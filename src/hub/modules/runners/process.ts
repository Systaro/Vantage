/**
 * Worker side of runners (design 6.7): applies queued probe results with the uptime engine's own
 * code, evaluates queued server reports with the thresholds shared with ops, and watches for
 * runners and servers that went quiet. Every state change becomes an event; the alert engine does
 * the rest.
 */
import type { SQL } from "bun";
import { effectiveThresholds, evaluateReport, thresholdHint, worstOf, type CheckResult } from "../../../shared/hosts/evaluate";
import { parseReport } from "../../../shared/hosts/report";
import { recordResult, type MonitorForResult } from "../uptime/engine";

/** A runner without a request for this long is silent. */
export const RUNNER_SILENT_MS = 3 * 60_000;
/** A server is silent after this many missed intervals (while its runner is alive). */
export const SERVER_SILENT_INTERVALS = 3;
const BATCH = 500;
const SEVERITY_TEXT: Record<string, string> = { warning: "Warnung", critical: "kritisch" };

type Event = { source: "servers" | "system"; environmentId: number | null; subject: string; state: "firing" | "resolved"; severity: "critical" | "warning"; title: string; body: string | null; link: string | null };

function event(sql: SQL, e: Event) {
  return sql`insert into events (source, environment_id, subject_key, state, severity, title, body, link)
             values (${e.source}, ${e.environmentId}, ${e.subject}, ${e.state}, ${e.severity}, ${e.title.slice(0, 300)}, ${e.body?.slice(0, 2000) ?? null}, ${e.link})`;
}

/** Probe results from runners, oldest first, through the same state machine as the worker's own probes. */
export async function processRunnerResults(sql: SQL): Promise<number> {
  const rows = (await sql`
    select q.id as queue_id, q.at, q.ok, q.latency_ms, q.status_code, q.message, q.details, q.tls_days_left,
           m.id, m.environment_id, m.name, m.kind, m.config, m.interval_seconds, m.timeout_ms, m.retries, m.retry_interval_seconds,
           p.name || ' ' || e.name as env_label
    from runner_results q
    join monitors m on m.id = q.monitor_id
    join environments e on e.id = m.environment_id
    join projects p on p.id = e.project_id
    order by q.id limit ${BATCH}`) as any[];
  for (const r of rows) {
    // Re-read the state for each row: two results of one monitor in a batch must see each other.
    const [state] = (await sql`select status, consecutive_failures, tls_days_left from monitor_state where monitor_id = ${r.id}`) as any[];
    const monitor: MonitorForResult = {
      id: r.id, environment_id: r.environment_id, name: r.name, kind: r.kind, config: r.config, interval_seconds: r.interval_seconds,
      timeout_ms: r.timeout_ms, retries: r.retries, retry_interval_seconds: r.retry_interval_seconds, status: state.status,
      consecutive_failures: state.consecutive_failures, tls_days_left: state.tls_days_left, env_label: r.env_label,
    };
    if (monitor.status !== "paused") {
      await recordResult(sql, monitor, {
        ok: r.ok, latencyMs: r.latency_ms, statusCode: r.status_code ?? undefined, message: r.message,
        details: r.details ?? undefined, tlsDaysLeft: r.tls_days_left ?? undefined,
      }, new Date(r.at));
    }
    await sql`delete from runner_results where id = ${r.queue_id}`;
  }
  return rows.length;
}

interface ServerRow {
  id: number;
  environment_id: number;
  name: string;
  thresholds: Record<string, number>;
  silent_since: Date | null;
  env_label: string;
}

const serverLink = (s: { environment_id: number }) => `/env/${s.environment_id}/servers`;

/** One report: check states, events for every check whose severity changed or that disappeared. */
async function applyReport(sql: SQL, server: ServerRow, queueId: number, at: Date, raw: unknown, error: string | null) {
  const parsed = raw ? parseReport(raw) : null;
  if (!parsed || !parsed.ok) {
    const problem = error ?? (parsed && !parsed.ok ? `Ungültiger Bericht: ${parsed.error}` : "Kein Bericht");
    await sql.begin(async (tx) => {
      await tx`update server_reports set error = ${problem.slice(0, 1000)}, processed_at = now() where id = ${queueId}`;
      await tx`update servers set last_error = ${problem.slice(0, 1000)} where id = ${server.id}`;
    });
    return;
  }
  const report = parsed.report;
  const t = effectiveThresholds(server.thresholds);
  const results = evaluateReport(report, t);
  const label = `${server.env_label} – ${server.name}`;
  await sql.begin(async (tx) => {
    const previous = (await tx`select check_key, label, severity from server_checks where server_id = ${server.id}`) as { check_key: string; label: string; severity: string }[];
    await tx`update server_reports set results = ${results}::jsonb, worst = ${worstOf(results)}, processed_at = now() where id = ${queueId}`;
    await tx`update servers set last_report_at = greatest(coalesce(last_report_at, ${at}), ${at}),
               last_error = ${report.errors.length ? report.errors.join("; ").slice(0, 1000) : null} where id = ${server.id}`;
    for (const r of results) {
      await tx`insert into server_checks (server_id, environment_id, check_key, label, severity, value, detail)
        values (${server.id}, ${server.environment_id}, ${r.key}, ${r.label}, ${r.severity}, ${r.value}, ${r.detail})
        on conflict (server_id, check_key) do update set
          since = case when server_checks.severity = excluded.severity then server_checks.since else now() end,
          label = excluded.label, severity = excluded.severity, value = excluded.value, detail = excluded.detail, updated_at = now()`;
      const before = previous.find((p) => p.check_key === r.key)?.severity ?? "ok";
      if (before === r.severity) continue;
      await event(tx, checkEvent(server, label, r, t));
    }
    // A check that is no longer reported (filesystem unmounted, docker removed) cannot stay open.
    for (const p of previous) {
      if (results.some((r) => r.key === p.check_key)) continue;
      await tx`delete from server_checks where server_id = ${server.id} and check_key = ${p.check_key}`;
      if (p.severity !== "ok") {
        await event(tx, { source: "servers", environmentId: server.environment_id, subject: `server:${server.id}:${p.check_key}`, state: "resolved",
          severity: "warning", title: `${label}: ${p.label} wird nicht mehr gemeldet`, body: null, link: serverLink(server) });
      }
    }
  });
}

