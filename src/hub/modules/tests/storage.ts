/**
 * Playwright HTML reports on local disk (design §6.2: no object storage in v1; swapping this file is
 * the migration path). Layout under STORAGE_DIR:
 *   reports/<runId>/   one extracted report per run, served by the reports origin
 *   tmp/upload-*       extraction in progress; renamed into reports/ once the run row exists
 *
 * Uploaded zips come from CI and are untrusted. The central directory is parsed here so that every
 * entry is checked (names, type, declared sizes) before a single byte is written, and inflation is
 * streamed with a running byte count, so a lying header or a zip bomb stops at the limit.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { SQL } from "bun";
import { Inflate } from "fflate";

export const REPORT_RETENTION_DAYS = 90;
const STALE_TEMP_MS = 60 * 60 * 1000;

export interface ExtractLimits {
  maxFiles: number;
  maxUncompressedBytes: number;
}

export const EXTRACT_LIMITS: ExtractLimits = { maxFiles: 20_000, maxUncompressedBytes: 500 * 1024 * 1024 };

/** The upload is not an acceptable report archive; the message is safe to return to the client. */
export class ZipRejected extends Error {}

export function reportsRoot(storageDir: string): string {
  return join(resolve(storageDir), "reports");
}

export function reportDir(storageDir: string, runId: number): string {
  return join(reportsRoot(storageDir), String(runId));
}

function tmpRoot(storageDir: string): string {
  return join(resolve(storageDir), "tmp");
}

// ── Zip structure ──────────────────────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const INFLATE_CHUNK = 64 * 1024;

interface ZipEntry {
  segments: string[];
  isDir: boolean;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const utf8 = new TextDecoder("utf-8");

function findEndOfCentralDirectory(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG && i + 22 + view.getUint16(i + 20, true) <= view.byteLength) return i;
  }
  throw new ZipRejected("The html file is not a zip archive.");
}

/** Splits an entry name into path segments, or rejects it. Only plain relative paths survive. */
function entrySegments(name: string): { segments: string[]; isDir: boolean } {
  if (name.length === 0 || name.length > 1024) throw new ZipRejected("Zip entry with an empty or overlong name.");
  if (/[\u0000-\u001f\u007f\\]/.test(name)) throw new ZipRejected(`Zip entry name contains control characters or backslashes: ${JSON.stringify(name.slice(0, 200))}`);
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) throw new ZipRejected(`Zip entry with an absolute path: ${JSON.stringify(name.slice(0, 200))}`);
  const isDir = name.endsWith("/");
  const parts = (isDir ? name.slice(0, -1) : name).split("/");
  while (parts[0] === "." && parts.length > 1) parts.shift();
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") throw new ZipRejected(`Zip entry with a relative path component: ${JSON.stringify(name.slice(0, 200))}`);
  }
  return { segments: parts, isDir };
}

function readCentralDirectory(zip: Uint8Array, limits: ExtractLimits): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (zip.byteLength < 22) throw new ZipRejected("The html file is not a zip archive.");
  const eocd = findEndOfCentralDirectory(view);
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0) throw new ZipRejected("Multi-part zip archives are not supported.");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipRejected("ZIP64 archives are not supported.");
  if (cdOffset + cdSize > eocd) throw new ZipRejected("The zip archive is corrupt (central directory out of range).");
  if (count > limits.maxFiles * 2) throw new ZipRejected(`The report has more than ${limits.maxFiles} files.`);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let files = 0;
  let declared = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== CENTRAL_SIG) throw new ZipRejected("The zip archive is corrupt (bad central directory).");
    const madeBy = view.getUint16(p + 4, true) >> 8;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const external = view.getUint32(p + 38, true);
    const localOffset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > eocd) throw new ZipRejected("The zip archive is corrupt (bad central directory).");
    const name = utf8.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipRejected("ZIP64 archives are not supported.");
    if (flags & 0x1) throw new ZipRejected("Encrypted zip entries are not supported.");
    const { segments, isDir: dirByName } = entrySegments(name);
    // Unix-made archives carry the file type in the upper half of the external attributes.
    const mode = madeBy === 3 || madeBy === 19 ? external >>> 16 : 0;
    const type = mode & S_IFMT;
    if (type === S_IFLNK) throw new ZipRejected(`Symbolic links are not allowed in the report: ${JSON.stringify(name.slice(0, 200))}`);
    if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) throw new ZipRejected(`Zip entry is not a regular file: ${JSON.stringify(name.slice(0, 200))}`);
    const isDir = dirByName || type === S_IFDIR || (external & 0x10) !== 0;
    if (!isDir) {
      if (method !== 0 && method !== 8) throw new ZipRejected(`Unsupported compression method ${method} (only stored and deflate).`);
      files++;
      declared += size;
      if (files > limits.maxFiles) throw new ZipRejected(`The report has more than ${limits.maxFiles} files.`);
      if (declared > limits.maxUncompressedBytes) throw new ZipRejected(`The report is larger than ${limits.maxUncompressedBytes} bytes uncompressed.`);
    }
    entries.push({ segments, isDir, method, compressedSize, size, localOffset });
  }
  return entries;
}

