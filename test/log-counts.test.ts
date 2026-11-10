import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountAgentApi } from "../src/hub/modules/agent/routes";
import { TOOLS } from "../src/hub/modules/agent/tools";
import { EsError } from "../src/hub/modules/es/client";
import { bucketFor, fixedInterval, parseRange } from "../src/hub/modules/es/range";
import { buildLogCounts, LOG_GROUPS, parseLogFilters, parseLogGroup, toLogCounts } from "../src/hub/modules/logs/query";

const now = Date.UTC(2026, 10, 6, 10, 0, 0);
const rangeOf = (key: string) => parseRange((k) => ({ range: key })[k], { now }).range;
const range = rangeOf("24h");
const main = { id: 1, name: "main", index: "logstash-shop-prod-*" };
const shared = { id: 2, name: "shared", index: "logstash-shared-*", filterField: "appname.keyword", filterValue: "shop" };
const hostile = parseLogFilters(["ERROR", '"}]}'], '") OR _index:secret-* {"index": "other-*"} /../_all');
const opts = { range, filters: hostile, intervalMs: bucketFor(range), groups: 10 };

const response = (extra: Record<string, unknown>) => ({
  took: 1,
  timed_out: false,
  _shards: { total: 1, successful: 1, failed: 0 },
  hits: { total: { value: 1234, relation: "eq" as const }, hits: [] },
  aggregations: { over_time: { buckets: [{ key: range.from, doc_count: 1000 }, { key: range.to, doc_count: 234 }] }, ...extra },
});

describe("log counts", () => {
  test("counts everything: no hits, an exact total, a histogram over the range", () => {
    const { body } = buildLogCounts([main], opts) as { body: any };
    expect(body.size).toBe(0);
    expect(body.track_total_hits).toBe(true);
    expect(body.aggs.over_time.date_histogram).toMatchObject({ field: "@timestamp", fixed_interval: "30m", min_doc_count: 0, extended_bounds: { min: range.from, max: range.to } });
    expect(body.aggs.groups).toBeUndefined();
  });

  test("the text stays text, and a shared index stays narrowed to the environment", () => {
    const { index, body } = buildLogCounts([shared], opts) as { index: string; body: any };
    expect(String(index)).toBe("logstash-shared-*");
    const filter = JSON.stringify(body.query.bool.filter);
    expect(filter).toContain(JSON.stringify({ term: { "appname.keyword": "shop" } }));
    expect(body.query.bool.filter.find((c: any) => c.simple_query_string).simple_query_string.query).toBe(hostile.q);
    expect(body.query.bool.filter.find((c: any) => c.terms).terms).toEqual({ "level.keyword": ["ERROR"] });
  });

  test("a tampered source never reaches the cluster", () => {
    expect(() => buildLogCounts([{ id: 3, name: "x", index: "logstash-a-*,secret-*" }], opts)).toThrow(EsError);
  });

  test("group_by is a fixed list, an Elasticsearch field or anything else is refused", () => {
    expect(LOG_GROUPS.map(parseLogGroup)).toEqual([...LOG_GROUPS]);
    for (const bad of ["message", "level.keyword", "_index", "LEVEL", '{"terms":1}', "", 1, null, undefined, ["level"]]) expect(parseLogGroup(bad)).toBeNull();
  });

  test.each([
    ["level", "level.keyword"],
    ["logger", "logger_name.keyword"],
    ["host", "localhostname.keyword"],
  ] as const)("group_by %s reads %s, bounded, with entries lacking it in a group of their own", (groupBy, field) => {
    const { body } = buildLogCounts([main], { ...opts, groupBy, groups: 7 }) as { body: any };
    expect(body.aggs.groups.terms).toEqual({ field, size: 7, missing: "(none)" });
  });

  test("groups and the rest come back with the exact total", () => {
    const res = response({ groups: { sum_other_doc_count: 34, buckets: [{ key: "a.B", doc_count: 1000 }, { key: "c.D", doc_count: 200 }] } });
    expect(toLogCounts(res, [main], "logger")).toEqual({
      total: 1234,
      overTime: [{ t: range.from, v: 1000 }, { t: range.to, v: 234 }],
      groups: [{ key: "a.B", count: 1000 }, { key: "c.D", count: 200 }],
      other: 34,
    });
  });

  test("group_by source counts per source under its name, largest first, a source without entries included", () => {
    const { body } = buildLogCounts([main, shared], { ...opts, groupBy: "source" }) as { body: any };
    expect(Object.keys(body.aggs.sources.filters.filters)).toEqual(["1", "2"]);
    expect(body.aggs.groups).toBeUndefined();
    const res = response({ sources: { buckets: { "1": { doc_count: 34 }, "2": { doc_count: 1200 } } } });
    expect(toLogCounts(res, [main, shared], "source").groups).toEqual([{ key: "shared", count: 1200 }, { key: "main", count: 34 }]);
    const one = response({ sources: { buckets: { "1": { doc_count: 34 } } } });
    expect(toLogCounts(one, [main, shared], "source").groups).toEqual([{ key: "main", count: 34 }, { key: "shared", count: 0 }]);
  });

  test("no group asked, no groups returned; an empty answer is zero, not a failure", () => {
    expect(toLogCounts(response({}), [main]).groups).toEqual([]);
    const empty = { took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { hits: [] } };
    expect(toLogCounts(empty, [main], "level")).toEqual({ total: 0, overTime: [], groups: [], other: 0 });
  });

  test.each([
    ["15m", "1m"],
    ["1h", "1m"],
    ["24h", "30m"],
    ["7d", "3h"],
  ])("range %s keeps the histogram at about 60 points, interval %s", (key, interval) => {
    const r = rangeOf(key);
    expect(fixedInterval(bucketFor(r))).toBe(interval);
    expect((r.to - r.from) / bucketFor(r)).toBeLessThanOrEqual(60);
  });
});

describe("count_logs as a tool", () => {
  test("is declared read-only in shape: filters of search_logs plus group_by, nothing free", () => {
    const tool = TOOLS.find((t) => t.name === "count_logs")!;
    const search = TOOLS.find((t) => t.name === "search_logs")!;
    const props = tool.inputSchema.properties as Record<string, any>;
    const searchProps = search.inputSchema.properties as Record<string, any>;
    for (const k of ["environment_id", "source", "query", "levels", "range"]) expect(props[k]).toEqual(searchProps[k]);
    expect(props.group_by.enum).toEqual([...LOG_GROUPS]);
    expect(props.limit.maximum).toBe(50);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  test("REST: /logs/count is registered before /logs/:entryId, which would swallow it", () => {
    const app = new Hono();
    mountAgentApi(app);
    const paths = app.routes.filter((r) => r.method === "GET").map((r) => r.path);
    const count = paths.indexOf("/api/v1/environments/:id/logs/count");
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThan(paths.indexOf("/api/v1/environments/:id/logs/:entryId"));
  });
});
