import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { enqueueEvent, setAlert } from "../src/ops/alerts";
import { backoffMs, classifyStatus, OutboxSender } from "../src/ops/outbox";
import { createOpsHarness, flashOf, type OpsHarness } from "./helpers/ops";

// A stub hub: answers per subject, records what arrived. Never the real hub.
const received: { auth: string | null; body: any }[] = [];
let respond: (body: any) => Response = () => Response.json({ id: 1 }, { status: 202 });
let hub: Server<undefined>;
let h: OpsHarness;
const TOKEN = `vop_${"a".repeat(43)}`;

beforeAll(async () => {
  hub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/api/internal/v1/events" || req.method !== "POST") return new Response("nope", { status: 404 });
      const body = await req.json();
      received.push({ auth: req.headers.get("authorization"), body });
      return respond(body);
    },
  });
  h = await createOpsHarness({ config: () => ({ hubUrl: `http://127.0.0.1:${hub.port}`, hubEventToken: TOKEN }) });
});
afterAll(async () => {
  await h.close();
  hub.stop(true);
});

const sender = () => new OutboxSender(h.sql, { hubUrl: `http://127.0.0.1:${hub.port}`, token: TOKEN });
const statuses = async () => ((await h.sql`select subject, status, attempts, last_error from outbox order by id`) as any[]);
const event = (subject: string) => ({ subject, state: "notice" as const, severity: "info" as const, title: `T ${subject}` });

describe("classification", () => {
  test("2xx sent; 429 and 5xx retry; every other 4xx is permanent", () => {
    expect(classifyStatus(202)).toBe("sent");
    expect(classifyStatus(429)).toBe("retry");
    expect(classifyStatus(500)).toBe("retry");
    expect(classifyStatus(503)).toBe("retry");
    expect(classifyStatus(400)).toBe("permanent");
    expect(classifyStatus(401)).toBe("permanent");
    expect(classifyStatus(404)).toBe("permanent");
  });

  test("backoff doubles from 10 s and stops at one hour", () => {
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(2)).toBe(20_000);
    expect(backoffMs(5)).toBe(160_000);
    expect(backoffMs(30)).toBe(3_600_000);
  });
});

