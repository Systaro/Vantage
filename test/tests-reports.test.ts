import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { hubConfig } from "../src/hub/config";
import {
  isReportsHost,
  LINK_MAX_LIFETIME_SECONDS,
  mountReportsOrigin,
  reportSignature,
  signedReportUrl,
  signReportPath,
} from "../src/hub/modules/tests/reports";

const SECRET = "test-secret-0123456789";
const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);
const MIN = 60_000;
let storageDir: string;
let app: Hono;
let now = T0;

beforeAll(() => {
  storageDir = mkdtempSync(join(tmpdir(), "vantage-reports-"));
  const run = join(storageDir, "reports", "7");
  mkdirSync(join(run, "data"), { recursive: true });
  mkdirSync(join(storageDir, "reports", "8"), { recursive: true });
  writeFileSync(join(run, "index.html"), "<!doctype html><title>report 7</title>");
  writeFileSync(join(run, "data", "a.json"), '{"ok":true}');
  writeFileSync(join(run, "data", "trace.zip"), "PK");
  writeFileSync(join(run, "data", "video.webm"), new Uint8Array(Array.from({ length: 100 }, (_, i) => i)));
  writeFileSync(join(run, "data", "odd.bin"), "?");
  writeFileSync(join(storageDir, "reports", "8", "index.html"), "report 8");
  writeFileSync(join(storageDir, "secret.txt"), "outside");
  symlinkSync(join(storageDir, "secret.txt"), join(run, "data", "escape.txt"));
  app = new Hono();
  mountReportsOrigin(app, { secret: SECRET, storageDir, now: () => now });
});
afterAll(() => rmSync(storageDir, { recursive: true, force: true }));

const get = (path: string, headers: Record<string, string> = {}) => app.request(`http://127.0.0.1:7100${path}`, { headers });
const base = (runId = 7, at = T0) => signReportPath(SECRET, runId, at).replace(/index\.html$/, "");

