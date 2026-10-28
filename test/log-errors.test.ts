/**
 * Error groups from the logs: the signature that groups entries, paging through a poll window, and the
 * poll against a throwaway database, with a stand-in for the logs cluster that applies the query's
 * filters, sort and size the way Elasticsearch does.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EsClient } from "../src/hub/modules/es/client";
import { groupLogErrors, logErrorSignature, messageShape, pollLogErrors, readErrorEntries, replaceEmails, type LogPollDeps } from "../src/hub/modules/errors/log-poller";
import type { LogRow } from "../src/hub/modules/logs/query";
import { buildWorld, type World } from "./fixtures";
import { createHubTestDb, type TestDb } from "./helpers/db";

const row = (over: Partial<LogRow>): LogRow => ({ id: "x", sourceId: null, ts: 0, level: "ERROR", logger: "a.b.Handler", message: "boom", stack: "", thread: "", traceId: "", transactionId: "", ...over });
const stack = (type: string, line: number) => `${type}: something\n\tat org.example.Svc.run(Svc.java:${line})\n\tat org.example.Web.handle(Web.java:${line + 10})\n`;
/** R2's STOMP handler, the error that had become 47,000 groups. */
const STOMP = "org.springframework.web.socket.messaging.StompSubProtocolHandler";
const stomp = (session: string, signature: string) =>
  `Failed to send message to MessageChannel in session ${session}:Failed to send message to ExecutorSubscribableChannel[clientInboundChannel]; nested exception is grails.plugin.springsecurity.rest.token.storage.TokenNotFoundException: Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.${signature} has expired`;

