/**
 * Host checks: stores reports, keeps per-check state and raises / resolves alerts. Agent hosts push
 * reports (`/api/ingest/v1/report`); central hosts are swept over SSH every minute when due. Two
 * watchdogs: a host without a report for 3 intervals is `silent`, and a sweep that has not finished
 * in 5 minutes raises `ops:sweep` (otherwise central hosts would look healthy on stale data).
 */
import type { SQL } from "bun";
import { resolveAlertsWithPrefix, setAlert, subjectOf } from "../alerts";
import { all } from "../../shared/db";
import { formatDate } from "../../shared/ui/components";
import { effectiveThresholds, evaluateReport, thresholdHint, worstOf, type CheckResult } from "../../shared/hosts/evaluate";
import { MAX_REPORT_BYTES, parseReportText, type HostReport } from "../../shared/hosts/report";

export interface HostRow {
  id: number;
  name: string;
  mode: "agent" | "central";
  interval_seconds: number;
  ssh_target: string | null;
  environment_path: string | null;
  thresholds: Record<string, number>;
  enabled: boolean;
}

export interface MonitorOptions {
  sql: SQL;
  publicUrl: string;
  sshBin: string;
  agentScript: string;
  sshTimeoutMs?: number;
  sweepConcurrency?: number;
  /** Silent after this many missed intervals. */
  silentIntervals?: number;
  sweepStaleMs?: number;
  onAlert?: () => void;
  log?: (msg: string) => void;
}

const SEVERITY_TEXT: Record<string, string> = { warning: "Warnung", critical: "kritisch" };

export class HostMonitor {
  private timers: ReturnType<typeof setInterval>[] = [];
  private sweeping: Promise<void> | null = null;
  private rerun: Promise<void> | null = null;
  /** Start counts as a finished sweep, so a fresh process gets five minutes before the watchdog fires. */
  lastSweepFinishedAt = Date.now();
  lastSweepHosts = 0;

  constructor(private o: MonitorOptions) {}

  hostLink(id: number) {
    return `${this.o.publicUrl}/hosts/${id}`;
  }

  start() {
    this.timers.push(setInterval(() => void this.sweepOnce(), 60_000));
    this.timers.push(setInterval(() => void this.watchdogs(), 60_000));
    void this.sweepOnce();
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.sweeping;
  }

  private changed(change: unknown) {
    if (change) this.o.onAlert?.();
  }

  /** Stores an accepted report, updates check state and alerts. Returns the evaluated results. */
  async processReport(host: HostRow, report: HostReport, source: "agent" | "central"): Promise<CheckResult[]> {
    const t = effectiveThresholds(host.thresholds);
    const results = evaluateReport(report, t);
    const worst = worstOf(results);
    const keys = results.map((r) => r.key);
    await this.o.sql.begin(async (tx) => {
      await tx`insert into host_reports (host_id, source, report, results, worst) values (${host.id}, ${source}, ${report}::jsonb, ${results}::jsonb, ${worst})`;
      await tx`update hosts set last_report_at = now(), last_error = ${report.errors.length ? report.errors.join("; ").slice(0, 1000) : null},
               last_error_at = ${report.errors.length ? new Date() : null} where id = ${host.id}`;
      for (const r of results) {
        await tx`insert into check_states (host_id, check_key, severity, value, detail)
          values (${host.id}, ${r.key}, ${r.severity}, ${r.value}, ${r.detail})
          on conflict (host_id, check_key) do update set
            since = case when check_states.severity = excluded.severity then check_states.since else now() end,
            severity = excluded.severity, value = excluded.value, detail = excluded.detail, updated_at = now()`;
      }
      await tx`delete from check_states where host_id = ${host.id} and check_key <> all(${tx.array(keys.length ? keys : [""], "text")})`;
    });

    const prefix = `host:${host.name}:`;
    const link = this.hostLink(host.id);
    for (const r of results) {
      const subject = subjectOf("host", host.name, r.key);
      this.changed(
        await setAlert(
          this.o.sql,
          subject,
          r.severity === "ok"
            ? null
            : {
                severity: r.severity,
                title: `${host.name}: ${r.label} ${SEVERITY_TEXT[r.severity]}`,
                body: `${r.detail}. Schwellen: ${thresholdHint(r.key, t)}.`,
                link,
                environment: host.environment_path,
              },
          { title: `${host.name}: ${r.label} wieder in Ordnung`, body: r.detail, link, environment: host.environment_path },
        ),
      );
    }
    // Checks that disappeared from the report (filesystem unmounted, docker gone) cannot stay open.
    const current = new Set([...results.map((r) => subjectOf("host", host.name, r.key)), subjectOf("host", host.name, "silent")]);
    const open = await all<{ subject: string }>(this.o.sql`select subject from alerts where starts_with(subject, ${prefix})`);
    for (const a of open) {
      if (current.has(a.subject)) continue;
      this.changed(await setAlert(this.o.sql, a.subject, null, { title: `${host.name}: ${a.subject.slice(prefix.length)} wird nicht mehr gemeldet`, link }));
    }
    this.changed(
      await setAlert(this.o.sql, subjectOf("host", host.name, "silent"), null, {
        title: `${host.name} meldet sich wieder`,
        link,
        environment: host.environment_path,
      }),
    );
    return results;
  }

