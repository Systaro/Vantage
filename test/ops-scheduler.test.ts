import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cronProblem, nextRun } from "../src/ops/cron";
import { runRetention } from "../src/ops/scheduler";
import { createOpsHarness, type OpsHarness } from "./helpers/ops";

describe("cron expressions", () => {
  test("five fields only, valid ranges, must fire at some point", () => {
    expect(cronProblem("30 2 * * *")).toBeNull();
    expect(cronProblem("*/15 6-22 * * 1-5")).toBeNull();
    expect(cronProblem("0 3 1 * *")).toBeNull();
    expect(cronProblem("* * * * * *")).toContain("fünf Felder"); // seconds would run far too often
    expect(cronProblem("0 3 * *")).toContain("fünf Felder");
    expect(cronProblem("61 * * * *")).toContain("ungültig");
    expect(cronProblem("0 25 * * *")).toContain("ungültig");
    expect(cronProblem("@daily")).toContain("fünf Felder");
  });

  test("next run is computed in Europe/Berlin, across the DST change", () => {
    // 2026-10-25 03:00 CEST becomes 02:00 CET. A 02:30 job on the 24th is 00:30 UTC, on the 26th 01:30 UTC.
    expect(nextRun("30 2 * * *", new Date("2026-10-24T00:00:00Z"))!.toISOString()).toBe("2026-10-24T00:30:00.000Z");
    expect(nextRun("30 2 * * *", new Date("2026-10-26T00:00:00Z"))!.toISOString()).toBe("2026-10-26T01:30:00.000Z");
    expect(nextRun(null)).toBeNull();
    expect(nextRun("not cron")).toBeNull();
  });
});

describe("scheduler", () => {
  let h: OpsHarness;
  const started: number[] = [];

  beforeAll(async () => {
    h = await createOpsHarness();
    // Only the scheduling decision is tested here; the runner itself has its own tests.
    (h.ops.runner as any).start = async (id: number, trigger: string) => {
      if (trigger === "schedule") started.push(id);
      return { ok: true, runId: 0 };
    };
  });
  afterAll(() => h.close());

  const template = async (name: string, schedule: string | null, enabled = true) =>
    ((await h.sql`insert into templates (name, playbook, inventory, schedule, enabled) values (${name}, 'ping-local.yml', 'inventory/local.ini', ${schedule}, ${enabled}) returning id`) as { id: number }[])[0]!.id;

  test("sync schedules enabled templates with a cron, and nothing else", async () => {
    const a = await template("nightly", "30 2 * * *");
    await template("manual", null);
    await template("off", "0 * * * *", false);
    await h.sql`insert into pipeline_schedules (name, project, ref, token_enc, token_hint, schedule) values ('e2e', '42', 'main', 'v1.x.y', 'xxxx', '0 3 * * *')`;
    await h.ops.scheduler.sync();
    expect(h.ops.scheduler.keys().sort()).toEqual([`pipeline:1`, `template:${a}`]);
    const next = h.ops.scheduler.nextRun(`template:${a}`)!;
    const berlin = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(next);
    expect(berlin).toBe("02:30");
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(25 * 3600_000);
  });

  test("an edited expression replaces the job; disabling removes it", async () => {
    const id = (await h.sql`select id from templates where name = 'nightly'`)[0].id as number;
    await h.sql`update templates set schedule = '15 4 * * 1' where id = ${id}`;
    await h.ops.scheduler.sync();
    const next = h.ops.scheduler.nextRun(`template:${id}`)!;
    const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "Europe/Berlin" }).format(next);
    expect([part({ weekday: "long" }), part({ hour: "2-digit", minute: "2-digit" })]).toEqual(["Monday", "04:15"]);
    await h.sql`update templates set enabled = false where id = ${id}`;
    await h.ops.scheduler.sync();
    expect(h.ops.scheduler.keys()).not.toContain(`template:${id}`);
    await h.sql`update templates set enabled = true where id = ${id}`;
    await h.ops.scheduler.sync();
  });

  test("when a job fires it starts a scheduled run of its template", async () => {
    const id = (await h.sql`select id from templates where name = 'nightly'`)[0].id as number;
    started.length = 0;
    await h.ops.scheduler.fire(`template:${id}`);
    expect(started).toEqual([id]);
  });

  test("saving a template in the UI re-syncs the schedule", async () => {
    const res = await h.request("/templates", {
      cookie: h.users.admin.cookie,
      form: { name: "via UI", playbook: "ping-local.yml", inventory: "inventory/local.ini", schedule: "0 6 * * *", enabled: "1" },
    });
    const id = Number(res.headers.get("location")!.split("/").pop());
    expect(h.ops.scheduler.keys()).toContain(`template:${id}`);
    await h.request(`/templates/${id}/delete`, { cookie: h.users.admin.cookie, method: "POST" });
    expect(h.ops.scheduler.keys()).not.toContain(`template:${id}`);
  });

  test("stop() removes every job", async () => {
    const s = new (h.ops.scheduler.constructor as any)(h.sql, { runTemplate: async () => {}, triggerPipeline: async () => {} });
    await s.sync();
    expect(s.keys().length).toBeGreaterThan(0);
    s.stop();
    expect(s.keys()).toEqual([]);
    await s.sync();
    expect(s.keys()).toEqual([]);
  });
});

