/**
 * Runners in the hub UI (design 6.7): Verwaltung → Runner (create, token shown once with the
 * install lines, new token, delete), the servers an environment's runner reads (environment
 * settings), and the environment's „Server“ tab with a page per server (level 2).
 */
import type { Context, Hono } from "hono";
import { newToken, sha256Hex } from "../../../shared/crypto";
import { DEFAULT_THRESHOLDS, formatKb, parseThresholds, THRESHOLD_FIELDS, worstOf, type CheckSeverity } from "../../../shared/hosts/evaluate";
import type { DiskReport, HostReport } from "../../../shared/hosts/report";
import { formData, parseId, redirectWith, showDialogStep } from "../../../shared/http";
import { SSH_TARGET } from "../../../shared/runner-protocol";
import { TimeChart, Trend, type TimePoint } from "../../../shared/ui/charts";
import { ActionButton, Ago, Badge, Card, ConfirmAction, CopyButton, DialogButton, Empty, Field, FormDialog, formatPercent, SecretBox, Stat, type Tone } from "../../../shared/ui/components";
import { Icon } from "../../../shared/ui/icons";
import { hubConfig } from "../../config";
import { all, first, rls } from "../../db";
import { audit, EnvShell, loadEnv, type EnvContext } from "../../ui";
import { AdminShell } from "../core/admin-shell";
import { registerSettingsSection } from "../core/registry";
import { bucketFor, parseRange, PRESETS, RangePicker, type Preset, type TimeRange } from "../es/range";
import { currentCpu, serverHistory, type ServerHistory } from "./metrics";
import { RUNNER_SILENT_MS, SERVER_SILENT_INTERVALS } from "./process";

const BASE = "/admin/runners";
export const RUNNER_IMAGE = "vantage-runner:latest";
const SEVERITY_TONE: Record<CheckSeverity, Tone> = { ok: "ok", warning: "warn", critical: "bad" };
const SEVERITY_LABEL: Record<CheckSeverity, string> = { ok: "in Ordnung", warning: "Warnung", critical: "kritisch" };
/** Where a runner without organisation belongs: Systaro's own network, for servers of every customer. */
export const SYSTEM_RUNNER_LABEL = "Systaro, für alle Kunden";
const SYSTEM_RUNNER_ENV = "/data/vantage/secrets/runner.env";

interface RunnerRow {
  id: number;
  name: string;
  organisation_id: number | null;
  org_name: string | null;
  last_seen_at: Date | null;
  version: string | null;
  ssh_public_key: string | null;
  silent_since: Date | null;
  revoked_at: Date | null;
  monitors: number;
  servers: number;
}

/** Runners an environment's monitors and servers may use: those of its organisation and Systaro's own. Runs inside rls(). */
export function runnersForOrg(tx: any, orgId: number) {
  return all<{ id: number; name: string; system: boolean }>(tx`
    select id, name, organisation_id is null as system from runners
    where (organisation_id = ${orgId} or organisation_id is null) and revoked_at is null order by organisation_id nulls last, name`);
}

export const runnerOptionLabel = (r: { name: string; system: boolean }) => `Runner „${r.name}“${r.system ? " (Systaro)" : ""}`;

function RunnerStatus(props: { r: Pick<RunnerRow, "last_seen_at" | "revoked_at"> }) {
  if (props.r.revoked_at) return <Badge tone="idle">gesperrt</Badge>;
  if (!props.r.last_seen_at) return <Badge tone="idle">noch nie verbunden</Badge>;
  return Date.now() - new Date(props.r.last_seen_at).getTime() < RUNNER_SILENT_MS
    ? <Badge tone="ok" dot>verbunden</Badge>
    : <Badge tone="bad" dot>meldet sich nicht</Badge>;
}

