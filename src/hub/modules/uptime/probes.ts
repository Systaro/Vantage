/**
 * One function per monitor kind. Each returns a uniform result and never throws: a probe that
 * crashes is a failed check, not a crashed worker.
 */
import { promises as dns } from "node:dns";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { readHealth, type HealthDetails } from "./health";

export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  statusCode?: number | null;
  message: string;
  tlsDaysLeft?: number | null;
  /** Health monitors: components and figures of this check. */
  details?: HealthDetails;
}

export const JSON_OPS = ["==", "!=", ">", ">=", "<", "<=", "contains"] as const;
export type JsonOp = (typeof JSON_OPS)[number];

/** A value from a JSON response compared with an expected one, e.g. `dmts > 80000`. */
export interface JsonRule {
  path: string;
  op: JsonOp;
  expected: string;
}

export interface HttpConfig {
  url: string;
  method?: "GET" | "HEAD" | "POST";
  expectStatus?: string;
  keyword?: string;
  followRedirects?: boolean;
  /** POST body; sent as application/json when it parses as JSON and no Content-Type header is set. */
  body?: string;
  /** Encrypted JSON object of request headers, which often carry a token. */
  headersEnc?: string;
  /** Encrypted query string appended to `url` (an API key in the URL); `url` itself is shown. */
  queryEnc?: string;
  json?: JsonRule;
  /** Also watch the certificate of an https URL, with the thresholds of a TLS monitor. */
  tlsExpiry?: boolean;
  warnDays?: number;
  critDays?: number;
}

/** The decrypted parts of an HttpConfig. */
export interface HttpSecrets {
  headers?: Record<string, string>;
  query?: string;
}
export interface TcpConfig {
  host: string;
  port: number;
}
export interface DnsConfig {
  name: string;
  type?: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS";
  expect?: string;
}
export interface TlsConfig {
  host: string;
  port?: number;
  warnDays?: number;
  critDays?: number;
}
export interface HeartbeatConfig {
  graceSeconds?: number;
}
export interface HealthConfig {
  url: string;
  /** Encrypted Authorization header value, for health pages behind a login. */
  authEnc?: string;
}
export interface KumaConfig {
  baseUrl: string;
  apiKeyEnc: string;
  monitorName: string;
}

/** "200-299,301" → predicate. */
export function statusMatcher(spec: string | undefined): (status: number) => boolean {
  const parts = (spec || "200-299").split(",").map((p) => p.trim()).filter(Boolean);
  const ranges = parts.map((p) => {
    const [a, b] = p.split("-").map((n) => Number.parseInt(n, 10));
    return [a ?? 0, b ?? a ?? 0] as const;
  });
  return (status) => ranges.some(([lo, hi]) => status >= lo && status <= hi);
}

function elapsed(start: number) {
  return Math.round(performance.now() - start);
}

function errMessage(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "Zeitüberschreitung";
  return (e?.code ? `${e.code}: ` : "") + (e?.message ?? String(err)).slice(0, 300);
}

/** `a.b[0].c` (a leading `$` or `$.` is ignored) → the value there, or undefined. */
export function readJsonPath(data: unknown, path: string): unknown {
  const steps = path.trim().replace(/^\$\.?/, "").match(/[^.[\]]+|\[\d+\]/g) ?? [];
  let cur: any = data;
  for (const step of steps) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = step.startsWith("[") ? cur[Number(step.slice(1, -1))] : cur[step];
  }
  return cur;
}

/** Numbers compare as numbers, everything else as its JSON text (`true` == "true"). */
function compareJson(value: unknown, op: JsonOp, expected: string): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (op === "contains") return text.includes(expected);
  const a = Number(text);
  const b = Number(expected);
  const numeric = typeof value !== "boolean" && text.trim() !== "" && expected.trim() !== "" && Number.isFinite(a) && Number.isFinite(b);
  switch (op) {
    case "==":
      return numeric ? a === b : text === expected;
    case "!=":
      return numeric ? a !== b : text !== expected;
    default:
      if (!numeric) return false;
      return op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : a <= b;
  }
}