describe("delivery to a stub hub", () => {
  test("sends the contract fields with the bearer token and records the hub id", async () => {
    received.length = 0;
    respond = () => Response.json({ id: 77 }, { status: 202 });
    await setAlert(h.sql, "host:web1:memory", { severity: "critical", title: "web1: Arbeitsspeicher kritisch", body: "98 %", link: "http://ops.test/hosts/1", environment: "nordwind/shop/prod" });
    await sender().flush();
    expect(received).toEqual([
      {
        auth: `Bearer ${TOKEN}`,
        body: { subject: "host:web1:memory", state: "firing", severity: "critical", title: "web1: Arbeitsspeicher kritisch", body: "98 %", link: "http://ops.test/hosts/1", environment: "nordwind/shop/prod" },
      },
    ]);
    const [row] = (await h.sql`select status, hub_event_id, sent_at from outbox`) as any[];
    expect(row.status).toBe("sent");
    expect(row.hub_event_id).toBe("77");
    expect(row.sent_at).not.toBeNull();
  });

  test("a permanent failure marks that event failed and delivery continues with the next", async () => {
    await h.sql`delete from outbox`;
    received.length = 0;
    respond = (b) => (b.subject === "bad" ? Response.json({ error: "subject and title are required" }, { status: 400 }) : Response.json({ id: 2 }, { status: 202 }));
    await h.sql.begin(async (tx) => {
      await enqueueEvent(tx, event("one"));
      await enqueueEvent(tx, event("bad"));
      await enqueueEvent(tx, event("three"));
    });
    await sender().flush();
    expect(await statuses()).toEqual([
      { subject: "one", status: "sent", attempts: 1, last_error: null },
      { subject: "bad", status: "failed", attempts: 1, last_error: 'HTTP 400: {"error":"subject and title are required"}' },
      { subject: "three", status: "sent", attempts: 1, last_error: null },
    ]);
  });

  test("401 is permanent too (wrong token), kept for inspection", async () => {
    await h.sql`delete from outbox`;
    respond = () => new Response(null, { status: 401 });
    await h.sql.begin((tx) => enqueueEvent(tx, event("x")));
    await sender().flush();
    expect((await statuses())[0]).toMatchObject({ status: "failed", last_error: "HTTP 401" });
  });

  test("a retryable failure stops the batch, keeps order and backs off", async () => {
    await h.sql`delete from outbox`;
    received.length = 0;
    let calls = 0;
    respond = () => (++calls === 1 ? new Response("busy", { status: 503 }) : Response.json({ id: calls }, { status: 202 }));
    await h.sql.begin(async (tx) => {
      await enqueueEvent(tx, { ...event("s"), state: "firing", severity: "warning" });
      await enqueueEvent(tx, { ...event("s"), state: "resolved", severity: "warning" });
    });
    const s = sender();
    await s.flush();
    expect(received).toHaveLength(1);
    expect(await statuses()).toEqual([
      { subject: "s", status: "pending", attempts: 1, last_error: "HTTP 503: busy" },
      { subject: "s", status: "pending", attempts: 0, last_error: null },
    ]);
    expect(s.backoffUntil!.getTime()).toBeGreaterThan(Date.now() + 5_000);
    // During the backoff nothing is sent, even when woken.
    s.wake();
    await s.flush();
    expect(received).toHaveLength(1);
    // After it, both go out in their original order.
    (s as any).notBefore = 0;
    await s.flush();
    expect(received.slice(1).map((r) => r.body.state)).toEqual(["firing", "resolved"]);
    expect((await statuses()).map((r) => r.status)).toEqual(["sent", "sent"]);
  });

  test("429 and network errors are retryable", async () => {
    await h.sql`delete from outbox`;
    respond = () => new Response(null, { status: 429 });
    await h.sql.begin((tx) => enqueueEvent(tx, event("rate")));
    await sender().flush();
    expect((await statuses())[0]).toMatchObject({ status: "pending", attempts: 1 });
    const offline = new OutboxSender(h.sql, { hubUrl: "http://127.0.0.1:9", token: TOKEN });
    await offline.flush();
    expect((await statuses())[0]).toMatchObject({ status: "pending", attempts: 2 });
    expect((await statuses())[0].last_error).toStartWith("network:");
  });

  test("without OPS_HUB_EVENT_TOKEN nothing is sent and the dashboard warns", async () => {
    await h.sql`delete from outbox`;
    received.length = 0;
    await h.sql.begin((tx) => enqueueEvent(tx, event("kept")));
    const unconfigured = new OutboxSender(h.sql, { hubUrl: `http://127.0.0.1:${hub.port}`, token: undefined });
    await unconfigured.flush();
    expect(received).toHaveLength(0);
    expect((await statuses())[0].status).toBe("pending");

    const noToken = await createOpsHarness({ config: () => ({ hubEventToken: undefined }) });
    try {
      const page = await (await noToken.request("/", { cookie: noToken.users.viewer.cookie })).text();
      expect(page).toContain("OPS_HUB_EVENT_TOKEN");
      expect(page).toContain("Ereignisse gehen nicht an den Hub");
    } finally {
      await noToken.close();
    }
  });

  test("only the newest event of a subject can be resent (an old firing must not overtake its resolved)", async () => {
    await h.sql`delete from outbox`;
    await h.sql.begin(async (tx) => {
      await enqueueEvent(tx, { ...event("dup"), state: "firing", severity: "warning" });
      await enqueueEvent(tx, { ...event("dup"), state: "resolved", severity: "warning" });
    });
    await h.sql`update outbox set status = 'failed'`;
    const [older, newer] = (await h.sql`select id from outbox order by id`) as { id: number }[];
    expect(flashOf(await h.request(`/events/${older!.id}/retry`, { cookie: h.users.admin.cookie, method: "POST" }))?.kind).toBe("bad");
    expect(flashOf(await h.request(`/events/${newer!.id}/retry`, { cookie: h.users.admin.cookie, method: "POST" }))?.kind).toBe("ok");
    expect(((await h.sql`select status from outbox order by id`) as any[]).map((r) => r.status)[0]).toBe("failed");
  });
});

describe("alert state", () => {
  test("setAlert sends firing once, firing again on a severity change, resolved once", async () => {
    await h.sql`delete from outbox`;
    await h.sql`delete from alerts`;
    const spec = (severity: "warning" | "critical") => ({ severity, title: `x ${severity}` });
    expect(await setAlert(h.sql, "s1", spec("warning"))).toBe("fired");
    expect(await setAlert(h.sql, "s1", spec("warning"))).toBe(null);
    expect(await setAlert(h.sql, "s1", spec("critical"))).toBe("escalated");
    expect(await setAlert(h.sql, "s1", spec("warning"))).toBe("escalated");
    expect(await setAlert(h.sql, "s1", null)).toBe("resolved");
    expect(await setAlert(h.sql, "s1", null)).toBe(null);
    const rows = (await h.sql`select state, severity from outbox order by id`) as any[];
    expect(rows).toEqual([
      { state: "firing", severity: "warning" },
      { state: "firing", severity: "critical" },
      { state: "firing", severity: "warning" },
      { state: "resolved", severity: "warning" },
    ]);
  });

  test("long subjects and texts are cut to the hub's limits", async () => {
    await h.sql`delete from outbox`;
    const { subjectOf } = await import("../src/ops/alerts");
    const subject = subjectOf("host", "web1", `disk:/${"x".repeat(300)}`);
    expect(subject.length).toBeLessThanOrEqual(200);
    expect(subjectOf("host", "web1", `disk:/${"x".repeat(300)}`)).toBe(subject);
    expect(subjectOf("host", "web1", `disk:/${"x".repeat(301)}`)).not.toBe(subject);
    await setAlert(h.sql, subject, { severity: "warning", title: "t".repeat(400), body: "b".repeat(5000) });
    const [row] = (await h.sql`select length(title) as t, length(body) as b from outbox`) as any[];
    expect(row).toEqual({ t: 300, b: 4000 });
  });
});
