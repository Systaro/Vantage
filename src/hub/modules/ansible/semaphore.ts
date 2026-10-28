/**
 * Semaphore's REST API, read only, through the "semaphore" integration (a guest member's token).
 * Vantage reads the run list and each finished run's plain-text output, from which it keeps only the
 * PLAY RECAP (per-server counts) and the name of the task a server failed in. Nothing else of the
 * output leaves this module: messages can carry hostnames, paths and the occasional secret.
 */
import type { SemaphoreConnection } from "../integrations/kinds";
import { semaphoreConnection } from "../integrations/store";

export class SemaphoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemaphoreError";
  }
}

const TIMEOUT_MS = 20_000;
const OUTPUT_TIMEOUT_MS = 120_000;
/** A run's whole log is read to reach the recap at its end; beyond this something is wrong. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_HOSTS = 30;
/** Inventory host names and aliases: what Ansible prints in the recap. */
export const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
/** Statuses after which a run no longer changes. */
export const FINAL_STATUSES = ["success", "error", "stopped", "rejected"];

export interface SemaphoreTask {
  id: number;
  template_id: number;
  status: string;
  schedule_id?: number | null;
  created: string;
  start?: string | null;
  end?: string | null;
  /** Only in the run list: the template's name and playbook. */
  tpl_alias?: string;
  tpl_playbook?: string;
}

export interface HostResult {
  host: string;
  ok: number;
  changed: number;
  unreachable: number;
  failed: number;
  skipped: number;
  rescued: number;
  ignored: number;
  failedTask: string | null;
}

export interface SemaphoreApi {
  project(): Promise<{ id: number; name: string }>;
  lastTasks(limit: number): Promise<SemaphoreTask[]>;
  task(id: number): Promise<SemaphoreTask | null>;
  /** Feeds the run's output line by line into `onLine`. */
  output(id: number, onLine: (line: string) => void): Promise<void>;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const RECAP_START = /^PLAY RECAP \*/;
const RECAP_LINE = /^(\S+)\s+:\s+ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)(?:\s+skipped=(\d+))?(?:\s+rescued=(\d+))?(?:\s+ignored=(\d+))?/;
const TASK_LINE = /^(?:TASK|RUNNING HANDLER) \[(.+)\] \*+\s*$/;
// "fatal: [web1]: FAILED! => …", "failed: [web1] (item=x) => …", "fatal: [web1 -> localhost]: UNREACHABLE! …"
const FAIL_LINE = /^(?:fatal|failed): \[([^\]\s]+)(?: -> [^\]]+)?\]/;

/** Reads the per-server outcome out of ansible-playbook's output, one line at a time. */
export class RecapParser {
  private task: string | null = null;
  private inRecap = false;
  private readonly failedIn = new Map<string, string>();
  private readonly hosts = new Map<string, HostResult>();

  push(raw: string) {
    const line = raw.replace(ANSI, "").trimEnd();
    if (RECAP_START.test(line)) {
      this.inRecap = true;
      return;
    }
    if (this.inRecap) {
      const m = RECAP_LINE.exec(line);
      if (m) {
        const n = (i: number) => Number(m[i] ?? 0);
        const prev = this.hosts.get(m[1]!);
        const add = (k: keyof Omit<HostResult, "host" | "failedTask">, v: number) => (prev ? prev[k] + v : v);
        this.hosts.set(m[1]!, {
          host: m[1]!,
          ok: add("ok", n(2)), changed: add("changed", n(3)), unreachable: add("unreachable", n(4)), failed: add("failed", n(5)),
          skipped: add("skipped", n(6)), rescued: add("rescued", n(7)), ignored: add("ignored", n(8)),
          failedTask: null,
        });
        return;
      }
      if (line.trim() !== "") this.inRecap = false;
    }
    const task = TASK_LINE.exec(line);
    if (task) {
      this.task = task[1]!.slice(0, 200);
      return;
    }
    // The last failure counts: a server stops at a real one, an ignored one earlier may precede it.
    const fail = FAIL_LINE.exec(line);
    if (fail && this.task) this.failedIn.set(fail[1]!, this.task);
  }

  /** Servers in recap order; a failed task only for servers that ended up failed or unreachable. */
  result(): HostResult[] {
    return [...this.hosts.values()]
      .filter((h) => HOST_NAME.test(h.host))
      .map((h) => ({ ...h, failedTask: h.failed > 0 || h.unreachable > 0 ? this.failedIn.get(h.host) ?? null : null }));
  }
}

export function parseRecap(output: string): HostResult[] {
  const p = new RecapParser();
  for (const line of output.split("\n")) p.push(line);
  return p.result();
}

/** The server names of an environment's source row, re-validated on every read. */
export function parseAnsibleConfig(raw: unknown): string[] | null {
  const hosts = (raw as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > MAX_HOSTS) return null;
  if (!hosts.every((h) => typeof h === "string" && HOST_NAME.test(h))) return null;
  return [...new Set(hosts as string[])];
}

/** Where an admin reads a run's full log: Semaphore opens its task dialog for `?t=`. */
export function semaphoreRunUrl(conn: Pick<SemaphoreConnection, "url" | "projectId">, runId: number): string {
  return `${conn.url}/project/${conn.projectId}/history?t=${runId}`;
}

async function request(path: string, timeoutMs = TIMEOUT_MS): Promise<{ res: Response; conn: SemaphoreConnection }> {
  const conn = await semaphoreConnection();
  if (!conn) throw new SemaphoreError("Semaphore ist nicht angebunden (Verwaltung → Integrationen).");
  let res: Response;
  try {
    res = await fetch(`${conn.url}/api/project/${conn.projectId}${path}`, {
      headers: { authorization: `Bearer ${conn.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    throw new SemaphoreError(`Semaphore nicht erreichbar (${(err as Error).message})`);
  }
  if (res.status === 401 || res.status === 403) throw new SemaphoreError(`Semaphore lehnt das API-Token ab (HTTP ${res.status}). Der Benutzer muss Mitglied des Projekts sein.`);
  return { res, conn };
}

async function getJson<T>(path: string): Promise<T> {
  const { res } = await request(path);
  if (res.status === 404) throw new SemaphoreError(`Gibt es in Semaphore nicht: ${path}`);
  if (!res.ok) throw new SemaphoreError(`Semaphore antwortet mit HTTP ${res.status}.`);
  return (await res.json()) as T;
}

export const semaphore: SemaphoreApi = {
  project: () => getJson<{ id: number; name: string }>(""),
  lastTasks: async (limit) => (await getJson<SemaphoreTask[] | null>(`/tasks/last?limit=${Math.min(Math.max(1, limit), 200)}`)) ?? [],
  task: async (id) => {
    const { res } = await request(`/tasks/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new SemaphoreError(`Semaphore antwortet mit HTTP ${res.status}.`);
    return (await res.json()) as SemaphoreTask;
  },
  output: async (id, onLine) => {
    const { res } = await request(`/tasks/${id}/raw_output`, OUTPUT_TIMEOUT_MS);
    if (!res.ok || !res.body) throw new SemaphoreError(`Semaphore liefert die Ausgabe nicht (HTTP ${res.status}).`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let bytes = 0;
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        await reader.cancel();
        throw new SemaphoreError("Die Ausgabe des Laufs ist zu groß zum Auswerten.");
      }
      const lines = (rest + value).split("\n");
      rest = lines.pop()!;
      for (const line of lines) onLine(line);
    }
    if (rest) onLine(rest);
  },
};
