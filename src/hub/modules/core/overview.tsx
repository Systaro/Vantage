import type { Hono } from "hono";
import { Ago, Badge, Card, Empty, formatPercent, PageHead, Stat, StatusBanner } from "../../../shared/ui/components";
import { Icon } from "../../../shared/ui/icons";
import { all, rls } from "../../db";
import { ENV_KIND_LABEL, EnvKindBadge, HubPage } from "../../ui";

export interface EnvRow {
  id: number;
  name: string;
  kind: string;
  project_id: number;
  project_name: string;
  org_id: number;
  org_name: string;
  level: number;
  up: number;
  down: number;
  pending: number;
  open_incidents: number;
  open_errors: number;
  uptime24: string | null;
  last_run_status: string | null;
  last_run_at: string | null;
}

export const RUN_STATUS: Record<string, { label: string; tone: "ok" | "bad" | "warn" | "idle" }> = {
  passed: { label: "grün", tone: "ok" },
  failed: { label: "rot", tone: "bad" },
  flaky: { label: "wackelig", tone: "warn" },
  interrupted: { label: "abgebrochen", tone: "idle" },
};

export function uptimeBadge(r: { up: number; down: number; pending: number }) {
  if (r.down > 0) return <Badge tone="bad" dot>{r.down} down</Badge>;
  if (r.up > 0) return <Badge tone="ok" dot>{r.up} up</Badge>;
  if (r.pending > 0) return <Badge tone="idle" dot>ausstehend</Badge>;
  return <Badge tone="idle">keine Monitore</Badge>;
}

/** `short` is for the overview table, whose column header already says "Monitore". */
function uptimeLine(e: EnvRow, short = false) {
  const total = e.up + e.down + e.pending;
  if (total === 0) return <span class="env-status idle"><span class="dot idle" />{short ? "keine" : "Keine Monitore"}</span>;
  if (e.down > 0) return <span class="env-status bad"><span class="dot bad pulse" />{e.down} von {total}{short ? "" : " Monitoren"} down</span>;
  if (e.up === 0) return <span class="env-status idle"><span class="dot idle" />Prüfung läuft</span>;
  if (short) return <span class="env-status ok"><span class="dot ok" />{total === 1 ? "erreichbar" : `alle ${total} erreichbar`}</span>;
  return <span class="env-status ok"><span class="dot ok" />{total === 1 ? "Monitor erreichbar" : `Alle ${total} Monitore erreichbar`}</span>;
}

function UptimeFigure(props: { value: string | null }) {
  if (props.value === null) return <span class="subtle">–</span>;
  const uptime = Number(props.value);
  return <span class={`uptime-figure ${uptime >= 99.9 ? "status-ok" : uptime >= 99 ? "status-warn" : "status-bad"}`} title="Uptime der letzten 24 Stunden">{formatPercent(uptime, 2)}</span>;
}

function LastRun(props: { e: EnvRow }) {
  const e = props.e;
  if (!e.last_run_status) return <span class="subtle">keine Tests</span>;
  return <><Badge tone={RUN_STATUS[e.last_run_status]?.tone}>{RUN_STATUS[e.last_run_status]?.label}</Badge><Ago at={e.last_run_at} /></>;
}

export function EnvTile(props: { e: EnvRow }) {
  const e = props.e;
  return (
    <a class={`env-tile${e.down > 0 ? " is-down" : ""}`} href={`/env/${e.id}`}>
      <div class="row-between">
        <span class="name">{e.name}</span>
        <EnvKindBadge kind={e.kind} name={e.name} />
      </div>
      <div class="row-between">
        {uptimeLine(e)}
        {e.uptime24 !== null && <UptimeFigure value={e.uptime24} />}
      </div>
      <div class="facts-row">
        <span class="fact" title="Letzter Testlauf">
          <Icon name="flask-conical" size="sm" />
          <LastRun e={e} />
        </span>
        {e.open_incidents > 0 && <span class="fact status-warn"><Icon name="siren" size="sm" />{e.open_incidents} offen</span>}
        {e.level >= 2 && e.open_errors > 0 && <span class="fact status-warn"><Icon name="bug" size="sm" />{e.open_errors} Fehler</span>}
      </div>
    </a>
  );
}

type OrgGroup = { name: string; projects: Map<number, { name: string; envs: EnvRow[] }> };

