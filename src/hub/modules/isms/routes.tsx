/**
 * The ISMS tab of a project (#69764): the controls its information security management system
 * promises, each with where it stands right now. Checks on uptime, certificates, servers, logs,
 * vulnerabilities and Ansible maintenance runs are decided live from Vantage's own data; the rest
 * are dated records an admin enters (a restore test, an access review). Everyone who sees the
 * project sees the tab; adding controls and records is for admins. An environment shows the
 * controls that check it in a tab of its own, read-only.
 */
import type { Context, Hono } from "hono";
import { formData, parseId, redirectWith } from "../../../shared/http";
import { Badge, Card, ChoiceDialog, ConfirmAction, DialogButton, Empty, Field, FormDialog, formatDate, Stat, StatusBanner } from "../../../shared/ui/components";
import { Icon, type IconName } from "../../../shared/ui/icons";
import { all, first, rls } from "../../db";
import { audit, EnvShell, loadEnv, ProjectShell, rememberProject } from "../../ui";
import {
  berlinToday,
  CONTROL_KINDS,
  DEFAULTS,
  INTERVALS,
  intervalLabel,
  KIND_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  VULN_SOURCE_LABEL,
  type ControlKind,
  type VulnSource,
} from "./judge";
import { countByStatus, loadIsms, type JudgedControl } from "./load";

const NEW_DIALOG = "isms-new";
const MAX_NOTE = 1000;

const KIND_ICON: Record<ControlKind, IconName> = {
  uptime: "heart-pulse",
  tls: "lock",
  servers: "server",
  logs: "file-text",
  vulns: "bug",
  maintenance: "terminal",
  record: "calendar-clock",
};

const KIND_TEXT: Record<ControlKind, string> = {
  uptime: "Verfügbarkeit der Monitore einer Umgebung über 30 Tage gegen ein Ziel in Prozent.",
  tls: "Restlaufzeit der Zertifikate, die die Monitore einer Umgebung sehen.",
  servers: "Ob alle Server einer Umgebung sich melden und ihre Prüfungen bestehen.",
  logs: "Ob Protokolle einlaufen und nicht länger als vorgesehen aufbewahrt werden.",
  vulns: "Offene kritische und hohe Schwachstellen aus Dependency-Track und Wazuh gegen eine Frist zur Behebung.",
  maintenance: "Ob jeder Server der Umgebung regelmäßig einen Ansible-Lauf aus Semaphore bekommt und dieser durchgeht.",
  record: "Ein Nachweis, den jemand von Hand einträgt: einmalig oder in festem Abstand.",
};

interface EnvOption { id: number; name: string }
interface MonitorOption { id: number; environment_id: number; env_name: string; name: string }

