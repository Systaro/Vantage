/**
 * ISMS verdicts (#69764): how a control stands, decided from plain values with fixed thresholds, so
 * the same data always gives the same answer and the values themselves can go into an audit
 * record. No database access here; `load.ts` collects the values.
 */
import { wallClock } from "../../../shared/time";
import { formatPercent } from "../../../shared/ui/components";

export type ControlKind = "uptime" | "tls" | "servers" | "logs" | "vulns" | "maintenance" | "record";
export const CONTROL_KINDS: readonly ControlKind[] = ["uptime", "tls", "servers", "logs", "vulns", "maintenance", "record"];

/** ok: holds · warn: holds with a hint · deviation: does not hold · due: a periodic record is missing or too old · open: a one-time measure not done yet · unknown: no data to decide. */
export type IsmsStatus = "ok" | "warn" | "deviation" | "due" | "open" | "unknown";

export const STATUS_LABEL: Record<IsmsStatus, string> = {
  ok: "Erfüllt",
  warn: "Hinweis",
  deviation: "Abweichung",
  due: "Fällig",
  open: "Offen",
  unknown: "Keine Daten",
};
export const STATUS_TONE: Record<IsmsStatus, "ok" | "warn" | "bad" | "idle"> = {
  ok: "ok",
  warn: "warn",
  deviation: "bad",
  due: "warn",
  open: "idle",
  unknown: "idle",
};
/** Worst first: the order of the summary and of a list sorted by urgency. */
export const STATUS_ORDER: readonly IsmsStatus[] = ["deviation", "due", "warn", "open", "unknown", "ok"];

/** The level a kind's data needs under RLS: monitors are overview, servers and logs diagnostics, vulnerabilities and Ansible runs security. */
export const KIND_LEVEL: Record<ControlKind, 1 | 2 | 3> = { uptime: 1, tls: 1, servers: 2, logs: 2, vulns: 3, maintenance: 3, record: 1 };
export const LEVEL_NAME: Record<1 | 2 | 3, string> = { 1: "Übersicht", 2: "Diagnose", 3: "Sicherheit" };

export const KIND_LABEL: Record<ControlKind, string> = {
  uptime: "Verfügbarkeit",
  tls: "Zertifikate",
  servers: "Server",
  logs: "Protokolle",
  vulns: "Schwachstellen",
  maintenance: "Wartungsläufe",
  record: "Nachweis",
};

export interface Verdict {
  status: IsmsStatus;
  /** The measured value or the latest record, in one line. */
  value: string;
  detail?: string;
}

export interface UptimeParams { min_percent: number; monitor_id?: number }
export interface TlsParams { min_days: number }
export interface LogsParams { retention_days: number; max_silence_hours: number }
export type VulnSource = "all" | "dependency_track" | "wazuh";
export interface VulnsParams { source: VulnSource; critical_days: number; high_days: number }
export interface MaintenanceParams { max_age_days: number; template?: string }
export interface RecordParams { interval_days: number | null }

export const DEFAULTS = {
  uptime: { min_percent: 99.5 } as UptimeParams,
  tls: { min_days: 14 } as TlsParams,
  logs: { retention_days: 90, max_silence_hours: 24 } as LogsParams,
  vulns: { source: "all", critical_days: 7, high_days: 31 } as VulnsParams,
  maintenance: { max_age_days: 31 } as MaintenanceParams,
  record: { interval_days: null } as RecordParams,
};

/** Grace beyond the retention before old entries count as kept too long (deletion runs once a day, per daily index). */
const RETENTION_GRACE_DAYS = 3;
const DAY = 86_400_000;

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" });
export const fullDay = (d: Date | string | number) => dateFmt.format(new Date(d));
/** Dative ("in 3 Tagen", "seit 1 Tag") and nominative ("3 Tage zurück"). */
const inDays = (n: number) => (n === 1 ? "1 Tag" : `${n} Tagen`);
const daysN = (n: number) => (n === 1 ? "1 Tag" : `${n} Tage`);

export function judgeUptime(rows: { name: string; percent: number | null }[], p: UptimeParams): Verdict {
  const measured = rows.filter((r) => r.percent !== null) as { name: string; percent: number }[];
  if (measured.length === 0) return { status: "unknown", value: "Noch keine Messungen" };
  const worst = measured.reduce((a, b) => (b.percent < a.percent ? b : a));
  const value = `${formatPercent(worst.percent, 2)} in 30 Tagen`;
  const which = measured.length === 1 ? worst.name : `schwächster von ${measured.length} Monitoren: ${worst.name}`;
  const detail = `${which}; Ziel mindestens ${formatPercent(p.min_percent, 2)}, rund um die Uhr gemessen`;
  return { status: worst.percent >= p.min_percent ? "ok" : "deviation", value, detail };
}

