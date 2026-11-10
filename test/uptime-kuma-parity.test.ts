import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sha256Hex } from "../src/shared/crypto";
import { processEvents, routeMatches } from "../src/hub/modules/alerts/engine";
import { sealConfig } from "../src/hub/modules/alerts/channels";
import { certificateAlert, transition } from "../src/hub/modules/uptime/engine";
import { convertKumaMonitor, kumaJsonRule, monitorKey, type KumaMonitor } from "../src/hub/modules/uptime/kuma-import";
import { checkJson, evaluateHeartbeat, probeHttp, readJsonPath } from "../src/hub/modules/uptime/probes";
import { mountUptimeApi, parseHeaderLines, parseMonitorForm } from "../src/hub/modules/uptime/routes";
import { buildWorld, type World } from "./fixtures";
import { createHubTestDb, type TestDb } from "./helpers/db";

describe("JSON checks", () => {
  const body = JSON.stringify({ status: "OK", dmts: 81234, healthy: true, queue: { items: [{ size: 3 }] }, note: null });
  test("compare numbers as numbers and everything else as text", () => {
    expect(checkJson(body, { path: "status", op: "==", expected: "OK" }).ok).toBe(true);
    expect(checkJson(body, { path: "dmts", op: ">", expected: "80000" })).toEqual({ ok: true, message: "dmts = 81234" });
    expect(checkJson(body, { path: "dmts", op: "<=", expected: "80000" })).toEqual({ ok: false, message: "dmts = 81234, erwartet <= 80000" });
    expect(checkJson(body, { path: "healthy", op: "==", expected: "true" }).ok).toBe(true);
    expect(checkJson(body, { path: "$.queue.items[0].size", op: ">=", expected: "3" }).ok).toBe(true);
    expect(checkJson(body, { path: "status", op: ">", expected: "1" }).ok).toBe(false);
    expect(checkJson(body, { path: "status", op: "contains", expected: "K" }).ok).toBe(true);
    expect(checkJson(body, { path: "note", op: "==", expected: "null" }).ok).toBe(true);
  });

  test("a missing value or a body that is not JSON fails with a reason", () => {
    expect(checkJson(body, { path: "queue.missing", op: "==", expected: "1" })).toEqual({ ok: false, message: "„queue.missing“ fehlt in der Antwort" });
    expect(checkJson("<html>", { path: "status", op: "==", expected: "OK" })).toEqual({ ok: false, message: "Die Antwort ist kein JSON" });
    expect(readJsonPath({ a: "x" }, "a.b.c")).toBeUndefined();
  });
});

describe("HTTP monitors with headers, body, secret query and JSON check", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { method: string; url: string; token: string | null; type: string | null; body: string }[] = [];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ method: req.method, url: req.url, token: req.headers.get("x-auth-token"), type: req.headers.get("content-type"), body: await req.text() });
        return Response.json({ currency: "EUR", pending: 4 });
      },
    });
  });
  afterAll(() => server.stop(true));

  test("POST sends the decrypted headers, the body as JSON and the secret query; the JSON rule decides", async () => {
    const url = `http://127.0.0.1:${server.port}/price`;
    const ok = await probeHttp({ url, method: "POST", body: '{"sp":1}', json: { path: "currency", op: "==", expected: "EUR" } }, 5000, { headers: { "X-Auth-Token": "t0k" }, query: "key=s3cret" });
    expect(ok).toMatchObject({ ok: true, statusCode: 200, message: "HTTP 200, currency = EUR" });
    expect(seen.at(-1)).toEqual({ method: "POST", url: `${url}?key=s3cret`, token: "t0k", type: "application/json", body: '{"sp":1}' });
    const bad = await probeHttp({ url, json: { path: "pending", op: "<", expected: "3" } }, 5000);
    expect(bad).toMatchObject({ ok: false, message: "HTTP 200, pending = 4, erwartet < 3" });
  });

  test("a failed request never repeats the secret query", async () => {
    const res = await probeHttp({ url: "http://127.0.0.1:1/x" }, 2000, { query: "key=s3cret" });
    expect(res.ok).toBe(false);
    expect(res.message).not.toContain("s3cret");
  });
});

