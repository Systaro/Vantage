import type { Hono } from "hono";
import { parseId, redirectWith } from "../../shared/http";
import { ActionButton, Ago, Badge, Card, Empty, formatDate, PageHead, StatusBanner, Tabs } from "../../shared/ui/components";
import { Icon } from "../../shared/ui/icons";
import { all, first } from "../../shared/db";
import { can } from "../roles";
import type { Ops } from "../service";
import { audit, Breakable, localPath, OpsPage, SeverityBadge } from "../ui";

const PAGE = 100;
const STATE_TEXT: Record<string, string> = { firing: "ausgelöst", resolved: "behoben", notice: "Hinweis" };

export function HubTokenWarning() {
  return (
    <StatusBanner
      tone="warn"
      title="Ereignisse gehen nicht an den Hub."
      text={<><code>OPS_HUB_EVENT_TOKEN</code> ist leer. Sie bleiben im Ausgang, bis ein Token eingetragen ist (im Hub unter Verwaltung → Maschinen-Tokens erzeugen) und Ops neu startet.</>}
    />
  );
}

/** Shown while the sender waits after a failed delivery. */
export function HubBackoffBanner(props: { ops: Ops }) {
  const until = props.ops.outbox.backoffUntil;
  if (!until) return null;
  return (
    <StatusBanner
      tone="warn"
      title="Der Hub war zuletzt nicht erreichbar."
      text={<>{props.ops.outbox.lastError} · nächster Versuch <Ago at={until} /></>}
    />
  );
}

