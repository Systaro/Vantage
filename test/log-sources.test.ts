/**
 * Several logs sources per environment (#69812): one request over all of them that keeps each to its
 * own index and filter, the source of every hit, names unique per environment, and an error poll that
 * stands per source.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EsError, type EsClient } from "../src/hub/modules/es/client";
import { parseRange } from "../src/hub/modules/es/range";
import { pollLogErrors } from "../src/hub/modules/errors/log-poller";
import { buildLogEntryLookup, buildLogsSearch, buildLogsSummary, buildSourceCounts, parseLogFilters, sourceOf, toLogRow, toSourceCounts } from "../src/hub/modules/logs/query";
import { parseNamedLogsSource } from "../src/hub/modules/sources/config";
import { defaultSourceName, sourceNameProblem } from "../src/hub/modules/sources/pattern";
import { createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const now = Date.UTC(2026, 9, 23, 10, 0, 0);
const range = parseRange((k) => ({ range: "1h" })[k], { now }).range;
/** Webshop production: the main application on a shared host filter, and one of its services. */
const main = { id: 6, name: "shop-production", index: "logstash-shop-production-*", filterField: "host.keyword", filterValue: "203-0-113-26.rdns.example.net" };
const translation = { id: 9, name: "translation", index: "logstash-shop-translation-service-production-*" };
const hostile = parseLogFilters(["ERROR"], '") OR _index:secret-* /../_all');
const filters = (body: any) => body.query.bool.filter as any[];

describe("searching several sources at once", () => {
  test("one request: every pattern in the path, every source kept to its own index and filter", () => {
    const { index, body } = buildLogsSearch([main, translation], { range, filters: hostile });
    expect(String(index)).toBe("logstash-shop-production-*,logstash-shop-translation-service-production-*");
    expect(filters(body)[0]).toEqual({
      bool: {
        minimum_should_match: 1,
        should: [
          { bool: { _name: "source-6", filter: [{ wildcard: { _index: { value: "logstash-shop-production-*" } } }, { term: { "host.keyword": "203-0-113-26.rdns.example.net" } }] } },
          { bool: { _name: "source-9", filter: [{ wildcard: { _index: { value: "logstash-shop-translation-service-production-*" } } }] } },
        ],
      },
    });
    // The user's text still appears exactly once, inside simple_query_string.
    expect(JSON.stringify(body).split("secret-*").length - 1).toBe(1);
  });

  test("one source alone is searched as before: its pattern and its filter, no clause per index", () => {
    const { index, body } = buildLogsSearch([main], { range, filters: hostile });
    expect(String(index)).toBe("logstash-shop-production-*");
    expect(filters(body)[0]).toEqual({ term: { "host.keyword": "203-0-113-26.rdns.example.net" } });
  });

  test("two sources on one index family share the path once, their filters stay apart", () => {
    const a = { id: 1, name: "a", index: "logstash-shared-*", filterField: "appname.keyword", filterValue: "a" };
    const b = { id: 2, name: "b", index: "logstash-shared-*", filterField: "appname.keyword", filterValue: "b" };
    const { index, body } = buildLogsSearch([a, b], { range, filters: hostile });
    expect(String(index)).toBe("logstash-shared-*");
    expect(filters(body)[0].bool.should.map((c: any) => c.bool.filter[1])).toEqual([{ term: { "appname.keyword": "a" } }, { term: { "appname.keyword": "b" } }]);
  });

  test("a tampered source among several stops the whole request", () => {
    expect(() => buildLogsSearch([main, { id: 3, name: "x", index: "logstash-r2-*,secret-*" }], { range, filters: hostile })).toThrow(EsError);
    expect(() => buildLogsSearch([], { range, filters: hostile })).toThrow(EsError);
  });

  test("every hit names the source it matched; with one source searched it is that one", () => {
    const hit = (id: string, matched?: string[]) => ({ _index: "x", _id: id, _source: { "@timestamp": "2026-10-23T09:00:00Z" }, matched_queries: matched });
    const rows = [hit("a", ["source-9"]), hit("b", ["source-6"]), hit("c")].map(toLogRow);
    expect(rows.map((r) => r.sourceId)).toEqual([9, 6, null]);
    expect(rows.map((r) => sourceOf(r, [main, translation])?.name)).toEqual(["translation", "shop-production", undefined]);
    expect(sourceOf(rows[2]!, [main])?.name).toBe("shop-production");
  });

  test("the numbers on the source picker: one bucket per source, under the same view", () => {
    const { index, body } = buildSourceCounts([main, translation], { range, filters: hostile });
    expect(String(index)).toBe("logstash-shop-production-*,logstash-shop-translation-service-production-*");
    expect(body.size).toBe(0);
    expect(body.track_total_hits).toBe(true);
    expect(filters(body)).toContainEqual({ terms: { "level.keyword": ["ERROR"] } });
    const buckets = (body.aggs as any).sources.filters.filters;
    expect(Object.keys(buckets)).toEqual(["6", "9"]);
    expect(buckets["6"].bool.filter[1]).toEqual({ term: { "host.keyword": "203-0-113-26.rdns.example.net" } });
    // "Alle Quellen" is the union from the hit total, not the sum: overlapping sources count an entry once.
    const res = { hits: { total: { value: 12600, relation: "eq" }, hits: [] }, aggregations: { sources: { buckets: { "6": { doc_count: 12579 }, "9": { doc_count: 122 } } } } };
    expect(toSourceCounts(res as any)).toEqual({ total: 12600, bySource: new Map([[6, 12579], [9, 122]]) });
  });

  test("an entry and the overview are read from all sources, each in its own scope", () => {
    const { index, body } = buildLogEntryLookup([main, translation], "aB3_x-9");
    expect(String(index)).toBe("logstash-shop-production-*,logstash-shop-translation-service-production-*");
    expect(filters(body)[0]).toEqual({ ids: { values: ["aB3_x-9"] } });
    expect(filters(body)[1].bool.should).toHaveLength(2);
    expect(filters(buildLogsSummary([main, translation], now).body)[0].bool.should).toHaveLength(2);
  });
});

