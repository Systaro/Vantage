import type { Context, Hono } from "hono";
import { newToken } from "../../../shared/crypto";
import { formData, parseId, redirectWith, showDialogStep } from "../../../shared/http";
import { ActionButton, Ago, Badge, Card, ChoiceDialog, ConfirmAction, DialogButton, Empty, Field, FormDialog, formatDate, formatDuration, PageHead, SecretBox, StatusBanner } from "../../../shared/ui/components";
import { Icon, type IconName } from "../../../shared/ui/icons";
import { hubConfig } from "../../config";
import { all, rls } from "../../db";
import { audit, EnvShell, HubPage, loadEnv } from "../../ui";
import { AdminShell, nameProblem } from "../core/admin-shell";
import { CHANNEL_LABEL, sealConfig, SEVERITY_LABEL, SOURCE_LABEL, summarize, type ChannelConfig, type ChannelKind } from "./channels";


export function SeverityBadge(props: { severity: string }) {
  const tone = props.severity === "critical" ? "bad" : props.severity === "warning" ? "warn" : "info";
  return <Badge tone={tone}>{SEVERITY_LABEL[props.severity] ?? props.severity}</Badge>;
}

function SeveritySelect(props: { name?: string; value?: string }) {
  return (
    <select name={props.name ?? "min_severity"}>
      <option value="critical" selected={props.value === "critical"}>nur kritisch</option>
      <option value="warning" selected={props.value !== "critical" && props.value !== "info"}>ab Warnung</option>
      <option value="info" selected={props.value === "info"}>alles, auch Hinweise</option>
    </select>
  );
}

/** In-app links as they are; links into other systems (the internal ops UI) only for admins. */
function incidentLink(i: { link?: string | null; environment_id: number | null }, isAdmin: boolean): string | null {
  if (i.link && (i.link.startsWith("/") || isAdmin)) return i.link;
  return i.environment_id ? `/env/${i.environment_id}/incidents` : null;
}

const SOURCE_ICON: Record<string, IconName> = { uptime: "heart-pulse", tests: "flask-conical", errors: "bug", ops: "server", system: "settings" };