describe("monitor form", () => {
  test("headers are parsed line by line and stored encrypted; empty fields keep the stored secrets", async () => {
    expect(parseHeaderLines("X-Auth-Token: abc\n\nX-Customer-Id:42")).toEqual({ "X-Auth-Token": "abc", "X-Customer-Id": "42" });
    expect(parseHeaderLines("kein header")).toHaveProperty("error");
    const form = (v: Record<string, string>) => ({ get: (k: string) => v[k] ?? "" });
    const created = await parseMonitorForm(form({
      name: "Preis", kind: "http", url: "https://api.example/price", method: "POST", body: "{}", headers: "X-Auth-Token: abc",
      secret_query: "?key=1", json_path: "currency", json_op: "==", json_expected: "EUR", tls_expiry: "1", retry_interval_seconds: "60",
    }), null);
    if ("error" in created) throw new Error(created.error);
    const cfg = created.config as any;
    expect(cfg).toMatchObject({ url: "https://api.example/price", method: "POST", body: "{}", json: { path: "currency", op: "==", expected: "EUR" }, tlsExpiry: true, warnDays: 14, critDays: 3 });
    expect(cfg.headersEnc).toBeString();
    expect(JSON.stringify(cfg)).not.toContain("abc");
    expect(created.retryInterval).toBe(60);
    const edited = await parseMonitorForm(form({ name: "Preis", url: "https://api.example/price", method: "POST", body: "{}", retry_interval_seconds: "20" }), { kind: "http", config: { ...cfg, kumaId: 102 } });
    if ("error" in edited) throw new Error(edited.error);
    expect((edited.config as any).headersEnc).toBe(cfg.headersEnc);
    expect((edited.config as any).queryEnc).toBe(cfg.queryEnc);
    expect(edited.retryInterval).toBeNull();
    expect((edited.config as any).kumaId).toBe(102);
    const cleared = await parseMonitorForm(form({ name: "Preis", url: "https://api.example/price", headers_clear: "1" }), { kind: "http", config: cfg });
    if ("error" in cleared) throw new Error(cleared.error);
    expect((cleared.config as any).headersEnc).toBeUndefined();
  });
});

describe("certificate and retry timing", () => {
  test("certificate alert: warning below 14 days, critical below 3", () => {
    expect(certificateAlert(30, {})).toBeNull();
    expect(certificateAlert(13, {})).toBe("warning");
    expect(certificateAlert(2, {})).toBe("critical");
    expect(certificateAlert(20, { warnDays: 21 })).toBe("warning");
    expect(certificateAlert(null, {})).toBeNull();
  });

  test("a failure within the tolerance is retried after the monitor's retry interval", () => {
    expect(transition("up", 0, 3, false, 300, 200).nextInSeconds).toBe(200);
    expect(transition("up", 0, 3, false, 60, 200).nextInSeconds).toBe(60);
    expect(transition("up", 0, 3, false, 60).nextInSeconds).toBe(20);
  });

  test("a heartbeat shows what the job said", () => {
    const now = new Date();
    expect(evaluateHeartbeat(now, 60, {}, now, "pending=68").message).toMatch(/^Letztes Signal vor \d+ s \(„pending=68“\)$/);
    expect(evaluateHeartbeat(null, 60, {}, now, "pending=68").message).toBe("Wartet auf das erste Signal");
  });
});

