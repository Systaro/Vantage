import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { newToken, sha256Hex } from "../../shared/crypto";
import { formData, parseId, redirectWith } from "../../shared/http";
import { Ago, Badge, Card, ConfirmAction, Empty, Field, formatDate, formatTime, PageHead, SecretBox, StatusBanner } from "../../shared/ui/components";
import { Icon } from "../../shared/ui/icons";
import { all, first } from "../../shared/db";
import { DEFAULT_THRESHOLDS, effectiveThresholds, parseThresholds, THRESHOLD_FIELDS, thresholdHint, type CheckResult } from "../../shared/hosts/evaluate";
import type { HostRow } from "../hosts/monitor";
import { MAX_REPORT_BYTES, parseReportText } from "../../shared/hosts/report";
import { can } from "../roles";
import type { Ops } from "../service";
import { audit, Breakable, FormActions, isUniqueViolation, OpsPage, SectionHead, SeverityBadge } from "../ui";

export const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const SSH_TARGET = /^([a-z_][a-z0-9_.-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
export const ENV_PATH = /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}$/;
const TOKEN_PATTERN = /^vha_[A-Za-z0-9_-]{43}$/;
export const INTERVALS = [60, 120, 300, 600, 900, 1800, 3600];
/** Reports closer together than this are refused, so a looping agent cannot flood the database. */
const MIN_REPORT_GAP_SECONDS = 20;

const MODE_TEXT: Record<string, string> = { agent: "Agent (meldet selbst)", central: "Zentral (Ops prüft per SSH)" };

export interface HostInput {
  name: string;
  mode: "agent" | "central";
  interval_seconds: number;
  ssh_target: string | null;
  environment_path: string | null;
  thresholds: Record<string, number>;
  enabled: boolean;
}

export function parseHost(f: { get(k: string): string }): { ok: true; h: HostInput } | { ok: false; error: string } {
  const name = f.get("name");
  if (!HOST_NAME.test(name)) return { ok: false, error: "Name: Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich, höchstens 100 Zeichen." };
  const mode = f.get("mode");
  if (mode !== "agent" && mode !== "central") return { ok: false, error: "Bitte die Art der Prüfung wählen." };
  const interval = Number(f.get("interval_seconds"));
  if (!INTERVALS.includes(interval)) return { ok: false, error: "Bitte ein Intervall aus der Liste wählen." };
  const target = f.get("ssh_target");
  if (mode === "central" && !SSH_TARGET.test(target)) {
    return { ok: false, error: "SSH-Ziel: „benutzer@host“ oder ein Host-Alias aus der SSH-Konfiguration, ohne Leerzeichen und Optionen." };
  }
  const env = f.get("environment_path");
  if (env && !ENV_PATH.test(env)) return { ok: false, error: "Hub-Umgebung: als „organisation/projekt/umgebung“ mit den Kürzeln aus dem Hub." };
  const t = parseThresholds(Object.fromEntries(THRESHOLD_FIELDS.map((x) => [x.key, f.get(x.key)])));
  if (!t.ok) return { ok: false, error: t.error };
  return {
    ok: true,
    h: {
      name,
      mode,
      interval_seconds: interval,
      ssh_target: mode === "central" ? target : null,
      environment_path: env || null,
      thresholds: t.thresholds as Record<string, number>,
      enabled: f.get("enabled") === "1",
    },
  };
}

function intervalText(s: number) {
  return s < 3600 ? `${s / 60} min` : `${s / 3600} h`;
}

export function installCommand(publicUrl: string, token: string, intervalSeconds: number): string {
  const minutes = Math.max(1, Math.round(intervalSeconds / 60));
  return `curl -fsSL ${publicUrl}/agent/vantage-agent.sh -o /tmp/vantage-agent.sh && sudo sh /tmp/vantage-agent.sh --install --url ${publicUrl} --token ${token} --interval ${minutes}`;
}

/** Overall state per host: worst check, `silent` when the silent alert is open, `unknown` before the first report. */
export async function hostStates(ops: Ops): Promise<any[]> {
  return all<any>(ops.sql`
    select h.*, coalesce(w.worst, 'unknown') as worst, w.problems,
      exists (select 1 from alerts a where a.subject = 'host:' || h.name || ':silent') as silent
    from hosts h
    left join lateral (
      select case when bool_or(severity = 'critical') then 'critical' when bool_or(severity = 'warning') then 'warning' else 'ok' end as worst,
             count(*) filter (where severity <> 'ok')::int as problems
      from check_states where host_id = h.id having count(*) > 0
    ) w on true
    order by h.name`);
}

export function stateOf(h: { enabled: boolean; silent: boolean; worst: string }): string {
  if (!h.enabled) return "disabled";
  return h.silent ? "silent" : h.worst;
}

const HOST_HINT: Record<string, string> = { ok: "alle Prüfungen in Ordnung", unknown: "noch kein Bericht", silent: "meldet sich nicht", disabled: "wird nicht geprüft" };

function HostState(props: { h: any }) {
  const s = stateOf(props.h);
  return s === "disabled" ? <Badge tone="idle">deaktiviert</Badge> : <SeverityBadge severity={s} />;
}

function HostForm(props: { h?: any; action: string; canSetEnvironment: boolean; cancelHref?: string }) {
  const h = props.h;
  const t = h?.thresholds ?? {};
  return (
    <form method="post" action={props.action} class="stack">
      <Card title="Host" icon="server" description="Wie der Host heißt und wie Ops an seine Werte kommt.">
        <div class="stack">
          <div class="fields">
            <Field label="Name" for="name" hint="So erscheint der Host in Meldungen."><input id="name" name="name" type="text" autocomplete="off" required maxlength={100} value={h?.name ?? ""} placeholder="shop-prod-1" /></Field>
            <Field label="Art" for="mode">
              <select id="mode" name="mode">
                <option value="agent" selected={(h?.mode ?? "agent") === "agent"}>{MODE_TEXT.agent}</option>
                <option value="central" selected={h?.mode === "central"}>{MODE_TEXT.central}</option>
              </select>
            </Field>
            <Field label="Intervall" for="interval_seconds">
              <select id="interval_seconds" name="interval_seconds">
                {INTERVALS.map((s) => <option value={String(s)} selected={(h?.interval_seconds ?? 300) === s}>{intervalText(s)}</option>)}
              </select>
            </Field>
            <Field label="SSH-Ziel (nur zentral)" for="ssh_target" hint="„benutzer@host“ oder Host-Alias; der Schlüssel liegt bei Ops.">
              <input id="ssh_target" name="ssh_target" type="text" class="mono" value={h?.ssh_target ?? ""} placeholder="deploy@web1.example.com" />
            </Field>
          </div>
          <label class="check"><input type="checkbox" name="enabled" value="1" checked={h?.enabled ?? true} /> Aktiv (deaktivierte Hosts werden weder geprüft noch als stumm gemeldet)</label>
        </div>
      </Card>
      <Card title="Hub-Umgebung" icon="layers" description="Wo die Meldungen dieses Hosts im Hub erscheinen.">
        <div class="fields ops-fields-narrow">
          <Field label="Hub-Umgebung (optional)" for="environment_path" hint={props.canSetEnvironment ? "„organisation/projekt/umgebung“: Meldungen erscheinen dort im Hub, auch für die Kunden dieser Umgebung." : "Legen nur Administratoren fest: Meldungen erscheinen dort auch für Kunden."}>
            <input id="environment_path" name="environment_path" type="text" class="mono" value={h?.environment_path ?? ""} placeholder="nordwind/shop/prod" disabled={!props.canSetEnvironment} />
          </Field>
        </div>
      </Card>
      <Card title="Schwellenwerte" icon="sliders-horizontal" description="Leer = Standard. Fehlgeschlagene systemd-Units und gestoppte Container, die laufen sollten, sind ab einem Treffer eine Warnung.">
        <div class="fields ops-threshold-fields">
          {THRESHOLD_FIELDS.map((f) => (
            <Field label={`${f.label}${f.unit ? ` (${f.unit})` : ""}`} for={f.key}>
              <input id={f.key} name={f.key} type="text" inputmode="decimal" value={t[f.key] !== undefined ? String(t[f.key]) : ""} placeholder={String(DEFAULT_THRESHOLDS[f.key])} />
            </Field>
          ))}
        </div>
      </Card>
      <FormActions label={h ? "Speichern" : "Host anlegen"} cancelHref={props.cancelHref} />
    </form>
  );
}

export function mountHostsApi(app: Hono, ops: Ops) {
  // The agent script is not secret; agent hosts fetch it during installation.
  app.get("/agent/vantage-agent.sh", () =>
    new Response(Bun.file(ops.config.agentScript), {
      headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" },
    }),
  );

  app.post(
    "/api/ingest/v1/report",
    bodyLimit({ maxSize: MAX_REPORT_BYTES, onError: (c) => c.json({ error: "report too large" }, 413) }),
    async (c) => {
      const auth = c.req.header("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!TOKEN_PATTERN.test(token)) return c.json({ error: "unauthorized" }, 401);
      const host = await first<HostRow & { recent: boolean }>(ops.sql`
        select id, name, mode, interval_seconds, ssh_target, environment_path, thresholds, enabled,
               coalesce(last_report_at > now() - make_interval(secs => ${MIN_REPORT_GAP_SECONDS}), false) as recent
        from hosts where token_hash = ${sha256Hex(token)} and mode = 'agent'`);
      if (!host) return c.json({ error: "unauthorized" }, 401);
      if (!host.enabled) return c.json({ error: "host disabled" }, 403);
      if (host.recent) return c.json({ error: `at most one report per ${MIN_REPORT_GAP_SECONDS} s` }, 429);
      const parsed = parseReportText(await c.req.text());
      if (!parsed.ok) {
        await ops.sql`update hosts set last_error = ${`Bericht abgelehnt: ${parsed.error}`.slice(0, 1000)}, last_error_at = now() where id = ${host.id}`;
        return c.json({ error: parsed.error }, 400);
      }
      const results = await ops.monitor.processReport(host, parsed.report, "agent");
      return c.json({ ok: true, checks: results.map((r) => ({ key: r.key, severity: r.severity })) }, 202);
    },
  );
}

export function mountHosts(app: Hono, ops: Ops) {
  app.get("/hosts", async (c) => {
    const hosts = await hostStates(ops);
    const newButton = can(c.get("user"), "hosts") && <a class="btn primary" href="/hosts/new"><Icon name="plus" size="sm" />Host anlegen</a>;
    return c.html(
      <OpsPage c={c} title="Hosts" section="hosts">
        <PageHead
          icon="server"
          title="Hosts"
          sub="Festplatte, Arbeitsspeicher, Last, Dienste und Container aller überwachten Server."
          actions={newButton}
        />
        <Card
          flush
          title={`${hosts.length} ${hosts.length === 1 ? "Host" : "Hosts"}`}
          description={`Zentrale Prüfung zuletzt ${ops.monitor.lastSweepHosts} Host(s), abgeschlossen ${formatTime(new Date(ops.monitor.lastSweepFinishedAt))}.`}
        >
          {hosts.length === 0 ? (
            <Empty title="Noch keine Hosts" icon="server" action={newButton}>Agent-Hosts melden sich selbst; zentrale Hosts prüft Ops per SSH.</Empty>
          ) : <HostsTable hosts={hosts} />}
        </Card>
      </OpsPage>,
    );
  });

  app.get("/hosts/new", (c) =>
    c.html(
      <OpsPage c={c} title="Host anlegen" section="hosts">
        <PageHead
          icon="server"
          title="Host anlegen"
          crumbs={[{ href: "/hosts", label: "Hosts" }]}
          sub="Agent-Hosts bekommen nach dem Speichern eine Installationszeile; zentrale Hosts prüft Ops per SSH."
        />
        <HostForm action="/hosts" canSetEnvironment={can(c.get("user"), "admin")} cancelHref="/hosts" />
      </OpsPage>,
    ),
  );

  app.post("/hosts", async (c) => {
    const parsed = parseHost(await formData(c));
    if (!parsed.ok) return redirectWith(c, "/hosts/new", { kind: "bad", text: parsed.error });
    const h = parsed.h;
    // The hub environment decides which customers see this host's alerts: admins only.
    if (!can(c.get("user"), "admin")) h.environment_path = null;
    const token = h.mode === "agent" ? newToken("vha") : null;
    let id: number;
    try {
      const row = await first<{ id: number }>(ops.sql`
        insert into hosts (name, mode, interval_seconds, ssh_target, environment_path, thresholds, enabled, token_hash, token_prefix, created_by)
        values (${h.name}, ${h.mode}, ${h.interval_seconds}, ${h.ssh_target}, ${h.environment_path}, ${h.thresholds}::jsonb, ${h.enabled},
                ${token ? sha256Hex(token) : null}, ${token ? token.slice(0, 10) : null}, ${c.get("user").id})
        returning id`);
      id = row!.id;
    } catch (err) {
      if (isUniqueViolation(err)) return redirectWith(c, "/hosts/new", { kind: "bad", text: "Einen Host mit diesem Namen gibt es schon." });
      throw err;
    }
    await audit(ops.sql, c, "host.created", h.name, { ...h });
    if (h.mode === "central") void ops.monitor.sweepOnce();
    return hostPage(c, ops, id, token);
  });

  app.get("/hosts/:id", (c) => hostPage(c, ops, parseId(c.req.param("id")) ?? 0, null));

  app.post("/hosts/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const old = id ? await first<any>(ops.sql`select * from hosts where id = ${id}`) : null;
    if (!old) return c.notFound();
    const parsed = parseHost(await formData(c));
    if (!parsed.ok) return redirectWith(c, `/hosts/${id}`, { kind: "bad", text: parsed.error });
    const h = parsed.h;
    if (!can(c.get("user"), "admin")) h.environment_path = old.environment_path;
    // Switching to agent mode needs a token; switching away from it drops the token.
    const token = h.mode === "agent" && !old.token_hash ? newToken("vha") : null;
    try {
      await ops.sql`update hosts set name = ${h.name}, mode = ${h.mode}, interval_seconds = ${h.interval_seconds}, ssh_target = ${h.ssh_target},
        environment_path = ${h.environment_path}, thresholds = ${h.thresholds}::jsonb, enabled = ${h.enabled}, updated_at = now(),
        token_hash = ${h.mode === "agent" ? (token ? sha256Hex(token) : old.token_hash) : null},
        token_prefix = ${h.mode === "agent" ? (token ? token.slice(0, 10) : old.token_prefix) : null}
        where id = ${id}`;
    } catch (err) {
      if (isUniqueViolation(err)) return redirectWith(c, `/hosts/${id}`, { kind: "bad", text: "Einen Host mit diesem Namen gibt es schon." });
      throw err;
    }
    if (old.name !== h.name) await ops.monitor.forgetHost(old.name, `umbenannt in ${h.name}`);
    else if (!h.enabled && old.enabled) await ops.monitor.forgetHost(old.name, "Host deaktiviert");
    await audit(ops.sql, c, "host.updated", h.name, { id, ...h });
    if (token) return hostPage(c, ops, id!, token);
    return redirectWith(c, `/hosts/${id}`, { kind: "ok", text: "Gespeichert." });
  });

  app.post("/hosts/:id/token", async (c) => {
    const id = parseId(c.req.param("id"));
    const token = newToken("vha");
    const rows = await ops.sql`update hosts set token_hash = ${sha256Hex(token)}, token_prefix = ${token.slice(0, 10)}, updated_at = now()
      where id = ${id} and mode = 'agent' returning name`;
    if (!rows.length) return c.notFound();
    await audit(ops.sql, c, "host.token_reset", (rows[0] as any).name);
    return hostPage(c, ops, id!, token);
  });

  app.post("/hosts/:id/check", async (c) => {
    const id = parseId(c.req.param("id"));
    const host = await first<any>(ops.sql`select name, mode, enabled from hosts where id = ${id}`);
    if (!host) return c.notFound();
    if (host.mode !== "central" || !host.enabled) return redirectWith(c, `/hosts/${id}`, { kind: "bad", text: "Nur aktive zentrale Hosts lassen sich von Ops aus prüfen." });
    await audit(ops.sql, c, "host.check_now", host.name);
    await ops.sql`update hosts set last_attempt_at = null where id = ${id}`;
    void ops.monitor.sweepOnce();
    return redirectWith(c, `/hosts/${id}`, { kind: "info", text: "Prüfung gestartet. Das Ergebnis erscheint nach dem Neuladen." });
  });

  app.post("/hosts/:id/delete", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await ops.sql`delete from hosts where id = ${id} returning name`;
    if (!rows.length) return c.notFound();
    const name = (rows[0] as any).name;
    await ops.monitor.forgetHost(name, "Host gelöscht");
    await audit(ops.sql, c, "host.deleted", name);
    return redirectWith(c, "/hosts", { kind: "ok", text: `${name} gelöscht; offene Meldungen wurden als behoben gemeldet.` });
  });
}

