/**
 * Read-only access to the Elasticsearch clusters (logs, APM). Where a cluster is and how to log in
 * comes from its integration (/admin/integrations), looked up per request. The index in the URL path
 * is never a raw string: it is an `EsIndex`, which only exists after validation — of an admin's index
 * pattern (`logsIndex`) or of a value from the hub configuration (`configuredIndex`).
 */
import { hubConfig } from "../../config";
import type { EsConnection } from "../integrations/kinds";
import { esConnection } from "../integrations/store";
import { indexPatternProblem } from "../sources/pattern";

export class EsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "EsError";
  }
}

declare const indexBrand: unique symbol;
export type EsIndex = string & { readonly [indexBrand]: true };

/** An admin's log index pattern, re-validated right before it is used in a request path. */
export function logsIndex(pattern: string, prefixes: readonly string[] = hubConfig.logs.prefixes): EsIndex {
  const problem = indexPatternProblem(pattern, prefixes);
  if (problem) throw new EsError(`Ungültiges Indexmuster: ${problem}`);
  return pattern as EsIndex;
}

/** Several admin patterns in one request path, each validated on its own (a pattern never carries a comma). */
export function logsIndices(patterns: readonly string[], prefixes: readonly string[] = hubConfig.logs.prefixes): EsIndex {
  if (patterns.length === 0) throw new EsError("Keine Logs-Quelle");
  return [...new Set(patterns.map((p) => logsIndex(p, prefixes)))].join(",") as EsIndex;
}

/** Index expressions from the hub configuration (trusted, may list several patterns with commas). */
export function configuredIndex(value: string): EsIndex {
  if (!/^[a-z0-9._*-]+(,[a-z0-9._*-]+)*$/.test(value) || value.includes("_all") || value.includes(":")) {
    throw new EsError(`Ungültiger konfigurierter Index „${value}“`);
  }
  return value as EsIndex;
}

export interface SearchHit<S> {
  _index: string;
  _id: string;
  _source: S;
  sort?: unknown[];
  /** The `_name`s of the query clauses the hit matched. */
  matched_queries?: string[];
}

export interface SearchResponse<S = Record<string, any>> {
  took: number;
  timed_out: boolean;
  _shards: { total: number; successful: number; failed: number; failures?: { reason?: { type?: string; reason?: string } }[] };
  hits: { total?: { value: number; relation: "eq" | "gte" }; hits: SearchHit<S>[] };
  aggregations?: Record<string, any>;
}

export interface CatIndex {
  index: string;
  "docs.count": string | null;
  "store.size": string | null;
}

export interface EsClient {
  readonly label: string;
  search<S = Record<string, any>>(index: EsIndex, body: Record<string, unknown>): Promise<SearchResponse<S>>;
  catIndices(index: EsIndex): Promise<CatIndex[]>;
}

interface ClientOptions {
  label: string;
  /** A fixed connection, or a lookup that runs per request (so a saved integration applies at once). */
  connection: EsConnection | null | (() => Promise<EsConnection | null>);
  timeoutMs: number;
}

function reasonOf(body: any): string {
  const root = body?.error?.root_cause?.[0] ?? body?.error;
  if (root && typeof root === "object") return [root.type, root.reason].filter(Boolean).join(": ").slice(0, 300);
  return typeof body?.error === "string" ? body.error.slice(0, 300) : "";
}

export class HttpEsClient implements EsClient {
  readonly label: string;
  constructor(private readonly opts: ClientOptions) {
    this.label = opts.label;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const conn = typeof this.opts.connection === "function" ? await this.opts.connection() : this.opts.connection;
    if (!conn) throw new EsError(`${this.label}: keine URL konfiguriert (Verwaltung → Integrationen)`);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    // The Authorization value is used verbatim ("ApiKey …" / "Basic …") and never logged.
    if (conn.auth) headers.authorization = conn.auth;
    let res: Response;
    try {
      res = await fetch(conn.url.replace(/\/+$/, "") + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: "error",
        tls: conn.ca ? { ca: conn.ca } : undefined,
      });
    } catch (err) {
      const e = err as Error;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new EsError(`${this.label}: keine Antwort nach ${Math.round(this.opts.timeoutMs / 1000)} s`);
      }
      throw new EsError(`${this.label}: nicht erreichbar (${e?.message ?? "unbekannter Fehler"})`);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new EsError(`${this.label}: unerwartete Antwort (HTTP ${res.status})`, res.status);
    }
    return { status: res.status, json };
  }

  async search<S = Record<string, any>>(index: EsIndex, body: Record<string, unknown>): Promise<SearchResponse<S>> {
    const path = `/${encodeURIComponent(index)}/_search?ignore_unavailable=true&allow_no_indices=true`;
    const { status, json } = await this.request("POST", path, body);
    if (status !== 200) throw new EsError(`${this.label}: HTTP ${status} ${reasonOf(json)}`.trim(), status);
    const res = json as SearchResponse<S>;
    if (res._shards.total > 0 && res._shards.successful === 0) {
      const reason = res._shards.failures?.[0]?.reason;
      throw new EsError(`${this.label}: Suche fehlgeschlagen (${[reason?.type, reason?.reason].filter(Boolean).join(": ").slice(0, 300)})`);
    }
    return res;
  }

  async catIndices(index: EsIndex): Promise<CatIndex[]> {
    const path = `/_cat/indices/${encodeURIComponent(index)}?format=json&h=index,docs.count,store.size&expand_wildcards=open&s=index`;
    const { status, json } = await this.request("GET", path);
    if (status === 404) return [];
    if (status !== 200) throw new EsError(`${this.label}: HTTP ${status} ${reasonOf(json)}`.trim(), status);
    return json as CatIndex[];
  }
}

export const logsEs: EsClient = new HttpEsClient({ label: "Logs-Cluster", connection: () => esConnection("logs"), timeoutMs: hubConfig.esTimeoutMs });

export const apmEs: EsClient = new HttpEsClient({ label: "APM-Cluster", connection: () => esConnection("apm"), timeoutMs: hubConfig.esTimeoutMs });

export const wazuhEs: EsClient = new HttpEsClient({ label: "Wazuh-Indexer", connection: () => esConnection("wazuh"), timeoutMs: hubConfig.esTimeoutMs });

export const apmIndices = {
  errors: configuredIndex(hubConfig.apm.errorIndex),
  transactions: configuredIndex(hubConfig.apm.transactionIndex),
};

/** Short, user-presentable text for an ES failure; anything unexpected is rethrown. */
export function esProblem(err: unknown): string {
  if (err instanceof EsError) return err.message;
  throw err;
}