export function IncidentTable(props: { rows: any[]; showEnv: boolean; isAdmin: boolean }) {
  if (props.rows.length === 0) return <Empty title="Keine Vorfälle" icon="circle-check">Alles ruhig in diesem Zeitraum.</Empty>;
  return (
    <div class="table-wrap"><table>
      <thead><tr><th>Status</th><th>Vorfall</th><th>Schwere</th><th>Beginn</th><th class="num">Dauer</th></tr></thead>
      <tbody>{props.rows.map((i) => {
        const href = incidentLink(i, props.isAdmin);
        const where = props.showEnv ? (i.env_label ?? "systemweit") : null;
        return (
          <tr>
            <td class="nowrap">{i.resolved_at ? <Badge tone="ok" icon="check">behoben</Badge> : <Badge tone="bad" dot>offen</Badge>}</td>
            <td>
              {href ? <a class="cell-title link-quiet" href={href}>{i.title}</a> : <span class="cell-title">{i.title}</span>}
              <span class="cell-sub row-inline">
                <Icon name={SOURCE_ICON[i.source] ?? "activity"} size="sm" />
                {SOURCE_LABEL[i.source] ?? i.source}
                {where && <> · {i.environment_id ? <a href={`/env/${i.environment_id}`}>{where}</a> : where}</>}
              </span>
            </td>
            <td><SeverityBadge severity={i.severity} /></td>
            <td class="nowrap"><Ago at={i.opened_at} /><span class="cell-sub">{formatDate(i.opened_at)}</span></td>
            <td class="num">{formatDuration((i.resolved_at ? new Date(i.resolved_at).getTime() : Date.now()) - new Date(i.opened_at).getTime())}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

function incidentsQuery(tx: any, envId: number | null, days: number, state: "open" | "resolved" | "all" = "all") {
  return all<any>(tx`
    select i.id, i.title, i.source, i.severity, i.opened_at, i.resolved_at, i.environment_id, ev.link,
           p.name || ' · ' || e.name as env_label
    from incidents i
    left join events ev on ev.id = i.opened_event_id
    left join environments e on e.id = i.environment_id
    left join projects p on p.id = e.project_id
    where (${envId}::int is null or i.environment_id = ${envId}::int)
      and (i.resolved_at is null or i.opened_at > now() - make_interval(days => ${days}))
      and (${state} = 'all' or (${state} = 'open' and i.resolved_at is null) or (${state} = 'resolved' and i.resolved_at is not null))
    order by i.resolved_at is null desc, i.opened_at desc limit 200`);
}

export function mountAlerts(app: Hono) {
  // ── incidents ──────────────────────────────────────────────────────────────────────────────────
  app.get("/incidents", async (c) => {
    const q = c.req.query("state");
    const state = q === "resolved" || q === "all" ? q : "open";
    const { rows, counts } = await rls(c, async (tx) => ({
      rows: await incidentsQuery(tx, null, 14, state),
      counts: (await tx`select count(*) filter (where resolved_at is null)::int as open,
                                count(*) filter (where resolved_at is not null and opened_at > now() - interval '14 days')::int as resolved
                         from incidents`) as { open: number; resolved: number }[],
    }));
    const n = counts[0] ?? { open: 0, resolved: 0 };
    const filters = [
      { key: "open", label: "Offen", count: n.open },
      { key: "resolved", label: "Behoben (14 Tage)", count: n.resolved },
      { key: "all", label: "Alle", count: n.open + n.resolved },
    ];
    return c.html(
      <HubPage c={c} title="Vorfälle" section="incidents">
        <PageHead
          title="Vorfälle"
          icon="siren"
          sub="Probleme, die Vantage erkannt hat: Ausfälle, rote Tests, neue Fehler und Meldungen aus dem Betrieb."
          actions={<a class="btn" href="/account/notifications"><Icon name="bell" size="sm" />Benachrichtigungen einstellen</a>}
        />
        <nav class="seg filter-bar" aria-label="Filter">
          {filters.map((f) => (
            <a class={`btn small${f.key === state ? " active" : ""}`} href={`/incidents?state=${f.key}`} aria-current={f.key === state ? "page" : undefined}>{f.label} <span class="seg-count">{f.count}</span></a>
          ))}
        </nav>
        <Card flush><IncidentTable rows={rows} showEnv isAdmin={c.get("user").isAdmin} /></Card>
      </HubPage>,
    );
  });

  app.get("/env/:id/incidents", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const data = await rls(c, async (tx) => ({
      incidents: await incidentsQuery(tx, env.id, 30),
      events: await all<any>(tx`select at, source, state, severity, title, body, link from events
                                where environment_id = ${env.id} order by at desc limit 100`),
    }));
    return c.html(
      <EnvShell c={c} env={env} tab="incidents" title="Vorfälle">
        <div class="stack">
          <Card title="Vorfälle (30 Tage)" flush><IncidentTable rows={data.incidents} showEnv={false} isAdmin={c.get("user").isAdmin} /></Card>
          <Card title="Ereignisse" flush>
            {data.events.length === 0 ? <Empty title="Noch keine Ereignisse" /> : (
              <div class="table-wrap"><table>
                <thead><tr><th>Zeit</th><th>Quelle</th><th>Ereignis</th><th>Schwere</th></tr></thead>
                <tbody>{data.events.map((e) => (
                  <tr>
                    <td class="nowrap small">{formatDate(e.at)}</td>
                    <td class="small">{SOURCE_LABEL[e.source] ?? e.source}</td>
                    <td>
                      {e.state === "resolved" ? <Badge tone="ok">behoben</Badge> : e.state === "firing" ? <Badge tone="bad">Problem</Badge> : <Badge tone="info">Hinweis</Badge>}{" "}
                      {e.link && (e.link.startsWith("/") || c.get("user").isAdmin) ? <a href={e.link}>{e.title}</a> : e.title}
                      {e.body && <div class="muted small">{e.body}</div>}
                    </td>
                    <td><SeverityBadge severity={e.severity} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
        </div>
      </EnvShell>,
    );
  });

  // ── personal subscriptions ─────────────────────────────────────────────────────────────────────
  app.get("/account/notifications", async (c) => {
    const me = c.get("user");
    const data = await rls(c, async (tx) => ({
      subs: await all<any>(tx`
        select s.id, s.scope_kind, s.scope_id, s.min_severity,
          case s.scope_kind
            when 'project' then (select o.name || ' / ' || p.name from projects p join organisations o on o.id = p.organisation_id where p.id = s.scope_id)
            when 'environment' then (select p.name || ' · ' || e.name from environments e join projects p on p.id = e.project_id where e.id = s.scope_id)
          end as label
        from subscriptions s where s.user_id = ${me.id} order by s.created_at`),
      projects: await all<any>(tx`select p.id, o.name || ' / ' || p.name as label from projects p join organisations o on o.id = p.organisation_id order by 2`),
      envs: await all<any>(tx`select e.id, p.name || ' · ' || e.name as label, vantage_level(vantage_uid(), e.id) as level
                               from environments e join projects p on p.id = e.project_id order by 2`),
    }));
    const hasDiagnostics = data.envs.some((e) => e.level >= 2);
    const hasSecurity = data.envs.some((e) => e.level >= 3);
    return c.html(
      <HubPage c={c} title="Benachrichtigungen" section="notifications">
        <PageHead icon="bell" title="Benachrichtigungen" sub={`E-Mails an ${me.email}`} crumbs={[{ href: "/account", label: "Mein Konto" }]} />
        <Card title="Meine Abos" flush actions={data.subs.length > 0 && <DialogButton dialog="new-subscription" icon="plus" class="small">Abo hinzufügen</DialogButton>}>
          {data.subs.length === 0 ? (
            <Empty title="Keine Abos" icon="bell" action={<DialogButton dialog="new-subscription" icon="plus" class="primary">Abo hinzufügen</DialogButton>}>Sie erhalten noch keine E-Mails.</Empty>
          ) : (
            <div class="table-wrap"><table>
              <thead><tr><th>Für</th><th>Ab</th><th></th></tr></thead>
              <tbody>{data.subs.map((s) => (
                <tr>
                  <td>{s.scope_kind === "all" ? "alles, was ich sehen darf" : s.label ?? <span class="muted">nicht mehr sichtbar</span>}</td>
                  <td>{s.min_severity === "critical" ? "kritisch" : s.min_severity === "warning" ? "Warnung" : "Info"}</td>
                  <td class="right"><ActionButton action={`/account/notifications/${s.id}/delete`} label="Abbestellen" small /></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <FormDialog
          id="new-subscription"
          title="Abo hinzufügen"
          description={<>Sie bekommen eine E-Mail, wenn ein Vorfall beginnt und wenn er behoben ist.{hasDiagnostics ? " Meldungen zu neuen Fehlern gibt es nur für Umgebungen mit Diagnose-Freigabe." : ""}{hasSecurity ? " Meldungen zu neuen Schwachstellen nur für Umgebungen mit Sicherheits-Freigabe." : ""} Fällt eine Freigabe weg, endet auch die Benachrichtigung.</>}
          icon="bell"
          action="/account/notifications"
          submitLabel="Abonnieren"
        >
          <div class="fields">
            <Field label="Wofür" for="scope">
              <select id="scope" name="scope" required>
                <option value="all">Alles, was ich sehen darf</option>
                <optgroup label="Projekt">{data.projects.map((p) => <option value={`project:${p.id}`}>{p.label}</option>)}</optgroup>
                <optgroup label="Umgebung">{data.envs.map((e) => <option value={`environment:${e.id}`}>{e.label}</option>)}</optgroup>
              </select>
            </Field>
            <Field label="Ab Schwere" for="min_severity"><SeveritySelect /></Field>
          </div>
        </FormDialog>
      </HubPage>,
    );
  });

  app.post("/account/notifications", async (c) => {
    const f = await formData(c);
    const [kind, rawId] = f.get("scope").split(":");
    const scopeKind = kind === "project" || kind === "environment" ? kind : "all";
    const scopeId = scopeKind === "all" ? null : parseId(rawId);
    if (scopeKind !== "all" && !scopeId) return redirectWith(c, "/account/notifications", { kind: "bad", text: "Bitte etwas auswählen." });
    const min = ["critical", "warning", "info"].includes(f.get("min_severity")) ? f.get("min_severity") : "warning";
    try {
      // The policy's WITH CHECK refuses scopes the user cannot see.
      await rls(c, (tx) => tx`insert into subscriptions (user_id, scope_kind, scope_id, min_severity)
                               values (${c.get("user").id}, ${scopeKind}, ${scopeId}, ${min})
                               on conflict (user_id, scope_kind, coalesce(scope_id, 0)) do update set min_severity = excluded.min_severity`);
    } catch {
      return redirectWith(c, "/account/notifications", { kind: "bad", text: "Das können Sie nicht abonnieren." });
    }
    await audit(c, "subscription.set", `${scopeKind}:${scopeId ?? ""}`, { min_severity: min });
    return redirectWith(c, "/account/notifications", { kind: "ok", text: "Abo gespeichert." });
  });

  app.post("/account/notifications/:id/delete", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await rls(c, (tx) => tx`delete from subscriptions where id = ${id} and user_id = ${c.get("user").id} returning id`);
    if (!rows.length) return c.notFound();
    await audit(c, "subscription.removed", String(id));
    return redirectWith(c, "/account/notifications", { kind: "ok", text: "Abbestellt." });
  });

  // ── admin: channels and routes ─────────────────────────────────────────────────────────────────
  app.get("/admin/alerts", async (c) => alertsAdmin(c));

  app.post("/admin/alerts/channels", async (c) => {
    const f = await formData(c);
    const kind = f.get("kind") as ChannelKind;
    const problem = nameProblem(f.get("name"));
    if (problem || !CHANNEL_LABEL[kind]) return redirectWith(c, "/admin/alerts", { kind: "bad", text: problem ?? "Unbekannte Art." });
    let cfg: ChannelConfig;
    let shownSecret: string | null = null;
    if (kind === "email") {
      const recipients = f.get("recipients").split(/[\s,;]+/).map((r) => r.trim().toLowerCase()).filter(Boolean);
      if (recipients.length === 0 || recipients.length > 50 || recipients.some((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))) {
        return redirectWith(c, "/admin/alerts", { kind: "bad", text: "Bitte gültige E-Mail-Adressen angeben (bis 50)." });
      }
      cfg = { kind, recipients };
    } else {
      const url = f.get("url");
      if (!/^https:\/\/[^\s]+$/.test(url)) return redirectWith(c, "/admin/alerts", { kind: "bad", text: "Die Webhook-URL muss mit https:// beginnen." });
      if (kind === "webhook") {
        shownSecret = f.get("secret") || newToken("vwh");
        cfg = { kind, url, secret: shownSecret };
      } else {
        cfg = { kind, url };
      }
    }
    await rls(c, async (tx) => tx`insert into channels (name, kind, config_enc, summary) values (${f.get("name")}, ${kind}, ${await sealConfig(hubConfig.secret, cfg)}, ${summarize(cfg)})`);
    await audit(c, "channel.created", f.get("name"), { kind });
    if (shownSecret && !f.get("secret")) {
      return showDialogStep(c, {
        title: `Kanal „${f.get("name")}“ angelegt`,
        icon: "webhook",
        body: (
          <>
            <p>Vantage hat diesen Signatur-Schlüssel erzeugt. Er wird nur jetzt angezeigt.</p>
            <SecretBox id="webhook-secret" value={shownSecret} />
            <p class="muted small">Der Empfänger prüft damit die Signatur: HMAC-SHA256 über „&lt;x-vantage-timestamp&gt;.&lt;Body&gt;“, Header <code>x-vantage-signature: sha256=…</code>. Danach unter „Regel hinzufügen“ festlegen, wofür der Kanal benachrichtigt wird.</p>
          </>
        ),
      });
    }
    return redirectWith(c, "/admin/alerts", { kind: "ok", text: "Kanal angelegt. Jetzt festlegen, wofür er benachrichtigt wird." });
  });

  app.post("/admin/alerts/channels/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const f = await formData(c);
    const action = f.get("action");
    if (action === "toggle") {
      const rows = await rls(c, (tx) => tx`update channels set enabled = not enabled where id = ${id} returning name`);
      if (!rows.length) return c.notFound();
      await audit(c, "channel.toggled", String(id));
      return redirectWith(c, "/admin/alerts", { kind: "ok", text: "Gespeichert." });
    }
    if (action === "delete") {
      const rows = await rls(c, (tx) => tx`delete from channels where id = ${id} returning name`);
      if (!rows.length) return c.notFound();
      await audit(c, "channel.deleted", (rows[0] as any).name);
      return redirectWith(c, "/admin/alerts", { kind: "ok", text: "Kanal gelöscht." });
    }
    if (action === "test") {
      const [row] = (await rls(c, (tx) => tx`select admin_test_channel(${id}) as ev`)) as any[];
      if (!row?.ev) return c.notFound();
      await audit(c, "channel.tested", String(id));
      return redirectWith(c, "/admin/alerts", { kind: "ok", text: "Testnachricht eingereiht. Der Worker verschickt sie in wenigen Sekunden; das Ergebnis steht unten im Versandprotokoll." });
    }
    return c.notFound();
  });

  app.post("/admin/alerts/channels/:id/routes", async (c) => {
    const channelId = parseId(c.req.param("id"));
    const f = await formData(c);
    const [kind, rawId] = f.get("scope").split(":");
    const scopeKind = ["organisation", "project", "environment", "monitor"].includes(kind ?? "") ? kind! : "all";
    const scopeId = scopeKind === "all" ? null : parseId(rawId);
    const sources = f.all("sources").filter((s) => SOURCE_LABEL[s]);
    if (sources.length === 0) return redirectWith(c, "/admin/alerts", { kind: "bad", text: "Mindestens eine Quelle wählen." });
    if (scopeKind !== "all" && !scopeId) return redirectWith(c, "/admin/alerts", { kind: "bad", text: "Bereich fehlt." });
    const min = ["critical", "warning", "info"].includes(f.get("min_severity")) ? f.get("min_severity") : "warning";
    await rls(c, (tx) => tx`insert into routes (channel_id, scope_kind, scope_id, sources, min_severity)
                             values (${channelId}, ${scopeKind}, ${scopeId}, ${tx.array(sources, "text")}, ${min})`);
    await audit(c, "route.created", String(channelId), { scope_kind: scopeKind, scope_id: scopeId, sources, min_severity: min });
    return redirectWith(c, "/admin/alerts", { kind: "ok", text: "Regel hinzugefügt." });
  });

  app.post("/admin/alerts/routes/:id/delete", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await rls(c, (tx) => tx`delete from routes where id = ${id} returning channel_id`);
    if (!rows.length) return c.notFound();
    await audit(c, "route.deleted", String(id));
    return redirectWith(c, "/admin/alerts", { kind: "ok", text: "Regel entfernt." });
  });
}

const CHANNEL_CHOICE: Record<ChannelKind, { text: string; icon: IconName }> = {
  email: { text: "Schickt Vorfälle an feste Adressen, etwa ein Team-Postfach.", icon: "mail" },
  teams: { text: "Postet in einen Teams-Kanal über einen Workflow-Webhook.", icon: "users" },
  slack: { text: "Postet über einen Incoming Webhook in einen Slack-Kanal.", icon: "hash" },
  webhook: { text: "Schickt signiertes JSON an ein eigenes System.", icon: "webhook" },
};

async function alertsAdmin(c: Context) {
  const data = await rls(c, async (tx) => ({
    channels: await all<any>(tx`select id, name, kind, summary, enabled from channels order by name`),
    routes: await all<any>(tx`
      select r.id, r.channel_id, r.scope_kind, r.sources, r.min_severity,
        case r.scope_kind
          when 'organisation' then (select name from organisations where id = r.scope_id)
          when 'project' then (select o.name || ' / ' || p.name from projects p join organisations o on o.id = p.organisation_id where p.id = r.scope_id)
          when 'environment' then (select p.name || ' · ' || e.name from environments e join projects p on p.id = e.project_id where e.id = r.scope_id)
          when 'monitor' then (select p.name || ' · ' || e.name || ' – ' || m.name from monitors m join environments e on e.id = m.environment_id join projects p on p.id = e.project_id where m.id = r.scope_id)
        end as label
      from routes r order by r.id`),
    orgs: await all<any>(tx`select id, name from organisations order by name`),
    projects: await all<any>(tx`select p.id, o.name || ' / ' || p.name as label from projects p join organisations o on o.id = p.organisation_id order by 2`),
    envs: await all<any>(tx`select e.id, p.name || ' · ' || e.name as label from environments e join projects p on p.id = e.project_id order by 2`),
    monitors: await all<any>(tx`select m.id, p.name || ' · ' || e.name || ' – ' || m.name as label
                                 from monitors m join environments e on e.id = m.environment_id join projects p on p.id = e.project_id order by 2`),
    log: await all<any>(tx`
      select n.id, n.status, n.attempts, n.error, n.sent_at, n.created_at, e.title, e.state, ch.name as channel, u.email
      from notifications n join events e on e.id = n.event_id
      left join channels ch on ch.id = n.channel_id left join users u on u.id = n.user_id
      order by n.id desc limit 50`),
  }));
  return c.html(
    <AdminShell c={c} tab="alerts" title="Kanäle & Regeln" actions={<DialogButton dialog="new-channel" icon="plus" class="primary">Kanal anlegen</DialogButton>}>
      <div class="stack">
        <StatusBanner tone="info" title="Nur für Systaro-interne Ziele" text="Kunden abonnieren ihre Benachrichtigungen selbst unter „Mein Konto“; dort prüft Vantage bei jedem Versand die Freigabe. Eine Regel „alles“ auf einen Kanal mit Kundenadressen würde fremde Vorfälle verschicken." />
        {data.channels.length === 0 && <Card><Empty title="Noch keine Kanäle" icon="send" action={<DialogButton dialog="new-channel" icon="plus" class="primary">Kanal anlegen</DialogButton>}>Ein Kanal ist ein Ziel für Benachrichtigungen: E-Mail-Adressen, Teams, Slack oder ein Webhook.</Empty></Card>}
        {data.channels.map((ch) => {
          const routes = data.routes.filter((r) => r.channel_id === ch.id);
          return (
            <Card title={<h2 class="row">{ch.name} <Badge tone="idle">{CHANNEL_LABEL[ch.kind as ChannelKind]}</Badge> {!ch.enabled && <Badge tone="warn">deaktiviert</Badge>}</h2>} actions={
              <>
                <DialogButton dialog={`new-route-${ch.id}`} icon="plus" class="small">Regel hinzufügen</DialogButton>
                <ActionButton action={`/admin/alerts/channels/${ch.id}`} label="Test senden" small fields={{ action: "test" }} />
                <ActionButton action={`/admin/alerts/channels/${ch.id}`} label={ch.enabled ? "Deaktivieren" : "Aktivieren"} small fields={{ action: "toggle" }} />
                <ConfirmAction action={`/admin/alerts/channels/${ch.id}`} label="Löschen" question="Kanal und Regeln löschen?" fields={{ action: "delete" }} />
              </>
            }>
              <div class="stack">
                <p class="muted small mono">{ch.summary}</p>
                {routes.length === 0 ? <p class="muted">Keine Regeln: dieser Kanal bekommt nur Testnachrichten.</p> : (
                  <div class="table-wrap"><table>
                    <thead><tr><th>Bereich</th><th>Quellen</th><th>Ab</th><th></th></tr></thead>
                    <tbody>{routes.map((r) => (
                      <tr>
                        <td>{r.scope_kind === "all" ? "alles" : r.label}</td>
                        <td class="small">{(r.sources as string[]).map((s) => SOURCE_LABEL[s] ?? s).join(", ")}</td>
                        <td>{SEVERITY_LABEL[r.min_severity]}</td>
                        <td class="right"><ActionButton action={`/admin/alerts/routes/${r.id}/delete`} label="Entfernen" small /></td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
              </div>
              <FormDialog id={`new-route-${ch.id}`} title="Regel hinzufügen" description={<>Wofür „{ch.name}“ benachrichtigt wird.</>} icon="sliders-horizontal" action={`/admin/alerts/channels/${ch.id}/routes`} submitLabel="Regel hinzufügen">
                <div class="fields">
                  <Field label="Bereich">
                    <select name="scope">
                      <option value="all">Alles</option>
                      <optgroup label="Organisation">{data.orgs.map((o) => <option value={`organisation:${o.id}`}>{o.name}</option>)}</optgroup>
                      <optgroup label="Projekt">{data.projects.map((p) => <option value={`project:${p.id}`}>{p.label}</option>)}</optgroup>
                      <optgroup label="Umgebung">{data.envs.map((e) => <option value={`environment:${e.id}`}>{e.label}</option>)}</optgroup>
                      <optgroup label="Einzelner Monitor">{data.monitors.map((m) => <option value={`monitor:${m.id}`}>{m.label}</option>)}</optgroup>
                    </select>
                  </Field>
                  <Field label="Ab Schwere"><SeveritySelect /></Field>
                </div>
                <div class="field">
                  <span class="label">Quellen</span>
                  <div class="row">{Object.entries(SOURCE_LABEL).map(([k, label]) => (
                    <label class="check"><input type="checkbox" name="sources" value={k} checked={k !== "system"} /> {label}</label>
                  ))}</div>
                </div>
              </FormDialog>
            </Card>
          );
        })}

        <Card title="Versandprotokoll" flush>
          {data.log.length === 0 ? <Empty title="Noch nichts verschickt" /> : (
            <div class="table-wrap"><table>
              <thead><tr><th>Zeit</th><th>An</th><th>Nachricht</th><th>Status</th></tr></thead>
              <tbody>{data.log.map((n) => (
                <tr>
                  <td class="nowrap small">{formatDate(n.sent_at ?? n.created_at)}</td>
                  <td class="small">{n.channel ?? n.email}</td>
                  <td class="small">{n.title}</td>
                  <td>
                    {n.status === "sent" ? <Badge tone="ok">verschickt</Badge> : n.status === "failed" ? <Badge tone="bad">fehlgeschlagen</Badge> : n.status === "skipped" ? <Badge tone="idle">übersprungen</Badge> : <Badge tone="info">wartet</Badge>}
                    {n.error && <div class="muted small">{n.error} {n.attempts > 0 && `(${n.attempts} Versuche)`}</div>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
      <ChoiceDialog
        id="new-channel"
        title="Kanal anlegen"
        description="Wohin sollen Benachrichtigungen gehen?"
        icon="send"
        choices={(Object.keys(CHANNEL_LABEL) as ChannelKind[]).map((k) => ({ dialog: `new-channel-${k}`, label: CHANNEL_LABEL[k], text: CHANNEL_CHOICE[k].text, icon: CHANNEL_CHOICE[k].icon }))}
      />
      {(Object.keys(CHANNEL_LABEL) as ChannelKind[]).map((k) => (
        <FormDialog id={`new-channel-${k}`} title={`${CHANNEL_LABEL[k]}-Kanal anlegen`} description={CHANNEL_CHOICE[k].text} icon={CHANNEL_CHOICE[k].icon} action="/admin/alerts/channels" submitLabel="Kanal anlegen" back="new-channel">
          <input type="hidden" name="kind" value={k} />
          <Field label="Name"><input name="name" type="text" required placeholder={k === "email" ? "Ops-Postfach" : "Bereitschaft"} /></Field>
          {k === "email" ? (
            <Field label="Empfänger" hint="Mehrere durch Komma oder Zeilenumbruch trennen."><input name="recipients" type="text" required placeholder="ops@systaro.de" /></Field>
          ) : (
            <Field label="Webhook-URL" hint={k === "teams" ? "Teams: Workflow „Bei Empfang einer Webhook-Anforderung posten“." : k === "slack" ? "Slack: Incoming Webhook." : "Erhält JSON mit Signatur-Header."}>
              <input name="url" type="url" required placeholder="https://" />
            </Field>
          )}
          {k === "webhook" && <Field label="Signatur-Schlüssel (optional)" hint="Leer lassen: Vantage erzeugt einen und zeigt ihn einmal an."><input name="secret" type="text" autocomplete="off" /></Field>}
          <p class="muted small">Danach legen Sie fest, wofür der Kanal benachrichtigt wird.</p>
        </FormDialog>
      ))}
    </AdminShell>,
  );
}

