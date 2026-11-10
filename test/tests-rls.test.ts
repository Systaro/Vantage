import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newToken, sha256Hex } from "../src/shared/crypto";
import { parsePlaywrightReport } from "../src/hub/modules/tests/playwright";
import { purgeReports, reportDir } from "../src/hub/modules/tests/storage";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const parsed = parsePlaywrightReport(await Bun.file(join(import.meta.dir, "fixtures", "playwright-report.json")).json());

let db: TestDb;
let w: World;
const suites: Record<"shopProd" | "shopStage" | "mineProd", { id: number; token: string; run: number }> = {} as any;

async function ingest(token: string, run: Record<string, unknown> = {}): Promise<number | null> {
  const [row] = (await db.hub`select ingest_test_run(${sha256Hex(token)}, ${{ ...parsed.run, ...run }}::jsonb, ${parsed.cases}::jsonb) as id`) as { id: number | null }[];
  return row!.id;
}

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
  for (const env of ["shopProd", "shopStage", "mineProd"] as const) {
    const [s] = (await db.owner`insert into test_suites (environment_id, slug, name) values (${w.envs[env]}, 'e2e', ${`E2E ${env}`}) returning id`) as { id: number }[];
    const token = newToken("vti");
    await db.owner`insert into ingest_tokens (suite_id, name, token_hash, token_prefix) values (${s!.id}, 'ci', ${sha256Hex(token)}, ${token.slice(0, 10)})`;
    suites[env] = { id: s!.id, token, run: (await ingest(token))! };
  }
});
afterAll(() => db.drop());

const runIds = (rows: unknown) => (rows as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);
const visibleRuns = (user: number | null) => asUser(db.hub, user, (tx) => tx`select id from test_runs`).then(runIds);
const sorted = (...ids: number[]) => ids.sort((a, b) => a - b);

describe("test runs are visible only through grants", () => {
  test("Alice (Webshop, overview) sees both Webshop environments and nothing of the Minenportal", async () => {
    expect(await visibleRuns(w.aliceNordwindShopOverview)).toEqual(sorted(suites.shopProd.run, suites.shopStage.run));
    const cases = (await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select distinct run_id from test_cases`)) as { run_id: number }[];
    expect(cases.map((c) => c.run_id).sort((a, b) => a - b)).toEqual(sorted(suites.shopProd.run, suites.shopStage.run));
    const ownSuites = await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select id from test_suites`);
    expect(runIds(ownSuites)).toEqual(sorted(suites.shopProd.id, suites.shopStage.id));
  });

  test("Bob (Minenportal) does not see Webshop runs, cases or suites", async () => {
    expect(await visibleRuns(w.bobBergbauDiagnostics)).toEqual([suites.mineProd.run]);
    expect(await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select id from test_runs where id = ${suites.shopProd.run}`)).toHaveLength(0);
    expect(await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select title from test_cases where run_id = ${suites.shopProd.run}`)).toHaveLength(0);
  });

  test("Carol (Webshop stage only) sees only the stage run", async () => {
    expect(await visibleRuns(w.carolStageOnly)).toEqual([suites.shopStage.run]);
  });

  test("no user context, or staff without grants, sees nothing; admin sees everything", async () => {
    expect(await visibleRuns(null)).toEqual([]);
    expect(await visibleRuns(w.staffNoGrants)).toEqual([]);
    expect(await visibleRuns(w.admin)).toEqual(sorted(suites.shopProd.run, suites.shopStage.run, suites.mineProd.run));
  });
});

