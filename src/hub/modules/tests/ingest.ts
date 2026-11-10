/**
 * POST /api/v1/test-runs — CI uploads a Playwright run (design §6.2).
 * Bearer ingest token only, never the session cookie. The token is checked before the body is read
 * and again inside ingest_test_run(), which is the only way the hub role can write runs.
 */
import { statfs } from "node:fs/promises";
import type { Context, Hono } from "hono";
import type { SQL } from "bun";
import { sha256Hex } from "../../../shared/crypto";
import { parsePlaywrightReport, ReportFormatError } from "./playwright";
import { commitReport, discardTemp, EXTRACT_LIMITS, extractReportZip, ZipRejected } from "./storage";

const MB = 1024 * 1024;

export interface IngestLimits {
  reportBytes: number;
  htmlBytes: number;
  maxFiles: number;
  maxUncompressedBytes: number;
  maxCases: number;
  /** Uploads per token per hour. A runaway pipeline (or a leaked token) cannot flood the store. */
  uploadsPerHour: number;
  /** Refuse uploads when the report volume has less free space than this. */
  minFreeBytes: number;
}

export const INGEST_LIMITS: IngestLimits = {
  reportBytes: 50 * MB,
  htmlBytes: 150 * MB,
  maxFiles: EXTRACT_LIMITS.maxFiles,
  maxUncompressedBytes: EXTRACT_LIMITS.maxUncompressedBytes,
  maxCases: 50_000,
  uploadsPerHour: 120,
  minFreeBytes: 2 * 1024 * MB,
};

export interface IngestOptions {
  /** The hub connection; only SECURITY DEFINER functions are called on it. */
  sql: SQL;
  storageDir: string;
  publicUrl: string;
  limits?: Partial<IngestLimits>;
}

class BadUpload extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
  }
}

function bearer(header: string | undefined): string | null {
  const m = /^Bearer[ \t]+([A-Za-z0-9_-]{8,200})[ \t]*$/i.exec(header ?? "");
  return m ? m[1]! : null;
}

function unauthorized(c: Context) {
  c.header("WWW-Authenticate", 'Bearer realm="vantage-test-ingest"');
  return c.json({ error: "missing, invalid, revoked or expired ingest token" }, 401);
}