describe("retention", () => {
  let h: OpsHarness;
  beforeAll(async () => {
    h = await createOpsHarness();
  });
  afterAll(() => h.close());

  test("run logs older than 90 days go (the run row stays), host reports after 30 days, sent events after 30 days", async () => {
    const insertRun = async (daysAgo: number, status = "ok") =>
      ((await h.sql`insert into runs (template_name, playbook, inventory, limit_hosts, extra_vars, check_mode, trigger, started_by_label, status, queued_at, finished_at)
        values ('t', 'p.yml', 'i', '', '{}'::jsonb, false, 'manual', 'x', ${status}, now() - make_interval(days => ${daysAgo}), now() - make_interval(days => ${daysAgo}))
        returning id`) as { id: number }[])[0]!.id;
    const old = await insertRun(91);
    const recent = await insertRun(10);
    for (const id of [old, recent]) {
      const path = h.ops.runner.logPath(id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "log\n");
    }
    const [host] = (await h.sql`insert into hosts (name, mode) values ('r1', 'agent') returning id`) as { id: number }[];
    await h.sql`insert into host_reports (host_id, at, source, report, results, worst) values
      (${host!.id}, now() - interval '31 days', 'agent', '{}'::jsonb, '[]'::jsonb, 'ok'),
      (${host!.id}, now() - interval '29 days', 'agent', '{}'::jsonb, '[]'::jsonb, 'ok')`;
    await h.sql`insert into outbox (subject, state, severity, title, status, created_at) values
      ('a', 'notice', 'info', 'sent old', 'sent', now() - interval '31 days'),
      ('b', 'notice', 'info', 'pending old', 'pending', now() - interval '200 days'),
      ('c', 'notice', 'info', 'failed old', 'failed', now() - interval '31 days')`;

    const counts = await runRetention(h.sql, (id) => h.ops.runner.logPath(id));
    expect(counts).toMatchObject({ runLogs: 1, hostReports: 1, outboxSent: 1, outboxFailed: 0 });
    expect(existsSync(h.ops.runner.logPath(old))).toBe(false);
    expect(existsSync(h.ops.runner.logPath(recent))).toBe(true);
    const runs = (await h.sql`select id, log_deleted_at is not null as deleted from runs order by id`) as any[];
    expect(runs).toEqual([{ id: old, deleted: true }, { id: recent, deleted: false }]);
    // Pending events are never dropped.
    expect(((await h.sql`select title from outbox order by id`) as any[]).map((r) => r.title)).toEqual(["pending old", "failed old"]);
    // The run page says why the log is gone instead of failing.
    const page = await (await h.request(`/runs/${old}`, { cookie: h.users.viewer.cookie })).text();
    expect(page).toContain("nach 90 Tagen gelöscht");
  });
});
