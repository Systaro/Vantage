/**
 * What a runner and the hub say to each other (design 6.7). Shared by both sides, so the runner
 * sends exactly what the hub validates. The runner only connects out; the hub never calls it.
 *
 *   GET  /api/runner/v1/config   → RunnerConfig
 *   POST /api/runner/v1/results  ← ResultsBody → { accepted, rejected }
 *
 * Every request carries `Authorization: Bearer vrn_…`, `x-vantage-runner-version` and, once the
 * runner has its SSH key, `x-vantage-runner-key` (the public key, so admins can install it).
 */
import type { HealthConfig, HttpConfig, HttpSecrets, ProbeResult, TcpConfig, DnsConfig, TlsConfig } from "../hub/modules/uptime/probes";

export const RUNNER_TOKEN = /^vrn_[A-Za-z0-9_-]{43}$/;
export const VERSION_HEADER = "x-vantage-runner-version";
export const KEY_HEADER = "x-vantage-runner-key";
/** `user@host` or `host` (port in the user's ssh config is not supported); never readable as an ssh option. */
export const SSH_TARGET = /^(?:[a-z_][a-z0-9_.-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
export const SSH_PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{60,80}={0,2}( [\x21-\x7e]{1,100})?$/;
/** Kinds a runner can probe; heartbeats and the Kuma bridge need no network position. */
export const RUNNER_MONITOR_KINDS = ["http", "tcp", "dns", "tls", "health"] as const;
export const CONFIG_POLL_SECONDS = 60;
export const MAX_RESULTS_BYTES = 512 * 1024;
export const MAX_CHECKS = 2000;
export const MAX_REPORTS = 500;
/** Results older than this (a runner cut off for a week) are not worth replaying. */
export const MAX_RESULT_AGE_MS = 7 * 86_400_000;

export type RunnerMonitor =
  | { id: number; name: string; kind: "http"; config: HttpConfig; secrets: HttpSecrets; interval_seconds: number; timeout_ms: number; retry_interval_seconds: number | null }
  | { id: number; name: string; kind: "health"; config: HealthConfig; auth: string | null; interval_seconds: number; timeout_ms: number; retry_interval_seconds: number | null }
  | { id: number; name: string; kind: "tcp"; config: TcpConfig; interval_seconds: number; timeout_ms: number; retry_interval_seconds: number | null }
  | { id: number; name: string; kind: "dns"; config: DnsConfig; interval_seconds: number; timeout_ms: number; retry_interval_seconds: number | null }
  | { id: number; name: string; kind: "tls"; config: TlsConfig; interval_seconds: number; timeout_ms: number; retry_interval_seconds: number | null };

export interface RunnerServer {
  id: number;
  name: string;
  ssh_target: string;
  interval_seconds: number;
}

export interface RunnerConfig {
  runner: { id: number; name: string };
  poll_seconds: number;
  monitors: RunnerMonitor[];
  servers: RunnerServer[];
}

export interface CheckPayload {
  monitor_id: number;
  at: string;
  ok: boolean;
  latency_ms: number | null;
  status_code: number | null;
  message: string;
  details: unknown;
  tls_days_left: number | null;
}

export interface ReportPayload {
  server_id: number;
  at: string;
  /** The agent's JSON report as printed (validated by the hub), or null when reading it failed. */
  report: unknown;
  error: string | null;
}

export interface ResultsBody {
  checks: CheckPayload[];
  reports: ReportPayload[];
}

export function checkPayload(monitorId: number, result: ProbeResult, at: Date): CheckPayload {
  return {
    monitor_id: monitorId,
    at: at.toISOString(),
    ok: result.ok,
    latency_ms: result.latencyMs === null ? null : Math.round(result.latencyMs),
    status_code: result.statusCode ?? null,
    message: result.message,
    details: result.details ?? null,
    tls_days_left: result.tlsDaysLeft ?? null,
  };
}

const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const nullableInt = (v: unknown, min: number, max: number) => v === null || int(v, min, max);
const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;

function validAt(v: unknown, now: number): boolean {
  if (typeof v !== "string" || v.length > 40) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > now - MAX_RESULT_AGE_MS && t < now + 5 * 60_000;
}

/**
 * Strict check of a results body. Entries with a wrong shape reject the whole body (a broken
 * runner should be noticed, not half-trusted); entries that are merely too old are dropped.
 */
export function parseResultsBody(input: unknown, now = Date.now()): { ok: true; body: ResultsBody; dropped: number } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "body must be an object" };
  const { checks, reports } = input as Record<string, unknown>;
  if (!Array.isArray(checks) || checks.length > MAX_CHECKS) return { ok: false, error: `checks must be an array of at most ${MAX_CHECKS}` };
  if (!Array.isArray(reports) || reports.length > MAX_REPORTS) return { ok: false, error: `reports must be an array of at most ${MAX_REPORTS}` };
  const body: ResultsBody = { checks: [], reports: [] };
  let dropped = 0;
  for (const [i, c] of checks.entries()) {
    const x = c as Record<string, unknown>;
    if (typeof c !== "object" || c === null || !int(x.monitor_id, 1, 2 ** 31 - 1) || typeof x.ok !== "boolean" || !text(x.message, 1000)
      || !nullableInt(x.latency_ms, 0, 3_600_000) || !nullableInt(x.status_code, 0, 999) || !nullableInt(x.tls_days_left, -100_000, 100_000)
      || typeof x.at !== "string" || (x.details !== null && (typeof x.details !== "object" || JSON.stringify(x.details).length > 32_768))) {
      return { ok: false, error: `checks[${i}] is malformed` };
    }
    if (!validAt(x.at, now)) {
      dropped++;
      continue;
    }
    body.checks.push(x as unknown as CheckPayload);
  }
  for (const [i, r] of reports.entries()) {
    const x = r as Record<string, unknown>;
    if (typeof r !== "object" || r === null || !int(x.server_id, 1, 2 ** 31 - 1) || typeof x.at !== "string"
      || (x.error !== null && !text(x.error, 1000)) || (x.report !== null && typeof x.report !== "object")) {
      return { ok: false, error: `reports[${i}] is malformed` };
    }
    if (!validAt(x.at, now)) {
      dropped++;
      continue;
    }
    body.reports.push(x as unknown as ReportPayload);
  }
  return { ok: true, body, dropped };
}
