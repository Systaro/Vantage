import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { requiredLevel } from "../src/hub/modules/alerts/engine";
import { parseDependencyTrackConfig, severityOf, type DtApi, type DtFinding } from "../src/hub/modules/security/dependency-track";
import { syncSecurity, SYNC_EVERY_MS } from "../src/hub/modules/security/sync";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const PROJECT = "0b2f4b0e-7c1a-4f7e-9a51-1f2d3c4b5a60";
const OTHER = "9d8c7b6a-5f4e-4d3c-8b2a-1a0b9c8d7e6f";
let db: TestDb;
let w: World;
let securityUser: number;

function finding(component: string, vuln: string, severity: string, extra: Partial<DtFinding["analysis"]> = {}): DtFinding {
  return {
    component: { uuid: `c-${component}`, name: component, version: "1.0" },
    vulnerability: { uuid: `v-${vuln}`, vulnId: vuln, severity, cvssV3BaseScore: severity === "CRITICAL" ? 9.8 : 7.5, title: `${vuln} title` },
    analysis: { isSuppressed: false, ...extra },
  };
}

function fakeApi(findings: () => DtFinding[], fail = false): DtApi {
  return {
    listProjects: async () => [],
    getProject: async (uuid) => ({ uuid, name: uuid === PROJECT ? "shop-backend" : "other", version: "main", lastBomImport: Date.now() }),
    getFindings: async () => {
      if (fail) throw new (await import("../src/hub/modules/security/dependency-track")).DtError("Dependency-Track antwortet mit HTTP 500.");
      return findings();
    },
  };
}

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
  const [u] = (await db.owner`insert into users (email, name, kind) values ('sec@nordwind.example', 'Sec', 'customer') returning id`) as { id: number }[];
  securityUser = u!.id;
  await db.owner`insert into grants (user_id, project_id, level) values (${securityUser}, ${w.projects.shop}, 'security')`;
  await db.owner`insert into environment_sources (environment_id, kind, config) values (${w.envs.shopProd}, 'dependency_track', ${{ projects: [PROJECT] }}::jsonb)`;
});
afterAll(() => db.drop());

const events = async () => (await db.owner`select title, body, severity, state from events where source = 'security' order by id`) as any[];
const open = async () => (await db.owner`select vuln_id, severity from security_findings where resolved_at is null order by vuln_id`) as any[];

describe("Dependency-Track sync", () => {
  let current: DtFinding[] = [];
  const api = fakeApi(() => current);
  // attempted_at comes from the database clock; "now" only decides which projects are due.
  const later = () => Date.now() + SYNC_EVERY_MS + 1000;
  const tick = () => syncSecurity(db.worker, () => {}, api, later());

  test("the first sync takes everything over silently", async () => {
    current = [finding("log4j-core", "CVE-2021-44228", "CRITICAL"), finding("jackson", "CVE-2020-1111", "MEDIUM"), finding("old", "CVE-2019-0001", "HIGH", { isSuppressed: true })];
    expect(await tick()).toBe(1);
    expect(await open()).toEqual([{ vuln_id: "CVE-2020-1111", severity: "medium" }, { vuln_id: "CVE-2021-44228", severity: "critical" }]);
    expect(await events()).toEqual([]);
    const [p] = (await db.owner`select name, version, synced_at is not null as synced from security_projects`) as any[];
    expect(p).toEqual({ name: "shop-backend", version: "main", synced: true });
  });

  test("a project is not asked again before it is due", async () => {
    expect(await syncSecurity(db.worker, () => {}, api, Date.now())).toBe(0);
  });

  test("afterwards new serious findings become one notice, gone ones are resolved", async () => {
    current = [finding("log4j-core", "CVE-2021-44228", "CRITICAL"), finding("spring-web", "CVE-2024-2222", "HIGH"), finding("netty", "CVE-2024-3333", "LOW"),
      finding("tomcat", "CVE-2024-4444", "CRITICAL", { state: "NOT_AFFECTED" })];
    await tick();
    expect(await open()).toEqual([{ vuln_id: "CVE-2021-44228", severity: "critical" }, { vuln_id: "CVE-2024-2222", severity: "high" }, { vuln_id: "CVE-2024-3333", severity: "low" }]);
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ title: "1 neue Schwachstelle in shop-backend main", severity: "warning", state: "notice" });
    expect(ev[0].body).toContain("CVE-2024-2222 (hoch, CVSS 7.5) in spring-web 1.0");
    const [resolved] = (await db.owner`select resolved_at is not null as r from security_findings where vuln_id = 'CVE-2020-1111'`) as any[];
    expect(resolved.r).toBe(true);
  });

  test("an unreachable Dependency-Track is recorded, findings stay as they are", async () => {
    await syncSecurity(db.worker, () => {}, fakeApi(() => [], true), later());
    const [p] = (await db.owner`select last_error from security_projects`) as any[];
    expect(p.last_error).toContain("HTTP 500");
    expect(await open()).toHaveLength(3);
  });

  test("unmapping a project drops its state and findings", async () => {
    await db.owner`update environment_sources set config = ${{ projects: [OTHER] }}::jsonb where kind = 'dependency_track'`;
    current = [];
    await tick();
    expect((await db.owner`select project_uuid::text as u from security_projects`) as any[]).toEqual([{ u: OTHER }]);
    expect(await open()).toEqual([]);
    await db.owner`update environment_sources set config = ${{ projects: [PROJECT] }}::jsonb where kind = 'dependency_track'`;
  });
});

