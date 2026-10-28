/** Error requests on the APM cluster; all of them start from `serviceFilter()` (see apm/query.ts). */
import { apmIndices, type EsIndex } from "../es/client";
import { fixedInterval } from "../es/range";
import { serviceFilter, timeFilter } from "../apm/query";
import type { ApmSource } from "../sources/config";

type Search = { index: EsIndex; body: Record<string, unknown> };

const errorFilter = (source: ApmSource) => [...serviceFilter(source), { term: { "processor.event": "error" } }];

/** Groups seen in (since, until]: count, first/last timestamp and the newest document per group. */
export function buildPollSearch(source: ApmSource, since: number, until: number, index: EsIndex = apmIndices.errors): Search {
  return {
    index,
    body: {
      size: 0,
      query: { bool: { filter: [...errorFilter(source), { range: { "@timestamp": { gt: since, lte: until, format: "epoch_millis" } } }] } },
      aggs: {
        groups: {
          terms: { field: "error.grouping_key", size: 1000 },
          aggs: {
            first: { min: { field: "@timestamp" } },
            last: { max: { field: "@timestamp" } },
            newest: {
              top_hits: {
                size: 1,
                sort: [{ "@timestamp": { order: "desc" } }],
                _source: ["error.exception.type", "error.exception.message", "error.exception.handled", "error.log.message", "error.culprit"],
              },
            },
          },
        },
      },
    },
  };
}

export function buildNewestOccurrenceSearch(source: ApmSource, groupingKey: string, lastSeen: number, now = Date.now()): Search {
  return {
    index: apmIndices.errors,
    body: {
      size: 1,
      sort: [{ "@timestamp": { order: "desc" } }],
      _source: ["@timestamp", "error", "transaction.id", "transaction.name", "transaction.type", "trace.id", "host.hostname", "host.name", "service.version"],
      query: { bool: { filter: [...errorFilter(source), { term: { "error.grouping_key": groupingKey } }, timeFilter(lastSeen - 24 * 3600_000, now)] } },
    },
  };
}

export function buildOccurrencesSearch(source: ApmSource, groupingKey: string, from: number, to: number, bucketMs: number): Search {
  return {
    index: apmIndices.errors,
    body: {
      size: 0,
      query: { bool: { filter: [...errorFilter(source), { term: { "error.grouping_key": groupingKey } }, timeFilter(from, to)] } },
      aggs: {
        over_time: {
          date_histogram: {
            field: "@timestamp",
            fixed_interval: fixedInterval(bucketMs),
            min_doc_count: 0,
            extended_bounds: { min: from, max: to },
            time_zone: "Europe/Berlin",
          },
        },
      },
    },
  };
}

/** Hourly counts over the last 24 h for the groups on one list page (keys come from the database). */
export function buildSparklineSearch(source: ApmSource, groupingKeys: string[], now = Date.now()): Search {
  const from = now - 24 * 3600_000;
  return {
    index: apmIndices.errors,
    body: {
      size: 0,
      query: { bool: { filter: [...errorFilter(source), { terms: { "error.grouping_key": groupingKeys } }, timeFilter(from, now)] } },
      aggs: {
        groups: {
          terms: { field: "error.grouping_key", size: groupingKeys.length || 1 },
          aggs: {
            hours: { date_histogram: { field: "@timestamp", fixed_interval: "1h", min_doc_count: 0, extended_bounds: { min: from, max: now } } },
          },
        },
      },
    },
  };
}

export interface ErrorSummary {
  type: string | null;
  message: string | null;
  culprit: string | null;
  handled: boolean | null;
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** APM 7.x: `error.exception` is an array (the cause chain); log errors carry `error.log.message`. */
export function describeError(doc: any): ErrorSummary {
  const ex = Array.isArray(doc?.error?.exception) ? doc.error.exception[0] : doc?.error?.exception;
  return {
    type: text(ex?.type, 300),
    message: text(ex?.message, 2000) ?? text(doc?.error?.log?.message, 2000),
    culprit: text(doc?.error?.culprit, 500),
    handled: typeof ex?.handled === "boolean" ? ex.handled : null,
  };
}

export function errorTitle(e: { exception_type?: string | null; type?: string | null; message: string | null }): string {
  const type = e.type ?? e.exception_type ?? null;
  const parts = [type, e.message].filter((p): p is string => !!p);
  return parts.length ? parts.join(": ").replace(/\s+/g, " ") : "Unbekannter Fehler";
}
