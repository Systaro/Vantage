import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createAuth, type AuthStore } from "../src/shared/auth";
import { encryptString, hashPassword, newToken, sha256Hex } from "../src/shared/crypto";
import { newTotpSecret, totpCode } from "../src/shared/totp";
import { hubAuthStore } from "../src/hub/auth-store";
import { loginWay } from "../src/hub/modules/core/devices";
import { buildWorld, type World } from "./fixtures";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";

const SECRET = "test-hub-secret-0123456789abcdef0123456789";
const PASSWORD = "a-long-test-password";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

let db: TestDb;
let w: World;
const totp: Record<number, string> = {};

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
  const hash = await hashPassword(PASSWORD);
  for (const id of [w.admin, w.aliceNordwindShopOverview, w.bobBergbauDiagnostics, w.carolStageOnly]) {
    totp[id] = newTotpSecret();
    await db.owner`update users set password_hash = ${hash}, totp_secret_enc = ${await encryptString(SECRET, totp[id]!)} where id = ${id}`;
  }
});
afterAll(() => db.drop());

const trust = async (userId: number, days = 30) => {
  const token = newToken("vd");
  const [row] = (await db.hub`select auth_trust_device(${userId}, ${sha256Hex(token)}, ${new Date(Date.now() + days * 86_400_000)}, '10.0.0.1', ${UA}) as id`) as { id: number }[];
  return { id: row!.id, token, hash: sha256Hex(token) };
};
const use = async (userId: number, hash: string) =>
  ((await db.hub`select * from auth_use_device(${userId}, ${hash}, '10.0.0.2') as id`) as { id: number | null }[])[0]?.id ?? null;
const liveDevices = async (userId: number) =>
  ((await db.owner`select id from trusted_devices where user_id = ${userId} and revoked_at is null order by id`) as { id: number }[]).map((r) => r.id);