describe("signed report links", () => {
  test("a fresh link serves the report with the reports-origin headers and no cookies", async () => {
    now = T0;
    const res = await get(signReportPath(SECRET, 7, T0), { cookie: "vantage_session=should-be-ignored" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("report 7");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toBeNull();
    const csp = res.headers.get("content-security-policy")!;
    for (const directive of ["frame-ancestors 'none'", "form-action 'none'", "connect-src 'self'", "script-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:"]) {
      expect(csp).toContain(directive);
    }
  });

  test("files below the prefix get their content types", async () => {
    now = T0;
    const b = base();
    const types: Record<string, string> = {
      "data/a.json": "application/json; charset=utf-8",
      "data/trace.zip": "application/zip",
      "data/video.webm": "video/webm",
      "data/odd.bin": "application/octet-stream",
    };
    for (const [file, type] of Object.entries(types)) {
      const res = await get(`${b}${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
    }
    expect((await get(b)).status).toBe(200);
  });

  test("without the trailing slash the link redirects, so relative links resolve", async () => {
    now = T0;
    const res = await get(base().slice(0, -1));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(base());
  });

  test("a tampered signature, another run's signature or a moved expiry is 404", async () => {
    now = T0;
    const path = signReportPath(SECRET, 7, T0);
    const sig = path.split("/")[4]!;
    const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    expect((await get(path.replace(sig, flipped))).status).toBe(404);
    expect((await get(path.replace(sig, sig.toUpperCase()))).status).toBe(404);
    expect((await get(path.replace("/r/7/", "/r/8/"))).status).toBe(404);
    const expires = Number(path.split("/")[3]);
    expect((await get(path.replace(`/${expires}/`, `/${expires + 3600}/`))).status).toBe(404);
    expect((await get(`/r/7/${expires}/${reportSignature("other-secret", 7, expires)}/index.html`)).status).toBe(404);
    expect((await get(signReportPath(SECRET, 8, T0))).status).toBe(200);
  });

  test("an unused link expires after 15 minutes", async () => {
    const path = signReportPath(SECRET, 8, T0 + 1000);
    now = T0 + 1000 + 16 * MIN;
    expect((await get(path)).status).toBe(404);
  });

  test("a link in use stays alive while it is used, up to two hours", async () => {
    const issued = T0 + 5 * MIN;
    const path = signReportPath(SECRET, 7, issued);
    for (let t = issued; t <= issued + LINK_MAX_LIFETIME_SECONDS * 1000 - MIN; t += 10 * MIN) {
      now = t;
      expect((await get(path)).status).toBe(200);
    }
    now = issued + LINK_MAX_LIFETIME_SECONDS * 1000 + MIN;
    expect((await get(path)).status).toBe(404);

    const idle = signReportPath(SECRET, 7, T0 + 7 * MIN);
    now = T0 + 7 * MIN;
    expect((await get(idle)).status).toBe(200);
    now = T0 + 7 * MIN + 31 * MIN;
    expect((await get(idle)).status).toBe(404);
  });

  test("path traversal and escaping symlinks are 404", async () => {
    now = T0;
    const b = base();
    for (const path of [
      `${b}../../../secret.txt`,
      `${b}%2e%2e/%2e%2e/%2e%2e/secret.txt`,
      `${b}data/..%2f..%2f..%2fsecret.txt`,
      `${b}..%5c..%5csecret.txt`,
      `${b}data%2F..%2F..%2F8%2Findex.html`,
      `${b}data/%00`,
      `${b}data/escape.txt`,
      `${b}data/`,
      `${b}data`,
      `${b}missing.html`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain("outside");
    }
  });

  test("byte ranges for media", async () => {
    now = T0;
    const url = `${base()}data/video.webm`;
    const part = await get(url, { range: "bytes=10-19" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/100");
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const tail = await get(url, { range: "bytes=-5" });
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([95, 96, 97, 98, 99]);
    const bad = await get(url, { range: "bytes=200-" });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */100");
  });

  test("everything else on the reports host is 404", async () => {
    for (const path of ["/", "/login", "/runs/7", "/env/1/tests", "/static/vantage.css", "/r/7"]) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect((await app.request("http://127.0.0.1:7100/api/v1/test-runs", { method: "POST" })).status).toBe(404);
  });

  test("signedReportUrl points at REPORTS_URL with a 15-minute expiry", () => {
    const url = new URL(signedReportUrl(12));
    expect(url.origin).toBe(new URL(hubConfig.reportsUrl).origin);
    const [, r, run, expires, sig, file] = url.pathname.split("/");
    expect([r, run, file]).toEqual(["r", "12", "index.html"]);
    expect(Number(expires) - Date.now() / 1000).toBeGreaterThan(14 * 60);
    expect(Number(expires) - Date.now() / 1000).toBeLessThanOrEqual(15 * 60);
    expect(sig).toBe(reportSignature(hubConfig.secret, 12, Number(expires)));
  });
});

describe("isReportsHost", () => {
  const req = (host: string | null, url = "http://placeholder/") => new Request(url, { headers: host === null ? {} : { host } });

  test("local: hub on localhost, reports on 127.0.0.1", () => {
    const hub = "http://localhost:7100";
    const reports = "http://127.0.0.1:7100";
    expect(isReportsHost(req("127.0.0.1:7100"), hub, reports)).toBe(true);
    expect(isReportsHost(req("localhost:7100"), hub, reports)).toBe(false);
    expect(isReportsHost(req("127.0.0.1:7101"), hub, reports)).toBe(false);
    expect(isReportsHost(req(null, "http://127.0.0.1:7100/r/1"), hub, reports)).toBe(true);
  });

  test("production hosts: case and default port do not matter, other hosts never match", () => {
    const hub = "https://vantage.example.com";
    const reports = "https://reports.vantage-content.example";
    expect(isReportsHost(req("reports.vantage-content.example"), hub, reports)).toBe(true);
    expect(isReportsHost(req("REPORTS.Vantage-Content.example"), hub, reports)).toBe(true);
    expect(isReportsHost(req("reports.vantage-content.example:443"), hub, reports)).toBe(true);
    expect(isReportsHost(req("reports.vantage-content.example:8443"), hub, reports)).toBe(false);
    expect(isReportsHost(req("vantage.example.com"), hub, reports)).toBe(false);
    expect(isReportsHost(req("evil.example"), hub, reports)).toBe(false);
    expect(isReportsHost(req("a b"), hub, reports)).toBe(false);
  });

  test("never true when REPORTS_URL and HUB_PUBLIC_URL share a host", () => {
    expect(isReportsHost(req("localhost:7100"), "http://localhost:7100", "http://localhost:7100")).toBe(false);
  });
});
