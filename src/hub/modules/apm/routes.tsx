import type { Context, Hono } from "hono";
import { parseId } from "../../../shared/http";
import { Badge, Card, Empty, formatDate, formatDuration, formatNumber, Stat } from "../../../shared/ui/components";
import { EnvShell, loadEnv, type EnvContext } from "../../ui";
import { apmEs, esProblem } from "../es/client";
import { bucketFor, parseRange, RangePicker, rangeParams, withParams } from "../es/range";
import type { ApmSource } from "../sources/config";
import { loadApmSource } from "../sources/store";
import { TimeChart } from "../../../shared/ui/charts";
import { buildOverviewSearch, buildTraceSearch, parseOverview, parseTraceId, type Overview } from "./query";

async function apmContext(c: Context): Promise<{ env: EnvContext; source: ApmSource } | null> {
  const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 2);
  if (!env) return null;
  const source = await loadApmSource(c, env.id);
  return source ? { env, source } : null;
}

// Axis ticks and tiles share these: no padded zeros ("1,5", "2", "0,25"), precision by magnitude.
const numberFormats = [0, 1, 2].map((d) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: d }));
const digitsFor = (v: number) => (Math.abs(v) >= 10 ? 0 : Math.abs(v) >= 1 ? 1 : 2);
const compact = (v: number) => numberFormats[digitsFor(v)]!.format(v);
const perMinute = compact;
const pct = (v: number) => `${compact(v)} %`;
const latency = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${compact(ms / 1000)} s`);

function rateClass(rate: number | null): string {
  if (rate === null) return "";
  return rate >= 5 ? "status-bad" : rate >= 1 ? "status-warn" : "";
}

interface TraceTx {
  "@timestamp": string;
  transaction?: { id?: string; name?: string; type?: string; result?: string; duration?: { us?: number } };
  event?: { outcome?: string };
  parent?: { id?: string };
}

function TraceCard(props: { traceId: string; source: ApmSource; rows: TraceTx[] | null; error: string | null; clearHref: string }) {
  return (
    <Card
      title={<h2>Trace <code>{props.traceId}</code></h2>}
      actions={<a class="btn small" href={props.clearHref}>Trace-Filter entfernen</a>}
      flush
    >
      <p class="muted small card-note">
        Nur Transaktionen von <code>{props.source.service}</code> in <code>{props.source.environment}</code> aus den letzten 30 Tagen. Teile des Traces in anderen Diensten sind hier nicht sichtbar.
      </p>
      {props.error ? (
        <Empty title="Trace gerade nicht abrufbar">{props.error}</Empty>
      ) : !props.rows?.length ? (
        <Empty title="Keine Transaktionen zu diesem Trace" />
      ) : (
        <div class="table-wrap">
          <table>
            <thead><tr><th>Zeit</th><th>Transaktion</th><th>Typ</th><th class="num">Dauer</th><th>Ergebnis</th><th>Ausgang</th></tr></thead>
            <tbody>
              {props.rows.map((r) => (
                <tr>
                  <td class="nowrap small">{formatDate(r["@timestamp"])}</td>
                  <td>{r.transaction?.name ?? "–"}{r.parent?.id ? null : <span class="muted small"> (Einstieg)</span>}</td>
                  <td class="small">{r.transaction?.type ?? "–"}</td>
                  <td class="num">{typeof r.transaction?.duration?.us === "number" ? formatDuration(r.transaction.duration.us / 1000) : "–"}</td>
                  <td class="small">{r.transaction?.result ?? "–"}</td>
                  <td>{r.event?.outcome === "failure" ? <Badge tone="bad">Fehler</Badge> : r.event?.outcome === "success" ? <Badge tone="ok">ok</Badge> : <Badge>{r.event?.outcome ?? "unbekannt"}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function OverviewView(props: { o: Overview; bucketMs: number; minutes: number }) {
  const { o, bucketMs } = props;
  const perBucketMin = bucketMs / 60_000;
  const step = bucketMs >= 3600_000 ? `${bucketMs / 3600_000} h` : `${perBucketMin} min`;
  return (
    <>
      <div class="grid grid-4">
        <Stat label="Transaktionen" value={formatNumber(o.total)} />
        <Stat label="Durchsatz" value={perMinute(o.total / props.minutes)} hint="pro Minute im Schnitt" />
        <Stat label="Latenz p95" value={formatDuration(o.p95Ms)} hint={`Ø ${formatDuration(o.avgMs)}`} />
        <Stat label="Fehlerquote" value={pct(o.failureRate ?? 0)} hint="event.outcome = failure" tone={o.failureRate !== null && o.failureRate >= 5 ? "bad" : o.failureRate !== null && o.failureRate >= 1 ? "warn" : undefined} />
      </div>
      <Card title="Durchsatz">
        <p class="muted small">Transaktionen pro Minute, gemittelt je {step}</p>
        <TimeChart kind="columns" label="Transaktionen pro Minute" bucketMs={bucketMs} format={perMinute} points={o.buckets.map((b) => ({ t: b.t, v: b.count / perBucketMin }))} />
      </Card>
      <Card title="Latenz (p95)">
        <p class="muted small">95 % der Transaktionen waren schneller, je {step}</p>
        <TimeChart kind="line" label="Latenz p95" bucketMs={bucketMs} format={latency} points={o.buckets.map((b) => ({ t: b.t, v: b.p95Ms }))} />
      </Card>
      <Card title="Fehlerquote">
        <p class="muted small">Anteil der Transaktionen mit event.outcome = failure, je {step}</p>
        <TimeChart kind="line" tone="bad" label="Fehlerquote" bucketMs={bucketMs} format={pct} minTop={1} points={o.buckets.map((b) => ({ t: b.t, v: b.failureRate }))} />
      </Card>
      <Card flush title="Transaktionen" actions={o.transactions.length >= 50 && <span class="muted small">die 50 häufigsten</span>}>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Transaktion</th><th class="num">Anzahl</th><th class="num">Ø Dauer</th><th class="num">p95</th><th class="num">Fehlerquote</th></tr></thead>
            <tbody>
              {o.transactions.map((t) => (
                <tr>
                  <td class="mono small">{t.name}</td>
                  <td class="num">{formatNumber(t.count)}</td>
                  <td class="num">{formatDuration(t.avgMs)}</td>
                  <td class="num">{formatDuration(t.p95Ms)}</td>
                  <td class={`num ${rateClass(t.failureRate)}`}>{t.failureRate === null ? "–" : pct(t.failureRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

export function mountApm(app: Hono) {
  app.get("/env/:id/apm", async (c) => {
    const ctx = await apmContext(c);
    if (!ctx) return c.notFound();
    const { env, source } = ctx;
    const { range, problem } = parseRange((k) => c.req.query(k), { fallback: "24h" });
    const bucketMs = bucketFor(range);
    const traceId = parseTraceId(c.req.query("trace"));
    const base = `/env/${env.id}/apm`;

    const overviewReq = buildOverviewSearch(source, range, bucketMs);
    const traceReq = traceId ? buildTraceSearch(source, traceId) : null;
    const [overview, trace] = await Promise.all([
      apmEs.search(overviewReq.index, overviewReq.body).then(
        (res) => ({ data: parseOverview(res), error: null }),
        (err) => ({ data: null, error: esProblem(err) }),
      ),
      traceReq
        ? apmEs.search<TraceTx>(traceReq.index, traceReq.body).then(
            (res) => ({ rows: res.hits.hits.map((h) => h._source), error: null }),
            (err) => ({ rows: null, error: esProblem(err) }),
          )
        : null,
    ]);

    return c.html(
      <EnvShell c={c} env={env} tab="apm" title={traceId ? `Trace ${traceId.slice(0, 8)} – APM` : "APM"}>
        <div class="stack">
          <div class="row-between">
            <RangePicker base={base} range={range} keep={{ trace: traceId ?? undefined }} />
            <span class="muted small">Dienst <code>{source.service}</code> · <code>{source.environment}</code></span>
          </div>
          {problem && <div class="flash bad" role="status">{problem}</div>}
          {traceId && trace && <TraceCard traceId={traceId} source={source} rows={trace.rows} error={trace.error} clearHref={withParams(base, rangeParams(range))} />}
          {overview.error ? (
            <Card><Empty title="APM-Daten gerade nicht abrufbar">{overview.error}</Empty></Card>
          ) : overview.data!.total === 0 ? (
            <Card><Empty title="Keine Transaktionen im Zeitraum">Der Dienst hat in diesem Zeitraum keine Transaktionen gemeldet.</Empty></Card>
          ) : (
            <OverviewView o={overview.data!} bucketMs={bucketMs} minutes={(range.to - range.from) / 60_000} />
          )}
        </div>
      </EnvShell>,
    );
  });
}
