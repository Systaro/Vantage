import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

let db: TestDb;
let w: World;

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
});
afterAll(() => db.drop());

const ids = (rows: unknown) => (rows as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);

describe("environments are visible only through grants", () => {
  test("without a user context the hub role sees nothing (fail closed)", async () => {
    expect(await asUser(db.hub, null, (tx) => tx`select id from environments`)).toHaveLength(0);
    expect(await asUser(db.hub, null, (tx) => tx`select id from projects`)).toHaveLength(0);
    expect(await asUser(db.hub, null, (tx) => tx`select id from organisations`)).toHaveLength(0);
  });

  test("admin sees every environment", async () => {
    const rows = await asUser(db.hub, w.admin, (tx) => tx`select id from environments`);
    expect(rows).toHaveLength(5);
  });

  test("staff without grants sees nothing — employees are not privileged by default", async () => {
    expect(await asUser(db.hub, w.staffNoGrants, (tx) => tx`select id from environments`)).toHaveLength(0);
  });

  test("a whole-project grant covers its environments and nothing of the neighbour project", async () => {
    const rows = await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select id from environments`);
    expect(ids(rows)).toEqual([w.envs.shopProd, w.envs.shopStage].sort((a, b) => a - b));
  });

  test("a whole-project grant includes environments created later", async () => {
    const [{ id }] = (await db.owner`insert into environments (project_id, slug, name) values (${w.projects.shop}, 'demo', 'demo') returning id`) as { id: number }[] as [{ id: number }];
    const rows = await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select id from environments`);
    expect(ids(rows)).toContain(id);
    const carol = await asUser(db.hub, w.carolStageOnly, (tx) => tx`select id from environments`);
    expect(ids(carol)).toEqual([w.envs.shopStage]);
    await db.owner`delete from environments where id = ${id}`;
  });

  test("a named environment list grants exactly those environments", async () => {
    const rows = await asUser(db.hub, w.carolStageOnly, (tx) => tx`select id from environments`);
    expect(ids(rows)).toEqual([w.envs.shopStage]);
  });

  test("organisation and project visibility follow grants", async () => {
    const orgs = await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select id from organisations`);
    expect(ids(orgs)).toEqual([w.orgs.bergbau]);
    const projects = await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select id from projects`);
    expect(ids(projects)).toEqual([w.projects.shop]);
  });

  test("an expired grant gives no access", async () => {
    await db.owner`update grants set expires_at = now() - interval '1 minute' where user_id = ${w.bobBergbauDiagnostics}`;
    expect(await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select id from environments`)).toHaveLength(0);
    await db.owner`update grants set expires_at = null where user_id = ${w.bobBergbauDiagnostics}`;
  });

  test("a disabled user loses access at once", async () => {
    await db.owner`update users set disabled_at = now() where id = ${w.bobBergbauDiagnostics}`;
    expect(await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select id from environments`)).toHaveLength(0);
    await db.owner`update users set disabled_at = null where id = ${w.bobBergbauDiagnostics}`;
  });

  test("levels: overview = 1, diagnostics = 2, none = 0, admins everything (3)", async () => {
    const level = async (user: number, env: number) =>
      ((await db.worker`select vantage_level(${user}, ${env}) as l`) as { l: number }[])[0]!.l;
    expect(await level(w.aliceNordwindShopOverview, w.envs.shopProd)).toBe(1);
    expect(await level(w.bobBergbauDiagnostics, w.envs.mineProd)).toBe(2);
    expect(await level(w.bobBergbauDiagnostics, w.envs.shopProd)).toBe(0);
    expect(await level(w.carolStageOnly, w.envs.shopProd)).toBe(0);
    expect(await level(w.carolStageOnly, w.envs.shopStage)).toBe(2);
    expect(await level(w.admin, w.envs.crmProd)).toBe(3);
  });
});