/**
 * Reports are expected with index.html at the top. A zip of the report folder itself
 * (`playwright-report/index.html`) is accepted too: the single top-level folder is dropped.
 */
function rootEntries(entries: ZipEntry[]): ZipEntry[] {
  const files = entries.filter((e) => !e.isDir);
  if (files.some((e) => e.segments.length === 1 && e.segments[0] === "index.html")) return entries;
  const top = files[0]?.segments[0];
  const nested =
    top !== undefined &&
    files.every((e) => e.segments.length > 1 && e.segments[0] === top) &&
    files.some((e) => e.segments.length === 2 && e.segments[1] === "index.html");
  if (!nested) throw new ZipRejected("The zip has no index.html at its top level (zip the contents of playwright-report/).");
  return entries
    .filter((e) => e.segments.length > 1)
    .map((e) => ({ ...e, segments: e.segments.slice(1) }));
}

function writeEntry(zip: Uint8Array, entry: ZipEntry, target: string, budget: { left: number }) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const lh = entry.localOffset;
  if (lh + 30 > zip.byteLength || view.getUint32(lh, true) !== LOCAL_SIG) throw new ZipRejected("The zip archive is corrupt (bad local header).");
  const start = lh + 30 + view.getUint16(lh + 26, true) + view.getUint16(lh + 28, true);
  const end = start + entry.compressedSize;
  if (end > zip.byteLength) throw new ZipRejected("The zip archive is corrupt (entry data out of range).");
  const data = zip.subarray(start, end);

  // "wx" fails if the path exists (duplicate entry, or anything already planted there).
  const fd = openSync(target, "wx", 0o644);
  try {
    let written = 0;
    const take = (chunk: Uint8Array) => {
      written += chunk.byteLength;
      budget.left -= chunk.byteLength;
      if (written > entry.size) throw new ZipRejected("A zip entry inflates beyond its declared size.");
      if (budget.left < 0) throw new ZipRejected("The report is too large uncompressed.");
      writeSync(fd, chunk);
    };
    if (entry.method === 0) {
      take(data);
    } else {
      const inflater = new Inflate((chunk) => take(chunk));
      if (data.byteLength === 0) inflater.push(new Uint8Array(0), true);
      for (let o = 0; o < data.byteLength; o += INFLATE_CHUNK) {
        inflater.push(data.subarray(o, o + INFLATE_CHUNK), o + INFLATE_CHUNK >= data.byteLength);
      }
    }
    if (written !== entry.size) throw new ZipRejected("The zip archive is corrupt (entry size mismatch).");
  } finally {
    closeSync(fd);
  }
}

/**
 * Validates and extracts a zipped Playwright HTML report into a fresh temp directory under
 * STORAGE_DIR and returns its path. Throws ZipRejected for anything not acceptable; the temp
 * directory is removed on every failure.
 */
