/**
 * The environment's security tab (level 3): known vulnerabilities from Dependency-Track and Wazuh,
 * read from security_findings / security_agents under RLS (the worker keeps them current, sync.ts),
 * and Wazuh alerts, read live from the indexer for the mapped agents.
 */
import type { Hono } from "hono";
import { parseId } from "../../../shared/http";
import { Ago, Badge, Card, Empty, formatDate, formatNumber, Stat, type Tone } from "../../../shared/ui/components";
import { all, first, rls } from "../../db";
import { EnvShell, loadEnv, type EnvContext } from "../../ui";
import { esProblem } from "../es/client";
import { withParams } from "../es/range";
import type { Severity } from "./dependency-track";
import { SEVERITY_LABEL } from "./sync";
import { agentAlerts, parseWazuhConfig } from "./wazuh";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "unassigned"];
const SEVERITY_TONE: Record<Severity, Tone> = { critical: "bad", high: "warn", medium: "info", low: "idle", unassigned: "idle" };
const MAX_ROWS = 300;
/** An SBOM this old probably no longer describes what runs. */
const STALE_BOM_DAYS = 30;

export function SeverityBadge(props: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONE[props.severity]}>{SEVERITY_LABEL[props.severity]}</Badge>;
}

/** CVE and GHSA ids link to their public advisory; other ids stay text. */
function VulnLink(props: { id: string }) {
  const href = /^CVE-\d{4}-\d{4,}$/.test(props.id)
    ? `https://nvd.nist.gov/vuln/detail/${props.id}`
    : /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(props.id)
      ? `https://github.com/advisories/${props.id}`
      : null;
  return href ? <a href={href} rel="noopener noreferrer">{props.id}</a> : <span>{props.id}</span>;
}

interface Counts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unassigned: number;
}

/** Open vulnerabilities: Dependency-Track findings one by one, Wazuh by the agents' counts (all severities). */
export async function openCounts(tx: any, envId: number): Promise<Counts> {
  const dt = await all<{ severity: Severity; n: number }>(tx`
    select severity, count(*)::int as n from security_findings
    where environment_id = ${envId} and source = 'dependency_track' and resolved_at is null group by 1`);
  const agents = await all<{ counts: Partial<Counts> }>(tx`select counts from security_agents where environment_id = ${envId}`);
  return Object.fromEntries(SEVERITIES.map((s) => [
    s,
    (dt.find((r) => r.severity === s)?.n ?? 0) + agents.reduce((n, a) => n + Number(a.counts?.[s] ?? 0), 0),
  ])) as unknown as Counts;
}

/** Dependency-Track projects of the environment with their open findings; runs inside rls(). */
export function securityProjects(tx: any, envId: number) {
  return all<any>(tx`
    select p.project_uuid, p.name, p.version, p.last_bom_import, p.synced_at, p.last_error,
           (select count(*)::int from security_findings f where f.environment_id = p.environment_id and f.project_uuid = p.project_uuid and f.resolved_at is null) as open,
           (select count(*)::int from security_findings f where f.environment_id = p.environment_id and f.project_uuid = p.project_uuid and f.resolved_at is null and f.severity in ('critical', 'high')) as serious
    from security_projects p where p.environment_id = ${envId} order by p.name, p.version`);
}

/** Wazuh servers of the environment with their vulnerability counts; runs inside rls(). */
export function securityAgents(tx: any, envId: number) {
  return all<any>(tx`select agent_name, os, counts, synced_at, last_error from security_agents where environment_id = ${envId} order by agent_name`);
}

/** The Wazuh agent names mapped to the environment, or null without a Wazuh source; runs inside rls(). */
export async function mappedWazuhAgents(tx: any, envId: number): Promise<string[] | null> {
  const row = await first<{ config: unknown }>(tx`select config from environment_sources where environment_id = ${envId} and kind = 'wazuh'`);
  return parseWazuhConfig(row?.config);
}