describe("Uptime Kuma push path", () => {
  let db: TestDb;
  let w: World;
  let app: Hono;
  beforeAll(async () => {
    db = await createHubTestDb();
    w = await buildWorld(db.owner);
    app = new Hono();
    mountUptimeApi(app, db.hub);
    await db.owner`insert into monitors (environment_id, name, kind, heartbeat_token_hash) values (${w.envs.shopProd}, 'Import', 'heartbeat', ${sha256Hex("Ab3dEf9hJk")})`;
  });
  afterAll(() => db.drop());
  const state = async () => ((await db.owner`select s.last_heartbeat_at, s.last_heartbeat_message from monitor_state s join monitors m on m.id = s.monitor_id where m.name = 'Import'`) as any[])[0];

  test("a Kuma token on Kuma's path is a heartbeat, with its message; Kuma's default \"OK\" is dropped", async () => {
    expect((await app.request("/api/push/Ab3dEf9hJk?status=up&msg=pending%3D68&ping=")).status).toBe(200);
    expect(await state()).toMatchObject({ last_heartbeat_message: "pending=68" });
    expect((await app.request("/api/push/Ab3dEf9hJk?status=up&msg=OK", { method: "POST" })).status).toBe(200);
    expect((await state()).last_heartbeat_message).toBeNull();
  });

  test("unknown or malformed tokens are 404; a job reporting down is not a signal", async () => {
    expect((await app.request("/api/push/Zz9yY8xX7w")).status).toBe(404);
    expect((await app.request("/api/push/bad%20token")).status).toBe(404);
    await db.owner`update monitor_state s set last_heartbeat_at = null from monitors m where m.id = s.monitor_id and m.name = 'Import'`;
    expect((await app.request("/api/push/Ab3dEf9hJk?status=down&msg=failed")).status).toBe(200);
    expect((await state()).last_heartbeat_at).toBeNull();
  });
});

describe("routes for a single monitor", () => {
  let db: TestDb;
  let w: World;
  beforeAll(async () => {
    db = await createHubTestDb();
    w = await buildWorld(db.owner);
  });
  afterAll(() => db.drop());

  test("match the monitor's down and certificate events, nothing else in the environment", async () => {
    const route = { scope_kind: "monitor", scope_id: 7, sources: ["uptime"], min_severity: "warning" as const };
    const scope = { environment_id: 1, project_id: 1, organisation_id: 1 };
    expect(routeMatches(route, { source: "uptime", severity: "critical" }, { ...scope, monitor_id: 7 })).toBe(true);
    expect(routeMatches(route, { source: "uptime", severity: "critical" }, { ...scope, monitor_id: 8 })).toBe(false);
    expect(routeMatches(route, { source: "uptime", severity: "critical" }, scope)).toBe(false);

    const [m] = (await db.owner`insert into monitors (environment_id, name, kind, config) values (${w.envs.shopProd}, 'Import-Job', 'http', '{"url":"https://x"}') returning id`) as { id: number }[];
    const [other] = (await db.owner`insert into monitors (environment_id, name, kind, config) values (${w.envs.shopProd}, 'Shop', 'http', '{"url":"https://y"}') returning id`) as { id: number }[];
    const [ch] = (await db.owner`insert into channels (name, kind, config_enc) values ('Kunde', 'email', ${await sealConfig("test-secret-0123456789", { kind: "email", recipients: ["kunde@example.test"] })}) returning id`) as { id: number }[];
    await db.owner`insert into routes (channel_id, scope_kind, scope_id, sources, min_severity) values (${ch!.id}, 'monitor', ${m!.id}, '{uptime}', 'warning')`;
    const fire = (subject: string) => db.owner`insert into events (source, environment_id, subject_key, state, severity, title) values ('uptime', ${w.envs.shopProd}, ${subject}, 'firing', 'critical', ${subject}) returning id`;
    await fire(`monitor:${m!.id}`);
    await fire(`monitor:${m!.id}:tls-expiry`);
    await fire(`monitor:${other!.id}`);
    await processEvents(db.worker);
    const sent = (await db.owner`select e.subject_key from notifications n join events e on e.id = n.event_id where n.channel_id = ${ch!.id} order by e.id`) as { subject_key: string }[];
    expect(sent.map((r) => r.subject_key)).toEqual([`monitor:${m!.id}`, `monitor:${m!.id}:tls-expiry`]);

    await db.owner`delete from monitors where id = ${m!.id}`;
    expect(((await db.owner`select count(*)::int as n from routes where channel_id = ${ch!.id}`) as any[])[0].n).toBe(0);
  });
});

