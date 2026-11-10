/**
 * Worker side of security: copies the findings of every mapped Dependency-Track project and Wazuh
 * agent into security_findings, where the hub reads them under RLS (level 3). A project or agent is
 * due when it was never synced or not for its interval, so a new mapping shows up within a minute.
 * The first sync is silent; afterwards new serious findings become one notice per project or agent
 * and run, and findings that disappear are marked resolved.
 */
import type { SQL } from "bun";
import { wazuhEs, type EsClient } from "../es/client";
import { dependencyTrack, DtError, isRelevant, parseDependencyTrackConfig, projectLabel, severityOf, type DtApi, type Severity } from "./dependency-track";
import { parseWazuhConfig, syncAgent, WAZUH_SYNC_EVERY_MS } from "./wazuh";

export const SYNC_EVERY_MS = 15 * 60_000;
const NOTICE_LIST = 10;

export const SEVERITY_LABEL: Record<Severity, string> = { critical: "kritisch", high: "hoch", medium: "mittel", low: "niedrig", unassigned: "ohne Einstufung" };

interface Mapping {
  environment_id: number;
  /** Dependency-Track project UUIDs or Wazuh agent names. */
  targets: string[];
}

async function mappings(sql: SQL, kind: "dependency_track" | "wazuh"): Promise<Mapping[]> {
  const rows = (await sql`select environment_id, config from environment_sources where kind = ${kind}`) as { environment_id: number; config: unknown }[];
  return rows.flatMap((r) => {
    const targets = kind === "wazuh" ? parseWazuhConfig(r.config) : parseDependencyTrackConfig(r.config);
    return targets ? [{ environment_id: r.environment_id, targets }] : [];
  });
}

/** Drops state and findings of projects, agents or whole environments that are no longer mapped. */
async function forgetUnmapped(sql: SQL, projects: Mapping[], agents: Mapping[]) {
  const ids = (list: Mapping[]) => sql.array([0, ...list.map((m) => m.environment_id)], "int4");
  await sql`delete from security_projects where environment_id <> all(${ids(projects)})`;
  await sql`delete from security_findings where source = 'dependency_track' and environment_id <> all(${ids(projects)})`;
  await sql`delete from security_agents where environment_id <> all(${ids(agents)})`;
  await sql`delete from security_findings where source = 'wazuh' and environment_id <> all(${ids(agents)})`;
  for (const m of projects) {
    await sql`delete from security_projects where environment_id = ${m.environment_id} and project_uuid::text <> all(${sql.array(m.targets, "text")})`;
    await sql`delete from security_findings where environment_id = ${m.environment_id} and source = 'dependency_track'
              and project_uuid::text <> all(${sql.array(m.targets, "text")})`;
  }
  for (const m of agents) {
    await sql`delete from security_agents where environment_id = ${m.environment_id} and agent_name <> all(${sql.array(m.targets, "text")})`;
    await sql`delete from security_findings where environment_id = ${m.environment_id} and source = 'wazuh' and target <> all(${sql.array(m.targets, "text")})`;
  }
}

function noticeBody(rows: { vuln_id: string; severity: Severity; cvss: number | null; component: string | null; component_version: string | null }[]): string {
  const lines = rows.slice(0, NOTICE_LIST).map((r) =>
    `${r.vuln_id} (${SEVERITY_LABEL[r.severity]}${r.cvss !== null ? `, CVSS ${r.cvss}` : ""}) in ${[r.component, r.component_version].filter(Boolean).join(" ")}`);
  if (rows.length > NOTICE_LIST) lines.push(`… und ${rows.length - NOTICE_LIST} weitere`);
  return lines.join("\n");
}

