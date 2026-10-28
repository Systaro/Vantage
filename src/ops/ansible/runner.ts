/**
 * Runs `ansible-playbook` for templates: one run per template at a time (a partial unique index on
 * `runs`), at most `maxConcurrent` at once (the rest wait in a FIFO queue), argv only (never a
 * shell), a minimal environment, output written straight into `OPS_DATA_DIR/runs/<id>.log`.
 * Cancel sends SIGTERM to the run's process group and SIGKILL after `killAfterMs`.
 */
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { SQL, Subprocess } from "bun";
import { setAlert, subjectOf } from "../alerts";
import { first } from "../../shared/db";
import { checkProjectPath } from "./paths";

export type Trigger = "manual" | "schedule";
export type RunStatus = "queued" | "running" | "ok" | "failed" | "cancelled" | "error";
export const ACTIVE: RunStatus[] = ["queued", "running"];

export interface RunnerOptions {
  sql: SQL;
  projectDir: string;
  dataDir: string;
  publicUrl: string;
  bin: string;
  gitBin: string;
  gitPull: boolean;
  maxConcurrent?: number;
  killAfterMs?: number;
  /** Called after an alert changed, so the outbox can deliver right away. */
  onAlert?: () => void;
  log?: (msg: string) => void;
}

export type StartResult = { ok: true; runId: number } | { ok: false; code: "not_found" | "disabled" | "busy" | "stopping"; message: string };

