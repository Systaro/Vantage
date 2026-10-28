import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { checkProjectPath } from "../src/ops/ansible/paths";
import { parseTemplate } from "../src/ops/routes/templates";
import { createOpsHarness, flashOf, outboxRows, writeExecutable, type OpsHarness } from "./helpers/ops";

const form = (values: Record<string, string>) => ({ get: (k: string) => values[k] ?? "" });

describe("project paths", () => {
  let root: string;
  let project: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "vantage-paths-"));
    project = join(root, "project");
    mkdirSync(join(project, "playbooks"), { recursive: true });
    mkdirSync(join(project, "inventories", "prod"), { recursive: true });
    writeFileSync(join(project, "site.yml"), "- hosts: all\n");
    writeFileSync(join(project, "playbooks", "deploy.yaml"), "- hosts: all\n");
    writeFileSync(join(project, "inventories", "prod", "hosts.ini"), "[all]\n");
    writeFileSync(join(project, "README.md"), "no playbook\n");
    writeFileSync(join(root, "outside.yml"), "- hosts: all\n");
    mkdirSync(join(root, "outside-dir"));
    symlinkSync(join(root, "outside.yml"), join(project, "escape.yml"));
    symlinkSync(join(root, "outside-dir"), join(project, "linked-dir"));
    symlinkSync(join(project, "site.yml"), join(project, "alias.yml"));
    writeFileSync(join(project, "-e.yml"), "- hosts: all\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("accepts playbooks and inventories inside the project", () => {
    expect(checkProjectPath(project, "site.yml", "playbook")).toMatchObject({ ok: true, rel: "site.yml" });
    expect(checkProjectPath(project, "./playbooks/deploy.yaml", "playbook")).toMatchObject({ ok: true, rel: "playbooks/deploy.yaml" });
    expect(checkProjectPath(project, "inventories/prod/hosts.ini", "inventory")).toMatchObject({ ok: true });
    expect(checkProjectPath(project, "inventories/prod", "inventory")).toMatchObject({ ok: true });
    // A symlink that stays inside the project is fine.
    expect(checkProjectPath(project, "alias.yml", "playbook")).toMatchObject({ ok: true, rel: "alias.yml" });
  });

  test("rejects traversal, absolute paths and home paths", () => {
    expect(checkProjectPath(project, "../outside.yml", "playbook").ok).toBe(false);
    expect(checkProjectPath(project, "playbooks/../../outside.yml", "playbook").ok).toBe(false);
    expect(checkProjectPath(project, join(root, "outside.yml"), "playbook").ok).toBe(false);
    expect(checkProjectPath(project, "/etc/hosts", "inventory").ok).toBe(false);
    expect(checkProjectPath(project, "~/site.yml", "playbook").ok).toBe(false);
    expect(checkProjectPath(project, "..", "inventory").ok).toBe(false);
    expect(checkProjectPath(project, ".", "inventory").ok).toBe(false);
  });

  test("rejects symlinks that escape the project", () => {
    const r = checkProjectPath(project, "escape.yml", "playbook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("hinaus");
    expect(checkProjectPath(project, "linked-dir", "inventory").ok).toBe(false);
  });

  test("rejects option-like names, control characters, missing files and non-YAML playbooks", () => {
    expect(checkProjectPath(project, "-e.yml", "playbook").ok).toBe(false);
    expect(checkProjectPath(project, "site.yml\n", "playbook").ok).toBe(true); // trimmed
    expect(checkProjectPath(project, "si\u0000te.yml", "playbook").ok).toBe(false);
    expect(checkProjectPath(project, "missing.yml", "playbook").ok).toBe(false);
    expect(checkProjectPath(project, "README.md", "playbook").ok).toBe(false);
    expect(checkProjectPath(project, "playbooks", "playbook").ok).toBe(false);
    expect(checkProjectPath(join(root, "nope"), "site.yml", "playbook").ok).toBe(false);
  });

  test("template form validation: limit charset, extra vars object, cron", () => {
    const base = { name: "Deploy", playbook: "site.yml", inventory: "inventories/prod", enabled: "1" };
    expect(parseTemplate(project, form({ ...base, limit_hosts: "web:!web3,db[0:2]" })).ok).toBe(true);
    expect(parseTemplate(project, form({ ...base, limit_hosts: "web; rm -rf /" })).ok).toBe(false);
    expect(parseTemplate(project, form({ ...base, limit_hosts: "@retry.txt" })).ok).toBe(false);
    expect(parseTemplate(project, form({ ...base, limit_hosts: "-oProxyCommand" })).ok).toBe(false);
    expect(parseTemplate(project, form({ ...base, extra_vars: "[1,2]" })).ok).toBe(false);
    expect(parseTemplate(project, form({ ...base, extra_vars: "{nope" })).ok).toBe(false);
    const ok = parseTemplate(project, form({ ...base, extra_vars: '{"v": "1.2"}', schedule: " 30  2 * * 1-5 " }));
    expect(ok).toMatchObject({ ok: true, t: { extra_vars: { v: "1.2" }, schedule: "30 2 * * 1-5" } });
    expect(parseTemplate(project, form({ ...base, schedule: "* * * * * *" })).ok).toBe(false);
    expect(parseTemplate(project, form({ ...base, schedule: "61 * * * *" })).ok).toBe(false);
  });
});

