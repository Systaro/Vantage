import type { Context, Hono } from "hono";
import { parseId } from "../../../shared/http";
import { TimeChart } from "../../../shared/ui/charts";
import { Card, CopyButton, DetailDialog, Empty, formatNumber } from "../../../shared/ui/components";
import { EnvShell, loadEnv, type EnvContext } from "../../ui";
import { parseTraceId } from "../apm/query";
import { esProblem, logsEs } from "../es/client";
import { berlinLocalInput } from "../../../shared/time";
import { parseRange, PRESETS, RangePicker, rangeParams, withParams, type TimeRange } from "../es/range";
import { mountSources } from "../sources/settings";
import type { NamedLogsSource } from "../sources/config";
import { loadLogsSources } from "../sources/store";
import {
  buildLogEntryLookup,
  buildLogsSearch,
  buildLogsSummary,
  buildSourceCounts,
  cursorParams,
  LOG_LEVELS,
  nextCursor,
  PAGE_SIZE,
  parseCursor,
  parseLogFilters,
  parseLogId,
  sourceOf,
  toLogEntry,
  toLogRow,
  toLogsSummary,
  toSourceCounts,
  type LogCursor,
  type LogEntry,
  type LogFilters,
  type LogRow,
  type SourceCounts,
} from "./query";

interface LogsContext {
  env: EnvContext;
  /** Every logs source of the environment. */
  sources: NamedLogsSource[];
  /** The one chosen with `?source=`, or null for all of them. */
  selected: NamedLogsSource | null;
}

async function logsContext(c: Context): Promise<LogsContext | null> {
  const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 2);
  if (!env) return null;
  const sources = await loadLogsSources(c, env.id);
  if (!sources.length) return null;
  const wanted = parseId(c.req.query("source"));
  return { env, sources, selected: sources.find((s) => s.id === wanted) ?? null };
}

/** The sources a view reads, and whether its rows name theirs (only when several are read). */
function viewSources(ctx: LogsContext) {
  const read = ctx.selected ? [ctx.selected] : ctx.sources;
  return { read, showSource: read.length > 1 };
}

const columns = (showSource: boolean) => (showSource ? 6 : 5);

function viewParams(c: Context) {
  const { range, problem } = parseRange((k) => c.req.query(k), { fallback: "1h" });
  const filters = parseLogFilters(c.req.queries("level") ?? [], c.req.query("q"));
  const before = parseCursor(c.req.query("before"), c.req.query("before_seen"));
  const live = c.req.query("live") === "1" && range.relative && !before;
  return { range, problem, filters, before, live };
}

/** Parameters every follow-up request (older page, live poll) carries to stay in the same view. */
function filterParams(range: TimeRange, filters: LogFilters, selected: NamedLogsSource | null): Record<string, string | string[]> {
  return { ...rangeParams(range), level: filters.levels, q: filters.q, ...(selected ? { source: String(selected.id) } : {}) };
}

