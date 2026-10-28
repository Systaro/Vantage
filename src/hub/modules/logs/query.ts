/**
 * Log search requests. The index and the shared-index filter come only from the environment's source
 * rows; user input reaches the query solely as simple_query_string text, level terms, time bounds and
 * the paging cursor below.
 *
 * Several sources (#69812) are one request: their patterns in the path, and a `should` of one named
 * clause per source, each its own `_index` pattern and shared-index filter, so a document of source A's
 * index never counts for source B's filter. The clause names (`source-<id>`) come back in
 * `matched_queries` and tell which source a hit belongs to.
 *
 * Paging (*build decision*): log documents have no unique sortable field and a point-in-time id would
 * have to travel through the URL (and it names the indices it was opened on), so the cursor is
 * "timestamp + ids already shown at exactly that millisecond". The next page asks for `<= ts` (or
 * `>= ts` for the live tail) and excludes those ids, which neither skips nor repeats rows that share
 * a timestamp — the failure mode of a plain `search_after` on `@timestamp` alone.
 */
import type { TimePoint } from "../../../shared/ui/charts";
import { logsIndex, logsIndices, type EsIndex, type SearchHit, type SearchResponse } from "../es/client";
import type { TimeRange } from "../es/range";
import type { LogsSource, NamedLogsSource } from "../sources/config";

export const LOG_LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"] as const;
export const PAGE_SIZE = 100;
export const LIVE_MAX = 200;
const MAX_QUERY = 500;
const MAX_SEEN = 300;
const SEARCH_FIELDS = ["message", "logger_name", "stack_trace"];
const SOURCE_FIELDS = ["@timestamp", "level", "logger_name", "message", "stack_trace", "thread_name", "trace.id", "trace", "transaction.id", "transaction", "appname", "environment"];

export interface LogFilters {
  levels: string[];
  q: string;
}

export interface LogCursor {
  ts: number;
  seen: string[];
}

