import type { Hono } from "hono";
import { parseId } from "../../../shared/http";
import { StatusStripLinks } from "../../../shared/ui/charts";
import { Ago, Badge, Card, Empty, Stat, formatDate, formatDuration, formatNumber, formatPercent, type Tone } from "../../../shared/ui/components";
import { Icon } from "../../../shared/ui/icons";
import { hubConfig } from "../../config";
import { all, first, hubSql, rls } from "../../db";
import { EnvShell, loadEnv } from "../../ui";
import { RUN_STATUS } from "../core/overview";
import { registerSettingsSection } from "../core/registry";
import { mountIngestApi } from "./ingest";
import { signedReportUrl } from "./reports";
import { mountTestSettings, renderTestSettings } from "./settings";

const PAGE = 50;
const HISTORY = 20;

export const CASE_STATUS: Record<string, { label: string; tone: Tone }> = {
  passed: { label: "bestanden", tone: "ok" },
  failed: { label: "fehlgeschlagen", tone: "bad" },
  timedOut: { label: "Zeitüberschreitung", tone: "bad" },
  interrupted: { label: "abgebrochen", tone: "idle" },
  flaky: { label: "wackelig", tone: "warn" },
  skipped: { label: "übersprungen", tone: "idle" },
};

const FAILED = new Set(["failed", "timedOut", "interrupted"]);

interface RecentRun {
  id: number;
  status: string;
  received_at: string;
}

interface SuiteRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  recent: RecentRun[];
}

interface RunRow {
  id: number;
  suite_id: number;
  suite_name: string;
  environment_id: number;
  received_at: string;
  started_at: string | null;
  duration_ms: number | null;
  status: string;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  commit_sha: string | null;
  branch: string | null;
  pipeline_url: string | null;
  job_url: string | null;
  has_report: boolean;
  report_purged: boolean;
}

interface CaseRow {
  title: string;
  file: string | null;
  project: string | null;
  status: string;
  duration_ms: number | null;
  retries: number;
  error: string | null;
}

export function RunBadge(props: { status: string }) {
  const s = RUN_STATUS[props.status];
  return <Badge tone={s?.tone ?? "idle"} dot>{s?.label ?? props.status}</Badge>;
}

function CaseBadge(props: { status: string }) {
  const s = CASE_STATUS[props.status];
  return <Badge tone={s?.tone ?? "idle"}>{s?.label ?? props.status}</Badge>;
}

/** Last runs as linked cells, oldest left, newest right; fixed slots keep suites aligned. */
function RunStrip(props: { runs: RecentRun[] }) {
  return (
    <StatusStripLinks
      slots={HISTORY}
      label={`Letzte ${props.runs.length} Läufe, neuester rechts`}
      cells={props.runs.map((r) => {
        const s = RUN_STATUS[r.status];
        return { tone: s?.tone ?? "idle", title: `Lauf #${r.id}: ${s?.label ?? r.status}, ${formatDate(r.received_at)}`, href: `/runs/${r.id}` };
      })}
    />
  );
}

