/**
 * A project's ISMS controls with their verdicts. Everything is read as the current user: the
 * controls under the project's policy, the data behind each check under its environment's, so a
 * check whose data the user may not see says so instead of guessing.
 */
import type { Context } from "hono";
import { all, first, rls } from "../../db";
import { esProblem, logsEs } from "../es/client";
import { buildLogsSpan, toLogsSpan } from "../logs/query";
import { serverStale, serverStatuses, type ServerStatus } from "../runners/routes";
import { lastRunPerHost, mappedAnsibleHosts } from "../ansible/routes";
import { securityAgents, securityProjects, STALE_BOM_DAYS } from "../security/routes";
import { loadLogsSources } from "../sources/store";
import { monitorsWithStats } from "../uptime/routes";
import {
  berlinToday,
  compareRefs,
  DEFAULTS,
  judgeLogs,
  judgeMaintenance,
  judgeRecord,
  judgeServers,
  judgeTls,
  judgeUptime,
  judgeVulns,
  KIND_LEVEL,
  LEVEL_NAME,
  STATUS_ORDER,
  type ControlKind,
  type HostRun,
  type IsmsStatus,
  type Verdict,
  type VulnSource,
  type VulnsInput,
} from "./judge";

export interface LastRecord {
  done_on: string;
  result: "passed" | "deviation";
  note: string | null;
  link: string | null;
  /** null for viewers who may not read the user list */
  by_name: string | null;
}

export interface ControlRow {
  id: number;
  project_id: number;
  environment_id: number | null;
  /** null when the environment is not visible to the user */
  env_name: string | null;
  ref: string;
  title: string;
  basis: string | null;
  kind: ControlKind;
  params: Record<string, any>;
  note: string | null;
  level: number;
  records: number;
  last: LastRecord | null;
}

export interface JudgedControl extends ControlRow {
  verdict: Verdict;
}

export interface IsmsView {
  project: { id: number; name: string; org_name: string };
  controls: JudgedControl[];
  checkedAt: Date;
}

type MonitorStats = Awaited<ReturnType<typeof monitorsWithStats>>;
type Span = { newest: number | null; oldest: number | null } | null;

/** An environment's vulnerability state, for every source at once; `vulnsInput` picks one. */
interface VulnState {
  kinds: string[];
  groups: { source: string; severity: "critical" | "high"; day: string; n: number }[];
  projects: { name: string | null; project_uuid: string; last_bom_import: Date | null; synced_at: Date | null; last_error: string | null }[];
  agents: { agent_name: string; synced_at: Date | null; last_error: string | null }[];
}

interface Loaded {
  monitors: Map<number, MonitorStats>;
  servers: Map<number, ServerStatus[]>;
  vulns: Map<number, VulnState>;
  /** Keyed by "<environment>:<template>". */
  runs: Map<string, HostRun[] | null>;
  spans: Map<number, Span | string>;
}

const ENV_KINDS: ControlKind[] = ["uptime", "tls", "servers", "logs", "vulns", "maintenance"];
const DAY = 86_400_000;

/** The project's controls, or with `envId` only those checking that environment. */
export async function loadIsms(c: Context, projectId: number, envId: number | null = null): Promise<IsmsView | null> {
  const base = await rls(c, async (tx) => {
    const project = await first<{ id: number; name: string; org_name: string }>(tx`
      select p.id, p.name, o.name as org_name from projects p join organisations o on o.id = p.organisation_id where p.id = ${projectId}`);
    if (!project) return null;
    const controls = await all<ControlRow>(tx`
      select k.id, k.project_id, k.environment_id, e.name as env_name, k.ref, k.title, k.basis, k.kind, k.params, k.note,
             coalesce(vantage_level(vantage_uid(), k.environment_id), 0) as level,
             (select count(*)::int from isms_records r where r.control_id = k.id) as records,
             (select jsonb_build_object('done_on', r.done_on::text, 'result', r.result, 'note', r.note, 'link', r.link, 'by_name', u.name)
                from isms_records r left join users u on u.id = r.created_by
                where r.control_id = k.id order by r.done_on desc, r.id desc limit 1) as last
      from isms_controls k left join environments e on e.id = k.environment_id
      where k.project_id = ${projectId} and (${envId}::int is null or k.environment_id = ${envId}::int)`);
    const monitors = new Map<number, MonitorStats>();
    const servers = new Map<number, ServerStatus[]>();
    const vulns = new Map<number, VulnState>();
    const runs = new Map<string, HostRun[] | null>();
    for (const k of controls) {
      if (k.environment_id === null || !k.env_name || k.level < KIND_LEVEL[k.kind]) continue;
      const envId = k.environment_id;
      if ((k.kind === "uptime" || k.kind === "tls") && !monitors.has(envId)) monitors.set(envId, await monitorsWithStats(tx, envId));
      if (k.kind === "servers" && !servers.has(envId)) servers.set(envId, await serverStatuses(tx, envId));
      if (k.kind === "vulns" && !vulns.has(envId)) {
        vulns.set(envId, {
          kinds: (await all<{ kind: string }>(tx`select kind from environment_sources where environment_id = ${envId}`)).map((r) => r.kind),
          groups: await all(tx`
            select source, severity, first_seen_at::date::text as day, count(*)::int as n from security_findings
            where environment_id = ${envId} and resolved_at is null and severity in ('critical', 'high') group by 1, 2, 3`),
          projects: await securityProjects(tx, envId),
          agents: await securityAgents(tx, envId),
        });
      }
      const template = k.kind === "maintenance" ? (k.params.template as string | undefined) ?? null : null;
      const runKey = `${envId}:${template ?? ""}`;
      if (k.kind === "maintenance" && !runs.has(runKey)) {
        const hosts = await mappedAnsibleHosts(tx, envId);
        runs.set(runKey, hosts ? await lastRunPerHost(tx, hosts, template) : null);
      }
    }
    return { project, controls, monitors, servers, vulns, runs };
  });
  if (!base) return null;

  // Elasticsearch outside the transaction: one request per environment with a logs control.
  const spans = new Map<number, Span | string>();
  for (const k of base.controls) {
    if (k.kind !== "logs" || k.environment_id === null || !k.env_name || k.level < KIND_LEVEL.logs || spans.has(k.environment_id)) continue;
    const sources = await loadLogsSources(c, k.environment_id);
    if (!sources.length) {
      spans.set(k.environment_id, null);
      continue;
    }
    try {
      const q = buildLogsSpan(sources);
      spans.set(k.environment_id, toLogsSpan(await logsEs.search(q.index, q.body)));
    } catch (err) {
      spans.set(k.environment_id, esProblem(err));
    }
  }

  const today = berlinToday();
  const controls = base.controls
    .map((k): JudgedControl => ({ ...k, verdict: judge(k, { ...base, spans }, today) }))
    .sort((a, b) => compareRefs(a.ref, b.ref) || a.id - b.id);
  return { project: base.project, controls, checkedAt: new Date() };
}