export function parseLogFilters(levels: string[], q: string | undefined): LogFilters {
  const wanted = new Set(levels.map((l) => l.toUpperCase()));
  return {
    levels: LOG_LEVELS.filter((l) => wanted.has(l)),
    q: (q ?? "").trim().slice(0, MAX_QUERY),
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseCursor(ts: string | undefined, seen: string | undefined): LogCursor | null {
  if (!ts || !/^\d{1,13}$/.test(ts)) return null;
  const n = Number(ts);
  if (n > 4_102_444_800_000) return null;
  const ids = (seen ?? "").split(",").filter((id) => ID.test(id)).slice(0, MAX_SEEN);
  return { ts: n, seen: ids };
}

export function cursorParams(prefix: "before" | "after", cursor: LogCursor): Record<string, string> {
  return { [prefix]: String(cursor.ts), [`${prefix}_seen`]: cursor.seen.join(",") };
}

export interface LogsSearch {
  index: EsIndex;
  body: Record<string, unknown>;
}

type Clause = Record<string, unknown>;

/** A shared index (several apps in one index family) is narrowed to this environment's documents. */
function sourceFilter(source: LogsSource): Clause[] {
  return source.filterField && source.filterValue ? [{ term: { [source.filterField]: source.filterValue } }] : [];
}

const clauseName = (source: NamedLogsSource) => `source-${source.id}`;

/** One source's documents among those of several: its index pattern and its filter. */
function sourceClause(source: NamedLogsSource): Clause {
  return { bool: { _name: clauseName(source), filter: [{ wildcard: { _index: { value: source.index } } }, ...sourceFilter(source)] } };
}

/** Where a search over some of an environment's sources reads: the request path and the clauses that keep it there. */
function sourcesScope(sources: readonly NamedLogsSource[]): { index: EsIndex; filter: Clause[] } {
  if (sources.length === 1) return { index: logsIndex(sources[0]!.index), filter: sourceFilter(sources[0]!) };
  return {
    index: logsIndices(sources.map((s) => s.index)),
    filter: [{ bool: { should: sources.map(sourceClause), minimum_should_match: 1 } }],
  };
}

function levelAndText(filters: LogFilters): Clause[] {
  const out: Clause[] = [];
  if (filters.levels.length > 0) out.push({ terms: { "level.keyword": [...filters.levels] } });
  if (filters.q) out.push({ simple_query_string: { query: filters.q, fields: SEARCH_FIELDS, default_operator: "and", lenient: true } });
  return out;
}

export function buildLogsSearch(
  sources: readonly NamedLogsSource[],
  opts: { range: TimeRange; filters: LogFilters; before?: LogCursor | null; after?: LogCursor | null },
): LogsSearch {
  const { index, filter } = sourcesScope(sources);
  if (opts.after) {
    // The cursor only moves the lower bound inside the chosen range; it can never widen the range
    // (or escape the 30-day cap) — "?after=0" must not read the oldest documents of the index.
    filter.push({ range: { "@timestamp": { gte: Math.max(opts.after.ts, opts.range.from), lte: opts.range.to, format: "epoch_millis" } } });
  } else {
    const upper = opts.before ? Math.min(opts.before.ts, opts.range.to) : opts.range.to;
    filter.push({ range: { "@timestamp": { gte: opts.range.from, lte: upper, format: "epoch_millis" } } });
  }
  filter.push(...levelAndText(opts.filters));
  const seen = (opts.after ?? opts.before)?.seen ?? [];
  return {
    index,
    body: {
      size: opts.after ? LIVE_MAX : PAGE_SIZE,
      // The live tail reads forward from its cursor so a burst is caught up over several polls, not skipped.
      sort: [{ "@timestamp": { order: opts.after ? "asc" : "desc", unmapped_type: "date" } }],
      _source: SOURCE_FIELDS,
      track_total_hits: opts.before || opts.after ? false : 10_000,
      query: { bool: { filter, ...(seen.length ? { must_not: [{ ids: { values: seen } }] } : {}) } },
    },
  };
}

/** How many entries of the view each source has: the numbers on the source picker. */
export function buildSourceCounts(sources: readonly NamedLogsSource[], opts: { range: TimeRange; filters: LogFilters }): LogsSearch {
  const { index, filter } = sourcesScope(sources);
  return {
    index,
    body: {
      size: 0,
      // The total is the union: an entry two overlapping sources share counts once there.
      track_total_hits: true,
      query: { bool: { filter: [...filter, { range: { "@timestamp": { gte: opts.range.from, lte: opts.range.to, format: "epoch_millis" } } }, ...levelAndText(opts.filters)] } },
      aggs: { sources: { filters: { filters: Object.fromEntries(sources.map((s) => [String(s.id), sourceClause(s)])) } } },
    },
  };
}

export interface SourceCounts {
  total: number;
  bySource: Map<number, number>;
}

export function toSourceCounts(res: SearchResponse): SourceCounts {
  const buckets = (res.aggregations?.sources?.buckets ?? {}) as Record<string, { doc_count: number }>;
  return { total: res.hits.total?.value ?? 0, bySource: new Map(Object.entries(buckets).map(([id, b]) => [Number(id), b.doc_count])) };
}

export interface LogRow {
  id: string;
  /** The source the entry matched, when several were searched at once. */
  sourceId: number | null;
  ts: number;
  level: string;
  logger: string;
  message: string;
  stack: string;
  thread: string;
  traceId: string;
  transactionId: string;
}

const str = (v: unknown, max = 20_000) => (typeof v === "string" ? v.slice(0, max) : v === undefined || v === null ? "" : String(v).slice(0, max));

export function toLogRow(hit: SearchHit<Record<string, any>>): LogRow {
  const s = hit._source ?? {};
  const sortTs = typeof hit.sort?.[0] === "number" ? (hit.sort[0] as number) : Date.parse(s["@timestamp"]);
  const named = hit.matched_queries?.map((q) => /^source-(\d+)$/.exec(q)?.[1]).find(Boolean);
  return {
    id: hit._id,
    sourceId: named ? Number(named) : null,
    ts: Number.isFinite(sortTs) ? sortTs : 0,
    level: str(s.level, 20).toUpperCase(),
    logger: str(s.logger_name, 300),
    message: str(s.message),
    stack: str(s.stack_trace, 50_000),
    thread: str(s.thread_name, 200),
    // Logback MDC writes dotted keys literally; ECS-style shippers nest them.
    traceId: str(s["trace.id"] ?? s.trace?.id, 64),
    transactionId: str(s["transaction.id"] ?? s.transaction?.id, 64),
  };
}

/** A document id as Elasticsearch writes it; anything else never reaches the cluster. */
export function parseLogId(value: string | undefined): string | null {
  return value && ID.test(value) ? value : null;
}

/** The source of a row: the one searched, or among several the one it matched. */
export function sourceOf(row: LogRow, sources: readonly NamedLogsSource[]): NamedLogsSource | undefined {
  return sources.length === 1 ? sources[0] : sources.find((s) => s.id === row.sourceId);
}

/**
 * One entry, whole: by its id, but only inside the environment's index patterns and shared-index
 * filters, so an id from another application's documents finds nothing.
 */
export function buildLogEntryLookup(sources: readonly NamedLogsSource[], id: string): LogsSearch {
  const { index, filter } = sourcesScope(sources);
  return { index, body: { size: 1, query: { bool: { filter: [{ ids: { values: [id] } }, ...filter] } } } };
}

/** The levels a log error group is built from. */
export const ERROR_LEVELS = ["ERROR", "FATAL"];

/** ERROR entries in [since, until), oldest first, for the error poll (errors/log-poller.ts). */
export function buildErrorPollSearch(source: LogsSource, since: number, until: number, size: number): LogsSearch {
  return {
    index: logsIndex(source.index),
    body: {
      size,
      sort: [{ "@timestamp": { order: "asc", unmapped_type: "date" } }],
      _source: SOURCE_FIELDS,
      track_total_hits: false,
      query: {
        bool: {
          filter: [
            ...sourceFilter(source),
            { terms: { "level.keyword": ERROR_LEVELS } },
            { range: { "@timestamp": { gte: since, lt: until, format: "epoch_millis" } } },
          ],
        },
      },
    },
  };
}

export interface LogEntry extends LogRow {
  index: string;
  /** Every other field of the document as dotted path and text, sorted by path. */
  fields: [string, string][];
  /** The whole document, for copying. */
  json: string;
}

/** Shown on their own in the detail (or meaningless there), so not repeated under „Weitere Felder“. */
const DETAIL_FIELDS = new Set(["@timestamp", "@version", "level", "logger_name", "message", "stack_trace", "thread_name", "trace.id", "transaction.id"]);
const MAX_DETAIL_FIELDS = 200;
const MAX_FIELD_TEXT = 2_000;

export function detailFields(doc: Record<string, unknown>, prefix = "", out: [string, string][] = []): [string, string][] {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      detailFields(value as Record<string, unknown>, path, out);
      continue;
    }
    if (DETAIL_FIELDS.has(path)) continue;
    const text = Array.isArray(value)
      ? value.every((v) => v === null || typeof v !== "object") ? value.join(", ") : JSON.stringify(value)
      : str(value, MAX_FIELD_TEXT);
    out.push([path, text.slice(0, MAX_FIELD_TEXT)]);
  }
  return out;
}

