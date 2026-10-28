import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { can, permissionFor } from "../src/ops/roles";
import { totpCode } from "../src/shared/totp";
import { createOpsHarness, createUser, flashOf, type OpsHarness } from "./helpers/ops";

let h: OpsHarness;

beforeAll(async () => {
  h = await createOpsHarness();
});
afterAll(() => h.close());

function cookieFrom(res: Response, name: string): string | null {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  const value = raw?.split(";")[0];
  return value && value !== `${name}=` ? value : null;
}

describe("role table", () => {
  test("maps requests to permissions, failing closed for unknown writes", () => {
    expect(permissionFor("GET", "/")).toBe("read");
    expect(permissionFor("GET", "/users")).toBe("admin");
    expect(permissionFor("GET", "/users/3")).toBe("admin");
    expect(permissionFor("GET", "/audit")).toBe("admin");
    expect(permissionFor("GET", "/templates/new")).toBe("admin");
    expect(permissionFor("GET", "/hosts/new")).toBe("hosts");
    expect(permissionFor("POST", "/templates/4/run")).toBe("run");
    expect(permissionFor("POST", "/schedules/4/trigger")).toBe("run");
    expect(permissionFor("POST", "/runs/4/cancel")).toBe("run");
    expect(permissionFor("POST", "/hosts/4/token")).toBe("hosts");
    expect(permissionFor("POST", "/account/password")).toBe("read");
    expect(permissionFor("POST", "/templates/4")).toBe("admin");
    expect(permissionFor("POST", "/schedules")).toBe("admin");
    expect(permissionFor("POST", "/something/new")).toBe("admin");
    expect(permissionFor("DELETE", "/hosts/1")).toBe("admin");
    // Lookalike paths do not match the narrower rules.
    expect(permissionFor("POST", "/templates/4/run/x")).toBe("admin");
  });

  test("roles are ordered viewer < operator < admin, unknown roles get nothing", () => {
    expect(can({ role: "viewer" }, "read")).toBe(true);
    expect(can({ role: "viewer" }, "run")).toBe(false);
    expect(can({ role: "operator" }, "run")).toBe(true);
    expect(can({ role: "operator" }, "hosts")).toBe(true);
    expect(can({ role: "operator" }, "admin")).toBe(false);
    expect(can({ role: "admin" }, "admin")).toBe(true);
    expect(can({ role: "root" }, "read")).toBe(false);
    expect(can(null, "read")).toBe(false);
  });
});

