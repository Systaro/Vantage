import type { Context, Hono } from "hono";
import { formData, parseId, redirectWith } from "../../shared/http";
import { Ago, Badge, Card, ConfirmAction, Empty, Field, formatDate, formatDuration, PageHead } from "../../shared/ui/components";
import { Icon } from "../../shared/ui/icons";
import { checkProjectPath, projectSuggestions } from "../ansible/paths";
import type { RunStatus } from "../ansible/runner";
import { cronProblem, normalizeCron } from "../cron";
import { all, first } from "../../shared/db";
import { can } from "../roles";
import type { Ops } from "../service";
import { actor, audit, Breakable, FormActions, isUniqueViolation, nameProblem, OpsPage, RunBadge, SectionHead } from "../ui";

const LIMIT_PATTERN = /^[A-Za-z0-9_.,:!&*\[\]-]{0,500}$/;
const MAX_EXTRA_VARS = 20_000;

export interface TemplateInput {
  name: string;
  playbook: string;
  inventory: string;
  limit_hosts: string;
  extra_vars: Record<string, unknown>;
  check_mode: boolean;
  schedule: string | null;
  enabled: boolean;
}

/** Validates the template form. Paths are checked against the real project directory. */
export function parseTemplate(projectDir: string, f: { get(k: string): string }): { ok: true; t: TemplateInput } | { ok: false; error: string } {
  const name = f.get("name");
  const nameErr = nameProblem(name);
  if (nameErr) return { ok: false, error: nameErr };
  const playbook = checkProjectPath(projectDir, f.get("playbook"), "playbook");
  if (!playbook.ok) return { ok: false, error: playbook.error };
  const inventory = checkProjectPath(projectDir, f.get("inventory"), "inventory");
  if (!inventory.ok) return { ok: false, error: inventory.error };
  const limit = f.get("limit_hosts");
  if (!LIMIT_PATTERN.test(limit) || limit.startsWith("-")) {
    return { ok: false, error: "Limit: erlaubt sind Buchstaben, Ziffern und _ . , : ! & * [ ] - (nicht am Anfang), höchstens 500 Zeichen." };
  }
  const varsText = f.get("extra_vars");
  let extra: Record<string, unknown> = {};
  if (varsText) {
    if (varsText.length > MAX_EXTRA_VARS) return { ok: false, error: "Extra-Vars: höchstens 20 000 Zeichen." };
    try {
      extra = JSON.parse(varsText);
    } catch (err) {
      return { ok: false, error: `Extra-Vars: kein gültiges JSON (${(err as Error).message}).` };
    }
    if (typeof extra !== "object" || extra === null || Array.isArray(extra)) return { ok: false, error: "Extra-Vars: erwartet wird ein JSON-Objekt, z. B. {\"version\": \"1.2\"}." };
  }
  const scheduleText = f.get("schedule");
  let schedule: string | null = null;
  if (scheduleText) {
    const problem = cronProblem(scheduleText);
    if (problem) return { ok: false, error: problem };
    schedule = normalizeCron(scheduleText);
  }
  return {
    ok: true,
    t: { name, playbook: playbook.rel, inventory: inventory.rel, limit_hosts: limit, extra_vars: extra, check_mode: f.get("check_mode") === "1", schedule, enabled: f.get("enabled") === "1" },
  };
}

