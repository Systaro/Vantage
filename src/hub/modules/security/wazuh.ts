/**
 * Wazuh, read from its indexer (OpenSearch) through the "wazuh" integration: vulnerability states
 * per agent (synced by the worker) and alerts (read live). Agent names come from an
 * environment_sources row; they only ever reach a query as term values, never as index names.
 */
import type { SQL } from "bun";
import { configuredIndex, EsError, wazuhEs, type EsClient } from "../es/client";
import type { Severity } from "./dependency-track";

export const VULN_INDEX = configuredIndex("wazuh-states-vulnerabilities-*");
export const ALERT_INDEX = configuredIndex("wazuh-alerts-4.x-*");
export const MAX_AGENTS = 20;
/** Vulnerability scans run a few times a day; once an hour is plenty. */
export const WAZUH_SYNC_EVERY_MS = 60 * 60_000;
/** Critical and high findings are stored one by one; this caps one agent (an Ubuntu host has ~3,200). */
const MAX_FINDINGS_PER_AGENT = 10_000;
const AGENT_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export function parseWazuhConfig(raw: unknown): string[] | null {
  const agents = (raw as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents) || agents.length === 0 || agents.length > MAX_AGENTS) return null;
  if (!agents.every((a) => typeof a === "string" && AGENT_NAME.test(a))) return null;
  return [...new Set(agents as string[])];
}

export function wazuhSeverity(value: unknown): Severity {
  switch (String(value ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "unassigned";
  }
}

/** Agents that have vulnerability data, for the picker in the data source dialog. */
export async function listWazuhAgents(es: EsClient = wazuhEs): Promise<{ name: string; id: string; os: string | null }[]> {
  const res = await es.search(VULN_INDEX, {
    size: 0,
    aggs: { agents: { terms: { field: "agent.name", size: 500, order: { _key: "asc" } }, aggs: { info: { top_hits: { size: 1, _source: ["agent.id", "host.os.full"] } } } } },
  });
  return ((res.aggregations?.agents?.buckets ?? []) as any[]).map((b) => {
    const src = b.info?.hits?.hits?.[0]?._source ?? {};
    return { name: String(b.key), id: String(src.agent?.id ?? ""), os: src.host?.os?.full ?? null };
  });
}

interface AgentSnapshot {
  id: string | null;
  os: string | null;
  counts: Record<Severity, number>;
  findings: { key: string; vulnId: string; severity: Severity; cvss: number | null; title: string | null; pkg: string; version: string | null }[];
}

export async function agentSnapshot(es: EsClient, agent: string): Promise<AgentSnapshot> {
  const res = await es.search<any>(VULN_INDEX, {
    size: MAX_FINDINGS_PER_AGENT,
    track_total_hits: true,
    query: { bool: { filter: [{ term: { "agent.name": agent } }, { terms: { "vulnerability.severity": ["Critical", "High"] } }] } },
    _source: ["agent.id", "host.os.full", "package.name", "package.version", "vulnerability.id", "vulnerability.severity", "vulnerability.score.base", "vulnerability.description"],
    aggs: { all: { global: {}, aggs: { mine: { filter: { term: { "agent.name": agent } }, aggs: { severity: { terms: { field: "vulnerability.severity", size: 10 } } } } } } },
  });
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unassigned: 0 };
  for (const b of (res.aggregations?.all?.mine?.severity?.buckets ?? []) as { key: string; doc_count: number }[]) counts[wazuhSeverity(b.key)] += b.doc_count;
  const first = res.hits.hits[0]?._source;
  return {
    id: first?.agent?.id ?? null,
    os: first?.host?.os?.full ?? null,
    counts,
    findings: res.hits.hits.map((h) => {
      const s = h._source;
      const pkg = String(s.package?.name ?? "?");
      const version = s.package?.version ? String(s.package.version) : null;
      const vulnId = String(s.vulnerability?.id ?? "?");
      return {
        key: `${s.agent?.id ?? agent}:${pkg}:${version ?? ""}:${vulnId}`,
        vulnId,
        severity: wazuhSeverity(s.vulnerability?.severity),
        cvss: typeof s.vulnerability?.score?.base === "number" ? s.vulnerability.score.base : null,
        title: typeof s.vulnerability?.description === "string" ? s.vulnerability.description.split("\n")[0]!.slice(0, 300) : null,
        pkg,
        version,
      };
    }),
  };
}

