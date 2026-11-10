import { describe, expect, test } from "bun:test";
import type { CatIndex, EsClient } from "../src/hub/modules/es/client";
import { familyPattern, stringFields, suggestFilterFields, suggestFilterValues, suggestIndexPatterns } from "../src/hub/modules/sources/suggest";

/** An ES client that answers from fixed data and records the requests it got. */
function fakeEs(opts: { indices?: CatIndex[]; search?: (index: string, body: any) => any }) {
  const requests: { index: string; body: any }[] = [];
  const es: EsClient = {
    label: "Test-ES",
    catIndices: async () => opts.indices ?? [],
    search: async (index, body) => {
      requests.push({ index, body });
      return opts.search!(index, body);
    },
  };
  return { es, requests };
}

const hits = (docs: object[]) => ({ _shards: { total: 1, successful: 1 }, hits: { total: { value: docs.length }, hits: docs.map((d, i) => ({ _index: "x", _id: String(i), _source: d })) } });

describe("index pattern suggestions", () => {
  test("one pattern per family, with the index's own separator before the date", () => {
    expect(familyPattern("logstash-cortex-default-2026.10.15")).toBe("logstash-cortex-default-*");
    expect(familyPattern("logstash-crm-default-2026-10")).toBe("logstash-crm-default-*");
    expect(familyPattern("logstash-shop.2026.10")).toBe("logstash-shop.*");
    expect(familyPattern("logstash-static")).toBe("logstash-static");
  });

  test("families are counted, the largest first, unusable names left out", async () => {
    const { es } = fakeEs({
      indices: [
        { index: "logstash-small-2026.10.14", "docs.count": "10", "store.size": null },
        { index: "logstash-big-2026.10.14", "docs.count": "1000", "store.size": null },
        { index: "logstash-big-2026.10.15", "docs.count": "2000", "store.size": null },
        { index: "logstash-%{[appname]}-%{[environment]}-2026.10.15", "docs.count": "5", "store.size": null },
      ],
    });
    const { items } = await suggestIndexPatterns(es, ["logstash-"]);
    expect(items).toEqual([
      { value: "logstash-big-*", hint: "2 Indizes, 3.000 Einträge" },
      { value: "logstash-small-*", hint: "1 Index, 10 Einträge" },
    ]);
  });

  test("an empty cluster explains itself", async () => {
    const { es } = fakeEs({ indices: [] });
    expect((await suggestIndexPatterns(es, ["logstash-"])).note).toContain("keine Indizes");
  });
});

describe("filter field suggestions", () => {
  test("short string values become candidates, nested objects as dotted paths", () => {
    const fields = stringFields({
      appname: "cortex",
      level_value: 20000,
      message: "x".repeat(500),
      host: { name: "web-01", ip: ["10.0.0.1", "10.0.0.2"] },
      tags: ["a", "b"],
      labels: [{ team: "core" }],
    });
    expect([...fields].sort()).toEqual(["appname", "host.ip", "host.name", "labels.team", "tags"]);
  });

  test("keyword fields with values, the ones with a handful of values first", async () => {
    const { es, requests } = fakeEs({
      search: (_index, body) => {
        if (!body.aggs) return hits([{ appname: "cortex", environment: "prod", level: "INFO", logger_name: "a.b.C", unused: "x", message: "hello", "@timestamp": "2026-10-15T10:00:00Z" }]);
        const agg = (field: string) => Object.keys(body.aggs).find((k) => k.startsWith("t") && body.aggs[k].terms.field === field)?.slice(1);
        const values: Record<string, { keys: string[]; distinct: number }> = {
          "appname.keyword": { keys: ["cortex", "crm", "tackl"], distinct: 4 },
          "environment.keyword": { keys: ["prod"], distinct: 1 },
          "level.keyword": { keys: ["INFO", "WARN"], distinct: 2 },
          "logger_name.keyword": { keys: ["a.b.C", "a.b.D", "a.b.E"], distinct: 900 },
          "unused.keyword": { keys: [], distinct: 0 },
        };
        const aggregations: Record<string, any> = {};
        for (const [field, v] of Object.entries(values)) {
          const i = agg(field);
          if (!i) continue;
          aggregations[`t${i}`] = { buckets: v.keys.map((key) => ({ key, doc_count: 1 })) };
          aggregations[`c${i}`] = { value: v.distinct };
        }
        return { ...hits([]), aggregations };
      },
    });
    const { items } = await suggestFilterFields("logstash-shared-*", es);
    // The application's identity first; level and logger describe entries and come last.
    expect(items.map((i) => i.value)).toEqual(["appname.keyword", "environment.keyword", "level.keyword", "logger_name.keyword"]);
    expect(items[0]!.hint).toBe("4 Werte: cortex, crm, tackl, …");
    expect(items[1]!.hint).toBe("1 Wert: prod");
    // message is never offered, and the index pattern is the one that was asked for.
    const asked = Object.values(requests[1]!.body.aggs).map((a: any) => a.terms?.field).filter(Boolean);
    expect(asked).not.toContain("message.keyword");
    expect(asked).not.toContain("@timestamp.keyword");
    expect(requests.every((r) => r.index === "logstash-shared-*")).toBe(true);
  });

  test("falls back to seven days, then says there is nothing", async () => {
    const { es, requests } = fakeEs({ search: () => hits([]) });
    const res = await suggestFilterFields("logstash-quiet-*", es);
    expect(res.items).toEqual([]);
    expect(res.note).toContain("7 Tagen");
    expect(requests.map((r) => r.body.query.bool.filter[0].range["@timestamp"].gte)).toEqual(["now-24h", "now-7d"]);
  });

  test("an invalid pattern never reaches Elasticsearch", async () => {
    const { es, requests } = fakeEs({ search: () => hits([]) });
    expect((await suggestFilterFields("*", es)).note).toContain("gültiges Indexmuster");
    expect((await suggestFilterValues("logstash-*", "appname.keyword", es)).note).toContain("gültiges Indexmuster");
    expect(requests).toHaveLength(0);
  });
});

describe("filter value suggestions", () => {
  test("the most frequent values of the field", async () => {
    const { es, requests } = fakeEs({
      search: () => ({ ...hits([]), aggregations: { values: { buckets: [{ key: "cortex", doc_count: 1200 }, { key: "crm", doc_count: 3 }] } } }),
    });
    const { items } = await suggestFilterValues("logstash-shared-*", "appname.keyword", es);
    expect(items).toEqual([
      { value: "cortex", hint: "1.200 Einträge in 7 Tagen" },
      { value: "crm", hint: "3 Einträge in 7 Tagen" },
    ]);
    expect(requests[0]!.body.aggs.values.terms.field).toBe("appname.keyword");
  });

  test("a missing or malformed field is answered without a query", async () => {
    const { es, requests } = fakeEs({ search: () => hits([]) });
    expect((await suggestFilterValues("logstash-shared-*", "", es)).note).toContain("Filterfeld");
    expect((await suggestFilterValues("logstash-shared-*", "a b", es)).note).toContain("Filterfeld");
    expect(requests).toHaveLength(0);
  });

  test("no values on a text field points to .keyword", async () => {
    const { es } = fakeEs({ search: () => ({ ...hits([]), aggregations: { values: { buckets: [] } } }) });
    expect((await suggestFilterValues("logstash-shared-*", "appname", es)).note).toContain("appname.keyword");
  });
});