export function mountIsms(app: Hono) {
  app.get("/projects/:id/isms", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const view = await loadIsms(c, id);
    if (!view) return c.notFound();
    rememberProject(c, id);
    const admin = c.get("user").isAdmin;
    const options = admin ? await adminOptions(c, id) : null;
    const { project, controls } = view;

    return c.html(
      <ProjectShell
        c={c}
        project={project}
        tab="isms"
        title={`ISMS – ${project.name}`}
        hasIsms={controls.length > 0}
        sub={`${controls.length} Kontrolle${controls.length === 1 ? "" : "n"} · Stand ${formatDate(view.checkedAt)}`}
        actions={admin && <DialogButton dialog={NEW_DIALOG} icon="plus" class="primary">Kontrolle anlegen</DialogButton>}
      >
        <div class="stack">
          {controls.length === 0 ? (
            <Card>
              <Empty title="Noch keine Kontrollen" icon="shield-check">
                Hier steht, was das ISMS dieses Projekts zusagt und ob es gerade eingehalten wird: Verfügbarkeit, Zertifikate, Server, Protokolle, Schwachstellen und Wartungsläufe prüft Vantage selbst, Nachweise wie ein Wiederherstellungstest werden eingetragen.
              </Empty>
            </Card>
          ) : (
            <IsmsBody project={project.id} controls={controls} admin={admin} />
          )}
        </div>
        {options && (
          <>
            <ChoiceDialog
              id={NEW_DIALOG}
              title="Kontrolle anlegen"
              description="Wie soll Vantage prüfen, ob die Kontrolle eingehalten wird?"
              icon="shield-check"
              choices={CONTROL_KINDS.map((k) => ({ dialog: `${NEW_DIALOG}-${k}`, label: KIND_LABEL[k], text: KIND_TEXT[k], icon: KIND_ICON[k] }))}
            />
            {CONTROL_KINDS.map((k) => <ControlDialog projectId={project.id} kind={k} envs={options.envs} monitors={options.monitors} />)}
            {controls.filter((k) => k.kind === "record").map((k) => <RecordDialog projectId={project.id} control={k} />)}
          </>
        )}
      </ProjectShell>,
    );
  });

  app.get("/env/:id/isms", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env || !env.hasIsms) return c.notFound();
    const view = await loadIsms(c, env.projectId, env.id);
    if (!view) return c.notFound();
    return c.html(
      <EnvShell c={c} env={env} tab="isms" title="ISMS" actions={<a class="btn" href={`/projects/${env.projectId}/isms`}><Icon name="list-checks" size="sm" />Alle Kontrollen des Projekts</a>}>
        <div class="stack">
          <IsmsBody project={env.projectId} controls={view.controls} admin={false} />
          <p class="muted small">Stand {formatDate(view.checkedAt)}. Nachweise, die keiner Umgebung gehören, und das Anlegen von Kontrollen stehen im ISMS des Projekts.</p>
        </div>
      </EnvShell>,
    );
  });

  app.post("/admin/projects/:id/isms", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const back = `/projects/${id}/isms`;
    const options = await adminOptions(c, id);
    if (!options) return c.notFound();
    const f = await formData(c);
    const kind = f.get("kind") as ControlKind;
    if (!CONTROL_KINDS.includes(kind)) return redirectWith(c, back, { kind: "bad", text: "Unbekannte Art der Prüfung." });
    const ref = f.get("ref");
    const title = f.get("title");
    const basis = f.get("basis");
    const note = f.get("note");
    if (!ref || ref.length > 40) return redirectWith(c, back, { kind: "bad", text: "Bitte eine Kennung angeben (höchstens 40 Zeichen), z. B. A.8.13." });
    if (!title || title.length > 200) return redirectWith(c, back, { kind: "bad", text: "Bitte einen Titel angeben (höchstens 200 Zeichen)." });
    if (basis.length > 200) return redirectWith(c, back, { kind: "bad", text: "Die Grundlage ist zu lang (höchstens 200 Zeichen)." });
    if (note.length > MAX_NOTE) return redirectWith(c, back, { kind: "bad", text: `Die Notiz ist zu lang (höchstens ${MAX_NOTE} Zeichen).` });

    let environmentId: number | null = null;
    if (kind !== "record") {
      environmentId = parseId(f.get("environment_id"));
      if (!options.envs.some((e) => e.id === environmentId)) return redirectWith(c, back, { kind: "bad", text: "Bitte eine Umgebung dieses Projekts wählen." });
    }
    const params = readParams(kind, f, environmentId, options.monitors);
    if (typeof params === "string") return redirectWith(c, back, { kind: "bad", text: params });

    const row = await rls(c, (tx) => first<{ id: number }>(tx`
      insert into isms_controls (project_id, environment_id, ref, title, basis, kind, params, note, created_by)
      values (${id}, ${environmentId}, ${ref}, ${title}, ${basis || null}, ${kind}, ${params}::jsonb, ${note || null}, ${c.get("user").id})
      returning id`));
    await audit(c, "isms_control.created", String(row!.id), { project_id: id, environment_id: environmentId, ref, kind, params });
    return redirectWith(c, back, { kind: "ok", text: `Kontrolle ${ref} angelegt.` });
  });

  app.post("/admin/projects/:id/isms/:cid/records", async (c) => {
    const id = parseId(c.req.param("id"));
    const cid = parseId(c.req.param("cid"));
    if (!id || !cid) return c.notFound();
    const back = `/projects/${id}/isms`;
    const control = await rls(c, (tx) => first<{ ref: string }>(tx`select ref from isms_controls where id = ${cid} and project_id = ${id} and kind = 'record'`));
    if (!control) return c.notFound();
    const f = await formData(c);
    const doneOn = f.get("done_on");
    const result = f.get("result");
    const note = f.get("note");
    const link = f.get("link");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(doneOn) || Number.isNaN(Date.parse(doneOn)) || doneOn < "2000-01-01") {
      return redirectWith(c, back, { kind: "bad", text: "Bitte ein gültiges Datum angeben." });
    }
    if (doneOn > berlinToday()) return redirectWith(c, back, { kind: "bad", text: "Das Datum liegt in der Zukunft. Ein Nachweis wird eingetragen, wenn er erbracht ist." });
    if (result !== "passed" && result !== "deviation") return redirectWith(c, back, { kind: "bad", text: "Bitte das Ergebnis wählen." });
    if (note.length > MAX_NOTE) return redirectWith(c, back, { kind: "bad", text: `Die Notiz ist zu lang (höchstens ${MAX_NOTE} Zeichen).` });
    if (link && !isHttpsLink(link)) return redirectWith(c, back, { kind: "bad", text: "Der Beleg muss ein https-Link sein (höchstens 500 Zeichen)." });

    const row = await rls(c, (tx) => first<{ id: number }>(tx`
      insert into isms_records (control_id, done_on, result, note, link, created_by)
      values (${cid}, ${doneOn}, ${result}, ${note || null}, ${link || null}, ${c.get("user").id})
      returning id`));
    await audit(c, "isms_record.created", String(row!.id), { project_id: id, control_id: cid, ref: control.ref, done_on: doneOn, result });
    return redirectWith(c, back, { kind: "ok", text: `Nachweis für ${control.ref} eingetragen.` });
  });

  app.post("/admin/projects/:id/isms/:cid/delete", async (c) => {
    const id = parseId(c.req.param("id"));
    const cid = parseId(c.req.param("cid"));
    if (!id || !cid) return c.notFound();
    const row = await rls(c, (tx) => first<{ ref: string; title: string; kind: string }>(tx`
      delete from isms_controls where id = ${cid} and project_id = ${id} returning ref, title, kind`));
    if (!row) return c.notFound();
    await audit(c, "isms_control.deleted", String(cid), { project_id: id, ref: row.ref, title: row.title, kind: row.kind });
    return redirectWith(c, `/projects/${id}/isms`, { kind: "ok", text: `Kontrolle ${row.ref} gelöscht.` });
  });
}

