import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

let db: TestDb;
let w: World;
const groups: Record<string, number> = {};

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
  for (const [name, env, service, environment] of [
    ["shopProd", w.envs.shopProd, "shop-backend", "production"],
    ["shopStage", w.envs.shopStage, "shop-backend", "staging"],
    ["mineProd", w.envs.mineProd, "mine-portal", "production"],
  ] as const) {
    await db.owner`insert into environment_sources (environment_id, kind, config) values (${env}, 'apm', ${{ service, environment }}::jsonb)`;
    await db.owner`insert into environment_sources (environment_id, kind, name, config) values (${env}, 'logs', ${name}, ${{ index: `logstash-${name.toLowerCase()}-*` }}::jsonb)`;
    const [g] = (await db.owner`
      insert into error_groups (environment_id, grouping_key, exception_type, message, first_seen_at, last_seen_at, occurrences)
      values (${env}, ${`key-${name}`}, 'java.lang.NullPointerException', 'boom', now(), now(), 5) returning id`) as { id: number }[];
    groups[name] = g!.id;
    await db.owner`insert into error_poll_state (environment_id, polled_until) values (${env}, now())`;
  }
});
afterAll(() => db.drop());

const count = (rows: unknown) => (rows as unknown[]).length;

describe("sources and error groups need diagnostics", () => {
  test("an overview user sees neither sources nor error groups of their own environment", async () => {
    const alice = w.aliceNordwindShopOverview;
    expect(count(await asUser(db.hub, alice, (tx) => tx`select id from environments where id = ${w.envs.shopProd}`))).toBe(1);
    expect(count(await asUser(db.hub, alice, (tx) => tx`select id from environment_sources`))).toBe(0);
    expect(count(await asUser(db.hub, alice, (tx) => tx`select id from error_groups`))).toBe(0);
  });

  test("diagnostics covers exactly the granted environments", async () => {
    const bob = await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select environment_id from environment_sources`);
    expect([...new Set((bob as { environment_id: number }[]).map((r) => r.environment_id))]).toEqual([w.envs.mineProd]);
    const carol = await asUser(db.hub, w.carolStageOnly, (tx) => tx`select environment_id from error_groups`);
    expect((carol as { environment_id: number }[]).map((r) => r.environment_id)).toEqual([w.envs.shopStage]);
  });

  test("without a user context nothing is visible (fail closed)", async () => {
    expect(count(await asUser(db.hub, null, (tx) => tx`select id from environment_sources`))).toBe(0);
    expect(count(await asUser(db.hub, null, (tx) => tx`select id from error_groups`))).toBe(0);
  });

  test("only admins write sources", async () => {
    const insert = (user: number) =>
      asUser(db.hub, user, (tx) => tx`insert into environment_sources (environment_id, kind, name, config) values (${w.envs.mineTest}, 'logs', 'x', ${{ index: "logstash-x-*" }}::jsonb)`);
    await expect(insert(w.bobBergbauDiagnostics)).rejects.toThrow(/row-level security/);
    const updated = await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`update environment_sources set config = ${{ index: "logstash-*" }}::jsonb where environment_id = ${w.envs.mineProd} returning id`);
    expect(count(updated)).toBe(0);
    await insert(w.admin);
    expect(count(await asUser(db.hub, w.admin, (tx) => tx`delete from environment_sources where environment_id = ${w.envs.mineTest} returning id`))).toBe(1);
  });

  test("poll state is admin-only, and only admins can reset it", async () => {
    expect(count(await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select environment_id from error_poll_state`))).toBe(0);
    expect(count(await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`delete from error_poll_state where environment_id = ${w.envs.mineProd} returning environment_id`))).toBe(0);
    expect(count(await asUser(db.hub, w.admin, (tx) => tx`select environment_id from error_poll_state`))).toBe(3);
  });
});

describe("triage", () => {
  const triage = (user: number, groupId: number, envId: number, status: string) =>
    asUser(db.hub, user, (tx) => tx`update error_groups set status = ${status} where id = ${groupId} and environment_id = ${envId} returning id`);

  test("a diagnostics user cannot triage another environment's group", async () => {
    // carol has diagnostics on shop stage only
    expect(count(await triage(w.carolStageOnly, groups.shopProd!, w.envs.shopProd, "resolved"))).toBe(0);
    // the route's environment_id condition: a group id from elsewhere under one's own environment
    expect(count(await triage(w.bobBergbauDiagnostics, groups.shopProd!, w.envs.mineProd, "resolved"))).toBe(0);
    // an overview user cannot triage even on their own environment
    expect(count(await triage(w.aliceNordwindShopOverview, groups.shopProd!, w.envs.shopProd, "resolved"))).toBe(0);
    const [row] = (await db.owner`select status from error_groups where id = ${groups.shopProd!}`) as { status: string }[];
    expect(row!.status).toBe("open");
  });

  test("on their own environment it works, and the actor is stamped from the session", async () => {
    expect(count(await triage(w.carolStageOnly, groups.shopStage!, w.envs.shopStage, "ignored"))).toBe(1);
    const [row] = (await db.owner`select status, status_changed_by, status_changed_at from error_groups where id = ${groups.shopStage!}`) as any[];
    expect(row.status).toBe("ignored");
    expect(row.status_changed_by).toBe(w.carolStageOnly);
    expect(row.status_changed_at).not.toBeNull();
  });

  test("the hub role may only change the status columns", async () => {
    await expect((async () => asUser(db.hub, w.carolStageOnly, (tx) => tx`update error_groups set occurrences = 0 where id = ${groups.shopStage!}`))()).rejects.toThrow(/permission denied/);
    await expect((async () => asUser(db.hub, w.carolStageOnly, (tx) => tx`update error_groups set status_changed_by = ${w.admin} where id = ${groups.shopStage!}`))()).resolves.toBeDefined();
    const [row] = (await db.owner`select status_changed_by from error_groups where id = ${groups.shopStage!}`) as any[];
    // the trigger overwrites whatever the caller tried to put there
    expect(row.status_changed_by).toBe(w.carolStageOnly);
  });

  test("invalid statuses are rejected by the table", async () => {
    await expect((async () => triage(w.carolStageOnly, groups.shopStage!, w.envs.shopStage, "deleted"))()).rejects.toThrow(/check constraint/);
  });
});