export async function syncAgent(sql: SQL, es: EsClient, envId: number, agent: string): Promise<{ added: number; resolved: number }> {
  const [state] = (await sql`select synced_at from security_agents where environment_id = ${envId} and agent_name = ${agent}`) as { synced_at: Date | null }[];
  let snap: AgentSnapshot;
  try {
    snap = await agentSnapshot(es, agent);
  } catch (err) {
    if (!(err instanceof EsError)) throw err;
    await sql`insert into security_agents (environment_id, agent_name, attempted_at, last_error) values (${envId}, ${agent}, now(), ${err.message})
              on conflict (environment_id, agent_name) do update set attempted_at = now(), last_error = excluded.last_error`;
    return { added: 0, resolved: 0 };
  }
  const firstSync = !state?.synced_at;
  return sql.begin(async (tx) => {
    await tx`insert into security_agents (environment_id, agent_name, agent_id, os, counts, attempted_at, synced_at, last_error)
             values (${envId}, ${agent}, ${snap.id}, ${snap.os}, ${snap.counts}::jsonb, now(), now(), null)
             on conflict (environment_id, agent_name) do update set agent_id = excluded.agent_id, os = excluded.os, counts = excluded.counts,
               attempted_at = now(), synced_at = now(), last_error = null`;
    const keys: string[] = [];
    const added: typeof snap.findings = [];
    for (const f of snap.findings) {
      keys.push(f.key);
      const [row] = (await tx`
        insert into security_findings (environment_id, source, finding_key, target, vuln_id, severity, cvss, title, component, component_version)
        values (${envId}, 'wazuh', ${f.key.slice(0, 500)}, ${agent}, ${f.vulnId.slice(0, 100)}, ${f.severity}, ${f.cvss}, ${f.title}, ${f.pkg.slice(0, 300)}, ${f.version?.slice(0, 100) ?? null})
        on conflict (environment_id, source, finding_key) do update set last_seen_at = now(), resolved_at = null, severity = excluded.severity, cvss = excluded.cvss
        returning (xmax = 0) as inserted`) as { inserted: boolean }[];
      if (row?.inserted && f.severity === "critical") added.push(f);
    }
    const resolved = (await tx`
      update security_findings set resolved_at = now()
      where environment_id = ${envId} and source = 'wazuh' and target = ${agent} and resolved_at is null
        and finding_key <> all(${tx.array(keys.length ? keys : [""], "text")})
      returning id`).length;
    // Kernel and library CVEs arrive in batches; only new critical ones are worth a message.
    if (!firstSync && added.length > 0) {
      const packages = [...new Set(added.map((a) => `${a.pkg} ${a.version ?? ""}`.trim()))];
      await tx`insert into events (source, environment_id, subject_key, state, severity, title, body, link)
               values ('security', ${envId}, ${`wazuh:${agent}`}, 'notice', 'critical',
                       ${`${added.length} ${added.length === 1 ? "neue kritische Schwachstelle" : "neue kritische Schwachstellen"} auf ${agent}`},
                       ${`Betroffene Pakete: ${packages.slice(0, 10).join(", ")}${packages.length > 10 ? ` und ${packages.length - 10} weitere` : ""}`},
                       ${`/env/${envId}/security`})`;
    }
    return { added: added.length, resolved };
  });
}

/** Alerts of the mapped agents for the security tab, read live. */
export async function agentAlerts(agents: string[], es: EsClient = wazuhEs) {
  const scope = { terms: { "agent.name": agents } };
  const [day, newest] = await Promise.all([
    es.search<any>(ALERT_INDEX, {
      size: 15,
      track_total_hits: true,
      sort: [{ timestamp: { order: "desc", unmapped_type: "date" } }],
      _source: ["timestamp", "agent.name", "rule.level", "rule.description", "rule.id"],
      query: { bool: { filter: [scope, { range: { timestamp: { gte: "now-24h" } } }, { range: { "rule.level": { gte: 10 } } }] } },
      aggs: {
        all: {
          global: {},
          aggs: {
            mine: {
              filter: { bool: { filter: [scope, { range: { timestamp: { gte: "now-24h" } } }] } },
              aggs: {
                levels: { range: { field: "rule.level", ranges: [{ key: "low", to: 7 }, { key: "medium", from: 7, to: 12 }, { key: "high", from: 12 }] } },
                rules: { terms: { field: "rule.description", size: 8 }, aggs: { level: { max: { field: "rule.level" } } } },
              },
            },
          },
        },
      },
    }),
    es.search<any>(ALERT_INDEX, { size: 0, query: { bool: { filter: [scope] } }, aggs: { newest: { max: { field: "timestamp" } } } }),
  ]);
  const mine = day.aggregations?.all?.mine;
  return {
    total: (mine?.doc_count as number | undefined) ?? 0,
    levels: Object.fromEntries(((mine?.levels?.buckets ?? []) as any[]).map((b) => [b.key, b.doc_count])) as Record<"low" | "medium" | "high", number>,
    rules: ((mine?.rules?.buckets ?? []) as any[]).map((b) => ({ description: String(b.key), count: b.doc_count as number, level: Number(b.level?.value ?? 0) })),
    serious: day.hits.hits.map((h) => ({ at: h._source.timestamp as string, agent: h._source.agent?.name as string, level: Number(h._source.rule?.level ?? 0), description: String(h._source.rule?.description ?? "") })),
    newestAt: (newest.aggregations?.newest?.value_as_string as string | undefined) ?? null,
  };
}