/** Open problems as ops currently reports them, most severe first. */
export function AlertsTable(props: { alerts: any[]; publicUrl: string; showSubject?: boolean }) {
  return (
    <div class="table-wrap"><table>
      <thead><tr><th>Schwere</th><th>Problem</th><th>Seit</th></tr></thead>
      <tbody>{props.alerts.map((a) => {
        const href = localPath(props.publicUrl, a.link);
        return (
          <tr>
            <td class="nowrap"><SeverityBadge severity={a.severity} /></td>
            <td class="ops-wrap">
              {href ? <a class="cell-title link-quiet" href={href}><Breakable text={a.title} /></a> : <span class="cell-title"><Breakable text={a.title} /></span>}
              {a.body && <span class="cell-sub">{a.body}</span>}
              {props.showSubject && <span class="cell-sub mono"><Breakable text={a.subject} /></span>}
            </td>
            <td class="nowrap ops-time"><Ago at={a.since} /><span class="cell-sub">{formatDate(a.since)}</span></td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

function DeliveryBadge(props: { status: string }) {
  if (props.status === "sent") return <Badge tone="ok" icon="check">zugestellt</Badge>;
  if (props.status === "failed") return <Badge tone="bad" dot>fehlgeschlagen</Badge>;
  return <Badge tone="idle" icon="clock">ausstehend</Badge>;
}

export function mountEvents(app: Hono, ops: Ops) {
  app.get("/events", async (c) => {
    const status = ["pending", "sent", "failed"].includes(c.req.query("status") ?? "") ? c.req.query("status")! : "";
    const before = parseId(c.req.query("before"));
    const rows = await all<any>(ops.sql`
      select o.*, (o.status = 'failed' and not exists (select 1 from outbox n where n.subject = o.subject and n.id > o.id)) as retryable
      from outbox o
      where (${status} = '' or o.status = ${status}) and (${before}::int is null or o.id < ${before}::int)
      order by o.id desc limit ${PAGE}`);
    const counts = await first<any>(ops.sql`select count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'failed')::int as failed from outbox`);
    const alerts = await all<any>(ops.sql`select * from alerts order by severity = 'critical' desc, since desc`);
    const canRetry = can(c.get("user"), "admin");
    const last = rows.at(-1);
    const emptyTitle = status === "pending" ? "Nichts ausstehend" : status === "failed" ? "Nichts fehlgeschlagen" : status === "sent" ? "Noch nichts zugestellt" : "Noch keine Ereignisse";
    return c.html(
      <OpsPage c={c} title="Ereignisse" section="events">
        <PageHead
          icon="activity"
          title="Ereignisse an den Hub"
          sub="Ops meldet jeden Zustandswechsel über einen Ausgang an den Hub; der Hub benachrichtigt die zuständigen Personen."
        />
        {!ops.outbox.configured && <HubTokenWarning />}
        <HubBackoffBanner ops={ops} />
        <div class="stack">
          <Card title="Offene Probleme" icon="triangle-alert" description="Was Ops gerade als ausgelöst meldet, kritische zuerst." flush>
            {alerts.length === 0
              ? <Empty title="Keine offenen Probleme" icon="circle-check">Alle Hosts, Läufe und Pipelines sind in Ordnung.</Empty>
              : <AlertsTable alerts={alerts} publicUrl={ops.config.publicUrl} showSubject />}
          </Card>
          <Card title="Ausgang" icon="send" description="Jedes Ereignis bleibt hier, bis der Hub es angenommen hat. Fehlgeschlagene lassen sich erneut senden." flush>
            <div class="ops-card-tabs">
              <Tabs items={[
                { href: "/events", label: "Alle", active: status === "" },
                { href: "/events?status=pending", label: "Ausstehend", icon: "clock", count: counts?.pending ?? 0, active: status === "pending" },
                { href: "/events?status=failed", label: "Fehlgeschlagen", icon: "circle-x", count: counts?.failed ?? 0, active: status === "failed" },
                { href: "/events?status=sent", label: "Zugestellt", icon: "check", active: status === "sent" },
              ]} />
            </div>
            {rows.length === 0 ? <Empty title={emptyTitle} icon="send" /> : (
              <div class="table-wrap"><table>
                <thead><tr><th>Ereignis</th><th>Schwere</th><th>Umgebung</th><th>Versand</th><th>Zeit</th><th></th></tr></thead>
                <tbody>{rows.map((e) => (
                  <tr>
                    <td class="ops-wrap">
                      <span class="cell-title"><Breakable text={e.title} /></span>
                      <span class="cell-sub">{STATE_TEXT[e.state] ?? e.state} · <span class="mono"><Breakable text={e.subject} /></span></span>
                    </td>
                    <td class="nowrap"><SeverityBadge severity={e.state === "resolved" ? "ok" : e.severity} /></td>
                    <td class="small mono">{e.environment ?? <span class="subtle">–</span>}</td>
                    <td>
                      <DeliveryBadge status={e.status} />
                      {e.attempts > 0 && e.status !== "sent" && (
                        <span class="cell-sub ops-clip" title={e.last_error ?? undefined}>{e.attempts} Versuch(e){e.last_error ? `: ${e.last_error}` : ""}</span>
                      )}
                    </td>
                    <td class="nowrap ops-time"><Ago at={e.created_at} /><span class="cell-sub">{formatDate(e.created_at)}</span></td>
                    <td class="right">{canRetry && e.retryable && <ActionButton action={`/events/${e.id}/retry`} label="Erneut senden" icon="refresh-cw" small />}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
          {rows.length === PAGE && last && (
            <div class="ops-pager"><a class="btn" href={`/events?status=${status}&before=${last.id}`}>Ältere Ereignisse<Icon name="arrow-right" size="sm" /></a></div>
          )}
        </div>
      </OpsPage>,
    );
  });

  // Only the newest event of a subject may be resent, so an old `firing` can never overtake its `resolved`.
  app.post("/events/:id/retry", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await ops.sql`update outbox o set status = 'pending', last_error = null
      where o.id = ${id} and o.status = 'failed' and not exists (select 1 from outbox n where n.subject = o.subject and n.id > o.id)
      returning subject`;
    if (!rows.length) return redirectWith(c, "/events?status=failed", { kind: "bad", text: "Dieses Ereignis lässt sich nicht erneut senden; es gibt ein neueres zum selben Betreff." });
    await audit(ops.sql, c, "event.retry", (rows[0] as any).subject, { id });
    ops.outbox.wake();
    return redirectWith(c, "/events?status=pending", { kind: "ok", text: "Ereignis wird erneut gesendet." });
  });
}
