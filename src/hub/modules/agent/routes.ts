/**
 * Agent access: REST under /api/v1/… and an MCP server (Streamable HTTP, stateless, JSON responses)
 * at /api/mcp. Both take only `Authorization: Bearer vpat_…` (a personal API token from Mein Konto),
 * never the session cookie, and set the token's user for the request, so tools.ts reads with that
 * user's grants. See docs/api.md.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import { sha256Hex } from "../../../shared/crypto";
import { hubConfig } from "../../config";
import { hubSql } from "../../db";
import { findTool, ToolError, TOOLS } from "./tools";

export const API_TOKEN_PATTERN = /^vpat_[A-Za-z0-9_-]{43}$/;
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "vantage", title: "Vantage", version: "1.0.0" };
const INSTRUCTIONS =
  "Vantage is Systaro's observability hub. Start with list_environments to get environment ids and your access level " +
  "(overview < diagnostics < security); tools that need more access than you have answer 'not found'. Everything is read-only.";

const tokenUser: MiddlewareHandler = async (c, next) => {
  const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
  if (!token || !API_TOKEN_PATTERN.test(token)) {
    return c.json({ error: "A personal API token is required: Authorization: Bearer vpat_…" }, 401, { "www-authenticate": 'Bearer realm="vantage"' });
  }
  const [row] = (await hubSql`select * from auth_api_token(${sha256Hex(token)})`) as { user_id: number; email: string; name: string; kind: string; is_admin: boolean }[];
  if (!row) return c.json({ error: "The token is invalid, expired or revoked." }, 401, { "www-authenticate": 'Bearer realm="vantage", error="invalid_token"' });
  c.set("user", { sessionId: 0, id: row.user_id, email: row.email, name: row.name, isAdmin: row.is_admin, role: row.kind });
  await next();
};

async function runTool(c: Context, name: string, args: Record<string, unknown>) {
  const tool = findTool(name);
  if (!tool) throw new ToolError(`Unknown tool ${name}`);
  return tool.run(c, args);
}

/** REST: one route per tool, arguments from the path and the query string. */
function rest(c: Context, tool: string, extra: Record<string, unknown> = {}) {
  const query = Object.fromEntries(Object.entries(c.req.queries()).map(([k, v]) => [k, v.length > 1 || k === "levels" ? v.flatMap((x) => x.split(",")) : v[0]]));
  return runTool(c, tool, { ...query, ...extra })
    .then((data) => c.json({ data }))
    .catch((err) => {
      if (err instanceof ToolError) return c.json({ error: err.message }, /^(Environment not found|No such)/.test(err.message) ? 404 : 400);
      throw err;
    });
}

// ── MCP ─────────────────────────────────────────────────────────────────────────────────────────

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleRpc(c: Context, msg: RpcRequest): Promise<object | null> {
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid request");
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) },
      };
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (!findTool(name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await runTool(c, name, (msg.params?.arguments as Record<string, unknown>) ?? {});
        return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
      } catch (err) {
        if (err instanceof ToolError) return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: err.message }], isError: true } };
        throw err;
      }
    }
    default:
      // Notifications (initialized, cancelled, …) need no answer.
      return isNotification || msg.method.startsWith("notifications/") ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export function mountAgentApi(app: Hono) {
  for (const path of ["/api/mcp", "/api/v1/environments", "/api/v1/environments/*", "/api/v1/incidents"]) app.use(path, tokenUser);

  app.get("/api/v1/environments", (c) => rest(c, "list_environments"));
  app.get("/api/v1/environments/:id", (c) => rest(c, "get_environment_status", { environment_id: c.req.param("id") }));
  app.get("/api/v1/environments/:id/logs", (c) => rest(c, "search_logs", { environment_id: c.req.param("id") }));
  app.get("/api/v1/environments/:id/logs/:entryId", (c) => rest(c, "get_log_entry", { environment_id: c.req.param("id"), entry_id: c.req.param("entryId") }));
  app.get("/api/v1/environments/:id/errors", (c) => rest(c, "list_errors", { environment_id: c.req.param("id") }));
  app.get("/api/v1/environments/:id/error-ignore-rules", (c) => rest(c, "list_error_ignore_rules", { environment_id: c.req.param("id") }));
  app.get("/api/v1/environments/:id/vulnerabilities", (c) => rest(c, "list_vulnerabilities", { environment_id: c.req.param("id") }));
  app.get("/api/v1/environments/:id/security-alerts", (c) => rest(c, "get_security_alerts", { environment_id: c.req.param("id") }));
  app.get("/api/v1/environments/:id/servers/:server/history", (c) => rest(c, "get_server_history", { environment_id: c.req.param("id"), server: c.req.param("server") }));
  app.get("/api/v1/environments/:id/test-runs", (c) => rest(c, "list_test_runs", { environment_id: c.req.param("id") }));
  app.get("/api/v1/environments/:id/ansible-runs", (c) => rest(c, "list_ansible_runs", { environment_id: c.req.param("id") }));
  app.get("/api/v1/incidents", (c) => rest(c, "list_incidents"));

  app.post("/api/mcp", async (c) => {
    // A browser page on another origin must not drive the server with a user's token (DNS rebinding).
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(hubConfig.publicUrl).origin) return c.json(rpcError(null, -32600, "Origin not allowed"), 403);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }
    if (Array.isArray(body)) {
      const answers = (await Promise.all(body.map((m) => handleRpc(c, m as RpcRequest)))).filter((a) => a !== null);
      return answers.length ? c.json(answers) : c.body(null, 202);
    }
    const answer = await handleRpc(c, body as RpcRequest);
    return answer ? c.json(answer) : c.body(null, 202);
  });
  // Stateless server: no server-initiated stream, no sessions to end.
  app.on(["GET", "DELETE"], "/api/mcp", (c) => c.body(null, 405, { allow: "POST" }));
}
