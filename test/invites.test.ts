import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderInviteMail } from "../src/hub/modules/alerts/mail";
import { buildWorld, type World } from "./fixtures";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";

describe("new invites", () => {
  let db: TestDb;
  let w: World;
  const issue = (admin: number, user: number, hash: string) =>
    asUser(db.hub, admin, (tx) => tx`select admin_issue_invite(${user}, ${hash}, ${new Date(Date.now() + 3600_000)})`);
  const openInvites = async (user: number) =>
    ((await db.owner`select token_hash from invites where user_id = ${user} and used_at is null order by id`) as { token_hash: string }[]).map((r) => r.token_hash);

  beforeAll(async () => {
    db = await createHubTestDb();
    w = await buildWorld(db.owner);
  });
  afterAll(() => db.drop());

  test("a new invite replaces every open one: only the newest mail works", async () => {
    await issue(w.admin, w.carolStageOnly, "h1");
    await issue(w.admin, w.carolStageOnly, "h2");
    expect(await openInvites(w.carolStageOnly)).toEqual(["h2"]);
    const [byAdmin] = (await db.owner`select created_by from invites where token_hash = 'h2'`) as { created_by: number }[];
    expect(byAdmin!.created_by).toBe(w.admin);
  });

  test("only admins issue invites and see who is set up", async () => {
    await expect(issue(w.staffNoGrants, w.carolStageOnly, "h3")).rejects.toThrow();
    await expect(asUser(db.hub, w.staffNoGrants, (tx) => tx`select * from admin_user_access()`)).rejects.toThrow();
    await db.owner`update users set password_hash = 'x', totp_secret_enc = 'y' where id = ${w.aliceNordwindShopOverview}`;
    const access = (await asUser(db.hub, w.admin, (tx) => tx`select user_id, set_up from admin_user_access()`)) as { user_id: number; set_up: boolean }[];
    expect(access.find((a) => a.user_id === w.aliceNordwindShopOverview)!.set_up).toBe(true);
    expect(access.find((a) => a.user_id === w.carolStageOnly)!.set_up).toBe(false);
  });

  test("setting up an invited account subscribes it to everything from Warnung on, but only the first time", async () => {
    const accept = async (hash: string) => {
      await issue(w.admin, w.bobBergbauDiagnostics, hash);
      await db.owner`update invites set pending_totp_enc = 'totp' where token_hash = ${hash}`;
      const [row] = (await db.hub`select auth_accept_invite(${hash}, 'pw') as id`) as { id: number }[];
      expect(row!.id).toBe(w.bobBergbauDiagnostics);
    };
    const subs = () => db.owner`select scope_kind, scope_id, min_severity from subscriptions where user_id = ${w.bobBergbauDiagnostics}`;
    await accept("first");
    expect(await subs()).toEqual([{ scope_kind: "all", scope_id: null, min_severity: "warning" }]);

    // Logged in, unsubscribed, then reset by an admin: the new setup keeps the choice.
    await db.owner`update users set last_login_at = now() where id = ${w.bobBergbauDiagnostics}`;
    await db.owner`delete from subscriptions where user_id = ${w.bobBergbauDiagnostics}`;
    await asUser(db.hub, w.admin, (tx) => tx`select admin_reset_user(${w.bobBergbauDiagnostics})`);
    await accept("second");
    expect(await subs()).toEqual([]);
  });
});

describe("correcting the e-mail address of an unused account", () => {
  let db: TestDb;
  let w: World;
  const correct = (admin: number, user: number, email: string) =>
    asUser(db.hub, admin, (tx) => tx`select admin_correct_email(${user}, ${email})`);
  const fresh = async (email: string) =>
    ((await db.owner`insert into users (email, name, kind) values (${email}, 'Neu', 'customer') returning id`) as { id: number }[])[0]!.id;
  const emailOf = async (user: number) => ((await db.owner`select email from users where id = ${user}`) as { email: string }[])[0]!.email;

  beforeAll(async () => {
    db = await createHubTestDb();
    w = await buildWorld(db.owner);
  });
  afterAll(() => db.drop());

  test("an admin corrects a typo, and the invite sent to the wrong address stops working", async () => {
    const user = await fresh("max@exampel.de");
    await asUser(db.hub, w.admin, (tx) => tx`select admin_issue_invite(${user}, 'typo', ${new Date(Date.now() + 3600_000)})`);
    await correct(w.admin, user, "Max@Example.de");
    expect(await emailOf(user)).toBe("max@example.de");
    expect(await db.owner`select 1 from invites where user_id = ${user} and used_at is null`).toHaveLength(0);
  });

  test("the address is fixed once the account was used", async () => {
    const loggedIn = await fresh("a@example.de");
    await db.owner`update users set last_login_at = now() where id = ${loggedIn}`;
    await expect(correct(w.admin, loggedIn, "b@example.de")).rejects.toThrow(/already in use/);
    const setUp = await fresh("c@example.de");
    await db.owner`update users set password_hash = 'x' where id = ${setUp}`;
    await expect(correct(w.admin, setUp, "d@example.de")).rejects.toThrow(/already in use/);
    expect(await emailOf(loggedIn)).toBe("a@example.de");
    expect(await emailOf(setUp)).toBe("c@example.de");
  });

  test("only admins correct, never onto another account's address, and never by a plain update", async () => {
    const user = await fresh("e@example.de");
    await expect(correct(w.staffNoGrants, user, "f@example.de")).rejects.toThrow(/admin only/);
    await expect(correct(w.admin, user, await emailOf(w.carolStageOnly))).rejects.toThrow(/duplicate key/);
    await expect(asUser(db.hub, w.admin, (tx) => tx`update users set email = 'g@example.de' where id = ${user}`)).rejects.toThrow(/permission denied/);
    expect(await emailOf(user)).toBe("e@example.de");
  });
});

describe("the invite mail", () => {
  test("names the person, the inviter, the login address and the link, in HTML and as text", async () => {
    const mail = await renderInviteMail({
      name: "Max Beispiel", email: "max@example.de", link: "https://vantage.example/invite/vi_abc",
      expiresAt: new Date(Date.UTC(2026, 9, 19, 9, 0)), invitedBy: "Erika", publicUrl: "https://vantage.example",
    });
    expect(mail.subject).toBe("Ihr Zugang zu Vantage");
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain("Max Beispiel");
      expect(part).toContain("Erika");
      expect(part).toContain("max@example.de");
      expect(part).toContain("https://vantage.example/invite/vi_abc");
      expect(part).not.toMatch(/—|–|…/);
    }
    expect(mail.html).toContain('href="https://vantage.example/invite/vi_abc"');
    expect(mail.html).toContain("19.10.2026");
  });

  test("text from the account is escaped in the HTML", async () => {
    const mail = await renderInviteMail({ name: "<b>Eve</b>", email: "e@x.de", link: "https://v/i", expiresAt: new Date(), invitedBy: "A & B", publicUrl: "https://v" });
    expect(mail.html).not.toContain("<b>Eve</b>");
    expect(mail.html).toContain("&lt;b&gt;Eve&lt;/b&gt;");
  });
});
