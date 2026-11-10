/**
 * Worker side of uptime: picks due monitors, probes them, records the check and moves the state
 * machine. State changes become events; the alert engine turns those into incidents and messages.
 */
import type { SQL } from "bun";
import { decryptString } from "../../../shared/crypto";
import {
  evaluateHeartbeat,
  probeDns,
  probeHealth,
  probeHttp,
  probeKuma,
  probeTcp,
  probeTls,
  type HttpConfig,
  type HttpSecrets,
  type ProbeResult,
} from "./probes";

interface DueMonitor {
  id: number;
  environment_id: number;
  name: string;
  kind: string;
  config: any;
  interval_seconds: number;
  timeout_ms: number;
  retries: number;
  created_at: Date;
  status: string;
  consecutive_failures: number;
  retry_interval_seconds: number | null;
  last_heartbeat_at: Date | null;
  last_heartbeat_message: string | null;
  tls_days_left: number | null;
  env_label: string;
}

const MAX_PARALLEL = 20;
const RETRY_SECONDS = 20;
const running = new Set<number>();

async function httpSecrets(cfg: HttpConfig, secret: string): Promise<HttpSecrets> {
  return {
    headers: cfg.headersEnc ? JSON.parse(await decryptString(secret, cfg.headersEnc)) : undefined,
    query: cfg.queryEnc ? await decryptString(secret, cfg.queryEnc) : undefined,
  };
}

type ProbeInput = Pick<DueMonitor, "kind" | "config" | "timeout_ms" | "interval_seconds" | "last_heartbeat_at" | "created_at"> & { last_heartbeat_message?: string | null };

export async function runProbe(m: ProbeInput, secret: string): Promise<ProbeResult> {
  switch (m.kind) {
    case "http":
      return probeHttp(m.config, m.timeout_ms, await httpSecrets(m.config, secret));
    case "tcp":
      return probeTcp(m.config, m.timeout_ms);
    case "dns":
      return probeDns(m.config, m.timeout_ms);
    case "tls":
      return probeTls(m.config, m.timeout_ms);
    case "heartbeat":
      return evaluateHeartbeat(m.last_heartbeat_at ? new Date(m.last_heartbeat_at) : null, m.interval_seconds, m.config, new Date(m.created_at), m.last_heartbeat_message ?? null);
    case "kuma":
      return probeKuma(m.config, await decryptString(secret, m.config.apiKeyEnc), m.timeout_ms);
    case "health":
      return probeHealth(m.config, m.config.authEnc ? await decryptString(secret, m.config.authEnc) : null, m.timeout_ms);
    default:
      return { ok: false, latencyMs: null, message: `Unbekannte Art ${m.kind}` };
  }
}

export interface Transition {
  status: "up" | "down" | "pending";
  failures: number;
  event: null | { state: "firing" | "resolved"; severity: "critical" };
  nextInSeconds: number;
}

/** Pure state machine, tested on its own. `retries` = failures tolerated before "down", checked every `retryInterval` seconds. */
export function transition(current: string, failures: number, retries: number, ok: boolean, interval: number, retryInterval = RETRY_SECONDS): Transition {
  if (ok) {
    return {
      status: "up",
      failures: 0,
      event: current === "down" ? { state: "resolved", severity: "critical" } : null,
      nextInSeconds: interval,
    };
  }
  const next = failures + 1;
  if (next > retries) {
    return {
      status: "down",
      failures: next,
      event: current !== "down" ? { state: "firing", severity: "critical" } : null,
      nextInSeconds: interval,
    };
  }
  return { status: current === "down" ? "down" : current === "up" ? "up" : "pending", failures: next, event: null, nextInSeconds: Math.min(interval, retryInterval) };
}

/** TLS warning band (still "up", but the certificate runs out soon): its own subject. */
export function tlsWarning(daysLeft: number | null | undefined, cfg: { warnDays?: number; critDays?: number }): boolean {
  if (daysLeft === null || daysLeft === undefined) return false;
  return daysLeft < (cfg.warnDays ?? 14) && daysLeft >= (cfg.critDays ?? 3);
}

/**
 * Certificate state of an http monitor that watches its certificate. The monitor itself stays up,
 * so the expiry is its own incident: a warning below `warnDays`, critical below `critDays`.
 */
export function certificateAlert(daysLeft: number | null | undefined, cfg: { warnDays?: number; critDays?: number }): "warning" | "critical" | null {
  if (daysLeft === null || daysLeft === undefined) return null;
  if (daysLeft < (cfg.critDays ?? 3)) return "critical";
  return daysLeft < (cfg.warnDays ?? 14) ? "warning" : null;
}

/**
 * Records one probe result and moves the state machine: the worker's own probes and the results
 * runners send (`at` = when the runner probed) take this same path.
 */
