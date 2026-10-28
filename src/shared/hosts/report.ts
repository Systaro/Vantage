/**
 * The report `agent/vantage-agent.sh` prints (central mode) or posts (agent mode). Version 1.
 * Validation is strict: unknown keys, wrong types and out-of-range values reject the whole report,
 * so a broken agent shows up as a silent host instead of as plausible-looking wrong numbers.
 *
 * {
 *   "version": 1, "agent": "1", "hostname": "web1", "time": 1760263200,
 *   "disks":   [{ "mount": "/", "device": "/dev/sda1", "fstype": "ext4",
 *                 "size_kb": 1000, "used_kb": 400, "avail_kb": 600, "used_pct": 40.0 }],
 *   "memory":  { "total_kb": 2048000, "available_kb": 1024000, "used_pct": 50.0 } | null,
 *   "load":    { "load1": 0.12, "load5": 0.2, "load15": 0.3, "cores": 4 } | null,
 *   "cpu":     { "total": 22800, "idle": 16250, "iowait": 520 } | null,
 *   "systemd": { "failed": ["foo.service"] } | null,
 *   "docker":  { "total": 3, "stopped": ["db"] } | null,
 *   "es":      { "reachable": true, "blocked_indices": 0, "max_disk_pct": 71 } | null,
 *   "errors":  ["docker: permission denied"]
 * }
 * `null` means the check is not available on that host (no systemd, no docker access, no ES URL).
 * `cpu` holds clock ticks since boot (/proc/stat); usage comes from two reports (`cpuUsagePct`). Agents
 * before it was added leave the key out, so it is the one optional key.
 */

export interface DiskReport {
  mount: string;
  device: string;
  fstype: string;
  size_kb: number;
  used_kb: number;
  avail_kb: number;
  used_pct: number;
}

export interface HostReport {
  version: 1;
  agent: string;
  hostname: string;
  time: number;
  disks: DiskReport[];
  memory: { total_kb: number; available_kb: number; used_pct: number } | null;
  load: { load1: number; load5: number; load15: number; cores: number } | null;
  cpu?: { total: number; idle: number; iowait: number } | null;
  systemd: { failed: string[] } | null;
  docker: { total: number; stopped: string[] } | null;
  es: { reachable: boolean; blocked_indices: number; max_disk_pct: number | null } | null;
  errors: string[];
}

export const MAX_REPORT_BYTES = 64 * 1024;

class ReportError extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string, keys: string[], optional: string[] = []): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ReportError(`${path} must be an object`);
  for (const k of Object.keys(v)) if (!keys.includes(k) && !optional.includes(k)) throw new ReportError(`${path}.${k} is not allowed`);
  for (const k of keys) if (!(k in v)) throw new ReportError(`${path}.${k} is missing`);
  return v as Obj;
}

function str(v: unknown, path: string, max: number, min = 0): string {
  if (typeof v !== "string" || v.length < min || v.length > max) throw new ReportError(`${path} must be a string of ${min}–${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new ReportError(`${path} contains control characters`);
  return v;
}

function num(v: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    throw new ReportError(`${path} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
  }
  return v;
}

function list<T>(v: unknown, path: string, max: number, item: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(v) || v.length > max) throw new ReportError(`${path} must be an array of at most ${max} entries`);
  return v.map((x, i) => item(x, `${path}[${i}]`));
}

function nullable<T>(v: unknown, parse: (x: unknown) => T): T | null {
  return v === null ? null : parse(v);
}

const KB_MAX = 2 ** 53;

export function parseReport(input: unknown): { ok: true; report: HostReport } | { ok: false; error: string } {
  try {
    const r = obj(input, "report", ["version", "agent", "hostname", "time", "disks", "memory", "load", "systemd", "docker", "es", "errors"], ["cpu"]);
    if (r.version !== 1) throw new ReportError("version must be 1");
    const report: HostReport = {
      version: 1,
      agent: str(r.agent, "agent", 40, 1),
      hostname: str(r.hostname, "hostname", 253, 1),
      time: num(r.time, "time", 0, 4102444800, true),
      disks: list(r.disks, "disks", 100, (x, p) => {
        const d = obj(x, p, ["mount", "device", "fstype", "size_kb", "used_kb", "avail_kb", "used_pct"]);
        return {
          mount: str(d.mount, `${p}.mount`, 1024, 1),
          device: str(d.device, `${p}.device`, 1024),
          fstype: str(d.fstype, `${p}.fstype`, 64),
          size_kb: num(d.size_kb, `${p}.size_kb`, 0, KB_MAX, true),
          used_kb: num(d.used_kb, `${p}.used_kb`, 0, KB_MAX, true),
          avail_kb: num(d.avail_kb, `${p}.avail_kb`, 0, KB_MAX, true),
          used_pct: num(d.used_pct, `${p}.used_pct`, 0, 100),
        };
      }),
      memory: nullable(r.memory, (x) => {
        const m = obj(x, "memory", ["total_kb", "available_kb", "used_pct"]);
        return {
          total_kb: num(m.total_kb, "memory.total_kb", 0, KB_MAX, true),
          available_kb: num(m.available_kb, "memory.available_kb", 0, KB_MAX, true),
          used_pct: num(m.used_pct, "memory.used_pct", 0, 100),
        };
      }),
      load: nullable(r.load, (x) => {
        const l = obj(x, "load", ["load1", "load5", "load15", "cores"]);
        return {
          load1: num(l.load1, "load.load1", 0, 1e6),
          load5: num(l.load5, "load.load5", 0, 1e6),
          load15: num(l.load15, "load.load15", 0, 1e6),
          cores: num(l.cores, "load.cores", 1, 65536, true),
        };
      }),
      cpu: nullable(r.cpu ?? null, (x) => {
        const u = obj(x, "cpu", ["total", "idle", "iowait"]);
        const total = num(u.total, "cpu.total", 0, Number.MAX_SAFE_INTEGER, true);
        const idle = num(u.idle, "cpu.idle", 0, total, true);
        return { total, idle, iowait: num(u.iowait, "cpu.iowait", 0, total - idle, true) };
      }),
      systemd: nullable(r.systemd, (x) => {
        const s = obj(x, "systemd", ["failed"]);
        return { failed: list(s.failed, "systemd.failed", 500, (u, p) => str(u, p, 256, 1)) };
      }),
      docker: nullable(r.docker, (x) => {
        const d = obj(x, "docker", ["total", "stopped"]);
        return {
          total: num(d.total, "docker.total", 0, 100000, true),
          stopped: list(d.stopped, "docker.stopped", 1000, (u, p) => str(u, p, 256, 1)),
        };
      }),
      es: nullable(r.es, (x) => {
        const e = obj(x, "es", ["reachable", "blocked_indices", "max_disk_pct"]);
        if (typeof e.reachable !== "boolean") throw new ReportError("es.reachable must be a boolean");
        return {
          reachable: e.reachable,
          blocked_indices: num(e.blocked_indices, "es.blocked_indices", 0, 1e7, true),
          max_disk_pct: e.max_disk_pct === null ? null : num(e.max_disk_pct, "es.max_disk_pct", 0, 100),
        };
      }),
      errors: list(r.errors, "errors", 50, (u, p) => str(u, p, 500)),
    };
    return { ok: true, report };
  } catch (err) {
    if (err instanceof ReportError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Parses raw JSON text with the size limit applied first. */
export function parseReportText(text: string): { ok: true; report: HostReport } | { ok: false; error: string } {
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES) return { ok: false, error: "report too large" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  return parseReport(json);
}