/** A count that only matters when it is not zero; on a phone the zero ones are left out. */
function CountCell(props: { n: number; icon: "siren" | "bug"; label: string }) {
  return props.n > 0
    ? <td class="num env-count"><span class="fact status-warn" title={props.label}><Icon name={props.icon} size="sm" />{props.n}</span></td>
    : <td class="num env-count is-empty"><span class="subtle">–</span></td>;
}

/**
 * Every environment in one table, a header row per customer, the project name spanning its
 * environments. Each project is a tbody of its own, so the search shows or hides it as a whole.
 */
function EnvTable(props: { orgs: OrgGroup[]; showErrors: boolean }) {
  const cols = props.showErrors ? 7 : 6;
  return (
    <div class="table-wrap">
      <table class="env-table">
        <thead>
          <tr>
            <th>Projekt</th><th>Umgebung</th><th>Monitore</th><th class="num">Uptime 24 h</th><th>Letzter Testlauf</th><th class="num">Vorfälle</th>
            {props.showErrors && <th class="num">Fehler 24 h</th>}
          </tr>
        </thead>
        {props.orgs.map((org, oi) => [
          <tbody class="env-org" data-filter-head={`org-${oi}`}>
            <tr class="group-row"><th colspan={cols} scope="colgroup"><span class="row-inline"><Icon name="building-2" size="sm" />{org.name}</span></th></tr>
          </tbody>,
          ...[...org.projects.entries()].map(([pid, p]) => {
            const project = <a class="link-quiet" href={`/projects/${pid}`}>{p.name}</a>;
            const search = [org.name, p.name, ...p.envs.flatMap((e) => [e.name, ENV_KIND_LABEL[e.kind] ?? e.kind])].join(" ").toLowerCase();
            return (
              <tbody class="env-group" data-filter-group={`org-${oi}`} data-search={search}>
                {p.envs.length === 0
                  ? <tr><td class="env-project">{project}</td><td colspan={cols - 1} class="muted">Keine Umgebungen freigegeben.</td></tr>
                  : p.envs.map((e, i) => (
                    <tr class={e.down > 0 ? "is-down" : undefined}>
                      {i === 0 && <td class="env-project" rowspan={p.envs.length}>{project}</td>}
                      <td class="env-name"><span class="row-inline"><a href={`/env/${e.id}`}>{e.name}</a><EnvKindBadge kind={e.kind} name={e.name} /></span></td>
                      <td class="env-monitors">{uptimeLine(e, true)}</td>
                      <td class={`num env-uptime${e.uptime24 === null ? " is-empty" : ""}`}><UptimeFigure value={e.uptime24} /></td>
                      <td class="env-tests"><span class="row-inline"><LastRun e={e} /></span></td>
                      <CountCell n={e.open_incidents} icon="siren" label="Offene Vorfälle" />
                      {props.showErrors && <CountCell n={e.level >= 2 ? e.open_errors : 0} icon="bug" label="Offene Fehlergruppen der letzten 24 Stunden" />}
                    </tr>
                    ))}
              </tbody>
            );
          }),
        ])}
      </table>
    </div>
  );
}

/** Status figures per environment the user may see; optionally only one project's. Runs inside rls(). */
export function loadEnvRows(tx: any, projectId: number | null) {
  return all<EnvRow>(tx`
        select e.id, e.name, e.kind, p.id as project_id, p.name as project_name, o.id as org_id, o.name as org_name,
               vantage_level(vantage_uid(), e.id) as level,
               (select count(*)::int from monitor_state s where s.environment_id = e.id and s.status = 'up') as up,
               (select count(*)::int from monitor_state s where s.environment_id = e.id and s.status = 'down') as down,
               (select count(*)::int from monitor_state s where s.environment_id = e.id and s.status = 'pending') as pending,
               (select count(*)::int from incidents i where i.environment_id = e.id and i.resolved_at is null) as open_incidents,
               (select count(*)::int from error_groups g where g.environment_id = e.id and g.status = 'open'
                  and g.last_seen_at > now() - interval '24 hours') as open_errors,
               (select round(100.0 * avg(case when k.ok then 1 else 0 end), 2) from monitor_checks k
                  where k.environment_id = e.id and k.at > now() - interval '24 hours') as uptime24,
               lr.status as last_run_status, lr.received_at as last_run_at
        from environments e
        join projects p on p.id = e.project_id
        join organisations o on o.id = p.organisation_id
        left join lateral (
          select status, received_at from test_runs r where r.environment_id = e.id order by received_at desc limit 1
        ) lr on true
        where (${projectId}::int is null or p.id = ${projectId}::int)
        order by o.name, p.name, e.sort_order, e.name`);
}

