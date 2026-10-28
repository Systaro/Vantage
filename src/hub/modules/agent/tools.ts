/**
 * What agents can ask Vantage, shared by the REST API (/api/v1/…) and the MCP server (/api/mcp).
 * Every tool runs as the token's user: the request context carries that user, data is read through
 * rls() and loadEnv() exactly like the UI, so an agent never sees more than its owner (and gets
 * "not found" where the UI would 404). All tools only read.
 */
import type { Context } from "hono";
import { all, rls } from "../../db";
import { ansibleRuns, hostSummaries, mappedAnsibleHosts, runCounts } from "../ansible/routes";
import { serverHistory } from "../runners/metrics";
import { SERVER_PRESETS, serverStale, serverStatuses } from "../runners/routes";
import { loadEnv, type EnvContext } from "../../ui";
import { selectRules } from "../errors/rules";
import { EsError, logsEs } from "../es/client";
import { bucketFor, parseRange } from "../es/range";
import { buildLogEntryLookup, buildLogsSearch, LOG_LEVELS, parseLogFilters, parseLogId, sourceOf, toLogEntry, toLogRow } from "../logs/query";
import { alertsStale, mappedWazuhAgents, openCounts, securityAgents, securityProjects } from "../security/routes";
import { agentAlerts } from "../security/wazuh";
import type { NamedLogsSource } from "../sources/config";
import { loadLogsSources } from "../sources/store";
import { latestHealth, monitorsWithStats } from "../uptime/routes";

export class ToolError extends Error {}

async function logSources(c: Context, envId: number): Promise<NamedLogsSource[]> {
  const sources = await loadLogsSources(c, envId);
  if (!sources.length) throw new ToolError("This environment has no log source.");
  return sources;
}

function namedSource(sources: NamedLogsSource[], name: string): NamedLogsSource {
  const source = sources.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!source) throw new ToolError(`No log source "${name}" in this environment; it has ${sources.map((s) => `"${s.name}"`).join(", ")}.`);
  return source;
}

type Args = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema of the arguments (MCP inputSchema). */
  inputSchema: Record<string, unknown>;
  run(c: Context, args: Args): Promise<unknown>;
}

const LEVEL_NAME = ["none", "overview", "diagnostics", "security"] as const;
const ENV_ID = { environment_id: { type: "integer", description: "Id from list_environments" } };

function int(v: unknown, name: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) throw new ToolError(`${name} must be a positive integer`);
  return n;
}

function bounded(v: unknown, fallback: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

const round = (v: number | null | undefined, digits: number) => (v == null ? null : Number(v.toFixed(digits)));

/** ES failures (unreachable, refused, timed out) become a tool answer instead of a server error. */
async function fromEs<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof EsError) throw new ToolError(err.message);
    throw err;
  }
}

/** The environment at the required level, or the same answer whether it does not exist or is not granted. */
async function env(c: Context, args: Args, level: 1 | 2 | 3, what: string): Promise<EnvContext> {
  const e = await loadEnv(c, int(args.environment_id, "environment_id"), level);
  if (!e) throw new ToolError(`Environment not found, or your access does not include ${what}.`);
  return e;
}

