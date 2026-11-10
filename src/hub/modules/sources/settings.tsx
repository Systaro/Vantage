/**
 * Admin configuration of an environment's log and APM sources (block on the environment settings
 * page). Routes live under /admin, so the admin middleware applies; the policies check again.
 */
import type { Context, Hono } from "hono";
import { formData, parseId, redirectWith } from "../../../shared/http";
import { Ago, Badge, Card, ConfirmAction, DialogButton, Field, FormDialog, formatNumber } from "../../../shared/ui/components";
import { hubConfig } from "../../config";
import { all, first, rls } from "../../db";
import { audit, loadEnv, type EnvContext } from "../../ui";
import { MAX_HOSTS, parseAnsibleConfig } from "../ansible/semaphore";
import { registerSettingsSection } from "../core/registry";
import { apmEs, apmIndices, esProblem, logsEs, logsIndex } from "../es/client";
import { isConfigured } from "../integrations/kinds";
import { resolveIntegration } from "../integrations/store";
import { dependencyTrack, DtError, MAX_PROJECTS, parseDependencyTrackConfig, projectLabel, UUID } from "../security/dependency-track";
import { listWazuhAgents, MAX_AGENTS, parseWazuhConfig } from "../security/wazuh";
import { apmServiceProblem, defaultSourceName, filterProblem, indexFamily, indexPatternProblem, MAX_SOURCE_NAME, sourceNameProblem } from "./pattern";
import { parseApmConfig, parseNamedLogsSource, type LogsSource } from "./config";
import { suggestFilterFields, suggestFilterValues, suggestIndexPatterns } from "./suggest";

const MAX_FAMILIES = 30;
/** Logs sources per environment: one per service of an application is the case this is for. */
export const MAX_LOG_SOURCES = 10;

interface PollRow {
  polled_until: Date | null;
  last_error: string | null;
  updated_at: Date;
}

interface LogsRow {
  id: number;
  name: string;
  config: (Record<string, string> & { errorGroups?: boolean }) | null;
  poll: PollRow | null;
}