describe("names", () => {
  test("a name is required, at most 40 characters, no control characters; left empty it comes from the pattern", () => {
    expect(sourceNameProblem("")).toMatch(/fehlt/);
    expect(sourceNameProblem("x".repeat(41))).toMatch(/40/);
    expect(sourceNameProblem("a\nb")).toMatch(/Steuerzeichen/);
    expect(sourceNameProblem("search-api")).toBeNull();
    expect(defaultSourceName("logstash-shop-search-api-production-*", ["logstash-"])).toBe("shop-search-api-production");
    expect(defaultSourceName("logstash-nordwind_prod*", ["logstash-"])).toBe("nordwind_prod");
  });

  test("a row without a valid name or config is not used", () => {
    expect(parseNamedLogsSource({ id: 1, name: "a", config: { index: "logstash-ab-*" } }, ["logstash-"])).toEqual({ id: 1, name: "a", index: "logstash-ab-*" });
    expect(parseNamedLogsSource({ id: 1, name: null, config: { index: "logstash-ab-*" } }, ["logstash-"])).toBeNull();
    expect(parseNamedLogsSource({ id: 1, name: "a", config: { index: "secret-*" } }, ["logstash-"])).toBeNull();
  });
});

describe("in the database", () => {
  let db: TestDb;
  let w: World;
  const addLogs = async (env: number, name: string, config: Record<string, unknown>) =>
    ((await db.owner`insert into environment_sources (environment_id, kind, name, config) values (${env}, 'logs', ${name}, ${config}::jsonb) returning id`) as { id: number }[])[0]!.id;

  beforeAll(async () => {
    db = await createHubTestDb();
    w = await buildWorld(db.owner);
  });
  afterAll(() => db.drop());

  test("several logs sources per environment with names unique regardless of case; every other kind stays one", async () => {
    await addLogs(w.envs.shopProd, "shop", { index: "logstash-shop-*" });
    await addLogs(w.envs.shopProd, "payments", { index: "logstash-shop-payments-*" });
    await expect(addLogs(w.envs.shopProd, "Payments", { index: "logstash-shop-pay-*" })).rejects.toThrow(/environment_sources_logs_name/);
    await addLogs(w.envs.shopStage, "payments", { index: "logstash-shop-pay-*" });
    await expect((async () => db.owner`insert into environment_sources (environment_id, kind, config) values (${w.envs.shopProd}, 'logs', ${{ index: "logstash-x-*" }}::jsonb)`)()).rejects.toThrow(/name_check/);
    await expect((async () => db.owner`insert into environment_sources (environment_id, kind, name, config) values (${w.envs.shopProd}, 'apm', 'x', ${{ service: "s", environment: "e" }}::jsonb)`)()).rejects.toThrow(/name_check/);
    // The settings page's upsert still finds the one APM row.
    const upsert = (service: string) => db.owner`
      insert into environment_sources (environment_id, kind, config) values (${w.envs.shopProd}, 'apm', ${{ service, environment: "production" }}::jsonb)
      on conflict (environment_id, kind) where kind <> 'logs' do update set config = excluded.config`;
    await upsert("first");
    await upsert("second");
    expect(await db.owner`select config->>'service' as service from environment_sources where environment_id = ${w.envs.shopProd} and kind = 'apm'` as any[]).toEqual([{ service: "second" }]);
  });

  test("the error poll stands per source: its own index, its own state, and a new source backfills alone", async () => {
    const HOUR = 3600_000;
    const T0 = Date.UTC(2026, 9, 23, 8, 0, 0);
    const docs: { index: string; id: string; ts: number; message: string }[] = [];
    const asked: string[] = [];
    const es: EsClient = {
      label: "Test",
      catIndices: async () => [],
      search: async (index, body: any) => {
        asked.push(String(index));
        const r = body.query.bool.filter.find((f: any) => f.range).range["@timestamp"];
        const hits = docs
          .filter((d) => d.index === String(index) && d.ts >= r.gte && d.ts < r.lt)
          .map((d) => ({ _index: d.index, _id: d.id, sort: [d.ts], _source: { "@timestamp": new Date(d.ts).toISOString(), level: "ERROR", logger_name: `svc.${d.index}`, message: d.message } }));
        return { took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { hits } } as any;
      },
    };
    const poll = (at: number) => pollLogErrors(db.worker, () => {}, { es, now: () => at, lagMs: 0 });
    const groups = () => db.owner`select message, occurrences::int as n from error_groups where environment_id = ${w.envs.mineTest} order by message` as Promise<any[]>;
    const events = () => db.owner`select title from events where source = 'errors' and environment_id = ${w.envs.mineTest} order by id` as Promise<any[]>;

    const a = await addLogs(w.envs.mineTest, "portal", { index: "logstash-mine-portal-*" });
    const b = await addLogs(w.envs.mineTest, "batch", { index: "logstash-mine-batch-*", errorGroups: false });
    docs.push({ index: "logstash-mine-portal-*", id: "a1", ts: T0 - HOUR, message: "portal failed" });
    docs.push({ index: "logstash-mine-batch-*", id: "b1", ts: T0 - HOUR, message: "batch failed" });
    await poll(T0);
    expect(asked).toContain("logstash-mine-portal-*");
    expect(asked).not.toContain("logstash-mine-batch-*");
    expect(await groups()).toEqual([{ message: "portal failed", n: 1 }]);
    expect(await events()).toEqual([]);
    const state = async () => ((await db.owner`select source_id from log_error_poll_state where source_id in (${a}, ${b}) order by source_id`) as { source_id: number }[]).map((r) => r.source_id);
    expect(await state()).toEqual([a]);

    // A third source: its last day comes in silently, the first source is not read again.
    const c = await addLogs(w.envs.mineTest, "reports", { index: "logstash-mine-reports-*" });
    docs.push({ index: "logstash-mine-reports-*", id: "c1", ts: T0 - 2 * HOUR, message: "report failed" });
    docs.push({ index: "logstash-mine-portal-*", id: "a2", ts: T0 + 10_000, message: "portal timeout" });
    await poll(T0 + 60_000);
    expect(await groups()).toEqual([{ message: "portal failed", n: 1 }, { message: "portal timeout", n: 1 }, { message: "report failed", n: 1 }]);
    expect((await events()).map((e) => e.title)).toEqual(["Neuer Fehler: portal timeout"]);

    await db.owner`delete from environment_sources where id = ${c}`;
    expect(((await db.owner`select count(*)::int as n from log_error_poll_state where source_id = ${c}`) as { n: number }[])[0]!.n).toBe(0);
  });
});