function textField(form: FormData, name: string, max: number): string | null {
  const v = form.get(name);
  if (v === null) return null;
  if (typeof v !== "string") throw new BadUpload(`"${name}" must be a text field, not a file.`);
  const s = v.trim();
  if (s === "") return null;
  if (s.length > max) throw new BadUpload(`"${name}" is longer than ${max} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new BadUpload(`"${name}" contains control characters.`);
  return s;
}

function urlField(form: FormData, name: string): string | null {
  const s = textField(form, name, 1000);
  if (s === null) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new BadUpload(`"${name}" is not a URL.`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new BadUpload(`"${name}" must be an http(s) URL.`);
  return u.toString();
}

async function readReport(form: FormData, maxBytes: number): Promise<string> {
  const v = form.get("report");
  if (v === null) throw new BadUpload('Missing "report": attach the Playwright JSON report, e.g. -F report=@results.json.');
  if (typeof v === "string") {
    if (Buffer.byteLength(v) > maxBytes) throw new BadUpload(`"report" is larger than ${maxBytes / MB} MB.`, 413);
    return v;
  }
  if (v.size > maxBytes) throw new BadUpload(`"report" is larger than ${maxBytes / MB} MB.`, 413);
  return v.text();
}

export function mountIngestApi(app: Hono, opts: IngestOptions) {
  const limits = { ...INGEST_LIMITS, ...opts.limits };
  // Per hub process; with one hub replica (see docs/self-hosting.md) that is the whole picture.
  const recent = new Map<string, number[]>();
  function overQuota(hash: string, now = Date.now()): boolean {
    const hour = now - 3600_000;
    const list = (recent.get(hash) ?? []).filter((t) => t > hour);
    if (list.length >= limits.uploadsPerHour) {
      recent.set(hash, list);
      return true;
    }
    list.push(now);
    recent.set(hash, list);
    return false;
  }
  const publicUrl = opts.publicUrl.replace(/\/+$/, "");

  app.post("/api/v1/test-runs", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return unauthorized(c);
    const hash = sha256Hex(token);
    const [suite] = (await opts.sql`select suite_id from ingest_token_suite(${hash})`) as { suite_id: number }[];
    if (!suite) return unauthorized(c);
    if (overQuota(hash)) return c.json({ error: `More than ${limits.uploadsPerHour} uploads in the last hour for this token.` }, 429);
    const disk = await statfs(opts.storageDir).catch(() => null);
    if (disk && disk.bavail * disk.bsize < limits.minFreeBytes) {
      console.error("[tests] report storage almost full, refusing uploads");
      return c.json({ error: "Report storage is full; try again later." }, 507);
    }

    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > limits.reportBytes + limits.htmlBytes + MB) {
      return c.json({ error: `Upload too large (report ≤ ${limits.reportBytes / MB} MB, html ≤ ${limits.htmlBytes / MB} MB).` }, 413);
    }
    if (!/^multipart\/form-data/i.test(c.req.header("content-type") ?? "")) {
      return c.json({ error: 'Send multipart/form-data with a "report" file field.' }, 400);
    }

    let tempDir: string | null = null;
    try {
      let form: FormData;
      try {
        form = await c.req.raw.formData();
      } catch {
        throw new BadUpload("The multipart body could not be parsed.");
      }

      let json: unknown;
      try {
        json = JSON.parse(await readReport(form, limits.reportBytes));
      } catch (err) {
        if (err instanceof BadUpload) throw err;
        throw new BadUpload('"report" is not valid JSON. Upload the output of Playwright\'s json reporter (outputFile).');
      }
      const parsed = parsePlaywrightReport(json);
      if (parsed.cases.length > limits.maxCases) throw new BadUpload(`The report has more than ${limits.maxCases} tests.`, 413);

      const commit = textField(form, "commit", 64);
      if (commit !== null && !/^[0-9A-Za-z._-]+$/.test(commit)) throw new BadUpload('"commit" must be a commit SHA.');
      const meta = {
        commit_sha: commit,
        branch: textField(form, "branch", 200),
        pipeline_url: urlField(form, "pipeline_url"),
        job_url: urlField(form, "job_url"),
      };

      const html = form.get("html");
      if (html !== null && typeof html === "string") throw new BadUpload('"html" must be a file: -F html=@report.zip.');
      if (html && html.size > 0) {
        if (html.size > limits.htmlBytes) throw new BadUpload(`"html" is larger than ${limits.htmlBytes / MB} MB.`, 413);
        tempDir = await extractReportZip(new Uint8Array(await html.arrayBuffer()), opts.storageDir, limits);
      }

      const run = { ...parsed.run, ...meta, has_report: tempDir !== null };
      const [row] = (await opts.sql`select ingest_test_run(${hash}, ${run}::jsonb, ${parsed.cases}::jsonb) as id`) as { id: number | null }[];
      if (!row?.id) return unauthorized(c);

      if (tempDir) {
        try {
          await commitReport(tempDir, opts.storageDir, row.id);
          tempDir = null;
        } catch (err) {
          console.error(`[tests] storing the HTML report of run ${row.id} failed:`, err);
        }
      }
      return c.json({ id: row.id, url: `${publicUrl}/runs/${row.id}`, status: run.status, total: run.total, failed: run.failed }, 201);
    } catch (err) {
      if (err instanceof BadUpload) return c.json({ error: err.message }, err.status);
      if (err instanceof ReportFormatError || err instanceof ZipRejected) return c.json({ error: err.message }, 400);
      throw err;
    } finally {
      if (tempDir) await discardTemp(tempDir);
    }
  });
}
