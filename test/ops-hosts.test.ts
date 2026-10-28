import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cpuUsagePct, DEFAULT_THRESHOLDS, effectiveThresholds, evaluateReport, parseThresholds } from "../src/shared/hosts/evaluate";
import type { HostRow } from "../src/ops/hosts/monitor";
import { parseReport, type HostReport } from "../src/shared/hosts/report";
import { createOpsHarness, outboxRows, writeExecutable, type OpsHarness } from "./helpers/ops";

function report(over: Partial<HostReport> = {}): HostReport {
  return {
    version: 1,
    agent: "1",
    hostname: "web1",
    time: Math.floor(Date.now() / 1000),
    disks: [
      { mount: "/", device: "/dev/sda1", fstype: "ext4", size_kb: 1_000_000, used_kb: 400_000, avail_kb: 600_000, used_pct: 40 },
      { mount: "/data", device: "/dev/sdb1", fstype: "xfs", size_kb: 1_000_000, used_kb: 500_000, avail_kb: 500_000, used_pct: 50 },
    ],
    memory: { total_kb: 4_000_000, available_kb: 2_000_000, used_pct: 50 },
    load: { load1: 0.5, load5: 0.4, load15: 0.3, cores: 4 },
    systemd: { failed: [] },
    docker: { total: 3, stopped: [] },
    es: null,
    errors: [],
    ...over,
  };
}

describe("report validation", () => {
  test("accepts a complete report and reports with unavailable checks", () => {
    expect(parseReport(report()).ok).toBe(true);
    expect(parseReport(report({ memory: null, load: null, systemd: null, docker: null, disks: [] })).ok).toBe(true);
    expect(parseReport(report({ es: { reachable: true, blocked_indices: 0, max_disk_pct: null } })).ok).toBe(true);
  });

  test("rejects unknown keys, wrong types, out-of-range values and control characters", () => {
    const bad: unknown[] = [
      { ...report(), extra: 1 },
      { ...report(), version: 2 },
      { ...report(), disks: [{ ...report().disks[0], used_pct: 101 }] },
      { ...report(), disks: [{ ...report().disks[0], size_kb: -1 }] },
      { ...report(), disks: [{ ...report().disks[0], mount: "/a\nb" }] },
      { ...report(), disks: [{ ...report().disks[0], shell: "rm" }] },
      { ...report(), memory: { used_pct: "50", total_kb: 1, available_kb: 1 } },
      { ...report(), load: { load1: 1, load5: 1, load15: 1, cores: 0 } },
      { ...report(), systemd: { failed: [1] } },
      { ...report(), docker: { total: 1 } },
      { ...report(), es: { reachable: "yes", blocked_indices: 0, max_disk_pct: null } },
      { ...report(), errors: "none" },
      { ...report(), hostname: "" },
      [report()],
      null,
    ];
    for (const b of bad) expect(parseReport(b).ok).toBe(false);
  });
});

describe("CPU counters", () => {
  test("optional: reports without them stay valid; with them they are checked like the rest", () => {
    const cpu = { total: 22800, idle: 16250, iowait: 520 };
    const parsed = parseReport(report({ cpu }));
    expect(parsed.ok && parsed.report.cpu).toEqual(cpu);
    const without = parseReport(report());
    expect(without.ok && without.report.cpu).toBeNull();
    expect(parseReport(report({ cpu: null })).ok).toBe(true);
    for (const bad of [{ ...cpu, steal: 1 }, { total: 100, idle: 101, iowait: 0 }, { total: 100, idle: 60, iowait: 50 }, { total: 1.5, idle: 0, iowait: 0 }, { total: 100, idle: 10 }]) {
      expect(parseReport(report({ cpu: bad as any })).ok).toBe(false);
    }
  });

  test("usage between two readings: busy is neither idle nor I/O wait; a reboot or missing counters give none", () => {
    const a = { total: 1000, idle: 800, iowait: 0 };
    expect(cpuUsagePct(a, { total: 2000, idle: 1550, iowait: 50 })).toBeCloseTo(20);
    expect(cpuUsagePct(a, { total: 2000, idle: 800, iowait: 0 })).toBeCloseTo(100);
    expect(cpuUsagePct(a, { total: 500, idle: 400, iowait: 0 })).toBeNull();
    expect(cpuUsagePct(a, a)).toBeNull();
    expect(cpuUsagePct(null, a)).toBeNull();
    expect(cpuUsagePct(a, undefined)).toBeNull();
  });
});

