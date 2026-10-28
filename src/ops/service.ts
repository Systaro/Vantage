/**
 * Everything ops runs in-process, wired once: the Ansible runner, host monitor, scheduler, outbox
 * sender and retention. `src/ops/index.tsx` starts it next to the HTTP server; tests build it
 * against a throwaway database with fake binaries and stub servers.
 */
import type { SQL } from "bun";
import { AnsibleRunner } from "./ansible/runner";
import type { OpsConfig } from "./config";
import { HostMonitor } from "./hosts/monitor";
import { OutboxSender } from "./outbox";
import { runPipelineSchedule, type PipelineDeps } from "./pipelines/gitlab";
import { runRetention, Scheduler } from "./scheduler";

export interface Ops {
  sql: SQL;
  config: OpsConfig;
  runner: AnsibleRunner;
  monitor: HostMonitor;
  outbox: OutboxSender;
  scheduler: Scheduler;
  pipelines: PipelineDeps;
  startedAt: Date;
  start(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}

export interface OpsOverrides {
  fetch?: typeof fetch;
  maxConcurrent?: number;
  killAfterMs?: number;
  log?: (msg: string) => void;
}

export function createOps(config: OpsConfig, sql: SQL, overrides: OpsOverrides = {}): Ops {
  const log = overrides.log ?? ((msg: string) => console.log(msg));
  const outbox = new OutboxSender(sql, { hubUrl: config.hubUrl, token: config.hubEventToken, fetch: overrides.fetch, log });
  const onAlert = () => outbox.wake();
  const runner = new AnsibleRunner({
    sql,
    projectDir: config.ansible.projectDir,
    dataDir: config.dataDir,
    publicUrl: config.publicUrl,
    bin: config.ansible.bin,
    gitBin: config.ansible.gitBin,
    gitPull: config.ansible.gitPull,
    maxConcurrent: overrides.maxConcurrent,
    killAfterMs: overrides.killAfterMs,
    onAlert,
    log,
  });
  const monitor = new HostMonitor({ sql, publicUrl: config.publicUrl, sshBin: config.sshBin, agentScript: config.agentScript, onAlert, log });
  const pipelines: PipelineDeps = { sql, secret: config.secret, gitlabUrl: config.gitlabUrl, publicUrl: config.publicUrl, fetch: overrides.fetch, onAlert };
  const scheduler = new Scheduler(
    sql,
    {
      async runTemplate(id) {
        const r = await runner.start(id, "schedule", { id: null, label: "Zeitplan" });
        if (!r.ok) log(`[ops] scheduled run of template ${id} skipped: ${r.message}`);
      },
      async triggerPipeline(id) {
        const r = await runPipelineSchedule(pipelines, id, "schedule", { id: null, label: "Zeitplan" });
        if (!r.ok) log(`[ops] scheduled pipeline ${id}: ${r.message}`);
      },
    },
    log,
  );
  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  const retention = async () => {
    try {
      const counts = await runRetention(sql, (id) => runner.logPath(id));
      const removed = Object.entries(counts).filter(([, n]) => n > 0);
      if (removed.length) log(`[ops] retention: ${removed.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    } catch (err) {
      log(`[ops] retention: ${(err as Error).message}`);
    }
  };

  return {
    sql,
    config,
    runner,
    monitor,
    outbox,
    scheduler,
    pipelines,
    startedAt: new Date(),
    async start() {
      const recovered = await runner.recover();
      if (recovered) log(`[ops] marked ${recovered} run(s) from the previous process as interrupted`);
      await scheduler.sync();
      monitor.start();
      outbox.start();
      void retention();
      retentionTimer = setInterval(() => void retention(), 3_600_000);
    },
    async stop(graceMs = 30_000) {
      scheduler.stop();
      if (retentionTimer) clearInterval(retentionTimer);
      await monitor.stop();
      await runner.shutdown(graceMs);
      await outbox.flush();
      await outbox.stop();
    },
  };
}