describe("what makes a group", () => {
  test("one exception from one call path is one group, whatever the message and line numbers say", () => {
    const a = logErrorSignature(row({ message: "Unhandled exception: No static resource public/.env.", stack: stack("org.springframework.web.servlet.resource.NoResourceFoundException", 12) }));
    const b = logErrorSignature(row({ message: "Unhandled exception: No static resource login.", stack: stack("org.springframework.web.servlet.resource.NoResourceFoundException", 14) }));
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^log:[0-9a-f]{40}$/);
    expect(a.type).toBe("org.springframework.web.servlet.resource.NoResourceFoundException");
    expect(a.culprit).toBe("org.example.Svc.run");
    expect(a.message).toBe("Unhandled exception: No static resource public/.env.");
  });

  test("another exception, another call path or another logger is another group", () => {
    const base = logErrorSignature(row({ stack: stack("java.lang.IllegalStateException", 1) }));
    expect(logErrorSignature(row({ stack: stack("java.lang.IllegalArgumentException", 1) })).key).not.toBe(base.key);
    expect(logErrorSignature(row({ stack: "java.lang.IllegalStateException: x\n\tat org.example.Other.run(Other.java:1)\n" })).key).not.toBe(base.key);
    expect(logErrorSignature(row({ logger: "a.b.Other", stack: stack("java.lang.IllegalStateException", 1) })).key).not.toBe(base.key);
  });

  test("framework frames neither split a group nor name its place: the application's own code does", () => {
    const via = (method: string) => [
      "org.springframework.web.servlet.resource.NoResourceFoundException: No static resource x.",
      "\tat org.springframework.web.servlet.resource.ResourceHttpRequestHandler.handleRequest(ResourceHttpRequestHandler.java:585)",
      "\tat org.springframework.web.servlet.mvc.HttpRequestHandlerAdapter.handle(HttpRequestHandlerAdapter.java:52)",
      "\tat org.springframework.web.servlet.DispatcherServlet.doDispatch(DispatcherServlet.java:1089)",
      "\tat org.springframework.web.servlet.DispatcherServlet.doService(DispatcherServlet.java:979)",
      "\tat org.springframework.web.servlet.FrameworkServlet.processRequest(FrameworkServlet.java:1014)",
      `\tat org.springframework.web.servlet.FrameworkServlet.${method}(FrameworkServlet.java:903)`,
    ].join("\n");
    expect(logErrorSignature(row({ stack: via("doGet") })).key).toBe(logErrorSignature(row({ stack: via("doPost") })).key);

    const groovy = (entry: string) => [
      "java.lang.RuntimeException: Auto-tagging failed permanently for upload 25",
      "\tat org.codehaus.groovy.vmplugin.v8.IndyInterface.fromCache(IndyInterface.java:321)",
      "\tat app.modules.fileUploader.upload.AutoTaggingService.loadAutoTaggingData(AutoTaggingService.groovy:88)",
      `\tat app.modules.fileUploader.upload.AutoTaggingService$$SpringCGLIB$$0.${entry}(<generated>)`,
      "\tat app.modules.fileUploader.upload.UploadJob.run(UploadJob.groovy:40)",
    ].join("\n");
    const sig = logErrorSignature(row({ stack: groovy("loadAutoTaggingData") }));
    expect(sig.culprit).toBe("app.modules.fileUploader.upload.AutoTaggingService.loadAutoTaggingData");
    expect(logErrorSignature(row({ stack: groovy("otherProxyMethod") })).key).toBe(sig.key);
  });

  test("without a stack trace the message counts, without its variable parts", () => {
    expect(messageShape("Order 4711 for 'Müller' failed after 3 tries (id 9f2c1e0a-1b2c-4d5e-8f90-123456789abc, mail a.b@c.de)"))
      .toBe("Order <n> for <text> failed after <n> tries (id <id>, mail <email>)");
    const a = logErrorSignature(row({ message: "Order 4711 failed" }));
    expect(logErrorSignature(row({ message: "Order 815 failed\nsecond line differs" })).key).toBe(a.key);
    expect(logErrorSignature(row({ message: "Payment 4711 failed" })).key).not.toBe(a.key);
    expect(a.type).toBeNull();
    expect(a.culprit).toBe("a.b.Handler");
  });

  test("session ids, tokens and object hashes do not split a group, a plain word after 'session' does", () => {
    expect(messageShape(stomp("uymxomlv", "p0Q-7rT"))).toBe(messageShape(stomp("ra35cs03", "Xk3_aZ9")));
    expect(messageShape(stomp("uymxomlv", "p0Q-7rT"))).toContain("in session <id>:Failed");
    expect(messageShape(stomp("uymxomlv", "p0Q-7rT"))).toContain("TokenNotFoundException: Token <token> has expired");
    expect(messageShape("Failed to send client message to application via MessageChannel in session vzmjq3wp. Sending STOMP ERROR to client."))
      .toBe("Failed to send client message to application via MessageChannel in session <id>. Sending STOMP ERROR to client.");
    expect(messageShape("lookup failed for sessionId=ab12cd34ef, token: 9xY7zz81")).toBe("lookup failed for sessionId=<id>, token: <id>");
    expect(messageShape("error on executing request PUT with basex.core.api.pipedrive.PipedriveApiDefinition$RequestData@5c4a5d63 :null"))
      .toBe("error on executing request PUT with basex.core.api.pipedrive.PipedriveApiDefinition$RequestData@<id> :null");
    expect(messageShape("session expired")).toBe("session expired");
    expect(messageShape("session closed")).not.toBe(messageShape("session expired"));
  });

  test("e-mail addresses are found as the plain regex finds them, also one right after another", () => {
    const plain = (s: string) => s.replace(/[^\s@<>]+@[^\s@<>]+\.\w+/g, "<email>");
    for (const s of ["mail a.b@c.de", "x:mail=a.b@c.de,y", "a@b@c.de", "<a@b.de>", "foo@bar", "referer: a@b.de?subject=c_1-0@career.example.com?x", "a@b.c@d.e", "", "@"]) {
      expect(replaceEmails(s)).toBe(plain(s));
    }
    // A long word without "@" is not searched once per position.
    const long = `${"x".repeat(200_000)} a@b.de`;
    const t = performance.now();
    expect(replaceEmails(long)).toBe(`${"x".repeat(200_000)} <email>`);
    expect(performance.now() - t).toBeLessThan(500);
  });

  test("a group counts its entries and is described by the newest one", () => {
    const s = stack("java.lang.IllegalStateException", 1);
    const groups = groupLogErrors([
      row({ id: "1", ts: 1000, message: "first", stack: s }),
      row({ id: "2", ts: 3000, message: "newest", stack: s }),
      row({ id: "3", ts: 2000, message: "middle", stack: s }),
      row({ id: "4", ts: 2500, message: "Order 1 failed" }),
    ]);
    expect(groups.length).toBe(2);
    const g = groups.find((x) => x.info.type)!;
    expect([g.count, g.firstSeen.getTime(), g.lastSeen.getTime(), g.sampleEntryId, g.info.message]).toEqual([3, 1000, 3000, "2", "newest"]);
  });
});

// ── A logs cluster stand-in ──────────────────────────────────────────────────────────────────────

interface Doc { id: string; ts: number; level: string; app?: string; logger?: string; message?: string; stack?: string }

