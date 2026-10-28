/** Turns a validated host report (ops agents, Vantage runners) into one result per check, using the host's thresholds. */
import type { HostReport } from "./report";

export type CheckSeverity = "ok" | "warning" | "critical";

export interface Thresholds {
  disk_warn: number;
  disk_crit: number;
  memory_warn: number;
  memory_crit: number;
  load_warn: number;
  load_crit: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { disk_warn: 85, disk_crit: 95, memory_warn: 90, memory_crit: 97, load_warn: 2, load_crit: 4 };

/** Elasticsearch disk watermarks: high (90 %) and flood stage (95 %). */
const ES_WARN = 90;
const ES_CRIT = 95;

export const THRESHOLD_FIELDS: { key: keyof Thresholds; label: string; unit: string; max: number }[] = [
  { key: "disk_warn", label: "Festplatte Warnung", unit: "%", max: 100 },
  { key: "disk_crit", label: "Festplatte kritisch", unit: "%", max: 100 },
  { key: "memory_warn", label: "Arbeitsspeicher Warnung", unit: "%", max: 100 },
  { key: "memory_crit", label: "Arbeitsspeicher kritisch", unit: "%", max: 100 },
  { key: "load_warn", label: "Last je Kern Warnung", unit: "", max: 1000 },
  { key: "load_crit", label: "Last je Kern kritisch", unit: "", max: 1000 },
];

export function effectiveThresholds(override: Partial<Thresholds> | null | undefined): Thresholds {
  const t = { ...DEFAULT_THRESHOLDS };
  for (const f of THRESHOLD_FIELDS) {
    const v = override?.[f.key];
    if (typeof v === "number" && Number.isFinite(v)) t[f.key] = v;
  }
  return t;
}

/** Validates an override from the host form; empty fields fall back to the defaults. */
export function parseThresholds(values: Record<string, string>): { ok: true; thresholds: Partial<Thresholds> } | { ok: false; error: string } {
  const out: Partial<Thresholds> = {};
  for (const f of THRESHOLD_FIELDS) {
    const raw = (values[f.key] ?? "").trim().replace(",", ".");
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > f.max) return { ok: false, error: `${f.label}: bitte eine Zahl zwischen 0 und ${f.max}.` };
    out[f.key] = n;
  }
  const t = effectiveThresholds(out);
  for (const [w, c, label] of [["disk_warn", "disk_crit", "Festplatte"], ["memory_warn", "memory_crit", "Arbeitsspeicher"], ["load_warn", "load_crit", "Last"]] as const) {
    if (t[w] >= t[c]) return { ok: false, error: `${label}: Die Warnschwelle muss unter der kritischen liegen.` };
  }
  return { ok: true, thresholds: out };
}

export interface CheckResult {
  key: string;
  label: string;
  severity: CheckSeverity;
  value: number | null;
  detail: string;
}

const num1 = (n: number) => n.toFixed(1).replace(".", ",");
const num2 = (n: number) => n.toFixed(2).replace(".", ",");

export function formatKb(kb: number): string {
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = kb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : num1(v)} ${units[i]}`;
}

function level(value: number, warn: number, crit: number): CheckSeverity {
  return value >= crit ? "critical" : value >= warn ? "warning" : "ok";
}

function names(list: string[], max = 10): string {
  return list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} und ${list.length - max} weitere`;
}

