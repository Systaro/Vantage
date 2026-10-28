import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync, type Zippable } from "fflate";
import { Hono } from "hono";
import { newToken, sha256Hex } from "../src/shared/crypto";
import { mountIngestApi } from "../src/hub/modules/tests/ingest";
import { createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const report = await Bun.file(join(import.meta.dir, "fixtures", "playwright-report.json")).text();

let db: TestDb;
let w: World;
let app: Hono;
let storageDir: string;
let suiteId: number;
const tokens = { valid: newToken("vti"), revoked: newToken("vti"), expired: newToken("vti"), future: newToken("vti") };

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
  storageDir = mkdtempSync(join(tmpdir(), "vantage-ingest-"));
  const [suite] = (await db.owner`insert into test_suites (environment_id, slug, name) values (${w.envs.shopProd}, 'e2e', 'E2E') returning id`) as { id: number }[];
  suiteId = suite!.id;
  const add = (token: string, extra: { revoked?: boolean; expires?: string }) => db.owner`
    insert into ingest_tokens (suite_id, name, token_hash, token_prefix, revoked_at, expires_at)
    values (${suiteId}, 'ci', ${sha256Hex(token)}, ${token.slice(0, 10)},
            ${extra.revoked ? new Date() : null}, ${extra.expires ?? null}::timestamptz)`;
  await add(tokens.valid, {});
  await add(tokens.revoked, { revoked: true });
  await add(tokens.expired, { expires: new Date(Date.now() - 60_000).toISOString() });
  await add(tokens.future, { expires: new Date(Date.now() + 3600_000).toISOString() });
  app = new Hono();
  mountIngestApi(app, {
    sql: db.hub,
    storageDir,
    publicUrl: "http://hub.test/",
    limits: { reportBytes: 100 * 1024, htmlBytes: 64 * 1024, maxFiles: 5, maxUncompressedBytes: 256 * 1024 },
  });
});
afterAll(async () => {
  await db.drop();
  rmSync(storageDir, { recursive: true, force: true });
});

function upload(token: string | null, parts: { report?: string; html?: Uint8Array | string; fields?: Record<string, string> } = {}) {
  const form = new FormData();
  if (parts.report !== undefined) form.append("report", new Blob([parts.report], { type: "application/json" }), "results.json");
  if (parts.html !== undefined) {
    if (typeof parts.html === "string") form.append("html", parts.html);
    else form.append("html", new Blob([new Uint8Array(parts.html)], { type: "application/zip" }), "report.zip");
  }
  for (const [k, v] of Object.entries(parts.fields ?? {})) form.append(k, v);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return app.request("/api/v1/test-runs", { method: "POST", body: form, headers });
}

const runCount = async () => ((await db.owner`select count(*)::int as n from test_runs`) as { n: number }[])[0]!.n;
const tmpEntries = () => (existsSync(join(storageDir, "tmp")) ? readdirSync(join(storageDir, "tmp")) : []);
const html = (extra: Zippable = {}) => zipSync({ "index.html": strToU8("<!doctype html><title>r</title>"), "data/a.txt": strToU8("hello"), ...extra });

/** Rewrites the uncompressed size an entry declares in the central directory (to fake a zip bomb). */
function patchDeclaredSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let p = 0; p + 46 < out.length; p++) {
    if (view.getUint32(p, true) !== 0x02014b50) continue;
    const nameLen = view.getUint16(p + 28, true);
    if (new TextDecoder().decode(out.subarray(p + 46, p + 46 + nameLen)) === name) view.setUint32(p + 24, size, true);
  }
  return out;
}