/** Shown once after creating a runner or replacing its token. */
function InstallStep(props: { token: string; system: boolean }) {
  const env = `VANTAGE_URL=${hubConfig.publicUrl}\nVANTAGE_RUNNER_TOKEN=${props.token}`;
  const run = `docker run -d --name vantage-runner --restart unless-stopped \\\n  --env-file runner.env -v vantage-runner:/data \\\n  ${RUNNER_IMAGE}`;
  if (props.system) return (
    <div class="stack">
      <p>Der Systaro-Runner läuft neben dem Hub (Compose-Dienst <code>runner</code>) und wird mit Vantage ausgeliefert.</p>
      <p class="small"><strong>1.</strong> Diesen Inhalt auf dem Host des Hubs als <code>{SYSTEM_RUNNER_ENV}</code> ablegen (Modus 600, wird nur jetzt angezeigt):</p>
      <div class="secret-row"><div class="secret multiline" id="runner-env">{env}</div><CopyButton target="runner-env" /></div>
      <p class="small"><strong>2.</strong> Der nächste Deploy (<code>deploy_production</code>) startet ihn; wer nicht warten will, startet den Job des letzten Release-Tags neu.</p>
      <p class="muted small">Seinen öffentlichen SSH-Schlüssel danach auf jedem Server hinterlegen, nur mit dem Forced Command des Agents (docs/self-hosting.md).</p>
    </div>
  );
  return (
    <div class="stack">
      <p>Auf einem Rechner im Netz des Kunden, der die zu prüfenden Dienste und Server erreicht und ausgehend <code>{new URL(hubConfig.publicUrl).host}</code> über HTTPS (443). Eingehend braucht der Runner nichts.</p>
      <p class="small"><strong>1.</strong> Datei <code>runner.env</code> anlegen (enthält das Token, wird nur jetzt angezeigt):</p>
      <div class="secret-row"><div class="secret multiline" id="runner-env">{env}</div><CopyButton target="runner-env" /></div>
      <p class="small"><strong>2.</strong> Mit einem Deploy-Token der Registry (<code>read_registry</code>) anmelden und starten:</p>
      <div class="secret-row"><pre id="runner-run">{run}</pre><CopyButton target="runner-run" /></div>
      <p class="muted small">Beim ersten Start legt der Runner einen SSH-Schlüssel an. Sein öffentlicher Teil erscheint danach auf dieser Seite und kommt auf die Server, die der Runner lesen soll.</p>
    </div>
  );
}

