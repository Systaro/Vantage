/**
 * Uptime Kuma monitors → Vantage monitors (scripts/kuma-import.ts, docs/self-hosting.md "Uptime Kuma").
 * Pure conversion, tested on its own; the script does the reading and writing.
 *
 * Timing is kept as Kuma had it: a Kuma monitor retries `maxretries` times every `retry_interval`
 * seconds before it is down, which is exactly Vantage's `retries` and `retry_interval_seconds`.
 * A push monitor is down once no push came for `interval` plus its retries, so the retries become
 * the heartbeat's grace time.
 */
import { JSON_OPS, type JsonOp, type JsonRule } from "./probes";

export interface KumaMonitor {
  id: number;
  parent: number | null;
  name: string;
  type: string;
  active: number | boolean;
  url: string | null;
  method: string | null;
  body: string | null;
  headers: string | null;
  accepted_statuscodes_json: string | null;
  keyword: string | null;
  invert_keyword: number | boolean | null;
  json_path: string | null;
  json_path_operator: string | null;
  expected_value: string | null;
  interval: number;
  maxretries: number | null;
  retry_interval: number | null;
  timeout: number | null;
  expiry_notification: number | boolean | null;
  max_redirects: number | null;
  ignore_tls: number | boolean | null;
  upside_down: number | boolean | null;
  push_token: string | null;
  auth_method: string | null;
  has_basic_auth: boolean;
  notifications: string[];
}

export interface PlannedMonitor {
  kumaId: number;
  name: string;
  kind: "http" | "heartbeat";
  /** Without secrets; they are in `secrets` and get encrypted (or hashed) when written. */
  config: Record<string, unknown>;
  secrets: { headers?: Record<string, string>; query?: string; pushToken?: string };
  interval: number;
  timeoutMs: number;
  retries: number;
  retryInterval: number | null;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Kuma JSON queries are JSONata. Plain paths carry over; so does Kuma's `path > 500` == true idiom. */
export function kumaJsonRule(path: string, op: string | null, expected: string | null): JsonRule | { skip: string } {
  const p = path.trim();
  const operator = (op || "==") as JsonOp;
  const comparison = /^([\w$.[\]-]+)\s*(==|!=|>=|<=|>|<|=)\s*(.+)$/.exec(p);
  if (comparison && operator === "==" && expected === "true") {
    const cmp = comparison[2] === "=" ? "==" : (comparison[2] as JsonOp);
    return { path: comparison[1]!, op: cmp, expected: comparison[3]!.trim().replace(/^(["'])(.*)\1$/, "$2") };
  }
  if (!/^[\w$.[\]-]+$/.test(p)) return { skip: `JSON-Ausdruck „${p}“ lässt sich nicht übernehmen` };
  if (!(JSON_OPS as readonly string[]).includes(operator)) return { skip: `JSON-Vergleich „${operator}“ gibt es in Vantage nicht` };
  return { path: p, op: operator, expected: expected ?? "" };
}

/** Why a Kuma setting cannot be carried over, if one is set that Vantage does not have. */
function unsupported(k: KumaMonitor): string | null {
  if (k.upside_down) return "Umgekehrter Modus (upside down)";
  if (k.invert_keyword && k.keyword) return "Umgekehrtes Stichwort";
  if (k.ignore_tls) return "TLS-Fehler ignorieren";
  if (k.has_basic_auth || (k.auth_method && k.auth_method !== "null")) return "Anmeldung am Ziel (Basic/NTLM/OAuth)";
  return null;
}

export function convertKumaMonitor(k: KumaMonitor, name: string): PlannedMonitor | { skip: string } {
  const interval = clamp(Math.round(k.interval || 60), 30, 86400);
  const retries = clamp(k.maxretries ?? 0, 0, 10);
  const retryInterval = k.retry_interval && k.retry_interval !== 20 ? clamp(Math.round(k.retry_interval), 10, 3600) : null;
  if (k.type === "push") {
    if (!k.push_token) return { skip: "Push-Monitor ohne Token" };
    return {
      kumaId: k.id, name, kind: "heartbeat",
      config: { graceSeconds: clamp((k.maxretries ?? 0) * (k.retry_interval || k.interval || 60), 0, 86400), kumaId: k.id },
      secrets: { pushToken: k.push_token },
      interval, timeoutMs: 10_000, retries: 0, retryInterval: null,
    };
  }
  if (k.type !== "http" && k.type !== "json-query") return { skip: `Monitor-Art „${k.type}“ gibt es in Vantage nicht` };
  const why = unsupported(k);
  if (why) return { skip: `${why} gibt es in Vantage nicht` };
  if (!k.url || !/^https?:\/\//.test(k.url)) return { skip: "Keine http(s)-URL" };
  const method = (k.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(method)) return { skip: `Methode ${method} gibt es in Vantage nicht` };

  // Whatever is in the query string may be a key: it is stored encrypted, the URL without it.
  const target = new URL(k.url);
  const query = target.search.slice(1);
  target.search = "";
  const url = query ? target.toString() : k.url;

  let headers: Record<string, string> | undefined;
  if (k.headers?.trim()) {
    try {
      const parsed = JSON.parse(k.headers) as Record<string, unknown>;
      headers = Object.fromEntries(Object.entries(parsed).map(([h, v]) => [h, String(v)]));
    } catch {
      return { skip: "Die Header sind kein JSON-Objekt" };
    }
  }
  let json: JsonRule | undefined;
  if (k.type === "json-query") {
    const rule = kumaJsonRule(k.json_path ?? "", k.json_path_operator, k.expected_value);
    if ("skip" in rule) return rule;
    json = rule;
  }
  const accepted = k.accepted_statuscodes_json ? (JSON.parse(k.accepted_statuscodes_json) as string[]).join(",") : "200-299";
  const expectStatus = /^\d{3}(-\d{3})?(,\d{3}(-\d{3})?)*$/.test(accepted) ? accepted : "200-299";
  const tlsExpiry = !!k.expiry_notification && url.startsWith("https:");
  return {
    kumaId: k.id, name, kind: "http",
    config: {
      url, method, expectStatus,
      keyword: k.keyword || undefined,
      followRedirects: k.max_redirects !== 0,
      body: method === "POST" && k.body ? k.body : undefined,
      json,
      tlsExpiry: tlsExpiry || undefined,
      kumaId: k.id,
    },
    secrets: { headers, query: query || undefined },
    interval,
    timeoutMs: clamp(Math.round((k.timeout || interval * 0.8) * 1000), 500, 60_000),
    retries,
    retryInterval,
  };
}

/** Two http monitors in one environment that ask the same thing have the same key; others have none. */
export function monitorKey(kind: string, cfg: { url?: string; method?: string; json?: JsonRule }): string | null {
  if (kind !== "http" || !cfg.url) return null;
  const u = new URL(cfg.url);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return [cfg.method ?? "GET", `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`, JSON.stringify(cfg.json ?? null)].join(" ");
}