describe("ingest tokens", () => {
  test("missing, malformed, unknown, revoked and expired tokens get 401 and store nothing", async () => {
    const before = await runCount();
    for (const res of [
      await upload(null, { report }),
      await app.request("/api/v1/test-runs", { method: "POST", headers: { authorization: `Basic ${btoa("a:b")}` } }),
      await upload(newToken("vti"), { report }),
      await upload(tokens.revoked, { report }),
      await upload(tokens.expired, { report }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(await res.json()).toEqual({ error: "missing, invalid, revoked or expired ingest token" });
    }
    expect(await runCount()).toBe(before);
  });

  test("a token with a future expiry works", async () => {
    expect((await upload(tokens.future, { report })).status).toBe(201);
  });
});

describe("uploads", () => {
  test("a valid upload stores the run, its cases and the HTML report, and returns the run URL", async () => {
    const res = await upload(tokens.valid, {
      report,
      html: html(),
      fields: {
        commit: "0123456789abcdef0123456789abcdef01234567",
        branch: "main",
        pipeline_url: "https://git.example/nordwind/shop/-/pipelines/42",
        job_url: "https://git.example/nordwind/shop/-/jobs/4711",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; url: string; status: string };
    expect(body.url).toBe(`http://hub.test/runs/${body.id}`);
    expect(body.status).toBe("failed");

    const [run] = (await db.owner`select * from test_runs where id = ${body.id}`) as any[];
    expect(run).toMatchObject({
      suite_id: suiteId,
      environment_id: w.envs.shopProd,
      status: "failed",
      total: 7,
      passed: 3,
      failed: 2,
      flaky: 1,
      skipped: 1,
      duration_ms: 45679,
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      branch: "main",
      pipeline_url: "https://git.example/nordwind/shop/-/pipelines/42",
      has_report: true,
      report_purged: false,
    });
    const cases = (await db.owner`select title, status, error from test_cases where run_id = ${body.id}`) as any[];
    expect(cases).toHaveLength(7);
    expect(cases.find((c) => c.title === "Checkout › pays by invoice").error).toStartWith("Error: expect(locator).toBeVisible() failed");

    expect(await Bun.file(join(storageDir, "reports", String(body.id), "index.html")).text()).toContain("<title>r</title>");
    expect(await Bun.file(join(storageDir, "reports", String(body.id), "data", "a.txt")).text()).toBe("hello");
    expect(tmpEntries()).toEqual([]);

    const [tok] = (await db.owner`select last_used_at from ingest_tokens where token_hash = ${sha256Hex(tokens.valid)}`) as any[];
    expect(tok.last_used_at).not.toBeNull();
  });

  test("the first red run of a suite emits a tests event", async () => {
    const events = (await db.owner`select state, title, link from events where source = 'tests'`) as any[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: "firing", title: "Tests rot: E2E" });
  });

  test("the report alone is enough; a zip of the report folder is accepted too", async () => {
    const plain = await upload(tokens.valid, { report });
    expect(plain.status).toBe(201);
    const { id } = (await plain.json()) as { id: number };
    expect(((await db.owner`select has_report from test_runs where id = ${id}`) as any[])[0].has_report).toBe(false);
    expect(existsSync(join(storageDir, "reports", String(id)))).toBe(false);

    const nested = zipSync({ "playwright-report/index.html": strToU8("<html>nested</html>"), "playwright-report/data/x.txt": strToU8("x") });
    const res = await upload(tokens.valid, { report, html: nested });
    expect(res.status).toBe(201);
    const run = (await res.json()) as { id: number };
    expect(await Bun.file(join(storageDir, "reports", String(run.id), "index.html")).text()).toBe("<html>nested</html>");
  });

  test("bad requests get 400 with a message that says what is wrong", async () => {
    const before = await runCount();
    const cases: [Response | Promise<Response>, RegExp][] = [
      [upload(tokens.valid, {}), /Missing "report"/],
      [upload(tokens.valid, { report: "{not json" }), /not valid JSON/],
      [upload(tokens.valid, { report: JSON.stringify({ hello: "world" }) }), /"suites" array is missing/],
      [upload(tokens.valid, { report, html: "not a file" }), /"html" must be a file/],
      [upload(tokens.valid, { report, fields: { pipeline_url: "javascript:alert(1)" } }), /http\(s\) URL/],
      [upload(tokens.valid, { report, fields: { commit: "abc; rm -rf /" } }), /commit SHA/],
      [app.request("/api/v1/test-runs", { method: "POST", body: report, headers: { authorization: `Bearer ${tokens.valid}`, "content-type": "application/json" } }), /multipart/],
    ];
    for (const [pending, message] of cases) {
      const res = await pending;
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
    expect(await runCount()).toBe(before);
  });

  test("oversized parts get 413", async () => {
    const big = JSON.stringify({ suites: [], padding: "x".repeat(150 * 1024) });
    expect((await upload(tokens.valid, { report: big })).status).toBe(413);
    const noise = crypto.getRandomValues(new Uint8Array(65 * 1024));
    expect((await upload(tokens.valid, { report, html: zipSync({ "index.html": [noise, { level: 0 }] }) })).status).toBe(413);
  });
});

describe("zip guards", () => {
  async function rejected(zip: Uint8Array, message: RegExp) {
    const before = await runCount();
    const res = await upload(tokens.valid, { report, html: zip });
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(400);
    expect(body.error).toMatch(message);
    expect(await runCount()).toBe(before);
    expect(tmpEntries()).toEqual([]);
  }

  test("not a zip", () => rejected(strToU8("PK but not really"), /not a zip archive/));
  test("path traversal with ..", () => rejected(html({ "../../evil.txt": strToU8("x") }), /relative path component/));
  test("nested path traversal", () => rejected(html({ "data/../../evil.txt": strToU8("x") }), /relative path component/));
  test("absolute paths", () => rejected(html({ "/etc/cron.d/evil": strToU8("x") }), /absolute path/));
  test("backslash paths", () => rejected(html({ "..\\evil.txt": strToU8("x") }), /backslashes/));
  test("symbolic links", () =>
    rejected(html({ "data/link": [strToU8("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] }), /Symbolic links/));
  test("too many files", () =>
    rejected(html({ "data/1": strToU8("1"), "data/2": strToU8("2"), "data/3": strToU8("3"), "data/4": strToU8("4") }), /more than 5 files/));
  test("too large uncompressed (declared)", () => rejected(html({ "data/zeros.bin": new Uint8Array(512 * 1024) }), /larger than/));
  test("zip bomb with a lying size header", () =>
    rejected(patchDeclaredSize(html({ "data/zeros.bin": new Uint8Array(512 * 1024) }), "data/zeros.bin", 10), /beyond its declared size/));
  test("no index.html", () => rejected(zipSync({ "report.html": strToU8("x") }), /no index.html/));
  test("nothing was written outside the storage directory", () => {
    expect(existsSync(join(storageDir, "..", "evil.txt"))).toBe(false);
    expect(readdirSync(join(storageDir, "reports")).every((n) => /^\d+$/.test(n))).toBe(true);
  });
});

describe("upload quota", () => {
  test("a token gets 429 once it exceeds its uploads per hour", async () => {
    const quotaApp = new Hono();
    mountIngestApi(quotaApp, { sql: db.hub, storageDir, publicUrl: "http://hub.test/", limits: { uploadsPerHour: 2 } });
    const send = () => {
      const form = new FormData();
      form.append("report", new Blob(["{}"], { type: "application/json" }), "results.json");
      return quotaApp.request("/api/v1/test-runs", { method: "POST", body: form, headers: { authorization: `Bearer ${tokens.future}` } });
    };
    const statuses = [(await send()).status, (await send()).status, (await send()).status];
    // The first two are counted (and rejected as invalid reports), the third is refused before parsing.
    expect(statuses[2]).toBe(429);
    expect(statuses.slice(0, 2)).not.toContain(429);
  });
});