export function mountOverview(app: Hono) {
  app.get("/", async (c) => {
    const { envs, projects, openIncidents } = await rls(c, async (tx) => ({
      envs: await loadEnvRows(tx, null),
      projects: await all<{ id: number; name: string; org_name: string }>(tx`
        select p.id, p.name, o.name as org_name from projects p join organisations o on o.id = p.organisation_id
        order by o.name, p.name`),
      // Same count as the sidebar: every open incident the user may see, including fleet-wide ones.
      openIncidents: ((await tx`select count(*)::int as n from incidents where resolved_at is null`) as { n: number }[])[0]?.n ?? 0,
    }));

    const down = envs.reduce((n, e) => n + e.down, 0);
    const downEnvs = envs.filter((e) => e.down > 0);
    const red = envs.filter((e) => e.last_run_status === "failed").length;
    const errors = envs.reduce((n, e) => n + e.open_errors, 0);
    const showErrors = envs.some((e) => e.level >= 2);

    const byOrg = new Map<string, OrgGroup>();
    for (const p of projects) {
      if (!byOrg.has(p.org_name)) byOrg.set(p.org_name, { name: p.org_name, projects: new Map() });
      byOrg.get(p.org_name)!.projects.set(p.id, { name: p.name, envs: [] });
    }
    for (const e of envs) byOrg.get(e.org_name)?.projects.get(e.project_id)?.envs.push(e);

    const banner = downEnvs.length > 0 ? (
      <StatusBanner
        tone="bad"
        title={`${down} Monitor${down === 1 ? "" : "e"} down`}
        text={`Betroffen: ${downEnvs.map((e) => `${e.project_name} ${e.name}`).join(", ")}`}
        actions={<a class="btn small" href="/incidents">Vorfälle ansehen</a>}
      />
    ) : openIncidents > 0 ? (
      <StatusBanner tone="warn" title={`${openIncidents} offene${openIncidents === 1 ? "r" : ""} Vorfall${openIncidents === 1 ? "" : "e"}`} text="Alle Monitore sind erreichbar." actions={<a class="btn small" href="/incidents">Ansehen</a>} />
    ) : (
      <StatusBanner tone="ok" title="Alle Systeme betriebsbereit" text="Alle Monitore erreichbar, keine offenen Vorfälle." />
    );

    return c.html(
      <HubPage c={c} title="Alle Projekte" section="overview">
        <PageHead title="Alle Projekte" sub="Der Zustand aller Umgebungen, auf die Sie Zugriff haben, nach Kunde und Projekt." />
        {projects.length === 0 ? (
          <Card>
            <Empty title="Noch keine Freigaben" icon="shield-check">
              Ihr Zugang ist eingerichtet, aber noch keinem Projekt zugeordnet. Systaro schaltet die Projekte für Sie frei.
            </Empty>
          </Card>
        ) : (
          <div class="stack">
            {banner}
            <div class="grid grid-4">
              <Stat icon="heart-pulse" label="Monitore down" value={down} tone={down > 0 ? "bad" : "ok"} hint={down > 0 ? "jetzt gerade" : "alles erreichbar"} />
              <Stat icon="siren" label="Offene Vorfälle" value={openIncidents} tone={openIncidents > 0 ? "warn" : undefined} hint="inklusive systemweiter" />
              <Stat icon="flask-conical" label="Rote Testläufe" value={red} tone={red > 0 ? "bad" : undefined} hint="letzter Lauf je Umgebung" />
              {showErrors && <Stat icon="bug" label="Fehlergruppen (24 h)" value={errors} tone={errors > 0 ? "warn" : undefined} hint="offen, zuletzt gesehen" />}
            </div>
            <div data-filter-scope>
              <Card
                flush
                title={
                  <label class="search-field">
                    <Icon name="search" size="sm" />
                    <input type="search" placeholder="Kunde, Projekt oder Umgebung" aria-label="Projekte durchsuchen" autocomplete="off" data-filter=".env-table tbody.env-group" />
                  </label>
                }
              >
                <EnvTable orgs={[...byOrg.values()]} showErrors={showErrors} />
                <div data-filter-empty hidden><Empty title="Nichts gefunden" icon="search">Kein Kunde, kein Projekt und keine Umgebung passt zu dieser Suche.</Empty></div>
              </Card>
            </div>
          </div>
        )}
      </HubPage>,
    );
  });
}