describe("trusted devices in the database", () => {
  test("the hub role never reads token hashes; everyone sees their own devices, admins all", async () => {
    const a = await trust(w.aliceNordwindShopOverview);
    const b = await trust(w.bobBergbauDiagnostics);
    const seen = (userId: number) => asUser(db.hub, userId, (tx) => tx`select id from trusted_devices order by id`) as Promise<{ id: number }[]>;
    expect((await seen(w.aliceNordwindShopOverview)).map((r) => r.id)).toEqual([a.id]);
    expect((await seen(w.admin)).map((r) => r.id)).toEqual([a.id, b.id]);
    await expect(asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select token_hash from trusted_devices`)).rejects.toThrow();
    await expect(asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`insert into trusted_devices (user_id, token_hash, expires_at) values (${w.aliceNordwindShopOverview}, 'x', now() + interval '1 day')`)).rejects.toThrow();
    // "dieses Gerät": only one's own token answers.
    const current = (userId: number, hash: string) => asUser(db.hub, userId, async (tx) => ((await tx`select account_current_device(${hash}) as id`) as { id: number | null }[])[0]!.id);
    expect(await current(w.aliceNordwindShopOverview, a.hash)).toBe(a.id);
    expect(await current(w.bobBergbauDiagnostics, a.hash)).toBeNull();
  });

  test("a removed device stays removed, and nobody renames or removes another user's device", async () => {
    const alice = w.aliceNordwindShopOverview;
    const a = await trust(alice);
    const b = await trust(w.bobBergbauDiagnostics);
    const update = (userId: number, q: (tx: any) => Promise<unknown[]>) => asUser(db.hub, userId, q) as Promise<unknown[]>;
    expect((await update(alice, (tx) => tx`update trusted_devices set name = 'Laptop' where id = ${a.id} returning id`)).length).toBe(1);
    expect((await update(alice, (tx) => tx`update trusted_devices set revoked_at = now() where id = ${a.id} returning id`)).length).toBe(1);
    expect((await update(alice, (tx) => tx`update trusted_devices set revoked_at = null where id = ${a.id} returning id`)).length).toBe(0);
    expect((await update(alice, (tx) => tx`update trusted_devices set name = 'zurück' where id = ${a.id} returning id`)).length).toBe(0);
    expect((await update(alice, (tx) => tx`update trusted_devices set revoked_at = now() where id = ${b.id} returning id`)).length).toBe(0);
    expect(await use(alice, a.hash)).toBeNull();
    expect(await use(w.bobBergbauDiagnostics, b.hash)).toBe(b.id);
  });

  test("a device opens only its own user's login, only while it is live and the account is set up", async () => {
    const bob = w.bobBergbauDiagnostics;
    const b = await trust(bob);
    expect(await use(w.aliceNordwindShopOverview, b.hash)).toBeNull();
    expect(await use(bob, b.hash)).toBe(b.id);
    const [row] = (await db.owner`select last_used_at, last_ip from trusted_devices where id = ${b.id}`) as any[];
    expect(row.last_used_at).not.toBeNull();
    expect(row.last_ip).toBe("10.0.0.2");

    const expired = await trust(bob, -1);
    expect(await use(bob, expired.hash)).toBeNull();

    await db.owner`update users set disabled_at = now() where id = ${bob}`;
    expect(await use(bob, b.hash)).toBeNull();
    await db.owner`update users set disabled_at = null where id = ${bob}`;
    expect(await use(bob, b.hash)).toBe(b.id);
  });

  test("locking and resetting an account forget all its devices", async () => {
    const carol = w.carolStageOnly;
    await trust(carol);
    await trust(carol);
    await asUser(db.hub, w.admin, (tx) => tx`select admin_set_disabled(${carol}, true)`);
    expect(await liveDevices(carol)).toEqual([]);
    await asUser(db.hub, w.admin, (tx) => tx`select admin_set_disabled(${carol}, false)`);

    const bob = w.bobBergbauDiagnostics;
    expect((await liveDevices(bob)).length).toBeGreaterThan(0);
    await asUser(db.hub, w.admin, (tx) => tx`select admin_reset_user(${bob})`);
    expect(await liveDevices(bob)).toEqual([]);
    // Bob needs a password and a code again for the login tests below.
    totp[bob] = newTotpSecret();
    await db.owner`update users set password_hash = ${await hashPassword(PASSWORD)}, totp_secret_enc = ${await encryptString(SECRET, totp[bob]!)} where id = ${bob}`;
  });

  test("admins count other users' sessions; users still see only their own", async () => {
    const alice = w.aliceNordwindShopOverview;
    await db.owner`insert into sessions (user_id, token_hash, expires_at) values (${alice}, ${newToken("vs")}, now() + interval '1 hour')`;
    const count = (viewer: number) => asUser(db.hub, viewer, async (tx) => ((await tx`select count(*)::int as n from sessions where user_id = ${alice}`) as { n: number }[])[0]!.n);
    expect(await count(w.admin)).toBe(1);
    expect(await count(alice)).toBe(1);
    expect(await count(w.bobBergbauDiagnostics)).toBe(0);
    // Reading is all: an admin cannot end someone else's session by hand.
    expect((await asUser(db.hub, w.admin, (tx) => tx`update sessions set revoked_at = now() where user_id = ${alice} returning id`)).length).toBe(0);
  });

  test("more than 20 live devices: the oldest are forgotten", async () => {
    const carol = w.carolStageOnly;
    const ids: number[] = [];
    for (let i = 0; i < 22; i++) ids.push((await trust(carol)).id);
    expect(await liveDevices(carol)).toEqual(ids.slice(2));
  });
});

// ── The login itself: password, code step with the box, and the shortcut on the next login ──

function cookieFrom(res: Response, name: string): string | null {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  const value = raw?.split(";")[0];
  return value && value !== `${name}=` ? value : null;
}

function harness(store: AuthStore) {
  const app = new Hono();
  const auth = createAuth({
    product: "Vantage",
    pitch: { headline: "Test", text: "Test", features: [] },
    cookieName: "vantage_session",
    publicUrl: "http://hub.test",
    secret: SECRET,
    store,
  });
  app.use(auth.loadUser);
  auth.mount(app);
  app.get("/hosts", auth.requireUser, (c) => c.text(`hello ${c.get("user").email}`));
  return (path: string, init: { cookie?: string | null; form?: Record<string, string> } = {}) =>
    app.request(path, {
      method: init.form ? "POST" : "GET",
      headers: {
        "user-agent": UA,
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: init.form ? new URLSearchParams(init.form) : undefined,
    });
}

const cookies = (...values: (string | null)[]) => values.filter(Boolean).join("; ");

describe("login with a trusted device", () => {
  let request: ReturnType<typeof harness>;
  let device: string;
  const email = "alice@nordwind.example";

  beforeAll(() => {
    request = harness(hubAuthStore(db.hub));
  });

  const password = (who: string, cookie: string | null = null, pw = PASSWORD) => request("/login", { cookie, form: { email: who, password: pw, next: "/hosts" } });

  test("the box on the code step remembers the browser; the next login needs only the password", async () => {
    const step1 = await password(email);
    expect(step1.headers.get("location")).toBe("/login/totp?next=%2Fhosts");
    const pre = cookieFrom(step1, "vantage_session_pre");
    expect(await (await request("/login/totp", { cookie: pre })).text()).toContain("Diesem Gerät 30 Tage vertrauen");

    const step2 = await request("/login/totp", { cookie: pre, form: { code: await totpCode(totp[w.aliceNordwindShopOverview]!), remember: "1", next: "/hosts" } });
    expect(step2.status).toBe(303);
    expect(step2.headers.get("location")).toBe("/hosts");
    device = cookieFrom(step2, "vantage_session_device")!;
    expect(device).toMatch(/^vantage_session_device=vd_/);
    expect(step2.headers.getSetCookie().find((c) => c.startsWith("vantage_session_device="))).toContain("Max-Age=2592000");

    const again = await password(email, device);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/hosts");
    expect(cookieFrom(again, "vantage_session_pre")).toBeNull();
    const session = cookieFrom(again, "vantage_session");
    expect(await (await request("/hosts", { cookie: session })).text()).toBe(`hello ${email}`);

    const audit = (await db.owner`select detail from audit_log where action = 'login.ok' and actor_id = ${w.aliceNordwindShopOverview} order by id`) as { detail: any }[];
    expect(audit.map((a) => [a.detail.method, a.detail.second_factor])).toEqual([["password", "totp"], ["password", "device"]]);
    expect(audit[0]!.detail.trusted_device).toBe(audit[1]!.detail.device_id);
    expect(audit[1]!.detail.user_agent).toBe(UA);
  });

  test("the device never replaces the password, and does nothing for another account", async () => {
    expect((await password(email, device, "falsch-falsch-falsch")).status).toBe(401);
    const bob = await password("bob@bergbau.example", device);
    expect(bob.headers.get("location")).toBe("/login/totp?next=%2Fhosts");
  });

  test("a removed device asks for the code again", async () => {
    await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`update trusted_devices set revoked_at = now() where user_id = ${w.aliceNordwindShopOverview}`);
    expect((await password(email, device)).headers.get("location")).toBe("/login/totp?next=%2Fhosts");
  });

  test("a wrong code keeps the box ticked; without the box nothing is remembered", async () => {
    const pre = cookieFrom(await password("bob@bergbau.example"), "vantage_session_pre");
    const wrong = await request("/login/totp", { cookie: pre, form: { code: "000000", remember: "1", next: "/hosts" } });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toMatch(/name="remember" value="1" checked/);
    const ok = await request("/login/totp", { cookie: pre, form: { code: await totpCode(totp[w.bobBergbauDiagnostics]!), next: "/hosts" } });
    expect(ok.status).toBe(303);
    expect(cookieFrom(ok, "vantage_session_device")).toBeNull();
  });

  test("ticking the box for another account drops the token the browser held", async () => {
    const carol = w.carolStageOnly;
    const old = await trust(w.admin);
    const pre = cookieFrom(await password("carol@agency.example", `vantage_session_device=${old.token}`), "vantage_session_pre");
    const ok = await request("/login/totp", { cookie: cookies(pre, `vantage_session_device=${old.token}`), form: { code: await totpCode(totp[carol]!), remember: "1", next: "/hosts" } });
    expect(cookieFrom(ok, "vantage_session_device")).not.toBe(`vantage_session_device=${old.token}`);
    expect(await use(w.admin, old.hash)).toBeNull();
  });

  test("a store without devices (ops) shows no box", async () => {
    const plain = harness({ ...hubAuthStore(db.hub), devices: undefined });
    const pre = cookieFrom(await plain("/login", { form: { email: "admin@systaro.de", password: PASSWORD, next: "/" } }), "vantage_session_pre");
    expect(await (await plain("/login/totp", { cookie: pre })).text()).not.toContain("vertrauen");
  });

  test("the login history lists one's own logins and failed attempts, newest first", async () => {
    const rows = (await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select * from account_login_history(10)`)) as { action: string; detail: any }[];
    expect(rows.map((r) => loginWay(r.action as any, r.detail))).toEqual([
      "Passwort falsch",
      "Passwort + gemerktes Gerät",
      "Passwort + Code, Gerät gemerkt",
    ]);
    expect(rows.every((r) => r.detail.user_agent === UA)).toBe(true);
    // Bob's history has his own wrong code, not Alice's attempts.
    const bob = (await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select * from account_login_history(10)`)) as { action: string; detail: any }[];
    expect(bob.map((r) => loginWay(r.action as any, r.detail))).toEqual(["Passwort + Code", "Code falsch"]);
  });
});

describe("login history labels", () => {
  test("old rows without method or browser read as password and code", () => {
    expect(loginWay("login.ok", {})).toBe("Passwort + Code");
    expect(loginWay("login.ok", { method: "cortex", second_factor: "cortex" })).toBe("Cortex + Code in Cortex");
    expect(loginWay("login.ok", { method: "cortex", second_factor: "device" })).toBe("Cortex + gemerktes Gerät");
    expect(loginWay("invite.accepted", {})).toBe("Zugang eingerichtet");
    expect(loginWay("login.failed", { step: "totp" })).toBe("Code falsch");
  });
});