function fakeLogs(docs: Doc[]) {
  const requests: any[] = [];
  const es: EsClient = {
    label: "fake-logs",
    catIndices: async () => [],
    search: async (_index, body: any) => {
      requests.push(body);
      const filters: any[] = body.query.bool.filter;
      const range = filters.find((f) => f.range)?.range["@timestamp"];
      const levels: string[] | undefined = filters.find((f) => f.terms)?.terms["level.keyword"];
      const app = filters.find((f) => f.term)?.term["appname.keyword"];
      const hits = docs
        .filter((d) => (range.gte === undefined || d.ts >= range.gte) && (range.lt === undefined || d.ts < range.lt))
        .filter((d) => !levels || levels.includes(d.level))
        .filter((d) => app === undefined || d.app === app)
        .sort((a, b) => a.ts - b.ts)
        .slice(0, body.size)
        .map((d) => ({ _index: "logstash-shared-2026.10", _id: d.id, sort: [d.ts], _source: { "@timestamp": new Date(d.ts).toISOString(), level: d.level, logger_name: d.logger ?? "a.b.Handler", message: d.message ?? "boom", stack_trace: d.stack, appname: d.app } }));
      return { took: 1, timed_out: false, _shards: { total: 1, successful: 1 }, hits: { hits } } as any;
    },
  };
  return { es, requests };
}

describe("reading a window", () => {
  test("pages split before their last millisecond: nothing twice, nothing skipped", async () => {
    // 7 entries, 3 of them in the same millisecond across the page boundary.
    const docs: Doc[] = [1, 2, 3, 5, 5, 5, 8].map((ts, i) => ({ id: `d${i}`, ts, level: "ERROR" }));
    const { es } = fakeLogs(docs);
    const d: LogPollDeps = { es, now: () => 100, lagMs: 0, pageSize: 4, maxPages: 5 };
    const read = await readErrorEntries(d, { index: "logstash-shared-*" }, 0, 100);
    expect(read.rows.map((r) => r.id).sort()).toEqual(docs.map((x) => x.id).sort());
    expect(read.until).toBe(100);
  });

  test("a millisecond that fills a page alone is taken whole and passed", async () => {
    const docs: Doc[] = [7, 7, 7, 7, 9].map((ts, i) => ({ id: `e${i}`, ts, level: "ERROR" }));
    const { es } = fakeLogs(docs);
    const read = await readErrorEntries({ es, now: () => 100, lagMs: 0, pageSize: 4, maxPages: 5 }, { index: "logstash-shared-*" }, 0, 100);
    expect(read.rows.map((r) => r.id)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
  });

  test("more than the poll may read: it stops where it got to and continues next time", async () => {
    const docs: Doc[] = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, ts: i + 1, level: "ERROR" }));
    const { es } = fakeLogs(docs);
    const read = await readErrorEntries({ es, now: () => 100, lagMs: 0, pageSize: 3, maxPages: 2 }, { index: "logstash-shared-*" }, 0, 100);
    expect(read.rows.map((r) => r.id)).toEqual(["f0", "f1", "f2", "f3"]);
    expect(read.until).toBe(5);
  });
});

// ── The poll, against a throwaway database ───────────────────────────────────────────────────────

