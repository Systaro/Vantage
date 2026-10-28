import type { Context, Hono } from "hono";
import { formData, parseId, redirectWith } from "../../../shared/http";
import { Sparkline } from "../../../shared/ui/charts";
import { ActionButton, Ago, Badge, Card, Empty, formatDate, formatNumber, type Tone } from "../../../shared/ui/components";
import { all, first, rls } from "../../db";
import { audit, EnvShell, loadEnv, type EnvContext } from "../../ui";
import { TimeChart } from "../../../shared/ui/charts";
import { parseTraceId } from "../apm/query";
import { apmEs, esProblem, logsEs } from "../es/client";
import { parseRange, PRESETS, RangePicker, withParams } from "../es/range";
import { buildLogEntryLookup, sourceOf, toLogEntry, type LogEntry } from "../logs/query";
import { entrySourceName, LogEntryView } from "../logs/routes";
import type { ApmSource, NamedLogsSource } from "../sources/config";
import { loadApmSource, loadLogsSources } from "../sources/store";
import { suggestPattern } from "./ignore-rules";
import { buildNewestOccurrenceSearch, buildOccurrencesSearch, buildSparklineSearch, errorTitle } from "./query";
import { IgnoreRulesCard, IgnoreSimilarButton, RuleDialog, selectRules } from "./rules";

const STATUSES = ["open", "resolved", "ignored"] as const;
type Status = (typeof STATUSES)[number];
const STATUS_LABEL: Record<Status, string> = { open: "Offen", resolved: "Erledigt", ignored: "Ignoriert" };
const STATUS_TONE: Record<Status, Tone> = { open: "warn", resolved: "ok", ignored: "idle" };
const STATUS_DONE: Record<Status, string> = { open: "Wieder geöffnet.", resolved: "Als erledigt markiert.", ignored: "Wird ab jetzt ignoriert." };
const LIST_LIMIT = 200;
const DETAIL_PRESETS = PRESETS.filter((p) => p.key === "24h" || p.key === "7d");

const asStatus = (v: string | undefined): Status | null => (STATUSES as readonly string[]).includes(v ?? "") ? (v as Status) : null;

interface GroupRow {
  id: number;
  grouping_key: string;
  source: "apm" | "logs";
  sample_entry_id: string | null;
  exception_type: string | null;
  message: string | null;
  culprit: string | null;
  handled: boolean | null;
  first_seen_at: Date;
  last_seen_at: Date;
  occurrences: number;
  status: Status;
  status_changed_at: Date | null;
}

interface ErrorsContext {
  env: EnvContext;
  apm: ApmSource | null;
  logs: NamedLogsSource[];
}

/** Error groups come from APM, from the ERROR entries of the logs, or both. */
async function errorsContext(c: Context): Promise<ErrorsContext | null> {
  const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 2);
  if (!env) return null;
  const [apm, logs] = await Promise.all([loadApmSource(c, env.id), loadLogsSources(c, env.id)]);
  return apm || logs.length ? { env, apm, logs } : null;
}

function sourcesText(ctx: ErrorsContext): string {
  const fromLogs = ctx.logs.some((s) => s.errorGroups !== false);
  if (ctx.apm && fromLogs) return "Fehlergruppen aus APM und aus den ERROR-Einträgen der Logs, jede Minute aktualisiert";
  if (fromLogs) return "Fehlergruppen aus den ERROR-Einträgen der Logs, jede Minute aktualisiert";
  if (ctx.apm) return "Fehlergruppen aus APM, jede Minute aktualisiert";
  return "Fehlergruppen aus den Logs sind für diese Umgebung ausgeschaltet (Einstellungen › Datenquellen)";
}

function TriageButtons(props: { env: EnvContext; group: GroupRow; back: "list" | "detail" }) {
  const action = `/env/${props.env.id}/errors/${props.group.id}/status`;
  const fields = { back: props.back, from: props.group.status };
  if (props.group.status === "open") {
    return (
      <span class="btn-group">
        <ActionButton action={action} label="Erledigt" icon="check" small fields={{ ...fields, status: "resolved" }} />
        <ActionButton action={action} label="Ignorieren" icon="circle-dashed" small fields={{ ...fields, status: "ignored" }} />
      </span>
    );
  }
  return <ActionButton action={action} label="Wieder öffnen" icon="refresh-cw" small fields={{ ...fields, status: "open" }} />;
}

