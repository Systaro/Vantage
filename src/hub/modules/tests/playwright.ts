/**
 * Playwright JSON reporter output → one run summary + one row per test (spec × project).
 * The input comes from CI uploads, so every field is treated as optional and of unknown type.
 */

export type RunStatus = "passed" | "failed" | "flaky" | "interrupted";
export type CaseStatus = "passed" | "failed" | "flaky" | "skipped" | "timedOut" | "interrupted";

export interface ParsedCase {
  title: string;
  file: string | null;
  project: string | null;
  status: CaseStatus;
  duration_ms: number | null;
  retries: number;
  error: string | null;
}

export interface ParsedRun {
  status: RunStatus;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  started_at: string | null;
  duration_ms: number | null;
}

export interface ParsedReport {
  run: ParsedRun;
  cases: ParsedCase[];
}

export class ReportFormatError extends Error {}

export const TITLE_SEPARATOR = " › ";
export const MAX_ERROR_CHARS = 4000;
const MAX_ERROR_LINES = 60;

type Outcome = "expected" | "unexpected" | "flaky" | "skipped";

const RESULT_STATUSES = new Set(["passed", "failed", "timedOut", "skipped", "interrupted"]);

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function ms(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.min(Math.round(n), 2_147_483_647);
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// CSI sequences (colours, cursor movement) and OSC sequences (hyperlinks), as Playwright prints them.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(CONTROL, "");
}

/** The message of each error, without colour codes, capped in lines and characters. */
export function cleanError(messages: string[]): string | null {
  const text = messages
    .map((m) => stripAnsi(m).replace(/\r\n?/g, "\n").trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) return null;
  let out = text.split("\n").slice(0, MAX_ERROR_LINES).join("\n");
  if (out.length > MAX_ERROR_CHARS) out = `${out.slice(0, MAX_ERROR_CHARS - 1)}…`;
  return out;
}

function errorMessages(result: Record<string, unknown>): string[] {
  const fromList = list(result.errors)
    .map((e) => str(obj(e)?.message) ?? str(obj(e)?.value))
    .filter((m): m is string => m !== null);
  if (fromList.length) return fromList;
  const single = obj(result.error);
  const message = str(single?.message) ?? str(single?.value) ?? str(single?.stack);
  return message ? [message] : [];
}

function outcomeOf(test: Record<string, unknown>, results: Record<string, unknown>[]): Outcome {
  const declared = test.status;
  if (declared === "expected" || declared === "unexpected" || declared === "flaky" || declared === "skipped") return declared;
  // Older or hand-made reports: derive from the attempts, the way Playwright does.
  const statuses = results.map((r) => r.status);
  if (statuses.length === 0 || statuses.every((s) => s === "skipped")) return "skipped";
  const expected = typeof test.expectedStatus === "string" ? test.expectedStatus : "passed";
  const last = statuses.at(-1);
  if (last === expected) return statuses.some((s) => s !== expected) ? "flaky" : "expected";
  return "unexpected";
}

function caseStatus(outcome: Outcome, last: Record<string, unknown> | undefined): CaseStatus {
  if (outcome === "flaky") return "flaky";
  if (outcome === "skipped") return last?.status === "interrupted" ? "interrupted" : "skipped";
  if (outcome === "expected") return "passed";
  const s = last?.status;
  if (s === "timedOut" || s === "interrupted") return s;
  return "failed";
}

interface Walked {
  case: ParsedCase;
  outcome: Outcome;
  hasResults: boolean;
  startedAt: number | null;
}

interface SuiteScope {
  path: string[];
  file: string | null;
  top: boolean;
}

function walkSuite(suite: Record<string, unknown>, scope: SuiteScope, out: Walked[]) {
  const file = str(suite.file) ?? scope.file;
  const title = str(suite.title);
  // Top-level suites are the spec files; the file has its own column, so it is not part of the title.
  const isFileSuite = scope.top && (title === file || file === null);
  const ownPath = title && !isFileSuite ? [...scope.path, title] : scope.path;

  for (const specValue of list(suite.specs)) {
    const spec = obj(specValue);
    if (!spec) continue;
    const specTitle = str(spec.title) ?? "(ohne Titel)";
    const specFile = str(spec.file) ?? file;
    for (const testValue of list(spec.tests)) {
      const test = obj(testValue);
      if (!test) continue;
      const results = list(test.results).map(obj).filter((r): r is Record<string, unknown> => r !== null);
      const outcome = outcomeOf(test, results);
      const last = results.at(-1);
      const withError = [...results].reverse().find((r) => errorMessages(r).length > 0);
      const retry = num(last?.retry);
      const starts = results.map((r) => (typeof r.startTime === "string" ? Date.parse(r.startTime) : NaN)).filter((t) => !Number.isNaN(t));
      out.push({
        outcome,
        hasResults: results.some((r) => typeof r.status === "string" && RESULT_STATUSES.has(r.status)),
        startedAt: starts.length ? Math.min(...starts) : null,
        case: {
          title: [...ownPath, specTitle].join(TITLE_SEPARATOR),
          file: specFile,
          project: str(test.projectName) ?? str(test.projectId),
          status: caseStatus(outcome, last),
          duration_ms: ms(last?.duration),
          retries: retry !== null ? Math.round(retry) : Math.max(results.length - 1, 0),
          error: withError ? cleanError(errorMessages(withError)) : null,
        },
      });
    }
  }
  for (const child of list(suite.suites)) {
    const s = obj(child);
    if (s) walkSuite(s, { path: ownPath, file, top: false }, out);
  }
}

/** Throws ReportFormatError when the value is not shaped like a Playwright JSON report. */
export function parsePlaywrightReport(value: unknown): ParsedReport {
  const report = obj(value);
  if (!report) throw new ReportFormatError("The report must be a JSON object (Playwright JSON reporter output).");
  if (!Array.isArray(report.suites)) {
    throw new ReportFormatError('Not a Playwright JSON report: the top-level "suites" array is missing.');
  }
  const walked: Walked[] = [];
  for (const s of report.suites) {
    const suite = obj(s);
    if (suite) walkSuite(suite, { path: [], file: null, top: true }, walked);
  }

  const count = (o: Outcome) => walked.filter((w) => w.outcome === o).length;
  const failed = count("unexpected");
  const flaky = count("flaky");
  const skipped = count("skipped");
  const passed = count("expected");
  const globalErrors = list(report.errors).length > 0;
  const interrupted =
    walked.some((w) => w.case.status === "interrupted") || !walked.some((w) => w.hasResults) || globalErrors;

  const stats = obj(report.stats);
  const starts = walked.map((w) => w.startedAt).filter((t): t is number => t !== null);
  const status: RunStatus = failed > 0 ? "failed" : flaky > 0 ? "flaky" : interrupted ? "interrupted" : "passed";

  return {
    run: {
      status,
      total: walked.length,
      passed,
      failed,
      flaky,
      skipped,
      started_at: isoDate(stats?.startTime) ?? (starts.length ? new Date(Math.min(...starts)).toISOString() : null),
      duration_ms: ms(stats?.duration),
    },
    cases: walked.map((w) => w.case),
  };
}
