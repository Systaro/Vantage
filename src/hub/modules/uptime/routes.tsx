import type { SQL } from "bun";
import type { Context, Hono } from "hono";
import { encryptString, newToken, sha256Hex } from "../../../shared/crypto";
import { formData, parseId, redirectWith, showDialogStep } from "../../../shared/http";
import { Sparkline, StatusStrip, TimeChart } from "../../../shared/ui/charts";
import { ActionButton, Ago, Badge, Card, ChoiceDialog, ConfirmAction, DialogButton, Empty, Field, FormDialog, formatDate, formatDay, formatDuration, formatPercent, SecretBox, Stat } from "../../../shared/ui/components";
import { Icon, type IconName } from "../../../shared/ui/icons";
import { hubConfig } from "../../config";
import { all, first, hubSql, rls } from "../../db";
import { registerSettingsSection } from "../core/registry";
import { audit, EnvShell, loadEnv, type EnvContext } from "../../ui";
import type { HealthDetails } from "./health";
import { JSON_OPS, statusMatcher, type JsonOp } from "./probes";
import { RUNNER_MONITOR_KINDS } from "../../../shared/runner-protocol";
import { runnerOptionLabel, runnersForOrg } from "../runners/routes";

export const KIND_LABEL: Record<string, string> = {
  http: "HTTP(S)",
  tcp: "TCP-Port",
  dns: "DNS",
  tls: "TLS-Zertifikat",
  heartbeat: "Heartbeat (Push)",
  kuma: "Uptime Kuma",
  health: "Health-Endpunkt",
};

export function StatusBadge(props: { status: string }) {
  switch (props.status) {
    case "up":
      return <Badge tone="ok" dot>up</Badge>;
    case "down":
      return <Badge tone="bad" dot>down</Badge>;
    case "paused":
      return <Badge tone="idle">pausiert</Badge>;
    default:
      return <Badge tone="idle" dot>ausstehend</Badge>;
  }
}

function target(kind: string, cfg: any): string {
  switch (kind) {
    case "http":
      return `${cfg.method ?? "GET"} ${cfg.url}`;
    case "tcp":
      return `${cfg.host}:${cfg.port}`;
    case "dns":
      return `${cfg.type ?? "A"} ${cfg.name}`;
    case "tls":
      return `${cfg.host}:${cfg.port ?? 443}`;
    case "heartbeat":
      return `Push, Toleranz ${cfg.graceSeconds ?? 60} s`;
    case "kuma":
      return `${cfg.monitorName} @ ${cfg.baseUrl}`;
    case "health":
      return `GET ${cfg.url}`;
    default:
      return "";
  }
}

interface MonitorRow {
  id: number;
  name: string;
  kind: string;
  config: any;
  interval_seconds: number;
  enabled: boolean;
  runner_id: number | null;
  status: string;
  since: string;
  last_check_at: string | null;
  last_message: string | null;
  last_latency_ms: number | null;
  tls_days_left: number | null;
  u24: number | null;
  u7: number | null;
  u30: number | null;
  lat24: number | null;
}

/** Monitors of one environment with uptime figures; runs inside rls(). */
export function monitorsWithStats(tx: any, envId: number) {
  return all<MonitorRow>(tx`
    select m.id, m.name, m.kind, m.config, m.interval_seconds, m.enabled, m.runner_id,
           s.status, s.since, s.last_check_at, s.last_message, s.last_latency_ms, s.tls_days_left,
           st.u24, st.u7, st.u30, st.lat24
    from monitors m
    join monitor_state s on s.monitor_id = m.id
    left join lateral (
      select
        100.0 * avg(case when c.ok then 1 else 0 end) filter (where c.at > now() - interval '24 hours') as u24,
        100.0 * avg(case when c.ok then 1 else 0 end) filter (where c.at > now() - interval '7 days') as u7,
        100.0 * avg(case when c.ok then 1 else 0 end) as u30,
        avg(c.latency_ms) filter (where c.ok and c.at > now() - interval '24 hours') as lat24
      from monitor_checks c where c.monitor_id = m.id and c.at > now() - interval '30 days'
    ) st on true
    where m.environment_id = ${envId}
    order by (s.status = 'down') desc, m.name`);
}

/** No check for three intervals (a runner cut off, a stalled worker): the status shown is old. */
function checkOverdue(m: Pick<MonitorRow, "enabled" | "kind" | "last_check_at" | "interval_seconds">): boolean {
  if (!m.enabled || m.kind === "heartbeat" || !m.last_check_at) return false;
  return Date.now() - new Date(m.last_check_at).getTime() > m.interval_seconds * 3000 + 60_000;
}

/** The newest reading of a health monitor: components and metrics; runs inside rls(). */
export function latestHealth(tx: any, monitorId: number) {
  return first<{ at: string; details: HealthDetails }>(tx`
    select at, details from monitor_checks where monitor_id = ${monitorId} and details is not null order by at desc limit 1`);
}

function recentChecks(tx: any, envId: number) {
  return all<{ monitor_id: number; at: string; ok: boolean; message: string; latency_ms: number | null }>(tx`
    select monitor_id, at, ok, message, latency_ms from (
      select c.*, row_number() over (partition by c.monitor_id order by c.at desc) as rn
      from monitor_checks c where c.environment_id = ${envId} and c.at > now() - interval '7 days'
    ) x where rn <= 60 order by at`);
}

const QUARTER_HOUR = 15 * 60_000;

/** 96 quarter-hour buckets ending now; buckets without successful checks stay empty (a gap, not 0). */
function latencyBuckets(rows: { bucket: string; lat: number | null }[]) {
  const end = Math.floor(Date.now() / QUARTER_HOUR) * QUARTER_HOUR;
  const byStart = new Map(rows.map((r) => [new Date(r.bucket).getTime(), r.lat === null ? null : Number(r.lat)]));
  return Array.from({ length: 96 }, (_, i) => {
    const t = end - (95 - i) * QUARTER_HOUR;
    return { t, v: byStart.get(t) ?? null };
  });
}