async function RunnersPage(c: Context) {
  const data = await rls(c, async (tx) => ({
    runners: await all<RunnerRow>(tx`
      select r.id, r.name, r.organisation_id, o.name as org_name, r.last_seen_at, r.version, r.ssh_public_key, r.silent_since, r.revoked_at,
             (select count(*)::int from monitors m where m.runner_id = r.id) as monitors,
             (select count(*)::int from servers s where s.runner_id = r.id) as servers
      from runners r left join organisations o on o.id = r.organisation_id order by o.name nulls first, r.name`),
    orgs: await all<{ id: number; name: string }>(tx`select id, name from organisations order by name`),
  }));
  const create = (primary: boolean) => <DialogButton dialog="new-runner" icon="plus" class={primary ? "primary" : "small"}>Runner anlegen</DialogButton>;
  return c.html(
    <AdminShell c={c} tab="runners" title="Runner" actions={data.runners.length > 0 && create(false)}>
      <Card flush>
        {data.runners.length === 0 ? (
          <Empty title="Noch keine Runner" icon="network" action={create(true)}>
            Er braucht einen Rechner mit Docker im Netz des Kunden und eine ausgehende HTTPS-Verbindung zu Vantage, sonst nichts.
          </Empty>
        ) : (
          <div class="table-wrap"><table>
            <thead><tr><th>Runner</th><th>Status</th><th class="num">Monitore</th><th class="num">Server</th><th></th></tr></thead>
            <tbody>{data.runners.map((r) => (
              <tr>
                <td><span class="cell-title">{r.name}</span><span class="cell-sub">{r.org_name ?? SYSTEM_RUNNER_LABEL}</span></td>
                <td>
                  <RunnerStatus r={r} />
                  {r.last_seen_at && <span class="cell-sub">zuletzt <Ago at={r.last_seen_at} />{r.version && <> · Version <span class="mono">{r.version}</span></>}</span>}
                </td>
                <td class="num">{r.monitors}</td>
                <td class="num">{r.servers}</td>
                <td class="right">
                  <div class="btn-group">
                    <DialogButton dialog={`runner-token-${r.id}`} icon="key-round" class="small">Neues Token</DialogButton>
                    <ConfirmAction action={`${BASE}/${r.id}/delete`} label="Löschen"
                      question={`Runner „${r.name}“ löschen? Seine ${r.servers} Server werden mit ihren Werten gelöscht.${r.monitors ? " Erst die Monitore auf einen anderen Runner oder auf Vantage umstellen." : ""}`} />
                  </div>
                  <FormDialog id={`runner-token-${r.id}`} title={`Neues Token für „${r.name}“`} icon="key-round" action={`${BASE}/${r.id}/token`} submitLabel="Neues Token erzeugen" danger wide>
                    <p>Das bisherige Token wird sofort ungültig. Bis der Runner das neue bekommt, prüft er nichts mehr und meldet sich nach drei Minuten als still.</p>
                  </FormDialog>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {data.runners.some((r) => r.ssh_public_key) && (
        <Card title="SSH-Schlüssel" description="Mit diesem Schlüssel meldet sich ein Runner auf den Servern an, die er liest: in die authorized_keys des Benutzers aus dem SSH-Ziel eintragen. Der private Teil verlässt den Runner nie.">
          <div class="stack">
            {data.runners.filter((r) => r.ssh_public_key).map((r) => (
              <div class="field">
                <span class="label">{r.name} <span class="muted">· {r.org_name ?? SYSTEM_RUNNER_LABEL}</span></span>
                <div class="secret-row"><div class="secret" id={`runner-key-${r.id}`}>{r.ssh_public_key}</div><CopyButton target={`runner-key-${r.id}`} /></div>
              </div>
            ))}
          </div>
        </Card>
      )}
      <FormDialog id="new-runner" title="Runner anlegen" icon="network" action={BASE} submitLabel="Anlegen" wide
        description="Ein Runner gehört zu einem Kunden. Monitore und Server von dessen Umgebungen lassen sich ihm zuweisen. Ein Systaro-Runner läuft in unserem Netz und darf Server aller Kunden lesen; nie für einen Rechner beim Kunden wählen.">
        <Field label="Name" for="runner-name" hint="z. B. Rechenzentrum Nordwind"><input id="runner-name" name="name" type="text" required maxlength={100} /></Field>
        <Field label="Kunde" for="runner-org">
          <select id="runner-org" name="organisation_id" required>
            {data.orgs.map((o) => <option value={String(o.id)}>{o.name}</option>)}
            <option value="system">{SYSTEM_RUNNER_LABEL}</option>
          </select>
        </Field>
      </FormDialog>
    </AdminShell>,
  );
}

// ── Servers of an environment ───────────────────────────────────────────────────────────────────

interface ServerRow {
  id: number;
  name: string;
  ssh_target: string;
  runner_id: number;
  runner_name: string;
  interval_seconds: number;
  thresholds: Record<string, number>;
  enabled: boolean;
  last_report_at: Date | null;
  last_error: string | null;
}

function ServerFields(props: { s?: ServerRow; runners: { id: number; name: string; system: boolean }[] }) {
  const id = (n: string) => `server-${props.s?.id ?? "new"}-${n}`;
  return (
    <>
      <div class="fields">
        <Field label="Name" for={id("name")}><input id={id("name")} name="name" type="text" required maxlength={100} value={props.s?.name ?? ""} placeholder="app-01" /></Field>
        <Field label="SSH-Ziel" for={id("target")} hint="benutzer@host, so wie der Runner den Server erreicht">
          <input id={id("target")} name="ssh_target" type="text" required autocomplete="off" spellcheck={false} value={props.s?.ssh_target ?? ""} placeholder="vantage@10.0.4.12" />
        </Field>
      </div>
      <div class="fields">
        <Field label="Runner" for={id("runner")}>
          <select id={id("runner")} name="runner_id">{props.runners.map((r) => <option value={String(r.id)} selected={props.s?.runner_id === r.id}>{runnerOptionLabel(r)}</option>)}</select>
        </Field>
        <Field label="Intervall (min)" for={id("interval")}><input id={id("interval")} name="interval_minutes" type="number" min="1" max="1440" value={String((props.s?.interval_seconds ?? 300) / 60)} /></Field>
      </div>
      <details class="disclosure">
        <summary>Schwellen</summary>
        <div class="fields">
          {THRESHOLD_FIELDS.map((f) => (
            <Field label={`${f.label}${f.unit ? ` (${f.unit})` : ""}`} for={id(f.key)}>
              <input id={id(f.key)} name={f.key} type="text" inputmode="decimal" value={props.s?.thresholds?.[f.key] !== undefined ? String(props.s.thresholds[f.key]) : ""} placeholder={String(DEFAULT_THRESHOLDS[f.key])} />
            </Field>
          ))}
        </div>
        <p class="muted small">Leer heißt Standard. Die Last zählt je Prozessorkern (5-Minuten-Mittel).</p>
      </details>
    </>
  );
}

async function ServersSection(c: Context, env: EnvContext) {
  const data = await rls(c, async (tx) => ({
    servers: await all<ServerRow>(tx`
      select s.id, s.name, s.ssh_target, s.runner_id, r.name as runner_name, s.interval_seconds, s.thresholds, s.enabled, s.last_report_at, s.last_error
      from servers s join runners r on r.id = s.runner_id where s.environment_id = ${env.id} order by s.name`),
    runners: await runnersForOrg(tx, env.orgId),
  }));
  const base = `/admin/env/${env.id}/servers`;
  const add = (primary: boolean) => <DialogButton dialog="new-server" icon="plus" class={primary ? "primary" : "small"}>Server anlegen</DialogButton>;
  return (
    <Card title="Server" id="servers" description="Server, deren Festplatten, Speicher, Last, systemd-Units und Container ein Runner per SSH liest."
      actions={data.servers.length > 0 && data.runners.length > 0 && add(false)} flush={data.servers.length > 0}>
      {data.runners.length === 0 ? (
        <Empty title="Kein Runner für diesen Kunden" icon="network" action={<a class="btn small" href={BASE}>Runner anlegen</a>}>
          Server werden über einen Runner im Netz des Kunden gelesen. {env.orgName} hat noch keinen.
        </Empty>
      ) : data.servers.length === 0 ? (
        <Empty title="Noch keine Server" icon="server" action={add(true)}>Der Runner liest sie per SSH mit dem Host-Agenten von Vantage, ohne etwas zu installieren.</Empty>
      ) : (
        <div class="table-wrap"><table>
          <thead><tr><th>Server</th><th>Runner</th><th>Intervall</th><th>Zuletzt gelesen</th><th></th></tr></thead>
          <tbody>{data.servers.map((s) => (
            <tr>
              <td><span class="cell-title">{s.name}</span><span class="cell-sub mono">{s.ssh_target}</span></td>
              <td>{s.runner_name}</td>
              <td class="nowrap">{s.interval_seconds / 60} min</td>
              <td>{s.last_report_at ? <Ago at={s.last_report_at} /> : <span class="muted">noch nie</span>}{s.last_error && <span class="cell-sub status-bad">{s.last_error}</span>}</td>
              <td class="right">
                <div class="btn-group">
                  <DialogButton dialog={`edit-server-${s.id}`} icon="pencil" class="small">Bearbeiten</DialogButton>
                  <ActionButton action={`${base}/${s.id}`} label={s.enabled ? "Pausieren" : "Fortsetzen"} icon={s.enabled ? "pause" : "play"} small fields={{ action: "toggle" }} />
                  <ConfirmAction action={`${base}/${s.id}`} label="Löschen" question={`Server „${s.name}“ mit allen Werten löschen?`} fields={{ action: "delete" }} />
                </div>
                <FormDialog id={`edit-server-${s.id}`} title={`„${s.name}“ bearbeiten`} icon="pencil" action={`${base}/${s.id}`} submitLabel="Speichern" wide>
                  <ServerFields s={s} runners={data.runners} />
                </FormDialog>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {data.runners.length > 0 && (
        <FormDialog id="new-server" title="Server anlegen" icon="server" action={base} submitLabel="Anlegen" wide
          description="Der Runner meldet sich per SSH mit seinem eigenen Schlüssel an (Verwaltung → Runner). Ein Benutzer ohne Root-Rechte genügt; für Docker braucht er die Gruppe docker.">
          <ServerFields runners={data.runners} />
        </FormDialog>
      )}
    </Card>
  );
}

type ServerForm = { name: string; ssh_target: string; runner_id: number; interval_seconds: number; thresholds: Record<string, number> };

function parseServerForm(f: { get(k: string): string }, runners: { id: number }[]): ServerForm | { error: string } {
  const name = f.get("name");
  if (!name || name.length > 100) return { error: "Der Name fehlt oder ist zu lang." };
  const target = f.get("ssh_target");
  if (!SSH_TARGET.test(target)) return { error: "SSH-Ziel als benutzer@host oder host angeben (ohne Port, ohne Leerzeichen)." };
  const runnerId = Number(f.get("runner_id"));
  if (!runners.some((r) => r.id === runnerId)) return { error: "Diesen Runner gibt es für den Kunden nicht." };
  const minutes = Number(f.get("interval_minutes") || "5");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return { error: "Das Intervall ist eine ganze Zahl von Minuten, 1 bis 1440." };
  const t = parseThresholds(Object.fromEntries(THRESHOLD_FIELDS.map((x) => [x.key, f.get(x.key)])));
  if (!t.ok) return { error: t.error };
  return { name, ssh_target: target, runner_id: runnerId, interval_seconds: Math.max(60, minutes * 60), thresholds: t.thresholds as Record<string, number> };
}

// ── Server tab (level 2) ────────────────────────────────────────────────────────────────────────

export interface ServerStatus {
  id: number;
  name: string;
  enabled: boolean;
  interval_seconds: number;
  last_report_at: Date | null;
  last_error: string | null;
  checks: { key: string; label: string; severity: CheckSeverity; value: number | null; detail: string; since: Date }[];
  /** Average CPU usage between the two newest reports; null while the agent sends no CPU counters. */
  cpu_pct: number | null;
  /** Memory and filesystems of the newest accepted report, for the free space beside the percentages. */
  memory: HostReport["memory"];
  disks: DiskReport[];
}

/** Servers of an environment (or the one `only`) with their current checks; runs inside rls() (level 2). */
export async function serverStatuses(tx: any, envId: number, only?: number): Promise<ServerStatus[]> {
  const servers = await all<Omit<ServerStatus, "checks" | "cpu_pct">>(tx`
    select s.id, s.name, s.enabled, s.interval_seconds, s.last_report_at, s.last_error,
           r.report->'memory' as memory, coalesce(r.report->'disks', '[]') as disks
    from servers s left join lateral (
      select report from server_reports where server_id = s.id and results is not null order by at desc limit 1
    ) r on true
    where s.environment_id = ${envId} and (${only ?? null}::int is null or s.id = ${only ?? null}) order by s.name`);
  const checks = await all<any>(tx`
    select server_id, check_key as key, label, severity, value, detail, since from server_checks where environment_id = ${envId}
    order by array_position(array['critical', 'warning', 'ok'], severity), check_key`);
  const cpu = await currentCpu(tx, envId);
  return servers.map((s) => ({ ...s, checks: checks.filter((k) => k.server_id === s.id).map(({ server_id, ...k }) => k), cpu_pct: cpu.get(s.id) ?? null }));
}

/** No report for three intervals: the values shown are old. */
export const serverStale = (s: Pick<ServerStatus, "last_report_at" | "interval_seconds">) =>
  !s.last_report_at || Date.now() - new Date(s.last_report_at).getTime() > s.interval_seconds * 1000 * SERVER_SILENT_INTERVALS;

const VALUE_TONE: Record<CheckSeverity, "warn" | "bad" | undefined> = { ok: undefined, warning: "warn", critical: "bad" };
const STATUS_CLASS: Record<CheckSeverity, string> = { ok: "", warning: "status-warn", critical: "status-bad" };
/** Percentages as the reader says them: "42 %", below ten with one decimal ("4,3 %"). */
const pct = (v: number) => formatPercent(v, v > 0 && v < 10 ? 1 : 0);
const perCore = (v: number) => v.toFixed(2).replace(".", ",");
const diskMount = (key: string) => key.slice("disk:".length);
const byMount = (a: { key: string }, b: { key: string }) => (diskMount(a.key) === "/" ? -1 : diskMount(b.key) === "/" ? 1 : a.key.localeCompare(b.key));

function StateBadge(props: { s: ServerStatus }) {
  const s = props.s;
  if (!s.enabled) return <Badge tone="idle">pausiert</Badge>;
  if (s.checks.length === 0) return <Badge tone="idle">noch keine Werte</Badge>;
  const worst = worstOf(s.checks);
  return <Badge tone={SEVERITY_TONE[worst]} dot>{SEVERITY_LABEL[worst]}</Badge>;
}

/** Name, state and when it was read; on the tab the name and „Verlauf“ lead to the server page. */
function ServerHead(props: { s: ServerStatus; href?: string }) {
  const s = props.s;
  const stale = s.enabled && serverStale(s);
  const minutes = Math.round(s.interval_seconds / 60);
  return (
    <div class="server-head">
      <h2 class="row">{props.href ? <a class="link-quiet" href={props.href}>{s.name}</a> : s.name}<StateBadge s={s} /></h2>
      <span class={`small ${stale ? "status-warn" : "muted"}`}>
        {s.last_report_at ? <>zuletzt gelesen <Ago at={s.last_report_at} /></> : "noch nie gelesen"}, liest alle {minutes === 1 ? "Minute" : `${minutes} Minuten`}
        {stale && s.last_report_at && ", keine aktuellen Werte"}
      </span>
      {props.href && <a class="btn" href={props.href}><Icon name="activity" />Verlauf</a>}
    </div>
  );
}

/**
 * The figures that matter at a glance, as big tiles: CPU (load per core while the agent sends no CPU
 * time), memory and every filesystem, with the free space below the percentage. On the tab each tile
 * also shows its last 24 hours and links to the server page.
 */
function ServerTiles(props: { s: ServerStatus; hasCpu: boolean; day?: { history: ServerHistory; bucketMs: number; href: string } }) {
  const { s, day } = props;
  const load = s.checks.find((k) => k.key === "load");
  const memory = s.checks.find((k) => k.key === "memory");
  const disks = s.checks.filter((k) => k.key.startsWith("disk:") && k.value !== null).sort(byMount);
  const trend = (points: TimePoint[] | undefined, label: string, format: (v: number) => string, max: number, severity: CheckSeverity = "ok") =>
    day && points && <Trend points={points} bucketMs={day.bucketMs} max={max} format={format} label={`${label}, letzte 24 Stunden`} tone={VALUE_TONE[severity]} />;
  const loadHint = load?.value != null ? `Last ${perCore(load.value)} je Kern` : undefined;
  return (
    <div class="grid grid-4">
      {s.cpu_pct !== null || props.hasCpu ? (
        <Stat label="CPU" value={s.cpu_pct !== null ? pct(s.cpu_pct) : "–"} hint={loadHint} href={day?.href}>
          {trend(day?.history.cpu, "CPU-Auslastung", pct, 100)}
        </Stat>
      ) : load?.value != null && (
        <Stat label="Last je Kern" value={perCore(load.value)} tone={VALUE_TONE[load.severity]} hint="CPU-Auslastung kommt mit dem neuen Agent" href={day?.href}>
          {trend(day?.history.load, "Last je Kern", perCore, 1, load.severity)}
        </Stat>
      )}
      {memory?.value != null && (
        <Stat label="Arbeitsspeicher" value={pct(memory.value)} tone={VALUE_TONE[memory.severity]} href={day?.href}
          hint={s.memory ? `${formatKb(s.memory.available_kb)} verfügbar von ${formatKb(s.memory.total_kb)}` : undefined}>
          {trend(day?.history.memory, "Arbeitsspeicher", pct, 100, memory.severity)}
        </Stat>
      )}
      {disks.map((k) => {
        const mount = diskMount(k.key);
        const d = s.disks.find((x) => x.mount === mount);
        return (
          <Stat label={`Festplatte ${mount}`} value={pct(k.value!)} tone={VALUE_TONE[k.severity]} href={day?.href}
            hint={d ? `${formatKb(d.avail_kb)} frei von ${formatKb(d.size_kb)}` : undefined}>
            {trend(day?.history.disks.find((x) => x.mount === mount)?.points, `Festplatte ${mount}`, pct, 100, k.severity)}
          </Stat>
        );
      })}
    </div>
  );
}

/** One server on the „Server“ tab: head, what is wrong, and its tiles with the last 24 hours. */
function ServerSection(props: { envId: number; s: ServerStatus; history: ServerHistory; bucketMs: number }) {
  const { s } = props;
  const href = `/env/${props.envId}/servers/${s.id}`;
  const problems = s.checks.filter((k) => k.severity !== "ok");
  return (
    <section class="server-section stack-sm">
      <ServerHead s={s} href={href} />
      {problems.length > 0 && (
        <ul class="server-checks">
          {problems.map((k) => <li><span class={STATUS_CLASS[k.severity]}>{k.label}</span> <span class="small">{k.detail}</span></li>)}
        </ul>
      )}
      {s.last_error && <p class="small status-bad">{s.last_error}</p>}
      {s.checks.length > 0 && <ServerTiles s={s} hasCpu={props.history.hasCpu} day={{ history: props.history, bucketMs: props.bucketMs, href }} />}
    </section>
  );
}

/** The spans a server's history can be read over (server page and agent tool). */
export const SERVER_PRESETS: Preset[] = [...PRESETS.filter((p) => p.key === "24h" || p.key === "7d"), { key: "30d", label: "30 Tage", ms: 30 * 24 * 3600_000 }];

/** One server: every check with its value, and its readings over time. */
function ServerPage(props: { c: Context; env: EnvContext; s: ServerStatus; range: TimeRange; problem: string | null; bucketMs: number; history: ServerHistory }) {
  const { env, s, range, history, bucketMs } = props;
  const base = `/env/${env.id}/servers/${s.id}`;
  const chart = (title: string, points: TimePoint[], format: (v: number) => string, minTop: number) => (
    <Card title={title}><TimeChart kind="line" label={title} bucketMs={bucketMs} format={format} minTop={minTop} points={points} /></Card>
  );
  return (
    <EnvShell c={props.c} env={env} tab="servers" title={`${s.name} – Server`}>
      <div class="stack">
        <p class="small"><a href={`/env/${env.id}/servers`}>← Alle Server</a></p>
        <ServerHead s={s} />
        {s.last_error && <p class="small status-bad">{s.last_error}</p>}
        {s.checks.length > 0 && <ServerTiles s={s} hasCpu={history.hasCpu} />}
        <Card title="Prüfungen" flush>
          {s.checks.length === 0 ? (
            <Empty title="Noch keine Werte" icon="server">Der Runner hat diesen Server noch nicht gelesen.</Empty>
          ) : (
            <div class="table-wrap"><table>
              <thead><tr><th>Prüfung</th><th>Zustand</th><th>Wert</th><th>Seit</th></tr></thead>
              <tbody>{s.checks.map((k) => (
                <tr>
                  <td class="nowrap"><span class="cell-title">{k.label}</span></td>
                  <td><Badge tone={SEVERITY_TONE[k.severity]} dot>{SEVERITY_LABEL[k.severity]}</Badge></td>
                  <td class="small">{k.detail}</td>
                  <td class="nowrap small"><Ago at={k.since} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <div class="toolbar">
          <RangePicker base={base} range={range} presets={SERVER_PRESETS} />
          {props.problem && <span class="small status-bad">{props.problem}</span>}
        </div>
        {history.hasCpu
          ? chart("CPU-Auslastung", history.cpu, pct, 100)
          : <Card title="CPU-Auslastung"><p class="muted small">Der Agent auf diesem Server meldet noch keine CPU-Zeit, nur die Last. Mit dem aktuellen Agent erscheint hier die Auslastung.</p></Card>}
        {chart("Last je Kern", history.load, perCore, 1)}
        {chart("Arbeitsspeicher", history.memory, pct, 100)}
        {history.disks.map((d) => chart(`Festplatte ${d.mount}`, d.points, pct, 100))}
      </div>
    </EnvShell>
  );
}

let registered = false;

export function mountRunners(app: Hono) {
  if (!registered) {
    registerSettingsSection(25, ServersSection);
    registered = true;
  }

  app.get(BASE, (c) => RunnersPage(c));

  app.get("/env/:id/servers", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 2);
    if (!env) return c.notFound();
    const { range: day } = parseRange(() => undefined, { fallback: "24h" });
    const servers = await rls(c, async (tx) => {
      const out: { s: ServerStatus; history: ServerHistory; bucketMs: number }[] = [];
      for (const s of await serverStatuses(tx, env.id)) {
        const bucketMs = bucketFor(day, 48, s.interval_seconds * 1000);
        out.push({ s, bucketMs, history: await serverHistory(tx, s, day.from, day.to, bucketMs) });
      }
      return out;
    });
    return c.html(
      <EnvShell c={c} env={env} tab="servers" title="Server">
        <div class="stack" hx-get={`/env/${env.id}/servers`} hx-trigger="every 30s" hx-select="#servers-live" hx-target="#servers-live" hx-swap="outerHTML">
          <div id="servers-live" class="stack">
            {servers.length === 0 ? (
              <Card title="Server" flush>
                <Empty title="Keine Server" icon="server">{c.get("user").isAdmin ? <a href={`/env/${env.id}/settings#servers`}>In den Einstellungen anlegen</a> : "Systaro liest für diese Umgebung noch keine Server."}</Empty>
              </Card>
            ) : (
              <>
                {servers.map((x) => <ServerSection envId={env.id} {...x} />)}
                <p class="muted small">Per SSH von einem Runner gelesen. CPU ist die mittlere Auslastung zwischen zwei Lesungen, die Linien zeigen die letzten 24 Stunden.</p>
              </>
            )}
          </div>
        </div>
      </EnvShell>,
    );
  });

  app.get("/env/:id/servers/:serverId", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 2);
    const serverId = parseId(c.req.param("serverId"));
    if (!env || !serverId) return c.notFound();
    const { range, problem } = parseRange((k) => c.req.query(k), { fallback: "24h", presets: SERVER_PRESETS });
    const data = await rls(c, async (tx) => {
      const [s] = await serverStatuses(tx, env.id, serverId);
      if (!s) return null;
      // At least one report per bucket, else the line would break between every two of them.
      const bucketMs = bucketFor(range, 150, s.interval_seconds * 1000);
      return { s, bucketMs, history: await serverHistory(tx, s, range.from, range.to, bucketMs) };
    });
    if (!data) return c.notFound();
    return c.html(<ServerPage c={c} env={env} range={range} problem={problem} {...data} />);
  });

  app.post(BASE, async (c) => {
    const f = await formData(c);
    const name = f.get("name");
    const system = f.get("organisation_id") === "system";
    const orgId = system ? null : parseId(f.get("organisation_id"));
    if (!name || name.length > 100 || (!system && !orgId)) return redirectWith(c, BASE, { kind: "bad", text: "Name und Kunde angeben." });
    const token = newToken("vrn");
    const row = await rls(c, async (tx) => {
      if (await first(tx`select 1 from runners where organisation_id is not distinct from ${orgId} and name = ${name}`)) return null;
      return first<{ id: number }>(tx`insert into runners (organisation_id, name, token_hash, token_prefix, created_by)
                                      values (${orgId}, ${name}, ${sha256Hex(token)}, ${token.slice(0, 8)}, ${c.get("user").id}) returning id`);
    });
    if (!row) return redirectWith(c, BASE, { kind: "bad", text: "Diesen Namen hat bei dem Kunden schon ein Runner." });
    await audit(c, "runner.created", String(row.id), { organisation_id: orgId, name });
    return showDialogStep(c, { title: `Runner „${name}“ angelegt`, icon: "network", body: <InstallStep token={token} system={system} /> });
  });

  app.post(`${BASE}/:id/token`, async (c) => {
    const id = parseId(c.req.param("id")) ?? 0;
    const token = newToken("vrn");
    const row = await rls(c, (tx) => first<{ name: string; system: boolean }>(tx`
      update runners set token_hash = ${sha256Hex(token)}, token_prefix = ${token.slice(0, 8)}, revoked_at = null where id = ${id}
      returning name, organisation_id is null as system`));
    if (!row) return c.notFound();
    await audit(c, "runner.token_replaced", String(id));
    return showDialogStep(c, { title: `Neues Token für „${row.name}“`, icon: "key-round", body: <InstallStep token={token} system={row.system} /> });
  });

  app.post(`${BASE}/:id/delete`, async (c) => {
    const id = parseId(c.req.param("id")) ?? 0;
    const result = await rls(c, async (tx) => {
      const r = await first<{ name: string; monitors: number }>(tx`
        select name, (select count(*)::int from monitors m where m.runner_id = runners.id) as monitors from runners where id = ${id}`);
      if (!r) return null;
      if (r.monitors > 0) return { ...r, deleted: false };
      await tx`delete from runners where id = ${id}`;
      return { ...r, deleted: true };
    });
    if (!result) return c.notFound();
    if (!result.deleted) return redirectWith(c, BASE, { kind: "bad", text: `„${result.name}“ prüft noch ${result.monitors} Monitore. Erst die Monitore umstellen.` });
    await audit(c, "runner.deleted", String(id), { name: result.name });
    return redirectWith(c, BASE, { kind: "ok", text: `Runner „${result.name}“ gelöscht.` });
  });

  app.post("/admin/env/:id/servers", async (c) => {
    const envId = parseId(c.req.param("id")) ?? 0;
    const back = `/env/${envId}/settings#servers`;
    const f = await formData(c);
    const result = await rls(c, async (tx) => {
      const env = await first<{ org_id: number }>(tx`select p.organisation_id as org_id from environments e join projects p on p.id = e.project_id where e.id = ${envId}`);
      if (!env) return null;
      const parsed = parseServerForm(f, await runnersForOrg(tx, env.org_id));
      if ("error" in parsed) return parsed;
      if (await first(tx`select 1 from servers where environment_id = ${envId} and name = ${parsed.name}`)) return { error: "Einen Server mit diesem Namen gibt es hier schon." };
      return first<{ id: number }>(tx`insert into servers (environment_id, runner_id, name, ssh_target, interval_seconds, thresholds)
        values (${envId}, ${parsed.runner_id}, ${parsed.name}, ${parsed.ssh_target}, ${parsed.interval_seconds}, ${parsed.thresholds}::jsonb) returning id`);
    });
    if (!result) return c.notFound();
    if ("error" in result) return redirectWith(c, back, { kind: "bad", text: result.error });
    await audit(c, "server.created", String(result.id), { environment_id: envId });
    return redirectWith(c, back, { kind: "ok", text: "Server angelegt. Der Runner liest ihn nach seiner nächsten Abfrage, spätestens in einer Minute." });
  });

  app.post("/admin/env/:id/servers/:serverId", async (c) => {
    const envId = parseId(c.req.param("id")) ?? 0;
    const serverId = parseId(c.req.param("serverId")) ?? 0;
    const back = `/env/${envId}/settings#servers`;
    const f = await formData(c);
    const action = f.get("action");
    const result = await rls(c, async (tx) => {
      const env = await first<{ org_id: number }>(tx`select p.organisation_id as org_id from environments e join projects p on p.id = e.project_id where e.id = ${envId}`);
      const server = await first<{ id: number }>(tx`select id from servers where id = ${serverId} and environment_id = ${envId}`);
      if (!env || !server) return null;
      if (action === "toggle") return tx`update servers set enabled = not enabled, silent_since = null where id = ${serverId}`.then(() => ({ text: "Gespeichert." }));
      if (action === "delete") return tx`delete from servers where id = ${serverId}`.then(() => ({ text: "Server gelöscht." }));
      const parsed = parseServerForm(f, await runnersForOrg(tx, env.org_id));
      if ("error" in parsed) return parsed;
      if (await first(tx`select 1 from servers where environment_id = ${envId} and name = ${parsed.name} and id <> ${serverId}`)) return { error: "Einen Server mit diesem Namen gibt es hier schon." };
      await tx`update servers set name = ${parsed.name}, ssh_target = ${parsed.ssh_target}, runner_id = ${parsed.runner_id},
                 interval_seconds = ${parsed.interval_seconds}, thresholds = ${parsed.thresholds}::jsonb where id = ${serverId}`;
      return { text: "Server gespeichert." };
    });
    if (!result) return c.notFound();
    if ("error" in result) return redirectWith(c, back, { kind: "bad", text: result.error });
    await audit(c, action === "toggle" ? "server.toggled" : action === "delete" ? "server.deleted" : "server.updated", String(serverId));
    return redirectWith(c, back, { kind: "ok", text: result.text });
  });
}