function TemplateForm(props: { ops: Ops; t?: any; action: string; cancelHref?: string }) {
  const t = props.t;
  const s = projectSuggestions(props.ops.config.ansible.projectDir);
  return (
    <form method="post" action={props.action} class="stack">
      <Card title="Playbook" icon="terminal" description={<>Was läuft, gegen welche Hosts. Pfade relativ zu <code class="ops-wrap"><Breakable text={props.ops.config.ansible.projectDir} /></code>.</>}>
        <div class="fields">
          <Field label="Name" for="name"><input id="name" name="name" type="text" autocomplete="off" required maxlength={200} value={t?.name ?? ""} placeholder="Webshop ausrollen" /></Field>
          <Field label="Playbook" for="playbook" hint="Relativ zum Projektverzeichnis.">
            <input id="playbook" name="playbook" type="text" class="mono" required list="playbooks" value={t?.playbook ?? ""} placeholder="site.yml" />
          </Field>
          <Field label="Inventory" for="inventory" hint="Datei oder Verzeichnis im Projekt.">
            <input id="inventory" name="inventory" type="text" class="mono" required list="inventories" value={t?.inventory ?? ""} placeholder="inventory/hosts.ini" />
          </Field>
          <Field label="Limit (optional)" for="limit_hosts" hint="Wie --limit, z. B. „web:!web3“.">
            <input id="limit_hosts" name="limit_hosts" type="text" class="mono" maxlength={500} value={t?.limit_hosts ?? ""} />
          </Field>
        </div>
        <datalist id="playbooks">{s.playbooks.map((p) => <option value={p} />)}</datalist>
        <datalist id="inventories">{s.inventories.map((p) => <option value={p} />)}</datalist>
      </Card>
      <Card title="Ausführung" icon="sliders-horizontal" description="Variablen und Modus für jeden Lauf dieser Vorlage.">
        <div class="stack">
          <Field label="Extra-Vars (optional)" for="extra_vars" hint="JSON-Objekt, wird als --extra-vars übergeben. Keine Geheimnisse: dafür ist Ansible Vault da.">
            <textarea id="extra_vars" name="extra_vars" rows={4} placeholder='{"app_version": "1.4.0"}'>{t && Object.keys(t.extra_vars ?? {}).length ? JSON.stringify(t.extra_vars, null, 2) : ""}</textarea>
          </Field>
          <label class="check"><input type="checkbox" name="check_mode" value="1" checked={t?.check_mode ?? false} /> Prüfmodus (--check): nichts ändern, nur zeigen, was sich ändern würde</label>
        </div>
      </Card>
      <Card title="Zeitplan" icon="calendar-clock" description="Ohne Zeitplan startet die Vorlage nur von Hand.">
        <div class="stack">
          <div class="fields ops-fields-narrow">
            <Field label="Zeitplan (optional)" for="schedule" hint="Cron mit fünf Feldern, Zeitzone Europe/Berlin, z. B. „30 2 * * 1-5“.">
              <input id="schedule" name="schedule" type="text" class="mono" value={t?.schedule ?? ""} placeholder="30 2 * * *" />
            </Field>
          </div>
          <label class="check"><input type="checkbox" name="enabled" value="1" checked={t?.enabled ?? true} /> Aktiv (deaktivierte Vorlagen laufen weder geplant noch von Hand)</label>
        </div>
      </Card>
      <FormActions label={t ? "Speichern" : "Vorlage anlegen"} cancelHref={props.cancelHref} />
    </form>
  );
}

