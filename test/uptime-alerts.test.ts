import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hmacHex, newToken, sha256Hex } from "../src/shared/crypto";
import { sealConfig } from "../src/hub/modules/alerts/channels";
import { deliverNotifications, processEvents, requiredLevel, routeMatches } from "../src/hub/modules/alerts/engine";
import { transition, tlsWarning } from "../src/hub/modules/uptime/engine";
import { evaluateHeartbeat, parseKumaStatus, statusMatcher } from "../src/hub/modules/uptime/probes";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const SECRET = "test-secret-0123456789";
let db: TestDb;
let w: World;

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
});
afterAll(() => db.drop());

describe("uptime state machine", () => {
  test("failures within the tolerance keep the state and retry sooner", () => {
    const t = transition("up", 0, 1, false, 60);
    expect(t).toMatchObject({ status: "up", failures: 1, event: null });
    expect(t.nextInSeconds).toBeLessThan(60);
  });
  test("going down fires once, staying down is silent, recovery resolves", () => {
    expect(transition("up", 1, 1, false, 60)).toMatchObject({ status: "down", event: { state: "firing" } });
    expect(transition("down", 2, 1, false, 60).event).toBeNull();
    expect(transition("down", 5, 1, true, 60)).toMatchObject({ status: "up", failures: 0, event: { state: "resolved" } });
  });
  test("a new monitor that fails beyond the tolerance goes down with an event; one that succeeds goes up silently", () => {
    expect(transition("pending", 0, 0, false, 60)).toMatchObject({ status: "down", event: { state: "firing" } });
    expect(transition("pending", 0, 1, true, 60)).toMatchObject({ status: "up", event: null });
  });
  test("TLS warning band", () => {
    expect(tlsWarning(10, {})).toBe(true);
    expect(tlsWarning(20, {})).toBe(false);
    expect(tlsWarning(2, {})).toBe(false); // below critDays the monitor is down instead
    expect(tlsWarning(null, {})).toBe(false);
  });
  test("status matcher and heartbeat evaluation", () => {
    const m = statusMatcher("200-299,301");
    expect([m(200), m(299), m(301), m(302), m(500)]).toEqual([true, true, true, false, false]);
    const created = new Date(Date.now() - 3600_000);
    expect(evaluateHeartbeat(new Date(Date.now() - 30_000), 60, { graceSeconds: 60 }, created).ok).toBe(true);
    expect(evaluateHeartbeat(new Date(Date.now() - 300_000), 60, { graceSeconds: 60 }, created).ok).toBe(false);
    expect(evaluateHeartbeat(null, 86400, {}, created).ok).toBe(true);
  });
  test("Uptime Kuma metrics parsing", () => {
    const metrics = [
      "# HELP monitor_status Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)",
      'monitor_status{monitor_name="Shop \\"prod\\"",monitor_type="http",monitor_url="https://x",monitor_hostname="null",monitor_port="null"} 0',
      'monitor_status{monitor_name="API",monitor_type="http",monitor_url="https://y",monitor_hostname="null",monitor_port="null"} 1',
    ].join("\n");
    expect(parseKumaStatus(metrics, "API")).toBe(1);
    expect(parseKumaStatus(metrics, 'Shop "prod"')).toBe(0);
    expect(parseKumaStatus(metrics, "missing")).toBeNull();
  });
});