// A stand-in for ansible-playbook. What it does comes from a "# fake:" line in the playbook, because
// the runner hands the child a minimal environment and nothing else.
const FAKE_ANSIBLE = `#!/bin/sh
for arg; do last=$arg; done
echo "fake-ansible $*"
mode=$(sed -n 's/^# fake: //p' "$last" | head -n 1)
case "$mode" in
  ok) echo "ok: [localhost]"; exit 0 ;;
  fail) echo "fatal: [localhost]: FAILED!"; exit 2 ;;
  env) env | sort; exit 0 ;;
  argv) for a; do echo "ARG<$a>"; done; exit 0 ;;
  sleep) trap 'echo "got TERM"; exit 143' TERM; sleep 30 & wait $!; exit 0 ;;
  stubborn) trap 'echo "ignoring TERM"' TERM; echo "started"; while :; do sleep 1; done ;;
  *) echo "unknown mode"; exit 99 ;;
esac
`;

describe("runner with a fake ansible-playbook", () => {
  let h: OpsHarness;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    h = await createOpsHarness({
      config: (c) => ({ ansible: { ...c.ansible, bin: join(c.ansible.projectDir, "..", "fake-ansible-playbook"), gitBin: join(c.ansible.projectDir, "..", "fake-git") } }),
      overrides: { maxConcurrent: 2, killAfterMs: 300 },
    });
    writeExecutable(join(h.dir, "fake-ansible-playbook"), FAKE_ANSIBLE);
    writeExecutable(join(h.dir, "fake-git"), `#!/bin/sh\necho "fake-git $*"\n[ -f "$2/.pull-fails" ] && exit 1\nexit 0\n`);
    for (const mode of ["ok", "fail", "env", "argv", "sleep", "stubborn"]) writeFileSync(join(h.projectDir, `${mode}.yml`), `# fake: ${mode}\n- hosts: localhost\n`);
    writeFileSync(join(h.projectDir, "ansible.cfg"), "[defaults]\n");
    for (const mode of ["ok", "fail", "env", "argv", "sleep", "stubborn", "sleep2", "sleep3"]) {
      const playbook = mode.startsWith("sleep") ? "sleep.yml" : `${mode}.yml`;
      const [row] = (await h.sql`insert into templates (name, playbook, inventory, limit_hosts, extra_vars)
        values (${mode}, ${playbook}, 'inventory/local.ini', ${mode === "argv" ? "web:!web3" : ""}, ${mode === "argv" ? { greeting: "it's \"quoted\" $(whoami)" } : {}}::jsonb)
        returning id`) as { id: number }[];
      ids[mode] = row!.id;
    }
  });
  afterAll(() => h.close());

  const actor = { id: null, label: "test" };
  const run = async (id: number) => (await h.sql`select * from runs where id = ${id}`)[0] as any;
  const log = (id: number) => readFileSync(h.ops.runner.logPath(id), "utf8");

  test("a successful run records exit code, duration, who started it and the log", async () => {
    const r = await h.ops.runner.start(ids.ok!, "manual", { id: h.users.operator.id, label: h.users.operator.email });
    expect(r.ok).toBe(true);
    await h.ops.runner.idle();
    const row = await run((r as any).runId);
    expect(row).toMatchObject({ status: "ok", exit_code: 0, trigger: "manual", started_by: h.users.operator.id, started_by_label: "operator@systaro.de" });
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.finished_at).not.toBeNull();
    expect(log(row.id)).toContain("ok: [localhost]");
    expect(log(row.id)).toContain("# Ende: erfolgreich, Exit-Code 0");
  });

  test("argv is passed without a shell: limit and extra vars arrive as single arguments", async () => {
    const r = await h.ops.runner.start(ids.argv!, "manual", actor);
    await h.ops.runner.idle();
    const text = log((r as any).runId);
    expect(text).toContain("ARG<--inventory=./inventory/local.ini>");
    expect(text).toContain("ARG<--limit=web:!web3>");
    expect(text).toContain(`ARG<--extra-vars={"greeting":"it's \\"quoted\\" $(whoami)"}>`);
    expect(text).toContain("ARG<./argv.yml>");
    expect(text).not.toMatch(new RegExp(`ARG<.*${userInfo().username}|ARG<root>`));
  });

  test("the child gets a minimal environment", async () => {
    process.env.VANTAGE_TEST_LEAK = "should-not-arrive";
    const r = await h.ops.runner.start(ids.env!, "manual", actor);
    await h.ops.runner.idle();
    delete process.env.VANTAGE_TEST_LEAK;
    const keys = log((r as any).runId)
      .split("\n")
      .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
      .map((l) => l.split("=")[0]!);
    const allowed = new Set(["PATH", "HOME", "ANSIBLE_FORCE_COLOR", "ANSIBLE_NOCOLOR", "ANSIBLE_CONFIG", "PYTHONUNBUFFERED", "LANG", "LC_ALL", "PWD", "SHLVL", "_", "OLDPWD"]);
    expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
    const text = log((r as any).runId);
    expect(text).toContain("ANSIBLE_NOCOLOR=1");
    expect(text).toContain("ANSIBLE_FORCE_COLOR=0");
    expect(text).toContain(`ANSIBLE_CONFIG=${join(h.projectDir, "ansible.cfg")}`);
    expect(text).not.toContain("should-not-arrive");
    expect(text).not.toContain("DATABASE_URL");
  });

  test("one run per template: a second start while the first is active is refused", async () => {
    const first = await h.ops.runner.start(ids.sleep!, "manual", actor);
    const second = await h.ops.runner.start(ids.sleep!, "manual", actor);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "busy" });
    await h.ops.runner.cancel((first as any).runId, "test");
    await h.ops.runner.idle();
  });

  test("at most two runs at once; the third waits in the queue and starts when a slot frees", async () => {
    const a = (await h.ops.runner.start(ids.sleep!, "manual", actor)) as any;
    const b = (await h.ops.runner.start(ids.sleep2!, "manual", actor)) as any;
    const c = (await h.ops.runner.start(ids.sleep3!, "manual", actor)) as any;
    await Bun.sleep(100);
    expect(h.ops.runner.runningIds.sort()).toEqual([a.runId, b.runId].sort());
    expect(h.ops.runner.queuedIds).toEqual([c.runId]);
    expect((await run(c.runId)).status).toBe("queued");
    await h.ops.runner.cancel(a.runId, "test");
    for (let i = 0; i < 50 && (await run(c.runId)).status === "queued"; i++) await Bun.sleep(20);
    expect((await run(c.runId)).status).toBe("running");
    await h.ops.runner.cancel(b.runId, "test");
    await h.ops.runner.cancel(c.runId, "test");
    await h.ops.runner.idle();
    expect((await run(c.runId)).status).toBe("cancelled");
  });

  test("cancelling a queued run removes it before it starts", async () => {
    const a = (await h.ops.runner.start(ids.sleep!, "manual", actor)) as any;
    const b = (await h.ops.runner.start(ids.sleep2!, "manual", actor)) as any;
    const c = (await h.ops.runner.start(ids.sleep3!, "manual", actor)) as any;
    expect(await h.ops.runner.cancel(c.runId, "operator@systaro.de")).toBe(true);
    expect((await run(c.runId))).toMatchObject({ status: "cancelled", cancelled_by_label: "operator@systaro.de", started_at: null });
    await h.ops.runner.cancel(a.runId, "test");
    await h.ops.runner.cancel(b.runId, "test");
    await h.ops.runner.idle();
  });

  test("cancel sends SIGTERM to the process group", async () => {
    const r = (await h.ops.runner.start(ids.sleep!, "manual", actor)) as any;
    await Bun.sleep(150);
    const t0 = Date.now();
    await h.ops.runner.cancel(r.runId, "operator@systaro.de");
    await h.ops.runner.idle();
    expect(Date.now() - t0).toBeLessThan(2000);
    const row = await run(r.runId);
    expect(row).toMatchObject({ status: "cancelled", cancelled_by_label: "operator@systaro.de", exit_code: 143 });
    expect(log(r.runId)).toContain("got TERM");
  });

  test("a child that ignores SIGTERM is killed with SIGKILL after the grace period", async () => {
    const r = (await h.ops.runner.start(ids.stubborn!, "manual", actor)) as any;
    await Bun.sleep(150);
    const t0 = Date.now();
    await h.ops.runner.cancel(r.runId, "test");
    await h.ops.runner.idle();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(3000);
    expect(log(r.runId)).toContain("ignoring TERM");
    expect((await run(r.runId)).status).toBe("cancelled");
  });

  test("the cancel route needs the operator role and is audited", async () => {
    const r = (await h.ops.runner.start(ids.sleep!, "manual", actor)) as any;
    expect((await h.request(`/runs/${r.runId}/cancel`, { cookie: h.users.viewer.cookie, method: "POST" })).status).toBe(403);
    const res = await h.request(`/runs/${r.runId}/cancel`, { cookie: h.users.operator.cookie, method: "POST" });
    expect(flashOf(res)?.kind).toBe("ok");
    await h.ops.runner.idle();
    expect((await run(r.runId)).status).toBe("cancelled");
    const [a] = (await h.sql`select actor_label, action, target from audit_log where action = 'run.cancel'`) as any[];
    expect(a).toEqual({ actor_label: "operator@systaro.de", action: "run.cancel", target: String(r.runId) });
  });

  test("a failed scheduled run raises an alert; the next successful scheduled run resolves it", async () => {
    await h.sql`delete from outbox`;
    const manual = (await h.ops.runner.start(ids.fail!, "manual", actor)) as any;
    await h.ops.runner.idle();
    expect((await run(manual.runId)).status).toBe("failed");
    expect(await outboxRows(h.sql)).toEqual([]); // manual failures are seen by whoever started them

    const scheduled = (await h.ops.runner.start(ids.fail!, "schedule", { id: null, label: "Zeitplan" })) as any;
    await h.ops.runner.idle();
    expect((await run(scheduled.runId)).exit_code).toBe(2);
    const [fired] = await outboxRows(h.sql);
    expect(fired).toMatchObject({ subject: "ansible:fail", state: "firing", severity: "warning" });
    expect(fired!.title).toContain("„fail“ fehlgeschlagen");

    // A second failure does not send again.
    await h.ops.runner.start(ids.fail!, "schedule", { id: null, label: "Zeitplan" });
    await h.ops.runner.idle();
    expect(await outboxRows(h.sql)).toHaveLength(1);

    await h.sql`update templates set playbook = 'ok.yml' where id = ${ids.fail!}`;
    await h.ops.runner.start(ids.fail!, "schedule", { id: null, label: "Zeitplan" });
    await h.ops.runner.idle();
    const rows = await outboxRows(h.sql);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ subject: "ansible:fail", state: "resolved", severity: "warning" });
    await h.sql`update templates set playbook = 'fail.yml' where id = ${ids.fail!}`;
  });

  test("a playbook that vanished from the project fails the run with an error, not a crash", async () => {
    rmSync(join(h.projectDir, "env.yml"));
    const r = (await h.ops.runner.start(ids.env!, "manual", actor)) as any;
    await h.ops.runner.idle();
    const row = await run(r.runId);
    expect(row.status).toBe("error");
    expect(row.error).toContain("env.yml");
    writeFileSync(join(h.projectDir, "env.yml"), "# fake: env\n- hosts: localhost\n");
  });

  test("with ANSIBLE_GIT_PULL the project is pulled first; a failed pull stops the run", async () => {
    const runner = h.ops.runner as any;
    runner.o.gitPull = true;
    try {
      const ok = (await h.ops.runner.start(ids.ok!, "manual", actor)) as any;
      await h.ops.runner.idle();
      expect(log(ok.runId)).toContain(`fake-git -C ${h.projectDir} pull --ff-only`);
      expect((await run(ok.runId)).status).toBe("ok");

      writeFileSync(join(h.projectDir, ".pull-fails"), "");
      const bad = (await h.ops.runner.start(ids.ok!, "manual", actor)) as any;
      await h.ops.runner.idle();
      expect(await run(bad.runId)).toMatchObject({ status: "error", exit_code: 1 });
      expect(log(bad.runId)).not.toContain("fake-ansible");
    } finally {
      runner.o.gitPull = false;
      rmSync(join(h.projectDir, ".pull-fails"), { force: true });
    }
  });

  test("disabled templates do not run", async () => {
    await h.sql`update templates set enabled = false where id = ${ids.ok!}`;
    expect(await h.ops.runner.start(ids.ok!, "manual", actor)).toMatchObject({ ok: false, code: "disabled" });
    await h.sql`update templates set enabled = true where id = ${ids.ok!}`;
  });

  test("shutdown waits for running playbooks, then cancels them; recover() marks leftovers", async () => {
    const r = (await h.ops.runner.start(ids.stubborn!, "manual", actor)) as any;
    await Bun.sleep(150);
    await h.ops.runner.shutdown(200);
    expect((await run(r.runId)).status).toBe("cancelled");
    expect(await h.ops.runner.start(ids.ok!, "manual", actor)).toMatchObject({ ok: false, code: "stopping" });
    await h.sql`insert into runs (template_id, template_name, playbook, inventory, limit_hosts, extra_vars, check_mode, trigger, started_by_label, status)
                values (${ids.ok!}, 'ok', 'ok.yml', 'inventory/local.ini', '', '{}'::jsonb, false, 'manual', 'test', 'running')`;
    expect(await h.ops.runner.recover()).toBe(1);
  });
});