function uptimeTone(v: number | null): "ok" | "warn" | "bad" | undefined {
  if (v === null || v === undefined) return undefined;
  return v >= 99.9 ? "ok" : v >= 99 ? "warn" : "bad";
}

function Uptime(props: { value: number | null }) {
  const tone = uptimeTone(props.value);
  return <span class={tone ? `status-${tone}` : "muted"}>{formatPercent(props.value === null ? null : Number(props.value), 2)}</span>;
}

const HOUR = 3_600_000;
const num = (v: number, digits = 2) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: digits }).format(v);

/** Units by naming convention (usedPercentage, queryLatencyMs, heapUsedMb, freeSpaceGb, …). */
export function formatMetric(key: string, v: number): string {
  const leaf = key.split(".").pop() ?? key;
  if (/percent(age)?$/i.test(leaf)) return `${num(v, 1)} %`;
  if (/ms$/i.test(leaf)) return formatDuration(v);
  if (/mb$/i.test(leaf)) return `${num(v, 0)} MB`;
  if (/gb$/i.test(leaf)) return `${num(v, 1)} GB`;
  if (/bytes$/i.test(leaf) || (/^(free|total|threshold)$/.test(leaf) && v >= 1e6)) return `${num(v / 1e9, 1)} GB`;
  return num(v);
}