export function HostsTable(props: { hosts: any[] }) {
  return (
    <div class="table-wrap"><table>
      <thead><tr><th>Host</th><th>Status</th><th>Art</th><th>Letzter Bericht</th><th>Hub-Umgebung</th></tr></thead>
      <tbody>{props.hosts.map((h) => (
        <tr>
          <td>
            <a class="cell-title link-quiet" href={`/hosts/${h.id}`}>{h.name}</a>
            <span class="cell-sub">{h.problems > 0 ? `${h.problems} Problem(e)` : HOST_HINT[stateOf(h)] ?? "–"}</span>
          </td>
          <td class="nowrap"><HostState h={h} /></td>
          <td>
            {h.mode === "agent" ? "Agent" : "Zentral"} <span class="subtle">· alle {intervalText(h.interval_seconds)}</span>
            {h.mode === "central" && <span class="cell-sub mono ops-clip" title={h.ssh_target}>{h.ssh_target}</span>}
          </td>
          <td class="nowrap">
            <Ago at={h.last_report_at} />
            {h.last_error && <span class="cell-sub status-warn ops-clip" title={h.last_error}>{h.last_error}</span>}
          </td>
          <td class="small mono">{h.environment_path ?? <span class="subtle">–</span>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

async function hostPage(c: Context, ops: Ops, id: number, freshToken: string | null) {
  const states = await hostStates(ops);
  const h = states.find((x) => x.id === id);
  if (!h) return c.notFound();
  const checks = await all<any>(ops.sql`select * from check_states where host_id = ${id} order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, check_key`);
  const reports = await all<any>(ops.sql`select id, at, source, worst, results, report->'errors' as errors from host_reports where host_id = ${id} order by at desc limit 30`);
  const changes = await all<any>(ops.sql`select created_at, state, severity, title from outbox
    where starts_with(subject, ${`host:${h.name}:`}) order by id desc limit 20`);
  const t = effectiveThresholds(h.thresholds);
  const canEdit = can(c.get("user"), "hosts");
  return c.html(
    <OpsPage c={c} title={`${h.name} – Hosts`} section="hosts">
      <PageHead
        icon="server"
        title={<span class="row">{h.name} <HostState h={h} /></span>}
        sub={<>{MODE_TEXT[h.mode]} · alle {intervalText(h.interval_seconds)} · letzter Bericht <Ago at={h.last_report_at} />{h.environment_path ? <> · Hub: <code>{h.environment_path}</code></> : ""}</>}
        crumbs={[{ href: "/hosts", label: "Hosts" }]}
        actions={canEdit && h.mode === "central" && h.enabled && (
          <form method="post" action={`/hosts/${h.id}/check`} class="inline-form"><button class="btn" type="submit"><Icon name="refresh-cw" size="sm" />Jetzt prüfen</button></form>
        )}
      />
      <div class="stack">
        {freshToken && (
          <Card title="Agent installieren" icon="terminal" class="ops-highlight" description="Auf dem Host als root ausführen. Diese Zeile wird hier nicht noch einmal angezeigt.">
            <div class="stack-sm">
              <p>Das Token steht nur in dieser Zeile; der Agent legt es mit Rechten 600 in <code>/etc/vantage-agent.conf</code> ab.</p>
              <SecretBox id="install-command" value={installCommand(ops.config.publicUrl, freshToken, h.interval_seconds)} />
              <p class="muted small">Der Host muss {ops.config.publicUrl} erreichen (VPN oder Freigabe). Mit einem Leerzeichen vor dem Befehl landet die Zeile in bash nicht in der History.</p>
            </div>
          </Card>
        )}
        {h.last_error && <StatusBanner tone="bad" title="Letzter Fehler" text={<><Ago at={h.last_error_at} />: {h.last_error}</>} />}
        <Card title="Aktuelle Prüfungen" icon="list-checks" description="Der letzte Stand jeder Prüfung, Probleme zuerst." flush>
          {checks.length === 0 ? (
            <Empty title="Noch kein Bericht" icon="clock">{h.mode === "agent" ? "Sobald der Agent installiert ist, meldet er sich im eingestellten Intervall." : "Die zentrale Prüfung läuft jede Minute für fällige Hosts."}</Empty>
          ) : (
            <div class="table-wrap"><table>
              <thead><tr><th>Prüfung</th><th>Status</th><th>Wert</th><th class="ops-hide-sm">Schwellen</th><th class="ops-hide-sm">Seit</th></tr></thead>
              <tbody>{checks.map((s) => (
                <tr>
                  <td class="mono small ops-check-key"><Breakable text={s.check_key} /></td>
                  <td class="nowrap"><SeverityBadge severity={s.severity} /></td>
                  <td>{s.detail}</td>
                  <td class="small muted ops-hide-sm">{thresholdHint(s.check_key, t)}</td>
                  <td class="nowrap ops-time ops-hide-sm"><Ago at={s.since} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <div class="grid grid-2">
          <Card title="Verlauf" icon="history" description="Die letzten 30 Berichte." flush>
            {reports.length === 0 ? <Empty title="Keine Berichte" icon="history" /> : (
              <div class="table-wrap"><table>
                <thead><tr><th>Zeit</th><th>Ergebnis</th><th>Auffällig</th></tr></thead>
                <tbody>{reports.map((r) => {
                  const bad = (r.results as CheckResult[]).filter((x) => x.severity !== "ok");
                  return (
                    <tr>
                      <td class="nowrap">{formatDate(r.at)}<span class="cell-sub">{r.source === "agent" ? "Agent" : "SSH"}</span></td>
                      <td class="nowrap"><SeverityBadge severity={r.worst} /></td>
                      <td class="small ops-wrap">{bad.length ? <Breakable text={bad.map((x) => x.label).join(", ")} /> : <span class="subtle">–</span>}{(r.errors ?? []).length > 0 && <span class="cell-sub">{(r.errors as string[]).join("; ")}</span>}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </Card>
          <Card title="Zustandswechsel" icon="activity" description="Was Ops zu diesem Host an den Hub gemeldet hat." flush>
            {changes.length === 0 ? <Empty title="Keine Meldungen bisher" icon="activity" /> : (
              <div class="table-wrap"><table>
                <thead><tr><th>Zustand</th><th>Meldung</th></tr></thead>
                <tbody>{changes.map((e) => (
                  <tr>
                    <td class="nowrap"><SeverityBadge severity={e.state === "resolved" ? "ok" : e.severity} /></td>
                    <td class="small ops-wrap"><Breakable text={e.title} /><span class="cell-sub">{formatDate(e.created_at)}</span></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
        </div>
        {canEdit ? (
          <>
            <SectionHead title="Einstellungen" sub="Gilt ab der nächsten Prüfung." />
            <HostForm h={h} action={`/hosts/${h.id}`} canSetEnvironment={can(c.get("user"), "admin")} />
            <div class="grid grid-2">
              {h.mode === "agent" && (
                <Card title="Agent-Token" icon="key-round" description={<>Aktuelles Token beginnt mit <code>{h.token_prefix}…</code></>}>
                  <div class="stack-sm">
                    <p class="muted small">Ein neues Token macht das alte sofort ungültig; danach den Agent mit der neuen Zeile neu installieren.</p>
                    <ConfirmAction action={`/hosts/${h.id}/token`} label="Neues Token erzeugen" question="Altes Token ungültig machen?" />
                  </div>
                </Card>
              )}
              <Card title="Host löschen" icon="trash-2" class="ops-danger" description="Löscht den Host mit Verlauf. Offene Meldungen gehen als behoben an den Hub.">
                <ConfirmAction action={`/hosts/${h.id}/delete`} label="Löschen" question={`${h.name} löschen?`} />
              </Card>
            </div>
          </>
        ) : (
          <Card title="Schwellenwerte" icon="sliders-horizontal">
            <dl class="facts">
              <dt>Festplatte</dt><dd>{thresholdHint("disk:/", t)}</dd>
              <dt>Arbeitsspeicher</dt><dd>{thresholdHint("memory", t)}</dd>
              <dt>Last</dt><dd>{thresholdHint("load", t)}</dd>
              {h.ssh_target && <><dt>SSH-Ziel</dt><dd><code>{h.ssh_target}</code></dd></>}
            </dl>
          </Card>
        )}
      </div>
    </OpsPage>,
  );
}
