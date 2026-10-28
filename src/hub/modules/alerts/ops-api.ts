import type { Hono } from "hono";
import { sha256Hex } from "../../../shared/crypto";
import { hubSql } from "../../db";

const STATES = new Set(["firing", "resolved", "notice"]);
const SEVERITIES = new Set(["critical", "warning", "info"]);
const MAX_BODY = 16 * 1024;

/**
 * `POST /api/internal/v1/events` — the only door from ops into the hub. Write-only: the token can
 * create events and nothing else, and it is verified inside ingest_ops_event().
 */
export function mountOpsEventsApi(app: Hono) {
  app.post("/api/internal/v1/events", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!/^vop_[A-Za-z0-9_-]{43}$/.test(token)) return c.json({ error: "unauthorized" }, 401);
    const [valid] = (await hubSql`select ops_event_token_valid(${sha256Hex(token)}) as ok`) as { ok: boolean }[];
    if (!valid?.ok) return c.json({ error: "unauthorized" }, 401);
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return c.json({ error: "body too large" }, 413);

    let body: any;
    try {
      const text = await c.req.text();
      if (text.length > MAX_BODY) return c.json({ error: "body too large" }, 413);
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const str = (v: unknown, max: number, required: boolean): string | null | undefined => {
      if (v === undefined || v === null) return required ? undefined : null;
      if (typeof v !== "string" || v.length > max || (required && v.length === 0)) return undefined;
      return v;
    };
    const environment = str(body?.environment, 200, false);
    const subject = str(body?.subject, 200, true);
    const title = str(body?.title, 300, true);
    const text = str(body?.body, 4000, false);
    const link = str(body?.link, 1000, false);
    if (environment === undefined || (environment && !/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(environment))) {
      return c.json({ error: "environment must be org/project/env" }, 400);
    }
    if (subject === undefined || title === undefined || text === undefined || link === undefined) {
      return c.json({ error: "subject and title are required; body ≤ 4000, link ≤ 1000 characters" }, 400);
    }
    if (link && !/^https?:\/\//.test(link)) return c.json({ error: "link must be an absolute http(s) URL" }, 400);
    if (!STATES.has(body.state) || !SEVERITIES.has(body.severity)) return c.json({ error: "invalid state or severity" }, 400);

    const [row] = (await hubSql`select ingest_ops_event(${sha256Hex(token)}, ${environment}, ${subject}, ${body.state}, ${body.severity},
                                                       ${title}, ${text}, ${link}) as id`) as { id: string | null }[];
    if (!row?.id) return c.json({ error: "unauthorized" }, 401);
    return c.json({ id: Number(row.id) }, 202);
  });
}