describe("threshold evaluation", () => {
  test("defaults: disk 85/95, memory 90/97, load per core 2/4, failed units and stopped containers warn", () => {
    const t = DEFAULT_THRESHOLDS;
    const sev = (r: HostReport) => Object.fromEntries(evaluateReport(r, t).map((x) => [x.key, x.severity]));
    expect(sev(report())).toEqual({ "disk:/": "ok", "disk:/data": "ok", memory: "ok", load: "ok", systemd: "ok", docker: "ok" });
    const d = (pct: number) => ({ mount: "/", device: "d", fstype: "ext4", size_kb: 100, used_kb: pct, avail_kb: 100 - pct, used_pct: pct });
    expect(sev(report({ disks: [d(84.9)] }))["disk:/"]).toBe("ok");
    expect(sev(report({ disks: [d(85)] }))["disk:/"]).toBe("warning");
    expect(sev(report({ disks: [d(95)] }))["disk:/"]).toBe("critical");
    expect(sev(report({ memory: { total_kb: 1, available_kb: 0, used_pct: 90 } })).memory).toBe("warning");
    expect(sev(report({ memory: { total_kb: 1, available_kb: 0, used_pct: 97.5 } })).memory).toBe("critical");
    expect(sev(report({ load: { load1: 30, load5: 8, load15: 1, cores: 4 } })).load).toBe("warning"); // 2.0 per core
    expect(sev(report({ load: { load1: 0, load5: 16, load15: 1, cores: 4 } })).load).toBe("critical");
    expect(sev(report({ systemd: { failed: ["a.service"] } })).systemd).toBe("warning");
    expect(sev(report({ docker: { total: 2, stopped: ["db"] } })).docker).toBe("warning");
    expect(sev(report({ es: { reachable: true, blocked_indices: 0, max_disk_pct: 71 } })).es).toBe("ok");
    expect(sev(report({ es: { reachable: true, blocked_indices: 0, max_disk_pct: 91 } })).es).toBe("warning");
    expect(sev(report({ es: { reachable: true, blocked_indices: 2, max_disk_pct: 71 } })).es).toBe("critical");
    expect(sev(report({ es: { reachable: false, blocked_indices: 0, max_disk_pct: null } })).es).toBe("warning");
  });

  test("per-host overrides win over the defaults and are validated", () => {
    const t = effectiveThresholds({ disk_warn: 70, disk_crit: 80 });
    expect(t).toMatchObject({ disk_warn: 70, disk_crit: 80, memory_warn: 90 });
    expect(evaluateReport(report(), t).find((r) => r.key === "disk:/data")!.severity).toBe("ok");
    expect(evaluateReport(report({ disks: [{ ...report().disks[1]!, used_pct: 75 }] }), t)[0]!.severity).toBe("warning");
    expect(parseThresholds({ disk_warn: "70", disk_crit: "80" })).toEqual({ ok: true, thresholds: { disk_warn: 70, disk_crit: 80 } });
    expect(parseThresholds({ load_warn: "1,5" })).toEqual({ ok: true, thresholds: { load_warn: 1.5 } });
    expect(parseThresholds({ disk_warn: "96" }).ok).toBe(false); // above the default critical
    expect(parseThresholds({ memory_crit: "120" }).ok).toBe(false);
    expect(parseThresholds({ memory_crit: "abc" }).ok).toBe(false);
  });
});

// Fake ssh: prints a report (or fails) depending on the target, after checking the arguments and
// that the agent script arrives on stdin.
const FAKE_SSH = `#!/bin/sh
target=""; prev=""
for a; do [ "$prev" = "--" ] && target=$a; prev=$a; done
script=$(cat)
case "$script" in "#!/bin/sh"*) ;; *) echo "no agent script on stdin" >&2; exit 97 ;; esac
case "$*" in *"-o BatchMode=yes -o ConnectTimeout=10 -- $target sh -s -- --print") ;; *) echo "unexpected argv: $*" >&2; exit 98 ;; esac
case "$target" in
  ok@*) cat "$(dirname "$0")/report.json" ;;
  down@*) echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255 ;;
  garbage@*) echo "not json" ;;
  slow@*) sleep 30 ;;
esac
`;

