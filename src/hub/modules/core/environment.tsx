import type { Hono } from "hono";
import { parseId } from "../../../shared/http";
import { Ago, Badge, Card, Empty, formatNumber } from "../../../shared/ui/components";
import { all, rls } from "../../db";
import { EnvShell, loadEnv } from "../../ui";
import { IncidentTable } from "../alerts/routes";
import { AnsibleOverviewCard } from "../ansible/routes";
import { LogsOverviewCard } from "../logs/routes";
import { SecurityOverviewCard } from "../security/routes";
import { KIND_LABEL, monitorsWithStats, StatusBadge } from "../uptime/routes";
import { RUN_STATUS } from "./overview";

/** The environment landing page: one glance at every module, each linking to its tab. */
export function mountEnvironment(app: Hono) {
  app.get("/env/:id", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const data = await rls(c, async (tx) => ({
      monitors: await monitorsWithStats(tx, env.id),
      suites: await all<any>(tx`
        select s.id, s.name, r.id as run_id, r.status, r.received_at, r.passed, r.failed, r.total
        from test_suites s
        left join lateral (select * from test_runs r where r.suite_id = s.id order by received_at desc limit 1) r on true
        where s.environment_id = ${env.id} order by s.name`),
      incidents: await all<any>(tx`
        select i.id, i.title, i.source, i.severity, i.opened_at, i.resolved_at, i.environment_id, ev.link, null as env_label
        from incidents i left join events ev on ev.id = i.opened_event_id
        where i.environment_id = ${env.id} and i.resolved_at is null order by i.opened_at desc`),
      errors: env.level >= 2
        ? await all<any>(tx`select id, exception_type, message, occurrences, last_seen_at from error_groups
                            where environment_id = ${env.id} and status = 'open' order by last_seen_at desc limit 5`)
        : [],
    }));
    const down = data.monitors.filter((m) => m.status === "down");
    return c.html(
      <EnvShell c={c} env={env} tab="overview" title="Übersicht">
        <div class="stack">
          <div class="grid grid-2">
            <Card title="Uptime" actions={<a class="btn small" href={`/env/${env.id}/uptime`}>Alle Monitore</a>}>
              {data.monitors.length === 0 ? <p class="muted">Keine Monitore eingerichtet.</p> : (
                <div class="stack">
                  <p>{down.length > 0
                    ? <span class="status-bad"><strong>{down.length} von {data.monitors.length}</strong> Monitoren sind down.</span>
                    : <span class="status-ok">Alle {data.monitors.length} Monitore erreichbar.</span>}</p>
                  <table>
                    <tbody>{data.monitors.slice(0, 6).map((m) => (
                      <tr>
                        <td><a href={`/env/${env.id}/uptime/${m.id}`}>{m.name}</a> <span class="muted small">{KIND_LABEL[m.kind]}</span></td>
                        <td class="right"><StatusBadge status={m.status} /></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card title="Tests" actions={<a class="btn small" href={`/env/${env.id}/tests`}>Alle Läufe</a>}>
              {data.suites.length === 0 ? <p class="muted">Keine Testsuiten eingerichtet.</p> : (
                <table>
                  <tbody>{data.suites.map((s) => (
                    <tr>
                      <td>{s.name}</td>
                      <td>{s.status ? <a href={`/runs/${s.run_id}`}><Badge tone={RUN_STATUS[s.status]?.tone}>{RUN_STATUS[s.status]?.label}</Badge></a> : <span class="muted small">noch kein Lauf</span>}</td>
                      <td class="small muted">{s.status && <>{s.passed}/{s.total} grün · <Ago at={s.received_at} /></>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </Card>
          </div>
          <Card title="Offene Vorfälle" flush actions={<a class="btn small" href={`/env/${env.id}/incidents`}>Verlauf</a>}>
            <IncidentTable rows={data.incidents} showEnv={false} isAdmin={c.get("user").isAdmin} />
          </Card>
          {env.level >= 2 && (env.hasApm || env.hasLogs) && (
            <Card title="Offene Fehler" flush actions={<a class="btn small" href={`/env/${env.id}/errors`}>Alle Fehler</a>}>
              {data.errors.length === 0 ? <Empty title="Keine offenen Fehlergruppen" /> : (
                <div class="table-wrap"><table>
                  <thead><tr><th>Fehler</th><th class="num">Vorkommen</th><th>Zuletzt</th></tr></thead>
                  <tbody>{data.errors.map((e) => (
                    <tr>
                      <td><a href={`/env/${env.id}/errors/${e.id}`}>{e.exception_type ?? "Fehler"}</a><div class="muted small">{(e.message ?? "").slice(0, 160)}</div></td>
                      <td class="num">{formatNumber(Number(e.occurrences))}</td>
                      <td><Ago at={e.last_seen_at} /></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
          )}
          {env.level >= 2 && env.hasLogs && <LogsOverviewCard env={env} />}
          {env.level >= 3 && env.hasSecurity && <SecurityOverviewCard c={c} env={env} />}
          {env.level >= 3 && env.hasAnsible && <AnsibleOverviewCard c={c} env={env} />}
          {env.level < 2 && (
            <p class="muted small">Ihre Freigabe für diese Umgebung umfasst den Überblick. Fehler, Logs und APM gehören zur Diagnose-Freigabe, die Systaro bei Bedarf erteilt.</p>
          )}
        </div>
      </EnvShell>,
    );
  });
}
