/**
 * Autocomplete for the logs source dialog: index patterns (one per index family on the logs
 * cluster), filter fields seen in recent entries of a pattern, and the most frequent values of a
 * field. Only reads what the logs read proxy admits (`_cat/indices/<prefix>*` and `_search`).
 * Each answer is the whole list; the browser filters it while typing (vantage.js, data-suggest).
 */
import { formatNumber } from "../../../shared/ui/components";
import { hubConfig } from "../../config";
import { configuredIndex, logsEs, logsIndex, type CatIndex, type EsClient } from "../es/client";
import { filterProblem, indexFamily, indexPatternProblem } from "./pattern";

export interface Suggestion {
  value: string;
  hint?: string;
}

export interface Suggestions {
  items: Suggestion[];
  /** Shown instead of an empty list: why there is nothing to suggest. */
  note?: string;
}

const CAT_CACHE_MS = 60_000;
const SAMPLE_SIZE = 25;
const MAX_FIELDS = 50;
const MAX_VALUES = 200;
/** Longer strings are messages, not values a source is filtered on. */
const MAX_VALUE_LENGTH = 120;
const NOT_FILTERS = new Set(["@timestamp", "@version", "message", "stack_trace", "tags", "event.original"]);
/** Fields with a handful of values tell entries in a shared index apart, so they come first. */
const FEW_VALUES = 50;
/** Fields that describe the entry, not the application it comes from: last, whatever their values. */
const ENTRY_FIELDS = new Set(["level", "log.level", "logger_name", "log.logger", "thread_name", "trace.id", "transaction.id", "span.id"]);

const catCache = new WeakMap<EsClient, { key: string; at: number; indices: CatIndex[] }>();

async function allIndices(es: EsClient, prefixes: readonly string[]): Promise<CatIndex[]> {
  const key = prefixes.join(",");
  const cached = catCache.get(es);
  if (cached && cached.key === key && Date.now() - cached.at < CAT_CACHE_MS) return cached.indices;
  const indices = (await Promise.all(prefixes.map((p) => es.catIndices(configuredIndex(`${p}*`))))).flat();
  catCache.set(es, { key, at: Date.now(), indices });
  return indices;
}

/** The pattern that covers an index's family, keeping the index's own separator before the date. */
export function familyPattern(index: string): string {
  const family = indexFamily(index);
  return family === index ? index : `${index.slice(0, family.length + 1)}*`;
}

