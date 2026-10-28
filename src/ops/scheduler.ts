/**
 * Cron jobs for templates and pipeline schedules (croner, Europe/Berlin), synced from the database
 * at start and after every edit, plus the hourly retention job.
 */
import { rmSync } from "node:fs";
import type { SQL } from "bun";
import { Cron } from "croner";
import { TIMEZONE } from "./cron";
import { all } from "../shared/db";

export interface SchedulerActions {
  runTemplate(id: number): Promise<unknown>;
  triggerPipeline(id: number): Promise<unknown>;
}

interface Job {
  expr: string;
  cron: Cron;
}

export class Scheduler {
  private jobs = new Map<string, Job>();
  private stopped = false;

  constructor(private sql: SQL, private actions: SchedulerActions, private log: (msg: string) => void = () => {}) {}

  /** The jobs that should exist, keyed `template:<id>` / `pipeline:<id>`. */
  async desired(): Promise<Map<string, { expr: string; fire: () => Promise<unknown> }>> {
    const out = new Map<string, { expr: string; fire: () => Promise<unknown> }>();
    const templates = await all<{ id: number; schedule: string }>(this.sql`select id, schedule from templates where enabled and schedule is not null`);
    for (const t of templates) out.set(`template:${t.id}`, { expr: t.schedule, fire: () => this.actions.runTemplate(t.id) });
    const pipelines = await all<{ id: number; schedule: string }>(this.sql`select id, schedule from pipeline_schedules where enabled and schedule is not null`);
    for (const p of pipelines) out.set(`pipeline:${p.id}`, { expr: p.schedule, fire: () => this.actions.triggerPipeline(p.id) });
    return out;
  }

  async sync(): Promise<void> {
    if (this.stopped) return;
    const want = await this.desired();
    for (const [key, job] of this.jobs) {
      if (want.get(key)?.expr !== job.expr) {
        job.cron.stop();
        this.jobs.delete(key);
      }
    }
    for (const [key, w] of want) {
      if (this.jobs.has(key)) continue;
      try {
        const cron = new Cron(w.expr, { timezone: TIMEZONE, protect: true, catch: (err) => this.log(`[ops] ${key}: ${(err as Error).message}`) }, async () => {
          this.log(`[ops] schedule ${key} fires`);
          await w.fire();
        });
        this.jobs.set(key, { expr: w.expr, cron });
      } catch (err) {
        this.log(`[ops] ${key}: invalid schedule "${w.expr}": ${(err as Error).message}`);
      }
    }
  }

  nextRun(key: string): Date | null {
    return this.jobs.get(key)?.cron.nextRun() ?? null;
  }

  keys(): string[] {
    return [...this.jobs.keys()];
  }

  /** Fires a job now, the way its timer would (tests). */
  async fire(key: string): Promise<void> {
    await this.jobs.get(key)?.cron.trigger();
  }

  stop() {
    this.stopped = true;
    for (const job of this.jobs.values()) job.cron.stop();
    this.jobs.clear();
  }
}

export const RETENTION = {
  runLogsDays: 90,
  hostReportsDays: 30,
  outboxSentDays: 30,
  outboxFailedDays: 90,
  pipelineTriggersDays: 365,
  loginAttemptsDays: 30,
  auditYears: 2,
};

/** Deletes what §7 of docs/design.md says ops keeps no longer. Returns counts for the log. */
export async function runRetention(sql: SQL, logPath: (runId: number) => string): Promise<Record<string, number>> {
  const runs = await all<{ id: number }>(sql`
    update runs set log_deleted_at = now()
    where log_deleted_at is null and status not in ('queued', 'running')
      and coalesce(finished_at, queued_at) < now() - make_interval(days => ${RETENTION.runLogsDays})
    returning id`);
  for (const r of runs) rmSync(logPath(r.id), { force: true });
  const count = async (q: Promise<unknown>) => ((await q) as unknown[]).length;
  return {
    runLogs: runs.length,
    hostReports: await count(sql`delete from host_reports where at < now() - make_interval(days => ${RETENTION.hostReportsDays}) returning 1`),
    outboxSent: await count(sql`delete from outbox where status = 'sent' and created_at < now() - make_interval(days => ${RETENTION.outboxSentDays}) returning 1`),
    outboxFailed: await count(sql`delete from outbox where status = 'failed' and created_at < now() - make_interval(days => ${RETENTION.outboxFailedDays}) returning 1`),
    pipelineTriggers: await count(sql`delete from pipeline_triggers where at < now() - make_interval(days => ${RETENTION.pipelineTriggersDays}) returning 1`),
    loginAttempts: await count(sql`delete from login_attempts where at < now() - make_interval(days => ${RETENTION.loginAttemptsDays}) returning 1`),
    sessions: await count(sql`delete from sessions where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days' returning 1`),
    invites: await count(sql`delete from invites where (used_at is not null or expires_at < now()) and created_at < now() - interval '30 days' returning 1`),
    audit: await count(sql`delete from audit_log where at < now() - make_interval(years => ${RETENTION.auditYears}) returning 1`),
  };
}
