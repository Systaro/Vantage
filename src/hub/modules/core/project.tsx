import type { Hono } from "hono";
import { parseId } from "../../../shared/http";
import { Ago, Badge, Card, Empty, formatDuration, formatNumber, PageHead, StatusBanner } from "../../../shared/ui/components";
import { all, first, rls } from "../../db";
import { HubPage, rememberProject } from "../../ui";
import { IncidentTable } from "../alerts/routes";
import { EnvTile, loadEnvRows, RUN_STATUS } from "./overview";

/** "org.springframework.dao.DataAccessResourceFailureException" → "DataAccessResourceFailureException". */
function shortType(type: string | null): string {
  if (!type) return "Fehler";
  return type.split(".").pop() ?? type;
}

/** One project at a glance: every environment side by side, plus incidents, test runs and errors across all of them. */
export function mountProject(app: Hono) {
  app.get("/projects/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const data = await rls(c, async (tx) => {
      const project = await first<{ id: number; name: string; org_name: string }>(tx`
        select p.id, p.name, o.name as org_name from projects p join organisations o on o.id = p.organisation_id where p.id = ${id}`);
      if (!project) return null;
      return {
        project,
        envs: await loadEnvRows(tx, id),
        incidents: await all<any>(tx`
          select i.id, i.title, i.source, i.severity, i.opened_at, i.resolved_at, i.environment_id, ev.link,
                 p.name || ' · ' || e.name as env_label
          from incidents i
          join environments e on e.id = i.environment_id
          join projects p on p.id = e.project_id
          left join events ev on ev.id = i.opened_event_id
          where e.project_id = ${id} and i.resolved_at is null
          order by i.opened_at desc limit 50`),
        runs: await all<any>(tx`
          select r.id, r.status, r.received_at, r.passed, r.failed, r.total, r.duration_ms, s.name as suite_name, e.name as env_name
          from test_runs r join test_suites s on s.id = r.suite_id join environments e on e.id = r.environment_id
          where e.project_id = ${id} order by r.received_at desc limit 8`),
        // error_groups is diagnostics-only under RLS; for overview users this list stays empty.
        errors: await all<any>(tx`
          select g.id, g.environment_id, g.exception_type, g.message, g.occurrences, g.last_seen_at, e.name as env_name
          from error_groups g join environments e on e.id = g.environment_id
          where e.project_id = ${id} and g.status = 'open' order by g.last_seen_at desc limit 8`),
      };
    });
    if (!data) return c.notFound();
    rememberProject(c, id);
    const { project, envs, incidents, runs, errors } = data;
    const down = envs.filter((e) => e.down > 0);
    const diagnostics = envs.some((e) => e.level >= 2);

    return c.html(
      <HubPage c={c} title={project.name} section="project" projectId={id}>
        <PageHead
          crumbs={[{ href: "/", label: "Alle Projekte" }, { label: project.org_name }]}
          icon="layers"
          title={project.name}
          sub={`${envs.length} Umgebung${envs.length === 1 ? "" : "en"} · ${project.org_name}`}
        />
        <div class="stack">
          {envs.length === 0 ? (
            <Card><Empty title="Keine Umgebungen freigegeben" icon="layers">Für dieses Projekt sind Ihnen noch keine Umgebungen freigegeben.</Empty></Card>
          ) : (
            <>
              {down.length > 0 ? (
                <StatusBanner tone="bad" title={`${down.length === 1 ? "Eine Umgebung hat" : `${down.length} Umgebungen haben`} Ausfälle`} text={down.map((e) => e.name).join(", ")} />
              ) : incidents.length > 0 ? (
                <StatusBanner tone="warn" title={`${incidents.length} offene${incidents.length === 1 ? "r" : ""} Vorfall${incidents.length === 1 ? "" : "e"}`} text="Alle Monitore sind erreichbar." />
              ) : (
                <StatusBanner tone="ok" title="Alles in Ordnung" text="Alle Monitore erreichbar, keine offenen Vorfälle in diesem Projekt." />
              )}
              <div class="grid grid-tiles">{envs.map((e) => <EnvTile e={e} />)}</div>
            </>
          )}

          <Card title="Offene Vorfälle" icon="siren" flush actions={<a class="btn small" href="/incidents">Alle Vorfälle</a>}>
            <IncidentTable rows={incidents} showEnv isAdmin={c.get("user").isAdmin} />
          </Card>
          <div class="grid grid-2">
            <Card title="Letzte Testläufe" icon="flask-conical" flush>
              {runs.length === 0 ? <Empty title="Noch keine Testläufe" icon="flask-conical">Sobald eine Pipeline Ergebnisse hochlädt, erscheinen sie hier.</Empty> : (
                <div class="table-wrap"><table>
                  <thead><tr><th>Lauf</th><th>Status</th><th class="num">Grün</th><th class="num">Dauer</th></tr></thead>
                  <tbody>{runs.map((r) => (
                    <tr>
                      <td>
                        <a class="cell-title link-quiet" href={`/runs/${r.id}`}>{r.suite_name}</a>
                        <span class="cell-sub">{r.env_name} · <Ago at={r.received_at} /></span>
                      </td>
                      <td><Badge tone={RUN_STATUS[r.status]?.tone} dot>{RUN_STATUS[r.status]?.label}</Badge></td>
                      <td class="num">{r.passed}/{r.total}</td>
                      <td class="num">{formatDuration(r.duration_ms)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
          {diagnostics && (
            <Card title="Offene Fehler" icon="bug" flush description="Fehlergruppen aus APM über alle Umgebungen">
              {errors.length === 0 ? <Empty title="Keine offenen Fehler" icon="circle-check" /> : (
                <div class="table-wrap"><table>
                  <thead><tr><th>Fehler</th><th class="num">Anzahl</th></tr></thead>
                  <tbody>{errors.map((g) => (
                    <tr>
                      <td class="error-cell">
                        <a class="cell-title link-quiet" href={`/env/${g.environment_id}/errors/${g.id}`}>{shortType(g.exception_type)}</a>
                        <span class="cell-sub">{g.env_name} · <Ago at={g.last_seen_at} /> · {(g.message ?? "").slice(0, 90)}</span>
                      </td>
                      <td class="num">{formatNumber(Number(g.occurrences))}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
          )}
          </div>
        </div>
      </HubPage>,
    );
  });
}