export const TOOLS: Tool[] = [
  {
    name: "list_environments",
    description: "All environments you can see, with your access level, what data sources they have and their current state (monitors down, open incidents).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (c) =>
      rls(c, (tx) => all<any>(tx`
        select e.id, o.name as organisation, p.name as project, e.name as environment, e.kind, e.url,
               vantage_level(vantage_uid(), e.id) as level,
               (select count(*)::int from monitor_state s where s.environment_id = e.id and s.status = 'down') as monitors_down,
               (select count(*)::int from monitor_state s where s.environment_id = e.id) as monitors,
               (select count(*)::int from incidents i where i.environment_id = e.id and i.resolved_at is null) as open_incidents
        from environments e join projects p on p.id = e.project_id join organisations o on o.id = p.organisation_id
        order by o.name, p.name, e.sort_order, e.name`)).then((rows) => rows.map((r) => ({ ...r, access: LEVEL_NAME[r.level] ?? "none", level: undefined }))),
  },
  {
    name: "get_environment_status",
    description: "Current state of one environment: every monitor with status and uptime (health-page monitors also with the components and metrics of their latest reading; via_runner when a runner inside the customer network probes it), open incidents, the latest test run per suite; with diagnostics access also open error groups and the servers a runner reads (disk, memory, load, systemd, docker checks with severity; stale when no report for three intervals), with security access the open vulnerabilities by severity.",
    inputSchema: { type: "object", properties: ENV_ID, required: ["environment_id"], additionalProperties: false },
    run: async (c, args) => {
      const e = await env(c, args, 1, "this environment");
      return rls(c, async (tx) => ({
        environment: { id: e.id, organisation: e.orgName, project: e.projectName, name: e.name, kind: e.kind, url: e.url, access: LEVEL_NAME[e.level] },
        monitors: await Promise.all((await monitorsWithStats(tx, e.id)).map(async (m) => {
          const health = m.kind === "health" ? await latestHealth(tx, m.id) : null;
          return {
            id: m.id, name: m.name, kind: m.kind, via_runner: m.runner_id !== null, status: m.status, since: m.since, last_check_at: m.last_check_at, last_message: m.last_message,
            uptime_24h_percent: m.u24 === null ? null : Number(Number(m.u24).toFixed(3)), latency_24h_ms: m.lat24 === null ? null : Math.round(Number(m.lat24)),
            health: health ? { read_at: health.at, components: health.details.components, metrics: health.details.metrics } : undefined,
          };
        })),
        open_incidents: await all<any>(tx`
          select id, title, source, severity, opened_at, last_seen_at from incidents
          where environment_id = ${e.id} and resolved_at is null order by opened_at desc`),
        test_suites: await all<any>(tx`
          select s.name as suite, r.status, r.received_at, r.total, r.passed, r.failed, r.flaky, r.branch, r.commit_sha
          from test_suites s left join lateral (select * from test_runs r where r.suite_id = s.id order by received_at desc limit 1) r on true
          where s.environment_id = ${e.id} order by s.name`),
        open_error_groups: e.level >= 2 && (e.hasApm || e.hasLogs)
          ? await all<any>(tx`select id, source, exception_type, message, occurrences::float8 as occurrences, last_seen_at from error_groups
                              where environment_id = ${e.id} and status = 'open' order by last_seen_at desc limit 20`)
          : undefined,
        servers: e.level >= 2
          ? (await serverStatuses(tx, e.id)).map((s) => ({
              name: s.name, enabled: s.enabled, last_report_at: s.last_report_at, stale: s.enabled && serverStale(s), last_error: s.last_error, cpu_pct: round(s.cpu_pct, 1),
              checks: s.checks.map((k) => ({ check: k.key, label: k.label, severity: k.severity, value: k.value, detail: k.detail, since: k.since })),
            }))
          : undefined,
        open_vulnerabilities: e.level >= 3 && e.hasSecurity ? await openCounts(tx, e.id) : undefined,
      }));
    },
  },
  {
    name: "get_server_history",
    description: "One server's readings over time, as its page in Vantage shows them (needs diagnostics access): CPU usage in percent (null while the server's agent sends no CPU time, see has_cpu), load per core, memory and each filesystem in percent, averaged per bucket (filesystems: the highest value). server is a name from get_environment_status.",
    inputSchema: {
      type: "object",
      properties: { ...ENV_ID, server: { type: "string" }, range: { type: "string", enum: ["24h", "7d", "30d"], description: "Default 24h" } },
      required: ["environment_id", "server"],
      additionalProperties: false,
    },
    run: async (c, args) => {
      const e = await env(c, args, 2, "servers (diagnostics)");
      const name = typeof args.server === "string" ? args.server.trim().toLowerCase() : "";
      const { range } = parseRange((k) => (k === "range" && typeof args.range === "string" ? args.range : undefined), { fallback: "24h", presets: SERVER_PRESETS });
      return rls(c, async (tx) => {
        const servers = await serverStatuses(tx, e.id);
        const s = servers.find((x) => x.name.toLowerCase() === name);
        if (!s) throw new ToolError(`No such server "${String(args.server ?? "")}" in this environment${servers.length ? `; it has ${servers.map((x) => `"${x.name}"`).join(", ")}` : ""}.`);
        const bucketMs = bucketFor(range, 48, s.interval_seconds * 1000);
        const h = await serverHistory(tx, s, range.from, range.to, bucketMs);
        return {
          server: s.name,
          range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
          bucket_minutes: bucketMs / 60_000,
          has_cpu: h.hasCpu,
          points: h.memory.map((m, i) => ({
            at: new Date(m.t).toISOString(),
            cpu_pct: round(h.cpu[i]?.v, 1),
            load_per_core: round(h.load[i]?.v, 2),
            memory_pct: round(m.v, 1),
            disk_pct: Object.fromEntries(h.disks.map((d) => [d.mount, round(d.points[i]?.v, 1)])),
          })),
        };
      });
    },
  },
  {
    name: "list_incidents",
    description: "Incidents you can see, newest first. Open ones only unless include_resolved is true; optionally for one environment.",
    inputSchema: {
      type: "object",
      properties: { ...ENV_ID, include_resolved: { type: "boolean" }, limit: { type: "integer", maximum: 200 } },
      additionalProperties: false,
    },
    run: async (c, args) => {
      const envId = args.environment_id === undefined ? null : int(args.environment_id, "environment_id");
      const resolved = args.include_resolved === true || args.include_resolved === "true";
      return rls(c, (tx) => all<any>(tx`
        select i.id, i.title, i.source, i.severity, i.opened_at, i.resolved_at, i.environment_id,
               p.name as project, e.name as environment
        from incidents i left join environments e on e.id = i.environment_id left join projects p on p.id = e.project_id
        where (${envId}::int is null or i.environment_id = ${envId}) and (${resolved} or i.resolved_at is null)
        order by i.opened_at desc limit ${bounded(args.limit, 50, 200)}`));
    },
  },
  {
    name: "search_logs",
    description: "Search an environment's application logs (needs diagnostics access). Newest first. query is a simple query string over message, logger and stack trace (e.g. 'timeout -health'). An environment can have several log sources (one per service, say); all are searched unless source names one, and sources in the result lists them.",
    inputSchema: {
      type: "object",
      properties: {
        ...ENV_ID,
        source: { type: "string", description: "Name of one log source (see sources in the result); default all" },
        query: { type: "string" },
        levels: { type: "array", items: { type: "string", enum: [...LOG_LEVELS] } },
        range: { type: "string", enum: ["15m", "1h", "24h", "7d"], description: "Default 1h" },
        limit: { type: "integer", maximum: 100, description: "Default 50" },
      },
      required: ["environment_id"],
      additionalProperties: false,
    },
    run: async (c, args) => {
      const e = await env(c, args, 2, "logs (diagnostics)");
      const sources = await logSources(c, e.id);
      const read = typeof args.source === "string" && args.source ? [namedSource(sources, args.source)] : sources;
      const { range } = parseRange((k) => (k === "range" && typeof args.range === "string" ? args.range : undefined), { fallback: "1h" });
      const levels = Array.isArray(args.levels) ? args.levels.map(String) : typeof args.levels === "string" ? [args.levels] : [];
      const filters = parseLogFilters(levels, typeof args.query === "string" ? args.query : undefined);
      const { index, body } = buildLogsSearch(read, { range, filters });
      const res = await fromEs(() => logsEs.search(index, { ...body, size: bounded(args.limit, 50, 100) }));
      return {
        range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
        sources: sources.map((s) => s.name),
        total: res.hits.total,
        entries: res.hits.hits.map(toLogRow).map((r) => ({
          id: r.id,
          source: sourceOf(r, read)?.name,
          at: new Date(r.ts).toISOString(),
          level: r.level,
          logger: r.logger,
          message: r.message,
          stack_trace: r.stack || undefined,
          trace_id: r.traceId || undefined,
        })),
      };
    },
  },
  {
    name: "get_log_entry",
    description: "One log entry with every field of the document (host, application, thread, MDC values …), as the detail dialog on the logs page shows it (needs diagnostics access). entry_id is the id from search_logs.",
    inputSchema: {
      type: "object",
      properties: { ...ENV_ID, entry_id: { type: "string", description: "id of an entry from search_logs" } },
      required: ["environment_id", "entry_id"],
      additionalProperties: false,
    },
    run: async (c, args) => {
      const e = await env(c, args, 2, "logs (diagnostics)");
      const sources = await logSources(c, e.id);
      const id = parseLogId(typeof args.entry_id === "string" ? args.entry_id : undefined);
      if (!id) throw new ToolError("entry_id must be an id from search_logs.");
      const { index, body } = buildLogEntryLookup(sources, id);
      const hit = (await fromEs(() => logsEs.search(index, body))).hits.hits[0];
      if (!hit) throw new ToolError("No such entry in this environment's logs (it may be older than the log retention).");
      const entry = toLogEntry(hit);
      return {
        id: entry.id,
        source: sourceOf(entry, sources)?.name,
        index: entry.index,
        at: new Date(entry.ts).toISOString(),
        level: entry.level,
        logger: entry.logger,
        thread: entry.thread || undefined,
        message: entry.message,
        stack_trace: entry.stack || undefined,
        trace_id: entry.traceId || undefined,
        transaction_id: entry.transactionId || undefined,
        fields: Object.fromEntries(entry.fields),
      };
    },
  },
  {
    name: "list_errors",
    description: "Error groups of an environment (needs diagnostics access), most recently seen first. source is 'apm' (APM error documents) or 'logs' (ERROR log entries grouped by logger, exception class and call path); for a logs group, sample_entry_id is an entry_id for get_log_entry.",
    inputSchema: {
      type: "object",
      properties: { ...ENV_ID, status: { type: "string", enum: ["open", "resolved", "ignored"], description: "Default open" }, limit: { type: "integer", maximum: 200 } },
      required: ["environment_id"],
      additionalProperties: false,
    },
    run: async (c, args) => {
      const e = await env(c, args, 2, "errors (diagnostics)");
      const status = ["open", "resolved", "ignored"].includes(String(args.status)) ? String(args.status) : "open";
      return rls(c, (tx) => all<any>(tx`
        select id, source, exception_type, message, culprit, handled, occurrences::float8 as occurrences, first_seen_at, last_seen_at, status, sample_entry_id
        from error_groups where environment_id = ${e.id} and status = ${status}
        order by last_seen_at desc limit ${bounded(args.limit, 50, 200)}`));
    },
  },
  {
    name: "list_error_ignore_rules",
    description: "Ignore rules of an environment (needs diagnostics access): regular expressions on an error's title ('Type: message') or place. Errors a rule matches are dropped when they are polled, so they never become an error group in list_errors and send no notification. scope is 'environment' or 'project' (the rule holds for every environment of the project); matched counts the occurrences the rule dropped.",
    inputSchema: { type: "object", properties: { ...ENV_ID }, required: ["environment_id"], additionalProperties: false },
    run: async (c, args) => {
      const e = await env(c, args, 2, "errors (diagnostics)");
      return (await rls(c, (tx) => selectRules(tx, e))).map((r) => ({
        id: r.id, scope: r.environment_id === null ? "project" : "environment", pattern: r.pattern, note: r.note,
        matched: r.matched, last_matched_at: r.last_matched_at, created_at: r.created_at,
      }));
    },
  },
  {
    name: "list_vulnerabilities",
    description: "Open vulnerabilities of an environment from Dependency-Track and Wazuh (needs security access): counts by severity, the Dependency-Track projects (with the age of their last SBOM) and Wazuh servers they come from, and the findings, most severe first.",
    inputSchema: {
      type: "object",
      properties: { ...ENV_ID, severity: { type: "string", enum: ["critical", "high", "medium", "low"] }, limit: { type: "integer", maximum: 500 } },
      required: ["environment_id"],
      additionalProperties: false,
    },
    run: async (c, args) => {
      const e = await env(c, args, 3, "vulnerabilities (security)");
      const severity = ["critical", "high", "medium", "low"].includes(String(args.severity)) ? String(args.severity) : null;
      return rls(c, async (tx) => ({
        counts: await openCounts(tx, e.id),
        projects: (await securityProjects(tx, e.id)).map((p) => ({
          name: p.name, version: p.version, uuid: p.project_uuid, last_bom_import: p.last_bom_import, synced_at: p.synced_at, last_error: p.last_error, open: p.open, critical_or_high: p.serious,
        })),
        servers: (await securityAgents(tx, e.id)).map((a) => ({ name: a.agent_name, os: a.os, counts: a.counts, synced_at: a.synced_at, last_error: a.last_error })),
        findings: await all<any>(tx`
          select source, vuln_id, severity, cvss::float8 as cvss, title, component, component_version, target, first_seen_at
          from security_findings where environment_id = ${e.id} and resolved_at is null and (${severity}::text is null or severity = ${severity})
          order by array_position(array['critical', 'high', 'medium', 'low', 'unassigned'], severity), cvss desc nulls last
          limit ${bounded(args.limit, 100, 500)}`),
      }));
    },
  },
  {
    name: "get_security_alerts",
    description: "Wazuh alerts of the environment's servers in the last 24 hours (needs security access): totals by rule level, the most frequent rules and every alert from level 10. stale is true when the newest alert in the indexer is older than 6 hours, which usually means the indexer stopped taking alerts in and the numbers are incomplete.",
    inputSchema: { type: "object", properties: ENV_ID, required: ["environment_id"], additionalProperties: false },
    run: async (c, args) => {
      const e = await env(c, args, 3, "security alerts (security)");
      const agents = await rls(c, (tx) => mappedWazuhAgents(tx, e.id));
      if (!agents) throw new ToolError("This environment has no Wazuh servers.");
      const a = await fromEs(() => agentAlerts(agents));
      return {
        servers: agents,
        window: "24h",
        total: a.total,
        by_level: { "0-6": a.levels.low ?? 0, "7-11": a.levels.medium ?? 0, "12-15": a.levels.high ?? 0 },
        top_rules: a.rules,
        level_10_and_above: a.serious,
        newest_alert_at: a.newestAt,
        stale: alertsStale(a.newestAt),
      };
    },
  },
  {
    name: "list_ansible_runs",
    description: "Ansible runs from Semaphore on the environment's servers (needs security access), newest first: template, status, trigger (schedule or manual), start and end, and for each of this environment's servers the PLAY RECAP counts (ok, changed, failed, unreachable) and the task it failed in. Also a 30-day summary per server. failed_only keeps runs in which one of these servers failed or was unreachable; a run with status error but no failed server here failed on other servers.",
    inputSchema: {
      type: "object",
      properties: { ...ENV_ID, failed_only: { type: "boolean" }, limit: { type: "integer", maximum: 200, description: "Default 50" } },
      required: ["environment_id"],
      additionalProperties: false,
    },
    run: async (c, args) => {
      const e = await env(c, args, 3, "Ansible runs (security)");
      const failedOnly = args.failed_only === true || args.failed_only === "true";
      return rls(c, async (tx) => {
        const hosts = await mappedAnsibleHosts(tx, e.id);
        if (!hosts) throw new ToolError("This environment has no Ansible servers.");
        return {
          servers: (await hostSummaries(tx, hosts)).map((s) => ({
            name: s.host, runs_30d: s.runs_30d, failed_30d: s.failed_30d, last_run_id: s.last_run_id, last_template: s.last_template,
            last_run_at: s.last_at, last_run_failed: s.last_failed, last_failure_at: s.last_failure_at,
          })),
          last_30_days: await runCounts(tx, hosts),
          runs: (await ansibleRuns(tx, { hosts, failedOnly, limit: bounded(args.limit, 50, 200) })).map((r) => ({
            id: r.id, template: r.template_name, playbook: r.playbook, status: r.status, trigger: r.trigger,
            created_at: r.created_at, started_at: r.started_at, ended_at: r.ended_at, servers: r.hosts,
          })),
        };
      });
    },
  },
  {
    name: "list_test_runs",
    description: "Recent Playwright test runs of an environment, newest first.",
    inputSchema: { type: "object", properties: { ...ENV_ID, limit: { type: "integer", maximum: 100 } }, required: ["environment_id"], additionalProperties: false },
    run: async (c, args) => {
      const e = await env(c, args, 1, "this environment");
      return rls(c, (tx) => all<any>(tx`
        select r.id, s.name as suite, r.status, r.received_at, r.duration_ms, r.total, r.passed, r.failed, r.flaky, r.skipped, r.branch, r.commit_sha, r.pipeline_url
        from test_runs r join test_suites s on s.id = r.suite_id where r.environment_id = ${e.id}
        order by r.received_at desc limit ${bounded(args.limit, 20, 100)}`));
    },
  },
];

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