describe("polling", () => {
  let db: TestDb;
  let w: World;
  const HOUR = 3600_000;
  const T0 = Date.UTC(2026, 9, 16, 8, 0, 0);
  const docs: Doc[] = [];
  const logs = fakeLogs(docs);
  const poll = (now: number) => pollLogErrors(db.worker, () => {}, { es: logs.es, now: () => now, lagMs: 0 });
  const groups = (env: number) => db.owner`select grouping_key, source, exception_type, occurrences::int as n, status, sample_entry_id from error_groups where environment_id = ${env} order by id` as Promise<any[]>;
  const events = () => db.owner`select environment_id, title, link from events where source = 'errors' order by id` as Promise<any[]>;
  const s = (type: string) => stack(type, 1);

  beforeAll(async () => {
    db = await createHubTestDb();
    w = await buildWorld(db.owner);
    await db.owner`insert into environment_sources (environment_id, kind, name, config) values (${w.envs.shopProd}, 'logs', 'shop', ${{ index: "logstash-shared-*", filterField: "appname.keyword", filterValue: "shop" }}::jsonb)`;
    await db.owner`insert into environment_sources (environment_id, kind, name, config) values (${w.envs.mineProd}, 'logs', 'mine', ${{ index: "logstash-mine-*", errorGroups: false }}::jsonb)`;
  });
  afterAll(() => db.drop());

  test("the first poll takes in the last 24 hours silently, only this application's ERROR entries", async () => {
    docs.push(
      { id: "a1", ts: T0 - 2 * HOUR, level: "ERROR", app: "shop", stack: s("java.lang.IllegalStateException") },
      { id: "a2", ts: T0 - HOUR, level: "ERROR", app: "shop", stack: s("java.lang.IllegalStateException") },
      { id: "w1", ts: T0 - HOUR, level: "WARN", app: "shop", stack: s("java.lang.IllegalStateException") },
      { id: "o1", ts: T0 - HOUR, level: "ERROR", app: "other", message: "not ours" },
      { id: "old", ts: T0 - 30 * HOUR, level: "ERROR", app: "shop", message: "too old" },
    );
    await poll(T0);
    const g = await groups(w.envs.shopProd);
    expect(g.length).toBe(1);
    expect(g[0]).toMatchObject({ source: "logs", exception_type: "java.lang.IllegalStateException", n: 2, status: "open", sample_entry_id: "a2" });
    expect(await events()).toEqual([]);
    // errorGroups: false — the mine environment is never asked.
    expect(logs.requests.every((r) => JSON.stringify(r).includes('"appname.keyword":"shop"'))).toBe(true);
    expect(await groups(w.envs.mineProd)).toEqual([]);
  });

  test("afterwards a new error is a new group with an event, a known one only counts up", async () => {
    docs.push(
      { id: "a3", ts: T0 + 10_000, level: "ERROR", app: "shop", stack: s("java.lang.IllegalStateException") },
      { id: "b1", ts: T0 + 20_000, level: "FATAL", app: "shop", stack: s("java.lang.OutOfMemoryError") },
    );
    await poll(T0 + 60_000);
    const g = await groups(w.envs.shopProd);
    expect(g.map((x) => [x.exception_type, x.n])).toEqual([["java.lang.IllegalStateException", 3], ["java.lang.OutOfMemoryError", 1]]);
    const ev = await events();
    expect(ev.length).toBe(1);
    expect(ev[0].title).toBe("Neuer Fehler: java.lang.OutOfMemoryError: boom");
    expect(ev[0].link).toMatch(new RegExp(`^/env/${w.envs.shopProd}/errors/\\d+$`));
  });

  test("a group marked as done opens again when it comes back, with an event", async () => {
    await db.owner`update error_groups set status = 'resolved' where exception_type = 'java.lang.OutOfMemoryError'`;
    docs.push({ id: "b2", ts: T0 + 70_000, level: "ERROR", app: "shop", stack: s("java.lang.OutOfMemoryError") });
    await poll(T0 + 120_000);
    const g = (await groups(w.envs.shopProd)).find((x) => x.exception_type === "java.lang.OutOfMemoryError");
    expect([g.status, g.n, g.sample_entry_id]).toEqual(["open", 2, "b2"]);
    expect((await events()).at(-1).title).toBe("Fehler wieder aufgetreten: java.lang.OutOfMemoryError: boom");
  });

  test("a burst of new groups is one event, not dozens", async () => {
    const before = (await events()).length;
    for (let i = 0; i < 15; i++) docs.push({ id: `c${i}`, ts: T0 + 130_000 + i, level: "ERROR", app: "shop", message: `Failure kind ${String.fromCharCode(97 + i)}` });
    await poll(T0 + 180_000);
    const ev = (await events()).slice(before);
    expect(ev.length).toBe(1);
    expect(ev[0].title).toBe("15 neue oder wieder aufgetretene Fehler");
    expect(ev[0].link).toBe(`/env/${w.envs.shopProd}/errors`);
  });

  const newErrors = (prefix: string, n: number, ts: number) => {
    for (let i = 0; i < n; i++) docs.push({ id: `${prefix}${i}`, ts: ts + i, level: "ERROR", app: "shop", message: `${prefix} kind ${String.fromCharCode(97 + i)}` });
  };

  test("after a summary the environment stays quiet for the hour, and the errors page still gets every group", async () => {
    const [eventsBefore, groupsBefore] = [(await events()).length, (await groups(w.envs.shopProd)).length];
    newErrors("Quiet", 2, T0 + 190_000);
    await poll(T0 + 240_000);
    expect((await events()).length).toBe(eventsBefore);
    expect((await groups(w.envs.shopProd)).length).toBe(groupsBefore + 2);
  });

  test("an hour later single events come again, and they count towards the next hour's limit", async () => {
    await db.owner`update events set at = at - interval '61 minutes' where source = 'errors'`;
    const before = (await events()).length;
    newErrors("Late", 2, T0 + 250_000);
    await poll(T0 + 300_000);
    expect((await events()).slice(before).map((e) => e.title)).toEqual(["Neuer Fehler: Late kind a", "Neuer Fehler: Late kind b"]);
    newErrors("Wave", 9, T0 + 310_000);
    await poll(T0 + 360_000);
    const ev = (await events()).slice(before + 2);
    expect(ev.map((e) => e.title)).toEqual(["9 neue oder wieder aufgetretene Fehler"]);
  });
});
