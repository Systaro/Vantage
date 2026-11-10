import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildOverviewSearch, buildTraceSearch, parseTraceId } from "../src/hub/modules/apm/query";
import { apmIndices, EsError, HttpEsClient, logsIndex } from "../src/hub/modules/es/client";
import { parseRange } from "../src/hub/modules/es/range";
import { buildNewestOccurrenceSearch, buildOccurrencesSearch, buildPollSearch, buildSparklineSearch, describeError } from "../src/hub/modules/errors/query";
import { buildLogEntryLookup, buildLogsSearch, buildLogsSummary, nextCursor, parseCursor, parseLogFilters, parseLogId, toLogEntry, toLogsSummary, type LogRow } from "../src/hub/modules/logs/query";

const now = Date.UTC(2026, 9, 12, 10, 0, 0);
const range = parseRange((k) => ({ range: "1h" })[k], { now }).range;
const logsSource = [{ id: 1, name: "shop-prod", index: "logstash-shop-prod-*" }];
const sharedSource = [{ id: 2, name: "shop", index: "logstash-shared-prod-*", filterField: "appname.keyword", filterValue: "shop" }];
const tampered = [{ id: 3, name: "x", index: "logstash-shop-*,secret-*" }];
const apm = { service: "shop-backend", environment: "production" };

const filters = (body: any) => body.query.bool.filter as any[];
const hasServiceFilter = (body: any) => {
  const f = JSON.stringify(filters(body));
  return f.includes(JSON.stringify({ term: { "service.name": "shop-backend" } })) && f.includes(JSON.stringify({ term: { "service.environment": "production" } }));
};

describe("log queries", () => {
  // Everything a user can put into the URL of the logs page, at its most hostile.
  const hostile = parseLogFilters(["ERROR", "error", "FATAL", '"}]}', "INFO"], '") OR _index:secret-* {"index": "other-*"} /../_all');

  test("only known levels survive, the text stays text", () => {
    expect(hostile.levels).toEqual(["ERROR", "INFO"]);
    expect(hostile.q).toContain("_index:secret-*");
  });

  test("the index comes only from the source row, whatever the user typed", () => {
    const { index, body } = buildLogsSearch(logsSource, { range, filters: hostile });
    expect(String(index)).toBe("logstash-shop-prod-*");
    const sqs = filters(body).find((f) => f.simple_query_string)!.simple_query_string;
    expect(sqs.query).toBe(hostile.q);
    expect(sqs.fields).toEqual(["message", "logger_name", "stack_trace"]);
    // The user's text appears exactly once in the request, inside simple_query_string.
    expect(JSON.stringify(body).split("secret-*").length - 1).toBe(1);
    expect(Object.keys(body).sort()).toEqual(["_source", "query", "size", "sort", "track_total_hits"]);
  });

  test("the shared-index filter is always applied", () => {
    for (const opts of [{}, { before: { ts: now - 1000, seen: ["a"] } }, { after: { ts: now - 1000, seen: [] } }]) {
      const { body } = buildLogsSearch(sharedSource, { range, filters: hostile, ...opts });
      expect(filters(body)).toContainEqual({ term: { "appname.keyword": "shop" } });
    }
  });

  test("a tampered source row cannot reach the request", () => {
    expect(() => buildLogsSearch(tampered, { range, filters: hostile })).toThrow(EsError);
  });

  test("the overview summary reads 24 whole hours of the source's own documents", () => {
    const at = Date.UTC(2026, 9, 12, 10, 25, 0);
    const { index, body, from } = buildLogsSummary(sharedSource, at);
    expect(String(index)).toBe("logstash-shared-prod-*");
    expect(from).toBe(Date.UTC(2026, 9, 11, 11, 0, 0));
    expect(filters(body)).toContainEqual({ term: { "appname.keyword": "shop" } });
    expect(filters(body)).toContainEqual({ range: { "@timestamp": { gte: from, lte: at, format: "epoch_millis" } } });
    expect(body.size).toBe(0);
    expect(() => buildLogsSummary(tampered, at)).toThrow(EsError);
  });

  test("the summary response becomes counts, hourly errors and the newest problems", () => {
    const from = Date.UTC(2026, 9, 11, 11, 0, 0);
    const s = toLogsSummary({
      took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 },
      hits: { total: { value: 656, relation: "eq" }, hits: [] },
      aggregations: {
        levels: { buckets: [{ key: "INFO", doc_count: 593 }, { key: "WARN", doc_count: 54 }, { key: "ERROR", doc_count: 9 }] },
        errors: { hourly: { buckets: [{ key: from - 3_600_000, doc_count: 4 }, { key: from, doc_count: 0 }, { key: from + 3_600_000, doc_count: 2 }] } },
        problems: { latest: { hits: { hits: [{ _index: "i", _id: "a", sort: [from + 60_000], _source: { level: "error", message: "boom", logger_name: "x.y.Z" } }] } } },
      },
    }, from);
    expect(s.total).toBe(656);
    expect(s.levels).toEqual({ INFO: 593, WARN: 54, ERROR: 9 });
    // A bucket before the window (histogram rounding) is dropped.
    expect(s.errorsPerHour).toEqual([{ t: from, v: 0 }, { t: from + 3_600_000, v: 2 }]);
    expect(s.latest.map((r) => [r.id, r.level, r.ts])).toEqual([["a", "ERROR", from + 60_000]]);
  });

  test("cursors accept only timestamps and id-shaped values", () => {
    expect(parseCursor("1760263200000", "abc,def_-1")).toEqual({ ts: 1760263200000, seen: ["abc", "def_-1"] });
    expect(parseCursor("1760263200000", 'a"},{"match_all":{}}')?.seen).toEqual([]);
    expect(parseCursor("-1", "a")).toBeNull();
    expect(parseCursor("1e12", "a")).toBeNull();
    expect(parseCursor("99999999999999", "a")).toBeNull();
  });

  test("older pages exclude rows already shown at the boundary millisecond", () => {
    const row = (id: string, ts: number) => ({ id, ts }) as LogRow;
    const cursor = nextCursor([row("a", 300), row("b", 200), row("c", 200)], "min");
    expect(cursor).toEqual({ ts: 200, seen: ["b", "c"] });
    const { body } = buildLogsSearch(logsSource, { range, filters: hostile, before: cursor });
    expect(filters(body)).toContainEqual({ range: { "@timestamp": { gte: range.from, lte: 200, format: "epoch_millis" } } });
    expect((body.query as any).bool.must_not).toEqual([{ ids: { values: ["b", "c"] } }]);
    // A page that is entirely at the same millisecond keeps the earlier ids too.
    expect(nextCursor([row("d", 200)], "min", cursor)).toEqual({ ts: 200, seen: ["d", "b", "c"] });
  });

  test("the live tail reads forward from its cursor, but never outside the chosen range", () => {
    const inside = range.from + 60_000;
    const { body } = buildLogsSearch(logsSource, { range, filters: hostile, after: { ts: inside, seen: ["x"] } });
    expect(body.sort).toEqual([{ "@timestamp": { order: "asc", unmapped_type: "date" } }]);
    expect(filters(body)).toContainEqual({ range: { "@timestamp": { gte: inside, lte: range.to, format: "epoch_millis" } } });
    // "?after=0" used to read the oldest documents of the index, past the range and the 30-day cap.
    const escape = buildLogsSearch(logsSource, { range, filters: hostile, after: { ts: 0, seen: [] } });
    expect(filters(escape.body)).toContainEqual({ range: { "@timestamp": { gte: range.from, lte: range.to, format: "epoch_millis" } } });
  });
});

