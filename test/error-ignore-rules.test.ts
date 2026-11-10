/**
 * Ignore rules for errors (#69811): which patterns are refused, the pattern "Ähnliche ignorieren"
 * suggests, the poll dropping matched groups (no group, no event, the rule counts them) for an
 * environment or its whole project, and who may read and write rules.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { compileRule, patternProblem, ruleMatches, suggestPattern } from "../src/hub/modules/errors/ignore-rules";
import { recordGroups, type PolledGroup } from "../src/hub/modules/errors/poller";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const STOMP_TYPE = "org.springframework.messaging.MessageDeliveryException";
const stomp = (session: string, signature: string) =>
  `Failed to send message to MessageChannel in session ${session}:Failed to send message to ExecutorSubscribableChannel[clientInboundChannel]; nested exception is grails.plugin.springsecurity.rest.token.storage.TokenNotFoundException: Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.${signature} has expired`;

describe("patterns", () => {
  test("empty, too long, broken, catastrophic and match-everything patterns are refused", () => {
    expect(patternProblem("")).toMatch(/angeben/);
    expect(patternProblem("a".repeat(301))).toMatch(/zu lang/);
    expect(patternProblem("in session (")).toMatch(/Kein gültiger/);
    expect(patternProblem("(a+)+$")).toMatch(/Verschachtelte/);
    expect(patternProblem("(?:\\w+\\s?)*x")).toMatch(/Verschachtelte/);
    expect(patternProblem("(\\d{2,})+")).toMatch(/Verschachtelte/);
    expect(patternProblem(".*")).toMatch(/leeren Text/);
    expect(patternProblem("x?")).toMatch(/leeren Text/);
    expect(patternProblem("^Failed to send message to MessageChannel in session \\S+")).toBeNull();
    expect(patternProblem("(foo|bar)+ baz")).toBeNull();
  });

  test("a rule looks at the title (type and message) and the place, case-insensitively", () => {
    const re = compileRule("tokennotfound")!;
    expect(ruleMatches(re, { exception_type: null, message: stomp("a1b2c3d4", "x"), culprit: null })).toBe(true);
    expect(ruleMatches(compileRule("^MessageDeliveryException")!, { exception_type: "MessageDeliveryException", message: "boom", culprit: null })).toBe(true);
    expect(ruleMatches(compileRule("StompSubProtocolHandler")!, { exception_type: null, message: "boom", culprit: "org.springframework.web.socket.messaging.StompSubProtocolHandler" })).toBe(true);
    expect(ruleMatches(re, { exception_type: null, message: "Crawler Data not found for: Lagerist", culprit: "a.b.Crawler" })).toBe(false);
  });

  test("the suggestion for a group takes the next session, token and number too, but not another message", () => {
    const suggestion = suggestPattern({ exception_type: STOMP_TYPE, message: stomp("uymxomlv", "abc") });
    expect(patternProblem(suggestion)).toBeNull();
    expect(suggestion.length).toBeLessThanOrEqual(110);
    const re = compileRule(suggestion)!;
    expect(ruleMatches(re, { exception_type: STOMP_TYPE, message: stomp("ra35cs03", "Zx9-_q"), culprit: null })).toBe(true);
    expect(ruleMatches(re, { exception_type: STOMP_TYPE, message: "Failed to send message to MessageChannel because the broker is down", culprit: null })).toBe(false);

    const order = compileRule(suggestPattern({ exception_type: null, message: "can't send order 1181545 to CS due to response status: null" }))!;
    expect(ruleMatches(order, { exception_type: null, message: "can't send order 99 to CS due to response status: null", culprit: null })).toBe(true);
    expect(ruleMatches(order, { exception_type: null, message: "can't send invoice 99 to CS due to response status: null", culprit: null })).toBe(false);

    expect(suggestPattern({ exception_type: "java.lang.IllegalStateException", message: null })).toBe("java\\.lang\\.IllegalStateException");
  });
});

describe("polling with rules", () => {
  let db: TestDb;
  let w: World;
  const group = (key: string, message: string, count = 1): PolledGroup => ({
    key, count, firstSeen: new Date(Date.now() - 60_000), lastSeen: new Date(),
    info: { type: STOMP_TYPE, message, culprit: "a.b.Handler", handled: null },
  });
  const groups = async (envId: number) => (await db.owner`select grouping_key from error_groups where environment_id = ${envId} order by grouping_key`) as { grouping_key: string }[];
  const events = async (envId: number) => (await db.owner`select title from events where source = 'errors' and environment_id = ${envId}`) as { title: string }[];
  const rule = async (projectId: number, envId: number | null, pattern: string) =>
    ((await db.owner`insert into error_ignore_rules (project_id, environment_id, pattern) values (${projectId}, ${envId}, ${pattern}) returning id`) as { id: number }[])[0]!.id;
  const counter = async (id: number) =>
    ((await db.owner`select matched::int as matched, last_matched_at from error_ignore_rules where id = ${id}`) as { matched: number; last_matched_at: Date | null }[])[0]!;

  beforeAll(async () => {
    db = await createHubTestDb();
    w = await buildWorld(db.owner);
  });
  afterAll(() => db.drop());

  test("a matched group is neither stored nor announced, and its rule counts the occurrences", async () => {
    const id = await rule(w.projects.shop, w.envs.shopProd, "in session \\S+:Failed to send");
    const written = await db.worker.begin((tx) => recordGroups(tx, w.envs.shopProd, "logs", [
      group("log:s1", stomp("aaaa1111", "x"), 3),
      group("log:s2", stomp("bbbb2222", "y"), 2),
      group("log:other", "Crawler Data not found for: Lagerist"),
    ], -Infinity));
    expect(written).toBe(1);
    expect(await groups(w.envs.shopProd)).toEqual([{ grouping_key: "log:other" }]);
    expect((await events(w.envs.shopProd)).map((e) => e.title)).toEqual([`Neuer Fehler: ${STOMP_TYPE}: Crawler Data not found for: Lagerist`]);
    const c = await counter(id);
    expect(c.matched).toBe(5);
    expect(c.last_matched_at).not.toBeNull();
  });

  test("a project-wide rule holds for every environment of its project and for no other project", async () => {
    await rule(w.projects.mine, null, "^MessageDeliveryException|Crawler Data");
    await rule(w.projects.mine, null, "Crawler Data");
    await db.worker.begin((tx) => recordGroups(tx, w.envs.mineProd, "logs", [group("log:c", "Crawler Data not found for: Hauer")], -Infinity));
    await db.worker.begin((tx) => recordGroups(tx, w.envs.mineTest, "logs", [group("log:c", "Crawler Data not found for: Steiger")], -Infinity));
    await db.worker.begin((tx) => recordGroups(tx, w.envs.crmProd, "logs", [group("log:c", "Crawler Data not found for: Vertrieb")], -Infinity));
    expect(await groups(w.envs.mineProd)).toEqual([]);
    expect(await groups(w.envs.mineTest)).toEqual([]);
    expect(await groups(w.envs.crmProd)).toEqual([{ grouping_key: "log:c" }]);
    // An occurrence is counted once, on the first rule that matches it.
    const counts = (await db.owner`select pattern, matched::int as matched from error_ignore_rules where project_id = ${w.projects.mine} order by id`) as any[];
    expect(counts).toEqual([{ pattern: "^MessageDeliveryException|Crawler Data", matched: 2 }, { pattern: "Crawler Data", matched: 0 }]);
  });

  test("a rule of another environment in the same project does not apply", async () => {
    await rule(w.projects.shop, w.envs.shopStage, "nur auf Stage");
    await db.worker.begin((tx) => recordGroups(tx, w.envs.shopProd, "apm", [group("apm:1", "Fehler nur auf Stage erwartet")], -Infinity));
    expect((await groups(w.envs.shopProd)).map((g) => g.grouping_key)).toContain("apm:1");
  });

  test("everyone with diagnostics reads the rules of the environments they see; only admins write", async () => {
    const read = (user: number) => asUser(db.hub, user, (tx) => tx`select environment_id, project_id from error_ignore_rules order by id`) as Promise<any[]>;
    // bob: diagnostics on the whole mine project, so its project-wide rules.
    expect((await read(w.bobBergbauDiagnostics)).every((r) => r.project_id === w.projects.mine)).toBe(true);
    expect(await read(w.bobBergbauDiagnostics)).toHaveLength(2);
    // carol: diagnostics on shop stage only, so the stage rule but not the prod one.
    expect(await read(w.carolStageOnly)).toEqual([{ environment_id: w.envs.shopStage, project_id: w.projects.shop }]);
    // alice: overview only, no errors, so no rules either.
    expect(await read(w.aliceNordwindShopOverview)).toEqual([]);
    expect(await read(w.admin)).toHaveLength(4);

    await expect(asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`
      insert into error_ignore_rules (project_id, environment_id, pattern) values (${w.projects.mine}, ${w.envs.mineProd}, 'x')`)).rejects.toThrow();
    expect(await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`delete from error_ignore_rules returning id`)).toHaveLength(0);
    // The hub cannot rewrite a rule or its counter, not even as admin; the worker counts.
    await expect(asUser(db.hub, w.admin, (tx) => tx`update error_ignore_rules set matched = 0`)).rejects.toThrow();
    const [made] = (await asUser(db.hub, w.admin, (tx) => tx`
      insert into error_ignore_rules (project_id, environment_id, pattern, created_by) values (${w.projects.crm}, ${w.envs.crmProd}, 'y', ${w.admin}) returning id`)) as any[];
    expect(await asUser(db.hub, w.admin, (tx) => tx`delete from error_ignore_rules where id = ${made.id} returning id`)).toHaveLength(1);
  });
});