/** GitLab pipeline/job URLs name the project, which gives a link to the commit. */
export function commitUrl(run: { pipeline_url: string | null; job_url: string | null; commit_sha: string | null }): string | null {
  if (!run.commit_sha) return null;
  for (const u of [run.pipeline_url, run.job_url]) {
    const m = u ? /^(https?:\/\/[^?#]+?)\/-\/(?:pipelines|jobs)\/\d+/.exec(u) : null;
    if (m) return `${m[1]}/-/commit/${encodeURIComponent(run.commit_sha)}`;
  }
  return null;
}

function Commit(props: { run: RunRow }) {
  const sha = props.run.commit_sha;
  if (!sha) return <span class="muted">–</span>;
  const href = commitUrl(props.run);
  const short = <code title={sha}>{sha.slice(0, 8)}</code>;
  return href ? <a href={href} rel="noopener noreferrer">{short}</a> : short;
}

function RunLinks(props: { run: RunRow }) {
  const r = props.run;
  return (
    <span class="row nowrap">
      {r.pipeline_url && <a href={r.pipeline_url} rel="noopener noreferrer">Pipeline</a>}
      {r.job_url && <a href={r.job_url} rel="noopener noreferrer">Job</a>}
      {r.has_report && !r.report_purged && <a href={`/runs/${r.id}/report`} target="_blank" rel="noopener noreferrer">Report</a>}
    </span>
  );
}

function passRate(runs: RecentRun[]): { green: number; rate: number | null } {
  const green = runs.filter((r) => r.status === "passed" || r.status === "flaky").length;
  return { green, rate: runs.length ? (green / runs.length) * 100 : null };
}

function groupByFile(cases: CaseRow[]): [string, CaseRow[]][] {
  const groups = new Map<string, CaseRow[]>();
  for (const c of cases) {
    const key = c.file ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return [...groups.entries()];
}

let settingsRegistered = false;

export function mountTests(app: Hono) {
  if (!settingsRegistered) {
    registerSettingsSection(40, renderTestSettings);
    settingsRegistered = true;
  }
  mountTestSettings(app);

  app.get("/env/:id/tests", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0);
    if (!env) return c.notFound();
    const suiteFilter = parseId(c.req.query("suite"));
    const before = parseId(c.req.query("before"));
    const { suites, runs } = await rls(c, async (tx) => ({
      suites: await all<SuiteRow>(tx`
        select s.id, s.slug, s.name, s.description,
          coalesce((select json_agg(h order by h.id) from (
            select r.id, r.status, r.received_at from test_runs r where r.suite_id = s.id order by r.id desc limit ${HISTORY}
          ) h), '[]'::json) as recent
        from test_suites s where s.environment_id = ${env.id} order by s.name`),
      runs: await all<RunRow>(tx`
        select r.*, s.name as suite_name from test_runs r join test_suites s on s.id = r.suite_id
        where r.environment_id = ${env.id}
          and (${suiteFilter}::int is null or r.suite_id = ${suiteFilter}::int)
          and (${before}::int is null or r.id < ${before}::int)
        order by r.id desc limit ${PAGE}`),
    }));
    const filtered = suiteFilter ? suites.find((s) => s.id === suiteFilter) : undefined;
    const last = runs.at(-1);
    const isAdmin = c.get("user").isAdmin;

    return c.html(
      <EnvShell c={c} env={env} tab="tests" title={filtered ? `Tests: ${filtered.name}` : "Tests"}>
        {suites.length === 0 ? (
          <Card>
            <Empty title="Noch keine Testsuiten">
              {isAdmin ? (
                <span>Legen Sie in den <a href={`/env/${env.id}/settings#tests`}>Einstellungen</a> eine Testsuite und ein Upload-Token an.</span>
              ) : (
                "Für diese Umgebung werden noch keine automatisierten Tests hochgeladen."
              )}
            </Empty>
          </Card>
        ) : (
          <div class="stack">
            <Card flush title="Testsuiten">
              <div class="table-wrap"><table>
                <thead><tr><th>Testsuite</th><th>Letzter Lauf</th><th class="num">Erfolgsquote</th><th>Verlauf (neuester rechts)</th></tr></thead>
                <tbody>{suites.map((s) => {
                  const latest = s.recent.at(-1);
                  const { green, rate } = passRate(s.recent);
                  return (
                    <tr>
                      <td>
                        <a href={`/env/${env.id}/tests?suite=${s.id}`}>{s.name}</a>
                        {s.description && <div class="muted small">{s.description}</div>}
                      </td>
                      <td class="nowrap">{latest ? <span class="row"><RunBadge status={latest.status} /><a href={`/runs/${latest.id}`}><Ago at={latest.received_at} /></a></span> : <span class="muted">noch kein Lauf</span>}</td>
                      <td class="num" title="Anteil grüner oder wackeliger Läufe">{rate === null ? "–" : <span>{formatPercent(rate, 0)} <span class="muted small">({green}/{s.recent.length})</span></span>}</td>
                      <td class="strip-cell"><RunStrip runs={s.recent} /></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            </Card>

            <Card flush title={filtered ? `Läufe von „${filtered.name}“` : "Letzte Läufe"} actions={filtered && <a class="btn small" href={`/env/${env.id}/tests`}>Alle Suiten</a>}>
              {runs.length === 0 ? <Empty title="Noch keine Läufe">Sobald die Pipeline ein Ergebnis hochlädt, erscheint es hier.</Empty> : (
                <div class="table-wrap"><table>
                  <thead><tr>
                    <th>Zeit</th>{!filtered && <th>Testsuite</th>}<th>Status</th>
                    <th class="num">Bestanden</th><th class="num">Fehlgeschl.</th><th class="num">Wackelig</th><th class="num">Übersprungen</th>
                    <th class="num">Dauer</th><th>Branch</th><th>Commit</th><th>Links</th>
                  </tr></thead>
                  <tbody>{runs.map((r) => (
                    <tr>
                      <td class="nowrap"><a href={`/runs/${r.id}`}><Ago at={r.received_at} /></a></td>
                      {!filtered && <td class="nowrap">{r.suite_name}</td>}
                      <td><RunBadge status={r.status} /></td>
                      <td class="num">{formatNumber(r.passed)}</td>
                      <td class={`num ${r.failed > 0 ? "status-bad" : ""}`}>{formatNumber(r.failed)}</td>
                      <td class={`num ${r.flaky > 0 ? "status-warn" : ""}`}>{formatNumber(r.flaky)}</td>
                      <td class="num">{formatNumber(r.skipped)}</td>
                      <td class="num">{formatDuration(r.duration_ms)}</td>
                      <td class="small">{r.branch ?? <span class="muted">–</span>}</td>
                      <td class="small"><Commit run={r} /></td>
                      <td class="small"><RunLinks run={r} /></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
            {runs.length === PAGE && last && (
              <p><a class="btn" href={`/env/${env.id}/tests?before=${last.id}${suiteFilter ? `&suite=${suiteFilter}` : ""}`}>Ältere Läufe</a></p>
            )}
          </div>
        )}
      </EnvShell>,
    );
  });

  app.get("/runs/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const data = await rls(c, async (tx) => {
      const run = await first<RunRow>(tx`select r.*, s.name as suite_name from test_runs r join test_suites s on s.id = r.suite_id where r.id = ${id}`);
      if (!run) return null;
      const cases = await all<CaseRow>(tx`
        select title, file, project, status, duration_ms, retries, error from test_cases where run_id = ${id}
        order by file nulls last, id`);
      const nav = await first<{ prev: number | null; next: number | null }>(tx`
        select (select max(id) from test_runs where suite_id = ${run.suite_id} and id < ${id}) as prev,
               (select min(id) from test_runs where suite_id = ${run.suite_id} and id > ${id}) as next`);
      return { run, cases, nav };
    });
    if (!data) return c.notFound();
    const env = await loadEnv(c, data.run.environment_id);
    if (!env) return c.notFound();
    const { run, cases, nav } = data;
    const failures = cases.filter((k) => FAILED.has(k.status));
    const reportAvailable = run.has_report && !run.report_purged;

    return c.html(
      <EnvShell
        c={c}
        env={env}
        tab="tests"
        title={`Testlauf #${run.id} – ${run.suite_name}`}
        actions={
          <span class="row">
            {nav?.prev && <a class="btn small" href={`/runs/${nav.prev}`}><Icon name="arrow-left" size="sm" />Vorheriger</a>}
            {nav?.next && <a class="btn small" href={`/runs/${nav.next}`}>Nächster<Icon name="arrow-right" size="sm" /></a>}
            {reportAvailable && <a class="btn primary" href={`/runs/${run.id}/report`} target="_blank" rel="noopener noreferrer">HTML-Report öffnen</a>}
          </span>
        }
      >
        <div class="stack">
          <Card title={
            <h2 class="row">
              <a href={`/env/${env.id}/tests?suite=${run.suite_id}`}>{run.suite_name}</a>
              <span class="muted">Lauf #{run.id}</span>
              <RunBadge status={run.status} />
            </h2>
          }>
            <dl class="run-facts">
              <div><dt>Empfangen</dt><dd>{formatDate(run.received_at)} (<Ago at={run.received_at} />)</dd></div>
              <div><dt>Gestartet</dt><dd>{formatDate(run.started_at)}</dd></div>
              <div><dt>Branch</dt><dd>{run.branch ?? "–"}</dd></div>
              <div><dt>Commit</dt><dd><Commit run={run} /></dd></div>
              <div><dt>CI</dt><dd>{run.pipeline_url || run.job_url ? <RunLinks run={{ ...run, has_report: false }} /> : "–"}</dd></div>
              <div><dt>HTML-Report</dt><dd>
                {reportAvailable ? <a href={`/runs/${run.id}/report`} target="_blank" rel="noopener noreferrer">öffnen</a>
                  : run.report_purged ? <span class="muted">nach 90 Tagen gelöscht</span>
                  : <span class="muted">nicht hochgeladen</span>}
              </dd></div>
            </dl>
          </Card>

          <div class="grid run-stats">
            <Stat label="Tests" value={formatNumber(run.total)} />
            <Stat label="Bestanden" value={formatNumber(run.passed)} tone={run.passed > 0 ? "ok" : undefined} />
            <Stat label="Fehlgeschlagen" value={formatNumber(run.failed)} tone={run.failed > 0 ? "bad" : undefined} />
            <Stat label="Wackelig" value={formatNumber(run.flaky)} tone={run.flaky > 0 ? "warn" : undefined} hint="erst im Wiederholungsversuch grün" />
            <Stat label="Übersprungen" value={formatNumber(run.skipped)} />
            <Stat label="Dauer" value={formatDuration(run.duration_ms)} />
          </div>

          {failures.length > 0 && (
            <Card title={`Fehlgeschlagene Tests (${failures.length})`}>
              {failures.map((k) => (
                <div class="test-failure">
                  <div class="row"><CaseBadge status={k.status} /><strong>{k.title}</strong></div>
                  <div class="test-meta">
                    {[k.file, k.project, formatDuration(k.duration_ms), k.retries > 0 ? `${k.retries} Wiederholung${k.retries === 1 ? "" : "en"}` : null].filter(Boolean).join(" · ")}
                  </div>
                  {k.error ? <pre>{k.error}</pre> : <p class="muted small">Keine Fehlermeldung im Report.</p>}
                </div>
              ))}
            </Card>
          )}

          <Card flush title={`Alle Tests (${cases.length})`}>
            {cases.length === 0 ? <Empty title="Der Report enthält keine Tests" /> : groupByFile(cases).map(([file, list]) => {
              const bad = list.filter((k) => FAILED.has(k.status)).length;
              const flaky = list.filter((k) => k.status === "flaky").length;
              return (
                <details class="test-file" open={bad > 0}>
                  <summary>
                    <span class="chev"><Icon name="chevron-right" size="sm" /></span>
                    <span class="test-file-name">{file || "ohne Datei"}</span>
                    <span class="muted small">{list.length} Test{list.length === 1 ? "" : "s"}</span>
                    {bad > 0 && <Badge tone="bad">{bad} fehlgeschlagen</Badge>}
                    {flaky > 0 && <Badge tone="warn">{flaky} wackelig</Badge>}
                  </summary>
                  <div class="table-wrap"><table class="case-table">
                    <colgroup><col /><col class="c-project" /><col class="c-status" /><col class="c-num" /><col class="c-num" /></colgroup>
                    <thead><tr><th>Test</th><th>Projekt</th><th>Status</th><th class="num">Dauer</th><th class="num">Wiederh.</th></tr></thead>
                    <tbody>{list.map((k) => (
                      <tr>
                        <td>
                          {k.title}
                          {k.error && !FAILED.has(k.status) && (
                            <details class="case-error"><summary>Fehler im ersten Versuch</summary><pre>{k.error}</pre></details>
                          )}
                        </td>
                        <td class="small">{k.project ?? "–"}</td>
                        <td><CaseBadge status={k.status} /></td>
                        <td class="num">{formatDuration(k.duration_ms)}</td>
                        <td class="num">{k.retries}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                </details>
              );
            })}
          </Card>
        </div>
      </EnvShell>,
    );
  });

  // The signed link is minted on click, so a run page left open never shows an expired link.
  app.get("/runs/:id/report", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.notFound();
    const run = await rls(c, (tx) => first<{ has_report: boolean; report_purged: boolean }>(tx`
      select has_report, report_purged from test_runs where id = ${id}`));
    if (!run?.has_report || run.report_purged) return c.notFound();
    c.header("Cache-Control", "no-store");
    return c.redirect(signedReportUrl(id), 302);
  });
}

export function mountTestsApi(app: Hono) {
  mountIngestApi(app, { sql: hubSql, storageDir: hubConfig.storageDir, publicUrl: hubConfig.publicUrl });
}