describe("who sees vulnerabilities", () => {
  beforeAll(async () => {
    await db.owner`insert into security_findings (environment_id, source, project_uuid, finding_key, target, vuln_id, severity)
                   values (${w.envs.shopProd}, 'dependency_track', ${PROJECT}::uuid, 'k1', 'shop-backend', 'CVE-2025-0001', 'critical')`;
    await db.owner`insert into events (source, environment_id, subject_key, state, severity, title) values ('security', ${w.envs.shopProd}, 'dt:x', 'notice', 'critical', 'neu')`;
  });

  test("levels are cumulative: security is 3, admins have everything", async () => {
    const level = async (user: number) => ((await db.worker`select vantage_level(${user}, ${w.envs.shopProd}) as l`) as { l: number }[])[0]!.l;
    expect(await level(securityUser)).toBe(3);
    expect(await level(w.admin)).toBe(3);
    expect(await level(w.aliceNordwindShopOverview)).toBe(1);
  });

  test("findings, project state and security events need level 3", async () => {
    for (const [user, visible] of [[securityUser, 1], [w.admin, 1], [w.aliceNordwindShopOverview, 0], [w.carolStageOnly, 0], [w.bobBergbauDiagnostics, 0]] as const) {
      expect(await asUser(db.hub, user, (tx) => tx`select id from security_findings where vuln_id = 'CVE-2025-0001'`)).toHaveLength(visible);
      expect(await asUser(db.hub, user, (tx) => tx`select id from events where source = 'security'`)).toHaveLength(visible ? (await events()).length : 0);
    }
    expect(await asUser(db.hub, w.admin, (tx) => tx`select 1 from security_projects`)).not.toHaveLength(0);
    expect(await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select 1 from security_projects`)).toHaveLength(0);
  });

  test("the hub can only read", async () => {
    await expect(asUser(db.hub, w.admin, (tx) => tx`delete from security_findings`)).rejects.toThrow();
  });

  test("mail goes only to users with the security grant", () => {
    expect(requiredLevel("security")).toBe(3);
  });
});

describe("source config", () => {
  test("only valid project UUIDs, at most 20", () => {
    expect(parseDependencyTrackConfig({ projects: [PROJECT.toUpperCase(), PROJECT] })).toEqual([PROJECT]);
    expect(parseDependencyTrackConfig({ projects: ["../admin"] })).toBeNull();
    expect(parseDependencyTrackConfig({ projects: [] })).toBeNull();
    expect(parseDependencyTrackConfig({ projects: Array.from({ length: 21 }, () => PROJECT) })).toBeNull();
    expect(severityOf("INFO")).toBe("low");
    expect(severityOf(undefined)).toBe("unassigned");
  });
});
