import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parseId, redirectWith } from "../../shared/http";
import { Ago, Badge, Card, Empty, formatDate, formatDuration, PageHead, StatusBanner, Tabs } from "../../shared/ui/components";
import { Icon } from "../../shared/ui/icons";
import { ACTIVE, type RunStatus } from "../ansible/runner";
import { all, first } from "../../shared/db";
import { can } from "../roles";
import type { Ops } from "../service";
import { actor, audit, OpsPage, RunBadge } from "../ui";
import { RunsTable } from "./templates";

const PAGE = 50;
/** A finished run's page shows the tail of the log inline; the full file is a download. */
const INLINE_LOG_BYTES = 1024 * 1024;
const CHUNK = 64 * 1024;

const FILTERS: Record<string, RunStatus[]> = {
  active: ["queued", "running"],
  failed: ["failed", "error"],
};

export function mountRuns(app: Hono, ops: Ops) {
  app.get("/runs", async (c) => {
    const filter = c.req.query("filter") ?? "";
    const statuses = FILTERS[filter] ?? null;
    const before = parseId(c.req.query("before"));
    const runs = await all<any>(ops.sql`
      select id, template_id, template_name, status, trigger, started_by_label, queued_at, duration_ms, exit_code from runs
      where (${before}::int is null or id < ${before}::int)
        and (${statuses === null} or status = any(${ops.sql.array(statuses ?? ["-"], "text")}))
      order by id desc limit ${PAGE}`);
    const counts = await first<{ active: number; failed: number }>(ops.sql`
      select count(*) filter (where status in ('queued', 'running'))::int as active, count(*) filter (where status in ('failed', 'error'))::int as failed from runs`);
    const last = runs.at(-1);
    const emptyTitle = filter === "active" ? "Gerade läuft nichts" : filter === "failed" ? "Keine fehlgeschlagenen Läufe" : "Noch keine Läufe";
    return c.html(
      <OpsPage c={c} title="Läufe" section="runs">
        <PageHead
          icon="list-checks"
          title="Läufe"
          sub={`Jeder Start einer Ansible-Vorlage mit Log. Höchstens ${ops.runner.maxConcurrent} gleichzeitig, weitere warten. Logs werden 90 Tage aufbewahrt.`}
        />
        <Tabs items={[
          { href: "/runs", label: "Alle", icon: "list-checks", active: !statuses },
          { href: "/runs?filter=active", label: "Aktiv", icon: "play", count: counts?.active ?? 0, active: filter === "active" },
          { href: "/runs?filter=failed", label: "Fehlgeschlagen", icon: "circle-x", count: counts?.failed ?? 0, active: filter === "failed" },
        ]} />
        <Card flush>
          {runs.length === 0 ? (
            <Empty
              title={emptyTitle}
              icon={filter === "failed" ? "circle-check" : "list-checks"}
              action={filter !== "failed" && can(c.get("user"), "run") ? <a class="btn small" href="/templates">Zu den Vorlagen</a> : undefined}
            >
              {filter === "failed" ? "Kein Lauf ist mit einem Fehler beendet worden." : "Läufe entstehen, wenn eine Vorlage von Hand oder nach Zeitplan startet."}
            </Empty>
          ) : <RunsTable runs={runs} showTemplate />}
        </Card>
        {runs.length === PAGE && last && (
          <div class="ops-pager"><a class="btn" href={`/runs?filter=${filter}&before=${last.id}`}>Ältere Läufe<Icon name="arrow-right" size="sm" /></a></div>
        )}
      </OpsPage>,
    );
  });

  app.get("/runs/:id", async (c) => {
    const run = await loadRun(ops, c);
    if (!run) return c.notFound();
    const live = ACTIVE.includes(run.status);
    let log = "";
    let truncated = false;
    if (!live && !run.log_deleted_at) {
      const file = Bun.file(ops.runner.logPath(run.id));
      if (await file.exists()) {
        truncated = file.size > INLINE_LOG_BYTES;
        log = await file.slice(Math.max(0, file.size - INLINE_LOG_BYTES)).text();
      }
    }
    return c.html(
      <OpsPage c={c} title={`Lauf #${run.id} – ${run.template_name}`} section="runs" head={live ? <script src="/static/ops-log.js" defer></script> : undefined}>
        <PageHead
          icon="list-checks"
          title={`Lauf #${run.id}`}
          sub={<>Ansible-Vorlage {run.template_id ? <a href={`/templates/${run.template_id}`}>{run.template_name}</a> : run.template_name}</>}
          crumbs={[{ href: "/runs", label: "Läufe" }]}
        />
        <div class="stack">
          <RunSummary c={c} run={run} />
          <Card
            title={<h2 class="row"><Icon name="terminal" />Log{live && <span id="log-live" class="ops-live" title="Die Ausgabe erscheint, während der Lauf arbeitet."><span class="live-dot" />live</span>}</h2>}
            description={truncated ? "Gezeigt wird das letzte MB; das ganze Log gibt es als Download." : undefined}
            actions={!run.log_deleted_at && <a class="btn small" href={`/runs/${run.id}/log`}><Icon name="download" size="sm" />Herunterladen</a>}
            flush
          >
            {run.log_deleted_at ? (
              <Empty title="Log gelöscht" icon="file-text">Das Log wurde nach 90 Tagen gelöscht ({formatDate(run.log_deleted_at)}).</Empty>
            ) : live ? (
              <pre class="ops-log ops-term" data-run-stream={`/runs/${run.id}/stream`} aria-live="polite"></pre>
            ) : (
              <pre class="ops-log ops-term">{log || "(leer)"}</pre>
            )}
          </Card>
        </div>
      </OpsPage>,
    );
  });

  // The status block refreshes itself when ops-log.js reports the end of the stream.
  app.get("/runs/:id/summary", async (c) => {
    const run = await loadRun(ops, c);
    if (!run) return c.notFound();
    // Once the run is over, the "live" marker on the log goes too (out-of-band swap).
    const over = !ACTIVE.includes(run.status);
    return c.html(<><RunSummary c={c} run={run} />{over && <span id="log-live" hx-swap-oob="true"></span>}</>);
  });

  app.get("/runs/:id/log", async (c) => {
    const run = await loadRun(ops, c);
    if (!run || run.log_deleted_at) return c.notFound();
    const file = Bun.file(ops.runner.logPath(run.id));
    if (!(await file.exists())) return c.notFound();
    return new Response(file, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="ops-run-${run.id}.log"`,
        "x-content-type-options": "nosniff",
      },
    });
  });

  // Live log over SSE. The event id is the byte offset, so a reconnect continues where it stopped.
  app.get("/runs/:id/stream", async (c) => {
    const run = await loadRun(ops, c);
    if (!run) return c.notFound();
    const path = ops.runner.logPath(run.id);
    const resume = Number(c.req.header("last-event-id") ?? 0);
    let offset = Number.isSafeInteger(resume) && resume > 0 ? resume : 0;
    return streamSSE(c, async (stream) => {
      const decoder = new TextDecoder();
      let finished = false;
      while (!stream.aborted) {
        const file = Bun.file(path);
        const size = (await file.exists()) ? file.size : 0;
        if (size > offset) {
          const bytes = new Uint8Array(await file.slice(offset, Math.min(size, offset + CHUNK)).arrayBuffer());
          // Send whole lines while the run is going, so a chunk never ends inside a UTF-8 character.
          let end = bytes.length;
          if (!finished && bytes.length < CHUNK) {
            const nl = bytes.lastIndexOf(10);
            end = nl >= 0 ? nl + 1 : 0;
          }
          if (end > 0) {
            offset += end;
            await stream.writeSSE({ event: "log", data: JSON.stringify(decoder.decode(bytes.subarray(0, end), { stream: true })), id: String(offset) });
            continue;
          }
        }
        if (finished) {
          const status = (await first<{ status: string }>(ops.sql`select status from runs where id = ${run.id}`))?.status ?? "error";
          await stream.writeSSE({ event: "done", data: status });
          return;
        }
        const status = (await first<{ status: RunStatus }>(ops.sql`select status from runs where id = ${run.id}`))?.status;
        // One more pass after the end, to flush a last line without a newline.
        if (!status || !ACTIVE.includes(status)) finished = true;
        else await stream.sleep(500);
      }
    });
  });

  app.post("/runs/:id/cancel", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const ok = await ops.runner.cancel(id, actor(c).label);
    if (!ok) return redirectWith(c, `/runs/${id}`, { kind: "bad", text: "Der Lauf ist schon beendet." });
    await audit(ops.sql, c, "run.cancel", String(id));
    return redirectWith(c, `/runs/${id}`, { kind: "ok", text: "Abbruch angefordert. Reagiert der Prozess nicht, wird er nach 10 Sekunden hart beendet." });
  });
}

async function loadRun(ops: Ops, c: Context) {
  const id = parseId(c.req.param("id"));
  if (!id) return null;
  return first<any>(ops.sql`select * from runs where id = ${id}`);
}

function RunSummary(props: { c: Context; run: any }) {
  const r = props.run;
  const live = ACTIVE.includes(r.status);
  const position = r.status === "queued" ? "in der Warteschlange" : null;
  return (
    <section
      class="card"
      id="run-summary"
      hx-get={live ? `/runs/${r.id}/summary` : undefined}
      hx-trigger={live ? "run-finished from:body, every 10s" : undefined}
      hx-swap={live ? "outerHTML" : undefined}
    >
      <div class="card-head ops-run-head">
        <div class="ops-run-status">
          <RunBadge status={r.status} />
          <span class="muted small">{position ?? (r.finished_at ? <>beendet <Ago at={r.finished_at} /></> : r.started_at ? <>gestartet <Ago at={r.started_at} /></> : null)}</span>
        </div>
        {live && can(props.c.get("user"), "run") && (
          <form method="post" action={`/runs/${r.id}/cancel`} class="inline-form"><button class="btn small danger" type="submit"><Icon name="circle-stop" size="sm" />Abbrechen</button></form>
        )}
      </div>
      <div class="card-body">
        {r.error && <StatusBanner tone="bad" title="Fehler" text={r.error} />}
        <div class="ops-facts-grid">
          <dl class="facts">
            <dt>Ausgelöst</dt><dd>{r.trigger === "schedule" ? "Zeitplan" : `von Hand durch ${r.started_by_label}`}</dd>
            <dt>Eingereiht</dt><dd>{formatDate(r.queued_at)}</dd>
            <dt>Gestartet</dt><dd>{formatDate(r.started_at)}</dd>
            <dt>Beendet</dt><dd>{formatDate(r.finished_at)}</dd>
            <dt>Dauer</dt><dd>{formatDuration(r.duration_ms)}</dd>
            <dt>Exit-Code</dt><dd class={r.exit_code ? "status-bad" : undefined}>{r.exit_code ?? "–"}</dd>
            {r.cancelled_by_label && <><dt>Abgebrochen von</dt><dd>{r.cancelled_by_label}</dd></>}
          </dl>
          <dl class="facts">
            <dt>Playbook</dt><dd class="mono">{r.playbook}</dd>
            <dt>Inventory</dt><dd class="mono">{r.inventory}</dd>
            <dt>Limit</dt><dd class="mono">{r.limit_hosts ? `--limit ${r.limit_hosts}` : "–"}</dd>
            {Object.keys(r.extra_vars ?? {}).length > 0 && <><dt>Extra-Vars</dt><dd class="mono">{JSON.stringify(r.extra_vars)}</dd></>}
            {r.check_mode && <><dt>Modus</dt><dd><Badge tone="info">Prüfmodus</Badge></dd></>}
          </dl>
        </div>
      </div>
    </section>
  );
}