describe("runner with the real ansible-playbook", () => {
  const hasAnsible = Boolean(Bun.which("ansible-playbook"));
  let h: OpsHarness;

  beforeAll(async () => {
    if (hasAnsible) h = await createOpsHarness();
  });
  afterAll(() => h?.close());

  test.skipIf(!hasAnsible)("runs ping-local.yml from the UI route with a live log", async () => {
    const res = await h.request("/templates", {
      cookie: h.users.admin.cookie,
      form: { name: "Ping lokal", playbook: "ping-local.yml", inventory: "inventory/local.ini", extra_vars: '{"greeting": "aus dem Test"}', check_mode: "1", enabled: "1" },
    });
    expect(res.status).toBe(303);
    const templateId = Number(res.headers.get("location")!.split("/").pop());
    const started = await h.request(`/templates/${templateId}/run`, { cookie: h.users.operator.cookie, method: "POST" });
    expect(started.status).toBe(303);
    const runPath = started.headers.get("location")!;
    expect(runPath).toMatch(/^\/runs\/\d+$/);

    const stream = await h.request(`${runPath}/stream`, { cookie: h.users.viewer.cookie });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const sse = await stream.text(); // ends with the `done` event once the run is finished
    const chunks = [...sse.matchAll(/^event: log\ndata: (.*)$/gm)].map((m) => JSON.parse(m[1]!) as string).join("");
    expect(chunks).toContain("PLAY [Ping localhost]");
    expect(chunks).toContain("Hallo von Vantage Ops (aus dem Test)");
    expect(chunks).toContain("--check");
    expect(sse).toMatch(/event: done\ndata: ok/);

    const page = await (await h.request(runPath, { cookie: h.users.viewer.cookie })).text();
    expect(page).toContain("erfolgreich");
    expect(page).toContain("PLAY RECAP");
    const download = await h.request(`${runPath}/log`, { cookie: h.users.viewer.cookie });
    expect(download.headers.get("content-disposition")).toContain("attachment");
  }, 60_000);
});