async function SourcesSection(c: Context, env: EnvContext) {
  const data = await rls(c, async (tx) => ({
    sources: await all<{ kind: string; config: unknown }>(tx`select kind, config from environment_sources where environment_id = ${env.id} and kind <> 'logs'`),
    logs: await all<{ id: number; name: string; config: LogsRow["config"]; polled_until: Date | null; last_error: string | null; updated_at: Date | null }>(tx`
      select s.id, s.name, s.config, p.polled_until, p.last_error, p.updated_at
      from environment_sources s left join log_error_poll_state p on p.source_id = s.id
      where s.environment_id = ${env.id} and s.kind = 'logs' order by s.id`),
    poll: await first<PollRow>(tx`
      select polled_until, last_error, updated_at from error_poll_state where environment_id = ${env.id}`),
    dtProjects: await all<{ project_uuid: string; name: string | null; version: string | null; last_error: string | null }>(tx`
      select project_uuid, name, version, last_error from security_projects where environment_id = ${env.id} order by name`),
    agents: await all<{ agent_name: string; os: string | null; last_error: string | null }>(tx`
      select agent_name, os, last_error from security_agents where environment_id = ${env.id}`),
  }));
  const logs: LogsRow[] = data.logs.map((r) => ({ id: r.id, name: r.name, config: r.config, poll: r.updated_at ? { polled_until: r.polled_until, last_error: r.last_error, updated_at: r.updated_at } : null }));
  const rawApm = data.sources.find((s) => s.kind === "apm")?.config as Record<string, string> | undefined;
  const apmValid = rawApm ? parseApmConfig(rawApm) !== null : true;
  const base = `/admin/env/${env.id}/sources`;
  const prefixes = hubConfig.logs.prefixes;
  const logsConnected = isConfigured("logs", (await resolveIntegration("logs")).row);
  const apmConnected = isConfigured("apm", (await resolveIntegration("apm")).row);
  const dtConnected = isConfigured("dependency_track", (await resolveIntegration("dependency_track")).row);
  const rawDt = data.sources.find((s) => s.kind === "dependency_track")?.config;
  const dtSelected = parseDependencyTrackConfig(rawDt);
  const wazuhConnected = isConfigured("wazuh", (await resolveIntegration("wazuh")).row);
  const rawWazuh = data.sources.find((s) => s.kind === "wazuh")?.config;
  const agentsSelected = parseWazuhConfig(rawWazuh);
  const semaphoreConnected = isConfigured("semaphore", (await resolveIntegration("semaphore")).row);
  const rawAnsible = data.sources.find((s) => s.kind === "ansible")?.config;
  const hostsSelected = parseAnsibleConfig(rawAnsible);

  return (
    <Card title="Datenquellen" id="sources" description="Woher die Logs, Fehler, APM-Daten, Schwachstellen und Ansible-Läufe dieser Umgebung kommen.">
      <div class="stack">
        <div class="source-block">
          <div class="row-between">
            <h3>Logs {logs.length ? <Badge tone="ok">{logs.length === 1 ? "1 Quelle" : `${logs.length} Quellen`}</Badge> : <Badge tone="idle">nicht eingerichtet</Badge>}</h3>
            {logs.length < MAX_LOG_SOURCES && (
              <DialogButton dialog="logs-source-new" icon="plus" class={logs.length ? "small" : "small primary"}>{logs.length ? "Quelle hinzufügen" : "Einrichten"}</DialogButton>
            )}
          </div>
          {!logsConnected && <p class="status-warn small">Der Logs-Cluster ist noch nicht angebunden (<a href="/admin/integrations">Integrationen</a>), daher zeigt der Logs-Tab noch nichts.</p>}
          {logs.length ? (
            <div class="log-source-list">{logs.map((l) => <LogsSourceItem base={base} source={l} only={logs.length === 1} />)}</div>
          ) : (
            <p class="muted small">Ohne Logs-Quelle hat diese Umgebung keinen Logs-Tab. Hat die Anwendung mehrere Dienste mit eigenem Index, bekommt jeder eine eigene Quelle.</p>
          )}
        </div>

        <div class="source-block">
          <div class="row-between">
            <h3>APM {rawApm ? <Badge tone="ok">eingerichtet</Badge> : <Badge tone="idle">nicht eingerichtet</Badge>}</h3>
            <div class="btn-group">
              <DialogButton dialog="apm-source" icon={rawApm ? "pencil" : "plus"} class={rawApm ? "small" : "small primary"}>{rawApm ? "Ändern" : "Einrichten"}</DialogButton>
              {rawApm && <ConfirmAction action={`${base}/apm/delete`} label="Entfernen" question="APM-Quelle entfernen? Die Tabs Fehler und APM verschwinden für alle." />}
            </div>
          </div>
          {!apmConnected && <p class="status-warn small">Der APM-Cluster ist noch nicht angebunden (<a href="/admin/integrations">Integrationen</a>), daher zeigen Fehler und APM noch nichts.</p>}
          {!apmValid && <p class="status-bad small">Die gespeicherte Konfiguration ist ungültig und wird nicht verwendet. Bitte neu speichern.</p>}
          {rawApm ? (
            <>
              <dl class="facts">
                <dt>service.name</dt><dd><code>{rawApm.service}</code></dd>
                <dt>service.environment</dt><dd><code>{rawApm.environment}</code></dd>
              </dl>
              <PollStatus poll={data.poll} />
            </>
          ) : <p class="muted small">Ohne APM-Quelle hat diese Umgebung keine Tabs Fehler und APM.</p>}
        </div>

        <div class="source-block">
          <div class="row-between">
            <h3>Dependency-Track {rawDt ? <Badge tone="ok">eingerichtet</Badge> : <Badge tone="idle">nicht eingerichtet</Badge>}</h3>
            <div class="btn-group">
              <DialogButton dialog="dt-source" icon={rawDt ? "pencil" : "plus"} class={rawDt ? "small" : "small primary"}>{rawDt ? "Ändern" : "Einrichten"}</DialogButton>
              {rawDt && <ConfirmAction action={`${base}/dependency_track/delete`} label="Entfernen" question="Dependency-Track-Zuordnung entfernen? Der Tab Sicherheit und die gesammelten Schwachstellen verschwinden." />}
            </div>
          </div>
          {!dtConnected && <p class="status-warn small">Dependency-Track ist noch nicht angebunden (<a href="/admin/integrations">Integrationen</a>), daher kommen noch keine Schwachstellen an.</p>}
          {rawDt && !dtSelected && <p class="status-bad small">Die gespeicherte Konfiguration ist ungültig und wird nicht verwendet. Bitte neu speichern.</p>}
          {dtSelected ? (
            <dl class="facts">
              <dt>Projekte</dt>
              <dd>{dtSelected.map((uuid) => {
                const p = data.dtProjects.find((x) => x.project_uuid === uuid);
                return <div>{p?.name ? projectLabel({ name: p.name, version: p.version }) : <code>{uuid}</code>}{p?.last_error && <span class="status-bad small"> · {p.last_error}</span>}</div>;
              })}</dd>
            </dl>
          ) : <p class="muted small">Ordnet dieser Umgebung Projekte aus Dependency-Track zu. Ihre Schwachstellen erscheinen im Tab Sicherheit, sichtbar nur mit der Freigabe „Sicherheit“.</p>}
        </div>

        <div class="source-block">
          <div class="row-between">
            <h3>Wazuh {rawWazuh ? <Badge tone="ok">eingerichtet</Badge> : <Badge tone="idle">nicht eingerichtet</Badge>}</h3>
            <div class="btn-group">
              <DialogButton dialog="wazuh-source" icon={rawWazuh ? "pencil" : "plus"} class={rawWazuh ? "small" : "small primary"}>{rawWazuh ? "Ändern" : "Einrichten"}</DialogButton>
              {rawWazuh && <ConfirmAction action={`${base}/wazuh/delete`} label="Entfernen" question="Wazuh-Zuordnung entfernen? Die Server und ihre Schwachstellen verschwinden aus dem Tab Sicherheit." />}
            </div>
          </div>
          {!wazuhConnected && <p class="status-warn small">Wazuh ist noch nicht angebunden (<a href="/admin/integrations">Integrationen</a>), daher kommen noch keine Daten an.</p>}
          {rawWazuh && !agentsSelected && <p class="status-bad small">Die gespeicherte Konfiguration ist ungültig und wird nicht verwendet. Bitte neu speichern.</p>}
          {agentsSelected ? (
            <dl class="facts">
              <dt>Server</dt>
              <dd>{agentsSelected.map((name) => {
                const a = data.agents.find((x) => x.agent_name === name);
                return <div>{name}{a?.os && <span class="muted small"> · {a.os}</span>}{a?.last_error && <span class="status-bad small"> · {a.last_error}</span>}</div>;
              })}</dd>
            </dl>
          ) : <p class="muted small">Ordnet dieser Umgebung die Server (Wazuh-Agenten) zu, auf denen sie läuft. Ihre Schwachstellen und Alarme erscheinen im Tab Sicherheit.</p>}
        </div>

        <div class="source-block">
          <div class="row-between">
            <h3>Ansible {rawAnsible ? <Badge tone="ok">eingerichtet</Badge> : <Badge tone="idle">nicht eingerichtet</Badge>}</h3>
            <div class="btn-group">
              <DialogButton dialog="ansible-source" icon={rawAnsible ? "pencil" : "plus"} class={rawAnsible ? "small" : "small primary"}>{rawAnsible ? "Ändern" : "Einrichten"}</DialogButton>
              {rawAnsible && <ConfirmAction action={`${base}/ansible/delete`} label="Entfernen" question="Ansible-Zuordnung entfernen? Der Tab Wartung verschwindet; die Läufe selbst bleiben in Vantage." />}
            </div>
          </div>
          {!semaphoreConnected && <p class="status-warn small">Semaphore ist noch nicht angebunden (<a href="/admin/integrations">Integrationen</a>), daher kommen noch keine Läufe an.</p>}
          {rawAnsible && !hostsSelected && <p class="status-bad small">Die gespeicherte Konfiguration ist ungültig und wird nicht verwendet. Bitte neu speichern.</p>}
          {hostsSelected ? (
            <dl class="facts">
              <dt>Server</dt>
              <dd>{hostsSelected.map((h) => <div class="mono small">{h}</div>)}</dd>
            </dl>
          ) : <p class="muted small">Ordnet dieser Umgebung die Server zu, auf denen sie läuft, mit dem Namen aus dem Ansible-Inventar. Die Läufe auf diesen Servern erscheinen im Tab Wartung, sichtbar nur mit der Freigabe „Sicherheit“.</p>}
        </div>
      </div>

      {logs.length < MAX_LOG_SOURCES && <LogsSourceDialog base={base} prefixes={prefixes} hasApm={!!rawApm} />}
      {logs.map((l) => <LogsSourceDialog base={base} prefixes={prefixes} hasApm={!!rawApm} source={l} />)}

      <FormDialog
        id="apm-source"
        title={rawApm ? "APM-Quelle ändern" : "APM-Quelle einrichten"}
        description="Dienst auf dem APM-Cluster. Jede APM-Abfrage filtert auf genau diese beiden Werte."
        icon="gauge"
        action={`${base}/apm`}
        submitLabel="Speichern"
        wide
      >
        <div class="fields">
          <Field label="service.name" for="src-service">
            <input id="src-service" name="service" type="text" required autocomplete="off" spellcheck={false} list="apm-service-names" value={rawApm?.service ?? ""} placeholder="shop-backend" />
          </Field>
          <Field label="service.environment" for="src-env">
            <input id="src-env" name="environment" type="text" required autocomplete="off" spellcheck={false} list="apm-service-envs" value={rawApm?.environment ?? ""} placeholder="production" />
          </Field>
        </div>
        <div class="src-preview" hx-get="/admin/sources/apm-services" hx-trigger="intersect once">
          <p class="muted small">Dienste im APM-Cluster werden geladen …</p>
        </div>
      </FormDialog>

      <FormDialog
        id="dt-source"
        title={rawDt ? "Dependency-Track-Projekte ändern" : "Dependency-Track einrichten"}
        description={`Welche Projekte in Dependency-Track zu dieser Umgebung gehören, höchstens ${MAX_PROJECTS}. Vantage gleicht sie alle 15 Minuten ab.`}
        icon="shield-check"
        action={`${base}/dependency_track`}
        submitLabel="Speichern"
        wide
      >
        <div hx-get={`/admin/sources/dt-projects?env=${env.id}`} hx-trigger="intersect once" hx-swap="outerHTML">
          <p class="muted small">Projekte werden aus Dependency-Track geladen …</p>
        </div>
      </FormDialog>

      <FormDialog
        id="wazuh-source"
        title={rawWazuh ? "Wazuh-Server ändern" : "Wazuh einrichten"}
        description={`Auf welchen Servern (Wazuh-Agenten) diese Umgebung läuft, höchstens ${MAX_AGENTS}. Vantage gleicht ihre Schwachstellen stündlich ab.`}
        icon="shield-check"
        action={`${base}/wazuh`}
        submitLabel="Speichern"
        wide
      >
        <div hx-get={`/admin/sources/wazuh-agents?env=${env.id}`} hx-trigger="intersect once" hx-swap="outerHTML">
          <p class="muted small">Agenten werden aus Wazuh geladen …</p>
        </div>
      </FormDialog>

      <FormDialog
        id="ansible-source"
        title={rawAnsible ? "Ansible-Server ändern" : "Ansible einrichten"}
        description={`Auf welchen Servern diese Umgebung läuft, höchstens ${MAX_HOSTS}. Zur Auswahl stehen die Server aus den Ansible-Läufen der letzten 90 Tage.`}
        icon="terminal"
        action={`${base}/ansible`}
        submitLabel="Speichern"
        wide
      >
        <div hx-get={`/admin/sources/ansible-hosts?env=${env.id}`} hx-trigger="intersect once" hx-swap="outerHTML">
          <p class="muted small">Server werden geladen …</p>
        </div>
      </FormDialog>
    </Card>
  );
}

