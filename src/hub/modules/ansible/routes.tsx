/**
 * Ansible runs from Semaphore. The environment's Wartung tab (level 3) shows the runs that touched
 * the servers the environment lists, with what each of those servers reported; /admin/ansible shows
 * every run and the servers no environment lists yet. Everything is read from ansible_runs /
 * ansible_run_hosts under RLS; the worker keeps them current (sync.ts).
 */
import type { Context, Hono } from "hono";
import { parseId } from "../../../shared/http";
import { Ago, Badge, Card, Empty, formatDate, formatDuration, formatNumber, Stat } from "../../../shared/ui/components";
import { Icon } from "../../../shared/ui/icons";
import { all, first, rls } from "../../db";
import { EnvShell, loadEnv, type EnvContext } from "../../ui";
import { AdminShell } from "../core/admin-shell";
import { withParams } from "../es/range";
import { semaphoreConnection } from "../integrations/store";
import { FINAL_STATUSES, parseAnsibleConfig, semaphoreRunUrl } from "./semaphore";

const MAX_ROWS = 100;
const ADMIN_ROWS = 200;

export interface RunHost {
  host: string;
  ok: number;
  changed: number;
  unreachable: number;
  failed: number;
  failed_task: string | null;
}

export interface RunRow {
  id: number;
  template_name: string;
  playbook: string | null;
  status: string;
  trigger: "schedule" | "manual";
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  parse_error: string | null;
  hosts: RunHost[];
}

const failedHost = (h: RunHost) => h.failed > 0 || h.unreachable > 0;

/** The servers mapped to the environment, or null without an Ansible source; runs inside rls(). */
export async function mappedAnsibleHosts(tx: any, envId: number): Promise<string[] | null> {
  const row = await first<{ config: unknown }>(tx`select config from environment_sources where environment_id = ${envId} and kind = 'ansible'`);
  return parseAnsibleConfig(row?.config);
}

/**
 * Runs, newest first, each with the results of the given servers only (all servers without a list).
 * `failedOnly` keeps runs in which one of those servers failed or was unreachable. Runs inside rls().
 */
export function ansibleRuns(tx: any, opts: { hosts: string[] | null; failedOnly: boolean; limit: number }): Promise<RunRow[]> {
  const hosts = opts.hosts ? tx.array(opts.hosts, "text") : null;
  return all<RunRow>(tx`
    select r.id, r.template_name, r.playbook, r.status, r.trigger, r.created_at, r.started_at, r.ended_at, r.parse_error,
           coalesce(jsonb_agg(jsonb_build_object('host', h.host, 'ok', h.ok, 'changed', h.changed, 'unreachable', h.unreachable,
                                                 'failed', h.failed, 'failed_task', h.failed_task) order by h.host)
                    filter (where h.host is not null), '[]') as hosts
    from ansible_runs r
    left join ansible_run_hosts h on h.run_id = r.id and (${hosts}::text[] is null or h.host = any(${hosts}::text[]))
    group by r.id
    having (${hosts}::text[] is null or count(h.host) > 0)
       and (not ${opts.failedOnly} or bool_or(h.failed > 0 or h.unreachable > 0) or (${hosts}::text[] is null and r.status = 'error'))
    order by r.created_at desc, r.id desc limit ${opts.limit}`);
}

/** Runs in 30 days that touched the servers, and those in which one of them failed; runs inside rls(). */
export async function runCounts(tx: any, hosts: string[]): Promise<{ runs: number; failed: number }> {
  return (await first<{ runs: number; failed: number }>(tx`
    select count(distinct r.id)::int as runs, count(distinct r.id) filter (where h.failed > 0 or h.unreachable > 0)::int as failed
    from ansible_runs r join ansible_run_hosts h on h.run_id = r.id
    where h.host = any(${tx.array(hosts, "text")}) and r.created_at > now() - interval '30 days'`)) ?? { runs: 0, failed: 0 };
}

export interface HostSummary {
  host: string;
  runs_30d: number;
  failed_30d: number;
  last_run_id: number | null;
  last_template: string | null;
  last_at: Date | null;
  last_failed: boolean | null;
  last_failure_at: Date | null;
}

