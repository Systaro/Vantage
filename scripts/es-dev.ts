/**
 * DEV ONLY: helpers for the local Elasticsearch container (docker/compose.dev.yml), shared by
 * scripts/seed-es.ts and the test/es-*.test.ts files. Refuses any host other than localhost.
 */

export const DEV_ES = process.env.LOGS_ES_URL ?? "http://127.0.0.1:5461";

// CI runs ES as a service container with its own host name; it is allowed only when named explicitly.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", ...(process.env.ES_DEV_ALLOW_HOST ? [process.env.ES_DEV_ALLOW_HOST] : [])]);

export function assertLocalEs(url: string): string {
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`refusing to touch a non-local Elasticsearch (${host})`);
  }
  return url.replace(/\/+$/, "");
}

export async function es(method: string, path: string, body?: unknown, url = DEV_ES): Promise<any> {
  const res = await fetch(assertLocalEs(url) + path, {
    method,
    headers: body === undefined ? {} : { "content-type": typeof body === "string" ? "application/x-ndjson" : "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok && !(method === "DELETE" && res.status === 404)) throw new Error(`ES ${method} ${path}: HTTP ${res.status} ${text.slice(0, 500)}`);
  return json;
}

export async function bulkIndex(index: string, docs: Record<string, unknown>[], url = DEV_ES): Promise<void> {
  for (let i = 0; i < docs.length; i += 5000) {
    const chunk = docs.slice(i, i + 5000);
    const body = chunk.map((d) => `${JSON.stringify({ index: { _index: index } })}\n${JSON.stringify(d)}\n`).join("");
    const res = await es("POST", "/_bulk", body, url);
    if (res.errors) {
      const failed = res.items.find((it: any) => it.index?.error);
      throw new Error(`bulk into ${index} failed: ${JSON.stringify(failed?.index?.error).slice(0, 500)}`);
    }
  }
}

export async function recreateIndex(index: string, mappings: Record<string, unknown>, url = DEV_ES): Promise<void> {
  await es("DELETE", `/${index}`, undefined, url);
  await es("PUT", `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings }, url);
}

const kw = { type: "keyword" };

/** The parts of the APM 7.x index templates Vantage reads; everything else stays in _source only. */
export const APM_TRANSACTION_MAPPINGS = {
  dynamic: false,
  properties: {
    "@timestamp": { type: "date" },
    processor: { properties: { event: kw, name: kw } },
    service: { properties: { name: kw, environment: kw, version: kw } },
    transaction: { properties: { id: kw, name: kw, type: kw, result: kw, duration: { properties: { us: { type: "long" } } } } },
    event: { properties: { outcome: kw } },
    trace: { properties: { id: kw } },
    parent: { properties: { id: kw } },
    host: { properties: { hostname: kw, name: kw } },
  },
};

export const APM_ERROR_MAPPINGS = {
  dynamic: false,
  properties: {
    "@timestamp": { type: "date" },
    processor: { properties: { event: kw, name: kw } },
    service: { properties: { name: kw, environment: kw, version: kw } },
    error: {
      properties: {
        id: kw,
        grouping_key: kw,
        culprit: kw,
        exception: { properties: { type: kw, message: { type: "text" }, handled: { type: "boolean" }, module: kw } },
        log: { properties: { message: { type: "text" }, level: kw } },
      },
    },
    trace: { properties: { id: kw } },
    transaction: { properties: { id: kw, name: kw, type: kw } },
    parent: { properties: { id: kw } },
    host: { properties: { hostname: kw, name: kw } },
  },
};

/** Logstash indices on the logs cluster use dynamic mapping: strings become text + .keyword. */
export const LOGS_MAPPINGS = { properties: { "@timestamp": { type: "date" }, level_value: { type: "long" } } };