function LogsSourceItem(props: { base: string; source: LogsRow; only: boolean }) {
  const { id, name, config } = props.source;
  const valid = parseNamedLogsSource(props.source) !== null;
  return (
    <div class="log-source-item">
      <div class="row-between">
        <h4>{name}</h4>
        <div class="btn-group">
          <DialogButton dialog={`logs-source-${id}`} icon="pencil" class="small">Ändern</DialogButton>
          <ConfirmAction
            action={`${props.base}/logs/${id}/delete`}
            label="Entfernen"
            question={`Logs-Quelle „${name}“ entfernen? ${props.only ? "Der Logs-Tab verschwindet für alle." : "Ihre Einträge verschwinden aus dem Logs-Tab."}`}
          />
        </div>
      </div>
      {!valid && <p class="status-bad small">Die gespeicherte Konfiguration ist ungültig und wird nicht verwendet. Bitte neu speichern.</p>}
      <dl class="facts">
        <dt>Indexmuster</dt><dd><code>{config?.index}</code></dd>
        <dt>Filter</dt><dd>{config?.filterField ? <code>{config.filterField} = {config.filterValue}</code> : <span class="muted">keiner, der ganze Index gehört zu dieser Umgebung</span>}</dd>
        <dt>Fehlergruppen</dt><dd>{config?.errorGroups === false ? <span class="muted">aus</span> : "aus den ERROR-Einträgen"}</dd>
      </dl>
      {config?.errorGroups !== false && <PollStatus poll={props.source.poll} />}
    </div>
  );
}