/** Per server: the newest run, and runs and failures in 30 days; runs inside rls(). */
export function hostSummaries(tx: any, hosts: string[]): Promise<HostSummary[]> {
  return all<HostSummary>(tx`
    select x.host,
           (select count(*)::int from ansible_run_hosts h join ansible_runs r on r.id = h.run_id
             where h.host = x.host and r.created_at > now() - interval '30 days') as runs_30d,
           (select count(*)::int from ansible_run_hosts h join ansible_runs r on r.id = h.run_id
             where h.host = x.host and r.created_at > now() - interval '30 days' and (h.failed > 0 or h.unreachable > 0)) as failed_30d,
           last.run_id as last_run_id, last.template_name as last_template, last.created_at as last_at, last.failed as last_failed,
           (select max(r.created_at) from ansible_run_hosts h join ansible_runs r on r.id = h.run_id
             where h.host = x.host and (h.failed > 0 or h.unreachable > 0)) as last_failure_at
    from unnest(${tx.array(hosts, "text")}::text[]) as x(host)
    left join lateral (
      select h.run_id, r.template_name, r.created_at, (h.failed > 0 or h.unreachable > 0) as failed
      from ansible_run_hosts h join ansible_runs r on r.id = h.run_id where h.host = x.host order by r.created_at desc, r.id desc limit 1
    ) last on true
    order by x.host`);
}

function RunStatus(props: { run: RunRow; scoped: boolean }) {
  const { run } = props;
  if (run.status === "stopped" || run.status === "rejected") return <Badge tone="idle">abgebrochen</Badge>;
  if (!FINAL_STATUSES.includes(run.status)) return <Badge tone="info" dot>läuft</Badge>;
  if (run.hosts.some((h) => h.failed > 0)) return <Badge tone="bad" dot>fehlgeschlagen</Badge>;
  if (run.hosts.some((h) => h.unreachable > 0)) return <Badge tone="bad" dot>nicht erreichbar</Badge>;
  // Scoped to an environment's servers: the run may have failed elsewhere while these were fine.
  if (run.status === "error") return props.scoped ? <Badge tone="ok" title="Der Lauf ist auf anderen Servern fehlgeschlagen.">ok hier</Badge> : <Badge tone="bad" dot>fehlgeschlagen</Badge>;
  return <Badge tone="ok">erfolgreich</Badge>;
}

function HostResults(props: { hosts: RunHost[]; compact?: boolean }) {
  const hosts = props.compact ? props.hosts.filter(failedHost) : props.hosts;
  if (props.compact && hosts.length === 0) return <span class="muted small">{props.hosts.length === 1 ? "1 Server" : `${props.hosts.length} Server`}, alle ok</span>;
  return (
    <ul class="run-hosts">
      {hosts.map((h) => (
        <li>
          <span class="mono small nowrap">{h.host}</span>
          {h.unreachable > 0
            ? <span class="status-bad small">nicht erreichbar{h.failed_task && <> bei „{h.failed_task}“</>}</span>
            : h.failed > 0
              ? <span class="status-bad small">fehlgeschlagen{h.failed_task && <> bei „{h.failed_task}“</>}</span>
              : <span class="muted small nowrap">{h.changed > 0 ? `${h.changed} geändert` : "unverändert"}</span>}
        </li>
      ))}
      {props.compact && props.hosts.length > hosts.length && <li class="muted small">{props.hosts.length - hosts.length} weitere ok</li>}
    </ul>
  );
}

