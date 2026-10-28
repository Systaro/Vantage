/**
 * Ansible runs from Semaphore: the recap parser, the worker sync against a fake API, and who sees
 * which run (level 3 through an environment's servers, admins everything).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ansibleRuns, hostSummaries, mappedAnsibleHosts, runCounts } from "../src/hub/modules/ansible/routes";
import { parseAnsibleConfig, parseRecap, SemaphoreError, type SemaphoreApi, type SemaphoreTask } from "../src/hub/modules/ansible/semaphore";
import { syncAnsible } from "../src/hub/modules/ansible/sync";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const OUTPUT_FAILED = `Task Weekly Upgrades added to queue
Started task #12 of template 'Weekly Upgrades'

PLAY [all] *********************************************************************

TASK [Gathering Facts] *********************************************************
\x1b[1;31mfatal: [web2.example.de]: UNREACHABLE! => {"changed": false, "msg": "Failed to connect to the host via ssh: secret-ish detail"}\x1b[0m
ok: [web1.example.de]

TASK [Upgrade packages] ********************************************************
failed: [db9.other.de] (item=openssl) => {"msg": "dpkg lock"}
fatal: [web1.example.de -> localhost]: FAILED! => {"msg": "ignored"}
...ignoring
changed: [web1.example.de]

PLAY RECAP *********************************************************************
\x1b[0;31mweb2.example.de\x1b[0m            : ok=0    changed=0    \x1b[1;31munreachable=1   \x1b[0m failed=0    skipped=0    rescued=0    ignored=0
web1.example.de            : ok=6    changed=3    unreachable=0    failed=0    skipped=1    rescued=0    ignored=1
db9.other.de               : ok=2    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0

Failed to run task: exit status 4
`;

describe("recap parser", () => {
  test("reads every server's counts, with and without colours", () => {
    const hosts = parseRecap(OUTPUT_FAILED);
    expect(hosts.map((h) => [h.host, h.ok, h.changed, h.unreachable, h.failed, h.skipped, h.ignored])).toEqual([
      ["web2.example.de", 0, 0, 1, 0, 0, 0],
      ["web1.example.de", 6, 3, 0, 0, 1, 1],
      ["db9.other.de", 2, 0, 0, 1, 0, 0],
    ]);
  });

  test("names the task a server failed in, never the message, and nothing for ignored failures", () => {
    const byHost = Object.fromEntries(parseRecap(OUTPUT_FAILED).map((h) => [h.host, h.failedTask]));
    expect(byHost).toEqual({ "web2.example.de": "Gathering Facts", "web1.example.de": null, "db9.other.de": "Upgrade packages" });
    expect(JSON.stringify(parseRecap(OUTPUT_FAILED))).not.toContain("secret-ish");
  });

  test("output without a recap gives no servers", () => {
    expect(parseRecap("ERROR! the playbook: site.yml could not be found\n")).toEqual([]);
  });

  test("an environment's servers are validated on every read", () => {
    expect(parseAnsibleConfig({ hosts: ["web1.example.de", "web1.example.de", "shop-stage"] })).toEqual(["web1.example.de", "shop-stage"]);
    expect(parseAnsibleConfig({ hosts: [] })).toBeNull();
    expect(parseAnsibleConfig({ hosts: ["-oProxyCommand=x"] })).toBeNull();
    expect(parseAnsibleConfig({ hosts: ["a b"] })).toBeNull();
    expect(parseAnsibleConfig(null)).toBeNull();
  });
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function task(id: number, status: string, extra: Partial<SemaphoreTask> = {}): SemaphoreTask {
  return { id, template_id: 7, status, schedule_id: 3, created: hoursAgo(20 - id), start: hoursAgo(20 - id), end: status === "running" ? null : hoursAgo(19.9 - id), tpl_alias: "Weekly Upgrades", tpl_playbook: "monthly-updates.yml", ...extra };
}

/** A Semaphore that answers from memory and records what was asked. */
function fakeApi(state: { tasks: SemaphoreTask[]; outputs: Record<number, string | Error> }) {
  const calls = { limits: [] as number[], outputs: [] as number[], single: [] as number[] };
  const api: SemaphoreApi = {
    project: async () => ({ id: 1, name: "Test" }),
    lastTasks: async (limit) => {
      calls.limits.push(limit);
      return state.tasks.slice(0, limit);
    },
    task: async (id) => {
      calls.single.push(id);
      const t = state.tasks.find((x) => x.id === id);
      return t ? { ...t, tpl_alias: undefined, tpl_playbook: undefined } : null;
    },
    output: async (id, onLine) => {
      calls.outputs.push(id);
      const out = state.outputs[id];
      if (out instanceof Error) throw out;
      for (const line of (out ?? "").split("\n")) onLine(line);
    },
  };
  return { api, calls };
}