export function toLogEntry(hit: SearchHit<Record<string, any>>): LogEntry {
  const source = hit._source ?? {};
  return {
    ...toLogRow(hit),
    index: hit._index,
    fields: detailFields(source).sort((a, b) => a[0].localeCompare(b[0])).slice(0, MAX_DETAIL_FIELDS),
    json: JSON.stringify(source, null, 2).slice(0, 200_000),
  };
}

/** The cursor that continues after `rows` (ordered in reading direction), merged with the previous one. */
export function nextCursor(rows: LogRow[], boundary: "min" | "max", prev?: LogCursor | null): LogCursor | null {
  if (rows.length === 0) return prev ?? null;
  const ts = boundary === "min" ? Math.min(...rows.map((r) => r.ts)) : Math.max(...rows.map((r) => r.ts));
  const seen = rows.filter((r) => r.ts === ts).map((r) => r.id);
  if (prev && prev.ts === ts) seen.push(...prev.seen);
  return { ts, seen: [...new Set(seen)].slice(-MAX_SEEN) };
}

const HOUR = 3_600_000;
export const SUMMARY_LATEST = 5;
const PROBLEM_LEVELS = ["ERROR", "WARN"];

/**
 * The overview card in one request: entries per level, errors per hour and the newest errors and
 * warnings of the last 24 hours (24 whole hours, the current one included).
 */
export function buildLogsSummary(sources: readonly NamedLogsSource[], now: number): LogsSearch & { from: number } {
  const from = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  const { index, filter } = sourcesScope(sources);
  return {
    index,
    from,
    body: {
      size: 0,
      track_total_hits: true,
      query: { bool: { filter: [...filter, { range: { "@timestamp": { gte: from, lte: now, format: "epoch_millis" } } }] } },
      aggs: {
        levels: { terms: { field: "level.keyword", size: 10 } },
        errors: {
          filter: { term: { "level.keyword": "ERROR" } },
          aggs: { hourly: { date_histogram: { field: "@timestamp", fixed_interval: "1h", min_doc_count: 0, extended_bounds: { min: from, max: now } } } },
        },
        problems: {
          filter: { terms: { "level.keyword": PROBLEM_LEVELS } },
          aggs: { latest: { top_hits: { size: SUMMARY_LATEST, sort: [{ "@timestamp": { order: "desc", unmapped_type: "date" } }], _source: SOURCE_FIELDS } } },
        },
      },
    },
  };
}

export interface LogsSummary {
  total: number;
  /** Entries per level, keys upper-case as the shippers write them. */
  levels: Record<string, number>;
  errorsPerHour: TimePoint[];
  latest: LogRow[];
}

export function toLogsSummary(res: SearchResponse, from: number): LogsSummary {
  const aggs = res.aggregations ?? {};
  const levels: Record<string, number> = {};
  for (const b of aggs.levels?.buckets ?? []) levels[String(b.key).toUpperCase()] = (levels[String(b.key).toUpperCase()] ?? 0) + b.doc_count;
  return {
    total: res.hits.total?.value ?? 0,
    levels,
    errorsPerHour: (aggs.errors?.hourly?.buckets ?? [])
      .filter((b: { key: number }) => b.key >= from)
      .map((b: { key: number; doc_count: number }) => ({ t: b.key, v: b.doc_count })),
    latest: (aggs.problems?.latest?.hits?.hits ?? []).map(toLogRow),
  };
}
