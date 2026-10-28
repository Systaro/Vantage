import { describe, expect, test } from "bun:test";
import { flattenMetrics, MAX_METRICS, readHealth } from "../src/hub/modules/uptime/health";
import { formatMetric } from "../src/hub/modules/uptime/routes";

// Shape of a Cortex /api/health page as of 2026-10-15 (values shortened).
const cortex = {
  healthy: true,
  issues: [],
  database: { healthy: true, issues: [], queryLatencyMs: 1, connectionCount: null },
  diskSpace: { healthy: true, issues: [], totalSpaceGb: 149, freeSpaceGb: 33, usedSpaceGb: 116, usedPercentage: 77 },
  memory: { healthy: true, issues: [], heapUsedMb: 756, heapMaxMb: 2048, heapUsedPercentage: 36, nonHeapUsedMb: 286 },
  s3: { healthy: true, issues: [], bucketName: "cortex-files", bucketAccessible: true },
  llm: { healthy: true, issues: [], recentErrorCount: 0, recentSuccessCount: 0 },
};

describe("health pages", () => {
  test("Cortex: overall flag, components and figures", () => {
    const r = readHealth(200, JSON.stringify(cortex));
    expect(r.ok).toBe(true);
    expect(r.message).toBe("Gesund, 5 Komponenten");
    expect(r.details.components.map((c) => c.name)).toEqual(["database", "diskSpace", "memory", "s3", "llm"]);
    expect(r.details.metrics).toMatchObject({ "database.queryLatencyMs": 1, "diskSpace.usedPercentage": 77, "memory.heapUsedPercentage": 36 });
    // Strings, booleans and nulls are not figures.
    expect(Object.keys(r.details.metrics)).not.toContain("database.connectionCount");
    expect(Object.keys(r.details.metrics)).not.toContain("s3.bucketName");
  });

  test("Cortex: a failing component names itself and its first issue", () => {
    const sick = { ...cortex, healthy: false, diskSpace: { ...cortex.diskSpace, healthy: false, issues: ["Disk usage above 90%"], usedPercentage: 93 } };
    const r = readHealth(200, JSON.stringify(sick));
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Nicht gesund: diskSpace (Disk usage above 90%)");
    expect(r.details.components.find((c) => c.name === "diskSpace")).toMatchObject({ ok: false, issues: ["Disk usage above 90%"] });
  });

  test("Spring Actuator: status words, components, 503 when down", () => {
    const up = { status: "UP", components: { db: { status: "UP", details: { database: "PostgreSQL" } }, diskSpace: { status: "UP", details: { total: 160_000_000_000, free: 40_000_000_000, threshold: 10485760 } }, ping: { status: "UP" } } };
    const r = readHealth(200, JSON.stringify(up));
    expect(r.ok).toBe(true);
    expect(r.details.components.map((c) => c.name)).toEqual(["db", "diskSpace", "ping"]);
    expect(r.details.metrics).toEqual({ "diskSpace.total": 160_000_000_000, "diskSpace.free": 40_000_000_000, "diskSpace.threshold": 10485760 });

    const down = { status: "DOWN", components: { db: { status: "DOWN", details: { error: "Connection refused" } }, ping: { status: "UP" } } };
    const d = readHealth(503, JSON.stringify(down));
    expect(d.ok).toBe(false);
    expect(d.message).toBe("Nicht gesund: db (Connection refused)");
  });

  test("IETF health+json checks and degraded states", () => {
    const warn = { status: "warn", checks: { "db:responseTime": [{ status: "warn", observedValue: 250, output: "slow" }] } };
    const r = readHealth(200, JSON.stringify(warn));
    expect(r.ok).toBe(true);
    expect(r.details.components[0]).toMatchObject({ name: "db:responseTime", ok: true, issues: ["slow"] });
  });

  test("no JSON, or a page without any status, falls back to the HTTP status", () => {
    expect(readHealth(200, "<html>ok</html>")).toMatchObject({ ok: false, message: "HTTP 200, Antwort ist kein JSON" });
    expect(readHealth(200, JSON.stringify({ uptime: 12 })).ok).toBe(true);
    expect(readHealth(503, JSON.stringify({ uptime: 12 })).ok).toBe(false);
    expect(readHealth(500, JSON.stringify({ status: "UP" })).ok).toBe(false);
  });

  test("figures are capped, so a huge page cannot bloat the check history", () => {
    const big = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`m${i}`, i]));
    expect(Object.keys(flattenMetrics(big))).toHaveLength(MAX_METRICS);
  });

  test("units follow the field names", () => {
    expect(formatMetric("diskSpace.usedPercentage", 77)).toBe("77 %");
    expect(formatMetric("memory.heapUsedMb", 756)).toBe("756 MB");
    expect(formatMetric("diskSpace.freeSpaceGb", 33)).toBe("33 GB");
    expect(formatMetric("diskSpace.free", 40_000_000_000)).toBe("40 GB");
    expect(formatMetric("llm.recentErrorCount", 3)).toBe("3");
  });
});
