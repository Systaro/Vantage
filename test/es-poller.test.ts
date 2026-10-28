/**
 * The error poller against the dev Elasticsearch (docker/compose.dev.yml, :5461) with its own
 * throwaway index, and a throwaway database. Time is injected, so the windows are exact.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { configuredIndex, EsError, HttpEsClient, type EsClient } from "../src/hub/modules/es/client";
import { pollErrors, type PollDeps } from "../src/hub/modules/errors/poller";
import { APM_ERROR_MAPPINGS, DEV_ES, es, recreateIndex } from "../scripts/es-dev";
import { createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const INDEX = `vantage-test-apm-error-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const T0 = Date.now();
const real = new HttpEsClient({ label: "Dev-ES", connection: { url: DEV_ES }, timeoutMs: 10_000 });

let db: TestDb;
let w: World;

async function errorDoc(service: string, environment: string, key: string, t: number, type = "java.lang.IllegalStateException", message = `boom ${key}`) {
  await es("POST", `/${INDEX}/_doc?refresh=true`, {
    "@timestamp": new Date(t).toISOString(),
    processor: { event: "error" },
    service: { name: service, environment },
    error: { grouping_key: key, culprit: `de.example.Thing in ${key}`, exception: [{ type, message, handled: false, stacktrace: [{ function: "run", filename: "Thing.java", line: { number: 1 }, library_frame: false }] }] },
    trace: { id: "0af7651916cd43dd8448eb211c80319c" },
  });
}

const poll = (now: number, es: EsClient = real) => {
  const deps: Partial<PollDeps> = { es, index: configuredIndex(INDEX), now: () => now, lagMs: 0 };
  return pollErrors(db.worker, () => {}, deps);
};

const group = async (env: number, key: string) =>
  ((await db.owner`select id, status, occurrences::int as occurrences, first_seen_at, last_seen_at, exception_type, message from error_groups where environment_id = ${env} and grouping_key = ${key}`) as any[])[0];
const events = async () => (await db.owner`select environment_id, subject_key, state, severity, title, link from events where source = 'errors' order by id`) as any[];
const pollState = async (env: number) => ((await db.owner`select polled_until, last_error from error_poll_state where environment_id = ${env}`) as any[])[0];

/** Fails every request for one service, passes the rest through. */
const failingFor = (service: string): EsClient => ({
  label: "flaky",
  catIndices: (i) => real.catIndices(i),
  search: async (index, body) => {
    if (JSON.stringify(body).includes(`"service.name":"${service}"`)) throw new EsError("APM-Cluster: nicht erreichbar (test)");
    return real.search(index, body);
  },
});

beforeAll(async () => {
  await recreateIndex(INDEX, APM_ERROR_MAPPINGS);
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
  await db.owner`insert into environment_sources (environment_id, kind, config) values (${w.envs.shopProd}, 'apm', ${{ service: "shop-backend", environment: "production" }}::jsonb)`;
  await db.owner`insert into environment_sources (environment_id, kind, config) values (${w.envs.mineProd}, 'apm', ${{ service: "mine-portal", environment: "production" }}::jsonb)`;
});
afterAll(async () => {
  await db.drop();
  await es("DELETE", `/${INDEX}`);
});

