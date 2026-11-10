/**
 * The Wazuh sync against the dev Elasticsearch (docker/compose.dev.yml, :5461) with a throwaway
 * vulnerability index and agent names of its own, so seeded dev data never interferes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpEsClient } from "../src/hub/modules/es/client";
import { syncSecurity } from "../src/hub/modules/security/sync";
import { listWazuhAgents, parseWazuhConfig, WAZUH_SYNC_EVERY_MS } from "../src/hub/modules/security/wazuh";
import { DEV_ES, es, recreateIndex } from "../scripts/es-dev";
import { createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const RUN = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const INDEX = `wazuh-states-vulnerabilities-test-${RUN}`;
const AGENT = `agent-${RUN}`;
const client = new HttpEsClient({ label: "Dev-ES", connection: { url: DEV_ES }, timeoutMs: 10_000 });
const noDt = { listProjects: async () => [], getProject: async () => { throw new Error("unused"); }, getFindings: async () => [] };
let db: TestDb;
let w: World;

const kw = { type: "keyword" };
async function vuln(pkg: string, id: string, severity: string, score: number | null) {
  await es("POST", `/${INDEX}/_doc?refresh=true`, {
    agent: { id: "099", name: AGENT },
    host: { os: { full: "Ubuntu 24.04.1 LTS" } },
    package: { name: pkg, version: "1.0" },
    vulnerability: { id, severity, score: { base: score }, description: `${id} description\nsecond line` },
  });
}
const sync = () => syncSecurity(db.worker, () => {}, noDt, Date.now() + WAZUH_SYNC_EVERY_MS + 1000, client);

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
  await recreateIndex(INDEX, {
    properties: {
      agent: { properties: { id: kw, name: kw } },
      host: { properties: { os: { properties: { full: kw } } } },
      package: { properties: { name: kw, version: kw } },
      vulnerability: { properties: { id: kw, severity: kw, score: { properties: { base: { type: "float" } } } } },
    },
  });
  await vuln("openssl", "CVE-2026-0001", "Critical", 9.8);
  await vuln("linux-image", "CVE-2026-0002", "High", 7.8);
  await vuln("vim", "CVE-2026-0003", "Medium", 5.5);
  await vuln("vim", "CVE-2026-0004", "-", null);
  await db.owner`insert into environment_sources (environment_id, kind, config) values (${w.envs.shopProd}, 'wazuh', ${{ agents: [AGENT] }}::jsonb)`;
});
afterAll(async () => {
  await es("DELETE", `/${INDEX}`);
  await db.drop();
});

const open = async () => (await db.owner`select vuln_id, severity, component, target from security_findings where source = 'wazuh' and resolved_at is null order by vuln_id`) as any[];
const notices = async () => (await db.owner`select title, body from events where source = 'security'`) as any[];

describe("Wazuh vulnerabilities", () => {
  test("the agent shows up in the picker", async () => {
    expect((await listWazuhAgents(client)).find((a) => a.name === AGENT)).toEqual({ name: AGENT, id: "099", os: "Ubuntu 24.04.1 LTS" });
  });

  test("first sync: critical and high stored one by one, all severities counted, no notice", async () => {
    await sync();
    expect(await open()).toEqual([
      { vuln_id: "CVE-2026-0001", severity: "critical", component: "openssl", target: AGENT },
      { vuln_id: "CVE-2026-0002", severity: "high", component: "linux-image", target: AGENT },
    ]);
    const [a] = (await db.owner`select os, counts from security_agents`) as any[];
    expect(a.os).toBe("Ubuntu 24.04.1 LTS");
    expect(a.counts).toEqual({ critical: 1, high: 1, medium: 1, low: 0, unassigned: 1 });
    expect(await notices()).toEqual([]);
  });

  test("later: a new critical one becomes a notice, a vanished one is resolved, new highs stay quiet", async () => {
    await es("POST", `/${INDEX}/_delete_by_query?refresh=true`, { query: { term: { "vulnerability.id": "CVE-2026-0002" } } });
    await vuln("libexpat1", "CVE-2026-0005", "Critical", 9.1);
    await vuln("curl", "CVE-2026-0006", "High", 7.5);
    await sync();
    expect((await open()).map((f) => f.vuln_id)).toEqual(["CVE-2026-0001", "CVE-2026-0005", "CVE-2026-0006"]);
    const n = await notices();
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe(`1 neue kritische Schwachstelle auf ${AGENT}`);
    expect(n[0].body).toBe("Betroffene Pakete: libexpat1 1.0");
  });

  test("unmapping the agent drops its findings", async () => {
    await db.owner`update environment_sources set config = ${{ agents: ["someone-else"] }}::jsonb where kind = 'wazuh'`;
    await sync();
    expect(await open()).toEqual([]);
    expect((await db.owner`select agent_name from security_agents`) as any[]).toEqual([{ agent_name: "someone-else" }]);
  });

  test("agent names are validated before they reach a query", () => {
    expect(parseWazuhConfig({ agents: ["web-01.example", "web-01.example"] })).toEqual(["web-01.example"]);
    expect(parseWazuhConfig({ agents: ['x" OR *'] })).toBeNull();
    expect(parseWazuhConfig({ agents: [] })).toBeNull();
  });
});