export function judgeTls(rows: { name: string; days_left: number | null }[], p: TlsParams): Verdict {
  const measured = rows.filter((r) => r.days_left !== null) as { name: string; days_left: number }[];
  if (measured.length === 0) return { status: "unknown", value: "Kein Monitor prüft ein Zertifikat" };
  const soonest = measured.reduce((a, b) => (b.days_left < a.days_left ? b : a));
  const value = soonest.days_left < 0 ? "Ein Zertifikat ist abgelaufen" : `Das nächste läuft in ${inDays(soonest.days_left)} ab`;
  const detail = `${soonest.name}; ${measured.length} Zertifikat${measured.length === 1 ? "" : "e"} geprüft, Ziel mindestens ${daysN(p.min_days)} Vorlauf`;
  return { status: soonest.days_left >= p.min_days ? "ok" : "deviation", value, detail };
}

export interface ServerInput {
  name: string;
  enabled: boolean;
  stale: boolean;
  checks: { label: string; severity: "ok" | "warning" | "critical"; detail: string }[];
}

export function judgeServers(servers: ServerInput[]): Verdict {
  const active = servers.filter((s) => s.enabled);
  if (active.length === 0) return { status: "unknown", value: "Kein Server erfasst" };
  const n = `${active.length} Server`;
  const silent = active.filter((s) => s.stale);
  if (silent.length) return { status: "deviation", value: `${silent.map((s) => s.name).join(", ")} meldet sich nicht`, detail: n };
  const all = active.flatMap((s) => s.checks.map((k) => ({ ...k, server: s.name })));
  const critical = all.filter((k) => k.severity === "critical");
  const warning = all.filter((k) => k.severity === "warning");
  const list = (ks: typeof all) => ks.slice(0, 3).map((k) => `${k.server}: ${k.label} ${k.detail}`).join(" · ");
  if (critical.length) return { status: "deviation", value: `${critical.length} kritische Prüfung${critical.length === 1 ? "" : "en"}`, detail: list(critical) };
  if (warning.length) return { status: "warn", value: `${warning.length} Warnung${warning.length === 1 ? "" : "en"}`, detail: list(warning) };
  return { status: "ok", value: `${n}, alle ${all.length} Prüfungen in Ordnung` };
}

export function judgeLogs(span: { newest: number | null; oldest: number | null } | null, p: LogsParams, now = Date.now()): Verdict {
  if (!span) return { status: "unknown", value: "Keine Logs-Quelle eingerichtet" };
  if (span.newest === null || span.oldest === null) return { status: "deviation", value: "Keine Protokolle gefunden" };
  const silentHours = (now - span.newest) / 3_600_000;
  const keptDays = Math.floor((now - span.oldest) / DAY);
  const reach = `älteste vom ${fullDay(span.oldest)}`;
  if (silentHours > p.max_silence_hours) {
    return { status: "deviation", value: `Seit ${fullDay(span.newest)} keine neuen Protokolle`, detail: `Ziel: höchstens ${p.max_silence_hours} Stunden Pause` };
  }
  if (keptDays > p.retention_days + RETENTION_GRACE_DAYS) {
    return { status: "deviation", value: `Protokolle älter als ${p.retention_days} Tage vorhanden`, detail: `${reach}, also ${keptDays} Tage` };
  }
  const detail = keptDays < p.retention_days
    ? `Aufbewahrung ${p.retention_days} Tage; die Sammlung reicht bisher ${daysN(keptDays)} zurück`
    : `Aufbewahrung ${p.retention_days} Tage, gelöscht wird pünktlich`;
  return { status: "ok", value: `Laufen ein, ${reach}`, detail };
}

export const VULN_SOURCE_LABEL: Record<VulnSource, string> = { all: "Dependency-Track und Wazuh", dependency_track: "Dependency-Track", wazuh: "Wazuh" };

export interface VulnsInput {
  /** A source of the chosen kind is mapped to the environment. */
  mapped: boolean;
  /** Projects and agents of those sources synced at least once. */
  synced: number;
  /** Open critical and high findings, counted per day they were first seen (YYYY-MM-DD). */
  groups: { severity: "critical" | "high"; day: string; n: number }[];
  /** Sync errors and outdated SBOMs, one line each. */
  problems: string[];
}

/** Open critical and high vulnerabilities against a fixing deadline, counted from the day Vantage first saw them. */
export function judgeVulns(v: VulnsInput, p: VulnsParams, today: string): Verdict {
  if (!v.mapped) return { status: "unknown", value: "Keine Schwachstellen-Quelle zugeordnet", detail: `${VULN_SOURCE_LABEL[p.source]} in den Einstellungen der Umgebung zuordnen` };
  if (v.synced === 0) return { status: "unknown", value: "Noch nicht abgeglichen", detail: v.problems.join(" · ") || undefined };
  const age = (day: string) => Math.round((Date.parse(today) - Date.parse(day)) / DAY);
  const sum = (sev: "critical" | "high", late: boolean) =>
    v.groups.filter((g) => g.severity === sev && (!late || age(g.day) > (sev === "critical" ? p.critical_days : p.high_days))).reduce((n, g) => n + g.n, 0);
  const deadline = `Frist kritisch ${daysN(p.critical_days)}, hoch ${daysN(p.high_days)}`;
  const lateCritical = sum("critical", true);
  const lateHigh = sum("high", true);
  if (lateCritical + lateHigh > 0) {
    const oldest = Math.max(...v.groups.map((g) => age(g.day)));
    return { status: "deviation", value: `Über der Frist: ${counted(lateCritical, lateHigh)}`, detail: [`älteste offen seit ${inDays(oldest)}; ${deadline}`, ...v.problems].join(" · ") };
  }
  const critical = sum("critical", false);
  const high = sum("high", false);
  const detail = [deadline, ...v.problems].join(" · ");
  if (critical + high > 0) return { status: "warn", value: `Offen: ${counted(critical, high)}, in der Frist`, detail };
  return { status: v.problems.length ? "warn" : "ok", value: "Keine offenen kritischen oder hohen", detail };
}