describe("Kuma monitors become Vantage monitors", () => {
  const base = {
    id: 1, parent: null, name: "X", type: "http", active: 1, url: "https://shop.example/", method: "GET", body: null, headers: null,
    accepted_statuscodes_json: '["200-299"]', keyword: null, invert_keyword: 0, json_path: null, json_path_operator: null, expected_value: null,
    interval: 60, maxretries: 3, retry_interval: 280, timeout: 48, expiry_notification: 1, max_redirects: 10, ignore_tls: 0, upside_down: 0,
    push_token: null, auth_method: null, has_basic_auth: false, notifications: [],
  } as KumaMonitor;

  test("http keeps Kuma's timing, status codes and certificate warning", () => {
    const m = convertKumaMonitor({ ...base, accepted_statuscodes_json: '["200-299","401"]' }, "Shop");
    expect(m).toMatchObject({ kind: "http", name: "Shop", interval: 60, timeoutMs: 48_000, retries: 3, retryInterval: 280,
      config: { url: "https://shop.example/", method: "GET", expectStatus: "200-299,401", tlsExpiry: true, followRedirects: true, kumaId: 1 } });
  });

  test("a query string and headers become secrets; a JSONata comparison becomes a JSON rule", () => {
    const m = convertKumaMonitor({ ...base, type: "json-query", url: "https://api.example/q?key=abc&x=1", headers: '{"X-Auth-Token":"t"}', json_path: "dmts > 80000", json_path_operator: "==", expected_value: "true" }, "Q");
    if ("skip" in m) throw new Error(m.skip);
    expect(m.config).toMatchObject({ url: "https://api.example/q", json: { path: "dmts", op: ">", expected: "80000" } });
    expect(m.secrets).toEqual({ headers: { "X-Auth-Token": "t" }, query: "key=abc&x=1" });
    expect(JSON.stringify(m.config)).not.toContain("abc");
    expect(kumaJsonRule("status", "==", "OK")).toEqual({ path: "status", op: "==", expected: "OK" });
    expect(kumaJsonRule("$sum(items.price)", "==", "3")).toHaveProperty("skip");
  });

  test("a push monitor keeps its token and is down after interval plus Kuma's retries", () => {
    const m = convertKumaMonitor({ ...base, type: "push", url: null, push_token: "Ab3dEf9hJk", interval: 240, maxretries: 6, retry_interval: 240 }, "Cron");
    expect(m).toMatchObject({ kind: "heartbeat", interval: 240, retries: 0, config: { graceSeconds: 1440 }, secrets: { pushToken: "Ab3dEf9hJk" } });
  });

  test("what Vantage cannot do is skipped with the reason, never imported half", () => {
    expect(convertKumaMonitor({ ...base, upside_down: 1 }, "X")).toHaveProperty("skip");
    expect(convertKumaMonitor({ ...base, ignore_tls: 1 }, "X")).toHaveProperty("skip");
    expect(convertKumaMonitor({ ...base, type: "ping" }, "X")).toHaveProperty("skip");
    expect(convertKumaMonitor({ ...base, method: "PUT" }, "X")).toHaveProperty("skip");
  });

  test("the same URL with or without the trailing slash is one monitor", () => {
    expect(monitorKey("http", { url: "https://Shop.example/" })).toBe(monitorKey("http", { url: "https://shop.example" }));
    expect(monitorKey("http", { url: "https://shop.example/a/" })).toBe(monitorKey("http", { url: "https://shop.example/a" }));
    expect(monitorKey("http", { url: "https://x/h", json: { path: "a", op: "==", expected: "1" } })).not.toBe(monitorKey("http", { url: "https://x/h" }));
    expect(monitorKey("heartbeat", {})).toBeNull();
  });
});