interface Active {
  proc: Subprocess | null;
  cancelledBy: string | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AnsibleRunner {
  private queue: number[] = [];
  private active = new Map<number, Active>();
  private accepting = true;
  private gitLock: Promise<unknown> = Promise.resolve();
  readonly maxConcurrent: number;
  private killAfterMs: number;

  constructor(private o: RunnerOptions) {
    this.maxConcurrent = o.maxConcurrent ?? 2;
    this.killAfterMs = o.killAfterMs ?? 10_000;
  }

  logPath(runId: number): string {
    return join(this.o.dataDir, "runs", `${runId}.log`);
  }

  get runningIds(): number[] {
    return [...this.active.keys()];
  }

  get queuedIds(): number[] {
    return [...this.queue];
  }

  /** Runs left over from a previous process can never finish; mark them so the history is honest. */
  async recover(): Promise<number> {
    const rows = await this.o.sql`update runs set status = 'error', finished_at = now(),
      error = 'Ops wurde neu gestartet, bevor der Lauf beendet war.'
      where status in ('queued', 'running') returning id`;
    return rows.length;
  }

  async start(templateId: number, trigger: Trigger, actor: { id: number | null; label: string }): Promise<StartResult> {
    if (!this.accepting) return { ok: false, code: "stopping", message: "Ops fährt gerade herunter." };
    const t = await first<any>(this.o.sql`select * from templates where id = ${templateId}`);
    if (!t) return { ok: false, code: "not_found", message: "Vorlage nicht gefunden." };
    if (!t.enabled) return { ok: false, code: "disabled", message: "Die Vorlage ist deaktiviert." };
    let runId: number;
    try {
      const row = await first<{ id: number }>(this.o.sql`
        insert into runs (template_id, template_name, playbook, inventory, limit_hosts, extra_vars, check_mode, trigger, started_by, started_by_label)
        values (${t.id}, ${t.name}, ${t.playbook}, ${t.inventory}, ${t.limit_hosts}, ${t.extra_vars}::jsonb, ${t.check_mode},
                ${trigger}, ${actor.id}, ${actor.label})
        returning id`);
      runId = row!.id;
    } catch (err) {
      if (/runs_one_active_per_template|duplicate key/.test((err as Error).message)) {
        return { ok: false, code: "busy", message: "Für diese Vorlage läuft schon ein Lauf oder wartet in der Warteschlange." };
      }
      throw err;
    }
    this.queue.push(runId);
    this.pump();
    return { ok: true, runId };
  }

  async cancel(runId: number, by: string): Promise<boolean> {
    const queuedAt = this.queue.indexOf(runId);
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1);
      await this.o.sql`update runs set status = 'cancelled', cancelled_by_label = ${by}, finished_at = now()
                       where id = ${runId} and status = 'queued'`;
      return true;
    }
    const a = this.active.get(runId);
    if (!a || a.cancelledBy) return Boolean(a);
    a.cancelledBy = by;
    await this.o.sql`update runs set cancelled_by_label = ${by} where id = ${runId}`;
    if (a.proc) this.terminate(a);
    return true;
  }

  /** Stops taking runs, gives running ones `graceMs` to finish, then cancels them. */
  async shutdown(graceMs = 30_000): Promise<void> {
    this.accepting = false;
    for (const id of this.queue.splice(0)) {
      await this.o.sql`update runs set status = 'cancelled', cancelled_by_label = 'Ops-Neustart', finished_at = now()
                       where id = ${id} and status = 'queued'`;
    }
    const all = () => Promise.all([...this.active.values()].map((a) => a.done));
    const finished = await Promise.race([all().then(() => true), sleep(graceMs).then(() => false)]);
    if (!finished) {
      for (const id of this.active.keys()) await this.cancel(id, "Ops-Neustart");
      await all();
    }
  }

  /** Resolves once nothing is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.queue.length || this.active.size) {
      await Promise.all([...this.active.values()].map((a) => a.done));
      await sleep(5);
    }
  }

  private pump() {
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!;
      const a: Active = { proc: null, cancelledBy: null, killTimer: null, done: Promise.resolve() };
      this.active.set(id, a);
      a.done = this.execute(id, a)
        .catch(async (err) => {
          this.o.log?.(`[ops] run ${id}: ${(err as Error).stack ?? err}`);
          await this.o.sql`update runs set status = 'error', error = ${String((err as Error).message).slice(0, 500)}, finished_at = now()
                           where id = ${id} and status in ('queued', 'running')`.catch(() => {});
        })
        .finally(() => {
          if (a.killTimer) clearTimeout(a.killTimer);
          this.active.delete(id);
          this.pump();
        });
    }
  }

  private terminate(a: Active) {
    const signal = (sig: "SIGTERM" | "SIGKILL") => {
      const pid = a.proc?.pid;
      if (!pid || a.proc?.exitCode !== null || a.proc?.signalCode) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          a.proc?.kill(sig);
        } catch {}
      }
    };
    signal("SIGTERM");
    a.killTimer = setTimeout(() => signal("SIGKILL"), this.killAfterMs);
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      ANSIBLE_FORCE_COLOR: "0",
      ANSIBLE_NOCOLOR: "1",
      // Ansible's own output is line-buffered when unbuffered; without it the live log arrives in 4 KB lumps.
      PYTHONUNBUFFERED: "1",
    };
    // Ansible refuses to start without a UTF-8 locale.
    for (const k of ["LANG", "LC_ALL"]) if (process.env[k]) env[k] = process.env[k]!;
    const cfg = join(this.o.projectDir, "ansible.cfg");
    if (existsSync(cfg)) env.ANSIBLE_CONFIG = cfg;
    return env;
  }

  private async spawnInto(a: Active, fd: number, argv: string[]): Promise<number> {
    const proc = Bun.spawn(argv, { cwd: this.o.projectDir, env: this.env(), stdin: "ignore", stdout: fd, stderr: fd, detached: true });
    a.proc = proc;
    if (a.cancelledBy) this.terminate(a);
    const code = await proc.exited;
    a.proc = null;
    return code;
  }

  private async execute(runId: number, a: Active) {
    const started = await first<any>(this.o.sql`update runs set status = 'running', started_at = now()
      where id = ${runId} and status = 'queued' returning *`);
    if (!started) return;
    const t0 = Date.now();
    mkdirSync(join(this.o.dataDir, "runs"), { recursive: true });
    // "w", not "a": run ids can repeat after a database restore, and a new run must not inherit an old log.
    const fd = openSync(this.logPath(runId), "w", 0o640);
    const write = (s: string) => writeSync(fd, s);
    let status: RunStatus = "error";
    let exitCode: number | null = null;
    let error: string | null = null;
    try {
      write(`# Lauf #${runId} · Vorlage „${started.template_name}“ · ${started.trigger === "schedule" ? "Zeitplan" : `gestartet von ${started.started_by_label}`}\n`);
      if (this.o.gitPull) {
        write(`# git pull --ff-only\n`);
        const code = await this.withGitLock(() => this.spawnInto(a, fd, [this.o.gitBin, "-C", this.o.projectDir, "pull", "--ff-only"]));
        if (code !== 0 && !a.cancelledBy) {
          error = `git pull ist fehlgeschlagen (Exit-Code ${code}).`;
          exitCode = code;
        }
      }
      if (!error && !a.cancelledBy) {
        const playbook = checkProjectPath(this.o.projectDir, started.playbook, "playbook");
        const inventory = checkProjectPath(this.o.projectDir, started.inventory, "inventory");
        if (!playbook.ok) error = playbook.error;
        else if (!inventory.ok) error = inventory.error;
        else {
          const argv = [this.o.bin, `--inventory=./${inventory.rel}`];
          if (started.limit_hosts) argv.push(`--limit=${started.limit_hosts}`);
          if (started.extra_vars && Object.keys(started.extra_vars).length) argv.push(`--extra-vars=${JSON.stringify(started.extra_vars)}`);
          if (started.check_mode) argv.push("--check");
          argv.push(`./${playbook.rel}`);
          write(`# ${argv.map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`)).join(" ")}\n\n`);
          exitCode = await this.spawnInto(a, fd, argv);
        }
      }
      if (error) write(`\n# Fehler: ${error}\n`);
      status = a.cancelledBy ? "cancelled" : error ? "error" : exitCode === 0 ? "ok" : "failed";
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
      write(`\n# Fehler: ${error}\n`);
      status = a.cancelledBy ? "cancelled" : "error";
    } finally {
      const ms = Date.now() - t0;
      try {
        write(`\n# Ende: ${STATUS_TEXT[status]}${exitCode !== null ? `, Exit-Code ${exitCode}` : ""}${a.cancelledBy ? `, abgebrochen von ${a.cancelledBy}` : ""}\n`);
      } catch {}
      closeSync(fd);
      await this.o.sql`update runs set status = ${status}, exit_code = ${exitCode}, error = ${error}, finished_at = now(), duration_ms = ${ms}
                       where id = ${runId}`;
    }
    if (started.trigger === "schedule" && started.template_id) await this.reportScheduled(started, runId, status, exitCode, error);
  }

  private async reportScheduled(run: any, runId: number, status: RunStatus, exitCode: number | null, error: string | null) {
    const subject = subjectOf("ansible", run.template_name);
    const link = `${this.o.publicUrl}/runs/${runId}`;
    let change = null;
    if (status === "failed" || status === "error") {
      change = await setAlert(this.o.sql, subject, {
        severity: "warning",
        title: `Geplanter Ansible-Lauf „${run.template_name}“ fehlgeschlagen`,
        body: error ?? `ansible-playbook endete mit Exit-Code ${exitCode}. Details im Lauf-Log in Vantage Ops.`,
        link,
      });
    } else if (status === "ok") {
      change = await setAlert(this.o.sql, subject, null, { title: `Geplanter Ansible-Lauf „${run.template_name}“ wieder erfolgreich`, link });
    }
    if (change) this.o.onAlert?.();
  }

  private withGitLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gitLock.then(fn, fn);
    this.gitLock = next.catch(() => {});
    return next;
  }
}

export const STATUS_TEXT: Record<RunStatus, string> = {
  queued: "wartet",
  running: "läuft",
  ok: "erfolgreich",
  failed: "fehlgeschlagen",
  cancelled: "abgebrochen",
  error: "Fehler",
};