const counted = (critical: number, high: number) => [critical && `${critical} kritisch`, high && `${high} hoch`].filter(Boolean).join(", ");

export interface HostRun {
  host: string;
  /** The newest run on this server (of the chosen template), null without one. */
  last_at: Date | string | null;
  last_failed: boolean | null;
}

/** Every mapped server had a maintenance run within the interval, and its newest one went through. */
export function judgeMaintenance(hosts: HostRun[] | null, p: MaintenanceParams, now = Date.now()): Verdict {
  if (!hosts || hosts.length === 0) return { status: "unknown", value: "Keine Server für Ansible zugeordnet" };
  const scope = `Ziel: höchstens ${daysN(p.max_age_days)} zwischen zwei Läufen${p.template ? `, Vorlage „${p.template}“` : ""}`;
  const ageOf = (h: HostRun) => Math.floor((now - new Date(h.last_at!).getTime()) / DAY);
  const names = (hs: HostRun[]) => hs.map((h) => h.host).join(", ");
  const failed = hosts.filter((h) => h.last_at && h.last_failed);
  const never = hosts.filter((h) => !h.last_at);
  const old = hosts.filter((h) => h.last_at && ageOf(h) > p.max_age_days);
  if (failed.length) return { status: "deviation", value: `Letzter Lauf fehlgeschlagen: ${names(failed)}`, detail: scope };
  if (never.length) return { status: "deviation", value: `Noch kein Lauf: ${names(never)}`, detail: scope };
  if (old.length) return { status: "deviation", value: `Zu lange kein Lauf: ${names(old)}`, detail: scope };
  const oldest = Math.max(...hosts.map(ageOf));
  const when = oldest === 0 ? "heute" : `in den letzten ${oldest + 1} Tagen`;
  return { status: "ok", value: `${hosts.length} Server, alle ${when} gewartet`, detail: scope };
}

export interface RecordInput {
  done_on: string | Date;
  result: "passed" | "deviation";
}

/** `today` as YYYY-MM-DD in Berlin, so a record dated today never counts as from the future. */
export function judgeRecord(last: RecordInput | null, p: RecordParams, today: string): Verdict {
  const periodic = p.interval_days !== null && p.interval_days > 0;
  if (!last) return periodic ? { status: "due", value: "Noch kein Nachweis" } : { status: "open", value: "Noch nicht umgesetzt" };
  const done = toDay(last.done_on);
  if (last.result === "deviation") return { status: "deviation", value: `Zuletzt am ${fullDay(done)}, mit Abweichungen` };
  if (!periodic) return { status: "ok", value: `Umgesetzt am ${fullDay(done)}` };
  const next = new Date(Date.parse(done) + p.interval_days! * DAY).toISOString().slice(0, 10);
  if (next < today) {
    const overdue = Math.round((Date.parse(today) - Date.parse(next)) / DAY);
    return { status: "due", value: `Fällig seit ${inDays(overdue)}`, detail: `zuletzt am ${fullDay(done)}` };
  }
  return { status: "ok", value: `Zuletzt am ${fullDay(done)}`, detail: `nächster bis ${fullDay(next)}` };
}

/** Today in Berlin as YYYY-MM-DD. */
export function berlinToday(now = Date.now()): string {
  const w = wallClock(now);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** YYYY-MM-DD of a date column (Bun returns a Date at UTC midnight) or of a string. */
export function toDay(d: string | Date): string {
  return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

export const INTERVALS: { days: number | null; label: string }[] = [
  { days: null, label: "Einmalig" },
  { days: 31, label: "Monatlich" },
  { days: 92, label: "Vierteljährlich" },
  { days: 183, label: "Halbjährlich" },
  { days: 366, label: "Jährlich" },
];

export function intervalLabel(d: number | null | undefined): string {
  return INTERVALS.find((i) => i.days === (d ?? null))?.label ?? `alle ${d} Tage`;
}

/** "A.8.13" before "A.8.7"? No: numbers compare as numbers, so A.5.18, A.8.7, A.8.13. */
export function compareRefs(a: string, b: string): number {
  return a.localeCompare(b, "de", { numeric: true, sensitivity: "base" });
}