  /** Raises `host:<name>:silent` for every enabled host without a report for N intervals. */
  async detectSilent(): Promise<void> {
    const n = this.o.silentIntervals ?? 3;
    const hosts = await all<any>(this.o.sql`
      select id, name, environment_path, interval_seconds, last_report_at, created_at,
             coalesce(last_report_at, created_at) < now() - make_interval(secs => interval_seconds * ${n}) as silent
      from hosts where enabled`);
    const silentSubjects = new Set<string>();
    for (const h of hosts) {
      if (!h.silent) continue;
      const subject = subjectOf("host", h.name, "silent");
      silentSubjects.add(subject);
      this.changed(
        await setAlert(this.o.sql, subject, {
          severity: "critical",
          title: h.last_report_at ? `${h.name} meldet sich nicht mehr` : `${h.name} hat noch nie gemeldet`,
          body: h.last_report_at
            ? `Letzter Bericht: ${formatDate(h.last_report_at)}. Erwartet alle ${Math.round(h.interval_seconds / 60)} Minuten.`
            : `Angelegt ${formatDate(h.created_at)}, seitdem kein Bericht. Ist der Agent installiert und erreicht er Ops?`,
          link: this.hostLink(h.id),
          environment: h.environment_path,
        }),
      );
    }
    // Hosts that were disabled, or whose interval grew, are no longer silent.
    const open = await all<{ subject: string }>(this.o.sql`select subject from alerts where starts_with(subject, 'host:') and subject like '%:silent'`);
    for (const a of open) {
      if (!silentSubjects.has(a.subject)) this.changed(await setAlert(this.o.sql, a.subject, null, { title: `${a.subject.slice(5, -7)}: nicht mehr überwacht oder wieder aktiv` }));
    }
  }

  async checkSweepHealth(now = Date.now()): Promise<void> {
    const stale = now - this.lastSweepFinishedAt > (this.o.sweepStaleMs ?? 5 * 60_000);
    this.changed(
      await setAlert(
        this.o.sql,
        "ops:sweep",
        stale
          ? {
              severity: "critical",
              title: "Ops: Die zentrale Host-Prüfung hängt",
              body: `Kein abgeschlossener SSH-Durchlauf seit ${formatDate(new Date(this.lastSweepFinishedAt))}. Die Werte der zentral geprüften Hosts sind veraltet.`,
              link: `${this.o.publicUrl}/hosts`,
            }
          : null,
        { title: "Ops: Die zentrale Host-Prüfung läuft wieder", link: `${this.o.publicUrl}/hosts` },
      ),
    );
  }

  async watchdogs() {
    try {
      await this.detectSilent();
      await this.checkSweepHealth();
    } catch (err) {
      this.o.log?.(`[ops] watchdogs: ${(err as Error).message}`);
    }
  }

