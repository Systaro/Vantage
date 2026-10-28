import type { Context, Hono } from "hono";
import { encryptString } from "../../shared/crypto";
import { formData, parseId, redirectWith } from "../../shared/http";
import { Ago, Badge, Card, ConfirmAction, Empty, Field, formatDate, PageHead } from "../../shared/ui/components";
import { Icon } from "../../shared/ui/icons";
import { cronProblem, normalizeCron } from "../cron";
import { all, first } from "../../shared/db";
import { parseVariables, PROJECT_PATTERN, REF_PATTERN, runPipelineSchedule, variablesText, type PipelineVariable } from "../pipelines/gitlab";
import { can } from "../roles";
import type { Ops } from "../service";
import { actor, audit, FormActions, isUniqueViolation, nameProblem, OpsPage, safeHref, SectionHead } from "../ui";

interface ScheduleInput {
  name: string;
  project: string;
  ref: string;
  token: string | null;
  variables: PipelineVariable[];
  schedule: string | null;
  enabled: boolean;
}

/** `token` is null when the field was left empty (edit keeps the stored one). */
export function parseSchedule(f: { get(k: string): string }, requireToken: boolean): { ok: true; s: ScheduleInput } | { ok: false; error: string } {
  const name = f.get("name");
  const nameErr = nameProblem(name);
  if (nameErr) return { ok: false, error: nameErr };
  const project = f.get("project");
  if (!PROJECT_PATTERN.test(project)) return { ok: false, error: "Projekt: numerische Projekt-ID oder Pfad wie „gruppe/projekt“." };
  const ref = f.get("ref");
  if (!REF_PATTERN.test(ref) || ref.includes("..") || ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/")) {
    return { ok: false, error: "Ref: Branch- oder Tag-Name, z. B. „main“." };
  }
  const token = f.get("token");
  if (requireToken && !token) return { ok: false, error: "Das Trigger-Token fehlt." };
  if (token && (token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token))) return { ok: false, error: "Das Trigger-Token hat ein unerwartetes Format." };
  const vars = parseVariables(f.get("variables"));
  if (!vars.ok) return { ok: false, error: vars.error };
  const scheduleText = f.get("schedule");
  let schedule: string | null = null;
  if (scheduleText) {
    const problem = cronProblem(scheduleText);
    if (problem) return { ok: false, error: problem };
    schedule = normalizeCron(scheduleText);
  }
  return { ok: true, s: { name, project, ref, token: token || null, variables: vars.variables, schedule, enabled: f.get("enabled") === "1" } };
}

function ScheduleForm(props: { s?: any; action: string; gitlabUrl: string; cancelHref?: string }) {
  const s = props.s;
  return (
    <form method="post" action={props.action} class="stack">
      <Card title="Pipeline" icon="git-branch" description={<>Welche GitLab-Pipeline ausgelöst wird, auf <code>{props.gitlabUrl}</code>.</>}>
        <div class="fields">
          <Field label="Name" for="name"><input id="name" name="name" type="text" autocomplete="off" required maxlength={200} value={s?.name ?? ""} placeholder="Webshop E2E nachts" /></Field>
          <Field label="GitLab-Projekt" for="project" hint="Numerische ID oder Pfad wie „nordwind/shop/shop-e2e“.">
            <input id="project" name="project" type="text" class="mono" required value={s?.project ?? ""} />
          </Field>
          <Field label="Ref" for="ref" hint="Branch oder Tag."><input id="ref" name="ref" type="text" class="mono" required value={s?.ref ?? "main"} /></Field>
        </div>
      </Card>
      <Card title="Zugang" icon="key-round" description="Mit dem Trigger-Token darf Ops die Pipeline in GitLab starten.">
        <div class="fields ops-fields-narrow">
          <Field label="Trigger-Token" for="token" hint={s ? `Gespeichert, endet auf „…${s.token_hint}“. Leer lassen, um es zu behalten.` : "Projekt → Einstellungen → CI/CD → Pipeline-Trigger. Wird verschlüsselt gespeichert und nie wieder angezeigt."}>
            <input id="token" name="token" type="password" autocomplete="off" required={!s} />
          </Field>
        </div>
      </Card>
      <Card title="Variablen" icon="sliders-horizontal" description="Werden der Pipeline bei jeder Auslösung mitgegeben.">
        <Field label="Variablen (optional)" for="variables" hint="Eine pro Zeile als SCHLÜSSEL=Wert. Schlüssel: A–Z, 0–9, _.">
          <textarea id="variables" name="variables" rows={4} placeholder={"TEST_ENV=prod\nSUITE=smoke"}>{s ? variablesText(s.variables ?? []) : ""}</textarea>
        </Field>
      </Card>
      <Card title="Zeitplan" icon="calendar-clock" description="Ohne Zeitplan löst die Pipeline nur von Hand aus.">
        <div class="stack">
          <div class="fields ops-fields-narrow">
            <Field label="Zeitplan (optional)" for="schedule" hint="Cron mit fünf Feldern, Zeitzone Europe/Berlin.">
              <input id="schedule" name="schedule" type="text" class="mono" value={s?.schedule ?? ""} placeholder="0 3 * * *" />
            </Field>
          </div>
          <label class="check"><input type="checkbox" name="enabled" value="1" checked={s?.enabled ?? true} /> Aktiv (deaktivierte Zeitpläne lösen weder geplant noch von Hand aus)</label>
        </div>
      </Card>
      <FormActions label={s ? "Speichern" : "Zeitplan anlegen"} cancelHref={props.cancelHref} />
    </form>
  );
}