async function sparklines(source: ApmSource, keys: string[]): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (keys.length === 0) return map;
  try {
    const { index, body } = buildSparklineSearch(source, keys);
    const res = await apmEs.search(index, body);
    for (const b of res.aggregations?.groups?.buckets ?? []) {
      map.set(String(b.key), (b.hours?.buckets ?? []).map((h: any) => h.doc_count as number));
    }
  } catch (err) {
    // Sparklines are decoration: the list stays usable without them.
    console.warn(`[hub] errors sparklines: ${esProblem(err)}`);
  }
  return map;
}

interface Frame {
  filename?: string;
  abs_path?: string;
  classname?: string;
  module?: string;
  function?: string;
  line?: { number?: number };
  library_frame?: boolean;
}

function frameLabel(f: Frame): string {
  const fn = [f.classname, f.function].filter(Boolean).join(".");
  return fn || f.module || "(unbekannt)";
}

function frameWhere(f: Frame): string {
  const file = f.filename ?? f.abs_path ?? "";
  return file ? `${file}${f.line?.number ? `:${f.line.number}` : ""}` : "";
}

/** Application frames stay visible; runs of library frames collapse into one disclosure. */
function Frames(props: { frames: Frame[] }) {
  const groups: { lib: boolean; frames: Frame[] }[] = [];
  for (const f of props.frames.slice(0, 300)) {
    const lib = f.library_frame === true;
    const last = groups.at(-1);
    if (last && last.lib === lib) last.frames.push(f);
    else groups.push({ lib, frames: [f] });
  }
  const FrameItem = (p: { f: Frame }) => (
    <li class={p.f.library_frame ? "frame lib" : "frame"}>
      <code>{frameLabel(p.f)}</code> <span class="muted">{frameWhere(p.f)}</span>
    </li>
  );
  return (
    <ol class="frames">
      {groups.map((g) =>
        g.lib ? (
          <li class="frame-group">
            <details>
              <summary>{g.frames.length} {g.frames.length === 1 ? "Bibliotheks-Frame" : "Bibliotheks-Frames"}</summary>
              <ol class="frames">{g.frames.map((f) => <FrameItem f={f} />)}</ol>
            </details>
          </li>
        ) : (
          g.frames.map((f) => <FrameItem f={f} />)
        ),
      )}
    </ol>
  );
}

function Occurrence(props: { env: EnvContext; doc: any }) {
  const d = props.doc;
  const exceptions: any[] = Array.isArray(d?.error?.exception) ? d.error.exception : d?.error?.exception ? [d.error.exception] : [];
  const frames: Frame[] = exceptions[0]?.stacktrace ?? d?.error?.log?.stacktrace ?? [];
  const trace = parseTraceId(d?.trace?.id);
  const facts: [string, unknown][] = [
    ["Zeitpunkt", formatDate(d?.["@timestamp"])],
    ["Transaktion", d?.transaction?.name ?? null],
    ["Trace", trace ? (props.env.hasApm ? <a class="mono" href={withParams(`/env/${props.env.id}/apm`, { trace })}>{trace}</a> : <span class="mono">{trace}</span>) : null],
    ["Transaktions-ID", d?.transaction?.id ? <span class="mono">{String(d.transaction.id)}</span> : null],
    ["Host", d?.host?.hostname ?? d?.host?.name ?? null],
    ["Version", d?.service?.version ?? null],
  ];
  return (
    <div class="stack">
      <dl class="facts">
        {facts.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
          <>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </>
        ))}
      </dl>
      {exceptions.length > 0 ? (
        <div class="exception-chain">
          {exceptions.slice(0, 10).map((ex, i) => (
            <p class="mono small">
              {i > 0 && <span class="muted">verursacht durch </span>}
              <strong>{String(ex?.type ?? "Exception")}</strong>
              {ex?.message ? `: ${String(ex.message).slice(0, 2000)}` : ""}
            </p>
          ))}
        </div>
      ) : (
        d?.error?.log?.message && <p class="mono small">{String(d.error.log.message).slice(0, 2000)}</p>
      )}
      {frames.length > 0 ? <Frames frames={frames} /> : <p class="muted small">Kein Stacktrace übermittelt.</p>}
    </div>
  );
}

