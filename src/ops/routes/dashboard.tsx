import type { Hono } from "hono";
import type { Child } from "hono/jsx";
import { Ago, Badge, Card, Empty, formatDate, PageHead, Stat, StatusBanner } from "../../shared/ui/components";
import { all, first } from "../../shared/db";
import { can } from "../roles";
import type { Ops } from "../service";
import { OpsPage } from "../ui";
import { AlertsTable, HubTokenWarning } from "./events";
import { hostStates, HostsTable, stateOf } from "./hosts";
import { RunsTable } from "./templates";

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function mountDashboard(app: Hono, ops: Ops) {
  app.get("/", async (c) => {
    const user = c.get("user");
    const hosts = await hostStates(ops);
    const count = (s: string) => hosts.filter((h) => stateOf(h) === s).length;
    const problemHosts = hosts.filter((h) => ["warning", "critical", "silent"].includes(stateOf(h)));
    const alerts = await all<any>(ops.sql`select * from alerts order by severity = 'critical' desc, since desc limit 20`);
    const active = await all<any>(ops.sql`select id, template_id, template_name, status, trigger, started_by_label, queued_at, duration_ms, exit_code
      from runs where status in ('queued', 'running') order by id`);
    const failed = await all<any>(ops.sql`select id, template_id, template_name, status, trigger, started_by_label, queued_at, duration_ms, exit_code
      from runs where status in ('failed', 'error') order by id desc limit 5`);
    const templates = await all<any>(ops.sql`select id, name, schedule from templates where enabled and schedule is not null order by name`);
    const pipelines = await all<any>(ops.sql`select id, name, schedule from pipeline_schedules where enabled and schedule is not null order by name`);
    const outbox = await first<any>(ops.sql`select count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'failed')::int as failed, max(sent_at) as last_sent from outbox`);
    const schedules = [
      ...templates.map((t) => ({ href: `/templates/${t.id}`, kind: "Ansible", name: t.name, expr: t.schedule, next: ops.scheduler.nextRun(`template:${t.id}`) })),
      ...pipelines.map((p) => ({ href: `/schedules/${p.id}`, kind: "Pipeline", name: p.name, expr: p.schedule, next: ops.scheduler.nextRun(`pipeline:${p.id}`) })),
    ].sort((a, b) => (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity));

    const ok = count("ok");
    const critical = count("critical");
    const silent = count("silent");
    const warning = count("warning");
    const unknown = count("unknown");
    const disabled = count("disabled");
    const bad = critical + silent;
    const running = active.filter((r) => r.status === "running").length;
    const queued = active.length - running;
    const outboxStuck = Boolean(outbox?.failed) || Boolean(ops.outbox.backoffUntil);

    const problemParts = [critical && `${critical} kritisch`, silent && `${silent} stumm`, warning && `${warning} mit Warnung`].filter(Boolean);
    const restParts = [unknown && `${unknown} ohne Daten`, disabled && `${disabled} deaktiviert`].filter(Boolean);
    const names = (list: any[]) => list.map((h) => h.name).join(", ");

    // One banner per kind of problem, worst first; "Flotte in Ordnung" only when there is none.
    const banners: Child[] = [];
    if (bad > 0) {
      banners.push(
        <StatusBanner
          tone="bad"
          title={`${plural(bad, "Host", "Hosts")} kritisch oder stumm`}
          text={`Betroffen: ${names(problemHosts.filter((h) => ["critical", "silent"].includes(stateOf(h))))}`}
          actions={<a class="btn small" href="#problem-hosts">Ansehen</a>}
        />,
      );
    }
    if (!ops.outbox.configured) banners.push(<HubTokenWarning />);
    else if (outboxStuck) {
      banners.push(
        <StatusBanner
          tone="warn"
          title="Der Versand an den Hub stockt."
          text={ops.outbox.backoffUntil ? <>Der Hub war zuletzt nicht erreichbar ({ops.outbox.lastError}). Nächster Versuch <Ago at={ops.outbox.backoffUntil} />.</> : `${plural(outbox!.failed, "Ereignis", "Ereignisse")} fehlgeschlagen.`}
          actions={<a class="btn small" href="/events?status=failed">Ausgang ansehen</a>}
        />,
      );
    }
    if (warning > 0) {
      banners.push(
        <StatusBanner
          tone="warn"
          title={`${plural(warning, "Host", "Hosts")} mit Warnung`}
          text={`Betroffen: ${names(problemHosts.filter((h) => stateOf(h) === "warning"))}`}
          actions={bad === 0 ? <a class="btn small" href="#problem-hosts">Ansehen</a> : undefined}
        />,
      );
    }
    if (banners.length === 0) {
      banners.push(
        <StatusBanner
          tone="ok"
          title="Flotte in Ordnung"
          text={hosts.length === 0 ? "Noch keine Hosts angelegt; Läufe und Versand an den Hub laufen normal." : `${plural(ok, "Host meldet", "Hosts melden")} keine Probleme, der Versand an den Hub läuft.`}
        />,
      );
    }

    return c.html(
      <OpsPage c={c} title="Übersicht" section="dashboard">
        <PageHead icon="layout-dashboard" title="Übersicht" sub="Der Zustand der Flotte, laufende Ansible-Läufe, die nächsten Zeitpläne und der Versand an den Hub." />
        <div class="stack">
          <div class="ops-banners">{banners}</div>
          <div class="grid grid-4">
            <Stat
              icon="server"
              label="Hosts in Ordnung"
              value={<>{ok}<span class="ops-stat-of"> / {hosts.length}</span></>}
              hint={restParts.length ? restParts.join(", ") : hosts.length ? "alle aktiv überwacht" : "noch keine Hosts"}
              tone={hosts.length > 0 && ok === hosts.length - disabled ? "ok" : undefined}
            />
            <Stat
              icon="triangle-alert"
              label="Hosts mit Problemen"
              value={problemHosts.length}
              hint={problemParts.length ? problemParts.join(", ") : "keine"}
              tone={bad ? "bad" : warning ? "warn" : undefined}
            />
            <Stat icon="play" label="Läufe aktiv" value={running} hint={`${queued} in der Warteschlange`} />
            <Stat
              icon="send"
              label="Ereignisse ausstehend"
              value={outbox?.pending ?? 0}
              hint={outbox?.failed ? `${outbox.failed} fehlgeschlagen` : outbox?.last_sent ? <>zuletzt zugestellt <Ago at={outbox.last_sent} /></> : "noch nichts zugestellt"}
              tone={outboxStuck ? "bad" : undefined}
            />
          </div>

          <Card
            title="Offene Probleme"
            icon="triangle-alert"
            description="Was Ops gerade an den Hub meldet, kritische zuerst."
            flush
            actions={<a class="btn small" href="/events">Alle Ereignisse</a>}
          >
            {alerts.length === 0
              ? <Empty title="Keine offenen Probleme" icon="circle-check">Alle Hosts, Läufe und Pipelines sind in Ordnung.</Empty>
              : <AlertsTable alerts={alerts} publicUrl={ops.config.publicUrl} />}
          </Card>

          {problemHosts.length > 0 && (
            <Card
              id="problem-hosts"
              title="Hosts mit Problemen"
              icon="server"
              description="Hosts mit Warnung, kritischem Wert oder ohne Bericht im erwarteten Intervall."
              flush
              actions={<a class="btn small" href="/hosts">Alle Hosts</a>}
            >
              <HostsTable hosts={problemHosts} />
            </Card>
          )}

          <div class="grid grid-2">
            <Card
              title="Laufende und wartende Läufe"
              icon="play"
              description="Ansible-Läufe, die gerade arbeiten oder auf einen freien Platz warten."
              flush
              actions={<a class="btn small" href="/runs?filter=active">Alle</a>}
            >
              {active.length === 0
                ? <Empty title="Gerade läuft nichts" icon="list-checks" action={can(user, "run") ? <a class="btn small" href="/templates">Vorlage starten</a> : undefined} />
                : <RunsTable runs={active} showTemplate compact />}
            </Card>
            <Card
              title="Zuletzt fehlgeschlagen"
              icon="circle-x"
              description="Die letzten fünf Läufe, die mit Fehler endeten."
              flush
              actions={<a class="btn small" href="/runs?filter=failed">Alle</a>}
            >
              {failed.length === 0 ? <Empty title="Keine fehlgeschlagenen Läufe" icon="circle-check" /> : <RunsTable runs={failed} showTemplate compact />}
            </Card>
          </div>

          <Card title="Zeitpläne" icon="calendar-clock" description="Was als Nächstes von selbst startet, Ansible-Vorlagen und GitLab-Pipelines zusammen." flush>
            {schedules.length === 0 ? (
              <Empty title="Nichts geplant" icon="calendar-clock" action={can(user, "admin") ? <a class="btn small" href="/schedules/new">Pipeline-Zeitplan anlegen</a> : undefined}>
                Zeitpläne legen Administratoren an Ansible-Vorlagen und Pipeline-Zeitplänen fest.
              </Empty>
            ) : (
              <div class="table-wrap"><table>
                <thead><tr><th>Name</th><th>Art</th><th>Cron</th><th>Nächster Lauf</th></tr></thead>
                <tbody>{schedules.map((s) => (
                  <tr>
                    <td><a class="cell-title link-quiet" href={s.href}>{s.name}</a></td>
                    <td><Badge tone={s.kind === "Ansible" ? "accent" : "info"} icon={s.kind === "Ansible" ? "terminal" : "git-branch"}>{s.kind}</Badge></td>
                    <td class="mono small">{s.expr}</td>
                    <td class="nowrap ops-time">{s.next ? <><Ago at={s.next} /><span class="cell-sub">{formatDate(s.next)}</span></> : <span class="subtle">–</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
        </div>
      </OpsPage>,
    );
  });
}
