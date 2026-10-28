/**
 * Runners (design 6.7): a runner sees and writes only its own monitors and servers, its results take
 * the same path as the worker's own probes, server reports are evaluated against thresholds, quiet
 * runners and servers raise events, and server data needs level 2. The runner process itself runs
 * against a fake hub with fake ssh tools.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { encryptString, newToken, sha256Hex } from "../src/shared/crypto";
import { parseResultsBody, type ResultsBody, type RunnerConfig } from "../src/shared/runner-protocol";
import { mountRunnerApi } from "../src/hub/modules/runners/api";
import { processRunnerResults, processServerReports, RUNNER_SILENT_MS, runnerWatchdogs } from "../src/hub/modules/runners/process";
import { currentCpu, serverHistory } from "../src/hub/modules/runners/metrics";
import { runnersForOrg, serverStatuses } from "../src/hub/modules/runners/routes";
import { Runner } from "../src/runner/runner";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const SECRET = "test-secret-0123456789abcdef0123456789";
let db: TestDb;
let w: World;
let app: Hono;
let runnerId: number;
let token: string;
let otherToken: string;
let monitorId: number;
let foreignMonitorId: number;
let serverId: number;

const report = (diskPct: number, extra: Record<string, unknown> = {}) => ({
  version: 1, agent: "1", hostname: "app-01", time: Math.floor(Date.now() / 1000),
  disks: [{ mount: "/", device: "/dev/sda1", fstype: "ext4", size_kb: 1000, used_kb: diskPct * 10, avail_kb: 1000 - diskPct * 10, used_pct: diskPct }],
  memory: { total_kb: 2048000, available_kb: 1024000, used_pct: 50 }, load: null, systemd: { failed: [] }, docker: null, es: null, errors: [], ...extra,
});

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
  token = newToken("vrn");
  otherToken = newToken("vrn");
  [{ id: runnerId }] = (await db.owner`insert into runners (organisation_id, name, token_hash, token_prefix) values (${w.orgs.nordwind}, 'RZ Nordwind', ${sha256Hex(token)}, 'vrn_x') returning id`) as any;
  await db.owner`insert into runners (organisation_id, name, token_hash, token_prefix) values (${w.orgs.bergbau}, 'RZ Bergbau', ${sha256Hex(otherToken)}, 'vrn_y')`;
  const headersEnc = await encryptString(SECRET, JSON.stringify({ authorization: "Bearer intern" }));
  [{ id: monitorId }] = (await db.owner`insert into monitors (environment_id, name, kind, config, interval_seconds, retries, runner_id)
    values (${w.envs.shopProd}, 'Intranet', 'http', ${{ url: "http://10.0.0.5/health", headersEnc }}::jsonb, 60, 1, ${runnerId}) returning id`) as any;
  [{ id: foreignMonitorId }] = (await db.owner`insert into monitors (environment_id, name, kind, config) values (${w.envs.mineProd}, 'Fremd', 'tcp', ${{ host: "x", port: 1 }}::jsonb) returning id`) as any;
  [{ id: serverId }] = (await db.owner`insert into servers (environment_id, runner_id, name, ssh_target) values (${w.envs.shopProd}, ${runnerId}, 'app-01', 'vantage@10.0.0.5') returning id`) as any;
  app = new Hono();
  mountRunnerApi(app, db.hub, SECRET);
});
afterAll(() => db.drop());

const call = (path: string, t: string | null, body?: unknown) =>
  app.request(path, {
    method: body ? "POST" : "GET",
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), "content-type": "application/json", "x-vantage-runner-version": "abc123" },
    body: body ? JSON.stringify(body) : undefined,
  });
const check = (id: number, ok: boolean, msg = ok ? "200 OK" : "connect ECONNREFUSED") =>
  ({ monitor_id: id, at: new Date().toISOString(), ok, latency_ms: ok ? 12 : null, status_code: ok ? 200 : null, message: msg, details: null, tls_days_left: null });
const events = async (prefix: string) => (await db.owner`select state, severity, title from events where subject_key like ${`${prefix}%`} order by id`) as any[];

describe("protocol", () => {
  test("a body is checked strictly; results older than a week are dropped, not refused", () => {
    expect(parseResultsBody({ checks: [check(1, true)], reports: [] }).ok).toBe(true);
    expect(parseResultsBody({ checks: [{ ...check(1, true), ok: "yes" }], reports: [] })).toEqual({ ok: false, error: "checks[0] is malformed" });
    expect(parseResultsBody({ checks: [], reports: [{ server_id: 1, at: "x", report: "text", error: null }] }).ok).toBe(false);
    const old = parseResultsBody({ checks: [{ ...check(1, true), at: new Date(Date.now() - 8 * 86_400_000).toISOString() }], reports: [] });
    expect(old.ok && old.dropped).toBe(1);
    expect(parseResultsBody([]).ok).toBe(false);
  });
});

describe("the runner's door", () => {
  test("a wrong or missing token gets 401", async () => {
    expect((await call("/api/runner/v1/config", null)).status).toBe(401);
    expect((await call("/api/runner/v1/config", newToken("vrn"))).status).toBe(401);
    expect((await call("/api/runner/v1/results", "vop_nope", { checks: [], reports: [] })).status).toBe(401);
  });

  test("config lists only its own monitors and servers, secrets decrypted for it alone", async () => {
    const res = await call("/api/runner/v1/config", token);
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as RunnerConfig;
    expect(cfg.runner.name).toBe("RZ Nordwind");
    expect(cfg.monitors.map((m) => m.id)).toEqual([monitorId]);
    const m = cfg.monitors[0]!;
    expect(m.kind === "http" && m.secrets.headers).toEqual({ authorization: "Bearer intern" });
    expect(JSON.stringify(m.config)).not.toContain("headersEnc");
    expect(cfg.servers).toEqual([{ id: serverId, name: "app-01", ssh_target: "vantage@10.0.0.5", interval_seconds: 300 }]);
    expect(((await (await call("/api/runner/v1/config", otherToken)).json()) as RunnerConfig).monitors).toEqual([]);
    const [r] = (await db.owner`select version, last_seen_at is not null as seen from runners where id = ${runnerId}`) as any[];
    expect(r).toEqual({ version: "abc123", seen: true });
  });

  test("results for monitors or servers of other runners are dropped", async () => {
    const res = await call("/api/runner/v1/results", token, { checks: [check(monitorId, true), check(foreignMonitorId, false)], reports: [{ server_id: serverId, at: new Date().toISOString(), report: report(40), error: null }] });
    expect(await res.json()).toEqual({ accepted: 2, rejected: 1 });
    const stolen = await call("/api/runner/v1/results", otherToken, { checks: [check(monitorId, false)], reports: [{ server_id: serverId, at: new Date().toISOString(), report: null, error: "x" }] });
    expect(await stolen.json()).toEqual({ accepted: 0, rejected: 2 });
  });

  test("the hub role reads no token hashes and writes no queue rows itself", async () => {
    await expect(asUser(db.hub, w.admin, (tx) => tx`select token_hash from runners`)).rejects.toThrow();
    await expect(asUser(db.hub, w.admin, (tx) => tx`insert into runner_results (runner_id, monitor_id, at, ok, message) values (${runnerId}, ${monitorId}, now(), false, 'x')`)).rejects.toThrow();
    expect(await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select id from runners`)).toHaveLength(0);
  });

  test("a monitor or server can only use a runner of its own organisation, and only probe kinds", async () => {
    const [bergbau] = (await db.owner`select id from runners where name = 'RZ Bergbau'`) as any[];
    // Bun SQL queries are lazy: wrapped, so expect() gets a real promise.
    await expect((async () => db.owner`update monitors set runner_id = ${bergbau.id} where id = ${monitorId}`)()).rejects.toThrow(/does not belong/);
    await expect((async () => db.owner`insert into monitors (environment_id, name, kind, config, runner_id) values (${w.envs.shopProd}, 'hb', 'heartbeat', '{}', ${runnerId})`)()).rejects.toThrow(/cannot run on a runner/);
    await expect((async () => db.owner`insert into servers (environment_id, runner_id, name, ssh_target) values (${w.envs.mineProd}, ${runnerId}, 'x', 'x')`)()).rejects.toThrow(/does not belong/);
  });

  test("a system runner (no organisation) may serve every organisation; customer runners still may not", async () => {
    const [sys] = (await db.owner`insert into runners (organisation_id, name, token_hash, token_prefix) values (null, 'Systaro-Server', ${sha256Hex(newToken("vrn"))}, 'vrn_s') returning id`) as any[];
    await expect((async () => db.owner`insert into runners (organisation_id, name, token_hash, token_prefix) values (null, 'Systaro-Server', ${sha256Hex(newToken("vrn"))}, 'vrn_t')`)()).rejects.toThrow(/runners_system_name/);
    const [a] = (await db.owner`insert into servers (environment_id, runner_id, name, ssh_target) values (${w.envs.mineProd}, ${sys.id}, 'sys-a', 'vantage@a') returning id`) as any[];
    const [b] = (await db.owner`insert into servers (environment_id, runner_id, name, ssh_target) values (${w.envs.shopProd}, ${sys.id}, 'sys-b', 'vantage@b') returning id`) as any[];
    const [m] = (await db.owner`insert into monitors (environment_id, name, kind, config, runner_id) values (${w.envs.mineProd}, 'Sys', 'tcp', ${{ host: "x", port: 1 }}::jsonb, ${sys.id}) returning id`) as any[];
    const usable = await asUser(db.hub, w.admin, (tx) => runnersForOrg(tx, w.orgs.bergbau));
    expect(usable.map((r) => [r.name, r.system])).toEqual([["RZ Bergbau", false], ["Systaro-Server", true]]);
    await db.owner`delete from servers where id in (${a.id}, ${b.id})`;
    await db.owner`delete from monitors where id = ${m.id}`;
    await db.owner`delete from runners where id = ${sys.id}`;
  });
});

describe("worker", () => {
  test("probe results move the monitor like the worker's own probes", async () => {
    expect(await processRunnerResults(db.worker)).toBe(1);
    let [s] = (await db.owner`select status from monitor_state where monitor_id = ${monitorId}`) as any[];
    expect(s.status).toBe("up");
    await call("/api/runner/v1/results", token, { checks: [check(monitorId, false), check(monitorId, false)], reports: [] });
    await processRunnerResults(db.worker);
    [s] = (await db.owner`select status, consecutive_failures from monitor_state where monitor_id = ${monitorId}`) as any[];
    expect(s).toEqual({ status: "down", consecutive_failures: 2 });
    expect(await events(`monitor:${monitorId}`)).toEqual([{ state: "firing", severity: "critical", title: "Webshop prod – Intranet" }].map((e) => ({ ...e, title: `DOWN: ${e.title}` })));
    expect(((await db.owner`select count(*)::int as n from monitor_checks where monitor_id = ${monitorId}`) as any[])[0].n).toBe(3);
    expect(((await db.owner`select count(*)::int as n from runner_results`) as any[])[0].n).toBe(0);
  });

  test("server reports: checks per server, an event when a threshold is crossed and when it is back", async () => {
    expect(await processServerReports(db.worker)).toBe(1);
    expect(await events(`server:${serverId}:`)).toEqual([]);
    await call("/api/runner/v1/results", token, { checks: [], reports: [{ server_id: serverId, at: new Date().toISOString(), report: report(91), error: null }] });
    await processServerReports(db.worker);
    expect(await events(`server:${serverId}:disk`)).toEqual([{ state: "firing", severity: "warning", title: "Webshop prod – app-01: Festplatte / Warnung" }]);
    await db.owner`update servers set thresholds = ${{ disk_warn: 95, disk_crit: 98 }}::jsonb where id = ${serverId}`;
    await call("/api/runner/v1/results", token, { checks: [], reports: [{ server_id: serverId, at: new Date().toISOString(), report: report(91, { systemd: null }), error: null }] });
    await processServerReports(db.worker);
    expect((await events(`server:${serverId}:disk`)).at(-1)).toEqual({ state: "resolved", severity: "warning", title: "Webshop prod – app-01: Festplatte / wieder in Ordnung" });
    // systemd disappeared from the report: its check is gone (it was ok, so no event).
    expect(((await db.owner`select check_key from server_checks where server_id = ${serverId} order by 1`) as any[]).map((r) => r.check_key)).toEqual(["disk:/", "memory"]);
  });

  test("a report that does not validate is stored as an error, not evaluated", async () => {
    await call("/api/runner/v1/results", token, { checks: [], reports: [{ server_id: serverId, at: new Date().toISOString(), report: { version: 2 }, error: null }] });
    await processServerReports(db.worker);
    const [s] = (await db.owner`select last_error from servers where id = ${serverId}`) as any[];
    expect(s.last_error).toMatch(/^Ungültiger Bericht/);
  });

  test("a quiet runner raises one event and resolves it when it is back; its servers stay quiet meanwhile", async () => {
    await db.owner`update runners set last_seen_at = now() - interval '10 minutes' where id = ${runnerId}`;
    await db.owner`update servers set last_report_at = now() - interval '2 hours' where id = ${serverId}`;
    await runnerWatchdogs(db.worker);
    await runnerWatchdogs(db.worker);
    expect(await events(`runner:${runnerId}:`)).toEqual([{ state: "firing", severity: "critical", title: "Runner „RZ Nordwind“ (Nordwind GmbH) meldet sich nicht" }]);
    expect(await events(`server:${serverId}:silent`)).toEqual([]);
    await call("/api/runner/v1/config", token);
    await runnerWatchdogs(db.worker);
    expect((await events(`runner:${runnerId}:`)).at(-1)?.state).toBe("resolved");
    // The runner is back but the server still sends nothing: now the server is reported.
    expect(await events(`server:${serverId}:silent`)).toEqual([{ state: "firing", severity: "warning", title: "Webshop prod – app-01: keine Werte mehr" }]);
    expect(RUNNER_SILENT_MS).toBe(180_000);
  });
});

describe("visibility", () => {
  test("server values need level 2; server events reach only those who may see them", async () => {
    const bobGrant = (await db.owner`insert into grants (user_id, project_id, level) values (${w.bobBergbauDiagnostics}, ${w.projects.shop}, 'diagnostics') returning id`) as any[];
    expect(await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => serverStatuses(tx, w.envs.shopProd))).toHaveLength(1);
    expect(await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => serverStatuses(tx, w.envs.shopProd))).toEqual([]);
    expect(await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select id from events where source = 'servers'`)).toHaveLength(0);
    expect((await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select id from events where source = 'servers'`) as any[]).length).toBeGreaterThan(0);
    await db.owner`delete from grants where id = ${bobGrant[0].id}`;
  });
});

describe("server readings", () => {
  test("CPU usage from two reports' counters, history in buckets, rejected reports left out, all at level 2", async () => {
    const [{ id }] = (await db.owner`insert into servers (environment_id, runner_id, name, ssh_target) values (${w.envs.shopProd}, ${runnerId}, 'app-02', 'vantage@10.0.0.6') returning id`) as any[];
    const MIN = 60_000;
    const t0 = Math.floor((Date.now() - 3 * 3600_000) / 3600_000) * 3600_000; // on the hour, so the hourly buckets start at t0
    const readings: [number, Record<string, number>, number, boolean][] = [
      [t0, { total: 1000, idle: 800, iowait: 0 }, 40, true],
      [t0 + 5 * MIN, { total: 2000, idle: 1550, iowait: 50 }, 42, true], // 200 of 1000 ticks busy
      [t0 + 7 * MIN, { total: 9000, idle: 0, iowait: 0 }, 99, false], // rejected by the worker: never counts
      [t0 + 10 * MIN, { total: 3000, idle: 2450, iowait: 50 }, 44, true], // 100 of 1000
      [t0 + 130 * MIN, { total: 4000, idle: 2450, iowait: 50 }, 45, true], // after a two-hour gap: no CPU value
    ];
    for (const [at, cpu, disk, accepted] of readings) {
      await db.owner`insert into server_reports (server_id, environment_id, at, report, results, processed_at)
        values (${id}, ${w.envs.shopProd}, ${new Date(at)}, ${report(disk, { cpu })}::jsonb, ${accepted ? [] : null}::jsonb, now())`;
    }
    const bobGrant = (await db.owner`insert into grants (user_id, project_id, level) values (${w.bobBergbauDiagnostics}, ${w.projects.shop}, 'diagnostics') returning id`) as any[];
    const bob = <T,>(fn: (tx: any) => Promise<T>) => asUser(db.hub, w.bobBergbauDiagnostics, fn);
    const alice = <T,>(fn: (tx: any) => Promise<T>) => asUser(db.hub, w.aliceNordwindShopOverview, fn);
    const server = { id, interval_seconds: 300 };

    expect((await bob((tx) => currentCpu(tx, w.envs.shopProd))).get(id)).toBeNull();
    const h = await bob((tx) => serverHistory(tx, server, t0, t0 + 15 * MIN, 5 * MIN));
    expect(h.hasCpu).toBe(true);
    expect(h.cpu.map((p) => p.v)).toEqual([null, 20, 10]);
    expect(h.memory.map((p) => p.v)).toEqual([50, 50, 50]);
    expect(h.disks).toEqual([{ mount: "/", points: [{ t: t0, v: 40 }, { t: t0 + 5 * MIN, v: 42 }, { t: t0 + 10 * MIN, v: 44 }] }]);
    const wide = await bob((tx) => serverHistory(tx, server, t0, t0 + 3 * 3600_000, 3600_000));
    expect(wide.cpu.map((p) => p.v)).toEqual([15, null, null]);

    // The two newest readings are two hours apart, so there is no current value; a fresh pair gives one.
    await db.owner`insert into server_reports (server_id, environment_id, at, report, results, processed_at)
      values (${id}, ${w.envs.shopProd}, ${new Date(t0 + 135 * MIN)}, ${report(45, { cpu: { total: 5000, idle: 2950, iowait: 50 } })}::jsonb, '[]'::jsonb, now())`;
    expect((await bob((tx) => currentCpu(tx, w.envs.shopProd))).get(id)).toBeCloseTo(50);

    expect((await alice((tx) => currentCpu(tx, w.envs.shopProd))).size).toBe(0);
    const hidden = await alice((tx) => serverHistory(tx, server, t0, t0 + 15 * MIN, 5 * MIN));
    expect({ cpu: hidden.cpu.every((p) => p.v === null), disks: hidden.disks, hasCpu: hidden.hasCpu }).toEqual({ cpu: true, disks: [], hasCpu: false });

    await db.owner`delete from grants where id = ${bobGrant[0].id}`;
    await db.owner`delete from servers where id = ${id}`;
  });
});

describe("the runner process", () => {
  const dir = mkdtempSync(join(tmpdir(), "vantage-runner-"));
  const bin = mkdtempSync(join(tmpdir(), "vantage-runner-bin-"));
  const exe = (name: string, body: string) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  // Fake ssh-keygen writes a key pair where -f points; fake ssh checks the target and prints a report.
  const keygen = exe("ssh-keygen", `while [ $# -gt 0 ]; do [ "$1" = "-f" ] && f="$2"; shift; done; echo private > "$f"; echo "ssh-ed25519 ${"A".repeat(68)} vantage-runner" > "$f.pub"`);
  const ssh = exe("ssh", `for a; do last="$a"; prev2="$prev"; prev="$a"; done; cat > /dev/null; case "$prev2" in down@*) echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255;; esac; echo '${JSON.stringify(report(42))}'`);
  const agent = exe("agent.sh", "echo agent");

  function fakeHub(config: RunnerConfig) {
    const posted: ResultsBody[] = [];
    let up = true;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!up) throw new Error("ECONNREFUSED");
      const u = String(url);
      if (u.endsWith("/config")) return Response.json(config);
      posted.push(JSON.parse(String(init!.body)));
      return Response.json({ accepted: 1, rejected: 0 });
    }) as typeof fetch;
    return { posted, fetchFn, setUp: (v: boolean) => (up = v) };
  }

  test("probes, reads servers over ssh, buffers while the hub is away and delivers afterwards", async () => {
    const hub = fakeHub({
      runner: { id: 1, name: "Test" }, poll_seconds: 60,
      monitors: [{ id: 7, name: "tcp", kind: "tcp", config: { host: "127.0.0.1", port: 1 }, interval_seconds: 60, timeout_ms: 1000, retry_interval_seconds: null }],
      servers: [{ id: 3, name: "app", ssh_target: "vantage@app", interval_seconds: 300 }, { id: 4, name: "down", ssh_target: "down@db", interval_seconds: 300 }],
    });
    const runner = new Runner({ url: "https://hub.test", token: newToken("vrn"), dataDir: dir, version: "t", sshBin: ssh, sshKeygenBin: keygen, agentScript: agent, fetch: hub.fetchFn, log: () => {} });
    await runner.ensureKey();
    expect(runner.publicKey).toStartWith("ssh-ed25519 ");
    await runner.refresh();
    await Promise.all(runner.tick());
    expect(runner.checks.map((c) => [c.monitor_id, c.ok])).toEqual([[7, false]]);
    // Both servers are read in parallel, so their reports arrive in either order.
    const reports = runner.reports.toSorted((a, b) => a.server_id - b.server_id);
    expect(reports.map((r) => [r.server_id, r.error === null])).toEqual([[3, true], [4, false]]);
    expect(reports[1]!.error).toContain("Connection refused");
    // Not due again yet: a failed probe comes back after the retry interval (20 s), not at once.
    expect(runner.tick()).toHaveLength(0);

    hub.setUp(false);
    await runner.flush();
    expect(runner.checks).toHaveLength(1);
    hub.setUp(true);
    await runner.flush();
    expect(runner.checks).toHaveLength(0);
    expect(hub.posted).toHaveLength(1);
    expect(parseResultsBody(hub.posted[0]).ok).toBe(true);
  });

  test("ssh targets that look like options never reach ssh", async () => {
    const { readServer } = await import("../src/runner/runner");
    const r = await readServer({ sshBin: ssh, keyFile: "k", knownHosts: "h", agentScript: agent, target: "-oProxyCommand=touch /tmp/x" });
    expect(r.error).toMatch(/Ungültiges SSH-Ziel/);
  });
});