describe("one log entry", () => {
  test("found by id only inside the environment's index pattern and shared-index filter", () => {
    const own = buildLogEntryLookup(logsSource, "aB3_x-9");
    expect(String(own.index)).toBe("logstash-shop-prod-*");
    expect(own.body).toEqual({ size: 1, query: { bool: { filter: [{ ids: { values: ["aB3_x-9"] } }] } } });
    const shared = buildLogEntryLookup(sharedSource, "aB3_x-9");
    expect(filters(shared.body)).toContainEqual({ term: { "appname.keyword": "shop" } });
  });

  test("an id that is not an Elasticsearch id never reaches the cluster", () => {
    expect(parseLogId("Qm9vbGVhbg-x_1")).toBe("Qm9vbGVhbg-x_1");
    for (const bad of [undefined, "", "a b", "a,b", "*", "../x", "x".repeat(65), '{"match_all":{}}']) expect(parseLogId(bad)).toBeNull();
  });

  test("every other field of the document, flattened and sorted, without the ones shown on their own", () => {
    const entry = toLogEntry({
      _index: "logstash-shop-prod-2026.10.12",
      _id: "e1",
      _source: {
        "@timestamp": "2026-10-12T10:00:00.123Z", "@version": "1", level: "ERROR", logger_name: "a.b.C", message: "boom",
        thread_name: "main", "trace.id": "0af7651916cd43dd8448eb211c80319c",
        host: { name: "web-01", ip: ["10.0.0.1", "10.0.0.2"] }, appname: "shop", tags: [{ k: 1 }], pid: 42, flag: false, none: null,
      },
    });
    expect(entry.ts).toBe(Date.parse("2026-10-12T10:00:00.123Z"));
    expect(entry.index).toBe("logstash-shop-prod-2026.10.12");
    expect(entry.fields).toEqual([
      ["appname", "shop"], ["flag", "false"], ["host.ip", "10.0.0.1, 10.0.0.2"], ["host.name", "web-01"], ["none", ""], ["pid", "42"], ["tags", '[{"k":1}]'],
    ]);
    expect(JSON.parse(entry.json).message).toBe("boom");
  });
});