const tsParts = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function logTime(t: number): string {
  const p = Object.fromEntries(tsParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}. ${p.hour}:${p.minute}:${p.second},${String(t % 1000).padStart(3, "0")}`;
}

function shortLogger(name: string): string {
  const parts = name.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : name;
}

const ENTRY_DIALOG = "log-entry";
const entryUrl = (env: EnvContext, id: string) => `/env/${env.id}/logs/entry/${encodeURIComponent(id)}`;

/** A row that opens its entry in the detail dialog (vantage.js: click outside links and controls, or Enter). */
const entryRow = (env: EnvContext, r: LogRow) => ({
  class: "log-row",
  tabindex: 0,
  "data-detail-dialog": ENTRY_DIALOG,
  "data-detail-url": entryUrl(env, r.id),
  "aria-haspopup": "dialog",
});

function SourceCell(props: { row: LogRow; sources: readonly NamedLogsSource[] }) {
  return <td class="nowrap log-source">{sourceOf(props.row, props.sources)?.name ?? "–"}</td>;
}

function LogRows(props: { rows: LogRow[]; env: EnvContext; sources: readonly NamedLogsSource[]; showSource: boolean }) {
  return (
    <>
      {props.rows.map((r) => {
        const trace = parseTraceId(r.traceId);
        return (
          <tr {...entryRow(props.env, r)}>
            <td class="nowrap" title={new Date(r.ts).toISOString()}>{logTime(r.ts)}</td>
            {props.showSource && <SourceCell row={r} sources={props.sources} />}
            <td><span class={`lvl lvl-${r.level.replace(/[^A-Z]/g, "")}`}>{r.level || "–"}</span></td>
            <td class="logger" title={r.thread ? `${r.logger} [${r.thread}]` : r.logger}>{shortLogger(r.logger)}</td>
            <td class="msg">
              {r.message}
              {r.stack && (
                <details class="log-stack">
                  <summary>Stacktrace</summary>
                  <pre>{r.stack}</pre>
                </details>
              )}
            </td>
            <td class="nowrap">
              {trace && props.env.hasApm ? (
                <a href={withParams(`/env/${props.env.id}/apm`, { trace })} title={`Trace ${trace} im APM öffnen`}>{trace.slice(0, 8)}…</a>
              ) : r.traceId ? (
                <span title={r.traceId}>{r.traceId.slice(0, 8)}…</span>
              ) : null}
            </td>
          </tr>
        );
      })}
    </>
  );
}

/**
 * One entry, whole: the detail dialog, its own page, and the newest occurrence of a log error group.
 * `source` is named when the environment has several.
 */
export function LogEntryView(props: { env: EnvContext; entry: LogEntry; standalone: boolean; source?: string }) {
  const e = props.entry;
  const trace = parseTraceId(e.traceId);
  return (
    <div class="log-entry">
      <dl class="facts">
        <dt>Zeit</dt><dd><span class="mono">{logTime(e.ts)}</span> <span class="muted small log-entry-iso">{new Date(e.ts).toISOString()}</span></dd>
        {props.source && <><dt>Quelle</dt><dd>{props.source}</dd></>}
        <dt>Level</dt><dd><span class={`lvl lvl-${e.level.replace(/[^A-Z]/g, "")}`}>{e.level || "–"}</span></dd>
        {e.logger && <><dt>Logger</dt><dd><code>{e.logger}</code></dd></>}
        {e.thread && <><dt>Thread</dt><dd><code>{e.thread}</code></dd></>}
        {e.traceId && <><dt>Trace</dt><dd>{trace && props.env.hasApm
          ? <a href={withParams(`/env/${props.env.id}/apm`, { trace })}>{e.traceId}</a>
          : <code>{e.traceId}</code>}</dd></>}
        {e.transactionId && <><dt>Transaktion</dt><dd><code>{e.transactionId}</code></dd></>}
      </dl>
      <section class="log-entry-block">
        <div class="row-between"><h3>Nachricht</h3><CopyButton target="log-entry-message" /></div>
        <pre id="log-entry-message">{e.message || "–"}</pre>
      </section>
      {e.stack && (
        <section class="log-entry-block">
          <div class="row-between"><h3>Stacktrace</h3><CopyButton target="log-entry-stack" /></div>
          <pre id="log-entry-stack">{e.stack}</pre>
        </section>
      )}
      {e.fields.length > 0 && (
        <section class="log-entry-block">
          <h3>Weitere Felder</h3>
          <dl class="facts log-entry-fields">{e.fields.map(([k, v]) => <><dt>{k}</dt><dd>{v}</dd></>)}</dl>
        </section>
      )}
      <div class="row log-entry-foot">
        <CopyButton target="log-entry-json" label="Als JSON kopieren" />
        {!props.standalone && <a class="btn small ghost" href={entryUrl(props.env, e.id)}>Eigene Seite</a>}
        <span class="muted small">Index <code>{e.index}</code> · ID <code>{e.id}</code></span>
      </div>
      <pre id="log-entry-json" hidden>{e.json}</pre>
    </div>
  );
}

/** The entry's source as LogEntryView names it: only among several. */
export function entrySourceName(entry: LogEntry, sources: readonly NamedLogsSource[]): string | undefined {
  return sources.length > 1 ? sourceOf(entry, sources)?.name : undefined;
}

function TailRow(props: { env: EnvContext; keep: Record<string, string | string[]>; cursor: LogCursor; cols: number; problem?: string }) {
  return (
    <tr
      id="log-tail"
      class="tail-row"
      hx-get={withParams(`/env/${props.env.id}/logs/rows`, { ...props.keep, ...cursorParams("after", props.cursor) })}
      hx-trigger="every 5s"
      hx-swap="outerHTML"
    >
      <td colspan={props.cols}>
        <span class="live-dot" aria-hidden="true" />
        {props.problem ? <span class="status-warn">Live-Aktualisierung gestört: {props.problem}. Nächster Versuch in 5 s.</span> : "Live: neue Einträge erscheinen hier automatisch (alle 5 s)."}
      </td>
    </tr>
  );
}

function MoreRow(props: { env: EnvContext; keep: Record<string, string | string[]>; cursor: LogCursor; cols: number }) {
  const params = { ...props.keep, ...cursorParams("before", props.cursor) };
  return (
    <tr class="more-row">
      <td colspan={props.cols}>
        <a
          class="btn small"
          href={withParams(`/env/${props.env.id}/logs`, params)}
          hx-get={withParams(`/env/${props.env.id}/logs/rows`, params)}
          hx-target="closest tr"
          hx-swap="outerHTML"
        >
          Ältere Einträge
        </a>
      </td>
    </tr>
  );
}

/** The overview's logs card. The numbers come in a second request, so a slow cluster never holds up the overview. */
export function LogsOverviewCard(props: { env: EnvContext }) {
  const base = `/env/${props.env.id}/logs`;
  return (
    <Card title="Logs" description="Letzte 24 Stunden" actions={<a class="btn small" href={base}>Alle Logs</a>}>
      <div hx-get={`${base}/summary`} hx-trigger="load" hx-swap="outerHTML">
        <p class="muted small">Lädt …</p>
      </div>
      <DetailDialog id={ENTRY_DIALOG} title="Logeintrag" icon="scroll-text" />
    </Card>
  );
}

function LogsSummaryBody(props: { env: EnvContext; summary: ReturnType<typeof toLogsSummary>; sources: readonly NamedLogsSource[] }) {
  const { env, summary: s, sources } = props;
  const showSource = sources.length > 1;
  const base = `/env/${env.id}/logs`;
  const errors = s.levels.ERROR ?? 0;
  const warnings = s.levels.WARN ?? 0;
  const count = (label: string, value: number, level?: string, tone?: string) => (
    <a class="log-count" href={withParams(base, { range: "24h", level })}>
      <span class={`log-count-value ${value > 0 && tone ? tone : ""}`}>{formatNumber(value)}</span>
      <span class="log-count-label">{label}</span>
    </a>
  );
  return (
    <div class="stack">
      <div class="log-counts">
        {count("Fehler", errors, "ERROR", "status-bad")}
        {count("Warnungen", warnings, "WARN", "status-warn")}
        {count("Einträge insgesamt", s.total)}
      </div>
      {errors > 0 && (
        <div class="log-summary-chart">
          <TimeChart kind="columns" tone="bad" label="Fehler pro Stunde" integer table={false} height={140}
            bucketMs={3_600_000} format={(v) => formatNumber(Math.round(v))} points={s.errorsPerHour} />
        </div>
      )}
      {s.latest.length === 0 ? (
        <p class="status-ok">Keine Fehler und Warnungen in den letzten 24 Stunden.</p>
      ) : (
        <div class="table-wrap">
          <table class="log-table log-latest">
            <thead><tr><th>Zeit</th>{showSource && <th>Quelle</th>}<th>Level</th><th>Logger</th><th>Neueste Fehler und Warnungen</th></tr></thead>
            <tbody>{s.latest.map((r) => (
              <tr {...entryRow(env, r)}>
                <td class="nowrap" title={new Date(r.ts).toISOString()}>{logTime(r.ts)}</td>
                {showSource && <SourceCell row={r} sources={sources} />}
                <td><span class={`lvl lvl-${r.level.replace(/[^A-Z]/g, "")}`}>{r.level || "–"}</span></td>
                <td class="logger" title={r.logger}>{shortLogger(r.logger)}</td>
                <td class="msg" title={r.message.slice(0, 1000)}>{r.message.split("\n", 1)[0]!.slice(0, 300)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** All sources or one, with how many entries of the view each has. */
function SourcePicker(props: { base: string; ctx: LogsContext; keep: Record<string, string | string[] | undefined>; counts: SourceCounts | null }) {
  const { ctx, counts } = props;
  const href = (source?: NamedLogsSource) => withParams(props.base, { ...props.keep, source: source ? String(source.id) : undefined });
  const count = (n: number | undefined) => (n === undefined ? null : <span class="seg-count">{formatNumber(n)}</span>);
  return (
    <div class="seg source-picker" role="group" aria-label="Quelle">
      <a class={`btn small ${ctx.selected ? "" : "active"}`} href={href()} aria-current={ctx.selected ? undefined : "true"}>Alle Quellen {count(counts?.total)}</a>
      {ctx.sources.map((s) => (
        <a class={`btn small ${ctx.selected?.id === s.id ? "active" : ""}`} href={href(s)} aria-current={ctx.selected?.id === s.id ? "true" : undefined} title={s.index}>
          {s.name} {count(counts?.bySource.get(s.id))}
        </a>
      ))}
    </div>
  );
}

function rangeText(range: TimeRange): string {
  const preset = PRESETS.find((p) => p.key === range.key);
  if (preset) return `letzte ${preset.label}`;
  return `${berlinLocalInput(range.from).replace("T", " ")} bis ${berlinLocalInput(range.to).replace("T", " ")}`;
}

export function mountLogs(app: Hono) {
  mountSources(app);

  app.get("/env/:id/logs", async (c) => {
    const ctx = await logsContext(c);
    if (!ctx) return c.notFound();
    const { env, sources, selected } = ctx;
    const { read, showSource } = viewSources(ctx);
    const cols = columns(showSource);
    const v = viewParams(c);
    const base = `/env/${env.id}/logs`;
    const keep = filterParams(v.range, v.filters, selected);

    let rows: LogRow[] = [];
    let total: { value: number; relation: string } | undefined;
    let counts: SourceCounts | null = null;
    let error: string | null = null;
    try {
      const { index, body } = buildLogsSearch(read, { range: v.range, filters: v.filters, before: v.before });
      const countSearch = sources.length > 1 && !v.before ? buildSourceCounts(sources, { range: v.range, filters: v.filters }) : null;
      const [res, countRes] = await Promise.all([
        logsEs.search(index, body),
        // The numbers on the picker are a nicety: without them the entries still show.
        countSearch ? logsEs.search(countSearch.index, countSearch.body).catch(() => null) : null,
      ]);
      rows = res.hits.hits.map(toLogRow);
      total = res.hits.total;
      counts = countRes ? toSourceCounts(countRes) : null;
    } catch (err) {
      error = esProblem(err);
    }
    const tailCursor = nextCursor(rows, "max") ?? { ts: v.range.to, seen: [] };
    const more = rows.length === PAGE_SIZE ? nextCursor(rows, "min", v.before) : null;
    const count = v.before
      ? "ältere Einträge"
      : total
        ? total.relation === "gte" ? `mehr als ${formatNumber(total.value)} Einträge` : `${formatNumber(total.value)} ${total.value === 1 ? "Eintrag" : "Einträge"}`
        : "";

    return c.html(
      <EnvShell c={c} env={env} tab="logs" title="Logs">
        <div class="stack">
          <div class="row-between">
            <RangePicker base={base} range={v.range} keep={{ level: v.filters.levels, q: v.filters.q, source: selected ? String(selected.id) : undefined, live: v.live ? "1" : undefined }} />
            {v.range.relative && !v.before && (
              <a class={`btn small live-toggle ${v.live ? "active" : ""}`} href={withParams(base, { ...keep, live: v.live ? undefined : "1" })} aria-pressed={v.live ? "true" : "false"}>
                {v.live ? "Live an" : "Live aus"}
              </a>
            )}
          </div>
          {sources.length > 1 && <SourcePicker base={base} ctx={ctx} keep={{ ...keep, live: v.live ? "1" : undefined }} counts={counts} />}
          <form method="get" action={base} class="toolbar log-search">
            {Object.entries(rangeParams(v.range)).map(([k, val]) => <input type="hidden" name={k} value={val} />)}
            {selected && <input type="hidden" name="source" value={String(selected.id)} />}
            {v.live && <input type="hidden" name="live" value="1" />}
            <div class="field grow">
              <label for="log-q">Suche</label>
              <input id="log-q" type="search" name="q" value={v.filters.q} maxlength={500} placeholder="Text in Nachricht, Logger oder Stacktrace, z. B. timeout -health" />
            </div>
            <fieldset class="field levels">
              <legend class="label">Level</legend>
              <div class="row">
                {LOG_LEVELS.map((l) => (
                  <label class="check"><input type="checkbox" name="level" value={l} checked={v.filters.levels.includes(l)} /> <span class={`lvl lvl-${l}`}>{l}</span></label>
                ))}
              </div>
            </fieldset>
            <button class="btn primary" type="submit">Suchen</button>
          </form>
          {v.problem && <div class="flash bad" role="status">{v.problem}</div>}
          <Card flush title={<h2>Einträge <span class="muted small">{rangeText(v.range)}{count && ` · ${count}`}</span></h2>} actions={v.before && <a class="btn small" href={withParams(base, keep)}>Zu den neuesten</a>}>
            {error ? (
              <Empty title="Logs gerade nicht abrufbar">{error}</Empty>
            ) : (
              <div class="table-wrap">
                <table class="log-table">
                  <thead><tr><th>Zeit</th>{showSource && <th>Quelle</th>}<th>Level</th><th>Logger</th><th>Nachricht</th><th>Trace</th></tr></thead>
                  <tbody id="log-rows">
                    {v.live && <TailRow env={env} keep={keep} cursor={tailCursor} cols={cols} />}
                    <LogRows rows={rows} env={env} sources={read} showSource={showSource} />
                    {rows.length === 0 && (
                      <tr class="empty-row"><td colspan={cols}>
                        {v.before ? (
                          <Empty title="Keine älteren Einträge" icon="scroll-text">Weiter zurück reicht der gewählte Zeitraum nicht.</Empty>
                        ) : (
                          <Empty title="Keine Einträge" icon="scroll-text">Im gewählten Zeitraum passt nichts zu Suche und Filtern. Zeitraum vergrößern oder Filter lockern.</Empty>
                        )}
                      </td></tr>
                    )}
                    {more && <MoreRow env={env} keep={keep} cursor={more} cols={cols} />}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
        <DetailDialog id={ENTRY_DIALOG} title="Logeintrag" icon="scroll-text" />
      </EnvShell>,
    );
  });

  // One entry, whole. htmx loads it into the dialog; opened directly it is a page of its own (a link to share).
  app.get("/env/:id/logs/entry/:entryId", async (c) => {
    const ctx = await logsContext(c);
    const id = parseLogId(c.req.param("entryId"));
    if (!ctx || !id) return c.notFound();
    let entry: LogEntry | null = null;
    let error: string | null = null;
    try {
      const { index, body } = buildLogEntryLookup(ctx.sources, id);
      const hit = (await logsEs.search(index, body)).hits.hits[0];
      entry = hit ? toLogEntry(hit) : null;
    } catch (err) {
      error = esProblem(err);
    }
    const content = error ? (
      <p class="status-bad">Logs gerade nicht abrufbar: {error}</p>
    ) : entry ? (
      <LogEntryView env={ctx.env} entry={entry} standalone={!c.req.header("hx-request")} source={entrySourceName(entry, ctx.sources)} />
    ) : (
      <Empty title="Eintrag nicht gefunden" icon="scroll-text">Er ist älter als die Aufbewahrung der Logs oder gehört nicht zu dieser Umgebung.</Empty>
    );
    if (c.req.header("hx-request")) return c.html(content);
    const back = `/env/${ctx.env.id}/logs`;
    return c.html(
      <EnvShell c={c} env={ctx.env} tab="logs" title={entry ? `Logeintrag ${logTime(entry.ts)}` : "Logeintrag"}>
        <Card title="Logeintrag" actions={<a class="btn small" href={back}>Alle Logs</a>}>{content}</Card>
      </EnvShell>,
      entry || error ? 200 : 404,
    );
  });

  app.get("/env/:id/logs/summary", async (c) => {
    const ctx = await logsContext(c);
    if (!ctx) return c.notFound();
    try {
      const { index, body, from } = buildLogsSummary(ctx.sources, Date.now());
      const summary = toLogsSummary(await logsEs.search(index, body), from);
      return c.html(<LogsSummaryBody env={ctx.env} summary={summary} sources={ctx.sources} />);
    } catch (err) {
      return c.html(<p class="status-bad small">Logs gerade nicht abrufbar: {esProblem(err)}</p>);
    }
  });

  // Fragments for htmx: the live tail (`after`) and the next older page (`before`).
  app.get("/env/:id/logs/rows", async (c) => {
    const ctx = await logsContext(c);
    if (!ctx) return c.notFound();
    const { env, selected } = ctx;
    const { read, showSource } = viewSources(ctx);
    const cols = columns(showSource);
    const v = viewParams(c);
    const keep = filterParams(v.range, v.filters, selected);
    const after = parseCursor(c.req.query("after"), c.req.query("after_seen"));

    if (after) {
      try {
        const { index, body } = buildLogsSearch(read, { range: v.range, filters: v.filters, after });
        const rows = (await logsEs.search(index, body)).hits.hits.map(toLogRow);
        if (rows.length === 0) return c.body(null, 204);
        return c.html(
          <>
            <TailRow env={env} keep={keep} cursor={nextCursor(rows, "max", after)!} cols={cols} />
            <LogRows rows={[...rows].reverse()} env={env} sources={read} showSource={showSource} />
          </>,
        );
      } catch (err) {
        return c.html(<TailRow env={env} keep={keep} cursor={after} cols={cols} problem={esProblem(err)} />);
      }
    }

    if (!v.before) return c.notFound();
    try {
      const { index, body } = buildLogsSearch(read, { range: v.range, filters: v.filters, before: v.before });
      const rows = (await logsEs.search(index, body)).hits.hits.map(toLogRow);
      const more = rows.length === PAGE_SIZE ? nextCursor(rows, "min", v.before) : null;
      return c.html(
        <>
          <LogRows rows={rows} env={env} sources={read} showSource={showSource} />
          {more ? <MoreRow env={env} keep={keep} cursor={more} cols={cols} /> : <tr class="more-row"><td colspan={cols}>Anfang des Zeitraums erreicht.</td></tr>}
        </>,
      );
    } catch (err) {
      return c.html(<tr class="more-row"><td colspan={cols} class="status-bad">{esProblem(err)}</td></tr>);
    }
  });
}
