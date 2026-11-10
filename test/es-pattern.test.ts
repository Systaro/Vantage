import { describe, expect, test } from "bun:test";
import { configuredIndex, logsIndex } from "../src/hub/modules/es/client";
import { bucketFor, parseRange } from "../src/hub/modules/es/range";
import { berlinLocalInput, parseBerlinLocal } from "../src/shared/time";
import { apmServiceProblem, filterProblem, indexFamily, indexPatternProblem } from "../src/hub/modules/sources/pattern";
import { parseApmConfig, parseLogsConfig } from "../src/hub/modules/sources/config";

const PREFIXES = ["logstash-"];

describe("index pattern validation", () => {
  test.each([
    "logstash-shop-prod-*",
    "logstash-portal.bergbau.prod-default-*",
    "logstash-shop-prod-2026-10",
    "logstash-sh*",
    "logstash-shop_prod-*",
  ])("accepts %s", (p) => {
    expect(indexPatternProblem(p, PREFIXES)).toBeNull();
  });

  test.each([
    ["", "fehlt"],
    ["*", "beginnen"],
    ["*-shop-*", "beginnen"],
    ["logstash-*", "zwei feste Zeichen"],
    ["logstash-s*", "zwei feste Zeichen"],
    ["logstash-*shop", "zwei feste Zeichen"],
    ["logstash-shop-*,logstash-mine-*", "Kommas"],
    ["logstash-shop-*,-logstash-shop-x", "Kommas"],
    ["remote:logstash-shop-*", "Clusterübergreifende"],
    ["logstash-shop:x", "Clusterübergreifende"],
    ["_all", "_all"],
    ["logstash-shop_all", "_all"],
    ["logstash-shop prod-*", "Leerzeichen"],
    ["logstash-shop\tprod", "Leerzeichen"],
    ["logstash-..-x", ".."],
    ["logstash-Shop-*", "Kleinbuchstaben"],
    ["logstash-shop/_search?q=*", "Kleinbuchstaben"],
    ["logstash-shop%2C*", "Kleinbuchstaben"],
    ["logstash-shop#x", "Kleinbuchstaben"],
    ["apm-7.15.0-error-*", "beginnen"],
    [".kibana", "beginnen"],
    [`logstash-${"x".repeat(200)}`, "höchstens"],
  ])("rejects %p", (p, reason) => {
    const problem = indexPatternProblem(p, PREFIXES);
    expect(problem).not.toBeNull();
    expect(problem!).toContain(reason);
  });

  test("the request-time check repeats the validation", () => {
    expect(String(logsIndex("logstash-shop-prod-*", PREFIXES))).toBe("logstash-shop-prod-*");
    expect(() => logsIndex("logstash-*,secret-*", PREFIXES)).toThrow();
    expect(() => logsIndex("*", PREFIXES)).toThrow();
  });

  test("configured APM indices may list patterns but never cross clusters or use _all", () => {
    expect(String(configuredIndex("apm-*-error-*"))).toBe("apm-*-error-*");
    expect(String(configuredIndex("apm-*-error-*,logs-apm.error-*"))).toBe("apm-*-error-*,logs-apm.error-*");
    expect(() => configuredIndex("remote:apm-*")).toThrow();
    expect(() => configuredIndex("_all")).toThrow();
    expect(() => configuredIndex("apm-*/_delete_by_query")).toThrow();
  });
});