describe("error polling", () => {
  test("the first poll is a silent 24 h backfill, scoped to service and environment", async () => {
    await errorDoc("shop-backend", "production", "a", T0 - 2 * 3600_000);
    await errorDoc("shop-backend", "production", "a", T0 - 3600_000);
    await errorDoc("shop-backend", "production", "old", T0 - 30 * 3600_000);
    await errorDoc("shop-backend", "staging", "stage-only", T0 - 3600_000);
    await errorDoc("mine-portal", "production", "m", T0 - 3600_000);
    await poll(T0);

    const a = await group(w.envs.shopProd, "a");
    expect(a.occurrences).toBe(2);
    expect(a.status).toBe("open");
    expect(a.exception_type).toBe("java.lang.IllegalStateException");
    expect(new Date(a.first_seen_at).getTime()).toBe(T0 - 2 * 3600_000);
    expect(new Date(a.last_seen_at).getTime()).toBe(T0 - 3600_000);
    // older than the backfill window, another environment of the same service, another service
    expect(await group(w.envs.shopProd, "old")).toBeUndefined();
    expect(await group(w.envs.shopProd, "stage-only")).toBeUndefined();
    expect(await group(w.envs.shopProd, "m")).toBeUndefined();
    expect((await group(w.envs.mineProd, "m")).occurrences).toBe(1);
    expect(await events()).toEqual([]);
    expect(new Date((await pollState(w.envs.shopProd)).polled_until).getTime()).toBe(T0);
  });

  test("a new group after the backfill emits exactly one notice", async () => {
    await errorDoc("shop-backend", "production", "b", T0 + 10_000);
    await poll(T0 + 60_000);
    const b = await group(w.envs.shopProd, "b");
    expect(b.occurrences).toBe(1);
    expect(await events()).toEqual([
      {
        environment_id: w.envs.shopProd,
        subject_key: `error:${w.envs.shopProd}:b`,
        state: "notice",
        severity: "warning",
        title: "Neuer Fehler: java.lang.IllegalStateException: boom b",
        link: `/env/${w.envs.shopProd}/errors/${b.id}`,
      },
    ]);
    // nothing new in the next window → nothing happens, and nothing is counted twice
    await poll(T0 + 65_000);
    expect((await group(w.envs.shopProd, "b")).occurrences).toBe(1);
    expect(await events()).toHaveLength(1);
  });

  test("a resolved group seen again reopens and emits one notice", async () => {
    await db.owner`update error_groups set status = 'resolved' where environment_id = ${w.envs.shopProd} and grouping_key = 'a'`;
    await errorDoc("shop-backend", "production", "a", T0 + 70_000);
    await poll(T0 + 120_000);
    const a = await group(w.envs.shopProd, "a");
    expect(a.status).toBe("open");
    expect(a.occurrences).toBe(3);
    const all = await events();
    expect(all).toHaveLength(2);
    expect(all[1].title).toBe("Fehler wieder aufgetreten: java.lang.IllegalStateException: boom a");
    expect(all[1].subject_key).toBe(`error:${w.envs.shopProd}:a`);
  });

  test("an ignored group keeps counting but never emits", async () => {
    await db.owner`update error_groups set status = 'ignored' where environment_id = ${w.envs.shopProd} and grouping_key = 'b'`;
    await errorDoc("shop-backend", "production", "b", T0 + 130_000);
    await errorDoc("shop-backend", "production", "b", T0 + 140_000);
    await poll(T0 + 180_000);
    const b = await group(w.envs.shopProd, "b");
    expect(b.status).toBe("ignored");
    expect(b.occurrences).toBe(3);
    expect(await events()).toHaveLength(2);
  });

  test("an ES failure is recorded per environment and the others go on", async () => {
    const before = await pollState(w.envs.mineProd);
    await errorDoc("shop-backend", "production", "c", T0 + 200_000);
    await poll(T0 + 240_000, failingFor("mine-portal"));
    const mine = await pollState(w.envs.mineProd);
    expect(mine.last_error).toContain("nicht erreichbar");
    expect(new Date(mine.polled_until).getTime()).toBe(new Date(before.polled_until).getTime());
    expect(new Date((await pollState(w.envs.shopProd)).polled_until).getTime()).toBe(T0 + 240_000);
    expect(await group(w.envs.shopProd, "c")).toBeDefined();
    // the next good poll catches up and clears the error
    await errorDoc("mine-portal", "production", "m", T0 + 230_000);
    await poll(T0 + 300_000);
    const recovered = await pollState(w.envs.mineProd);
    expect(recovered.last_error).toBeNull();
    expect((await group(w.envs.mineProd, "m")).occurrences).toBe(2);
  });

  test("a failed first poll still ends in a silent backfill", async () => {
    await db.owner`insert into environment_sources (environment_id, kind, config) values (${w.envs.mineTest}, 'apm', ${{ service: "mine-portal", environment: "test" }}::jsonb)`;
    await errorDoc("mine-portal", "test", "t", T0 + 250_000);
    const eventsBefore = (await events()).length;
    await poll(T0 + 310_000, failingFor("mine-portal"));
    const failed = await pollState(w.envs.mineTest);
    expect(failed.polled_until).toBeNull();
    expect(failed.last_error).toContain("nicht erreichbar");
    await poll(T0 + 320_000);
    expect((await group(w.envs.mineTest, "t")).occurrences).toBe(1);
    expect(await events()).toHaveLength(eventsBefore);
  });

  test("an invalid source row is reported, not polled", async () => {
    await db.owner`update environment_sources set config = ${{ service: "" }}::jsonb where environment_id = ${w.envs.mineTest} and kind = 'apm'`;
    await poll(T0 + 330_000);
    expect((await pollState(w.envs.mineTest)).last_error).toContain("ungültig");
  });
});