describe("hosts: ingest, state machine, silent detection, central sweep", () => {
  let h: OpsHarness;
  let agentToken = "";
  let agentId = 0;
  const post = (body: unknown, token = agentToken, raw?: string) =>
    h.request("/api/ingest/v1/report", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
  const host = async (id: number) => ((await h.sql`select id, name, mode, interval_seconds, ssh_target, environment_path, thresholds, enabled from hosts where id = ${id}`) as HostRow[])[0]!;

  beforeAll(async () => {
    h = await createOpsHarness({ config: (c) => ({ sshBin: join(c.ansible.projectDir, "..", "fake-ssh") }) });
    writeExecutable(join(h.dir, "fake-ssh"), FAKE_SSH);
    await Bun.write(join(h.dir, "report.json"), JSON.stringify(report({ hostname: "db1" })));
    // Only admins may route a host into a customer environment (security review 2026-10-12).
    const res = await h.request("/hosts", {
      cookie: h.users.admin.cookie,
      form: { name: "web1", mode: "agent", interval_seconds: "300", environment_path: "nordwind/shop/prod", enabled: "1" },
    });
    agentToken = (await res.text()).match(/--token (vha_[A-Za-z0-9_-]{43})/)![1]!;
    agentId = ((await h.sql`select id from hosts where name = 'web1'`) as { id: number }[])[0]!.id;
  });
  afterAll(() => h.close());

  test("operators cannot put a host into a customer environment, nor move or clear it", async () => {
    await h.request("/hosts", { cookie: h.users.operator.cookie, form: { name: "op-host", mode: "agent", interval_seconds: "300", environment_path: "bergbau/mine/prod", enabled: "1" } });
    const [created] = (await h.sql`select id, environment_path from hosts where name = ${"op-host"}`) as any[];
    expect(created.environment_path).toBeNull();
    await h.request(`/hosts/${agentId}`, { cookie: h.users.operator.cookie, form: { name: "web1", mode: "agent", interval_seconds: "300", environment_path: "bergbau/mine/prod", enabled: "1" } });
    expect((await host(agentId)).environment_path).toBe("nordwind/shop/prod");
    await h.sql`delete from hosts where id = ${created.id}`;
  });

  test("the host token is stored only as a hash", async () => {
    const [row] = (await h.sql`select token_hash, token_prefix from hosts where id = ${agentId}`) as any[];
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_prefix).toBe(agentToken.slice(0, 10));
    const page = await (await h.request(`/hosts/${agentId}`, { cookie: h.users.viewer.cookie })).text();
    expect(page).not.toContain(agentToken);
  });

  test("ingest refuses missing or wrong tokens, oversized and invalid bodies", async () => {
    expect((await post(report(), "")).status).toBe(401);
    expect((await post(report(), "vha_" + "x".repeat(43))).status).toBe(401);
    expect((await post(report(), "vs_" + "x".repeat(43))).status).toBe(401);
    expect((await post(null, agentToken, "x".repeat(70 * 1024))).status).toBe(413);
    expect((await post(null, agentToken, "{not json")).status).toBe(400);
    const bad = await post({ ...report(), extra: true });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain("extra");
    const [row] = (await h.sql`select last_error from hosts where id = ${agentId}`) as any[];
    expect(row.last_error).toContain("Bericht abgelehnt");
    // A session cookie is not a way in.
    expect((await h.request("/api/ingest/v1/report", { method: "POST", cookie: h.users.admin.cookie, body: JSON.stringify(report()) })).status).toBe(401);
  });

  test("a valid report is stored and evaluated; a healthy host sends no events", async () => {
    const res = await post(report());
    expect(res.status).toBe(202);
    const states = (await h.sql`select check_key, severity from check_states where host_id = ${agentId} order by check_key`) as any[];
    expect(states.map((s) => s.check_key)).toEqual(["disk:/", "disk:/data", "docker", "load", "memory", "systemd"]);
    expect(states.every((s) => s.severity === "ok")).toBe(true);
    expect(await outboxRows(h.sql)).toEqual([]);
    expect(((await h.sql`select count(*)::int as n from host_reports where host_id = ${agentId}`) as any[])[0].n).toBe(1);
  });

  test("reports closer together than 20 s are refused", async () => {
    expect((await post(report())).status).toBe(429);
  });

  const feed = (r: HostReport) => host(agentId).then((hh) => h.ops.monitor.processReport(hh, r, "agent"));

  test("transitions: ok → warning fires, warning → critical escalates, same state is quiet, back to ok resolves", async () => {
    const disk = (pct: number) => [report().disks[0]!, { ...report().disks[1]!, used_pct: pct }];
    await feed(report({ disks: disk(88) }));
    await feed(report({ disks: disk(89) }));
    await feed(report({ disks: disk(96) }));
    await feed(report({ disks: disk(97) }));
    await feed(report({ disks: disk(50) }));
    const rows = await outboxRows(h.sql);
    expect(rows.map((r) => [r.subject, r.state, r.severity])).toEqual([
      ["host:web1:disk:/data", "firing", "warning"],
      ["host:web1:disk:/data", "firing", "critical"],
      ["host:web1:disk:/data", "resolved", "critical"],
    ]);
    expect(rows.every((r) => r.environment === "nordwind/shop/prod")).toBe(true);
    expect(rows[0]!.title).toBe("web1: Festplatte /data Warnung");
    expect(rows[2]!.title).toBe("web1: Festplatte /data wieder in Ordnung");
    expect(((await h.sql`select count(*)::int as n from alerts`) as any[])[0].n).toBe(0);
  });

  test("a check that disappears from the report is resolved", async () => {
    await h.sql`delete from outbox`;
    await feed(report({ docker: { total: 2, stopped: ["db"] } }));
    await feed(report({ docker: null }));
    const rows = await outboxRows(h.sql);
    expect(rows.map((r) => [r.subject, r.state])).toEqual([
      ["host:web1:docker", "firing"],
      ["host:web1:docker", "resolved"],
    ]);
    expect(rows[1]!.title).toContain("nicht mehr gemeldet");
    expect(((await h.sql`select check_key from check_states where host_id = ${agentId} and check_key = 'docker'`) as any[])).toHaveLength(0);
  });

  test("silent detection: no report for 3 intervals is critical; the next report resolves it", async () => {
    await h.sql`delete from outbox`;
    await h.sql`update hosts set last_report_at = now() - interval '14 minutes' where id = ${agentId}`;
    await h.ops.monitor.detectSilent();
    expect(await outboxRows(h.sql)).toEqual([]);
    await h.sql`update hosts set last_report_at = now() - interval '16 minutes' where id = ${agentId}`;
    await h.ops.monitor.detectSilent();
    await h.ops.monitor.detectSilent();
    let rows = await outboxRows(h.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: "host:web1:silent", state: "firing", severity: "critical", environment: "nordwind/shop/prod" });
    expect(rows[0]!.title).toBe("web1 meldet sich nicht mehr");
    const res = await post(report());
    expect(res.status).toBe(202);
    rows = await outboxRows(h.sql);
    expect(rows[1]).toMatchObject({ subject: "host:web1:silent", state: "resolved" });
  });

  test("a host that never reported goes silent too; disabling it resolves that", async () => {
    await h.sql`delete from outbox`;
    await h.sql`insert into hosts (name, mode, interval_seconds, created_at, token_hash) values ('never', 'agent', 60, now() - interval '5 minutes', 'x')`;
    await h.ops.monitor.detectSilent();
    expect((await outboxRows(h.sql))[0]).toMatchObject({ subject: "host:never:silent", state: "firing" });
    expect((await outboxRows(h.sql))[0]!.title).toBe("never hat noch nie gemeldet");
    await h.sql`update hosts set enabled = false where name = 'never'`;
    await h.ops.monitor.detectSilent();
    expect((await outboxRows(h.sql))[1]).toMatchObject({ subject: "host:never:silent", state: "resolved" });
  });

  test("central sweep runs the agent over (fake) ssh and evaluates the result like a pushed report", async () => {
    await h.sql`delete from outbox`;
    for (const [name, target] of [["db1", "ok@db1"], ["down", "down@x"], ["garbage", "garbage@x"]]) {
      const res = await h.request("/hosts", { cookie: h.users.operator.cookie, form: { name: name!, mode: "central", interval_seconds: "300", ssh_target: target!, enabled: "1" } });
      expect(res.status).toBe(200);
    }
    await h.ops.monitor.sweepOnce();
    const rows = (await h.sql`select name, last_report_at is not null as reported, last_error from hosts where mode = 'central' order by name`) as any[];
    expect(rows).toEqual([
      { name: "db1", reported: true, last_error: null },
      { name: "down", reported: false, last_error: expect.stringContaining("Connection refused") },
      { name: "garbage", reported: false, last_error: expect.stringContaining("Ungültiger Bericht") },
    ]);
    const db1 = (await h.sql`select r.source, r.worst from host_reports r join hosts h on h.id = r.host_id where h.name = 'db1'`) as any[];
    expect(db1).toEqual([{ source: "central", worst: "ok" }]);
    // Not due again within the interval.
    const before = ((await h.sql`select count(*)::int as n from host_reports`) as any[])[0].n;
    await h.ops.monitor.sweepOnce();
    expect(((await h.sql`select count(*)::int as n from host_reports`) as any[])[0].n).toBe(before);
  });

  test("ssh targets are validated, so nothing can be smuggled in as an ssh option", async () => {
    for (const target of ["-oProxyCommand=touch /tmp/x", "a b", "root@host;id", "user@-host", "$(id)@host"]) {
      const res = await h.request("/hosts", { cookie: h.users.operator.cookie, form: { name: "evil", mode: "central", interval_seconds: "300", ssh_target: target, enabled: "1" } });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/hosts/new");
    }
    expect(((await h.sql`select count(*)::int as n from hosts where name = 'evil'`) as any[])[0].n).toBe(0);
  });

  test("sweep self-monitoring: no finished sweep for 5 minutes raises ops:sweep, the next sweep resolves it", async () => {
    await h.sql`delete from outbox`;
    h.ops.monitor.lastSweepFinishedAt = Date.now() - 4 * 60_000;
    await h.ops.monitor.checkSweepHealth();
    expect(await outboxRows(h.sql)).toEqual([]);
    h.ops.monitor.lastSweepFinishedAt = Date.now() - 6 * 60_000;
    await h.ops.monitor.checkSweepHealth();
    expect((await outboxRows(h.sql))[0]).toMatchObject({ subject: "ops:sweep", state: "firing", severity: "critical" });
    await h.ops.monitor.sweepOnce();
    expect((await outboxRows(h.sql))[1]).toMatchObject({ subject: "ops:sweep", state: "resolved" });
  });

  test("a hung ssh is killed after the timeout", async () => {
    (h.ops.monitor as any).o.sshTimeoutMs = 300;
    const t0 = Date.now();
    const r = await h.ops.monitor.collect("slow@x");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.ok).toBe(false);
    (h.ops.monitor as any).o.sshTimeoutMs = undefined;
  });

  test("renaming or deleting a host resolves its open alerts", async () => {
    await h.sql`delete from outbox`;
    await feed(report({ systemd: { failed: ["x.service"] } }));
    const res = await h.request(`/hosts/${agentId}`, { cookie: h.users.operator.cookie, form: { name: "web1-neu", mode: "agent", interval_seconds: "300", enabled: "1" } });
    expect(res.status).toBe(303);
    const rows = await outboxRows(h.sql);
    expect(rows.map((r) => [r.subject, r.state])).toEqual([
      ["host:web1:systemd", "firing"],
      ["host:web1:systemd", "resolved"],
    ]);
    // The token survives the edit.
    await h.sql`update hosts set last_report_at = now() - interval '1 minute' where id = ${agentId}`;
    expect((await post(report({ systemd: { failed: ["x.service"] } }))).status).toBe(202);
    expect((await outboxRows(h.sql)).at(-1)).toMatchObject({ subject: "host:web1-neu:systemd", state: "firing" });
    await h.request(`/hosts/${agentId}/delete`, { cookie: h.users.operator.cookie, method: "POST" });
    expect((await outboxRows(h.sql)).at(-1)).toMatchObject({ subject: "host:web1-neu:systemd", state: "resolved" });
    expect((await post(report())).status).toBe(401);
  });

  test("viewers see hosts but cannot change them", async () => {
    expect((await h.request("/hosts", { cookie: h.users.viewer.cookie })).status).toBe(200);
    const db1 = ((await h.sql`select id from hosts where name = 'db1'`) as any[])[0].id;
    expect((await h.request(`/hosts/${db1}`, { cookie: h.users.viewer.cookie })).status).toBe(200);
    expect((await h.request(`/hosts/${db1}/check`, { cookie: h.users.viewer.cookie, method: "POST" })).status).toBe(403);
    expect((await h.request(`/hosts/${db1}/delete`, { cookie: h.users.viewer.cookie, method: "POST" })).status).toBe(403);
  });
});