describe("writes", () => {
  test("the hub role cannot insert runs or cases directly, not even as admin", async () => {
    await expect(asUser(db.hub, w.admin, (tx) => tx`insert into test_runs (suite_id, environment_id, status) values (${suites.shopProd.id}, ${w.envs.shopProd}, 'passed')`)).rejects.toThrow(/permission denied/);
    await expect(asUser(db.hub, w.admin, (tx) => tx`update test_runs set status = 'passed'`)).rejects.toThrow(/permission denied/);
    await expect(asUser(db.hub, w.admin, (tx) => tx`delete from test_cases`)).rejects.toThrow(/permission denied/);
  });

  test("only admins manage suites and tokens; nobody reads token hashes", async () => {
    const alice = w.aliceNordwindShopOverview;
    await expect(asUser(db.hub, alice, (tx) => tx`insert into test_suites (environment_id, slug, name) values (${w.envs.shopProd}, 'evil', 'Evil')`)).rejects.toThrow();
    expect(await asUser(db.hub, alice, (tx) => tx`update test_suites set name = 'pwned' returning id`)).toHaveLength(0);
    expect(await asUser(db.hub, alice, (tx) => tx`select id from ingest_tokens`)).toHaveLength(0);
    expect(await asUser(db.hub, w.admin, (tx) => tx`select id from ingest_tokens`)).toHaveLength(3);
    await expect(asUser(db.hub, w.admin, (tx) => tx`select token_hash from ingest_tokens`)).rejects.toThrow(/permission denied/);
    const created = await asUser(db.hub, w.admin, (tx) => tx`insert into test_suites (environment_id, slug, name) values (${w.envs.crmProd}, 'smoke', 'Smoke') returning id`);
    expect(created).toHaveLength(1);
  });

  test("a revoked or expired token cannot write, even through the function", async () => {
    await db.owner`update ingest_tokens set revoked_at = now() where token_hash = ${sha256Hex(suites.mineProd.token)}`;
    expect(await ingest(suites.mineProd.token)).toBeNull();
    await db.owner`update ingest_tokens set revoked_at = null, expires_at = now() - interval '1 second' where token_hash = ${sha256Hex(suites.mineProd.token)}`;
    expect(await ingest(suites.mineProd.token)).toBeNull();
    expect(await ingest(newToken("vti"))).toBeNull();
  });
});

describe("purgeReports", () => {
  let storageDir: string;
  const ids = { old: 0, recent: 0, oldNoReport: 0 };

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "vantage-purge-"));
    const token = suites.shopProd.token;
    ids.old = (await ingest(token, { has_report: true }))!;
    ids.recent = (await ingest(token, { has_report: true }))!;
    ids.oldNoReport = (await ingest(token, { has_report: false }))!;
    await db.owner`update test_runs set received_at = now() - interval '91 days' where id in (${ids.old}, ${ids.oldNoReport})`;
    await db.owner`update test_runs set received_at = now() - interval '89 days' where id = ${ids.recent}`;
    for (const id of [ids.old, ids.recent, 999_999]) {
      mkdirSync(join(reportDir(storageDir, id), "data"), { recursive: true });
      writeFileSync(join(reportDir(storageDir, id), "index.html"), "x");
    }
    for (const name of ["upload-stale", "upload-fresh"]) mkdirSync(join(storageDir, "tmp", name), { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(storageDir, "tmp", "upload-stale"), twoHoursAgo, twoHoursAgo);
  });
  afterAll(() => rmSync(storageDir, { recursive: true, force: true }));

  test("removes reports older than 90 days and orphaned report directories, keeps runs and recent reports", async () => {
    const log: string[] = [];
    expect(await purgeReports(db.worker, storageDir, (m) => log.push(m))).toBe(2);
    expect(existsSync(reportDir(storageDir, ids.old))).toBe(false);
    expect(existsSync(reportDir(storageDir, 999_999))).toBe(false);
    expect(existsSync(join(reportDir(storageDir, ids.recent), "index.html"))).toBe(true);
    const rows = (await db.owner`select id, report_purged from test_runs where id in (${ids.old}, ${ids.recent}, ${ids.oldNoReport}) order by id`) as { id: number; report_purged: boolean }[];
    expect(rows.map((r) => [r.id, r.report_purged])).toEqual([[ids.old, true], [ids.recent, false], [ids.oldNoReport, false]]);
    const cases = (await db.owner`select count(*)::int as n from test_cases where run_id = ${ids.old}`) as { n: number }[];
    expect(cases[0]!.n).toBe(parsed.cases.length);
    expect(log.length).toBeGreaterThan(0);
  });

  test("clears upload temp directories older than an hour", () => {
    expect(existsSync(join(storageDir, "tmp", "upload-stale"))).toBe(false);
    expect(existsSync(join(storageDir, "tmp", "upload-fresh"))).toBe(true);
  });

  test("is idempotent and copes with a missing storage directory", async () => {
    expect(await purgeReports(db.worker, storageDir)).toBe(0);
    expect(await purgeReports(db.worker, join(storageDir, "does-not-exist"))).toBe(0);
  });
});