export async function syncProject(sql: SQL, api: DtApi, envId: number, uuid: string): Promise<{ added: number; resolved: number }> {
  const [state] = (await sql`select synced_at from security_projects where environment_id = ${envId} and project_uuid = ${uuid}::uuid`) as { synced_at: Date | null }[];
  let project, findings;
  try {
    project = await api.getProject(uuid);
    findings = (await api.getFindings(uuid)).filter(isRelevant);
  } catch (err) {
    if (!(err instanceof DtError)) throw err;
    await sql`insert into security_projects (environment_id, project_uuid, attempted_at, last_error) values (${envId}, ${uuid}::uuid, now(), ${err.message})
              on conflict (environment_id, project_uuid) do update set attempted_at = now(), last_error = excluded.last_error`;
    return { added: 0, resolved: 0 };
  }
  const target = projectLabel(project);
  const firstSync = !state?.synced_at;

  return sql.begin(async (tx) => {
    await tx`insert into security_projects (environment_id, project_uuid, name, version, last_bom_import, attempted_at, synced_at, last_error)
             values (${envId}, ${uuid}::uuid, ${project.name}, ${project.version ?? null},
                     ${project.lastBomImport ? new Date(project.lastBomImport) : null}, now(), now(), null)
             on conflict (environment_id, project_uuid) do update set name = excluded.name, version = excluded.version,
               last_bom_import = excluded.last_bom_import, attempted_at = now(), synced_at = now(), last_error = null`;
    const keys: string[] = [];
    const added: { vuln_id: string; severity: Severity; cvss: number | null; component: string | null; component_version: string | null }[] = [];
    for (const f of findings) {
      const key = `${f.component.uuid}:${f.vulnerability.uuid}`;
      keys.push(key);
      const severity = severityOf(f.vulnerability.severity);
      const cvss = f.vulnerability.cvssV3BaseScore ?? f.vulnerability.cvssV2BaseScore ?? null;
      const component = [f.component.group, f.component.name].filter(Boolean).join(":");
      const [row] = (await tx`
        insert into security_findings (environment_id, source, project_uuid, finding_key, target, vuln_id, severity, cvss, title, component, component_version)
        values (${envId}, 'dependency_track', ${uuid}::uuid, ${key}, ${target}, ${f.vulnerability.vulnId.slice(0, 100)}, ${severity}, ${cvss},
                ${f.vulnerability.title?.slice(0, 500) ?? null}, ${component.slice(0, 300)}, ${f.component.version?.slice(0, 100) ?? null})
        on conflict (environment_id, source, finding_key) do update set
          last_seen_at = now(), resolved_at = null, target = excluded.target, severity = excluded.severity, cvss = excluded.cvss,
          title = excluded.title, component_version = excluded.component_version
        returning (xmax = 0) as inserted`) as { inserted: boolean }[];
      if (row?.inserted && (severity === "critical" || severity === "high")) {
        added.push({ vuln_id: f.vulnerability.vulnId, severity, cvss, component, component_version: f.component.version ?? null });
      }
    }
    const resolved = (await tx`
      update security_findings set resolved_at = now()
      where environment_id = ${envId} and source = 'dependency_track' and project_uuid = ${uuid}::uuid and resolved_at is null
        and finding_key <> all(${tx.array(keys.length ? keys : [""], "text")})
      returning id`).length;

    if (!firstSync && added.length > 0) {
      added.sort((a, b) => (a.severity === b.severity ? (b.cvss ?? 0) - (a.cvss ?? 0) : a.severity === "critical" ? -1 : 1));
      const critical = added.some((a) => a.severity === "critical");
      await tx`insert into events (source, environment_id, subject_key, state, severity, title, body, link)
               values ('security', ${envId}, ${`dt:${uuid}`}, 'notice', ${critical ? "critical" : "warning"},
                       ${`${added.length} ${added.length === 1 ? "neue Schwachstelle" : "neue Schwachstellen"} in ${target}`},
                       ${noticeBody(added)}, ${`/env/${envId}/security`})`;
    }
    return { added: added.length, resolved };
  });
}

/** One worker tick: every mapped project and agent that is due gets synced. */
export async function syncSecurity(sql: SQL, log: (m: string) => void, api: DtApi = dependencyTrack, now = Date.now(), wazuh: EsClient = wazuhEs): Promise<number> {
  const projects = await mappings(sql, "dependency_track");
  const agents = await mappings(sql, "wazuh");
  await forgetUnmapped(sql, projects, agents);
  const due = (attempted: Date | null | undefined, every: number) => !attempted || now - new Date(attempted).getTime() >= every;
  let count = 0;

  const projectAttempts = (await sql`select environment_id, project_uuid::text as target, attempted_at from security_projects`) as { environment_id: number; target: string; attempted_at: Date | null }[];
  for (const m of projects) {
    for (const uuid of m.targets) {
      if (!due(projectAttempts.find((s) => s.environment_id === m.environment_id && s.target === uuid)?.attempted_at, SYNC_EVERY_MS)) continue;
      const r = await syncProject(sql, api, m.environment_id, uuid);
      if (r.added || r.resolved) log(`security: environment ${m.environment_id}, project ${uuid}: ${r.added} new, ${r.resolved} resolved`);
      count++;
    }
  }

  const agentAttempts = (await sql`select environment_id, agent_name as target, attempted_at from security_agents`) as { environment_id: number; target: string; attempted_at: Date | null }[];
  for (const m of agents) {
    for (const agent of m.targets) {
      if (!due(agentAttempts.find((s) => s.environment_id === m.environment_id && s.target === agent)?.attempted_at, WAZUH_SYNC_EVERY_MS)) continue;
      const r = await syncAgent(sql, wazuh, m.environment_id, agent);
      if (r.added || r.resolved) log(`security: environment ${m.environment_id}, agent ${agent}: ${r.added} new critical, ${r.resolved} resolved`);
      count++;
    }
  }
  return count;
}