export function checkJson(body: string, rule: JsonRule): { ok: boolean; message: string } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, message: "Die Antwort ist kein JSON" };
  }
  const value = readJsonPath(data, rule.path);
  if (value === undefined) return { ok: false, message: `„${rule.path}“ fehlt in der Antwort` };
  const shown = (typeof value === "string" ? value : JSON.stringify(value)).slice(0, 100);
  const ok = compareJson(value, rule.op, rule.expected);
  return { ok, message: `${rule.path} = ${shown}${ok ? "" : `, erwartet ${rule.op} ${rule.expected}`}` };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export async function probeHttp(cfg: HttpConfig, timeoutMs: number, secrets: HttpSecrets = {}): Promise<ProbeResult> {
  const target = cfg.tlsExpiry && cfg.url.startsWith("https:") ? new URL(cfg.url) : null;
  const cert = target ? probeTls({ host: target.hostname, port: Number(target.port) || 443 }, timeoutMs) : null;
  const result = await requestHttp(cfg, timeoutMs, secrets);
  const tlsDaysLeft = cert ? (await cert).tlsDaysLeft : undefined;
  return tlsDaysLeft === undefined ? result : { ...result, tlsDaysLeft };
}

async function requestHttp(cfg: HttpConfig, timeoutMs: number, secrets: HttpSecrets): Promise<ProbeResult> {
  const start = performance.now();
  const method = cfg.method ?? "GET";
  const headers: Record<string, string> = { "user-agent": "Vantage-Uptime/1.0", ...secrets.headers };
  const body = method === "POST" && cfg.body ? cfg.body : undefined;
  if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["content-type"] = isJson(body) ? "application/json" : "text/plain; charset=utf-8";
  }
  const url = secrets.query ? `${cfg.url}${cfg.url.includes("?") ? "&" : "?"}${secrets.query}` : cfg.url;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: cfg.followRedirects === false ? "manual" : "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = elapsed(start);
    const statusOk = statusMatcher(cfg.expectStatus)(res.status);
    if (!statusOk) {
      await res.body?.cancel();
      return { ok: false, latencyMs, statusCode: res.status, message: `HTTP ${res.status}, erwartet ${cfg.expectStatus || "200-299"}` };
    }
    if ((!cfg.keyword && !cfg.json) || method === "HEAD") {
      await res.body?.cancel();
      return { ok: true, latencyMs, statusCode: res.status, message: `HTTP ${res.status}` };
    }
    const text = (await res.text()).slice(0, 2_000_000);
    if (cfg.keyword && !text.includes(cfg.keyword)) {
      return { ok: false, latencyMs, statusCode: res.status, message: `Stichwort „${cfg.keyword}“ fehlt in der Antwort` };
    }
    if (cfg.json) {
      const check = checkJson(text, cfg.json);
      return { ok: check.ok, latencyMs, statusCode: res.status, message: `HTTP ${res.status}, ${check.message}` };
    }
    return { ok: true, latencyMs, statusCode: res.status, message: `HTTP ${res.status}` };
  } catch (err) {
    const message = errMessage(err);
    return { ok: false, latencyMs: null, statusCode: null, message: secrets.query ? message.replaceAll(secrets.query, "…") : message };
  }
}

/** An application's health page: 2xx or 503 with JSON, judged by `readHealth`. */
export async function probeHealth(cfg: HealthConfig, auth: string | null, timeoutMs: number): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const headers: Record<string, string> = { "user-agent": "Vantage-Uptime/1.0", accept: "application/json" };
    if (auth) headers.authorization = auth;
    const res = await fetch(cfg.url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = elapsed(start);
    if (!res.ok && res.status !== 503) {
      await res.body?.cancel();
      return { ok: false, latencyMs, statusCode: res.status, message: `HTTP ${res.status}` };
    }
    const reading = readHealth(res.status, (await res.text()).slice(0, 1_000_000));
    return { ok: reading.ok, latencyMs, statusCode: res.status, message: reading.message, details: reading.details };
  } catch (err) {
    return { ok: false, latencyMs: null, statusCode: null, message: errMessage(err) };
  }
}

export function probeTcp(cfg: TcpConfig, timeoutMs: number): Promise<ProbeResult> {
  const start = performance.now();
  return new Promise((resolve) => {
    const socket = netConnect({ host: cfg.host, port: cfg.port });
    const done = (r: ProbeResult) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs, () => done({ ok: false, latencyMs: null, message: "Zeitüberschreitung" }));
    socket.once("connect", () => done({ ok: true, latencyMs: elapsed(start), message: `Port ${cfg.port} offen` }));
    socket.once("error", (err) => done({ ok: false, latencyMs: null, message: errMessage(err) }));
  });
}