/** Adding a logs source, or (with `source`) changing one. The field ids carry the source, since every dialog is on the page. */
function LogsSourceDialog(props: { base: string; prefixes: readonly string[]; hasApm: boolean; source?: LogsRow }) {
  const s = props.source;
  const key = s ? String(s.id) : "new";
  const id = (field: string) => `src-${field}-${key}`;
  const index = s?.config?.index ?? "";
  return (
    <FormDialog
      id={`logs-source-${key}`}
      title={s ? `Logs-Quelle „${s.name}“ ändern` : "Logs-Quelle hinzufügen"}
      description={<>Indexmuster auf dem Logs-Cluster. Erlaubte Präfixe: {props.prefixes.map((p) => <code>{p}</code>)}. Kein „*“ am Anfang, keine Kommas, mindestens zwei feste Zeichen nach dem Präfix.</>}
      icon="scroll-text"
      action={s ? `${props.base}/logs/${s.id}` : `${props.base}/logs`}
      submitLabel="Speichern"
      wide
    >
      <div class="fields">
        <Field label="Indexmuster" for={id("index")} hint="z. B. logstash-shop-prod-*">
          <input
            id={id("index")}
            name="index"
            type="text"
            required
            autocomplete="off"
            spellcheck={false}
            value={index}
            placeholder={`${props.prefixes[0] ?? ""}…-*`}
            data-suggest="/admin/sources/suggest/index"
            hx-get="/admin/sources/preview"
            hx-trigger="input changed delay:400ms"
            hx-target={`#${id("preview")}`}
            hx-sync="this:replace"
          />
        </Field>
        <Field label={s ? "Name" : "Name (optional)"} for={id("name")} hint={s ? "im Logs-Tab und für Agenten" : "z. B. search-api; leer: aus dem Indexmuster"}>
          <input id={id("name")} name="name" type="text" required={!!s} maxlength={MAX_SOURCE_NAME} autocomplete="off" value={s?.name ?? ""} />
        </Field>
      </div>
      <div class="fields">
        <Field label="Filterfeld (optional)" for={id("field")} hint="nur bei geteilten Indizes, z. B. appname.keyword">
          <input id={id("field")} name="filter_field" type="text" autocomplete="off" spellcheck={false} value={s?.config?.filterField ?? ""} data-suggest="/admin/sources/suggest/field" data-suggest-with={`index=${id("index")}`} />
        </Field>
        <Field label="Filterwert (optional)" for={id("value")} hint="exakter Wert des Filterfelds">
          <input id={id("value")} name="filter_value" type="text" autocomplete="off" spellcheck={false} value={s?.config?.filterValue ?? ""} data-suggest="/admin/sources/suggest/value" data-suggest-with={`index=${id("index")} field=${id("field")}`} />
        </Field>
      </div>
      <div>
        <label class="check">
          <input type="checkbox" name="error_groups" value="1" checked={s?.config?.errorGroups !== false} />
          ERROR-Einträge zu Fehlergruppen zusammenfassen (Tab Fehler, mit Benachrichtigung bei neuen Fehlern)
        </label>
        {props.hasApm && <p class="muted small">Meldet die Anwendung ihre Fehler auch an APM, erscheinen sie im Tab Fehler doppelt. Dann hier ausschalten.</p>}
      </div>
      <div id={id("preview")} class="src-preview" aria-live="polite" {...(index ? { "hx-get": `/admin/sources/preview?index=${encodeURIComponent(index)}`, "hx-trigger": "intersect once" } : {})}>
        <p class="muted small">Beim Tippen erscheint hier, welche Indexfamilien das Muster trifft.</p>
      </div>
    </FormDialog>
  );
}