/** Title, status, triage and the counts of a group, the same for both sources; admins can ignore its kind. */
function GroupHead(props: { c: Context; env: EnvContext; group: GroupRow; title: string }) {
  const { env, group, title } = props;
  const admin = !!props.c.get("user")?.isAdmin;
  return (
    <>
      <Card
        title={
          <div class="error-head">
            <h2 class="mono">{title.slice(0, 500)}</h2>
            <div class="row">
              <Badge tone={STATUS_TONE[group.status]}>{STATUS_LABEL[group.status]}</Badge>
              {group.handled === false && <Badge tone="bad">unbehandelt</Badge>}
              {group.handled === true && <Badge>behandelt</Badge>}
              {group.status_changed_at && <span class="muted small">Status geändert <Ago at={group.status_changed_at} /></span>}
            </div>
          </div>
        }
        actions={<><TriageButtons env={env} group={group} back="detail" />{admin && <IgnoreSimilarButton />}</>}
      >
        <dl class="facts">
          <dt>Quelle</dt><dd>{group.source === "logs" ? "ERROR-Einträge der Logs" : "APM"}</dd>
          <dt>Vorkommen</dt><dd>{formatNumber(group.occurrences)}</dd>
          <dt>Zuerst gesehen</dt><dd>{formatDate(group.first_seen_at)} (<Ago at={group.first_seen_at} />)</dd>
          <dt>Zuletzt gesehen</dt><dd>{formatDate(group.last_seen_at)} (<Ago at={group.last_seen_at} />)</dd>
          {group.culprit && <><dt>Ort</dt><dd class="mono">{group.culprit}</dd></>}
          <dt>Gruppe</dt><dd class="mono small">{group.grouping_key}</dd>
        </dl>
      </Card>
      {admin && <RuleDialog env={env} pattern={suggestPattern(group)} />}
    </>
  );
}

const shortType = (type: string) => type.split(".").at(-1) ?? type;

/** A group from the logs: its newest entry, and the way into the logs page for more of them. */
async function logGroupPage(c: Context, ctx: ErrorsContext, group: GroupRow) {
  const { env, logs } = ctx;
  let entry: LogEntry | null = null;
  let problem: string | null = null;
  if (logs.length && group.sample_entry_id) {
    try {
      const { index, body } = buildLogEntryLookup(logs, group.sample_entry_id);
      const hit = (await logsEs.search(index, body)).hits.hits[0];
      entry = hit ? toLogEntry(hit) : null;
    } catch (err) {
      problem = esProblem(err);
    }
  }
  const title = errorTitle({ exception_type: group.exception_type, message: group.message });
  // The exception class finds the group's entries in the stack traces; without one, the place it was logged from.
  const q = group.exception_type ? shortType(group.exception_type) : group.culprit ? `"${group.culprit}"` : "";
  const source = entry && logs.length > 1 ? sourceOf(entry, logs) : undefined;
  const similar = withParams(`/env/${env.id}/logs`, { range: "7d", level: "ERROR", q, source: source && String(source.id) });
  return c.html(
    <EnvShell c={c} env={env} tab="errors" title={`${group.exception_type ? shortType(group.exception_type) : "Fehler"} – Fehler`}>
      <div class="stack">
        <p class="small"><a href={`/env/${env.id}/errors${group.status === "open" ? "" : `?status=${group.status}`}`}>← Alle Fehler</a></p>
        <GroupHead c={c} env={env} group={group} title={title} />
        <Card title="Neuestes Vorkommen" description="Aus den Logs: die Einträge mit demselben Logger, derselben Exception und demselben Aufrufpfad bilden diese Gruppe." actions={<a class="btn small" href={similar}>Ähnliche Einträge in den Logs</a>}>
          {problem ? (
            <Empty title="Eintrag gerade nicht abrufbar">{problem}</Empty>
          ) : entry ? (
            <LogEntryView env={env} entry={entry} standalone={false} source={entrySourceName(entry, logs)} />
          ) : (
            <Empty title="Eintrag nicht mehr in den Logs">Er ist vermutlich älter als die Aufbewahrung der Logs.</Empty>
          )}
        </Card>
      </div>
    </EnvShell>,
  );
}