/** Components and figures of the newest health reading, with the hourly trend of each figure. */
function HealthCards(props: { at: string; details: HealthDetails; hours: { hour: string; key: string; v: number }[] }) {
  const { details } = props;
  const end = Math.floor(Date.now() / HOUR) * HOUR;
  const slots = Array.from({ length: 24 }, (_, i) => end - (23 - i) * HOUR);
  const trend = new Map<string, Map<number, number>>();
  for (const r of props.hours) {
    if (!trend.has(r.key)) trend.set(r.key, new Map());
    trend.get(r.key)!.set(new Date(r.hour).getTime(), Number(r.v));
  }
  // jsonb returns keys in its own order; sorted, the figures of one component stay together.
  const metrics = Object.entries(details.metrics ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      {details.components?.length > 0 && (
        <Card title="Komponenten" description={<>Stand <Ago at={props.at} />, wie die Anwendung sie selbst meldet.</>} flush>
          <div class="table-wrap"><table>
            <thead><tr><th>Komponente</th><th>Status</th><th>Hinweise</th></tr></thead>
            <tbody>{details.components.map((p) => (
              <tr>
                <td class="mono small">{p.name}</td>
                <td><Badge tone={p.ok ? "ok" : "bad"} dot>{p.status}</Badge></td>
                <td class="small">{p.issues.length ? p.issues.join(" · ") : <span class="muted">keine</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}
      {metrics.length > 0 && (
        <Card title="Kennzahlen" description="Aktueller Wert und Stundenmittel der letzten 24 Stunden." flush>
          <div class="table-wrap"><table>
            <thead><tr><th>Kennzahl</th><th class="num">Aktuell</th><th>24 Stunden</th></tr></thead>
            <tbody>{metrics.map(([key, v]) => {
              const series = slots.map((t) => trend.get(key)?.get(t) ?? 0);
              return (
                <tr>
                  <td class="mono small">{key}</td>
                  <td class="num">{formatMetric(key, v)}</td>
                  <td><Sparkline values={series} label={`${key}, Stundenmittel der letzten 24 Stunden, zuletzt ${formatMetric(key, v)}`} /></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </Card>
      )}
    </>
  );
}

export function mountUptimeApi(app: Hono, sql: SQL = hubSql) {
  /** `msg` is shown with the monitor's state; "OK" is Kuma's default and says nothing. */
  const beat = (pattern: RegExp) => async (c: Context) => {
    const token = c.req.param("token") ?? "";
    if (!pattern.test(token)) return c.json({ ok: false }, 404);
    // A job reporting its own failure (Kuma `status=down`) has not run through: no signal, so the monitor goes down on time.
    if (c.req.query("status") === "down") return c.json({ ok: true });
    const msg = c.req.query("msg")?.trim();
    const [row] = (await sql`select ingest_heartbeat(${sha256Hex(token)}, ${msg && msg !== "OK" ? msg : null}) as ok`) as { ok: boolean }[];
    return row?.ok ? c.json({ ok: true }) : c.json({ ok: false }, 404);
  };
  // Push monitors: `curl -fsS https://vantage…/api/v1/heartbeat/<token>` at the end of a cron job.
  const vantageBeat = beat(/^vhb_[A-Za-z0-9_-]{43}$/);
  app.get("/api/v1/heartbeat/:token", vantageBeat);
  app.post("/api/v1/heartbeat/:token", vantageBeat);
  // Uptime Kuma's push path and token format, for monitors taken over from Kuma: the jobs keep their URL.
  const kumaBeat = beat(/^[A-Za-z0-9]{8,64}$/);
  app.get("/api/push/:token", kumaBeat);
  app.post("/api/push/:token", kumaBeat);
}

export function mountUptime(app: Hono) {
  registerSettingsSection(20, monitorSettings);

  app.get("/env/:id/uptime", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const { monitors, checks } = await rls(c, async (tx) => ({
      monitors: await monitorsWithStats(tx, env.id),
      checks: await recentChecks(tx, env.id),
    }));
    const up = monitors.filter((m) => m.status === "up").length;
    const down = monitors.filter((m) => m.status === "down").length;
    const avg30 = monitors.filter((m) => m.u30 !== null);
    return c.html(
      <EnvShell c={c} env={env} tab="uptime" title="Uptime">
        <div class="stack" hx-get={`/env/${env.id}/uptime`} hx-trigger="every 30s" hx-select="#uptime-live" hx-target="#uptime-live" hx-swap="outerHTML">
          <div id="uptime-live" class="stack">
            <div class="grid grid-4">
              <Stat label="Monitore" value={monitors.length} />
              <Stat label="Up" value={up} tone={up ? "ok" : undefined} />
              <Stat label="Down" value={down} tone={down ? "bad" : "ok"} />
              <Stat label="Uptime 30 Tage" value={avg30.length ? formatPercent(avg30.reduce((n, m) => n + Number(m.u30), 0) / avg30.length) : "–"} hint="Durchschnitt aller Monitore" />
            </div>
            <Card title="Monitore" flush>
              {monitors.length === 0 ? (
                <Empty title="Keine Monitore">{c.get("user").isAdmin ? <a href={`/env/${env.id}/settings#monitors`}>In den Einstellungen anlegen</a> : "Systaro hat für diese Umgebung noch keine Monitore eingerichtet."}</Empty>
              ) : (
                <div class="table-wrap"><table>
                  <thead><tr><th>Monitor</th><th>Status</th><th class="num">24 h</th><th class="num">7 Tage</th><th class="num">30 Tage</th><th class="num">Antwortzeit</th><th>Letzte 60 Prüfungen</th></tr></thead>
                  <tbody>{monitors.map((m) => {
                    const cells = checks.filter((k) => k.monitor_id === m.id).map((k) => ({
                      tone: (k.ok ? "ok" : "bad") as "ok" | "bad",
                      title: `${formatDate(k.at)} – ${k.ok ? "ok" : "Fehler"}: ${k.message}`,
                    }));
                    return (
                      <tr>
                        <td>
                          <a href={`/env/${env.id}/uptime/${m.id}`}>{m.name}</a>
                          <div class="muted small">{KIND_LABEL[m.kind]} · {target(m.kind, m.config)}{m.runner_id && " · über Runner"}</div>
                        </td>
                        <td>
                          <StatusBadge status={m.status} /><div class="muted small">seit <Ago at={m.since} /></div>
                          {checkOverdue(m) && <div class="status-warn small">letzte Prüfung <Ago at={m.last_check_at} /></div>}
                        </td>
                        <td class="num"><Uptime value={m.u24} /></td>
                        <td class="num"><Uptime value={m.u7} /></td>
                        <td class="num"><Uptime value={m.u30} /></td>
                        <td class="num">{m.lat24 !== null ? formatDuration(Number(m.lat24)) : "–"}</td>
                        <td class="strip-cell"><StatusStrip cells={cells} slots={60} label={`Letzte Prüfungen von ${m.name}`} /></td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              )}
            </Card>
          </div>
        </div>
      </EnvShell>,
    );
  });

  app.get("/env/:id/uptime/:monitorId", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    const monitorId = parseId(c.req.param("monitorId"));
    if (!env || !monitorId) return c.notFound();
    const data = await rls(c, async (tx) => ({
      monitor: (await monitorsWithStats(tx, env.id)).find((m) => m.id === monitorId),
      latency: await all<{ bucket: string; lat: number | null; fails: number }>(tx`
        select date_trunc('hour', at) + floor(extract(minute from at) / 15) * interval '15 minutes' as bucket,
               avg(latency_ms) filter (where ok) as lat, count(*) filter (where not ok)::int as fails
        from monitor_checks where monitor_id = ${monitorId} and at > now() - interval '24 hours'
        group by 1 order by 1`),
      daily: await all<{ day: string; ratio: number; total: number }>(tx`
        select date_trunc('day', at at time zone 'Europe/Berlin') as day, 100.0 * avg(case when ok then 1 else 0 end) as ratio, count(*)::int as total
        from monitor_checks where monitor_id = ${monitorId} and at > now() - interval '30 days'
        group by 1 order by 1`),
      checks: await all<any>(tx`select at, ok, latency_ms, status_code, message from monitor_checks where monitor_id = ${monitorId} order by at desc limit 25`),
      incidents: await all<any>(tx`select opened_at, resolved_at, title from incidents where subject_key = ${`monitor:${monitorId}`} order by opened_at desc limit 20`),
      health: await latestHealth(tx, monitorId),
      healthHours: await all<{ hour: string; key: string; v: number }>(tx`
        select date_trunc('hour', c.at) as hour, kv.key, avg((kv.value)::text::numeric)::float8 as v
        from monitor_checks c, jsonb_each(c.details -> 'metrics') kv
        where c.monitor_id = ${monitorId} and c.at > now() - interval '24 hours' and c.details is not null
          and jsonb_typeof(kv.value) = 'number'
        group by 1, 2`),
    }));
    const m = data.monitor;
    if (!m) return c.notFound();
    const points = latencyBuckets(data.latency);
    const dailyCells = data.daily.map((d) => ({
      tone: (Number(d.ratio) >= 99.9 ? "ok" : Number(d.ratio) >= 99 ? "warn" : "bad") as "ok" | "warn" | "bad",
      title: `${formatDay(d.day)}: ${formatPercent(Number(d.ratio))} (${d.total} Prüfungen)`,
    }));
    return c.html(
      <EnvShell c={c} env={env} tab="uptime" title={m.name}>
        <div class="stack">
          <div class="row-between">
            <h2 class="row">{m.name} <StatusBadge status={m.status} /></h2>
            <span class="muted small">{KIND_LABEL[m.kind]} · {target(m.kind, m.config)} · alle {m.interval_seconds} s</span>
          </div>
          {m.last_message && <p class={m.status === "down" ? "status-bad" : "muted"}>{m.last_message} (<Ago at={m.last_check_at} />)</p>}
          <div class="grid grid-4">
            <Stat label="Uptime 24 h" value={<Uptime value={m.u24} />} />
            <Stat label="Uptime 7 Tage" value={<Uptime value={m.u7} />} />
            <Stat label="Uptime 30 Tage" value={<Uptime value={m.u30} />} />
            {m.kind === "tls" ? (
              <Stat label="Zertifikat" value={m.tls_days_left !== null ? `${m.tls_days_left} Tage` : "–"} tone={m.tls_days_left !== null && m.tls_days_left < 14 ? "warn" : undefined} />
            ) : (
              <Stat label="Antwortzeit 24 h" value={m.lat24 !== null ? formatDuration(Number(m.lat24)) : "–"} hint="Mittel erfolgreicher Prüfungen" />
            )}
          </div>
          {points.some((p) => p.v !== null) && (
            <Card title="Antwortzeit, letzte 24 Stunden">
              <TimeChart kind="line" points={points} bucketMs={QUARTER_HOUR} format={(v) => formatDuration(v)} label={`Antwortzeit von ${m.name}`} />
            </Card>
          )}
          {m.kind === "health" && data.health && <HealthCards at={data.health.at} details={data.health.details} hours={data.healthHours} />}
          <Card title="Verfügbarkeit pro Tag, letzte 30 Tage">
            <StatusStrip cells={dailyCells} slots={30} label="Verfügbarkeit pro Tag" />
            <div class="legend"><span><span class="badge ok">≥ 99,9 %</span></span><span><span class="badge warn">≥ 99 %</span></span><span><span class="badge bad">darunter</span></span></div>
          </Card>
          {data.incidents.length > 0 && (
            <Card title="Ausfälle" flush>
              <div class="table-wrap"><table>
                <thead><tr><th>Beginn</th><th>Ende</th><th class="num">Dauer</th></tr></thead>
                <tbody>{data.incidents.map((i) => (
                  <tr>
                    <td>{formatDate(i.opened_at)}</td>
                    <td>{i.resolved_at ? formatDate(i.resolved_at) : <Badge tone="bad">läuft</Badge>}</td>
                    <td class="num">{formatDuration((i.resolved_at ? new Date(i.resolved_at).getTime() : Date.now()) - new Date(i.opened_at).getTime())}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </Card>
          )}
          <Card title="Letzte 25 Prüfungen" flush>
            <div class="table-wrap"><table>
              <thead><tr><th>Zeit</th><th>Ergebnis</th><th class="num">Antwortzeit</th><th>Meldung</th></tr></thead>
              <tbody>{data.checks.map((k) => (
                <tr>
                  <td class="nowrap">{formatDate(k.at)}</td>
                  <td>{k.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="bad">Fehler</Badge>}</td>
                  <td class="num">{k.latency_ms !== null ? formatDuration(k.latency_ms) : "–"}</td>
                  <td class="small">{k.message}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
        </div>
      </EnvShell>,
    );
  });

  app.post("/env/:id/monitors", async (c) => {
    const envId = parseId(c.req.param("id"));
    if (!envId || !c.get("user").isAdmin) return c.notFound();
    const f = await formData(c);
    const parsed = await parseMonitorForm(f, null);
    if ("error" in parsed) return redirectWith(c, `/env/${envId}/settings#monitors`, { kind: "bad", text: parsed.error });
    let heartbeatToken: string | null = null;
    if (parsed.kind === "heartbeat") heartbeatToken = newToken("vhb");
    const row = await rls(c, async (tx) => {
      const runnerId = await chosenRunner(tx, envId, f.get("runner_id"), parsed.kind);
      if (typeof runnerId === "object" && runnerId !== null) return runnerId;
      return first<{ id: number }>(tx`
        insert into monitors (environment_id, name, kind, config, interval_seconds, timeout_ms, retries, retry_interval_seconds, enabled, heartbeat_token_hash, runner_id)
        values (${envId}, ${parsed.name}, ${parsed.kind}, ${parsed.config}::jsonb, ${parsed.interval}, ${parsed.timeout}, ${parsed.retries}, ${parsed.retryInterval}, true,
                ${heartbeatToken ? sha256Hex(heartbeatToken) : null}, ${runnerId})
        returning id`);
    });
    if (!row) return c.notFound();
    if ("error" in row) return redirectWith(c, `/env/${envId}/settings#monitors`, { kind: "bad", text: row.error });
    await audit(c, "monitor.created", String(row.id), { environment_id: envId, kind: parsed.kind });
    if (heartbeatToken) return showDialogStep(c, { title: `„${parsed.name}“ angelegt`, body: <HeartbeatUrlStep url={heartbeatUrl(heartbeatToken)} /> });
    return redirectWith(c, `/env/${envId}/settings#monitors`, { kind: "ok", text: "Monitor angelegt. Die erste Prüfung läuft in wenigen Sekunden." });
  });

  app.post("/env/:id/monitors/:monitorId", async (c) => {
    const envId = parseId(c.req.param("id"));
    const monitorId = parseId(c.req.param("monitorId"));
    if (!envId || !monitorId || !c.get("user").isAdmin) return c.notFound();
    const f = await formData(c);
    const existing = await rls(c, (tx) => first<any>(tx`select kind, config from monitors where id = ${monitorId} and environment_id = ${envId}`));
    if (!existing) return c.notFound();
    if (f.get("action") === "toggle") {
      await rls(c, (tx) => tx`update monitors set enabled = not enabled where id = ${monitorId}`);
      await audit(c, "monitor.toggled", String(monitorId));
      return redirectWith(c, `/env/${envId}/settings#monitors`, { kind: "ok", text: "Gespeichert." });
    }
    if (f.get("action") === "delete") {
      await rls(c, (tx) => tx`delete from monitors where id = ${monitorId}`);
      await audit(c, "monitor.deleted", String(monitorId));
      return redirectWith(c, `/env/${envId}/settings#monitors`, { kind: "ok", text: "Monitor gelöscht." });
    }
    if (f.get("action") === "rotate" && existing.kind === "heartbeat") {
      const token = newToken("vhb");
      await rls(c, (tx) => tx`update monitors set heartbeat_token_hash = ${sha256Hex(token)} where id = ${monitorId}`);
      await audit(c, "monitor.heartbeat_rotated", String(monitorId));
      return showDialogStep(c, { title: "Neue Heartbeat-URL", icon: "refresh-cw", body: <HeartbeatUrlStep url={heartbeatUrl(token)} /> });
    }
    const parsed = await parseMonitorForm(f, existing);
    if ("error" in parsed) return redirectWith(c, `/env/${envId}/settings#monitors`, { kind: "bad", text: parsed.error });
    const problem = await rls(c, async (tx) => {
      const runnerId = await chosenRunner(tx, envId, f.get("runner_id"), parsed.kind);
      if (typeof runnerId === "object" && runnerId !== null) return runnerId.error;
      await tx`update monitors set name = ${parsed.name}, config = ${parsed.config}::jsonb, interval_seconds = ${parsed.interval}, timeout_ms = ${parsed.timeout},
                 retries = ${parsed.retries}, retry_interval_seconds = ${parsed.retryInterval}, runner_id = ${runnerId} where id = ${monitorId}`;
      return null;
    });
    if (problem) return redirectWith(c, `/env/${envId}/settings#monitors`, { kind: "bad", text: problem });
    await audit(c, "monitor.updated", String(monitorId));
    return redirectWith(c, `/env/${envId}/settings#monitors`, { kind: "ok", text: "Monitor gespeichert." });
  });
}

type MonitorForm = { name: string; kind: string; config: Record<string, unknown>; interval: number; timeout: number; retries: number; retryInterval: number | null };

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const HEADER_LINE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*([\x20-\x7e]*)$/;

/** "Name: Wert" per line → header object, or an error. */
export function parseHeaderLines(text: string): Record<string, string> | { error: string } {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = HEADER_LINE.exec(line);
    if (!m) return { error: `Header „${line.slice(0, 40)}“: bitte als „Name: Wert“ mit sichtbaren ASCII-Zeichen.` };
    headers[m[1]!] = m[2]!.trim();
  }
  return Object.keys(headers).length > 30 ? { error: "Höchstens 30 Header." } : headers;
}

/** An encrypted secret from a form: a new value replaces it, a ticked "remove" drops it, empty keeps it. */
async function secretField(value: string, remove: boolean, existing: string | undefined): Promise<string | undefined> {
  if (value) return encryptString(hubConfig.secret, value);
  return remove ? undefined : existing;
}

async function parseHttpForm(f: { get(k: string): string }, existing: any): Promise<Record<string, unknown> | { error: string }> {
  const url = f.get("url");
  if (!/^https?:\/\/[^\s]+$/.test(url)) return { error: "Die URL muss mit http:// oder https:// beginnen." };
  const method = ["GET", "HEAD", "POST"].includes(f.get("method")) ? f.get("method") : "GET";
  const expectStatus = f.get("expect_status") || "200-299";
  if (!/^\d{3}(-\d{3})?(,\s*\d{3}(-\d{3})?)*$/.test(expectStatus)) return { error: "Erwartete Statuscodes z. B. als 200-299 oder 200,301 angeben." };
  const body = method === "POST" ? f.get("body") : "";
  if (body.length > 65_536) return { error: "Der Anfrage-Inhalt ist zu lang (höchstens 64 KB)." };
  let headersJson = "";
  if (f.get("headers").trim()) {
    const headers = parseHeaderLines(f.get("headers"));
    if ("error" in headers) return headers;
    headersJson = JSON.stringify(headers);
  }
  const query = f.get("secret_query").replace(/^\?/, "");
  if (query && !/^[^\s#]{1,2000}$/.test(query)) return { error: "Die geheimen Query-Parameter dürfen keine Leerzeichen enthalten, z. B. key=…&lang=de." };
  const jsonPath = f.get("json_path").trim();
  let json: { path: string; op: JsonOp; expected: string } | undefined;
  if (jsonPath) {
    if (!/^[\w$.[\]-]{1,200}$/.test(jsonPath)) return { error: "Den JSON-Pfad als a.b oder a.b[0].c angeben." };
    const op = (JSON_OPS as readonly string[]).includes(f.get("json_op")) ? (f.get("json_op") as JsonOp) : "==";
    json = { path: jsonPath, op, expected: f.get("json_expected").slice(0, 200) };
  }
  const watchCert = url.startsWith("https:") && f.get("tls_expiry") === "1";
  return {
    url,
    method,
    expectStatus,
    keyword: f.get("keyword") || undefined,
    followRedirects: f.get("follow_redirects") !== "0",
    body: body || undefined,
    headersEnc: await secretField(headersJson, f.get("headers_clear") === "1", existing?.headersEnc),
    queryEnc: await secretField(query, f.get("secret_query_clear") === "1", existing?.queryEnc),
    json,
    tlsExpiry: watchCert || undefined,
    warnDays: watchCert ? clampInt(f.get("warn_days"), 1, 90, 14) : undefined,
    critDays: watchCert ? clampInt(f.get("crit_days"), 0, 60, 3) : undefined,
  };
}

/** Validates the form per kind. On edit the kind cannot change; secrets are kept if left empty. */
export async function parseMonitorForm(f: { get(k: string): string }, existing: { kind: string; config: any } | null): Promise<MonitorForm | { error: string }> {
  const name = f.get("name");
  if (!name || name.length > 200) return { error: "Der Name fehlt oder ist zu lang." };
  const kind = existing?.kind ?? f.get("kind");
  if (!KIND_LABEL[kind]) return { error: "Unbekannte Monitor-Art." };
  const interval = clampInt(f.get("interval_seconds"), 30, 86400, 60);
  const timeout = clampInt(f.get("timeout_ms"), 500, 60000, 10000);
  const retries = clampInt(f.get("retries"), 0, 10, 1);
  const retryInterval = clampInt(f.get("retry_interval_seconds"), 10, 3600, 20);
  let config: Record<string, unknown>;
  switch (kind) {
    case "http": {
      const http = await parseHttpForm(f, existing?.config);
      if ("error" in http) return http as { error: string };
      config = http;
      break;
    }
    case "tcp": {
      const host = f.get("host");
      const port = clampInt(f.get("port"), 1, 65535, 0);
      if (!HOST_RE.test(host) || !port) return { error: "Host und Port prüfen." };
      config = { host, port };
      break;
    }
    case "dns": {
      const dnsName = f.get("dns_name");
      const type = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"].includes(f.get("record_type")) ? f.get("record_type") : "A";
      if (!HOST_RE.test(dnsName)) return { error: "Der DNS-Name ist ungültig." };
      config = { name: dnsName, type, expect: f.get("expect") || undefined };
      break;
    }
    case "tls": {
      const host = f.get("host");
      if (!HOST_RE.test(host)) return { error: "Der Host ist ungültig." };
      config = { host, port: clampInt(f.get("port"), 1, 65535, 443), warnDays: clampInt(f.get("warn_days"), 1, 90, 14), critDays: clampInt(f.get("crit_days"), 0, 60, 3) };
      break;
    }
    case "heartbeat":
      config = { graceSeconds: clampInt(f.get("grace_seconds"), 0, 86400, 60) };
      break;
    case "health": {
      const url = f.get("url");
      if (!/^https?:\/\/[^\s]+$/.test(url)) return { error: "Die URL muss mit http:// oder https:// beginnen." };
      const header = f.get("auth_header");
      if (header && !/^[\x21-\x7e][\x20-\x7e]*$/.test(header)) return { error: "Der Authorization-Header darf nur sichtbare ASCII-Zeichen enthalten." };
      const authEnc = header ? await encryptString(hubConfig.secret, header) : existing?.config?.authEnc;
      config = authEnc ? { url, authEnc } : { url };
      break;
    }
    case "kuma": {
      const baseUrl = f.get("base_url");
      if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) return { error: "Die Uptime-Kuma-URL muss mit http:// oder https:// beginnen." };
      const apiKey = f.get("api_key");
      const apiKeyEnc = apiKey ? await encryptString(hubConfig.secret, apiKey) : existing?.config?.apiKeyEnc;
      if (!apiKeyEnc) return { error: "Der API-Schlüssel für Uptime Kuma fehlt." };
      if (!f.get("monitor_name")) return { error: "Der Monitor-Name in Uptime Kuma fehlt." };
      config = { baseUrl, apiKeyEnc, monitorName: f.get("monitor_name") };
      break;
    }
    default:
      return { error: "Unbekannte Monitor-Art." };
  }
  // Taken over from Uptime Kuma: the id lets a later import run recognise the monitor.
  if (existing?.config?.kumaId) config.kumaId = existing.config.kumaId;
  return { name, kind, config, interval, timeout, retries, retryInterval: retryInterval === 20 ? null : retryInterval };
}

function KindFields(props: { kind: string; cfg?: any }) {
  const cfg = props.cfg ?? {};
  switch (props.kind) {
    case "http":
      return <HttpFields cfg={cfg} />;
    case "tcp":
      return (
        <div class="fields">
          <Field label="Host"><input name="host" type="text" required value={cfg.host ?? ""} /></Field>
          <Field label="Port"><input name="port" type="number" min="1" max="65535" required value={cfg.port ? String(cfg.port) : ""} /></Field>
        </div>
      );
    case "dns":
      return (
        <div class="fields">
          <Field label="Name"><input name="dns_name" type="text" required value={cfg.name ?? ""} /></Field>
          <Field label="Typ"><select name="record_type">{["A", "AAAA", "CNAME", "MX", "TXT", "NS"].map((t) => <option selected={cfg.type === t}>{t}</option>)}</select></Field>
          <Field label="Erwarteter Wert (optional)"><input name="expect" type="text" value={cfg.expect ?? ""} /></Field>
        </div>
      );
    case "tls":
      return (
        <div class="fields">
          <Field label="Host"><input name="host" type="text" required value={cfg.host ?? ""} /></Field>
          <Field label="Port"><input name="port" type="number" value={String(cfg.port ?? 443)} /></Field>
          <Field label="Warnung ab (Tage)"><input name="warn_days" type="number" value={String(cfg.warnDays ?? 14)} /></Field>
          <Field label="Down ab (Tage)"><input name="crit_days" type="number" value={String(cfg.critDays ?? 3)} /></Field>
        </div>
      );
    case "heartbeat":
      return (
        <div class="fields">
          <Field label="Toleranz (Sekunden)" hint="Zusätzlich zum Intervall, bevor der Monitor als down gilt."><input name="grace_seconds" type="number" value={String(cfg.graceSeconds ?? 60)} /></Field>
        </div>
      );
    case "health":
      return (
        <div class="fields">
          <Field label="URL der Statusseite"><input name="url" type="url" required value={cfg.url ?? ""} placeholder="https://…/api/health" /></Field>
          <Field label="Authorization-Header (optional)" hint={cfg.authEnc ? "Leer lassen, um den gespeicherten zu behalten." : "Nur wenn die Seite eine Anmeldung verlangt, z. B. „Basic …“ oder „Bearer …“."}>
            <input name="auth_header" type="password" autocomplete="off" />
          </Field>
        </div>
      );
    case "kuma":
      return (
        <div class="fields">
          <Field label="Uptime-Kuma-URL"><input name="base_url" type="url" required value={cfg.baseUrl ?? ""} placeholder="https://status.example" /></Field>
          <Field label="API-Schlüssel" hint={cfg.apiKeyEnc ? "Leer lassen, um den gespeicherten zu behalten." : "In Uptime Kuma unter Einstellungen → API-Schlüssel."}><input name="api_key" type="password" autocomplete="off" /></Field>
          <Field label="Monitor-Name in Kuma"><input name="monitor_name" type="text" required value={cfg.monitorName ?? ""} /></Field>
        </div>
      );
    default:
      return null;
  }
}

function HttpFields(props: { cfg: any }) {
  const cfg = props.cfg;
  const keep = "Gespeichert und verschlüsselt. Leer lassen, um es zu behalten.";
  return (
    <>
      <div class="fields">
        <Field label="URL"><input name="url" type="url" required value={cfg.url ?? ""} placeholder="https://…/health" /></Field>
        <Field label="Methode"><select name="method">{["GET", "HEAD", "POST"].map((m) => <option selected={cfg.method === m}>{m}</option>)}</select></Field>
        <Field label="Erwartete Statuscodes"><input name="expect_status" type="text" value={cfg.expectStatus ?? "200-299"} /></Field>
        <Field label="Stichwort im Inhalt (optional)"><input name="keyword" type="text" value={cfg.keyword ?? ""} /></Field>
        <Field label="Weiterleitungen"><select name="follow_redirects"><option value="1" selected={cfg.followRedirects !== false}>folgen</option><option value="0" selected={cfg.followRedirects === false}>nicht folgen</option></select></Field>
      </div>
      <label class="check"><input type="checkbox" name="tls_expiry" value="1" checked={!!cfg.tlsExpiry} /> Zertifikat überwachen (nur https)</label>
      <div class="fields">
        <Field label="Warnung ab (Tage)"><input name="warn_days" type="number" value={String(cfg.warnDays ?? 14)} /></Field>
        <Field label="Kritisch ab (Tage)"><input name="crit_days" type="number" value={String(cfg.critDays ?? 3)} /></Field>
      </div>
      <details class="disclosure" open={!!(cfg.json || cfg.body || cfg.headersEnc || cfg.queryEnc)}>
        <summary><span class="chev"><Icon name="chevron-right" /></span>JSON-Wert, Header und Anfrage-Inhalt</summary>
        <div class="stack">
          <div class="fields">
            <Field label="JSON-Pfad (optional)" hint="Prüft einen Wert der Antwort, z. B. status oder queue.size."><input name="json_path" type="text" value={cfg.json?.path ?? ""} placeholder="status" /></Field>
            <Field label="Vergleich"><select name="json_op">{JSON_OPS.map((o) => <option value={o} selected={(cfg.json?.op ?? "==") === o}>{o === "contains" ? "enthält" : o}</option>)}</select></Field>
            <Field label="Erwarteter Wert"><input name="json_expected" type="text" value={cfg.json?.expected ?? ""} placeholder="OK" /></Field>
          </div>
          <Field label="Header (optional)" hint={cfg.headersEnc ? keep : "Ein Header pro Zeile, „Name: Wert“. Wird verschlüsselt gespeichert und nicht wieder angezeigt."}>
            <textarea name="headers" rows={3} placeholder="X-Auth-Token: …" autocomplete="off" />
          </Field>
          {cfg.headersEnc && <label class="check"><input type="checkbox" name="headers_clear" value="1" /> Gespeicherte Header entfernen</label>}
          <Field label="Geheime Query-Parameter (optional)" hint={cfg.queryEnc ? keep : "Werden an die URL gehängt, etwa ein API-Schlüssel (key=…). Verschlüsselt gespeichert, die URL oben bleibt ohne sie."}>
            <input name="secret_query" type="password" autocomplete="off" placeholder="key=…" />
          </Field>
          {cfg.queryEnc && <label class="check"><input type="checkbox" name="secret_query_clear" value="1" /> Gespeicherte Query-Parameter entfernen</label>}
          <Field label="Anfrage-Inhalt bei POST (optional)" hint="JSON wird als application/json geschickt, wenn kein Content-Type-Header gesetzt ist.">
            <textarea name="body" rows={4}>{cfg.body ?? ""}</textarea>
          </Field>
        </div>
      </details>
    </>
  );
}

/** The runner a monitor form picked: null for Vantage itself, else one the environment may use. Runs inside rls(). */
async function chosenRunner(tx: any, envId: number, raw: string, kind: string): Promise<number | null | { error: string }> {
  if (!raw) return null;
  if (!(RUNNER_MONITOR_KINDS as readonly string[]).includes(kind)) return { error: "Diese Monitor-Art läuft nicht auf einem Runner." };
  const id = Number(raw);
  const env = await first<{ org_id: number }>(tx`select p.organisation_id as org_id from environments e join projects p on p.id = e.project_id where e.id = ${envId}`);
  const ok = Number.isInteger(id) && env && (await runnersForOrg(tx, env.org_id)).some((r) => r.id === id);
  return ok ? id : { error: "Diesen Runner gibt es für den Kunden nicht." };
}

function RunnerField(props: { runners: { id: number; name: string; system: boolean }[]; selected?: number | null }) {
  return (
    <Field label="Geprüft von" hint="Ein Runner prüft aus seinem eigenen Netz, etwa Dienste beim Kunden hinter einem VPN.">
      <select name="runner_id">
        <option value="">Vantage, aus dem Internet</option>
        {props.runners.map((r) => <option value={String(r.id)} selected={props.selected === r.id}>{runnerOptionLabel(r)}</option>)}
      </select>
    </Field>
  );
}

function CommonFields(props: { interval?: number; timeout?: number; retries?: number; retryInterval?: number | null; kind?: string }) {
  return (
    <div class="fields">
      <Field label={props.kind === "heartbeat" ? "Erwartetes Intervall (s)" : "Intervall (s)"}><input name="interval_seconds" type="number" min="30" value={String(props.interval ?? 60)} /></Field>
      {props.kind !== "heartbeat" && <Field label="Zeitlimit (ms)"><input name="timeout_ms" type="number" min="500" value={String(props.timeout ?? 10000)} /></Field>}
      <Field label="Toleranz (Fehlversuche)" hint="So viele Fehler in Folge, bevor „down“ gemeldet wird."><input name="retries" type="number" min="0" max="10" value={String(props.retries ?? 1)} /></Field>
      <Field label="Abstand der Wiederholungen (s)" hint="Nach einem Fehler wird so bald erneut geprüft, höchstens im normalen Intervall."><input name="retry_interval_seconds" type="number" min="10" max="3600" value={String(props.retryInterval ?? 20)} /></Field>
    </div>
  );
}

const KIND_CHOICE: Record<string, { text: string; icon: IconName }> = {
  http: { text: "Ruft eine URL auf und prüft Statuscode, optional ein Stichwort, einen JSON-Wert und das Zertifikat.", icon: "globe" },
  tcp: { text: "Prüft, ob ein Port Verbindungen annimmt, etwa eine Datenbank.", icon: "network" },
  dns: { text: "Löst einen Namen auf und vergleicht auf Wunsch den Wert.", icon: "signpost" },
  tls: { text: "Warnt rechtzeitig, bevor ein Zertifikat abläuft.", icon: "shield-check" },
  heartbeat: { text: "Ein Job meldet sich selbst. Bleibt die Meldung aus, gilt er als down.", icon: "heart-pulse" },
  kuma: { text: "Übernimmt den Status eines Monitors aus Uptime Kuma.", icon: "activity" },
  health: { text: "Liest die Statusseite der Anwendung (etwa /api/health oder /actuator/health): Gesamtstatus, Komponenten und Kennzahlen wie Speicher und Plattenplatz.", icon: "stethoscope" },
};

function intervalText(seconds: number): string {
  return seconds % 3600 === 0 ? `${seconds / 3600} h` : seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

function heartbeatUrl(token: string): string {
  return `${hubConfig.publicUrl}/api/v1/heartbeat/${token}`;
}

/** The secret heartbeat URL, shown once after creating the monitor or replacing the URL. */
function HeartbeatUrlStep(props: { url: string }) {
  return (
    <>
      <p>Der Job ruft diese URL am Ende jedes erfolgreichen Laufs auf. Sie wird nur jetzt angezeigt.</p>
      <SecretBox id="heartbeat-url" value={props.url} />
      <p class="muted small">Zum Beispiel: <code>curl -fsS --retry 3 &lt;URL&gt;</code></p>
    </>
  );
}

async function monitorSettings(c: Context, env: EnvContext) {
  const { monitors, runners } = await rls(c, async (tx) => ({
    monitors: await all<any>(tx`
      select m.id, m.name, m.kind, m.config, m.interval_seconds, m.timeout_ms, m.retries, m.retry_interval_seconds, m.enabled, m.runner_id,
             r.name as runner_name, s.status
      from monitors m join monitor_state s on s.monitor_id = m.id left join runners r on r.id = m.runner_id
      where m.environment_id = ${env.id} order by m.name`),
    runners: await runnersForOrg(tx, env.orgId),
  }));
  const onRunner = (kind: string) => runners.length > 0 && (RUNNER_MONITOR_KINDS as readonly string[]).includes(kind);
  const base = `/env/${env.id}/monitors`;
  const newButton = (primary: boolean) => <DialogButton dialog="new-monitor" icon="plus" class={primary ? "primary" : "small"}>Monitor anlegen</DialogButton>;
  return (
    <Card title="Monitore" id="monitors" description="Prüfen Erreichbarkeit, Ports, DNS, Zertifikate und Jobs dieser Umgebung." actions={monitors.length > 0 && newButton(false)} flush={monitors.length > 0}>
      {monitors.length === 0 ? (
        <Empty title="Noch keine Monitore" icon="heart-pulse" action={newButton(true)}>Ein Monitor prüft regelmäßig, ob ein Teil dieser Umgebung funktioniert, und meldet Ausfälle.</Empty>
      ) : (
        <div class="table-wrap">
          <table>
            <thead><tr><th>Monitor</th><th>Art</th><th>Intervall</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {monitors.map((m) => (
                <tr>
                  <td>
                    <span class="cell-title">{m.name}</span><span class="cell-sub mono">{target(m.kind, m.config)}</span>
                    {m.runner_name && <span class="cell-sub">über Runner „{m.runner_name}“</span>}
                  </td>
                  <td class="nowrap">{KIND_LABEL[m.kind]}</td>
                  <td class="nowrap">{intervalText(m.interval_seconds)}</td>
                  <td><StatusBadge status={m.enabled ? m.status : "paused"} /></td>
                  <td class="right">
                    <div class="btn-group">
                      <DialogButton dialog={`edit-monitor-${m.id}`} icon="pencil" class="small">Bearbeiten</DialogButton>
                      <ActionButton action={`${base}/${m.id}`} label={m.enabled ? "Pausieren" : "Fortsetzen"} icon={m.enabled ? "pause" : "play"} small fields={{ action: "toggle" }} />
                      {m.kind === "heartbeat" && <DialogButton dialog={`rotate-monitor-${m.id}`} icon="refresh-cw" class="small">Neue URL</DialogButton>}
                      <ConfirmAction action={`${base}/${m.id}`} label="Löschen" question="Monitor mit allen Prüfungen löschen?" fields={{ action: "delete" }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ChoiceDialog
        id="new-monitor"
        title="Monitor anlegen"
        description="Was soll Vantage prüfen?"
        icon="heart-pulse"
        choices={Object.entries(KIND_LABEL).map(([k, label]) => ({ dialog: `new-monitor-${k}`, label, text: KIND_CHOICE[k]!.text, icon: KIND_CHOICE[k]!.icon }))}
      />
      {Object.entries(KIND_LABEL).map(([k, label]) => (
        <FormDialog id={`new-monitor-${k}`} title={`${label}-Monitor anlegen`} description={KIND_CHOICE[k]!.text} icon={KIND_CHOICE[k]!.icon} action={base} submitLabel="Monitor anlegen" back="new-monitor">
          <input type="hidden" name="kind" value={k} />
          <Field label="Name"><input name="name" type="text" required maxlength={200} placeholder={k === "heartbeat" ? "Nächtliches Backup" : "Startseite"} /></Field>
          <KindFields kind={k} />
          {onRunner(k) && <RunnerField runners={runners} />}
          <CommonFields kind={k} />
          {k === "heartbeat" && <p class="muted small">Nach dem Anlegen erscheint eine geheime URL, die der Job am Ende jedes erfolgreichen Laufs aufruft.</p>}
        </FormDialog>
      ))}
      {monitors.map((m) => (
        <>
          <FormDialog id={`edit-monitor-${m.id}`} title={`„${m.name}“ bearbeiten`} description={KIND_LABEL[m.kind]} icon="pencil" action={`${base}/${m.id}`} submitLabel="Speichern">
            <Field label="Name"><input name="name" type="text" required maxlength={200} value={m.name} /></Field>
            <KindFields kind={m.kind} cfg={m.config} />
            {(onRunner(m.kind) || m.runner_id) && <RunnerField runners={runners} selected={m.runner_id} />}
            <CommonFields interval={m.interval_seconds} timeout={m.timeout_ms} retries={m.retries} retryInterval={m.retry_interval_seconds} kind={m.kind} />
          </FormDialog>
          {m.kind === "heartbeat" && (
            <FormDialog id={`rotate-monitor-${m.id}`} title="Neue Heartbeat-URL" icon="refresh-cw" action={`${base}/${m.id}`} submitLabel="Neue URL erzeugen" danger>
              <input type="hidden" name="action" value="rotate" />
              <p>Die bisherige URL von „{m.name}“ wird sofort ungültig. Bis der Job die neue URL aufruft, kann der Monitor als down gelten.</p>
            </FormDialog>
          )}
        </>
      ))}
    </Card>
  );
}