export async function recordResult(sql: SQL, m: MonitorForResult, result: ProbeResult, at: Date = new Date()) {
  const t = transition(m.status, m.consecutive_failures, m.retries, result.ok, m.interval_seconds, m.retry_interval_seconds ?? RETRY_SECONDS);
  const label = `${m.env_label} – ${m.name}`;
  await sql.begin(async (tx) => {
    await tx`insert into monitor_checks (monitor_id, environment_id, at, ok, latency_ms, status_code, message, details)
             values (${m.id}, ${m.environment_id}, ${at}, ${result.ok}, ${result.latencyMs}, ${result.statusCode ?? null}, ${result.message},
                     ${result.details ?? null}::jsonb)`;
    await tx`update monitor_state set
               status = ${t.status},
               since = case when status is distinct from ${t.status} then now() else since end,
               last_check_at = now(),
               next_check_at = now() + make_interval(secs => ${t.nextInSeconds}),
               consecutive_failures = ${t.failures},
               last_message = ${result.message},
               last_latency_ms = ${result.latencyMs},
               tls_days_left = coalesce(${result.tlsDaysLeft ?? null}, tls_days_left)
             where monitor_id = ${m.id} and status <> 'paused'`;
    if (t.event) {
      await tx`insert into events (source, environment_id, subject_key, state, severity, title, body, link)
               values ('uptime', ${m.environment_id}, ${`monitor:${m.id}`}, ${t.event.state}, ${t.event.severity},
                       ${t.event.state === "firing" ? `DOWN: ${label}` : `Wieder erreichbar: ${label}`},
                       ${result.message}, ${`/env/${m.environment_id}/uptime/${m.id}`})`;
    }
    const certificate = (alert: "warning" | "critical" | null) =>
      tx`insert into events (source, environment_id, subject_key, state, severity, title, body, link)
         values ('uptime', ${m.environment_id}, ${`monitor:${m.id}:tls-expiry`}, ${alert ? "firing" : "resolved"}, ${alert ?? "warning"},
                 ${alert ? `Zertifikat läuft bald ab: ${label}` : `Zertifikat erneuert: ${label}`},
                 ${`Zertifikat gültig noch ${result.tlsDaysLeft} Tage`}, ${`/env/${m.environment_id}/uptime/${m.id}`})`;
    if (m.kind === "tls" && result.tlsDaysLeft !== undefined) {
      const warnNow = tlsWarning(result.tlsDaysLeft, m.config);
      if (warnNow !== tlsWarning(m.tls_days_left, m.config)) await certificate(warnNow ? "warning" : null);
    }
    if (m.kind === "http" && m.config.tlsExpiry && result.tlsDaysLeft !== undefined) {
      const now = certificateAlert(result.tlsDaysLeft, m.config);
      if (now !== certificateAlert(m.tls_days_left, m.config)) await certificate(now);
    }
  });
}

async function checkOne(sql: SQL, m: DueMonitor, secret: string) {
  await recordResult(sql, m, await runProbe(m, secret));
}

/** The monitor and state columns recordResult needs. */
export type MonitorForResult = Omit<DueMonitor, "last_heartbeat_at" | "last_heartbeat_message" | "created_at">;

/** One scheduler tick: start every due monitor that is not already running, up to MAX_PARALLEL. */
export async function uptimeTick(sql: SQL, secret: string, log: (m: string) => void = console.log): Promise<number> {
  const free = MAX_PARALLEL - running.size;
  if (free <= 0) return 0;
  const exclude = [...running, 0];
  const due = (await sql`
    select m.id, m.environment_id, m.name, m.kind, m.config, m.interval_seconds, m.timeout_ms, m.retries, m.retry_interval_seconds, m.created_at,
           s.status, s.consecutive_failures, s.last_heartbeat_at, s.last_heartbeat_message, s.tls_days_left,
           p.name || ' ' || e.name as env_label
    from monitor_state s
    join monitors m on m.id = s.monitor_id
    join environments e on e.id = m.environment_id
    join projects p on p.id = e.project_id
    where m.enabled and s.status <> 'paused' and s.next_check_at <= now() and m.runner_id is null
      and m.id <> all(${sql.array(exclude, "int4")})
    order by s.next_check_at
    limit ${free}`) as DueMonitor[];
  for (const m of due) {
    running.add(m.id);
    checkOne(sql, m, secret)
      .catch((err) => log(`[uptime] monitor ${m.id} failed: ${(err as Error).message}`))
      .finally(() => running.delete(m.id));
  }
  return due.length;
}

export async function uptimeRetention(sql: SQL): Promise<void> {
  await sql`delete from monitor_checks where at < now() - interval '30 days'`;
  // Health figures are for the recent trend; the up/down history keeps its 30 days.
  await sql`update monitor_checks set details = null where details is not null and at < now() - interval '14 days'`;
}