export function mountErrors(app: Hono) {
  app.get("/env/:id/errors", async (c) => {
    const ctx = await errorsContext(c);
    if (!ctx) return c.notFound();
    const { env } = ctx;
    const status = asStatus(c.req.query("status")) ?? "open";
    const { groups, counts, rules } = await rls(c, async (tx) => ({
      groups: await all<GroupRow>(tx`
        select id, grouping_key, source, sample_entry_id, exception_type, message, culprit, handled, first_seen_at, last_seen_at,
               occurrences::float8 as occurrences, status, status_changed_at
        from error_groups where environment_id = ${env.id} and status = ${status}
        order by last_seen_at desc limit ${LIST_LIMIT}`),
      counts: await all<{ status: Status; n: number }>(tx`
        select status, count(*)::int as n from error_groups where environment_id = ${env.id} group by status`),
      rules: await selectRules(tx, env),
    }));
    const admin = !!c.get("user")?.isAdmin;
    const spark = ctx.apm ? await sparklines(ctx.apm, groups.filter((g) => g.source === "apm").map((g) => g.grouping_key)) : new Map<string, number[]>();
    const count = (s: Status) => counts.find((x) => x.status === s)?.n ?? 0;
    const base = `/env/${env.id}/errors`;

    return c.html(
      <EnvShell c={c} env={env} tab="errors" title={`Fehler (${STATUS_LABEL[status]})`}>
        <div class="stack">
          <div class="row-between">
            <div class="seg" role="group" aria-label="Status">
              {STATUSES.map((s) => (
                <a class={`btn small ${s === status ? "active" : ""}`} href={withParams(base, { status: s === "open" ? undefined : s })} aria-current={s === status ? "true" : undefined}>
                  {STATUS_LABEL[s]} <span class="muted">{formatNumber(count(s))}</span>
                </a>
              ))}
            </div>
            <span class="muted small">
              {sourcesText(ctx)}
              {rules.length > 0 && <> · <a href="#ignore-rules">{rules.length === 1 ? "1 Ignorier-Regel" : `${rules.length} Ignorier-Regeln`}</a></>}
            </span>
          </div>
          <Card flush>
            {groups.length === 0 ? (
              <Empty title={status === "open" ? "Keine offenen Fehler" : `Keine Fehler mit Status „${STATUS_LABEL[status]}“`}>
                {status === "open" && (ctx.apm ? "Neue Fehlergruppen erscheinen hier, sobald der Dienst sie an APM meldet oder einen Fehler loggt." : "Neue Fehlergruppen erscheinen hier, sobald der Dienst einen Fehler loggt.")}
              </Empty>
            ) : (
              <div class="table-wrap">
                <table class="error-table">
                  <thead><tr><th>Fehler</th><th class="num">Vorkommen</th><th>24 h</th><th>Zuerst</th><th>Zuletzt</th><th></th></tr></thead>
                  <tbody>
                    {groups.map((g) => {
                      const values = spark.get(g.grouping_key);
                      const last24 = values?.reduce((a, b) => a + b, 0) ?? 0;
                      return (
                        <tr>
                          <td class="error-cell">
                            <a href={`${base}/${g.id}`}>{errorTitle({ exception_type: g.exception_type, message: g.message }).slice(0, 240)}</a>
                            <div class="muted small">
                              {g.source === "logs" && <><Badge>aus Logs</Badge> </>}
                              {g.culprit && <span class="mono">{g.culprit}</span>}
                              {g.handled === false && <> <Badge tone="bad">unbehandelt</Badge></>}
                            </div>
                          </td>
                          <td class="num">{formatNumber(g.occurrences)}</td>
                          <td>{values ? <Sparkline values={values} label={`${formatNumber(last24)} in den letzten 24 Stunden`} /> : <span class="muted small" title={g.source === "logs" ? "Für Fehlergruppen aus den Logs gibt es keinen Verlauf" : undefined}>–</span>}</td>
                          <td class="nowrap small"><Ago at={g.first_seen_at} /></td>
                          <td class="nowrap small"><Ago at={g.last_seen_at} /></td>
                          <td class="right nowrap"><TriageButtons env={env} group={g} back="list" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {groups.length === LIST_LIMIT && <p class="muted small">Die {LIST_LIMIT} zuletzt gesehenen Gruppen werden angezeigt.</p>}
          <IgnoreRulesCard env={env} rules={rules} admin={admin} />
          {admin && <RuleDialog env={env} />}
        </div>
      </EnvShell>,
    );
  });

  app.get("/env/:id/errors/:groupId", async (c) => {
    const ctx = await errorsContext(c);
    if (!ctx) return c.notFound();
    const { env } = ctx;
    const groupId = parseId(c.req.param("groupId"));
    if (!groupId) return c.notFound();
    const group = await rls(c, (tx) => first<GroupRow>(tx`
      select id, grouping_key, source, sample_entry_id, exception_type, message, culprit, handled, first_seen_at, last_seen_at,
             occurrences::float8 as occurrences, status, status_changed_at
      from error_groups where id = ${groupId} and environment_id = ${env.id}`));
    if (!group) return c.notFound();
    if (group.source === "logs") return logGroupPage(c, ctx, group);
    const source = ctx.apm;
    if (!source) return c.notFound();

    const { range } = parseRange((k) => c.req.query(k), { fallback: "24h", presets: DETAIL_PRESETS });
    const bucketMs = range.key === "7d" ? 24 * 3600_000 : 3600_000;
    const newestReq = buildNewestOccurrenceSearch(source, group.grouping_key, group.last_seen_at.getTime());
    const histReq = buildOccurrencesSearch(source, group.grouping_key, range.from, range.to, bucketMs);
    const [newest, hist] = await Promise.all([
      apmEs.search(newestReq.index, newestReq.body).then(
        (res) => ({ doc: res.hits.hits[0]?._source ?? null, error: null }),
        (err) => ({ doc: null, error: esProblem(err) }),
      ),
      apmEs.search(histReq.index, histReq.body).then(
        (res) => ({ points: ((res.aggregations?.over_time?.buckets ?? []) as any[]).map((b) => ({ t: b.key as number, v: b.doc_count as number })), error: null }),
        (err) => ({ points: [], error: esProblem(err) }),
      ),
    ]);
    const title = errorTitle({ exception_type: group.exception_type, message: group.message });
    const inRange = hist.points.reduce((a, p) => a + (p.v ?? 0), 0);

    return c.html(
      <EnvShell c={c} env={env} tab="errors" title={`${group.exception_type ?? "Fehler"} – Fehler`}>
        <div class="stack">
          <p class="small"><a href={`/env/${env.id}/errors${group.status === "open" ? "" : `?status=${group.status}`}`}>← Alle Fehler</a></p>
          <GroupHead c={c} env={env} group={group} title={title} />
          <Card title="Vorkommen im Zeitverlauf" actions={<RangePicker base={`/env/${env.id}/errors/${group.id}`} range={range} presets={DETAIL_PRESETS} custom={false} />}>
            {hist.error ? (
              <Empty title="Verlauf gerade nicht abrufbar">{hist.error}</Empty>
            ) : (
              <>
                <p class="muted small">{formatNumber(inRange)} Vorkommen, je {bucketMs >= 24 * 3600_000 ? "Tag" : "Stunde"}</p>
                <TimeChart kind="columns" tone="bad" label="Vorkommen" integer bucketMs={bucketMs} format={(v) => formatNumber(Math.round(v))} points={hist.points} />
              </>
            )}
          </Card>
          <Card title="Neuestes Vorkommen">
            {newest.error ? (
              <Empty title="Vorkommen gerade nicht abrufbar">{newest.error}</Empty>
            ) : newest.doc ? (
              <Occurrence env={env} doc={newest.doc} />
            ) : (
              <Empty title="Kein Vorkommen mehr im APM-Cluster">Das Dokument ist vermutlich durch die Aufbewahrungsfrist des APM-Clusters gelöscht.</Empty>
            )}
          </Card>
        </div>
      </EnvShell>,
    );
  });

  app.post("/env/:id/errors/:groupId/status", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 2);
    const groupId = parseId(c.req.param("groupId"));
    if (!env || !groupId) return c.notFound();
    const f = await formData(c);
    const status = asStatus(f.get("status"));
    if (!status) return c.notFound();
    // The policy limits the update to environments with diagnostics; the environment_id condition keeps
    // a group id from another environment out even for users who can see both.
    const rows = await rls(c, (tx) => tx`
      update error_groups set status = ${status} where id = ${groupId} and environment_id = ${env.id} returning id`);
    if (!rows.length) return c.notFound();
    await audit(c, "error_group.status", String(groupId), { environment_id: env.id, status });
    const from = asStatus(f.get("from")) ?? "open";
    const back = f.get("back") === "detail"
      ? `/env/${env.id}/errors/${groupId}`
      : withParams(`/env/${env.id}/errors`, { status: from === "open" ? undefined : from });
    return redirectWith(c, back, { kind: "ok", text: STATUS_DONE[status] });
  });
}