describe("role enforcement on routes", () => {
  test("pages behind the login redirect anonymous users, the API answers 401", async () => {
    const page = await h.request("/hosts");
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login?next=%2Fhosts");
    expect((await h.request("/api/ingest/v1/report", { method: "POST", body: "{}" })).status).toBe(401);
    // The agent script is public: hosts download it while installing.
    const agent = await h.request("/agent/vantage-agent.sh");
    expect(agent.status).toBe(200);
    expect(await agent.text()).toStartWith("#!/bin/sh");
  });

  test("viewer reads but cannot run, manage hosts or see users", async () => {
    const v = h.users.viewer.cookie;
    for (const path of ["/", "/hosts", "/templates", "/runs", "/schedules", "/events", "/account"]) {
      expect((await h.request(path, { cookie: v })).status).toBe(200);
    }
    expect((await h.request("/users", { cookie: v })).status).toBe(403);
    expect((await h.request("/audit", { cookie: v })).status).toBe(403);
    expect((await h.request("/hosts/new", { cookie: v })).status).toBe(403);
    expect((await h.request("/templates/1/run", { cookie: v, method: "POST" })).status).toBe(403);
    expect((await h.request("/schedules/1/trigger", { cookie: v, method: "POST" })).status).toBe(403);
    expect((await h.request("/hosts", { cookie: v, form: { name: "x", mode: "agent", interval_seconds: "300" } })).status).toBe(403);
  });

  test("operator runs and manages hosts but cannot manage users, templates or schedules", async () => {
    const o = h.users.operator.cookie;
    expect((await h.request("/users", { cookie: o })).status).toBe(403);
    expect((await h.request("/users", { cookie: o, form: { name: "Eve", email: "eve@systaro.de", role: "admin" } })).status).toBe(403);
    expect((await h.request(`/users/${h.users.operator.id}/update`, { cookie: o, form: { name: "op", role: "admin" } })).status).toBe(403);
    expect((await h.request("/templates", { cookie: o, form: { name: "t" } })).status).toBe(403);
    expect((await h.request("/schedules", { cookie: o, form: { name: "s" } })).status).toBe(403);
    expect((await h.request("/events/1/retry", { cookie: o, method: "POST" })).status).toBe(403);
    const host = await h.request("/hosts", { cookie: o, form: { name: "web1", mode: "agent", interval_seconds: "300", enabled: "1" } });
    expect(host.status).toBe(200);
    expect(await host.text()).toContain("--install --url http://ops.test --token vha_");
    // Running a missing template gets past the role check and then 404s.
    expect((await h.request("/templates/999/run", { cookie: o, method: "POST" })).status).toBe(404);
  });

  test("the role is read per request: a demoted admin loses access immediately", async () => {
    const u = await createUser(h.sql, "temp-admin@systaro.de", "admin");
    expect((await h.request("/users", { cookie: u.cookie })).status).toBe(200);
    await h.sql`update users set role = 'viewer' where id = ${u.id}`;
    expect((await h.request("/users", { cookie: u.cookie })).status).toBe(403);
  });

  test("form posts need the ops origin (CSRF)", async () => {
    const res = await h.request(`/account/sessions/1/revoke`, { cookie: h.users.admin.cookie, form: {}, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("accounts: invite, login with TOTP, reset, disable", () => {
  let inviteUrl = "";
  let secret = "";
  let session = "";
  const email = "neu@systaro.de";
  const password = "ein-sehr-langes-passwort";

  test("an admin creates a user; only hashes of the invite are stored", async () => {
    const res = await h.request("/users", { cookie: h.users.admin.cookie, form: { name: "Neu", email, role: "operator" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    inviteUrl = html.match(/http:\/\/ops\.test(\/invite\/voi_[A-Za-z0-9_-]{43})/)![1]!;
    const token = inviteUrl.split("/").pop()!;
    const rows = (await h.sql`select token_hash from invites i join users u on u.id = i.user_id where u.email = ${email}`) as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toContain(token);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const audit = (await h.sql`select action, target from audit_log where action = 'user.created'`) as any[];
    expect(audit.at(-1)).toEqual({ action: "user.created", target: email });
  });

  test("accepting the invite needs a valid TOTP code and stores the secret encrypted", async () => {
    const page = await h.request(inviteUrl);
    expect(page.status).toBe(200);
    secret = (await page.text()).match(/<div class="secret">([A-Z2-7 ]+)<\/div>/)![1]!.replace(/ /g, "");
    const wrong = await h.request(inviteUrl, { form: { password, password_repeat: password, code: "000000" } });
    expect(wrong.status).toBe(400);
    const ok = await h.request(inviteUrl, { form: { password, password_repeat: password, code: await totpCode(secret) } });
    expect(ok.status).toBe(303);
    session = cookieFrom(ok, "vantage_ops_session")!;
    expect(session).toBeTruthy();
    expect((await h.request("/", { cookie: session })).status).toBe(200);
    const [row] = (await h.sql`select totp_secret_enc, password_hash from users where email = ${email}`) as any[];
    expect(row.totp_secret_enc).toStartWith("v1.");
    expect(row.totp_secret_enc).not.toContain(secret);
    expect(row.password_hash).toStartWith("$argon2id$");
    // The invite is single use.
    expect((await h.request(inviteUrl)).status).toBe(404);
  });

  test("login is password, then TOTP", async () => {
    const step1 = await h.request("/login", { form: { email, password, next: "/hosts" } });
    expect(step1.status).toBe(303);
    expect(step1.headers.get("location")).toBe("/login/totp?next=%2Fhosts");
    const pre = cookieFrom(step1, "vantage_ops_session_pre")!;
    const bad = await h.request("/login/totp", { cookie: pre, form: { code: "123456", next: "/hosts" } });
    expect(bad.status).toBe(401);
    const step2 = await h.request("/login/totp", { cookie: pre, form: { code: await totpCode(secret), next: "/hosts" } });
    expect(step2.status).toBe(303);
    expect(step2.headers.get("location")).toBe("/hosts");
    expect(cookieFrom(step2, "vantage_ops_session")).toBeTruthy();
  });

  test("five wrong passwords lock the e-mail for 15 minutes", async () => {
    await h.sql`delete from login_attempts`;
    for (let i = 0; i < 5; i++) expect((await h.request("/login", { form: { email, password: "falsch-falsch-falsch" } })).status).toBe(401);
    expect((await h.request("/login", { form: { email, password } })).status).toBe(429);
    await h.sql`delete from login_attempts`;
  });

  test("an admin cannot demote or disable themselves", async () => {
    const a = h.users.admin;
    const demote = await h.request(`/users/${a.id}/update`, { cookie: a.cookie, form: { name: "admin", role: "viewer" } });
    expect(flashOf(demote)?.kind).toBe("bad");
    const disable = await h.request(`/users/${a.id}/disable`, { cookie: a.cookie, form: { disabled: "1" } });
    expect(flashOf(disable)?.kind).toBe("bad");
    const [row] = (await h.sql`select role, disabled_at from users where id = ${a.id}`) as any[];
    expect(row).toEqual({ role: "admin", disabled_at: null });
  });

  test("an admin reset ends the user's sessions and issues a new invite", async () => {
    const [u] = (await h.sql`select id from users where email = ${email}`) as { id: number }[];
    const res = await h.request(`/users/${u!.id}/reset`, { cookie: h.users.admin.cookie, method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/\/invite\/voi_/);
    expect((await h.request("/", { cookie: session })).status).toBe(303);
    expect((await h.request("/login", { form: { email, password } })).status).toBe(401);
    expect((await h.request(inviteUrl)).status).toBe(404);
  });

  test("disabling a user ends their sessions", async () => {
    const o = h.users.operator;
    expect((await h.request("/", { cookie: o.cookie })).status).toBe(200);
    const res = await h.request(`/users/${o.id}/disable`, { cookie: h.users.admin.cookie, form: { disabled: "1" } });
    expect(flashOf(res)?.kind).toBe("ok");
    expect((await h.request("/", { cookie: o.cookie })).status).toBe(303);
    const actions = ((await h.sql`select action from audit_log order by id`) as { action: string }[]).map((r) => r.action);
    expect(actions).toContain("user.reset");
    expect(actions).toContain("user.disabled");
    expect(actions).toContain("login.ok");
    expect(actions).toContain("login.failed");
  });
});
