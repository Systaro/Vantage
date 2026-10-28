import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MAX_ERROR_CHARS, parsePlaywrightReport, ReportFormatError, stripAnsi } from "../src/hub/modules/tests/playwright";

const fixture = await Bun.file(join(import.meta.dir, "fixtures", "playwright-report.json")).json();

describe("Playwright JSON report parser", () => {
  const { run, cases } = parsePlaywrightReport(fixture);
  const byTitle = (title: string, project = "chromium") => cases.find((c) => c.title === title && c.project === project)!;

  test("run summary: failures make the run red, totals count tests per project", () => {
    expect(run).toEqual({
      status: "failed",
      total: 7,
      passed: 3,
      failed: 2,
      flaky: 1,
      skipped: 1,
      started_at: "2026-10-01T08:00:00.000Z",
      duration_ms: 45679,
    });
  });

  test("titles are the describe path plus the spec title, without the file suite", () => {
    expect(cases.map((c) => c.title).sort()).toEqual([
      "Checkout › Express › only on weekdays",
      "Checkout › Express › times out",
      "Checkout › applies a voucher",
      "Checkout › pays by invoice",
      "Search › finds by name",
      "loads the cart page",
      "loads the cart page",
    ]);
  });

  test("one case per project, nested suites inherit the file", () => {
    expect(byTitle("loads the cart page", "firefox")).toMatchObject({ file: "checkout.spec.ts", status: "passed", duration_ms: 1500 });
    expect(byTitle("Search › finds by name")).toMatchObject({ file: "search.spec.ts", project: "chromium", status: "passed" });
  });

  test("a failure after retries keeps the last attempt's duration and error, without ANSI codes", () => {
    const c = byTitle("Checkout › pays by invoice");
    expect(c.status).toBe("failed");
    expect(c.retries).toBe(2);
    expect(c.duration_ms).toBe(5321);
    expect(c.error).toStartWith("Error: expect(locator).toBeVisible() failed");
    expect(c.error).toContain("Locator: getByRole('button', { name: 'Kostenpflichtig bestellen' })");
    expect(c.error).not.toContain("\u001b");
    expect(c.error).not.toContain("first attempt");
  });

  test("flaky tests keep the error of the failed attempt", () => {
    const c = byTitle("Checkout › applies a voucher");
    expect(c).toMatchObject({ status: "flaky", retries: 1, duration_ms: 1800 });
    expect(c.error).toBe("TimeoutError: locator.click: Timeout 5000ms exceeded.");
  });

  test("skipped and timed-out tests", () => {
    expect(byTitle("Checkout › Express › only on weekdays")).toMatchObject({ status: "skipped", error: null, retries: 0 });
    expect(byTitle("Checkout › Express › times out", "firefox")).toMatchObject({ status: "timedOut", error: "Test timeout of 30000ms exceeded." });
  });

  test("flaky without failures makes the run flaky", () => {
    const report = structuredClone(fixture);
    const checkout = report.suites[0].suites[0];
    checkout.specs = checkout.specs.filter((s: { title: string }) => s.title !== "pays by invoice");
    checkout.suites[0].specs = checkout.suites[0].specs.filter((s: { title: string }) => s.title !== "times out");
    expect(parsePlaywrightReport(report).run).toMatchObject({ status: "flaky", failed: 0, flaky: 1, total: 5 });
  });

  test("a report without results, or with run-level errors, is interrupted, never green", () => {
    expect(parsePlaywrightReport({ suites: [] }).run).toMatchObject({ status: "interrupted", total: 0 });
    const noResults = { suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [{ title: "x", tests: [{ projectName: "chromium", status: "skipped", results: [] }] }] }] };
    expect(parsePlaywrightReport(noResults).run.status).toBe("interrupted");
    const globalSetupFailed = {
      errors: [{ message: "Error: global setup failed" }],
      suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [{ title: "x", tests: [{ status: "expected", results: [{ status: "passed", duration: 1 }] }] }] }],
    };
    expect(parsePlaywrightReport(globalSetupFailed).run.status).toBe("interrupted");
    const interrupted = { suites: [{ specs: [{ title: "x", tests: [{ status: "unexpected", results: [{ status: "interrupted" }] }] }] }] };
    const parsed = parsePlaywrightReport(interrupted);
    expect(parsed.cases[0]!.status).toBe("interrupted");
    expect(parsed.run.status).toBe("failed");
  });

  test("missing fields are tolerated and the outcome is derived from the attempts", () => {
    const minimal = {
      suites: [
        { specs: [
          { tests: [{ results: [{ status: "failed", error: { message: "boom" } }, { status: "passed" }] }] },
          { title: "plain", tests: [{ results: [{ status: "passed", duration: "12" }] }] },
          { title: "broken", tests: [null, "x", { results: [{ status: "failed", errors: [{ message: "one" }, { message: "two" }] }] }] },
        ] },
        null,
        42,
      ],
    };
    const { run: r, cases: cs } = parsePlaywrightReport(minimal);
    expect(cs).toHaveLength(3);
    expect(cs[0]).toMatchObject({ title: "(ohne Titel)", file: null, project: null, status: "flaky", retries: 1, error: "boom" });
    expect(cs[1]).toMatchObject({ title: "plain", status: "passed", duration_ms: null });
    expect(cs[2]).toMatchObject({ title: "broken", status: "failed", error: "one\n\ntwo" });
    expect(r).toMatchObject({ status: "failed", total: 3, passed: 1, failed: 1, flaky: 1, started_at: null, duration_ms: null });
  });

  test("errors are capped", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n");
    const { cases: cs } = parsePlaywrightReport({ suites: [{ specs: [{ title: "t", tests: [{ status: "unexpected", results: [{ status: "failed", errors: [{ message: long }] }] }] }] }] });
    expect(cs[0]!.error!.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
    expect(cs[0]!.error).toStartWith("line 0 ");
  });

  test("anything that is not a Playwright report is rejected with a clear message", () => {
    expect(() => parsePlaywrightReport([])).toThrow(ReportFormatError);
    expect(() => parsePlaywrightReport("text")).toThrow(ReportFormatError);
    expect(() => parsePlaywrightReport({ results: [] })).toThrow(/"suites" array is missing/);
  });

  test("stripAnsi removes colours and hyperlinks", () => {
    expect(stripAnsi("\u001b[1m\u001b[31mred\u001b[39m\u001b[22m \u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toBe("red link");
  });
});