let db: TestDb;
let w: World;
let securityUser: number;

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
  const [u] = (await db.owner`insert into users (email, name, kind) values ('sec@nordwind.example', 'sec', 'customer') returning id`) as { id: number }[];
  securityUser = u!.id;
  await db.owner`insert into grants (user_id, project_id, level) values (${securityUser}, ${w.projects.shop}, 'security')`;
  await db.owner`insert into grants (user_id, project_id, level) values (${w.aliceNordwindShopOverview}, ${w.projects.crm}, 'diagnostics')`;
  await db.owner`insert into environment_sources (environment_id, kind, config) values (${w.envs.shopProd}, 'ansible', ${{ hosts: ["web1.example.de", "web2.example.de"] }}::jsonb)`;
  await db.owner`insert into environment_sources (environment_id, kind, config) values (${w.envs.mineProd}, 'ansible', ${{ hosts: ["db9.other.de"] }}::jsonb)`;
});
afterAll(() => db.drop());

describe("sync", () => {
  const state = { tasks: [task(12, "error"), task(11, "running", { schedule_id: null }), task(10, "success")], outputs: { 12: OUTPUT_FAILED, 10: "PLAY RECAP ***\nweb1.example.de : ok=2 changed=0 unreachable=0 failed=0\n" } as Record<number, string | Error> };
  const { api, calls } = fakeApi(state);

  test("the first sync takes the last 200 runs and reads every finished one", async () => {
    expect(await syncAnsible(db.worker, api, () => {})).toBe(2);
    expect(calls.limits).toEqual([200]);
    expect(calls.outputs.sort()).toEqual([10, 12]);
    const runs = (await db.owner`select id, template_name, status, trigger, parsed_at is not null as parsed from ansible_runs order by id`) as any[];
    expect(runs).toEqual([
      { id: 10, template_name: "Weekly Upgrades", status: "success", trigger: "schedule", parsed: true },
      { id: 11, template_name: "Weekly Upgrades", status: "running", trigger: "manual", parsed: false },
      { id: 12, template_name: "Weekly Upgrades", status: "error", trigger: "schedule", parsed: true },
    ]);
    expect(((await db.owner`select count(*)::int as n from ansible_run_hosts where run_id = 12`) as any[])[0].n).toBe(3);
  });

  test("later syncs take the last 50, follow runs still going and read each output once", async () => {
    calls.outputs.length = 0;
    state.tasks = [task(13, "success"), ...state.tasks.filter((t) => t.id !== 11)];
    state.tasks.push(task(11, "success", { schedule_id: null }));
    state.outputs[13] = new SemaphoreError("Semaphore antwortet mit HTTP 500.");
    state.outputs[11] = "PLAY RECAP ***\nweb2.example.de : ok=1 changed=1 unreachable=0 failed=0\n";
    // Only the newest two fit the recent window: 11 has dropped out and is looked up on its own.
    const recentOnly: SemaphoreApi = { ...api, lastTasks: async (limit) => (calls.limits.push(limit), state.tasks.filter((t) => t.id >= 12)) };
    await syncAnsible(db.worker, recentOnly, () => {});
    expect(calls.limits.at(-1)).toBe(50);
    expect(calls.single).toEqual([11]);
    expect(calls.outputs.sort()).toEqual([11, 13]);
    const [run11] = (await db.owner`select status, template_name, parsed_at is not null as parsed from ansible_runs where id = 11`) as any[];
    expect(run11).toEqual({ status: "success", template_name: "Weekly Upgrades", parsed: true });
  });

  test("an unreadable output is retried, three times at most", async () => {
    const get = async () => ((await db.owner`select parse_attempts, parse_error, parsed_at is not null as given_up from ansible_runs where id = 13`) as any[])[0];
    expect(await get()).toEqual({ parse_attempts: 1, parse_error: "Semaphore antwortet mit HTTP 500.", given_up: false });
    await syncAnsible(db.worker, api, () => {});
    await syncAnsible(db.worker, api, () => {});
    expect(await get()).toEqual({ parse_attempts: 3, parse_error: "Semaphore antwortet mit HTTP 500.", given_up: true });
    calls.outputs.length = 0;
    await syncAnsible(db.worker, api, () => {});
    expect(calls.outputs).not.toContain(13);
  });
});