function judge(k: ControlRow, { monitors, servers, vulns, runs, spans }: Loaded, today: string): Verdict {
  if (k.kind === "record") return judgeRecord(k.last, { interval_days: k.params.interval_days ?? null }, today);
  if (ENV_KINDS.includes(k.kind) && (k.environment_id === null || !k.env_name)) return { status: "unknown", value: "Umgebung nicht freigegeben" };
  if (k.level < KIND_LEVEL[k.kind]) return { status: "unknown", value: "Für diese Prüfung fehlt der Zugriff", detail: `Die Daten von ${k.env_name} brauchen die Stufe ${LEVEL_NAME[KIND_LEVEL[k.kind]]}.` };
  const envId = k.environment_id!;
  switch (k.kind) {
    case "uptime": {
      const p = { ...DEFAULTS.uptime, ...k.params };
      const rows = (monitors.get(envId) ?? []).filter((m) => m.enabled && (!p.monitor_id || m.id === p.monitor_id));
      if (p.monitor_id && rows.length === 0) return { status: "unknown", value: "Der Monitor existiert nicht mehr" };
      return judgeUptime(rows.map((m) => ({ name: m.name, percent: m.u30 === null ? null : Number(m.u30) })), p);
    }
    case "tls":
      return judgeTls((monitors.get(envId) ?? []).filter((m) => m.enabled).map((m) => ({ name: m.name, days_left: m.tls_days_left })), { ...DEFAULTS.tls, ...k.params });
    case "servers":
      return judgeServers((servers.get(envId) ?? []).map((s) => ({ name: s.name, enabled: s.enabled, stale: serverStale(s), checks: s.checks })));
    case "logs": {
      const span = spans.get(envId) ?? null;
      if (typeof span === "string") return { status: "unknown", value: "Logs-Cluster nicht abfragbar", detail: span };
      return judgeLogs(span, { ...DEFAULTS.logs, ...k.params });
    }
    case "vulns": {
      const p = { ...DEFAULTS.vulns, ...k.params };
      return judgeVulns(vulnsInput(vulns.get(envId)!, p.source), p, today);
    }
    case "maintenance": {
      const p = { ...DEFAULTS.maintenance, ...k.params };
      return judgeMaintenance(runs.get(`${envId}:${p.template ?? ""}`) ?? null, p);
    }
  }
  return { status: "unknown", value: "Unbekannte Art" };
}

/** One source's (or both sources') part of the environment's vulnerability state. */
function vulnsInput(v: VulnState, source: VulnSource, now = Date.now()): VulnsInput {
  const dt = source !== "wazuh";
  const wazuh = source !== "dependency_track";
  const projects = dt ? v.projects : [];
  const agents = wazuh ? v.agents : [];
  const staleBefore = now - STALE_BOM_DAYS * DAY;
  const problems = [
    ...projects.filter((p) => p.last_error).map((p) => `Abgleich von ${p.name ?? "einem Projekt"} fehlgeschlagen`),
    ...agents.filter((a) => a.last_error).map((a) => `Abgleich von ${a.agent_name} fehlgeschlagen`),
    ...projects.filter((p) => p.synced_at && !p.last_bom_import).map((p) => `${p.name ?? "Ein Projekt"} hat noch keine SBOM`),
    ...projects.filter((p) => p.last_bom_import && new Date(p.last_bom_import).getTime() < staleBefore).map((p) => `SBOM von ${p.name} älter als ${STALE_BOM_DAYS} Tage`),
  ];
  return {
    mapped: (dt && v.kinds.includes("dependency_track")) || (wazuh && v.kinds.includes("wazuh")),
    synced: projects.filter((p) => p.synced_at).length + agents.filter((a) => a.synced_at).length,
    groups: v.groups.filter((g) => (g.source === "dependency_track" ? dt : wazuh)),
    problems,
  };
}

export function countByStatus(controls: { verdict: Verdict }[]): Record<IsmsStatus, number> {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<IsmsStatus, number>;
  for (const k of controls) counts[k.verdict.status]++;
  return counts;
}