describe("only admins change the registry and grants", () => {
  test("a customer cannot create, change or delete registry rows", async () => {
    const alice = w.aliceNordwindShopOverview;
    await expect(asUser(db.hub, alice, (tx) => tx`insert into organisations (slug, name) values ('evil', 'Evil')`)).rejects.toThrow();
    const updated = await asUser(db.hub, alice, (tx) => tx`update environments set name = 'pwned' returning id`);
    expect(updated).toHaveLength(0);
    const deleted = await asUser(db.hub, alice, (tx) => tx`delete from environments returning id`);
    expect(deleted).toHaveLength(0);
  });

  test("a customer cannot grant themselves anything", async () => {
    const alice = w.aliceNordwindShopOverview;
    await expect(
      asUser(db.hub, alice, (tx) => tx`insert into grants (user_id, project_id, level) values (${alice}, ${w.projects.mine}, 'diagnostics')`),
    ).rejects.toThrow();
    const raised = await asUser(db.hub, alice, (tx) => tx`update grants set level = 'diagnostics' returning id`);
    expect(raised).toHaveLength(0);
  });

  test("a customer cannot make themselves admin", async () => {
    const alice = w.aliceNordwindShopOverview;
    const rows = await asUser(db.hub, alice, (tx) => tx`update users set is_admin = true where id = ${alice} returning id`);
    expect(rows).toHaveLength(0);
  });

  test("customers see only their own user row and grants", async () => {
    const alice = w.aliceNordwindShopOverview;
    expect(ids(await asUser(db.hub, alice, (tx) => tx`select id from users`))).toEqual([alice]);
    const grants = (await asUser(db.hub, alice, (tx) => tx`select user_id from grants`)) as { user_id: number }[];
    expect(grants.map((g) => g.user_id)).toEqual([alice]);
  });

  test("the hub role can never read password hashes or TOTP secrets, not even as admin", async () => {
    await expect(asUser(db.hub, w.admin, (tx) => tx`select password_hash from users`)).rejects.toThrow(/permission denied/);
    await expect(asUser(db.hub, w.admin, (tx) => tx`select totp_secret_enc from users`)).rejects.toThrow(/permission denied/);
    await expect(asUser(db.hub, w.admin, (tx) => tx`select token_hash from sessions`)).rejects.toThrow(/permission denied/);
  });

  test("admin can create registry rows and grants", async () => {
    const rows = await asUser(db.hub, w.admin, (tx) => tx`insert into organisations (slug, name) values ('neu', 'Neu') returning id`);
    expect(rows).toHaveLength(1);
  });

  test("a grant's environment list cannot name another project's environment", async () => {
    const [grant] = (await db.owner`select id from grants where user_id = ${w.carolStageOnly}`) as { id: number }[];
    // Bun's query objects are lazy thenables; `expect().rejects` needs a real promise.
    const attempt = (async () =>
      db.owner`insert into grant_environments (grant_id, environment_id) values (${grant!.id}, ${w.envs.mineProd})`)();
    await expect(attempt).rejects.toThrow(/does not belong/);
  });

  test("audit rows carry the session's actor, not one the caller chooses", async () => {
    await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select audit('test.action', 'x', ${{ a: 1 }}::jsonb, '1.2.3.4')`);
    const [row] = (await db.owner`select actor_id, actor_label from audit_log where action = 'test.action'`) as { actor_id: number; actor_label: string }[];
    expect(row!.actor_id).toBe(w.aliceNordwindShopOverview);
    expect(row!.actor_label).toBe("alice@nordwind.example");
    expect(await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select id from audit_log`)).toHaveLength(0);
  });
});

describe("sessions", () => {
  test("users can end their own sessions but never revive a revoked one", async () => {
    const alice = w.aliceNordwindShopOverview;
    const [s] = (await db.owner`insert into sessions (user_id, token_hash, expires_at, revoked_at) values (${alice}, 'h-revoked', now() + interval '1 day', now()) returning id`) as { id: number }[];
    await expect(asUser(db.hub, alice, (tx) => tx`update sessions set revoked_at = null where id = ${s!.id}`)).rejects.toThrow(/row-level security/);
    const [live] = (await db.owner`insert into sessions (user_id, token_hash, expires_at) values (${alice}, 'h-live', now() + interval '1 day') returning id`) as { id: number }[];
    const ended = await asUser(db.hub, alice, (tx) => tx`update sessions set revoked_at = now() where id = ${live!.id} returning id`);
    expect(ended).toHaveLength(1);
  });
});