/** The project's environments and monitors for the admin dialogs; null when the project does not exist. */
async function adminOptions(c: Context, projectId: number): Promise<{ envs: EnvOption[]; monitors: MonitorOption[] } | null> {
  return rls(c, async (tx) => {
    if (!(await first(tx`select 1 from projects where id = ${projectId}`))) return null;
    return {
      envs: await all<EnvOption>(tx`select id, name from environments where project_id = ${projectId} order by sort_order, name`),
      monitors: await all<MonitorOption>(tx`
        select m.id, m.environment_id, e.name as env_name, m.name from monitors m join environments e on e.id = m.environment_id
        where e.project_id = ${projectId} and m.enabled order by e.sort_order, e.name, m.name`),
    };
  });
}

function readParams(kind: ControlKind, f: { get(k: string): string }, envId: number | null, monitors: MonitorOption[]): Record<string, unknown> | string {
  const num = (k: string) => Number(f.get(k).replace(",", "."));
  switch (kind) {
    case "uptime": {
      const min = num("min_percent");
      if (!(min >= 50 && min <= 100)) return "Das Ziel muss zwischen 50 und 100 Prozent liegen.";
      const monitorId = f.get("monitor_id") ? parseId(f.get("monitor_id")) : null;
      if (monitorId !== null && !monitors.some((m) => m.id === monitorId && m.environment_id === envId)) return "Der Monitor gehört nicht zu der gewählten Umgebung.";
      return monitorId ? { min_percent: min, monitor_id: monitorId } : { min_percent: min };
    }
    case "tls": {
      const days = num("min_days");
      if (!Number.isInteger(days) || days < 1 || days > 365) return "Der Vorlauf muss zwischen 1 und 365 Tagen liegen.";
      return { min_days: days };
    }
    case "logs": {
      const retention = num("retention_days");
      const silence = num("max_silence_hours");
      if (!Number.isInteger(retention) || retention < 1 || retention > 3650) return "Die Aufbewahrung muss zwischen 1 und 3650 Tagen liegen.";
      if (!Number.isInteger(silence) || silence < 1 || silence > 720) return "Die erlaubte Pause muss zwischen 1 und 720 Stunden liegen.";
      return { retention_days: retention, max_silence_hours: silence };
    }
    case "vulns": {
      const source = f.get("source") as VulnSource;
      if (!(source in VULN_SOURCE_LABEL)) return "Bitte eine Quelle wählen.";
      const critical = num("critical_days");
      const high = num("high_days");
      if (!Number.isInteger(critical) || critical < 0 || critical > 365) return "Die Frist für kritische muss zwischen 0 und 365 Tagen liegen.";
      if (!Number.isInteger(high) || high < 0 || high > 365) return "Die Frist für hohe muss zwischen 0 und 365 Tagen liegen.";
      return { source, critical_days: critical, high_days: high };
    }
    case "maintenance": {
      const days = num("max_age_days");
      const template = f.get("template").trim();
      if (!Number.isInteger(days) || days < 1 || days > 365) return "Der Abstand muss zwischen 1 und 365 Tagen liegen.";
      if (template.length > 100) return "Die Vorlage ist zu lang (höchstens 100 Zeichen).";
      return template ? { max_age_days: days, template } : { max_age_days: days };
    }
    case "record": {
      const raw = f.get("interval_days");
      const days = raw ? Number(raw) : null;
      if (!INTERVALS.some((i) => i.days === days)) return "Bitte einen Abstand wählen.";
      return { interval_days: days };
    }
    case "servers":
      return {};
  }
}