describe("who sees which run", () => {
  test("level 3 sees the runs on its environment's servers, with only those servers' results", async () => {
    const runs = await asUser(db.hub, securityUser, (tx) => ansibleRuns(tx, { hosts: ["web1.example.de", "web2.example.de"], failedOnly: false, limit: 50 }));
    expect(runs.map((r) => r.id)).toEqual([12, 11, 10]);
    expect(runs[0]!.hosts.map((h) => h.host)).toEqual(["web1.example.de", "web2.example.de"]);
    // Nothing of another customer's server leaks, not even when asked for it by name.
    expect(await asUser(db.hub, securityUser, (tx) => tx`select host from ansible_run_hosts where host = 'db9.other.de'`)).toHaveLength(0);
    expect(await asUser(db.hub, securityUser, (tx) => ansibleRuns(tx, { hosts: ["db9.other.de"], failedOnly: false, limit: 50 }))).toEqual([]);
  });

  test("failed only: runs in which one of these servers failed or was unreachable", async () => {
    const runs = await asUser(db.hub, securityUser, (tx) => ansibleRuns(tx, { hosts: ["web1.example.de"], failedOnly: true, limit: 50 }));
    expect(runs).toEqual([]);
    const both = await asUser(db.hub, securityUser, (tx) => ansibleRuns(tx, { hosts: ["web1.example.de", "web2.example.de"], failedOnly: true, limit: 50 }));
    expect(both.map((r) => r.id)).toEqual([12]);
  });

  test("overview and diagnostics see nothing, admins see every run and server", async () => {
    for (const user of [w.aliceNordwindShopOverview, w.bobBergbauDiagnostics, w.carolStageOnly, w.staffNoGrants]) {
      expect(await asUser(db.hub, user, (tx) => tx`select id from ansible_runs`)).toHaveLength(0);
      expect(await asUser(db.hub, user, (tx) => tx`select host from ansible_run_hosts`)).toHaveLength(0);
    }
    expect(await asUser(db.hub, w.admin, (tx) => tx`select id from ansible_runs`)).toHaveLength(4);
    const all = await asUser(db.hub, w.admin, (tx) => ansibleRuns(tx, { hosts: null, failedOnly: true, limit: 50 }));
    expect(all.map((r) => r.id)).toEqual([12]);
    expect(all[0]!.hosts).toHaveLength(3);
  });

  test("the hub cannot write runs", async () => {
    await expect(asUser(db.hub, w.admin, (tx) => tx`delete from ansible_runs`)).rejects.toThrow();
    await expect(asUser(db.hub, w.admin, (tx) => tx`insert into ansible_run_hosts (run_id, host) values (10, 'x')`)).rejects.toThrow();
  });

  test("per-server summary and counts for the Wartung tab", async () => {
    const data = await asUser(db.hub, securityUser, async (tx) => {
      const hosts = (await mappedAnsibleHosts(tx, w.envs.shopProd))!;
      return { hosts, summary: await hostSummaries(tx, hosts), counts: await runCounts(tx, hosts) };
    });
    expect(data.hosts).toEqual(["web1.example.de", "web2.example.de"]);
    expect(data.summary.map((s) => [s.host, s.last_run_id, s.last_failed])).toEqual([["web1.example.de", 12, false], ["web2.example.de", 12, true]]);
    expect(data.summary.map((s) => s.failed_30d)).toEqual([0, 1]);
  });
});