function checkEvent(server: ServerRow, label: string, r: CheckResult, t: ReturnType<typeof effectiveThresholds>): Event {
  const base = { source: "servers" as const, environmentId: server.environment_id, subject: `server:${server.id}:${r.key}`, link: serverLink(server) };
  if (r.severity === "ok") return { ...base, state: "resolved", severity: "warning", title: `${label}: ${r.label} wieder in Ordnung`, body: r.detail };
  return { ...base, state: "firing", severity: r.severity, title: `${label}: ${r.label} ${SEVERITY_TEXT[r.severity]}`, body: `${r.detail}. Schwellen: ${thresholdHint(r.key, t)}.` };
}

/** Server reports from runners, oldest first. */
export async function processServerReports(sql: SQL): Promise<number> {
  const rows = (await sql`
    select q.id as queue_id, q.at, q.report, q.error, s.id, s.environment_id, s.name, s.thresholds, s.silent_since,
           p.name || ' ' || e.name as env_label
    from server_reports q join servers s on s.id = q.server_id
    join environments e on e.id = s.environment_id join projects p on p.id = e.project_id
    where q.processed_at is null order by q.id limit ${BATCH}`) as any[];
  for (const r of rows) await applyReport(sql, r as ServerRow, r.queue_id, new Date(r.at), r.report, r.error);
  return rows.length;
}

/** Runners and servers that went quiet, and those that are back. */
export async function runnerWatchdogs(sql: SQL, now = Date.now()): Promise<void> {
  const silentBefore = new Date(now - RUNNER_SILENT_MS);
  const runners = (await sql`
    select r.id, r.name, coalesce(o.name, 'Systaro') as org_name, r.last_seen_at, r.silent_since, r.revoked_at
    from runners r left join organisations o on o.id = r.organisation_id
    where r.last_seen_at is not null`) as any[];
  for (const r of runners) {
    const quiet = !r.revoked_at && new Date(r.last_seen_at) < silentBefore;
    const subject = `runner:${r.id}:silent`;
    if (quiet && !r.silent_since) {
      await sql.begin(async (tx) => {
        await tx`update runners set silent_since = now() where id = ${r.id}`;
        await event(tx, { source: "system", environmentId: null, subject, state: "firing", severity: "critical",
          title: `Runner „${r.name}“ (${r.org_name}) meldet sich nicht`,
          body: "Seine Monitore und Server behalten ihren letzten Stand, bis er wieder Ergebnisse schickt.", link: "/admin/runners" });
      });
    } else if (!quiet && r.silent_since) {
      await sql.begin(async (tx) => {
        await tx`update runners set silent_since = null where id = ${r.id}`;
        await event(tx, { source: "system", environmentId: null, subject, state: "resolved", severity: "critical",
          title: r.revoked_at ? `Runner „${r.name}“ (${r.org_name}) gesperrt` : `Runner „${r.name}“ (${r.org_name}) meldet sich wieder`, body: null, link: "/admin/runners" });
      });
    }
  }

  // Only servers whose runner is alive: when the runner is silent, that one event says it all.
  const servers = (await sql`
    select s.id, s.environment_id, s.name, s.silent_since, s.last_error, p.name || ' ' || e.name as env_label,
           coalesce(s.last_report_at, s.created_at) < ${new Date(now)}::timestamptz - make_interval(secs => s.interval_seconds * ${SERVER_SILENT_INTERVALS}) as overdue
    from servers s join runners r on r.id = s.runner_id
    join environments e on e.id = s.environment_id join projects p on p.id = e.project_id
    where s.enabled and r.revoked_at is null and r.silent_since is null and r.last_seen_at is not null`) as any[];
  for (const s of servers) {
    const subject = `server:${s.id}:silent`;
    const label = `${s.env_label} – ${s.name}`;
    if (s.overdue && !s.silent_since) {
      await sql.begin(async (tx) => {
        await tx`update servers set silent_since = now() where id = ${s.id}`;
        await event(tx, { source: "servers", environmentId: s.environment_id, subject, state: "firing", severity: "warning",
          title: `${label}: keine Werte mehr`, body: s.last_error ? `Letzter Fehler: ${s.last_error}` : "Der Runner erreicht den Server nicht oder bekommt keinen Bericht.", link: serverLink(s) });
      });
    } else if (!s.overdue && s.silent_since) {
      await sql.begin(async (tx) => {
        await tx`update servers set silent_since = null where id = ${s.id}`;
        await event(tx, { source: "servers", environmentId: s.environment_id, subject, state: "resolved", severity: "warning",
          title: `${label}: Werte kommen wieder an`, body: null, link: serverLink(s) });
      });
    }
  }
}

export async function runnersRetention(sql: SQL): Promise<void> {
  await sql`delete from server_reports where at < now() - interval '30 days'`;
}