export async function probeDns(cfg: DnsConfig, timeoutMs: number): Promise<ProbeResult> {
  const start = performance.now();
  const type = cfg.type ?? "A";
  try {
    const lookup = dns.resolve(cfg.name, type as "A") as Promise<unknown[]>;
    const records = await Promise.race([
      lookup,
      new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs)),
    ]);
    const values = records.map((r) => (typeof r === "string" ? r : Array.isArray(r) ? r.join("") : JSON.stringify(r)));
    const latencyMs = elapsed(start);
    if (cfg.expect && !values.some((v) => v.includes(cfg.expect!))) {
      return { ok: false, latencyMs, message: `${type}: ${values.join(", ").slice(0, 200)} — „${cfg.expect}“ nicht gefunden` };
    }
    return { ok: values.length > 0, latencyMs, message: `${type}: ${values.join(", ").slice(0, 200) || "leer"}` };
  } catch (err) {
    return { ok: false, latencyMs: null, message: errMessage(err) };
  }
}

export function probeTls(cfg: TlsConfig, timeoutMs: number): Promise<ProbeResult> {
  const start = performance.now();
  const critDays = cfg.critDays ?? 3;
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: cfg.host, port: cfg.port ?? 443, servername: cfg.host, rejectUnauthorized: false });
    const done = (r: ProbeResult) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs, () => done({ ok: false, latencyMs: null, message: "Zeitüberschreitung" }));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      if (!cert?.valid_to) return done({ ok: false, latencyMs: elapsed(start), message: "Kein Zertifikat erhalten" });
      const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
      if (!authorized) {
        return done({ ok: false, latencyMs: elapsed(start), tlsDaysLeft: days, message: `Zertifikat ungültig: ${String(socket.authorizationError ?? "unbekannt")}` });
      }
      done({
        ok: days >= critDays,
        latencyMs: elapsed(start),
        tlsDaysLeft: days,
        message: days < 0 ? `Zertifikat seit ${-days} Tagen abgelaufen` : `Zertifikat gültig noch ${days} Tage (bis ${new Date(cert.valid_to).toISOString().slice(0, 10)})`,
      });
    });
    socket.once("error", (err) => done({ ok: false, latencyMs: null, message: errMessage(err) }));
  });
}

/** `note` is what the job sent with its last signal (Kuma push `msg`), e.g. "pending=68". */
export function evaluateHeartbeat(lastBeat: Date | null, intervalSeconds: number, cfg: HeartbeatConfig, createdAt: Date, note: string | null = null): ProbeResult {
  const grace = (cfg.graceSeconds ?? 60) * 1000;
  const deadline = intervalSeconds * 1000 + grace;
  const reference = lastBeat ?? createdAt;
  const age = Date.now() - reference.getTime();
  const said = note && lastBeat ? ` („${note}“)` : "";
  if (age <= deadline) {
    return { ok: true, latencyMs: null, message: lastBeat ? `Letztes Signal vor ${Math.round(age / 1000)} s${said}` : "Wartet auf das erste Signal" };
  }
  return { ok: false, latencyMs: null, message: lastBeat ? `Kein Signal seit ${Math.round(age / 60000)} min${said}` : "Noch nie ein Signal erhalten" };
}

/** Uptime Kuma v2 `/metrics` (Prometheus text). monitor_status: 1 up, 0 down, 2 pending, 3 maintenance. */
export function parseKumaStatus(metrics: string, monitorName: string): number | null {
  for (const line of metrics.split("\n")) {
    if (!line.startsWith("monitor_status{")) continue;
    const labels = line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"));
    const name = /(?:^|,)monitor_name="((?:[^"\\]|\\.)*)"/.exec(labels)?.[1]?.replace(/\\(.)/g, "$1");
    if (name === monitorName) {
      const value = Number(line.slice(line.lastIndexOf("}") + 1).trim());
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

export async function probeKuma(cfg: KumaConfig, apiKey: string, timeoutMs: number): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const res = await fetch(new URL("/metrics", cfg.baseUrl), {
      headers: { authorization: `Basic ${Buffer.from(`:${apiKey}`).toString("base64")}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, latencyMs: null, statusCode: res.status, message: `Uptime Kuma antwortet mit HTTP ${res.status}` };
    const status = parseKumaStatus(await res.text(), cfg.monitorName);
    const latencyMs = elapsed(start);
    if (status === null) return { ok: false, latencyMs, message: `Monitor „${cfg.monitorName}“ in Uptime Kuma nicht gefunden` };
    const label = ["down", "up", "ausstehend", "Wartung"][status] ?? `Status ${status}`;
    return { ok: status === 1 || status === 3, latencyMs, message: `Uptime Kuma: ${label}` };
  } catch (err) {
    return { ok: false, latencyMs: null, message: errMessage(err) };
  }
}