function PollStatus(props: { poll: PollRow | null }) {
  const p = props.poll;
  if (!p) return <p class="muted small">Fehlerabfrage: noch nicht gelaufen. Der erste Lauf übernimmt die letzten 24 Stunden ohne Benachrichtigungen.</p>;
  return (
    <p class="small">
      Fehlerabfrage: {p.polled_until ? <>abgefragt bis <Ago at={p.polled_until} /></> : "noch kein erfolgreicher Lauf"}
      {p.last_error && <span class="status-bad"> · letzter Fehler <Ago at={p.updated_at} />: {p.last_error}</span>}
    </p>
  );
}

async function IndexPreview(props: { pattern: string }) {
  const problem = indexPatternProblem(props.pattern, hubConfig.logs.prefixes);
  if (problem) return <p class="status-bad small">{problem}</p>;
  let indices;
  try {
    indices = await logsEs.catIndices(logsIndex(props.pattern));
  } catch (err) {
    return <p class="status-warn small">Vorschau nicht möglich: {esProblem(err)}</p>;
  }
  if (indices.length === 0) return <p class="status-warn small">„{props.pattern}“ passt derzeit auf keinen Index. Speichern geht trotzdem, etwa für eine neue Anwendung.</p>;
  const families = new Map<string, { count: number; docs: number; newest: string }>();
  for (const i of indices) {
    const key = indexFamily(i.index);
    const f = families.get(key) ?? { count: 0, docs: 0, newest: i.index };
    f.count += 1;
    f.docs += Number(i["docs.count"] ?? 0) || 0;
    if (i.index > f.newest) f.newest = i.index;
    families.set(key, f);
  }
  const list = [...families.entries()].sort((a, b) => b[1].docs - a[1].docs);
  return (
    <div class="stack">
      <p class="small">
        „{props.pattern}“ passt auf {formatNumber(indices.length)} {indices.length === 1 ? "Index" : "Indizes"} in {formatNumber(families.size)} {families.size === 1 ? "Familie" : "Familien"}.
        {families.size > 1 && <span class="status-warn"> Mehrere Familien: prüfen, ob wirklich alle zu dieser Umgebung gehören.</span>}
      </p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Indexfamilie</th><th class="num">Indizes</th><th class="num">Dokumente</th><th>Neuester Index</th></tr></thead>
          <tbody>
            {list.slice(0, MAX_FAMILIES).map(([name, f]) => (
              <tr><td class="mono small">{name}</td><td class="num">{formatNumber(f.count)}</td><td class="num">{formatNumber(f.docs)}</td><td class="mono small">{f.newest}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > MAX_FAMILIES && <p class="muted small">… und {list.length - MAX_FAMILIES} weitere.</p>}
    </div>
  );
}

/** The project picker in the Dependency-Track dialog: active projects, the mapped ones ticked. */
async function DtProjectChoice(props: { selected: string[] }) {
  let projects;
  try {
    projects = await dependencyTrack.listProjects();
  } catch (err) {
    if (err instanceof DtError) return <p class="status-warn small">Projektliste nicht verfügbar: {err.message}</p>;
    throw err;
  }
  if (projects.length === 0) return <p class="muted small">Dependency-Track zeigt diesem API-Key keine aktiven Projekte.</p>;
  return (
    <div class="stack">
      <Field label="Projekte filtern" for="dt-filter">
        <input id="dt-filter" type="search" autocomplete="off" placeholder="Name oder Version" data-filter="#dt-source .dt-choice" />
      </Field>
      <div class="dt-choices">
        {projects.map((p) => (
          <label class="check dt-choice" data-search={projectLabel(p).toLowerCase()}>
            <input type="checkbox" name="projects" value={p.uuid} checked={props.selected.includes(p.uuid.toLowerCase())} />
            <span>{p.name}{p.version && <span class="muted"> {p.version}</span>}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

async function WazuhAgentChoice(props: { selected: string[] }) {
  let agents;
  try {
    agents = await listWazuhAgents();
  } catch (err) {
    return <p class="status-warn small">Agentenliste nicht verfügbar: {esProblem(err)}</p>;
  }
  if (agents.length === 0) return <p class="muted small">Wazuh meldet keine Agenten mit Schwachstellendaten.</p>;
  return (
    <div class="stack">
      <Field label="Server filtern" for="wazuh-filter">
        <input id="wazuh-filter" type="search" autocomplete="off" placeholder="Name" data-filter="#wazuh-source .dt-choice" />
      </Field>
      <div class="dt-choices">
        {agents.map((a) => (
          <label class="check dt-choice" data-search={a.name.toLowerCase()}>
            <input type="checkbox" name="agents" value={a.name} checked={props.selected.includes(a.name)} />
            <span>{a.name}{a.os && <span class="muted small"> {a.os}</span>}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** Servers from the recent Ansible runs; the mapped ones ticked, those matching a monitor first. */
async function AnsibleHostChoice(props: { c: Context; envId: number }) {
  const data = await rls(props.c, async (tx) => ({
    selected: parseAnsibleConfig((await first<{ config: unknown }>(tx`select config from environment_sources where environment_id = ${props.envId} and kind = 'ansible'`))?.config) ?? [],
    hosts: await all<{ host: string; runs: number }>(tx`
      select h.host, count(*)::int as runs from ansible_run_hosts h join ansible_runs r on r.id = h.run_id
      where r.created_at > now() - interval '90 days' and h.host <> 'localhost' group by h.host`),
    elsewhere: await all<{ host: string; env: string }>(tx`
      select h as host, p.name || ' ' || e.name as env
      from environment_sources s cross join jsonb_array_elements_text(s.config->'hosts') h
      join environments e on e.id = s.environment_id join projects p on p.id = e.project_id
      where s.kind = 'ansible' and s.environment_id <> ${props.envId} order by 2`),
    urls: await all<{ url: string | null }>(tx`
      select coalesce(config->>'url', 'https://' || (config->>'host')) as url from monitors where environment_id = ${props.envId}
      union select url from environments where id = ${props.envId}`),
  }));
  const monitored = new Set(data.urls.flatMap((u) => {
    try {
      return u.url ? [new URL(u.url).hostname.toLowerCase()] : [];
    } catch {
      return [];
    }
  }));
  const runs = new Map(data.hosts.map((h) => [h.host, h.runs]));
  const names = [...new Set([...data.selected, ...runs.keys()])];
  const rank = (h: string) => (data.selected.includes(h) ? 0 : monitored.has(h.toLowerCase()) ? 1 : 2);
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  if (names.length === 0) return <p class="muted small">Noch keine Ansible-Läufe gelesen. Ist Semaphore angebunden, erscheinen die Server innerhalb weniger Minuten.</p>;
  return (
    <div class="stack">
      <Field label="Server filtern" for="ansible-filter">
        <input id="ansible-filter" type="search" autocomplete="off" placeholder="Name" data-filter="#ansible-source .dt-choice" />
      </Field>
      <div class="dt-choices">
        {names.map((h) => {
          const others = data.elsewhere.filter((x) => x.host === h).map((x) => x.env);
          return (
            <label class="check dt-choice host-choice" data-search={h.toLowerCase()}>
              <input type="checkbox" name="hosts" value={h} checked={data.selected.includes(h)} />
              <span>
                <span class="mono">{h}</span>
                <span class="cell-sub">
                  {!runs.has(h) ? "keine Läufe in 90 Tagen" : runs.get(h) === 1 ? "1 Lauf in 90 Tagen" : `${formatNumber(runs.get(h)!)} Läufe in 90 Tagen`}
                  {monitored.has(h.toLowerCase()) && <span class="status-ok"> · passt zu einem Monitor</span>}
                  {others.length > 0 && <> · auch bei {others.join(", ")}</>}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

async function ApmServices() {
  let res;
  try {
    res = await apmEs.search(apmIndices.transactions, {
      size: 0,
      query: { range: { "@timestamp": { gte: "now-7d" } } },
      aggs: { services: { terms: { field: "service.name", size: 100 }, aggs: { envs: { terms: { field: "service.environment", size: 20 } } } } },
    });
  } catch (err) {
    return <p class="status-warn small">Dienstliste nicht verfügbar: {esProblem(err)}</p>;
  }
  const services = (res.aggregations?.services?.buckets ?? []) as { key: string; envs: { buckets: { key: string; doc_count: number }[] } }[];
  if (services.length === 0) return <p class="muted small">Im APM-Cluster gibt es in den letzten 7 Tagen keine Transaktionen.</p>;
  const envNames = [...new Set(services.flatMap((s) => s.envs.buckets.map((e) => e.key)))].sort();
  return (
    <details class="disclosure">
      <summary>Dienste im APM-Cluster (7 Tage, {services.length})</summary>
      <datalist id="apm-service-names">{services.map((s) => <option value={s.key} />)}</datalist>
      <datalist id="apm-service-envs">{envNames.map((e) => <option value={e} />)}</datalist>
      <div class="table-wrap">
        <table>
          <thead><tr><th>service.name</th><th>service.environment</th><th class="num">Transaktionen</th></tr></thead>
          <tbody>
            {services.flatMap((s) =>
              s.envs.buckets.map((e) => (
                <tr><td class="mono small">{s.key}</td><td class="mono small">{e.key}</td><td class="num">{formatNumber(e.doc_count)}</td></tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}

let registered = false;

export function mountSources(app: Hono) {
  if (!registered) {
    registerSettingsSection(30, SourcesSection);
    registered = true;
  }

  app.get("/admin/sources/preview", async (c) => c.html(<IndexPreview pattern={(c.req.query("index") ?? "").trim()} />));
  app.get("/admin/sources/suggest/:what", async (c) => {
    const index = (c.req.query("index") ?? "").trim();
    const read = { index: () => suggestIndexPatterns(), field: () => suggestFilterFields(index), value: () => suggestFilterValues(index, (c.req.query("field") ?? "").trim()) }[c.req.param("what")];
    if (!read) return c.notFound();
    try {
      return c.json(await read());
    } catch (err) {
      return c.json({ items: [], note: `Vorschläge nicht verfügbar: ${esProblem(err)}` });
    }
  });
  app.get("/admin/sources/apm-services", async (c) => c.html(<ApmServices />));
  app.get("/admin/sources/dt-projects", async (c) => {
    const envId = parseId(c.req.query("env")) ?? 0;
    const row = await rls(c, (tx) => first<{ config: unknown }>(tx`select config from environment_sources where environment_id = ${envId} and kind = 'dependency_track'`));
    return c.html(<DtProjectChoice selected={parseDependencyTrackConfig(row?.config) ?? []} />);
  });

  app.get("/admin/sources/wazuh-agents", async (c) => {
    const envId = parseId(c.req.query("env")) ?? 0;
    const row = await rls(c, (tx) => first<{ config: unknown }>(tx`select config from environment_sources where environment_id = ${envId} and kind = 'wazuh'`));
    return c.html(<WazuhAgentChoice selected={parseWazuhConfig(row?.config) ?? []} />);
  });

  app.post("/admin/env/:id/sources/wazuh", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const back = `/env/${env.id}/settings#sources`;
    const agents = [...new Set((await formData(c)).all("agents"))];
    if (agents.length === 0) return redirectWith(c, back, { kind: "bad", text: "Mindestens einen Server auswählen." });
    const config = { agents };
    if (!parseWazuhConfig(config)) return redirectWith(c, back, { kind: "bad", text: `Ungültige Auswahl (höchstens ${MAX_AGENTS} Server).` });
    await rls(c, (tx) => tx`
      insert into environment_sources (environment_id, kind, config) values (${env.id}, 'wazuh', ${config}::jsonb)
      on conflict (environment_id, kind) where kind <> 'logs' do update set config = excluded.config`);
    await audit(c, "source.saved", String(env.id), { kind: "wazuh", agents });
    return redirectWith(c, back, { kind: "ok", text: "Wazuh-Server gespeichert. Der erste Abgleich läuft innerhalb einer Minute." });
  });

  app.get("/admin/sources/ansible-hosts", async (c) => c.html(<AnsibleHostChoice c={c} envId={parseId(c.req.query("env")) ?? 0} />));

  app.post("/admin/env/:id/sources/ansible", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const back = `/env/${env.id}/settings#sources`;
    const hosts = [...new Set((await formData(c)).all("hosts"))];
    if (hosts.length === 0) return redirectWith(c, back, { kind: "bad", text: "Mindestens einen Server auswählen." });
    const config = { hosts };
    if (!parseAnsibleConfig(config)) return redirectWith(c, back, { kind: "bad", text: `Ungültige Auswahl (höchstens ${MAX_HOSTS} Server).` });
    await rls(c, (tx) => tx`
      insert into environment_sources (environment_id, kind, config) values (${env.id}, 'ansible', ${config}::jsonb)
      on conflict (environment_id, kind) where kind <> 'logs' do update set config = excluded.config`);
    await audit(c, "source.saved", String(env.id), { kind: "ansible", hosts });
    return redirectWith(c, back, { kind: "ok", text: "Ansible-Server gespeichert. Ihre Läufe stehen im Tab Wartung." });
  });

  app.post("/admin/env/:id/sources/dependency_track", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const back = `/env/${env.id}/settings#sources`;
    const projects = [...new Set((await formData(c)).all("projects").map((p) => p.toLowerCase()))];
    if (projects.length === 0) return redirectWith(c, back, { kind: "bad", text: "Mindestens ein Projekt auswählen." });
    if (projects.length > MAX_PROJECTS) return redirectWith(c, back, { kind: "bad", text: `Höchstens ${MAX_PROJECTS} Projekte.` });
    if (!projects.every((p) => UUID.test(p))) return redirectWith(c, back, { kind: "bad", text: "Ungültige Projektauswahl." });
    await rls(c, (tx) => tx`
      insert into environment_sources (environment_id, kind, config) values (${env.id}, 'dependency_track', ${{ projects }}::jsonb)
      on conflict (environment_id, kind) where kind <> 'logs' do update set config = excluded.config`);
    await audit(c, "source.saved", String(env.id), { kind: "dependency_track", projects });
    return redirectWith(c, back, { kind: "ok", text: "Dependency-Track-Projekte gespeichert. Der erste Abgleich läuft innerhalb einer Minute." });
  });

  // A new logs source (no :sourceId) or a change to one. Its first poll is a silent backfill.
  app.post("/admin/env/:id/sources/logs/:sourceId?", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const raw = c.req.param("sourceId");
    const sourceId = raw === undefined ? null : parseId(raw);
    if (raw !== undefined && !sourceId) return c.notFound();
    const back = `/env/${env.id}/settings#sources`;
    const f = await formData(c);
    const index = f.get("index");
    const field = f.get("filter_field");
    const value = f.get("filter_value");
    const prefixes = hubConfig.logs.prefixes;
    const problem = indexPatternProblem(index, prefixes) ?? filterProblem(field, value);
    if (problem) return redirectWith(c, back, { kind: "bad", text: problem });
    const name = f.get("name") || (sourceId === null ? defaultSourceName(index, prefixes) : "");
    const nameProblem = sourceNameProblem(name);
    if (nameProblem) return redirectWith(c, back, { kind: "bad", text: nameProblem });
    const config: LogsSource = field ? { index, filterField: field, filterValue: value } : { index };
    if (f.get("error_groups") !== "1") config.errorGroups = false;
    const result = await rls(c, async (tx) => {
      const sources = await all<{ id: number; name: string; config: unknown }>(tx`
        select id, name, config from environment_sources where environment_id = ${env.id} and kind = 'logs'`);
      const prev = sourceId === null ? null : sources.find((s) => s.id === sourceId);
      if (prev === undefined) return "missing" as const;
      if (sources.some((s) => s.id !== sourceId && s.name.toLowerCase() === name.toLowerCase())) return "taken" as const;
      if (!prev) {
        if (sources.length >= MAX_LOG_SOURCES) return "full" as const;
        const [row] = await tx`
          insert into environment_sources (environment_id, kind, name, config) values (${env.id}, 'logs', ${name}, ${config}::jsonb) returning id`;
        return { id: (row as { id: number }).id, reset: true };
      }
      await tx`update environment_sources set name = ${name}, config = ${config}::jsonb where id = ${prev.id}`;
      // Other entries, or error groups switched back on: the next poll is a silent backfill, not a flood of events.
      const old = parseNamedLogsSource(prev);
      const changed = !old || old.index !== config.index || old.filterField !== config.filterField || old.filterValue !== config.filterValue || old.errorGroups !== config.errorGroups;
      if (changed) await tx`delete from log_error_poll_state where source_id = ${prev.id}`;
      return { id: prev.id, reset: changed };
    });
    if (result === "missing") return c.notFound();
    if (result === "taken") return redirectWith(c, back, { kind: "bad", text: `Diese Umgebung hat schon eine Logs-Quelle „${name}“.` });
    if (result === "full") return redirectWith(c, back, { kind: "bad", text: `Höchstens ${MAX_LOG_SOURCES} Logs-Quellen pro Umgebung.` });
    await audit(c, "source.saved", String(env.id), { kind: "logs", source: result.id, name, ...config, pollReset: result.reset });
    return redirectWith(c, back, { kind: "ok", text: sourceId === null ? `Logs-Quelle „${name}“ hinzugefügt.` : `Logs-Quelle „${name}“ gespeichert.` });
  });

  app.post("/admin/env/:id/sources/logs/:sourceId/delete", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    const sourceId = parseId(c.req.param("sourceId"));
    if (!env || !sourceId) return c.notFound();
    const [row] = await rls(c, (tx) => tx`
      delete from environment_sources where id = ${sourceId} and environment_id = ${env.id} and kind = 'logs' returning name`);
    if (!row) return c.notFound();
    const { name } = row as { name: string };
    await audit(c, "source.deleted", String(env.id), { kind: "logs", source: sourceId, name });
    return redirectWith(c, `/env/${env.id}/settings#sources`, { kind: "ok", text: `Logs-Quelle „${name}“ entfernt.` });
  });

  app.post("/admin/env/:id/sources/apm", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const back = `/env/${env.id}/settings#sources`;
    const f = await formData(c);
    const config = { service: f.get("service"), environment: f.get("environment") };
    const problem = apmServiceProblem(config.service, config.environment);
    if (problem) return redirectWith(c, back, { kind: "bad", text: problem });
    const reset = await rls(c, async (tx) => {
      const prev = parseApmConfig((await first<{ config: unknown }>(tx`select config from environment_sources where environment_id = ${env.id} and kind = 'apm'`))?.config);
      await tx`
        insert into environment_sources (environment_id, kind, config) values (${env.id}, 'apm', ${config}::jsonb)
        on conflict (environment_id, kind) where kind <> 'logs' do update set config = excluded.config`;
      // Another service: its existing errors come in as a silent backfill, not as a flood of events.
      const changed = !prev || prev.service !== config.service || prev.environment !== config.environment;
      if (changed) await tx`delete from error_poll_state where environment_id = ${env.id}`;
      return changed;
    });
    await audit(c, "source.saved", String(env.id), { kind: "apm", ...config, pollReset: reset });
    return redirectWith(c, back, { kind: "ok", text: "APM-Quelle gespeichert." });
  });

  app.post("/admin/env/:id/sources/:kind{apm|dependency_track|wazuh|ansible}/delete", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const kind = c.req.param("kind");
    const rows = await rls(c, async (tx) => {
      const deleted = await tx`delete from environment_sources where environment_id = ${env.id} and kind = ${kind} returning id`;
      if (kind === "apm") await tx`delete from error_poll_state where environment_id = ${env.id}`;
      return deleted;
    });
    if (!rows.length) return c.notFound();
    await audit(c, "source.deleted", String(env.id), { kind });
    const removed = {
      apm: "APM-Quelle entfernt.",
      dependency_track: "Dependency-Track-Zuordnung entfernt. Die gesammelten Schwachstellen löscht der Worker beim nächsten Lauf.",
      wazuh: "Wazuh-Zuordnung entfernt. Die gesammelten Schwachstellen löscht der Worker beim nächsten Lauf.",
      ansible: "Ansible-Zuordnung entfernt.",
    };
    return redirectWith(c, `/env/${env.id}/settings#sources`, { kind: "ok", text: removed[kind as keyof typeof removed] });
  });
}