export async function extractReportZip(zip: Uint8Array, storageDir: string, limits: ExtractLimits = EXTRACT_LIMITS): Promise<string> {
  const entries = rootEntries(readCentralDirectory(zip, limits));
  mkdirSync(tmpRoot(storageDir), { recursive: true });
  const dir = mkdtempSync(join(tmpRoot(storageDir), "upload-"));
  const budget = { left: limits.maxUncompressedBytes };
  try {
    let sinceYield = 0;
    for (const entry of entries) {
      const target = resolve(dir, ...entry.segments);
      if (!target.startsWith(dir + sep)) throw new ZipRejected("Zip entry outside the report directory.");
      if (entry.isDir) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeEntry(zip, entry, target, budget);
      sinceYield += entry.size + 4096;
      // Extraction is synchronous work; give other requests a turn now and then.
      if (sinceYield > 8 * 1024 * 1024) {
        sinceYield = 0;
        await Bun.sleep(0);
      }
    }
    return dir;
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    if (err instanceof ZipRejected) throw err;
    const e = err as { code?: unknown };
    // fflate reports broken deflate data with a numeric code; EEXIST/ENOTDIR mean colliding entries.
    if (typeof e?.code === "number") throw new ZipRejected("The zip archive is corrupt (invalid deflate data).");
    if (e?.code === "EEXIST" || e?.code === "ENOTDIR") throw new ZipRejected("The zip archive has duplicate or colliding entries.");
    throw err;
  }
}

/** Moves an extracted report into place for its run. */
export async function commitReport(tempDir: string, storageDir: string, runId: number): Promise<void> {
  const target = reportDir(storageDir, runId);
  mkdirSync(reportsRoot(storageDir), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(tempDir, target);
}

export async function discardTemp(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

export async function removeReports(storageDir: string, runIds: number[]): Promise<void> {
  for (const id of runIds) await rm(reportDir(storageDir, id), { recursive: true, force: true });
}

// ── Retention ──────────────────────────────────────────────────────────────────────────────────

/**
 * Deletes HTML reports older than 90 days and marks their runs `report_purged` (run statistics and
 * cases stay forever), removes report directories whose run no longer exists (deleted suite or
 * environment), and clears upload temp directories older than an hour. Runs in the worker
 * (`vantage_worker`, BYPASSRLS). Returns the number of report directories removed.
 */
export async function purgeReports(sql: SQL, storageDir: string, log: (m: string) => void = () => {}): Promise<number> {
  let removed = 0;

  for (;;) {
    const rows = (await sql`
      select id from test_runs
      where has_report and not report_purged and received_at < now() - make_interval(days => ${REPORT_RETENTION_DAYS}::int)
      order by id limit 500`) as { id: number }[];
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    await removeReports(storageDir, ids);
    await sql`update test_runs set report_purged = true where id = any(${sql.array(ids, "int4")})`;
    removed += ids.length;
    log(`[tests] purged HTML reports of ${ids.length} run(s) older than ${REPORT_RETENTION_DAYS} days`);
  }

  const onDisk = (await readdir(reportsRoot(storageDir)).catch(() => [] as string[])).filter((n) => /^\d{1,9}$/.test(n)).map(Number);
  if (onDisk.length) {
    const live = new Set(
      ((await sql`select id from test_runs where id = any(${sql.array(onDisk, "int4")}) and has_report and not report_purged`) as { id: number }[]).map((r) => r.id),
    );
    const orphans = onDisk.filter((id) => !live.has(id));
    if (orphans.length) {
      await removeReports(storageDir, orphans);
      removed += orphans.length;
      log(`[tests] removed ${orphans.length} report director${orphans.length === 1 ? "y" : "ies"} without a live run`);
    }
  }

  const tmp = tmpRoot(storageDir);
  for (const name of await readdir(tmp).catch(() => [] as string[])) {
    if (!name.startsWith("upload-")) continue;
    const path = join(tmp, name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > STALE_TEMP_MS) {
      await rm(path, { recursive: true, force: true });
      log(`[tests] removed stale upload directory ${name}`);
    }
  }
  return removed;
}