export function mountSchedules(app: Hono, ops: Ops) {
  app.get("/schedules", async (c) => {
    const rows = await all<any>(ops.sql`
      select s.id, s.name, s.project, s.ref, s.schedule, s.enabled, t.status as last_status, t.at as last_at, t.web_url, t.pipeline_id
      from pipeline_schedules s
      left join lateral (select status, at, web_url, pipeline_id from pipeline_triggers where schedule_id = s.id order by id desc limit 1) t on true
      order by s.name`);
    const user = c.get("user");
    const newButton = can(user, "admin") && <a class="btn primary" href="/schedules/new"><Icon name="plus" size="sm" />Zeitplan anlegen</a>;
    return c.html(
      <OpsPage c={c} title="Pipeline-Zeitpläne" section="schedules">
        <PageHead
          icon="git-branch"
          title="Pipeline-Zeitpläne"
          sub={<>Geplante Testläufe: Ops löst die GitLab-Pipeline aus, die Pipeline lädt ihre Ergebnisse in den Hub. GitLab: <code>{ops.config.gitlabUrl}</code></>}
          actions={newButton}
        />
        <Card flush>
          {rows.length === 0 ? (
            <Empty title="Noch keine Zeitpläne" icon="git-branch" action={newButton}>
              Ein Zeitplan löst eine GitLab-Pipeline aus, etwa nächtliche End-to-End-Tests gegen eine Umgebung.
            </Empty>
          ) : (
            <div class="table-wrap"><table>
              <thead><tr><th>Zeitplan</th><th>Projekt</th><th>Cron</th><th>Zuletzt</th><th></th></tr></thead>
              <tbody>{rows.map((s) => (
                <tr>
                  <td>
                    <span class="row-inline"><a class="cell-title link-quiet" href={`/schedules/${s.id}`}>{s.name}</a>{!s.enabled && <Badge tone="idle">deaktiviert</Badge>}</span>
                  </td>
                  <td class="small mono">{s.project}<span class="cell-sub row-inline"><Icon name="git-branch" size="sm" />{s.ref}</span></td>
                  <td>{s.schedule ? <><code>{s.schedule}</code><span class="cell-sub">nächster: {formatDate(ops.scheduler.nextRun(`pipeline:${s.id}`))}</span></> : <span class="subtle">von Hand</span>}</td>
                  <td>
                    {s.last_status ? <TriggerBadge status={s.last_status} /> : <span class="subtle">nie</span>}
                    {s.last_at && <span class="cell-sub"><Ago at={s.last_at} />{safeHref(s.web_url) && <> · <a href={safeHref(s.web_url)} rel="noopener noreferrer">Pipeline #{s.pipeline_id}</a></>}</span>}
                  </td>
                  <td class="right">{can(user, "run") && s.enabled && <TriggerButton id={s.id} small />}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </OpsPage>,
    );
  });

  app.get("/schedules/new", (c) =>
    c.html(
      <OpsPage c={c} title="Zeitplan anlegen" section="schedules">
        <PageHead
          icon="git-branch"
          title="Pipeline-Zeitplan anlegen"
          crumbs={[{ href: "/schedules", label: "Pipeline-Zeitpläne" }]}
          sub="Ops löst die Pipeline nach Zeitplan oder von Hand aus; Ergebnisse lädt die Pipeline selbst in den Hub."
        />
        <ScheduleForm action="/schedules" gitlabUrl={ops.config.gitlabUrl} cancelHref="/schedules" />
      </OpsPage>,
    ),
  );

  app.post("/schedules", async (c) => {
    const parsed = parseSchedule(await formData(c), true);
    if (!parsed.ok) return redirectWith(c, "/schedules/new", { kind: "bad", text: parsed.error });
    const s = parsed.s;
    let id: number;
    try {
      const row = await first<{ id: number }>(ops.sql`
        insert into pipeline_schedules (name, project, ref, token_enc, token_hint, variables, schedule, enabled, created_by, updated_by)
        values (${s.name}, ${s.project}, ${s.ref}, ${await encryptString(ops.config.secret, s.token!)}, ${s.token!.slice(-4)},
                ${s.variables}::jsonb, ${s.schedule}, ${s.enabled}, ${c.get("user").id}, ${c.get("user").id})
        returning id`);
      id = row!.id;
    } catch (err) {
      if (isUniqueViolation(err)) return redirectWith(c, "/schedules/new", { kind: "bad", text: "Einen Zeitplan mit diesem Namen gibt es schon." });
      throw err;
    }
    await audit(ops.sql, c, "schedule.created", s.name, { project: s.project, ref: s.ref, schedule: s.schedule, variables: s.variables.map((v) => v.key), enabled: s.enabled });
    await ops.scheduler.sync();
    return redirectWith(c, `/schedules/${id}`, { kind: "ok", text: "Zeitplan angelegt." });
  });

  app.get("/schedules/:id", (c) => schedulePage(c, ops, parseId(c.req.param("id")) ?? 0));

  app.post("/schedules/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const parsed = parseSchedule(await formData(c), false);
    if (!parsed.ok) return redirectWith(c, `/schedules/${id}`, { kind: "bad", text: parsed.error });
    const s = parsed.s;
    const tokenEnc = s.token ? await encryptString(ops.config.secret, s.token) : null;
    try {
      const rows = await ops.sql`update pipeline_schedules set name = ${s.name}, project = ${s.project}, ref = ${s.ref},
        token_enc = coalesce(${tokenEnc}, token_enc), token_hint = coalesce(${s.token ? s.token.slice(-4) : null}, token_hint),
        variables = ${s.variables}::jsonb, schedule = ${s.schedule}, enabled = ${s.enabled}, updated_at = now(), updated_by = ${c.get("user").id}
        where id = ${id} returning id`;
      if (!rows.length) return c.notFound();
    } catch (err) {
      if (isUniqueViolation(err)) return redirectWith(c, `/schedules/${id}`, { kind: "bad", text: "Einen Zeitplan mit diesem Namen gibt es schon." });
      throw err;
    }
    await audit(ops.sql, c, "schedule.updated", s.name, { id, project: s.project, ref: s.ref, schedule: s.schedule, variables: s.variables.map((v) => v.key), enabled: s.enabled, token_changed: Boolean(s.token) });
    await ops.scheduler.sync();
    return redirectWith(c, `/schedules/${id}`, { kind: "ok", text: "Gespeichert." });
  });

  app.post("/schedules/:id/delete", async (c) => {
    const id = parseId(c.req.param("id"));
    const rows = await ops.sql`delete from pipeline_schedules where id = ${id} returning name`;
    if (!rows.length) return c.notFound();
    await audit(ops.sql, c, "schedule.deleted", (rows[0] as any).name, { id });
    await ops.scheduler.sync();
    return redirectWith(c, "/schedules", { kind: "ok", text: "Zeitplan gelöscht." });
  });

  app.post("/schedules/:id/trigger", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const result = await runPipelineSchedule(ops.pipelines, id, "manual", actor(c));
    await audit(ops.sql, c, "schedule.trigger", String(id), { ok: result.ok });
    return redirectWith(c, `/schedules/${id}`, { kind: result.ok ? "ok" : "bad", text: result.message });
  });
}

function TriggerBadge(props: { status: string }) {
  return props.status === "ok" ? <Badge tone="ok" dot>ausgelöst</Badge> : <Badge tone="bad" dot>fehlgeschlagen</Badge>;
}

function TriggerButton(props: { id: number; small?: boolean }) {
  return (
    <form method="post" action={`/schedules/${props.id}/trigger`} class="inline-form">
      <button class={`btn primary ${props.small ? "small" : ""}`} type="submit"><Icon name="play" size="sm" />Jetzt auslösen</button>
    </form>
  );
}

async function schedulePage(c: Context, ops: Ops, id: number) {
  const s = await first<any>(ops.sql`select id, name, project, ref, token_hint, variables, schedule, enabled, created_at, updated_at from pipeline_schedules where id = ${id}`);
  if (!s) return c.notFound();
  const triggers = await all<any>(ops.sql`select * from pipeline_triggers where schedule_id = ${id} order by id desc limit 50`);
  const user = c.get("user");
  return c.html(
    <OpsPage c={c} title={`${s.name} – Pipelines`} section="schedules">
      <PageHead
        icon="git-branch"
        title={<span class="row">{s.name} {!s.enabled && <Badge tone="idle">deaktiviert</Badge>}</span>}
        sub={<><code>{s.project}</code> @ <code>{s.ref}</code>{s.schedule ? <> · <code>{s.schedule}</code>, nächster Lauf {formatDate(ops.scheduler.nextRun(`pipeline:${s.id}`))}</> : " · nur von Hand"}</>}
        crumbs={[{ href: "/schedules", label: "Pipeline-Zeitpläne" }]}
        actions={can(user, "run") && s.enabled && <TriggerButton id={s.id} />}
      />
      <div class="stack">
        <Card title="Auslösungen" icon="history" description="Die letzten 50 Auslösungen, geplant und von Hand." flush>
          {triggers.length === 0 ? <Empty title="Noch nie ausgelöst" icon="git-branch">Die erste Auslösung erscheint hier mit Link zur Pipeline in GitLab.</Empty> : (
            <div class="table-wrap"><table>
              <thead><tr><th>Ergebnis</th><th>Ausgelöst</th><th>Pipeline</th><th>Zeit</th></tr></thead>
              <tbody>{triggers.map((t) => (
                <tr>
                  <td><TriggerBadge status={t.status} />{t.error && <span class="cell-sub status-bad">{t.error}</span>}</td>
                  <td class="small">
                    {t.trigger === "schedule"
                      ? <span class="row-inline"><Icon name="calendar-clock" size="sm" />Zeitplan</span>
                      : <span class="row-inline"><Icon name="user" size="sm" />{t.started_by_label}</span>}
                  </td>
                  <td>{safeHref(t.web_url) ? <a href={safeHref(t.web_url)} rel="noopener noreferrer" class="row-inline">#{t.pipeline_id}<Icon name="external-link" size="sm" /></a> : t.pipeline_id ? `#${t.pipeline_id}` : <span class="subtle">–</span>}</td>
                  <td class="nowrap ops-time"><Ago at={t.at} /><span class="cell-sub">{formatDate(t.at)}</span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        {can(user, "admin") ? (
          <>
            <SectionHead title="Einstellungen" sub="Gilt ab der nächsten Auslösung." />
            <ScheduleForm s={s} action={`/schedules/${s.id}`} gitlabUrl={ops.config.gitlabUrl} />
            <Card title="Zeitplan löschen" icon="trash-2" class="ops-danger" description="Löscht den Zeitplan, das gespeicherte Token und die Auslöse-Historie. In GitLab ändert sich nichts.">
              <ConfirmAction action={`/schedules/${s.id}/delete`} label="Löschen" question={`„${s.name}“ löschen?`} />
            </Card>
          </>
        ) : (
          <Card title="Variablen" icon="sliders-horizontal" description="Die Werte sehen nur Administratoren.">
            {/* Values can be credentials; only admins (who edit them) see them. */}
            {(s.variables ?? []).length === 0 ? <p class="muted">Keine.</p> : <pre>{(s.variables as PipelineVariable[]).map((v) => `${v.key}=••••••`).join("\n")}</pre>}
          </Card>
        )}
      </div>
    </OpsPage>,
  );
}