describe("source filters", () => {
  test("shared-index filter needs both parts and a plain field name", () => {
    expect(filterProblem("", "")).toBeNull();
    expect(filterProblem("appname.keyword", "shop")).toBeNull();
    expect(filterProblem("appname.keyword", "")).not.toBeNull();
    expect(filterProblem("", "shop")).not.toBeNull();
    expect(filterProblem('appname"}', "shop")).not.toBeNull();
    expect(filterProblem("a..b", "shop")).not.toBeNull();
    expect(filterProblem("appname", "x\u0000y")).not.toBeNull();
  });

  test("APM service and environment are required and plain", () => {
    expect(apmServiceProblem("shop-backend", "production")).toBeNull();
    expect(apmServiceProblem("", "production")).not.toBeNull();
    expect(apmServiceProblem("shop-backend", "")).not.toBeNull();
    expect(apmServiceProblem("shop\"backend", "production")).not.toBeNull();
  });

  test("stored rows are re-validated on read, so a tampered row is ignored", () => {
    expect(parseLogsConfig({ index: "logstash-shop-prod-*" }, PREFIXES)).toEqual({ index: "logstash-shop-prod-*" });
    expect(parseLogsConfig({ index: "logstash-*,secret-*" }, PREFIXES)).toBeNull();
    expect(parseLogsConfig({ index: "logstash-shop-prod-*", filterField: "appname.keyword" }, PREFIXES)).toBeNull();
    expect(parseLogsConfig("logstash-shop-prod-*", PREFIXES)).toBeNull();
    expect(parseApmConfig({ service: "shop-backend", environment: "production" })).toEqual({ service: "shop-backend", environment: "production" });
    expect(parseApmConfig({ service: "shop-backend" })).toBeNull();
  });

  test("index families strip date and rollover suffixes", () => {
    expect(indexFamily("logstash-shop-prod-2026-10")).toBe("logstash-shop-prod");
    expect(indexFamily("logstash-portal.bergbau.prod-default-2026.10.12")).toBe("logstash-portal.bergbau.prod-default");
    expect(indexFamily("apm-7.15.0-error-000001")).toBe("apm-7.15.0-error");
    expect(indexFamily("logstash-shop")).toBe("logstash-shop");
  });
});

describe("time ranges", () => {
  const now = Date.UTC(2026, 9, 12, 10, 0, 0);
  const q = (params: Record<string, string>) => (k: string) => params[k];

  test("presets end now, unknown values fall back", () => {
    expect(parseRange(q({ range: "15m" }), { now }).range).toMatchObject({ key: "15m", from: now - 15 * 60_000, to: now, relative: true });
    expect(parseRange(q({ range: "bogus" }), { now }).range.key).toBe("1h");
  });

  test("custom ranges are capped at 30 days", () => {
    const ok = parseRange(q({ range: "custom", from: "2026-10-01T00:00", to: "2026-10-10T00:00" }), { now });
    expect(ok.problem).toBeNull();
    expect(ok.range.relative).toBe(false);
    const tooLong = parseRange(q({ range: "custom", from: "2026-08-01T00:00", to: "2026-10-10T00:00" }), { now });
    expect(tooLong.problem).toContain("30 Tage");
    expect(tooLong.range.key).toBe("1h");
    expect(parseRange(q({ range: "custom", from: "2026-10-10T00:00", to: "2026-10-01T00:00" }), { now }).problem).not.toBeNull();
    expect(parseRange(q({ range: "custom", from: "nonsense", to: "2026-10-01T00:00" }), { now }).problem).not.toBeNull();
  });

  test("datetime-local values are Berlin time, across DST", () => {
    expect(parseBerlinLocal("2026-07-01T12:00")).toBe(Date.UTC(2026, 6, 1, 10, 0));
    expect(parseBerlinLocal("2026-12-01T12:00")).toBe(Date.UTC(2026, 11, 1, 11, 0));
    expect(berlinLocalInput(Date.UTC(2026, 6, 1, 10, 0))).toBe("2026-07-01T12:00");
    expect(parseBerlinLocal("2026-13-01T12:00")).toBeNull();
  });

  test("chart buckets stay at or below 60 columns", () => {
    for (const range of ["15m", "1h", "24h", "7d"]) {
      const r = parseRange(q({ range }), { now }).range;
      expect((r.to - r.from) / bucketFor(r)).toBeLessThanOrEqual(60);
    }
  });
});
