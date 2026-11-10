/**
 * The runner's door into the hub (design 6.7): Bearer `vrn_…` only, never cookies. The token is
 * checked inside runner_hello / runner_targets / runner_submit, which also make sure a runner only
 * ever sees and writes its own monitors and servers. Secrets of its monitors are decrypted here for
 * the answer, so they leave Vantage only towards the runner that probes them.
 */
import type { Context, Hono } from "hono";
import type { SQL } from "bun";
import { decryptString, sha256Hex } from "../../../shared/crypto";
import {
  CONFIG_POLL_SECONDS,
  KEY_HEADER,
  MAX_RESULTS_BYTES,
  parseResultsBody,
  RUNNER_TOKEN,
  SSH_PUBLIC_KEY,
  VERSION_HEADER,
  type RunnerConfig,
  type RunnerMonitor,
} from "../../../shared/runner-protocol";
import { hubConfig } from "../../config";
import { hubSql } from "../../db";

interface Target {
  kind: "monitor" | "server";
  id: number;
  monitor_kind: string | null;
  config: any;
  interval_seconds: number;
  timeout_ms: number | null;
  retry_interval_seconds: number | null;
  name: string;
  ssh_target: string | null;
}

/** The runner behind the request (and a record that it was seen), or null. */
async function hello(c: Context, sql: SQL): Promise<{ id: number; name: string; tokenHash: string } | null> {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!RUNNER_TOKEN.test(token)) return null;
  const version = (c.req.header(VERSION_HEADER) ?? "").slice(0, 40).replace(/[^\x20-\x7e]/g, "") || null;
  const key = c.req.header(KEY_HEADER)?.trim() ?? "";
  const tokenHash = sha256Hex(token);
  const [row] = (await sql`select id, name from runner_hello(${tokenHash}, ${version}, ${SSH_PUBLIC_KEY.test(key) ? key : null})`) as { id: number; name: string }[];
  return row ? { ...row, tokenHash } : null;
}

async function monitorFor(t: Target, secret: string): Promise<RunnerMonitor> {
  const common = { id: t.id, name: t.name, interval_seconds: t.interval_seconds, timeout_ms: t.timeout_ms ?? 10_000, retry_interval_seconds: t.retry_interval_seconds };
  const { headersEnc, queryEnc, authEnc, kumaId, ...config } = t.config ?? {};
  switch (t.monitor_kind) {
    case "http":
      return {
        ...common, kind: "http", config,
        secrets: {
          headers: headersEnc ? JSON.parse(await decryptString(secret, headersEnc)) : undefined,
          query: queryEnc ? await decryptString(secret, queryEnc) : undefined,
        },
      };
    case "health":
      return { ...common, kind: "health", config, auth: authEnc ? await decryptString(secret, authEnc) : null };
    case "tcp":
    case "dns":
    case "tls":
      return { ...common, kind: t.monitor_kind, config } as RunnerMonitor;
    default:
      throw new Error(`monitor ${t.id}: kind ${t.monitor_kind} cannot run on a runner`);
  }
}

export function mountRunnerApi(app: Hono, sql: SQL = hubSql, secret = hubConfig.secret) {
  app.get("/api/runner/v1/config", async (c) => {
    const runner = await hello(c, sql);
    if (!runner) return c.json({ error: "unauthorized" }, 401);
    const targets = (await sql`select * from runner_targets(${runner.tokenHash})`) as Target[];
    const config: RunnerConfig = {
      runner: { id: runner.id, name: runner.name },
      poll_seconds: CONFIG_POLL_SECONDS,
      monitors: await Promise.all(targets.filter((t) => t.kind === "monitor").map((t) => monitorFor(t, secret))),
      servers: targets.filter((t) => t.kind === "server").map((t) => ({ id: t.id, name: t.name, ssh_target: t.ssh_target!, interval_seconds: t.interval_seconds })),
    };
    c.header("cache-control", "no-store");
    return c.json(config);
  });

  app.post("/api/runner/v1/results", async (c) => {
    const runner = await hello(c, sql);
    if (!runner) return c.json({ error: "unauthorized" }, 401);
    if (Number(c.req.header("content-length") ?? 0) > MAX_RESULTS_BYTES) return c.json({ error: "body too large" }, 413);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_RESULTS_BYTES) return c.json({ error: "body too large" }, 413);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const parsed = parseResultsBody(json);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const [row] = (await sql`select accepted, rejected from runner_submit(${runner.tokenHash}, ${parsed.body.checks}::jsonb, ${parsed.body.reports}::jsonb)`) as { accepted: number; rejected: number }[];
    if (!row) return c.json({ error: "unauthorized" }, 401);
    return c.json({ accepted: row.accepted, rejected: row.rejected + parsed.dropped });
  });
}