  /**
   * One pass over the central hosts that are due (never checked, or last attempt one interval ago).
   * Never overlaps with itself: a call during a pass schedules exactly one more pass after it, so a
   * host added or reset ("Jetzt prüfen" clears last_attempt_at) meanwhile is not skipped.
   */
  sweepOnce(): Promise<void> {
    if (this.sweeping) {
      this.rerun ??= this.sweeping.then(() => {
        this.rerun = null;
        return this.sweepOnce();
      });
      return this.rerun;
    }
    this.sweeping = this.sweep()
      .catch((err) => this.o.log?.(`[ops] sweep: ${(err as Error).message}`))
      .finally(() => {
        this.sweeping = null;
      });
    return this.sweeping;
  }

  private async sweep() {
    const due = await all<HostRow>(this.o.sql`
      select id, name, mode, interval_seconds, ssh_target, environment_path, thresholds, enabled from hosts
      where enabled and mode = 'central' and ssh_target is not null
        and (last_attempt_at is null or last_attempt_at <= now() - make_interval(secs => interval_seconds - 10))
      order by last_attempt_at nulls first`);
    const queue = [...due];
    const worker = async () => {
      for (let h = queue.shift(); h; h = queue.shift()) await this.checkCentral(h);
    };
    await Promise.all(Array.from({ length: Math.min(this.o.sweepConcurrency ?? 4, queue.length) }, worker));
    this.lastSweepFinishedAt = Date.now();
    this.lastSweepHosts = due.length;
    await this.checkSweepHealth();
  }

  private async checkCentral(host: HostRow) {
    await this.o.sql`update hosts set last_attempt_at = now() where id = ${host.id}`;
    const result = await this.collect(host.ssh_target!);
    if (result.ok) {
      await this.processReport(host, result.report, "central");
    } else {
      await this.o.sql`update hosts set last_error = ${result.error}, last_error_at = now() where id = ${host.id}`;
    }
  }

  /** `ssh <target> 'sh -s -- --print' < agent/vantage-agent.sh`, parsed with the same validator as pushed reports. */
  async collect(target: string): Promise<{ ok: true; report: HostReport } | { ok: false; error: string }> {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" };
    if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
    let proc;
    try {
      // Own process group, so the timeout also kills anything ssh started (ProxyCommand) that holds the pipes.
      proc = Bun.spawn([this.o.sshBin, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target, "sh -s -- --print"], {
        stdin: Bun.file(this.o.agentScript),
        stdout: "pipe",
        stderr: "pipe",
        env,
        detached: true,
      });
    } catch (err) {
      return { ok: false, error: `ssh konnte nicht gestartet werden: ${(err as Error).message}` };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }, this.o.sshTimeoutMs ?? 120_000);
    const [out, err, code] = await Promise.all([readCapped(proc.stdout, MAX_REPORT_BYTES + 1), readCapped(proc.stderr, 4096), proc.exited]).finally(() =>
      clearTimeout(timer),
    );
    if (timedOut) return { ok: false, error: `ssh nach ${Math.round((this.o.sshTimeoutMs ?? 120_000) / 1000)} s abgebrochen` };
    if (code !== 0) return { ok: false, error: `ssh endete mit Exit-Code ${code}${err.trim() ? `: ${err.trim().split("\n").slice(-3).join(" ").slice(0, 400)}` : ""}` };
    const parsed = parseReportText(out);
    return parsed.ok ? parsed : { ok: false, error: `Ungültiger Bericht: ${parsed.error}` };
  }

  /** Host deleted or renamed: its alerts must not stay open under a subject nobody updates. */
  async forgetHost(name: string, why: string) {
    const n = await resolveAlertsWithPrefix(this.o.sql, `host:${name}:`, (subject) => `${name}: ${subject.slice(name.length + 6)} – ${why}`);
    this.changed(n);
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size < max) {
      chunks.push(value.subarray(0, max - size));
      size += Math.min(value.length, max - size);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