export function mountTemplates(app: Hono, ops: Ops) {
  app.get("/templates", async (c) => {
    const rows = await all<any>(ops.sql`
      select t.*, r.id as last_run_id, r.status as last_status, r.queued_at as last_at,
        exists (select 1 from runs a where a.template_id = t.id and a.status in ('queued', 'running')) as active
      from templates t
      left join lateral (select id, status, queued_at from runs where template_id = t.id order by id desc limit 1) r on true
      order by t.name`);
    const user = c.get("user");
    const newButton = can(user, "admin") && <a class="btn primary" href="/templates/new"><Icon name="plus" size="sm" />Vorlage anlegen</a>;
    return c.html(
      <OpsPage c={c} title="Ansible-Vorlagen" section="templates">
        <PageHead
          icon="terminal"
          title="Ansible-Vorlagen"
          sub="Gespeicherte Playbook-Aufrufe, von Hand oder nach Zeitplan gestartet."
          actions={newButton}
        />
        <Card
          flush
          title={`${rows.length} ${rows.length === 1 ? "Vorlage" : "Vorlagen"}`}
          description={<>Projekt: <code class="ops-wrap"><Breakable text={ops.config.ansible.projectDir} /></code>{ops.config.ansible.gitPull ? " · vor jedem Lauf git pull" : ""}</>}
        >
          {rows.length === 0 ? (
            <Empty title="Noch keine Vorlagen" icon="terminal" action={newButton}>Eine Vorlage legt fest, welches Playbook mit welchem Inventory läuft.</Empty>
          ) : (
            <div class="table-wrap"><table>
              <thead><tr><th>Vorlage</th><th>Inventory</th><th>Zeitplan</th><th>Letzter Lauf</th><th></th></tr></thead>
              <tbody>{rows.map((t) => (
                <tr>
                  <td>
                    <span class="row-inline">
                      <a class="cell-title link-quiet" href={`/templates/${t.id}`}>{t.name}</a>
                      {!t.enabled && <Badge tone="idle">deaktiviert</Badge>}
                      {t.check_mode && <Badge tone="info">Prüfmodus</Badge>}
                    </span>
                    <span class="cell-sub mono">{t.playbook}</span>
                  </td>
                  <td class="small mono">{t.inventory}{t.limit_hosts && <span class="cell-sub">--limit {t.limit_hosts}</span>}</td>
                  <td>{t.schedule ? <><code>{t.schedule}</code><span class="cell-sub">nächster: {formatDate(ops.scheduler.nextRun(`template:${t.id}`))}</span></> : <span class="subtle">von Hand</span>}</td>
                  <td class="nowrap">{t.last_run_id ? <><a href={`/runs/${t.last_run_id}`}><RunBadge status={t.last_status} /></a><span class="cell-sub"><Ago at={t.last_at} /></span></> : <span class="subtle">nie</span>}</td>
                  <td class="right">{can(user, "run") && t.enabled && !t.active && <RunButton id={t.id} small />}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </OpsPage>,
    );
  });

  app.get("/templates/new", (c) =>
    c.html(
      <OpsPage c={c} title="Vorlage anlegen" section="templates">
        <PageHead
          icon="terminal"
          title="Vorlage anlegen"
          crumbs={[{ href: "/templates", label: "Ansible-Vorlagen" }]}
          sub="Ein Playbook mit Inventory, optionalen Variablen und Zeitplan. Starten können es danach alle Operatoren."
        />
        <TemplateForm ops={ops} action="/templates" cancelHref="/templates" />
      </OpsPage>,
    ),
  );

  app.post("/templates", async (c) => {
    const parsed = parseTemplate(ops.config.ansible.projectDir, await formData(c));
    if (!parsed.ok) return redirectWith(c, "/templates/new", { kind: "bad", text: parsed.error });
    const t = parsed.t;
    let id: number;
    try {
      const row = await first<{ id: number }>(ops.sql`
        insert into templates (name, playbook, inventory, limit_hosts, extra_vars, check_mode, schedule, enabled, created_by, updated_by)
        values (${t.name}, ${t.playbook}, ${t.inventory}, ${t.limit_hosts}, ${t.extra_vars}::jsonb, ${t.check_mode}, ${t.schedule}, ${t.enabled}, ${c.get("user").id}, ${c.get("user").id})
        returning id`);
      id = row!.id;
    } catch (err) {
      if (isUniqueViolation(err)) return redirectWith(c, "/templates/new", { kind: "bad", text: "Eine Vorlage mit diesem Namen gibt es schon." });
      throw err;
    }
    await audit(ops.sql, c, "template.created", t.name, { ...t });
    await ops.scheduler.sync();
    return redirectWith(c, `/templates/${id}`, { kind: "ok", text: "Vorlage angelegt." });
  });

  app.get("/templates/:id", (c) => templatePage(c, ops, parseId(c.req.param("id")) ?? 0));

  app.post("/templates/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const parsed = parseTemplate(ops.config.ansible.projectDir, await formData(c));
    if (!parsed.ok) return redirectWith(c, `/templates/${id}`, { kind: "bad", text: parsed.error });
    const t = parsed.t;
    try {
      const rows = await ops.sql`update templates set name = ${t.name}, playbook = ${t.playbook}, inventory = ${t.inventory}, limit_hosts = ${t.limit_hosts},
        extra_vars = ${t.extra_vars}::jsonb, check_mode = ${t.check_mode}, schedule = ${t.schedule}, enabled = ${t.enabled},
        updated_at = now(), updated_by = ${c.get("user").id} where id = ${id} returning id`;
      if (!rows.length) return c.notFound();
    } catch (err) {
      if (isUniqueViolation(err)) return redirectWith(c, `/templates/${id}`, { kind: "bad", text: "Eine Vorlage mit diesem Namen gibt es schon." });
      throw err;
    }
    await audit(ops.sql, c, "template.updated", t.name, { id, ...t });
    await ops.scheduler.sync();
    return redirectWith(c, `/templates/${id}`, { kind: "ok", text: "Gespeichert." });
  });

  app.post("/templates/:id/delete", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await ops.sql`delete from templates t where t.id = ${id}
      and not exists (select 1 from runs r where r.template_id = t.id and r.status in ('queued', 'running')) returning name`;
    if (!rows.length) return redirectWith(c, `/templates/${id}`, { kind: "bad", text: "Löschen geht nicht, solange ein Lauf aktiv ist." });
    await audit(ops.sql, c, "template.deleted", (rows[0] as any).name, { id });
    await ops.scheduler.sync();
    return redirectWith(c, "/templates", { kind: "ok", text: "Vorlage gelöscht. Ihre Läufe bleiben in der Historie." });
  });

  app.post("/templates/:id/run", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const result = await ops.runner.start(id, "manual", actor(c));
    if (!result.ok) {
      if (result.code === "not_found") return c.notFound();
      return redirectWith(c, `/templates/${id}`, { kind: "bad", text: result.message });
    }
    await audit(ops.sql, c, "template.run", String(id), { run_id: result.runId });
    return redirectWith(c, `/runs/${result.runId}`, { kind: "ok", text: "Lauf gestartet." });
  });
}

function RunButton(props: { id: number; small?: boolean; checkMode?: boolean }) {
  return (
    <form method="post" action={`/templates/${props.id}/run`} class="inline-form">
      <button class={`btn primary${props.small ? " small" : ""}`} type="submit">
        <Icon name="play" size="sm" />{props.small ? "Starten" : props.checkMode ? "Im Prüfmodus starten" : "Jetzt starten"}
      </button>
    </form>
  );
}

async function templatePage(c: Context, ops: Ops, id: number) {
  const t = await first<any>(ops.sql`select * from templates where id = ${id}`);
  if (!t) return c.notFound();
  const runs = await all<any>(ops.sql`select id, status, trigger, started_by_label, queued_at, duration_ms, exit_code from runs where template_id = ${id} order by id desc limit 25`);
  const user = c.get("user");
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  return c.html(
    <OpsPage c={c} title={`${t.name} – Ansible`} section="templates">
      <PageHead
        icon="terminal"
        title={<span class="row">{t.name} {!t.enabled && <Badge tone="idle">deaktiviert</Badge>} {t.check_mode && <Badge tone="info">Prüfmodus</Badge>}</span>}
        sub={<><code>{t.playbook}</code> mit <code>{t.inventory}</code>{t.schedule ? <> · nächster Lauf {formatDate(ops.scheduler.nextRun(`template:${t.id}`))}</> : " · nur von Hand"}</>}
        crumbs={[{ href: "/templates", label: "Ansible-Vorlagen" }]}
        actions={can(user, "run") && t.enabled && !active && <RunButton id={t.id} checkMode={t.check_mode} />}
      />
      <div class="stack">
        <Card title="Läufe" icon="list-checks" description="Die letzten 25 Läufe dieser Vorlage." flush>
          {runs.length === 0 ? <Empty title="Noch nicht gelaufen" icon="list-checks">Läufe erscheinen hier, sobald die Vorlage von Hand oder nach Zeitplan startet.</Empty> : <RunsTable runs={runs} />}
        </Card>
        {can(user, "admin") ? (
          <>
            <SectionHead title="Einstellungen" sub="Änderungen gelten ab dem nächsten Lauf; laufende Läufe behalten ihre Werte." />
            <TemplateForm ops={ops} t={t} action={`/templates/${t.id}`} />
            <Card title="Vorlage löschen" icon="trash-2" class="ops-danger" description="Die Läufe bleiben mit ihren Logs in der Historie.">
              <ConfirmAction action={`/templates/${t.id}/delete`} label="Löschen" question={`„${t.name}“ wirklich löschen?`} />
            </Card>
          </>
        ) : (
          <Card title="Vorlage" icon="terminal">
            <dl class="facts">
              <dt>Playbook</dt><dd class="mono">{t.playbook}</dd>
              <dt>Inventory</dt><dd class="mono">{t.inventory}</dd>
              <dt>Limit</dt><dd class="mono">{t.limit_hosts || "–"}</dd>
              <dt>Extra-Vars</dt><dd class="mono">{Object.keys(t.extra_vars ?? {}).length ? JSON.stringify(t.extra_vars) : "–"}</dd>
              <dt>Prüfmodus</dt><dd>{t.check_mode ? "ja" : "nein"}</dd>
              <dt>Zeitplan</dt><dd>{t.schedule ? <><code>{t.schedule}</code> · nächster Lauf {formatDate(ops.scheduler.nextRun(`template:${t.id}`))}</> : "von Hand"}</dd>
            </dl>
          </Card>
        )}
      </div>
    </OpsPage>,
  );
}

function Trigger(props: { r: any }) {
  return props.r.trigger === "schedule"
    ? <span class="row-inline"><Icon name="calendar-clock" size="sm" />Zeitplan</span>
    : <span class="row-inline"><Icon name="user" size="sm" />{props.r.started_by_label}</span>;
}

/** Runs as a table; `compact` folds template, trigger and duration into two columns for half-width cards. */
export function RunsTable(props: { runs: any[]; showTemplate?: boolean; compact?: boolean }) {
  if (props.compact) {
    return (
      <div class="table-wrap"><table>
        <thead><tr><th>Lauf</th><th>Status</th><th>Eingereiht</th></tr></thead>
        <tbody>{props.runs.map((r) => (
          <tr>
            <td>
              <a class="cell-title link-quiet" href={`/runs/${r.id}`}>{r.template_name}</a>
              <span class="cell-sub">#{r.id} · {r.trigger === "schedule" ? "Zeitplan" : r.started_by_label}</span>
            </td>
            <td class="nowrap"><RunBadge status={r.status as RunStatus} /></td>
            <td class="nowrap ops-time"><Ago at={r.queued_at} /><span class="cell-sub">{formatDate(r.queued_at)}</span></td>
          </tr>
        ))}</tbody>
      </table></div>
    );
  }
  return (
    <div class="table-wrap"><table>
      <thead><tr><th>Lauf</th>{props.showTemplate && <th>Vorlage</th>}<th>Status</th><th>Ausgelöst</th><th>Eingereiht</th><th class="num">Dauer</th><th class="num">Exit</th></tr></thead>
      <tbody>{props.runs.map((r) => (
        <tr>
          <td><a class="cell-title link-quiet mono" href={`/runs/${r.id}`}>#{r.id}</a></td>
          {props.showTemplate && <td>{r.template_id ? <a class="cell-title link-quiet" href={`/templates/${r.template_id}`}>{r.template_name}</a> : <span class="cell-title">{r.template_name}</span>}</td>}
          <td class="nowrap"><RunBadge status={r.status as RunStatus} /></td>
          <td class="small"><Trigger r={r} /></td>
          <td class="nowrap ops-time"><Ago at={r.queued_at} /><span class="cell-sub">{formatDate(r.queued_at)}</span></td>
          <td class="num">{formatDuration(r.duration_ms)}</td>
          <td class={`num${r.exit_code ? " status-bad" : ""}`}>{r.exit_code ?? "–"}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}