describe("uptime data follows grants", () => {
  test("monitors, state and checks are visible only on granted environments", async () => {
    const shop = (await db.owner`insert into monitors (environment_id, name, kind, config) values (${w.envs.shopProd}, 'Shop', 'http', ${{ url: "https://x" }}::jsonb) returning id`) as any[];
    await db.owner`insert into monitors (environment_id, name, kind, config) values (${w.envs.mineProd}, 'Mine', 'http', ${{ url: "https://y" }}::jsonb)`;
    await db.owner`insert into monitor_checks (monitor_id, environment_id, ok) values (${shop[0].id}, ${w.envs.shopProd}, true)`;
    const alice = await asUser(db.hub, w.aliceNordwindShopOverview, async (tx) => ({
      monitors: (await tx`select name from monitors`) as any[],
      state: (await tx`select monitor_id from monitor_state`) as any[],
      checks: (await tx`select id from monitor_checks`) as any[],
    }));
    expect(alice.monitors.map((m) => m.name)).toEqual(["Shop"]);
    expect(alice.state).toHaveLength(1);
    expect(alice.checks).toHaveLength(1);
    const bob = (await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select name from monitors`)) as any[];
    expect(bob.map((m) => m.name)).toEqual(["Mine"]);
  });

  test("the hub role cannot write checks or state, and customers cannot create monitors", async () => {
    await expect(asUser(db.hub, w.admin, (tx) => tx`insert into monitor_checks (monitor_id, environment_id, ok) values (1, ${w.envs.shopProd}, true)`)).rejects.toThrow(/permission denied/);
    await expect(asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`insert into monitors (environment_id, name, kind) values (${w.envs.shopProd}, 'x', 'http')`)).rejects.toThrow();
  });

  test("heartbeats need the right token", async () => {
    const token = newToken("vhb");
    await db.owner`insert into monitors (environment_id, name, kind, heartbeat_token_hash) values (${w.envs.shopProd}, 'Backup', 'heartbeat', ${sha256Hex(token)})`;
    const ok = (await db.hub`select ingest_heartbeat(${sha256Hex(token)}) as ok`) as any[];
    const bad = (await db.hub`select ingest_heartbeat(${sha256Hex(newToken("vhb"))}) as ok`) as any[];
    expect(ok[0].ok).toBe(true);
    expect(bad[0].ok).toBe(false);
  });
});

describe("alert routing", () => {
  test("route matching by scope, source and severity", () => {
    const scope = { environment_id: 1, project_id: 2, organisation_id: 3 };
    const base = { scope_id: null, sources: ["uptime"], min_severity: "warning" as const };
    expect(routeMatches({ ...base, scope_kind: "all" }, { source: "uptime", severity: "critical" }, scope)).toBe(true);
    expect(routeMatches({ ...base, scope_kind: "all" }, { source: "tests", severity: "critical" }, scope)).toBe(false);
    expect(routeMatches({ ...base, scope_kind: "all" }, { source: "uptime", severity: "info" }, scope)).toBe(false);
    expect(routeMatches({ ...base, scope_kind: "organisation", scope_id: 3 }, { source: "uptime", severity: "warning" }, scope)).toBe(true);
    expect(routeMatches({ ...base, scope_kind: "project", scope_id: 9 }, { source: "uptime", severity: "warning" }, scope)).toBe(false);
    expect(routeMatches({ ...base, scope_kind: "environment", scope_id: 1 }, { source: "uptime", severity: "warning" }, { environment_id: null, project_id: null, organisation_id: null })).toBe(false);
    expect(requiredLevel("errors")).toBe(2);
    expect(requiredLevel("uptime")).toBe(1);
  });

  test("customers can only subscribe to what they can see", async () => {
    const alice = w.aliceNordwindShopOverview;
    await asUser(db.hub, alice, (tx) => tx`insert into subscriptions (user_id, scope_kind, min_severity) values (${alice}, 'all', 'info')`);
    await expect(asUser(db.hub, alice, (tx) => tx`insert into subscriptions (user_id, scope_kind, scope_id) values (${alice}, 'environment', ${w.envs.mineProd})`)).rejects.toThrow();
    await expect(asUser(db.hub, alice, (tx) => tx`insert into subscriptions (user_id, scope_kind) values (${w.bobBergbauDiagnostics}, 'all')`)).rejects.toThrow();
  });

  test("events fan out to matching routes and to subscribers with access; incidents dedupe", async () => {
    const carol = w.carolStageOnly;
    await db.owner`insert into subscriptions (user_id, scope_kind, min_severity) values (${carol}, 'all', 'info')`;
    const [ch] = (await db.owner`insert into channels (name, kind, config_enc) values ('Ops', 'email', ${await sealConfig(SECRET, { kind: "email", recipients: ["ops@example.test"] })}) returning id`) as any[];
    await db.owner`insert into routes (channel_id, scope_kind, scope_id, sources, min_severity) values (${ch.id}, 'organisation', ${w.orgs.nordwind}, '{uptime,errors}', 'warning')`;

    const insertEvent = (env: number, source: string, state: string, subject: string) =>
      db.owner`insert into events (source, environment_id, subject_key, state, severity, title) values (${source}, ${env}, ${subject}, ${state}, 'critical', ${subject}) returning id`;

    const [shopDown] = (await insertEvent(w.envs.shopProd, "uptime", "firing", "monitor:shop")) as any[];
    const [shopAgain] = (await insertEvent(w.envs.shopProd, "uptime", "firing", "monitor:shop")) as any[];
    const [mineDown] = (await insertEvent(w.envs.mineProd, "uptime", "firing", "monitor:mine")) as any[];
    const [prodError] = (await insertEvent(w.envs.shopProd, "errors", "notice", "error:prod")) as any[];
    const [stageError] = (await insertEvent(w.envs.shopStage, "errors", "notice", "error:stage")) as any[];
    await processEvents(db.worker);

    const recipients = async (eventId: number) => {
      const rows = (await db.owner`select channel_id, user_id from notifications where event_id = ${eventId} order by user_id nulls first`) as any[];
      return rows.map((r) => (r.channel_id ? `channel:${r.channel_id}` : `user:${r.user_id}`));
    };
    // Alice (overview, all) and the Nordwind channel get the shop outage; Carol only sees stage.
    expect(await recipients(shopDown.id)).toEqual([`channel:${ch.id}`, `user:${w.aliceNordwindShopOverview}`]);
    expect(await recipients(shopAgain.id)).toEqual([]);
    // Bergbau: no Nordwind route, Alice and Carol have no access.
    expect(await recipients(mineDown.id)).toEqual([]);
    // Errors need diagnostics: Alice (overview) gets none; Carol only on stage.
    expect(await recipients(prodError.id)).toEqual([`channel:${ch.id}`]);
    expect(await recipients(stageError.id)).toEqual([`channel:${ch.id}`, `user:${carol}`]);
    const open = (await db.owner`select count(*)::int as n from incidents where subject_key = 'monitor:shop' and resolved_at is null`) as any[];
    expect(open[0].n).toBe(1);

    const [shopUp] = (await insertEvent(w.envs.shopProd, "uptime", "resolved", "monitor:shop")) as any[];
    await processEvents(db.worker);
    expect(await recipients(shopUp.id)).toHaveLength(2);
    const closed = (await db.owner`select count(*)::int as n from incidents where subject_key = 'monitor:shop' and resolved_at is null`) as any[];
    expect(closed[0].n).toBe(0);
  });

  test("an open incident that escalates notifies again; de-escalation and repeats stay silent", async () => {
    const fire = async (severity: string) => {
      const [ev] = (await db.owner`insert into events (source, environment_id, subject_key, state, severity, title)
                                   values ('ops', ${w.envs.shopProd}, 'ops:host:a:disk', 'firing', ${severity}, ${`Disk ${severity}`}) returning id`) as any[];
      await processEvents(db.worker);
      const [n] = (await db.owner`select count(*)::int as n from notifications where event_id = ${ev.id}`) as any[];
      const [inc] = (await db.owner`select severity from incidents where subject_key = 'ops:host:a:disk' and resolved_at is null`) as any[];
      return { notified: n.n > 0, severity: inc.severity };
    };
    expect(await fire("warning")).toEqual({ notified: true, severity: "warning" });
    expect(await fire("warning")).toEqual({ notified: false, severity: "warning" });
    expect(await fire("critical")).toEqual({ notified: true, severity: "critical" });
    expect(await fire("warning")).toEqual({ notified: false, severity: "warning" });
  });

  test("delivery skips users who lost access in the meantime, and signs webhooks", async () => {
    const received: { body: string; ts: string | null; sig: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push({ body: await req.text(), ts: req.headers.get("x-vantage-timestamp"), sig: req.headers.get("x-vantage-signature") });
        return new Response("ok");
      },
    });
    try {
      const [ch] = (await db.owner`insert into channels (name, kind, config_enc) values ('Hook', 'webhook', ${await sealConfig(SECRET, { kind: "webhook", url: `http://127.0.0.1:${server.port}/hook`, secret: "whsec" })}) returning id`) as any[];
      const [ev] = (await db.owner`insert into events (source, environment_id, subject_key, state, severity, title, processed_at) values ('uptime', ${w.envs.shopProd}, 'x', 'notice', 'info', 'Hallo', now()) returning id`) as any[];
      await db.owner`delete from notifications`;
      await db.owner`insert into notifications (event_id, channel_id) values (${ev.id}, ${ch.id})`;
      await db.owner`insert into notifications (event_id, user_id) values (${ev.id}, ${w.aliceNordwindShopOverview})`;
      await db.owner`delete from grants where user_id = ${w.aliceNordwindShopOverview}`;

      await deliverNotifications(db.worker, { mail: async () => ({ smtpUrl: "smtp://127.0.0.1:1", from: "t@example.test" }), secret: SECRET, publicUrl: "http://localhost:7100" }, () => {});
      const rows = (await db.owner`select channel_id, user_id, status, error from notifications order by id`) as any[];
      expect(rows[0]).toMatchObject({ status: "sent" });
      expect(rows[1]).toMatchObject({ status: "skipped", error: "kein Zugriff mehr" });
      expect(received).toHaveLength(1);
      expect(received[0]!.sig).toBe(`sha256=${hmacHex("whsec", `${received[0]!.ts}.${received[0]!.body}`)}`);
    } finally {
      server.stop(true);
    }
  });
});

describe("ops events and test sends", () => {
  test("ops events need a live token and resolve the environment path", async () => {
    const token = newToken("vop");
    await db.owner`insert into machine_tokens (name, purpose, token_hash, token_prefix) values ('ops', 'ops-events', ${sha256Hex(token)}, 'vop_')`;
    const call = (t: string, path: string | null) =>
      db.hub`select ingest_ops_event(${sha256Hex(t)}, ${path}, 'host:a:disk', 'firing', 'critical', 'Disk voll', null, null) as id`;
    expect(((await call(newToken("vop"), null)) as any[])[0].id).toBeNull();
    const [ok] = (await call(token, "nordwind/shop/prod")) as any[];
    const [ev] = (await db.owner`select environment_id, subject_key from events where id = ${ok.id}`) as any[];
    expect(ev).toEqual({ environment_id: w.envs.shopProd, subject_key: "ops:host:a:disk" });
    await db.owner`update machine_tokens set revoked_at = now()`;
    expect(((await call(token, null)) as any[])[0].id).toBeNull();
  });

  test("only admins can queue a test message", async () => {
    const [ch] = (await db.owner`select id from channels limit 1`) as any[];
    await expect(asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select admin_test_channel(${ch.id})`)).rejects.toThrow(/admin only/);
    const [row] = (await asUser(db.hub, w.admin, (tx) => tx`select admin_test_channel(${ch.id}) as ev`)) as any[];
    expect(Number(row.ev)).toBeGreaterThan(0);
  });

  test("error events are diagnostics data: overview users never see them", async () => {
    await db.owner`insert into events (source, environment_id, subject_key, state, severity, title, processed_at)
                   values ('errors', ${w.envs.shopStage}, 'error:secret', 'notice', 'warning', 'Neuer Fehler: SecretException', now())`;
    const see = async (user: number) =>
      ((await asUser(db.hub, user, (tx) => tx`select id from events where subject_key = 'error:secret'`)) as any[]).length;
    // Alice has overview on the whole Webshop project; Carol has diagnostics on Webshop stage.
    expect(await see(w.aliceNordwindShopOverview)).toBe(0);
    expect(await see(w.carolStageOnly)).toBe(1);
    expect(await see(w.admin)).toBe(1);
  });

  test("system events without an environment are admin-only", async () => {
    await db.owner`insert into events (source, subject_key, state, severity, title) values ('ops', 'ops:sweep', 'firing', 'critical', 'Sweep steht')`;
    const alice = (await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select id from events where subject_key = 'ops:sweep'`)) as any[];
    const admin = (await asUser(db.hub, w.admin, (tx) => tx`select id from events where subject_key = 'ops:sweep'`)) as any[];
    expect(alice).toHaveLength(0);
    expect(admin).toHaveLength(1);
  });
});

describe("what leaves the hub in messages", () => {
  test("links into other systems go only to admins and internal channels", async () => {
    const { publicLink } = await import("../src/hub/modules/alerts/engine");
    const ops = "https://ops.internal/hosts/3";
    expect(publicLink("/env/4/uptime/2", "https://hub.test", false, 4)).toBe("https://hub.test/env/4/uptime/2");
    expect(publicLink(ops, "https://hub.test", true, 4)).toBe(ops);
    expect(publicLink(ops, "https://hub.test", false, 4)).toBe("https://hub.test/env/4/incidents");
    expect(publicLink(ops, "https://hub.test", false, null)).toBeNull();
  });

  test("event text cannot become markup in Slack or Teams", async () => {
    const { slackEscape, teamsEscape } = await import("../src/hub/modules/alerts/channels");
    expect(slackEscape("NPE <https://evil.example|Hier klicken> & mehr")).toBe("NPE &lt;https://evil.example|Hier klicken&gt; &amp; mehr");
    expect(teamsEscape("[Hier klicken](https://evil.example)")).toBe("[Hier klicken] (https://evil.example)");
  });
});

describe("subject lines", () => {
  test("red for an outage, yellow for a warning, green when it is over, i for a notice", async () => {
    const { subjectLine } = await import("../src/hub/modules/alerts/channels");
    const m = { title: "DOWN: Shop", body: null, url: null, context: null, at: new Date(), source: "uptime", eventId: 1 } as const;
    expect(subjectLine({ ...m, state: "firing", severity: "critical" })).toBe("[Vantage] 🔴 PROBLEM: DOWN: Shop");
    expect(subjectLine({ ...m, state: "firing", severity: "warning" })).toBe("[Vantage] 🟡 PROBLEM: DOWN: Shop");
    expect(subjectLine({ ...m, state: "resolved", severity: "critical" })).toBe("[Vantage] 🟢 BEHOBEN: DOWN: Shop");
    expect(subjectLine({ ...m, state: "notice", severity: "critical" })).toBe("[Vantage] ℹ️ HINWEIS: DOWN: Shop");
  });
});
