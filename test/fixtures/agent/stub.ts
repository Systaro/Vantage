/**
 * HTTP stub for the vantage-agent tests. Plays the Vantage Ops ingest endpoint (validating every
 * report with the real parser) and the three Elasticsearch endpoints the agent reads.
 *
 * In-process: `startStub()` from test/ops-agent.test.ts.
 * Standalone (docker-check.sh): `bun test/fixtures/agent/stub.ts` prints the port and serves until
 * killed. STUB_HOST sets the bind address (default 127.0.0.1), STUB_TOKEN makes the ingest endpoint
 * answer 401 to any other bearer token. GET /__last-report returns the last posted body,
 * GET /__reports the number of posted reports.
 */
import { parseReportText } from "../../../src/shared/hosts/report";

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

export interface Stub {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** POSTs to the ingest endpoint, in order. */
  reports(): RecordedRequest[];
  /** Forces this status for the ingest endpoint (0 = normal behaviour). */
  forceReportStatus(status: number): void;
  stop(): void;
}

export const INGEST_PATH = "/api/ingest/v1/report";

/** Two of three indices carry the flood-stage block. */
export const ES_SETTINGS = {
  "logs-app-2026.10.11": { settings: { "index.blocks.read_only_allow_delete": "true" } },
  "logs-app-2026.10.12": { settings: { "index.blocks.read_only_allow_delete": "true" } },
  "apm-traces": { settings: {} },
};

/** `_cat/allocation?h=disk.percent`: one line per node, plus the empty line of unassigned shards. */
export const ES_ALLOCATION = "71\n96\n\n";

export function startStub(options: { hostname?: string; token?: string } = {}): Stub {
  const requests: RecordedRequest[] = [];
  let forced = 0;
  const reports = () => requests.filter((r) => r.path === INGEST_PATH && r.method === "POST");

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/__last-report") {
        const last = reports().at(-1);
        return last ? new Response(last.body) : new Response("no report yet", { status: 404 });
      }
      if (url.pathname === "/__reports") return new Response(String(reports().length));

      const rec: RecordedRequest = {
        method: req.method,
        path: url.pathname,
        search: url.search,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      };
      requests.push(rec);

      switch (url.pathname) {
        case INGEST_PATH: {
          if (forced) return Response.json({ error: "forced" }, { status: forced });
          if (options.token !== undefined && rec.authorization !== `Bearer ${options.token}`) {
            return Response.json({ error: "invalid token" }, { status: 401 });
          }
          const parsed = parseReportText(rec.body);
          return parsed.ok ? Response.json({ ok: true }) : Response.json({ error: parsed.error }, { status: 400 });
        }
        case "/_cluster/health":
          return Response.json({ cluster_name: "logs", status: "yellow" });
        case "/_all/_settings/index.blocks.read_only_allow_delete":
          return Response.json(ES_SETTINGS);
        case "/_cat/allocation":
          return new Response(ES_ALLOCATION, { headers: { "content-type": "text/plain" } });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });

  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    reports,
    forceReportStatus(status) {
      forced = status;
    },
    stop() {
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const stub = startStub({ hostname: process.env.STUB_HOST ?? "127.0.0.1", token: process.env.STUB_TOKEN });
  console.log(stub.port);
}