export async function suggestIndexPatterns(es: EsClient = logsEs, prefixes: readonly string[] = hubConfig.logs.prefixes): Promise<Suggestions> {
  const families = new Map<string, { count: number; docs: number }>();
  for (const i of await allIndices(es, prefixes)) {
    const pattern = familyPattern(i.index);
    if (indexPatternProblem(pattern, prefixes)) continue;
    const f = families.get(pattern) ?? { count: 0, docs: 0 };
    f.count += 1;
    f.docs += Number(i["docs.count"] ?? 0) || 0;
    families.set(pattern, f);
  }
  const items = [...families.entries()]
    .sort((a, b) => b[1].docs - a[1].docs || a[0].localeCompare(b[0]))
    .map(([value, f]) => ({ value, hint: `${formatNumber(f.count)} ${f.count === 1 ? "Index" : "Indizes"}, ${formatNumber(f.docs)} Einträge` }));
  return items.length ? { items } : { items, note: `Auf dem Logs-Cluster gibt es keine Indizes mit ${prefixes.map((p) => `„${p}“`).join(" oder ")}.` };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Dotted paths of a document whose values are short strings: the candidates for an exact-match filter. */
export function stringFields(doc: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (!isObject(doc)) return out;
  for (const [k, v] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const values = Array.isArray(v) ? v : [v];
    if (values.some(isObject)) values.forEach((x) => stringFields(x, path, out));
    else if (values.length > 0 && values.every((x) => typeof x === "string" && x.length <= MAX_VALUE_LENGTH)) out.add(path);
  }
  return out;
}

const since = (from: string) => ({ bool: { filter: [{ range: { "@timestamp": { gte: from } } }] } });

/**
 * Fields of recent entries under the pattern, as `.keyword` (the logs cluster maps strings as text
 * with a keyword subfield, and only that matches the exact filter). Fields the aggregation finds no
 * values for are left out, so every suggestion can actually be filtered on.
 */
export async function suggestFilterFields(pattern: string, es: EsClient = logsEs): Promise<Suggestions> {
  if (indexPatternProblem(pattern, hubConfig.logs.prefixes)) return { items: [], note: "Zuerst ein gültiges Indexmuster eintragen." };
  const index = logsIndex(pattern);
  for (const [from, period] of [["now-24h", "24 Stunden"], ["now-7d", "7 Tagen"]] as const) {
    const sample = await es.search(index, { size: SAMPLE_SIZE, sort: [{ "@timestamp": { order: "desc", unmapped_type: "date" } }], query: since(from) });
    if (sample.hits.hits.length === 0) continue;
    const paths = new Set<string>();
    for (const h of sample.hits.hits) stringFields(h._source, "", paths);
    const fields = [...paths]
      .filter((p) => !NOT_FILTERS.has(p.replace(/\.keyword$/, "")))
      .map((p) => (p.endsWith(".keyword") ? p : `${p}.keyword`))
      .slice(0, MAX_FIELDS);
    if (fields.length === 0) break;
    const aggs = Object.fromEntries(fields.flatMap((field, i) => [
      [`t${i}`, { terms: { field, size: 3 } }],
      [`c${i}`, { cardinality: { field, precision_threshold: 200 } }],
    ]));
    const res = await es.search(index, { size: 0, query: since(from), aggs });
    const found = fields
      .map((field, i) => ({
        field,
        top: ((res.aggregations?.[`t${i}`]?.buckets ?? []) as { key: unknown }[]).map((b) => String(b.key)),
        distinct: Math.max(Number(res.aggregations?.[`c${i}`]?.value ?? 0), 1),
      }))
      .filter((f) => f.top.length > 0);
    const group = (f: { field: string; distinct: number }) =>
      ENTRY_FIELDS.has(f.field.replace(/\.keyword$/, "")) ? 3 : f.distinct > 1 && f.distinct <= FEW_VALUES ? 0 : f.distinct === 1 ? 1 : 2;
    found.sort((a, b) => group(a) - group(b) || a.distinct - b.distinct || a.field.localeCompare(b.field));
    return {
      items: found.map((f) => ({
        value: f.field,
        hint: `${f.distinct === 1 ? "1 Wert" : `${formatNumber(f.distinct)} Werte`}: ${f.top.join(", ")}${f.distinct > f.top.length ? ", …" : ""}`,
      })),
      note: found.length ? undefined : `In den letzten ${period} gibt es kein Feld mit kurzen Textwerten.`,
    };
  }
  return { items: [], note: "Unter diesem Muster gibt es in den letzten 7 Tagen keine Einträge." };
}

export async function suggestFilterValues(pattern: string, field: string, es: EsClient = logsEs): Promise<Suggestions> {
  if (indexPatternProblem(pattern, hubConfig.logs.prefixes)) return { items: [], note: "Zuerst ein gültiges Indexmuster eintragen." };
  if (!field) return { items: [], note: "Zuerst ein Filterfeld wählen." };
  const problem = filterProblem(field, "-");
  if (problem) return { items: [], note: problem };
  const res = await es.search(logsIndex(pattern), { size: 0, query: since("now-7d"), aggs: { values: { terms: { field, size: MAX_VALUES } } } });
  const buckets = (res.aggregations?.values?.buckets ?? []) as { key: unknown; doc_count: number }[];
  if (buckets.length === 0) {
    return { items: [], note: field.endsWith(".keyword") ? "Das Feld hat in den letzten 7 Tagen keine Werte." : `Keine Werte. Bei Textfeldern passt nur „${field}.keyword“.` };
  }
  return { items: buckets.map((b) => ({ value: String(b.key), hint: `${formatNumber(b.doc_count)} Einträge in 7 Tagen` })) };
}