function openHint(open: number, unknown: number): string {
  if (!unknown) return "Maßnahmen noch nicht umgesetzt";
  const parts = [open && `${open} Maßnahme${open === 1 ? "" : "n"} offen`, `${unknown} ohne Daten`].filter(Boolean);
  return parts.join(", ");
}

function isHttpsLink(link: string): boolean {
  if (link.length > 500) return false;
  try {
    return new URL(link).protocol === "https:";
  } catch {
    return false;
  }
}

/** Banner, counts and the controls table: the same on the project's ISMS tab and an environment's. */
function IsmsBody(props: { project: number; controls: JudgedControl[]; admin: boolean }) {
  const { controls } = props;
  const counts = countByStatus(controls);
  return (
    <>
      <Summary controls={controls} />
      <div class="grid grid-4">
        <Stat label="Erfüllt" icon="circle-check" value={`${counts.ok + counts.warn} von ${controls.length}`} tone={counts.ok + counts.warn === controls.length ? "ok" : undefined} hint={counts.warn ? `${counts.warn} davon mit Hinweis` : "ohne Einschränkung"} />
        <Stat label="Abweichungen" icon="circle-x" value={counts.deviation} tone={counts.deviation ? "bad" : undefined} hint="halten die Zusage gerade nicht" />
        <Stat label="Fällige Nachweise" icon="calendar-clock" value={counts.due} tone={counts.due ? "warn" : undefined} hint="fehlen oder sind zu alt" />
        <Stat label="Offen" icon="circle-dashed" value={counts.open + counts.unknown} hint={openHint(counts.open, counts.unknown)} />
      </div>
      <ControlsCard project={props.project} controls={controls} admin={props.admin} />
    </>
  );
}

function Summary(props: { controls: JudgedControl[] }) {
  const by = (s: string) => props.controls.filter((k) => k.verdict.status === s);
  const refs = (ks: JudgedControl[]) => ks.map((k) => k.ref).join(", ");
  const deviations = by("deviation");
  const due = by("due");
  const warn = by("warn");
  if (deviations.length) {
    const n = deviations.length;
    return <StatusBanner tone="bad" title={n === 1 ? "Eine Kontrolle weicht ab" : `${n} Kontrollen weichen ab`} text={refs(deviations)} />;
  }
  if (due.length) {
    const n = due.length;
    return <StatusBanner tone="warn" title={n === 1 ? "Ein Nachweis ist fällig" : `${n} Nachweise sind fällig`} text={refs(due)} />;
  }
  if (warn.length) return <StatusBanner tone="warn" title="Eingehalten, mit Hinweisen" text={refs(warn)} />;
  return <StatusBanner tone="ok" title="Alle geprüften Kontrollen eingehalten" text="Messwerte und Nachweise sind aktuell." />;
}

