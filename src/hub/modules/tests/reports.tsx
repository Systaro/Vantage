/**
 * The reports origin (design §6.5). Playwright HTML reports carry scripts from CI uploads, so they
 * are served from a second host that never sees the session cookie: requests whose Host is the
 * REPORTS_URL host are dispatched here before any hub middleware runs (see app.tsx).
 *
 * URL: /r/<runId>/<expires>/<sig>/<file>, sig = HMAC(HUB_SECRET, "report:<runId>:<expires>").
 * All files of a report share the prefix, so the report's relative links keep working. A link is
 * valid for 15 minutes; every file request within that window keeps it alive for another 15, up to
 * two hours after it was issued. The sliding part is held in memory, per process.
 */
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Context, Hono } from "hono";
import { hmacHex, timingSafeEqualStr } from "../../../shared/crypto";
import { hubConfig } from "../../config";
import { reportDir } from "./storage";

export const LINK_TTL_SECONDS = 15 * 60;
export const LINK_MAX_LIFETIME_SECONDS = 2 * 3600;

/** Playwright's report is one HTML file with inline module scripts and styles, data:/blob: media and
 *  an optional trace viewer (service worker). Nothing may leave the origin, frame it or post forms. */
const REPORT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const BASE_HEADERS: Record<string, string> = {
  "content-security-policy": REPORT_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function reportSignature(secret: string, runId: number, expires: number): string {
  return hmacHex(secret, `report:${runId}:${expires}`);
}

/** Path of a fresh link to a run's report: /r/<runId>/<expires>/<sig>/index.html */
export function signReportPath(secret: string, runId: number, nowMs = Date.now()): string {
  const expires = Math.floor(nowMs / 1000) + LINK_TTL_SECONDS;
  return `/r/${runId}/${expires}/${reportSignature(secret, runId, expires)}/index.html`;
}

/** Link for the "HTML-Report öffnen" button; valid for 15 minutes from now. */
export function signedReportUrl(runId: number): string {
  return `${hubConfig.reportsUrl.replace(/\/+$/, "")}${signReportPath(hubConfig.secret, runId)}`;
}

function hostOf(url: string): string {
  return new URL(url).host.toLowerCase();
}

/** Normalises a Host header the way URL does (lower case, default port dropped). */
function normaliseHost(header: string, protocol: string): string | null {
  try {
    return new URL(`${protocol}//${header}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/** True when the request is addressed to the reports host and that host is not the hub's own. */
export function isReportsHost(req: Request, publicUrl: string, reportsUrl: string): boolean {
  const reports = hostOf(reportsUrl);
  if (reports === hostOf(publicUrl)) return false;
  const header = req.headers.get("host") ?? new URL(req.url).host;
  return normaliseHost(header, new URL(reportsUrl).protocol) === reports;
}

export function isReportsRequest(req: Request): boolean {
  return isReportsHost(req, hubConfig.publicUrl, hubConfig.reportsUrl);
}

function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Decoded path segments below the report root, or null for anything that is not a plain path. */
function fileSegments(rest: string): string[] | null {
  const raw = rest.split("/").slice(1);
  if (raw.length === 0 || raw.at(-1) === "") raw.splice(-1, 1, "index.html");
  const out: string[] = [];
  for (const part of raw) {
    let s: string;
    try {
      s = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (s === "" || s === "." || s === ".." || /[/\\\u0000]/.test(s)) return null;
    out.push(s);
  }
  return out;
}

/** Single byte range (`bytes=a-b`, `bytes=a-`, `bytes=-n`); videos in Safari need it. */
function parseRange(header: string, size: number): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

export interface ReportsOriginOptions {
  secret: string;
  storageDir: string;
  /** Clock in milliseconds; tests move it. */
  now?: () => number;
}

export function mountReportsOrigin(app: Hono, options?: ReportsOriginOptions) {
  if (!options && hostOf(hubConfig.reportsUrl) === hostOf(hubConfig.publicUrl)) {
    console.warn("[hub] REPORTS_URL has the same host as HUB_PUBLIC_URL; HTML reports will not be served.");
  }
  const opts = options ?? { secret: hubConfig.secret, storageDir: hubConfig.storageDir };
  const now = opts.now ?? Date.now;
  const lastUse = new Map<string, number>();

  function linkAlive(key: string, expires: number): boolean {
    const t = Math.floor(now() / 1000);
    const issued = expires - LINK_TTL_SECONDS;
    if (t > issued + LINK_MAX_LIFETIME_SECONDS || t < issued - 60) {
      lastUse.delete(key);
      return false;
    }
    const last = lastUse.get(key);
    if (t > expires && (last === undefined || t - last > LINK_TTL_SECONDS)) return false;
    lastUse.set(key, t);
    if (lastUse.size > 10_000) {
      for (const [k, v] of lastUse) if (t - v > LINK_TTL_SECONDS) lastUse.delete(k);
    }
    return true;
  }

  app.get("/r/*", async (c: Context) => {
    const url = new URL(c.req.url);
    const m = /^\/r\/(\d{1,9})\/(\d{1,12})\/([0-9a-f]{64})(\/.*)?$/.exec(url.pathname);
    if (!m) return notFound();
    const runId = Number(m[1]);
    const expires = Number(m[2]);
    const sig = m[3]!;
    if (!timingSafeEqualStr(sig, reportSignature(opts.secret, runId, expires))) return notFound();
    if (!linkAlive(`${runId}:${expires}:${sig}`, expires)) return notFound();
    // Without the trailing slash the report's relative links would resolve one level too high.
    if (m[4] === undefined) {
      return new Response(null, { status: 302, headers: { ...BASE_HEADERS, location: `${url.pathname}/`, "cache-control": "no-store" } });
    }

    const segments = fileSegments(m[4]);
    if (!segments) return notFound();
    const root = reportDir(opts.storageDir, runId);
    const target = resolve(root, ...segments);
    if (!target.startsWith(root + sep)) return notFound();
    const [realRoot, realTarget] = await Promise.all([realpath(root).catch(() => null), realpath(target).catch(() => null)]);
    if (!realRoot || !realTarget || !realTarget.startsWith(realRoot + sep)) return notFound();
    const info = await stat(realTarget).catch(() => null);
    if (!info?.isFile()) return notFound();

    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      "content-type": contentTypeFor(realTarget),
      "cache-control": "private, max-age=300",
      "accept-ranges": "bytes",
    };
    const file = Bun.file(realTarget);
    const rangeHeader = c.req.header("range");
    if (rangeHeader) {
      const range = parseRange(rangeHeader, info.size);
      if (range === "invalid") {
        return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${info.size}` } });
      }
      if (range) {
        return new Response(file.slice(range.start, range.end + 1), {
          status: 206,
          headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${info.size}`, "content-length": String(range.end - range.start + 1) },
        });
      }
    }
    return new Response(file, { headers: { ...headers, "content-length": String(info.size) } });
  });

  // Browsers ask every origin for a favicon; answering keeps report pages free of console errors.
  app.get("/favicon.ico", () =>
    new Response(Bun.file(join(import.meta.dir, "..", "..", "..", "..", "public", "favicon.svg")), {
      headers: { ...BASE_HEADERS, "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
    }),
  );
  app.all("*", () => notFound());
  app.notFound(() => notFound());
  app.onError((err, c) => {
    console.error(`[reports] ${c.req.method} ${c.req.path}:`, err);
    return new Response("Internal error\n", { status: 500, headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  });
}