describe("APM queries always carry the service filter", () => {
  test("overview, trace, polling, detail and sparklines", () => {
    const bodies = [
      buildOverviewSearch(apm, range, 60_000).body,
      buildTraceSearch(apm, "0af7651916cd43dd8448eb211c80319c", now).body,
      buildPollSearch(apm, now - 60_000, now).body,
      buildNewestOccurrenceSearch(apm, "abc", now, now).body,
      buildOccurrencesSearch(apm, "abc", now - 86_400_000, now, 3_600_000).body,
      buildSparklineSearch(apm, ["abc", "def"], now).body,
    ];
    for (const body of bodies) expect(hasServiceFilter(body)).toBe(true);
  });

  test("indices come from configuration only", () => {
    expect(buildOverviewSearch(apm, range, 60_000).index).toBe(apmIndices.transactions);
    expect(buildTraceSearch(apm, "0af7651916cd43dd8448eb211c80319c").index).toBe(apmIndices.transactions);
    expect(buildNewestOccurrenceSearch(apm, "abc", now).index).toBe(apmIndices.errors);
  });

  test("trace ids must be hex, nothing else reaches the trace query", () => {
    expect(parseTraceId("0AF7651916CD43DD8448EB211C80319C")).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(parseTraceId('abc"}')).toBeNull();
    expect(parseTraceId("0af7651916cd43dd*")).toBeNull();
    expect(parseTraceId(undefined)).toBeNull();
  });

  test("APM 7.x error documents: exception array or log message", () => {
    expect(describeError({ error: { exception: [{ type: "java.lang.NullPointerException", message: "x is null", handled: false }], culprit: "Cart in total" } }))
      .toEqual({ type: "java.lang.NullPointerException", message: "x is null", culprit: "Cart in total", handled: false });
    expect(describeError({ error: { log: { message: "Something failed" } } })).toEqual({ type: null, message: "Something failed", culprit: null, handled: null });
  });
});

describe("HTTP client", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { method: string; path: string; auth: string | null; body: string }[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), body: await req.text() });
        if (url.pathname.includes("slow")) await Bun.sleep(500);
        if (url.pathname.startsWith("/_cat/indices/logstash-none")) return Response.json({ error: { type: "index_not_found_exception" } }, { status: 404 });
        if (url.pathname.startsWith("/_cat")) return Response.json([{ index: "logstash-shop-prod-2026-10", "docs.count": "12", "store.size": "1kb" }]);
        if (url.pathname.includes("broken")) return Response.json({ error: { root_cause: [{ type: "parsing_exception", reason: "bad query" }] } }, { status: 400 });
        return Response.json({ took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 0, relation: "eq" }, hits: [] } });
      },
    });
  });
  afterAll(() => server.stop(true));

  const client = (timeoutMs = 2000) => new HttpEsClient({ label: "Test", connection: { url: `http://127.0.0.1:${server.port}/`, auth: "ApiKey c2VjcmV0" }, timeoutMs });

  test("the path is the validated index, the user's text only in the body", async () => {
    const { index, body } = buildLogsSearch(logsSource, { range, filters: parseLogFilters([], "a/b?c=d&e,f:g") });
    await client().search(index, body);
    const last = seen.at(-1)!;
    expect(last.method).toBe("POST");
    expect(last.path).toBe("/logstash-shop-prod-*/_search?ignore_unavailable=true&allow_no_indices=true");
    expect(last.auth).toBe("ApiKey c2VjcmV0");
    expect(JSON.parse(last.body).query.bool.filter.at(-1).simple_query_string.query).toBe("a/b?c=d&e,f:g");
  });

  test("index preview uses _cat/indices and treats a missing index as no match", async () => {
    expect(await client().catIndices(logsIndex("logstash-shop-prod-*"))).toHaveLength(1);
    expect(seen.at(-1)!.path).toStartWith("/_cat/indices/logstash-shop-prod-*?format=json");
    expect(await client().catIndices(logsIndex("logstash-none-*"))).toEqual([]);
  });

  test("failures become readable EsErrors without leaking credentials", async () => {
    const err = await client().search(logsIndex("logstash-broken-*"), {}).catch((e) => e);
    expect(err).toBeInstanceOf(EsError);
    expect(err.message).toContain("parsing_exception: bad query");
    expect(err.message).not.toContain("c2VjcmV0");
    const timeout = await client(100).search(logsIndex("logstash-slow-*"), {}).catch((e) => e);
    expect(timeout).toBeInstanceOf(EsError);
    expect(timeout.message).toContain("keine Antwort");
    const down = await new HttpEsClient({ label: "Test", connection: { url: "http://127.0.0.1:1" }, timeoutMs: 1000 }).search(logsIndex("logstash-shop-*"), {}).catch((e) => e);
    expect(down).toBeInstanceOf(EsError);
    expect(down.message).toContain("nicht erreichbar");
    const unconfigured = await new HttpEsClient({ label: "Test", connection: null, timeoutMs: 1000 }).search(logsIndex("logstash-shop-*"), {}).catch((e) => e);
    expect(unconfigured.message).toContain("keine URL");
  });
});
