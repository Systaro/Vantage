/**
 * APM requests. APM indices are shared by every service, so the `service.name` and
 * `service.environment` term filters from the environment's source row are the only isolation there
 * is. Every request body in this module and in errors/ is built on `serviceFilter()`.
 */
import { apmIndices, type EsIndex, type SearchResponse } from "../es/client";
import { fixedInterval, type TimeRange } from "../es/range";
import type { ApmSource } from "../sources/config";

export function serviceFilter(source: ApmSource): Record<string, unknown>[] {
  return [{ term: { "service.name": source.service } }, { term: { "service.environment": source.environment } }];
}

export function timeFilter(from: number, to: number): Record<string, unknown> {
  return { range: { "@timestamp": { gte: from, lte: to, format: "epoch_millis" } } };
}

export function parseTraceId(raw: string | undefined): string | null {
  return raw && /^[a-f0-9]{16,64}$/i.test(raw) ? raw.toLowerCase() : null;
}

const DURATION = "transaction.duration.us";
const FAILED = { filter: { term: { "event.outcome": "failure" } } };

export function buildOverviewSearch(source: ApmSource, range: TimeRange, bucketMs: number): { index: EsIndex; body: Record<string, unknown> } {
  return {
    index: apmIndices.transactions,
    body: {
      size: 0,
      track_total_hits: true,
      query: { bool: { filter: [...serviceFilter(source), { term: { "processor.event": "transaction" } }, timeFilter(range.from, range.to)] } },
      aggs: {
        over_time: {
          date_histogram: {
            field: "@timestamp",
            fixed_interval: fixedInterval(bucketMs),
            min_doc_count: 0,
            extended_bounds: { min: range.from, max: range.to },
            time_zone: "Europe/Berlin",
          },
          aggs: { p95: { percentiles: { field: DURATION, percents: [95] } }, failures: FAILED },
        },
        avg: { avg: { field: DURATION } },
        p95: { percentiles: { field: DURATION, percents: [95] } },
        failures: FAILED,
        transactions: {
          terms: { field: "transaction.name", size: 50, order: { _count: "desc" } },
          aggs: { avg: { avg: { field: DURATION } }, p95: { percentiles: { field: DURATION, percents: [95] } }, failures: FAILED },
        },
      },
    },
  };
}

/** Lookback for a trace link: traces are looked up independent of the chart range. */
export const TRACE_LOOKBACK_MS = 30 * 24 * 3600_000;

export function buildTraceSearch(source: ApmSource, traceId: string, now = Date.now()): { index: EsIndex; body: Record<string, unknown> } {
  return {
    index: apmIndices.transactions,
    body: {
      size: 200,
      sort: [{ "@timestamp": { order: "asc" } }],
      _source: ["@timestamp", "transaction.id", "transaction.name", "transaction.type", "transaction.result", "transaction.duration.us", "event.outcome", "parent.id"],
      query: {
        bool: {
          filter: [...serviceFilter(source), { term: { "processor.event": "transaction" } }, { term: { "trace.id": traceId } }, timeFilter(now - TRACE_LOOKBACK_MS, now)],
        },
      },
    },
  };
}

const usToMs = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v / 1000 : null);
const p95Of = (agg: any) => usToMs(agg?.values?.["95.0"]);
const rate = (failures: number, count: number) => (count > 0 ? (failures / count) * 100 : null);

export interface OverviewBucket {
  t: number;
  count: number;
  p95Ms: number | null;
  failureRate: number | null;
}

export interface TransactionRow {
  name: string;
  count: number;
  avgMs: number | null;
  p95Ms: number | null;
  failureRate: number | null;
}

export interface Overview {
  total: number;
  avgMs: number | null;
  p95Ms: number | null;
  failureRate: number | null;
  buckets: OverviewBucket[];
  transactions: TransactionRow[];
}

export function parseOverview(res: SearchResponse): Overview {
  const a = res.aggregations ?? {};
  const total = res.hits.total?.value ?? 0;
  return {
    total,
    avgMs: usToMs(a.avg?.value),
    p95Ms: p95Of(a.p95),
    failureRate: rate(a.failures?.doc_count ?? 0, total),
    buckets: (a.over_time?.buckets ?? []).map((b: any) => ({
      t: b.key,
      count: b.doc_count,
      p95Ms: b.doc_count > 0 ? p95Of(b.p95) : null,
      failureRate: rate(b.failures?.doc_count ?? 0, b.doc_count),
    })),
    transactions: (a.transactions?.buckets ?? []).map((b: any) => ({
      name: String(b.key),
      count: b.doc_count,
      avgMs: usToMs(b.avg?.value),
      p95Ms: p95Of(b.p95),
      failureRate: rate(b.failures?.doc_count ?? 0, b.doc_count),
    })),
  };
}