function ControlsCard(props: { project: number; controls: JudgedControl[]; admin: boolean }) {
  return (
    <Card title="Kontrollen" icon="list-checks" flush description="Live aus den Messdaten von Vantage; Nachweise werden eingetragen.">
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Kontrolle</th><th>Prüfung</th><th>Stand</th><th>Status</th>{props.admin && <th></th>}</tr>
          </thead>
          <tbody>
            {props.controls.map((k) => (
              <tr>
                <td>
                  <span class="cell-title"><code class="isms-ref">{k.ref}</code> {k.title}</span>
                  {k.basis && <span class="cell-sub">{k.basis}</span>}
                  {k.note && <span class="cell-sub">{k.note}</span>}
                </td>
                <td class="nowrap">
                  <span class="row isms-kind"><Icon name={KIND_ICON[k.kind]} size="sm" />{KIND_LABEL[k.kind]}</span>
                  <span class="cell-sub">{k.kind === "record" ? intervalLabel(k.params.interval_days) : k.env_name ?? "–"}</span>
                </td>
                <td class="isms-state">
                  {k.verdict.value}
                  {k.verdict.detail && <span class="cell-sub">{k.verdict.detail}</span>}
                  {k.last?.note && <span class="cell-sub">„{k.last.note}“</span>}
                  {k.last?.link && <span class="cell-sub"><a href={k.last.link} rel="noopener noreferrer" target="_blank" class="row"><Icon name="external-link" size="sm" />Beleg</a></span>}
                  {k.records > 1 && <span class="cell-sub">{k.records} Nachweise insgesamt</span>}
                </td>
                <td class="nowrap"><Badge tone={STATUS_TONE[k.verdict.status]} dot>{STATUS_LABEL[k.verdict.status]}</Badge></td>
                {props.admin && (
                  <td class="right nowrap">
                    <span class="row isms-actions">
                      {k.kind === "record" && <DialogButton dialog={`isms-record-${k.id}`} icon="plus" class="small">Nachweis</DialogButton>}
                      <ConfirmAction
                        action={`/admin/projects/${props.project}/isms/${k.id}/delete`}
                        label="Löschen"
                        question={`Kontrolle ${k.ref} mit allen Nachweisen löschen?`}
                        confirmLabel="Ja, löschen"
                      />
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ControlDialog(props: { projectId: number; kind: ControlKind; envs: EnvOption[]; monitors: MonitorOption[] }) {
  const { kind, envs } = props;
  const id = `${NEW_DIALOG}-${kind}`;
  const f = (name: string) => `${id}-${name}`;
  return (
    <FormDialog id={id} title={`Kontrolle: ${KIND_LABEL[kind]}`} description={KIND_TEXT[kind]} icon={KIND_ICON[kind]} action={`/admin/projects/${props.projectId}/isms`} submitLabel="Kontrolle anlegen" back={NEW_DIALOG}>
      <input type="hidden" name="kind" value={kind} />
      <div class="fields">
        <Field label="Kennung" for={f("ref")} hint="z. B. A.8.13">
          <input id={f("ref")} name="ref" type="text" required maxlength={40} autocomplete="off" />
        </Field>
        <Field label="Titel" for={f("title")}>
          <input id={f("title")} name="title" type="text" required maxlength={200} autocomplete="off" />
        </Field>
      </div>
      <Field label="Grundlage (optional)" for={f("basis")} hint="Wo die Kontrolle zugesagt ist, z. B. ein Abschnitt im ISMS oder im Vertrag">
        <input id={f("basis")} name="basis" type="text" maxlength={200} autocomplete="off" />
      </Field>
      {kind !== "record" && (
        <Field label="Umgebung" for={f("env")}>
          {envs.length === 0 ? <p class="small muted">Dieses Projekt hat noch keine Umgebung.</p> : (
            <select id={f("env")} name="environment_id" required>
              {envs.map((e) => <option value={String(e.id)}>{e.name}</option>)}
            </select>
          )}
        </Field>
      )}
      {kind === "uptime" && (
        <div class="fields">
          <Field label="Ziel in Prozent" for={f("min")} hint="Über 30 Tage, rund um die Uhr gemessen">
            <input id={f("min")} name="min_percent" type="text" inputmode="decimal" required value={String(DEFAULTS.uptime.min_percent).replace(".", ",")} />
          </Field>
          <Field label="Monitor" for={f("monitor")} hint="Ohne Auswahl zählt der schwächste">
            <select id={f("monitor")} name="monitor_id">
              <option value="">Alle Monitore der Umgebung</option>
              {props.monitors.map((m) => <option value={String(m.id)}>{m.env_name} · {m.name}</option>)}
            </select>
          </Field>
        </div>
      )}
      {kind === "tls" && (
        <Field label="Vorlauf in Tagen" for={f("days")} hint="So lange muss jedes Zertifikat mindestens noch gelten">
          <input id={f("days")} name="min_days" type="number" min={1} max={365} required value={String(DEFAULTS.tls.min_days)} />
        </Field>
      )}
      {kind === "logs" && (
        <div class="fields">
          <Field label="Aufbewahrung in Tagen" for={f("retention")}>
            <input id={f("retention")} name="retention_days" type="number" min={1} max={3650} required value={String(DEFAULTS.logs.retention_days)} />
          </Field>
          <Field label="Erlaubte Pause in Stunden" for={f("silence")} hint="Länger ohne neue Protokolle gilt als Abweichung">
            <input id={f("silence")} name="max_silence_hours" type="number" min={1} max={720} required value={String(DEFAULTS.logs.max_silence_hours)} />
          </Field>
        </div>
      )}
      {kind === "vulns" && (
        <>
          <Field label="Quelle" for={f("source")}>
            <select id={f("source")} name="source">
              {(Object.keys(VULN_SOURCE_LABEL) as VulnSource[]).map((k) => <option value={k} selected={k === DEFAULTS.vulns.source}>{VULN_SOURCE_LABEL[k]}</option>)}
            </select>
          </Field>
          <div class="fields">
            <Field label="Frist kritisch in Tagen" for={f("critical")} hint="Ab dem Tag, an dem Vantage sie zuerst sieht">
              <input id={f("critical")} name="critical_days" type="number" min={0} max={365} required value={String(DEFAULTS.vulns.critical_days)} />
            </Field>
            <Field label="Frist hoch in Tagen" for={f("high")}>
              <input id={f("high")} name="high_days" type="number" min={0} max={365} required value={String(DEFAULTS.vulns.high_days)} />
            </Field>
          </div>
        </>
      )}
      {kind === "maintenance" && (
        <div class="fields">
          <Field label="Höchstens Tage zwischen zwei Läufen" for={f("age")}>
            <input id={f("age")} name="max_age_days" type="number" min={1} max={365} required value={String(DEFAULTS.maintenance.max_age_days)} />
          </Field>
          <Field label="Vorlage (optional)" for={f("template")} hint="Nur Läufe, deren Vorlage diesen Text enthält, z. B. Patch">
            <input id={f("template")} name="template" type="text" maxlength={100} autocomplete="off" />
          </Field>
        </div>
      )}
      {kind === "record" && (
        <Field label="Abstand" for={f("interval")} hint="Wie oft der Nachweis erneuert werden muss">
          <select id={f("interval")} name="interval_days">
            {INTERVALS.map((i) => <option value={i.days === null ? "" : String(i.days)}>{i.label}</option>)}
          </select>
        </Field>
      )}
      <Field label="Notiz (optional)" for={f("note")}>
        <textarea id={f("note")} name="note" rows={2} maxlength={MAX_NOTE}></textarea>
      </Field>
    </FormDialog>
  );
}

function RecordDialog(props: { projectId: number; control: JudgedControl }) {
  const k = props.control;
  const id = `isms-record-${k.id}`;
  const today = berlinToday();
  return (
    <FormDialog
      id={id}
      title={`Nachweis: ${k.ref}`}
      description={k.title}
      icon="calendar-clock"
      action={`/admin/projects/${props.projectId}/isms/${k.id}/records`}
      submitLabel="Nachweis eintragen"
    >
      <div class="fields">
        <Field label="Durchgeführt am" for={`${id}-date`}>
          <input id={`${id}-date`} name="done_on" type="date" required max={today} value={today} />
        </Field>
        <Field label="Ergebnis" for={`${id}-result`}>
          <select id={`${id}-result`} name="result">
            <option value="passed">Bestanden</option>
            <option value="deviation">Mit Abweichungen</option>
          </select>
        </Field>
      </div>
      <Field label="Notiz (optional)" for={`${id}-note`} hint="Was geprüft wurde, wer dabei war">
        <textarea id={`${id}-note`} name="note" rows={3} maxlength={MAX_NOTE}></textarea>
      </Field>
      <Field label="Beleg (optional)" for={`${id}-link`} hint="https-Link auf das Protokoll, z. B. in DocuVault">
        <input id={`${id}-link`} name="link" type="url" maxlength={500} autocomplete="off" placeholder="https://" />
      </Field>
    </FormDialog>
  );
}