export function evaluateReport(r: HostReport, t: Thresholds): CheckResult[] {
  const out: CheckResult[] = [];
  for (const d of r.disks) {
    out.push({
      key: `disk:${d.mount}`,
      label: `Festplatte ${d.mount}`,
      severity: level(d.used_pct, t.disk_warn, t.disk_crit),
      value: d.used_pct,
      detail: `${num1(d.used_pct)} % belegt, ${formatKb(d.avail_kb)} frei von ${formatKb(d.size_kb)}${d.fstype ? ` (${d.fstype})` : ""}`,
    });
  }
  if (r.memory) {
    out.push({
      key: "memory",
      label: "Arbeitsspeicher",
      severity: level(r.memory.used_pct, t.memory_warn, t.memory_crit),
      value: r.memory.used_pct,
      detail: `${num1(r.memory.used_pct)} % belegt, ${formatKb(r.memory.available_kb)} verfügbar von ${formatKb(r.memory.total_kb)}`,
    });
  }
  if (r.load) {
    // load5 rather than load1: the agent runs every few minutes, a one-minute spike says little.
    const perCore = r.load.load5 / r.load.cores;
    out.push({
      key: "load",
      label: "Last",
      severity: level(perCore, t.load_warn, t.load_crit),
      value: Math.round(perCore * 100) / 100,
      detail: `${num2(perCore)} je Kern (Load ${num2(r.load.load1)} / ${num2(r.load.load5)} / ${num2(r.load.load15)}, ${r.load.cores} Kerne)`,
    });
  }
  if (r.systemd) {
    const n = r.systemd.failed.length;
    out.push({
      key: "systemd",
      label: "systemd-Units",
      severity: n > 0 ? "warning" : "ok",
      value: n,
      detail: n ? `${n} fehlgeschlagen: ${names(r.systemd.failed)}` : "keine fehlgeschlagenen Units",
    });
  }
  if (r.docker) {
    const n = r.docker.stopped.length;
    out.push({
      key: "docker",
      label: "Docker-Container",
      severity: n > 0 ? "warning" : "ok",
      value: n,
      detail: n ? `${n} von ${r.docker.total} laufen nicht: ${names(r.docker.stopped)}` : `alle ${r.docker.total} laufen wie vorgesehen`,
    });
  }
  if (r.es) {
    const e = r.es;
    let severity: CheckSeverity = "ok";
    let detail: string;
    if (!e.reachable) {
      severity = "warning";
      detail = "Elasticsearch nicht erreichbar";
    } else {
      const disk = e.max_disk_pct;
      if (e.blocked_indices > 0 || (disk !== null && disk >= ES_CRIT)) severity = "critical";
      else if (disk !== null && disk >= ES_WARN) severity = "warning";
      detail = `${e.blocked_indices ? `${e.blocked_indices} Indizes schreibgeschützt (Flood Stage)` : "keine schreibgeschützten Indizes"}${disk !== null ? `, Datenträger bis ${num1(disk)} % belegt` : ""}`;
    }
    out.push({ key: "es", label: "Elasticsearch", severity, value: e.reachable ? e.max_disk_pct : null, detail });
  }
  return out;
}

/**
 * Average CPU usage between two reports in percent, from the tick counters: busy is neither idle nor
 * waiting for I/O, as top counts it. Null when a report lacks the counters or across a reboot.
 */
export function cpuUsagePct(prev: HostReport["cpu"] | undefined, cur: HostReport["cpu"] | undefined): number | null {
  if (!prev || !cur) return null;
  const total = cur.total - prev.total;
  const idle = cur.idle + cur.iowait - prev.idle - prev.iowait;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return ((total - idle) * 100) / total;
}

export function worstOf(results: { severity: CheckSeverity }[]): CheckSeverity {
  if (results.some((r) => r.severity === "critical")) return "critical";
  if (results.some((r) => r.severity === "warning")) return "warning";
  return "ok";
}

export function thresholdHint(key: string, t: Thresholds): string {
  if (key.startsWith("disk:")) return `Warnung ab ${t.disk_warn} %, kritisch ab ${t.disk_crit} %`;
  if (key === "memory") return `Warnung ab ${t.memory_warn} %, kritisch ab ${t.memory_crit} %`;
  if (key === "load") return `Warnung ab ${num2(t.load_warn)}, kritisch ab ${num2(t.load_crit)} je Kern`;
  if (key === "es") return `Warnung ab ${ES_WARN} %, kritisch ab ${ES_CRIT} % oder bei schreibgeschützten Indizes`;
  return "Warnung, sobald mindestens einer betroffen ist";
}
