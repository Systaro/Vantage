/**
 * Reads an application's health page. Understood shapes:
 * - Cortex-style: {"healthy": true, "issues": [], "database": {"healthy": true, "queryLatencyMs": 1}, …}
 * - Spring Boot Actuator: {"status": "UP", "components": {"db": {"status": "UP", "details": {…}}}}
 * - IETF health+json draft: {"status": "pass", "checks": {"db:responseTime": [{"status": "pass", …}]}}
 * Anything else still counts by its HTTP status. Numeric fields become metrics, at most MAX_METRICS.
 */

export interface HealthComponent {
  name: string;
  ok: boolean;
  status: string;
  issues: string[];
}

export interface HealthDetails {
  components: HealthComponent[];
  metrics: Record<string, number>;
}

export interface HealthReading {
  ok: boolean;
  message: string;
  details: HealthDetails;
}

export const MAX_METRICS = 40;
const MAX_ISSUES = 5;

const GOOD = new Set(["UP", "OK", "PASS", "HEALTHY", "GREEN", "WARN", "YELLOW", "UNKNOWN"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A status word or flag on an object, or null when the object carries none. */
function statusOf(v: Obj): { ok: boolean; label: string } | null {
  if (typeof v.healthy === "boolean") return { ok: v.healthy, label: v.healthy ? "gesund" : "nicht gesund" };
  if (typeof v.status === "string") return { ok: GOOD.has(v.status.toUpperCase()), label: v.status };
  return null;
}

function issuesOf(v: Obj): string[] {
  const out: string[] = [];
  const add = (x: unknown) => {
    if (typeof x === "string" && x.trim()) out.push(x.trim().slice(0, 300));
    else if (isObj(x) && typeof x.message === "string") out.push(x.message.slice(0, 300));
  };
  if (Array.isArray(v.issues)) v.issues.forEach(add);
  add(v.output);
  if (isObj(v.details)) add(v.details.error);
  add(v.error);
  return out.slice(0, MAX_ISSUES);
}

function components(body: Obj): HealthComponent[] {
  const source = isObj(body.components) ? body.components : isObj(body.checks) ? body.checks : body;
  const out: HealthComponent[] = [];
  for (const [name, raw] of Object.entries(source)) {
    const v = Array.isArray(raw) ? raw.find(isObj) : raw;
    if (!isObj(v)) continue;
    const s = statusOf(v);
    if (s) out.push({ name: name.slice(0, 100), ok: s.ok, status: s.label, issues: issuesOf(v) });
  }
  return out;
}

/** Numeric leaves as "a.b.c" → value. Actuator's "components." and ".details" are dropped from the path. */
export function flattenMetrics(body: unknown, max = MAX_METRICS): Record<string, number> {
  const out: Record<string, number> = {};
  let n = 0;
  const walk = (v: unknown, path: string[], depth: number) => {
    if (n >= max || depth > 6) return;
    if (typeof v === "number" && Number.isFinite(v)) {
      out[path.filter((p, i) => !(p === "components" && i === 0) && p !== "details").join(".").slice(0, 120)] = v;
      n++;
    } else if (isObj(v)) {
      for (const [k, child] of Object.entries(v)) walk(child, [...path, k], depth + 1);
    }
  };
  walk(body, [], 0);
  return out;
}

export function readHealth(httpStatus: number, text: string): HealthReading {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, message: `HTTP ${httpStatus}, Antwort ist kein JSON`, details: { components: [], metrics: {} } };
  }
  if (!isObj(body)) return { ok: false, message: `HTTP ${httpStatus}, unerwartete Antwort`, details: { components: [], metrics: {} } };

  const overall = statusOf(body);
  const ok = overall ? overall.ok && httpStatus < 500 : httpStatus >= 200 && httpStatus < 300;
  const parts = components(body);
  const details: HealthDetails = { components: parts, metrics: flattenMetrics(body) };
  const failing = parts.filter((p) => !p.ok);
  const own = issuesOf(body);
  if (ok) {
    return { ok, details, message: parts.length ? `Gesund, ${parts.length} ${parts.length === 1 ? "Komponente" : "Komponenten"}` : `Gesund (HTTP ${httpStatus})` };
  }
  const reasons = failing.length
    ? failing.map((p) => (p.issues[0] ? `${p.name} (${p.issues[0]})` : p.name)).join(", ")
    : own[0] ?? `HTTP ${httpStatus}`;
  return { ok, details, message: `Nicht gesund: ${reasons}`.slice(0, 500) };
}