/** Wazuh alerts lag when the indexer stops taking them in; older than this is flagged. */
const STALE_ALERTS_MS = 6 * 3_600_000;
export const alertsStale = (newestAt: string | null) => !newestAt || Date.now() - new Date(newestAt).getTime() > STALE_ALERTS_MS;
const LEVEL_LABEL = { low: "Stufe 0–6", medium: "Stufe 7–11", high: "Stufe 12–15" } as const;

async function WazuhAlerts(props: { agents: string[] }) {
  let a;
  try {
    a = await agentAlerts(props.agents);
  } catch (err) {
    return <p class="status-warn small">Alarme gerade nicht abrufbar: {esProblem(err)}</p>;
  }
  const stale = alertsStale(a.newestAt);
  return (
    <div class="stack">
      {stale && (
        <p class="status-warn small">
          {a.newestAt ? <>Der neueste Alarm dieser Server im Wazuh-Indexer ist vom {formatDate(a.newestAt)}.</> : "Im Wazuh-Indexer gibt es für diese Server keine Alarme."}{" "}
          Kommen keine neuen an, nimmt der Indexer sie vermutlich nicht mehr auf; die Zahlen unten sind dann unvollständig.
        </p>
      )}
      <div class="log-counts">
        <div class="log-count"><span class="log-count-value">{formatNumber(a.total)}</span><span class="log-count-label">Alarme in 24 Stunden</span></div>
        {(["high", "medium", "low"] as const).map((k) => (
          <div class="log-count"><span class={`log-count-value ${k === "high" && a.levels.high ? "status-bad" : ""}`}>{formatNumber(a.levels[k] ?? 0)}</span><span class="log-count-label">{LEVEL_LABEL[k]}</span></div>
        ))}
      </div>
      {a.rules.length > 0 && (
        <div class="table-wrap"><table>
          <thead><tr><th>Häufigste Regeln, 24 Stunden</th><th class="num">Stufe</th><th class="num">Anzahl</th></tr></thead>
          <tbody>{a.rules.map((r) => <tr><td class="small">{r.description}</td><td class="num">{r.level}</td><td class="num">{formatNumber(r.count)}</td></tr>)}</tbody>
        </table></div>
      )}
      {a.serious.length > 0 && (
        <div class="table-wrap"><table>
          <thead><tr><th>Ab Stufe 10, neueste zuerst</th><th>Server</th><th class="num">Stufe</th></tr></thead>
          <tbody>{a.serious.map((r) => <tr><td class="small"><span class="cell-title">{r.description}</span><span class="cell-sub">{formatDate(r.at)}</span></td><td class="small">{r.agent}</td><td class="num">{r.level}</td></tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}

/** Card on the environment overview: open counts and the newest serious findings. */
export async function SecurityOverviewCard(props: { c: any; env: EnvContext }) {
  const { env } = props;
  const data = await rls(props.c, async (tx) => ({
    counts: await openCounts(tx, env.id),
    newest: await all<any>(tx`
      select vuln_id, severity, component, component_version, target, first_seen_at from security_findings
      where environment_id = ${env.id} and resolved_at is null and severity = 'critical'
      order by first_seen_at desc, cvss desc nulls last limit 3`),
  }));
  const serious = data.counts.critical + data.counts.high;
  return (
    <Card title="Sicherheit" description="Offene Schwachstellen in den Abhängigkeiten" actions={<a class="btn small" href={`/env/${env.id}/security`}>Alle Schwachstellen</a>}>
      <div class="stack">
        <div class="log-counts">
          {(["critical", "high", "medium", "low"] as const).map((s) => (
            <a class="log-count" href={withParams(`/env/${env.id}/security`, { severity: s })}>
              <span class={`log-count-value ${data.counts[s] > 0 && (s === "critical" ? "status-bad" : s === "high" ? "status-warn" : "")}`}>{formatNumber(data.counts[s])}</span>
              <span class="log-count-label">{SEVERITY_LABEL[s]}</span>
            </a>
          ))}
        </div>
        {serious === 0 ? (
          <p class="status-ok">Keine offenen kritischen oder hohen Schwachstellen.</p>
        ) : data.newest.length === 0 ? (
          <p class="muted small">Keine kritischen, aber {formatNumber(data.counts.high)} hohe.</p>
        ) : (
          <div class="table-wrap"><table>
            <thead><tr><th>Neueste kritische</th><th>Komponente</th><th>Seit</th></tr></thead>
            <tbody>{data.newest.map((f) => (
              <tr>
                <td class="nowrap"><SeverityBadge severity={f.severity} /> <VulnLink id={f.vuln_id} /></td>
                <td class="small"><span class="mono">{f.component} {f.component_version}</span><div class="muted">{f.target}</div></td>
                <td class="nowrap small"><Ago at={f.first_seen_at} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </Card>
  );
}

export function mountSecurity(app: Hono) {
  app.get("/env/:id/security", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 3);
    if (!env || !env.hasSecurity) return c.notFound();
    const wanted = c.req.query("severity");
    const severity = SEVERITIES.includes(wanted as Severity) ? (wanted as Severity) : null;
    const base = `/env/${env.id}/security`;
    const data = await rls(c, async (tx) => ({
      kinds: (await all<{ kind: string }>(tx`select kind from environment_sources where environment_id = ${env.id}`)).map((r) => r.kind),
      counts: await openCounts(tx, env.id),
      projects: await securityProjects(tx, env.id),
      dtCounts: await all<{ severity: Severity; n: number }>(tx`
        select severity, count(*)::int as n from security_findings where environment_id = ${env.id} and source = 'dependency_track' and resolved_at is null group by 1`),
      findings: await all<any>(tx`
        select vuln_id, severity, cvss, title, component, component_version, target, first_seen_at from security_findings
        where environment_id = ${env.id} and source = 'dependency_track' and resolved_at is null and (${severity}::text is null or severity = ${severity})
        order by array_position(array['critical', 'high', 'medium', 'low', 'unassigned'], severity), cvss desc nulls last, first_seen_at desc
        limit ${MAX_ROWS}`),
      agents: await securityAgents(tx, env.id),
      packages: await all<any>(tx`
        select target, component, component_version, count(*)::int as cves, count(*) filter (where severity = 'critical')::int as critical, max(cvss) as cvss, min(first_seen_at) as since
        from security_findings where environment_id = ${env.id} and source = 'wazuh' and resolved_at is null
        group by 1, 2, 3 order by critical desc, max(cvss) desc nulls last, cves desc limit 100`),
      agentNames: (await mappedWazuhAgents(tx, env.id)) ?? [],
      resolved30: ((await tx`select count(*)::int as n from security_findings where environment_id = ${env.id} and resolved_at > now() - interval '30 days'`) as { n: number }[])[0]?.n ?? 0,
    }));
    const hasDt = data.kinds.includes("dependency_track");
    const hasWazuh = data.kinds.includes("wazuh");
    const dt = Object.fromEntries(SEVERITIES.map((s) => [s, data.dtCounts.find((r) => r.severity === s)?.n ?? 0])) as unknown as Counts;
    const dtTotal = SEVERITIES.reduce((n, s) => n + dt[s], 0);
    const shown = severity ? dt[severity] : dtTotal;
    const staleBefore = Date.now() - STALE_BOM_DAYS * 86_400_000;

    return c.html(
      <EnvShell c={c} env={env} tab="security" title="Sicherheit">
        <div class="stack">
          <div class="grid grid-4">
            <Stat label="Kritisch" value={formatNumber(data.counts.critical)} tone={data.counts.critical ? "bad" : "ok"} />
            <Stat label="Hoch" value={formatNumber(data.counts.high)} tone={data.counts.high ? "warn" : "ok"} />
            <Stat label="Mittel" value={formatNumber(data.counts.medium)} />
            <Stat label="Niedrig" value={formatNumber(data.counts.low + data.counts.unassigned)} hint={`${formatNumber(data.resolved30)} in den letzten 30 Tagen behoben`} />
          </div>

          {hasDt && (
            <Card title="Projekte in Dependency-Track" description="Was Dependency-Track über die Software dieser Umgebung weiß, stammt aus der zuletzt hochgeladenen SBOM." flush>
              {data.projects.length === 0 ? <Empty title="Noch nicht abgeglichen" icon="refresh-cw">Der erste Abgleich läuft innerhalb einer Minute nach dem Zuordnen.</Empty> : (
                <div class="table-wrap"><table>
                  <thead><tr><th>Projekt</th><th>Letzte SBOM</th><th>Abgeglichen</th><th class="num">Offen</th></tr></thead>
                  <tbody>{data.projects.map((p) => (
                    <tr>
                      <td><span class="cell-title">{p.name ?? p.project_uuid} {p.version && <span class="muted">{p.version}</span>}</span>{p.last_error && <span class="cell-sub status-bad">{p.last_error}</span>}</td>
                      <td class="nowrap">{p.last_bom_import ? <span class={new Date(p.last_bom_import).getTime() < staleBefore ? "status-warn" : ""}><Ago at={p.last_bom_import} /></span> : <span class="status-warn">noch keine</span>}</td>
                      <td class="nowrap">{p.synced_at ? <Ago at={p.synced_at} /> : <span class="muted">noch nicht</span>}</td>
                      <td class="num">{formatNumber(p.open)}{p.serious > 0 && <span class="status-bad"> ({formatNumber(p.serious)} schwer)</span>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
          )}

          {hasDt && (
            <Card title={<h2>Schwachstellen in Abhängigkeiten <span class="muted small">{formatNumber(shown)}</span></h2>} flush actions={
              <div class="seg" role="group" aria-label="Schweregrad">
                <a class={`btn small ${severity === null ? "active" : ""}`} href={base} aria-current={severity === null ? "true" : undefined}>Alle <span class="muted">{formatNumber(dtTotal)}</span></a>
                {(["critical", "high", "medium", "low"] as const).map((s) => (
                  <a class={`btn small ${severity === s ? "active" : ""}`} href={withParams(base, { severity: s })} aria-current={severity === s ? "true" : undefined}>
                    {SEVERITY_LABEL[s]} <span class="muted">{formatNumber(dt[s])}</span>
                  </a>
                ))}
              </div>
            }>
              {data.findings.length === 0 ? (
                <Empty title={severity ? `Keine offenen Schwachstellen „${SEVERITY_LABEL[severity]}“` : "Keine offenen Schwachstellen"} icon="shield-check">
                  {data.projects.some((p) => !p.last_bom_import) ? "Für mindestens ein Projekt liegt noch keine SBOM vor." : "Dependency-Track meldet für die zugeordneten Projekte nichts Offenes."}
                </Empty>
              ) : (
                <div class="table-wrap"><table>
                  <thead><tr><th>Schweregrad</th><th>Schwachstelle</th><th>Komponente</th><th class="num">CVSS</th><th>Seit</th></tr></thead>
                  <tbody>{data.findings.map((f) => (
                    <tr>
                      <td><SeverityBadge severity={f.severity} /></td>
                      <td><span class="cell-title"><VulnLink id={f.vuln_id} /></span>{f.title && <span class="cell-sub">{f.title}</span>}</td>
                      <td><span class="cell-title mono small">{f.component} {f.component_version}</span><span class="cell-sub">{f.target}</span></td>
                      <td class="num">{f.cvss !== null ? Number(f.cvss).toLocaleString("de-DE", { minimumFractionDigits: 1 }) : "–"}</td>
                      <td class="nowrap small"><Ago at={f.first_seen_at} /></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
              {shown > MAX_ROWS && <p class="muted small card-note">Die ersten {MAX_ROWS} von {formatNumber(shown)}, schwerste zuerst.</p>}
            </Card>
          )}

          {hasWazuh && (
            <Card title="Server (Wazuh)" description="Schwachstellen der installierten Pakete, wie der Wazuh-Agent sie meldet. Stündlich abgeglichen." flush>
              {data.agents.length === 0 ? <Empty title="Noch nicht abgeglichen" icon="refresh-cw">Der erste Abgleich läuft innerhalb einer Minute nach dem Zuordnen.</Empty> : (
                <div class="table-wrap"><table>
                  <thead><tr><th>Server</th><th class="num">kritisch</th><th class="num">hoch</th><th class="num">mittel</th><th class="num">niedrig</th><th>Abgeglichen</th></tr></thead>
                  <tbody>{data.agents.map((a) => (
                    <tr>
                      <td><span class="cell-title">{a.agent_name}</span>{a.last_error ? <span class="cell-sub status-bad">{a.last_error}</span> : a.os && <span class="cell-sub">{a.os}</span>}</td>
                      <td class={`num ${a.counts?.critical ? "status-bad" : ""}`}>{formatNumber(a.counts?.critical ?? 0)}</td>
                      <td class={`num ${a.counts?.high ? "status-warn" : ""}`}>{formatNumber(a.counts?.high ?? 0)}</td>
                      <td class="num">{formatNumber(a.counts?.medium ?? 0)}</td>
                      <td class="num">{formatNumber((a.counts?.low ?? 0) + (a.counts?.unassigned ?? 0))}</td>
                      <td class="nowrap">{a.synced_at ? <Ago at={a.synced_at} /> : <span class="muted">noch nicht</span>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
          )}

          {hasWazuh && data.packages.length > 0 && (
            <Card title="Pakete mit kritischen und hohen Schwachstellen" description="Je Server und Paketversion; ein Update des Pakets schließt meist alle ihre CVEs auf einmal." flush>
              <div class="table-wrap"><table>
                <thead><tr><th>Paket</th><th>Server</th><th class="num">CVEs</th><th class="num">davon kritisch</th><th class="num">CVSS max.</th><th>Seit</th></tr></thead>
                <tbody>{data.packages.map((p) => (
                  <tr>
                    <td><span class="cell-title mono small">{p.component}</span><span class="cell-sub mono">{p.component_version}</span></td>
                    <td class="small">{p.target}</td>
                    <td class="num">{formatNumber(p.cves)}</td>
                    <td class={`num ${p.critical ? "status-bad" : ""}`}>{formatNumber(p.critical)}</td>
                    <td class="num">{p.cvss !== null ? Number(p.cvss).toLocaleString("de-DE", { minimumFractionDigits: 1 }) : "–"}</td>
                    <td class="nowrap small"><Ago at={p.since} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
              {data.packages.length === 100 && <p class="muted small card-note">Die 100 Pakete mit den meisten kritischen Schwachstellen.</p>}
            </Card>
          )}

          {hasWazuh && data.agentNames.length > 0 && (
            <Card title="Alarme (Wazuh)" description="Was die Agenten dieser Server in den letzten 24 Stunden gemeldet haben, direkt aus dem Wazuh-Indexer.">
              <div hx-get={`${base}/alerts`} hx-trigger="load" hx-swap="outerHTML"><p class="muted small">Lädt …</p></div>
            </Card>
          )}
        </div>
      </EnvShell>,
    );
  });

  app.get("/env/:id/security/alerts", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 3);
    if (!env) return c.notFound();
    const agents = await rls(c, (tx) => mappedWazuhAgents(tx, env.id));
    if (!agents) return c.notFound();
    return c.html(<WazuhAlerts agents={agents} />);
  });
}