function RunsTable(props: { runs: RunRow[]; scoped: boolean; semaphoreUrl: ((id: number) => string) | null; compact?: boolean }) {
  return (
    <div class="table-wrap"><table class="run-table">
      <thead><tr><th>Gestartet</th><th>Vorlage</th><th>Ergebnis</th><th>Server</th><th class="num">Dauer</th>{props.semaphoreUrl && <th aria-label="Log in Semaphore" />}</tr></thead>
      <tbody>{props.runs.map((r) => (
        <tr>
          <td class="nowrap"><span class="cell-title"><Ago at={r.started_at ?? r.created_at} /></span><span class="cell-sub">{formatDate(r.started_at ?? r.created_at)}</span></td>
          <td><span class="cell-title">{r.template_name}</span><span class="cell-sub">{r.trigger === "schedule" ? "Zeitplan" : "von Hand"}</span></td>
          <td class="nowrap"><RunStatus run={r} scoped={props.scoped} /></td>
          <td>{r.hosts.length > 0
            ? <HostResults hosts={r.hosts} compact={props.compact} />
            : <span class="muted small">{!FINAL_STATUSES.includes(r.status) ? "Ergebnis folgt nach dem Lauf" : r.parse_error ?? "keine Server im Ergebnis"}</span>}</td>
          <td class="num nowrap">{r.started_at && r.ended_at ? formatDuration(new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) : "–"}</td>
          {props.semaphoreUrl && <td class="right"><a class="btn ghost small icon-only" href={props.semaphoreUrl(r.id)} rel="noopener noreferrer" title={`Lauf #${r.id} in Semaphore`}><Icon name="external-link" size="sm" /></a></td>}
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function FailedFilter(props: { base: string; failedOnly: boolean }) {
  return (
    <div class="seg" role="group" aria-label="Läufe">
      <a class={`btn small ${props.failedOnly ? "" : "active"}`} href={props.base} aria-current={props.failedOnly ? undefined : "true"}>Alle</a>
      <a class={`btn small ${props.failedOnly ? "active" : ""}`} href={withParams(props.base, { failed: "1" })} aria-current={props.failedOnly ? "true" : undefined}>Fehlgeschlagen</a>
    </div>
  );
}

/** Admins get a link to the full log in Semaphore; nobody else can open it. */
async function runLink(c: Context): Promise<((id: number) => string) | null> {
  if (!c.get("user")?.isAdmin) return null;
  const conn = await semaphoreConnection();
  return conn ? (id) => semaphoreRunUrl(conn, id) : null;
}

/** Card on the environment overview: failures in 30 days and the newest runs. */
export async function AnsibleOverviewCard(props: { c: Context; env: EnvContext }) {
  const { env } = props;
  const data = await rls(props.c, async (tx) => {
    const hosts = (await mappedAnsibleHosts(tx, env.id)) ?? [];
    return { runs: hosts.length ? await ansibleRuns(tx, { hosts, failedOnly: false, limit: 5 }) : [], counts: hosts.length ? await runCounts(tx, hosts) : { runs: 0, failed: 0 } };
  });
  const failed = data.counts.failed;
  const title = (
    <h2 class="row">
      Wartung
      {data.runs.length > 0 && (failed
        ? <Badge tone="bad" dot>{failed === 1 ? "1 Lauf" : `${formatNumber(failed)} Läufe`} fehlgeschlagen, 30 Tage</Badge>
        : <Badge tone="ok">30 Tage ohne Fehlschlag</Badge>)}
    </h2>
  );
  return (
    <Card title={title} description="Ansible-Läufe auf den Servern dieser Umgebung" flush actions={<a class="btn small" href={`/env/${env.id}/maintenance`}>Alle Läufe</a>}>
      {data.runs.length === 0 ? <Empty title="Noch keine Läufe" icon="terminal" /> : <RunsTable runs={data.runs} scoped semaphoreUrl={null} compact />}
    </Card>
  );
}

export function mountAnsible(app: Hono) {
  app.get("/env/:id/maintenance", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 3);
    if (!env || !env.hasAnsible) return c.notFound();
    const failedOnly = c.req.query("failed") === "1";
    const base = `/env/${env.id}/maintenance`;
    const data = await rls(c, async (tx) => {
      const hosts = (await mappedAnsibleHosts(tx, env.id)) ?? [];
      return {
        hosts,
        summary: hosts.length ? await hostSummaries(tx, hosts) : [],
        counts: hosts.length ? await runCounts(tx, hosts) : { runs: 0, failed: 0 },
        runs: hosts.length ? await ansibleRuns(tx, { hosts, failedOnly, limit: MAX_ROWS }) : [],
      };
    });
    const link = await runLink(c);
    const lastAt = data.summary.map((s) => s.last_at).filter(Boolean).sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0] ?? null;

    return c.html(
      <EnvShell c={c} env={env} tab="maintenance" title="Wartung">
        <div class="stack">
          <div class="grid grid-4">
            <Stat label="Server" value={formatNumber(data.hosts.length)} icon="server" hint={lastAt ? <>letzter Lauf <Ago at={lastAt} /></> : "noch kein Lauf"} />
            <Stat label="Läufe, 30 Tage" value={formatNumber(data.counts.runs)} icon="history" />
            <Stat label="Fehlgeschlagen, 30 Tage" value={formatNumber(data.counts.failed)} icon="circle-alert" tone={data.counts.failed ? "bad" : "ok"} hint="auf mindestens einem dieser Server" />
          </div>

          <Card title="Server" description="Wie die Ansible-Läufe auf jedem Server dieser Umgebung ausgingen." flush>
            <div class="table-wrap"><table>
              <thead><tr><th>Server</th><th>Letzter Lauf</th><th class="num">Läufe, 30 Tage</th><th class="num">fehlgeschlagen</th><th>Letzter Fehler</th></tr></thead>
              <tbody>{data.summary.map((s) => (
                <tr>
                  <td class="mono small nowrap">{s.host}</td>
                  <td>{s.last_run_id
                    ? <><span class="cell-title">{s.last_template}</span><span class="cell-sub">{s.last_failed ? <span class="status-bad">fehlgeschlagen</span> : "ok"} · <Ago at={s.last_at} /></span></>
                    : <span class="muted small">noch kein Lauf</span>}</td>
                  <td class="num">{formatNumber(s.runs_30d)}</td>
                  <td class={`num ${s.failed_30d ? "status-bad" : ""}`}>{formatNumber(s.failed_30d)}</td>
                  <td class="nowrap small">{s.last_failure_at ? <Ago at={s.last_failure_at} /> : <span class="muted">keiner</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {data.summary.some((s) => !s.last_run_id) && (
              <p class="muted small card-note">Ohne Lauf: Der Name muss so geschrieben sein wie im Ansible-Inventar, das zeigt die Server-Auswahl in den Einstellungen.</p>
            )}
          </Card>

          <Card title={<h2>Läufe <span class="muted small">{formatNumber(data.runs.length)}{data.runs.length === MAX_ROWS ? "+" : ""}</span></h2>} flush actions={<FailedFilter base={base} failedOnly={failedOnly} />}>
            {data.runs.length === 0
              ? <Empty title={failedOnly ? "Keine fehlgeschlagenen Läufe" : "Noch keine Läufe"} icon="terminal">{failedOnly ? "Auf diesen Servern ist kein Lauf fehlgeschlagen." : "Vantage liest die Läufe jede Minute aus Semaphore."}</Empty>
              : <RunsTable runs={data.runs} scoped semaphoreUrl={link} />}
            {data.runs.length === MAX_ROWS && <p class="muted small card-note">Die neuesten {MAX_ROWS} Läufe.</p>}
          </Card>
        </div>
      </EnvShell>,
    );
  });

  app.get("/admin/ansible", async (c) => {
    const failedOnly = c.req.query("failed") === "1";
    const data = await rls(c, async (tx) => ({
      runs: await ansibleRuns(tx, { hosts: null, failedOnly, limit: ADMIN_ROWS }),
      unmapped: await all<{ host: string; runs: number; failed: number }>(tx`
        select h.host, count(*)::int as runs, count(*) filter (where h.failed > 0 or h.unreachable > 0)::int as failed
        from ansible_run_hosts h join ansible_runs r on r.id = h.run_id
        where r.created_at > now() - interval '30 days' and h.host <> 'localhost'
          and h.host not in (select jsonb_array_elements_text(s.config->'hosts') from environment_sources s where s.kind = 'ansible')
        group by h.host order by h.host`),
      synced: await first<{ at: Date | null }>(tx`select max(synced_at) as at from ansible_runs`),
    }));
    const link = await runLink(c);
    return c.html(
      <AdminShell c={c} tab="ansible" title="Ansible-Läufe">
        <div class="stack">
          {!link && <p class="status-warn small">Semaphore ist noch nicht angebunden (<a href="/admin/integrations">Integrationen</a>).</p>}
          <Card
            title={<h2>Läufe <span class="muted small">{formatNumber(data.runs.length)}{data.runs.length === ADMIN_ROWS ? "+" : ""}</span></h2>}
            description={data.synced?.at ? <>Zuletzt aus Semaphore gelesen <Ago at={data.synced.at} />.</> : undefined}
            flush
            actions={<FailedFilter base="/admin/ansible" failedOnly={failedOnly} />}
          >
            {data.runs.length === 0
              ? <Empty title={failedOnly ? "Keine fehlgeschlagenen Läufe" : "Noch keine Läufe"} icon="terminal" />
              : <RunsTable runs={data.runs} scoped={false} semaphoreUrl={link} compact />}
          </Card>
          <Card title="Server ohne Umgebung" description="In den letzten 30 Tagen von Ansible bearbeitet, aber keiner Umgebung zugeordnet. Zuordnen unter Umgebung → Einstellungen → Datenquellen." flush>
            {data.unmapped.length === 0 ? <Empty title="Alle Server sind zugeordnet" icon="check" /> : (
              <div class="table-wrap"><table>
                <thead><tr><th>Server</th><th class="num">Läufe, 30 Tage</th><th class="num">fehlgeschlagen</th></tr></thead>
                <tbody>{data.unmapped.map((u) => (
                  <tr><td class="mono small nowrap">{u.host}</td><td class="num">{formatNumber(u.runs)}</td><td class={`num ${u.failed ? "status-bad" : ""}`}>{formatNumber(u.failed)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
        </div>
      </AdminShell>,
    );
  });
}
