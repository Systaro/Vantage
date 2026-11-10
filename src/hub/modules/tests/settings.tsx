/**
 * Admin block on the environment settings page: test suites and their ingest tokens, plus the CI
 * snippet. Writes run under rls() (the policies require admin) and are audited.
 */
import type { Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { newToken, sha256Hex } from "../../../shared/crypto";
import { formData, parseId, redirectWith, showDialogStep } from "../../../shared/http";
import { Ago, Badge, Card, ConfirmAction, DialogButton, Empty, Field, FormDialog, formatDate, SecretBox } from "../../../shared/ui/components";
import { hubConfig } from "../../config";
import { all, first, rls } from "../../db";
import { audit, loadEnv, type EnvContext } from "../../ui";
import { dbProblem, nameProblem, slugProblem } from "../core/admin-shell";
import { removeReports } from "./storage";

const MAX_DESCRIPTION = 1000;

interface SuiteAdminRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  runs: number;
  last_run: string | null;
}

interface TokenRow {
  id: number;
  suite_id: number;
  name: string;
  token_prefix: string;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expired: boolean;
}

/** GitLab job that runs Playwright and uploads the result; `after_script` also runs on failure. */
export function ciSnippet(hubUrl: string): string {
  const endpoint = `${hubUrl.replace(/\/+$/, "")}/api/v1/test-runs`;
  return `# playwright.config.ts:
#   reporter: [["list"], ["json", { outputFile: "results.json" }], ["html", { open: "never" }]]
# CI/CD variable (masked): VANTAGE_TOKEN = the upload token of this suite

e2e:
  stage: test
  image: mcr.microsoft.com/playwright:v1.50.0-noble   # same version as @playwright/test
  script:
    - npm ci
    - npx playwright test
  after_script:
    - command -v zip >/dev/null || (apt-get update -qq && apt-get install -y -qq zip >/dev/null)
    - (cd playwright-report && zip -qr ../report.zip .)
    - >-
      curl --fail-with-body -sS
      -H "Authorization: Bearer $VANTAGE_TOKEN"
      -F report=@results.json
      -F html=@report.zip
      --form-string "commit=$CI_COMMIT_SHA"
      --form-string "branch=$CI_COMMIT_REF_NAME"
      --form-string "pipeline_url=$CI_PIPELINE_URL"
      --form-string "job_url=$CI_JOB_URL"
      ${endpoint}
`;
}

function TokenStatus(props: { t: TokenRow }) {
  if (props.t.revoked_at) return <Badge tone="bad">widerrufen</Badge>;
  if (props.t.expired) return <Badge tone="idle">abgelaufen</Badge>;
  return <Badge tone="ok">aktiv</Badge>;
}

const dayFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" });

/** Tokens expire at the start of the day after the chosen date; people think in the last valid day. */
function lastValidDay(expiresAt: string | Date): string {
  return dayFmt.format(new Date(new Date(expiresAt).getTime() - 1));
}

function todayBerlin(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
}

export async function renderTestSettings(c: Context, env: EnvContext): Promise<Child> {
  const { suites, tokens } = await rls(c, async (tx) => ({
    suites: await all<SuiteAdminRow>(tx`
      select s.id, s.slug, s.name, s.description,
        (select count(*)::int from test_runs r where r.suite_id = s.id) as runs,
        (select max(r.received_at) from test_runs r where r.suite_id = s.id) as last_run
      from test_suites s where s.environment_id = ${env.id} order by s.name`),
    tokens: await all<TokenRow>(tx`
      select t.id, t.suite_id, t.name, t.token_prefix, t.expires_at, t.created_at, t.last_used_at, t.revoked_at,
             coalesce(t.expires_at <= now(), false) as expired
      from ingest_tokens t join test_suites s on s.id = t.suite_id
      where s.environment_id = ${env.id}
      order by t.revoked_at nulls first, t.created_at desc`),
  }));
  const base = `/env/${env.id}/tests`;
  const today = todayBerlin();

  const newButton = (primary: boolean) => <DialogButton dialog="new-suite" icon="plus" class={primary ? "primary" : "small"}>Testsuite anlegen</DialogButton>;

  return (
    <Card
      id="tests"
      title="Testsuiten & Upload-Tokens"
      description="CI-Pipelines laden Playwright-Ergebnisse pro Testsuite hoch. Ein Upload-Token darf nur Läufe seiner Suite schreiben und nichts lesen."
      actions={suites.length > 0 && newButton(false)}
    >
      <div class="stack tests-admin">
        {suites.length === 0 && <Empty title="Noch keine Testsuite" icon="flask-conical" action={newButton(true)}>Eine Testsuite sammelt die Läufe einer Pipeline, z. B. „E2E Smoke“.</Empty>}
        {suites.map((s) => {
          const own = tokens.filter((t) => t.suite_id === s.id);
          return (
            <div class="suite-admin">
              <div class="row-between">
                <div>
                  <h3>{s.name} <span class="muted small mono">{s.slug}</span></h3>
                  <span class="muted small">{s.runs} Läufe, zuletzt <Ago at={s.last_run} />{s.description && <> · {s.description}</>}</span>
                </div>
                <div class="btn-group">
                  <DialogButton dialog={`new-token-${s.id}`} icon="key-round" class="small">Upload-Token</DialogButton>
                  <DialogButton dialog={`edit-suite-${s.id}`} icon="pencil" class="small">Bearbeiten</DialogButton>
                  <ConfirmAction
                    action={`${base}/suites/${s.id}/delete`}
                    label="Löschen"
                    question={`„${s.name}“ mit ${s.runs} Läufen und allen HTML-Reports löschen?`}
                    confirmLabel="Ja, löschen"
                  />
                </div>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Token</th><th>Präfix</th><th>Angelegt</th><th>Gültig bis</th><th>Zuletzt benutzt</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {own.map((t) => (
                      <tr>
                        <td>{t.name}</td>
                        <td class="mono small">{t.token_prefix}…</td>
                        <td class="small nowrap">{formatDate(t.created_at)}</td>
                        <td class="small nowrap">{t.expires_at ? lastValidDay(t.expires_at) : <span class="muted">unbegrenzt</span>}</td>
                        <td class="small"><Ago at={t.last_used_at} /></td>
                        <td><TokenStatus t={t} /></td>
                        <td class="right">
                          {!t.revoked_at && <ConfirmAction action={`${base}/tokens/${t.id}/revoke`} label="Widerrufen" question="Token widerrufen? Uploads damit schlagen sofort fehl." />}
                        </td>
                      </tr>
                    ))}
                    {own.length === 0 && <tr><td colspan={7} class="muted">Noch kein Token. Ohne Token kann die Pipeline nichts hochladen.</td></tr>}
                  </tbody>
                </table>
              </div>
              <FormDialog id={`new-token-${s.id}`} title="Upload-Token erzeugen" description={<>Für die Testsuite „{s.name}“.</>} icon="key-round" action={`${base}/suites/${s.id}/tokens`} submitLabel="Token erzeugen">
                <div class="fields">
                  <Field label="Name" for={`tok-name-${s.id}`} hint="z. B. das GitLab-Projekt"><input id={`tok-name-${s.id}`} name="name" type="text" required maxlength={200} placeholder="gitlab: shop/e2e" /></Field>
                  <Field label="Gültig bis (optional)" for={`tok-exp-${s.id}`} hint="einschließlich dieses Tages"><input id={`tok-exp-${s.id}`} name="expires_on" type="date" min={today} /></Field>
                </div>
              </FormDialog>
              <FormDialog id={`edit-suite-${s.id}`} title={`„${s.name}“ bearbeiten`} icon="pencil" action={`${base}/suites/${s.id}`} submitLabel="Speichern">
                <Field label="Name" for={`suite-name-${s.id}`}><input id={`suite-name-${s.id}`} name="name" type="text" required maxlength={200} value={s.name} /></Field>
                <Field label="Beschreibung (optional)" for={`suite-desc-${s.id}`}><input id={`suite-desc-${s.id}`} name="description" type="text" maxlength={MAX_DESCRIPTION} value={s.description ?? ""} /></Field>
              </FormDialog>
            </div>
          );
        })}
        <details class="disclosure">
          <summary>GitLab-CI-Beispiel</summary>
          <p class="small">
            Die Pipeline lädt den JSON-Report (Pflicht) und den gezippten HTML-Report (optional) hoch. Grenzen: JSON bis 50 MB, Zip bis 150 MB,
            höchstens 20.000 Dateien und 500 MB entpackt. HTML-Reports werden nach 90 Tagen gelöscht, die Ergebnisse bleiben.
          </p>
          <pre class="ci-snippet">{ciSnippet(hubConfig.publicUrl)}</pre>
        </details>
      </div>
      <FormDialog id="new-suite" title="Testsuite anlegen" description="Danach erzeugen Sie ein Upload-Token für die Pipeline." icon="flask-conical" action={`${base}/suites`} submitLabel="Testsuite anlegen">
        <Field label="Name" for="suite-name"><input id="suite-name" name="name" type="text" required maxlength={200} placeholder="E2E Smoke" /></Field>
        <Field label="Kürzel" for="suite-slug" hint="Kleinbuchstaben, Ziffern, Bindestriche"><input id="suite-slug" name="slug" type="text" required pattern="[a-z0-9][a-z0-9\-]*" maxlength={63} placeholder="e2e-smoke" /></Field>
        <Field label="Beschreibung (optional)" for="suite-desc"><input id="suite-desc" name="description" type="text" maxlength={MAX_DESCRIPTION} /></Field>
      </FormDialog>
    </Card>
  );
}

function adminEnv(c: Context): Promise<EnvContext | null> {
  if (!c.get("user").isAdmin) return Promise.resolve(null);
  return loadEnv(c, parseId(c.req.param("id")) ?? 0);
}

function back(env: EnvContext) {
  return `/env/${env.id}/settings#tests`;
}

export function mountTestSettings(app: Hono) {
  app.post("/env/:id/tests/suites", async (c) => {
    const env = await adminEnv(c);
    if (!env) return c.notFound();
    const f = await formData(c);
    const description = f.get("description") || null;
    const problem = nameProblem(f.get("name")) ?? slugProblem(f.get("slug"))
      ?? ((description?.length ?? 0) > MAX_DESCRIPTION ? `Die Beschreibung darf höchstens ${MAX_DESCRIPTION} Zeichen lang sein.` : null);
    if (problem) return redirectWith(c, back(env), { kind: "bad", text: problem });
    let row: { id: number } | null;
    try {
      row = await rls(c, (tx) => first<{ id: number }>(tx`
        insert into test_suites (environment_id, slug, name, description)
        values (${env.id}, ${f.get("slug")}, ${f.get("name")}, ${description}) returning id`));
    } catch (err) {
      return redirectWith(c, back(env), { kind: "bad", text: dbProblem(err, "Dieses Kürzel gibt es in der Umgebung schon.") });
    }
    await audit(c, "test_suite.created", String(row!.id), { environment_id: env.id, slug: f.get("slug") });
    return redirectWith(c, back(env), { kind: "ok", text: `Testsuite „${f.get("name")}“ angelegt. Jetzt ein Upload-Token erzeugen.` });
  });

  app.post("/env/:id/tests/suites/:suite", async (c) => {
    const env = await adminEnv(c);
    const suiteId = parseId(c.req.param("suite"));
    if (!env || !suiteId) return c.notFound();
    const f = await formData(c);
    const description = f.get("description") || null;
    const problem = nameProblem(f.get("name"))
      ?? ((description?.length ?? 0) > MAX_DESCRIPTION ? `Die Beschreibung darf höchstens ${MAX_DESCRIPTION} Zeichen lang sein.` : null);
    if (problem) return redirectWith(c, back(env), { kind: "bad", text: problem });
    const rows = await rls(c, (tx) => tx`
      update test_suites set name = ${f.get("name")}, description = ${description}
      where id = ${suiteId} and environment_id = ${env.id} returning id`);
    if (!rows.length) return c.notFound();
    await audit(c, "test_suite.updated", String(suiteId), { environment_id: env.id, name: f.get("name") });
    return redirectWith(c, back(env), { kind: "ok", text: "Testsuite gespeichert." });
  });

  app.post("/env/:id/tests/suites/:suite/delete", async (c) => {
    const env = await adminEnv(c);
    const suiteId = parseId(c.req.param("suite"));
    if (!env || !suiteId) return c.notFound();
    const result = await rls(c, async (tx) => {
      const reports = (await tx`select id from test_runs where suite_id = ${suiteId} and has_report and not report_purged`) as { id: number }[];
      const deleted = (await tx`delete from test_suites where id = ${suiteId} and environment_id = ${env.id} returning slug, name`) as { slug: string; name: string }[];
      return deleted[0] ? { suite: deleted[0], reports: reports.map((r) => r.id) } : null;
    });
    if (!result) return c.notFound();
    await removeReports(hubConfig.storageDir, result.reports);
    await audit(c, "test_suite.deleted", String(suiteId), { environment_id: env.id, slug: result.suite.slug, reports: result.reports.length });
    return redirectWith(c, back(env), { kind: "ok", text: `Testsuite „${result.suite.name}“ gelöscht.` });
  });

  app.post("/env/:id/tests/suites/:suite/tokens", async (c) => {
    const env = await adminEnv(c);
    const suiteId = parseId(c.req.param("suite"));
    if (!env || !suiteId) return c.notFound();
    const f = await formData(c);
    const expiresOn = f.get("expires_on") || null;
    const problem = nameProblem(f.get("name"))
      ?? (expiresOn && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || Number.isNaN(Date.parse(expiresOn))) ? "Ungültiges Ablaufdatum." : null)
      ?? (expiresOn && expiresOn < todayBerlin() ? "Das Ablaufdatum darf nicht in der Vergangenheit liegen." : null);
    if (problem) return redirectWith(c, back(env), { kind: "bad", text: problem });

    const token = newToken("vti");
    const row = await rls(c, (tx) => first<{ id: number; expires_at: string | null; suite_name: string }>(tx`
      with s as (select id, name from test_suites where id = ${suiteId} and environment_id = ${env.id})
      insert into ingest_tokens (suite_id, name, token_hash, token_prefix, expires_at, created_by)
      select s.id, ${f.get("name")}, ${sha256Hex(token)}, ${token.slice(0, 10)},
             ((${expiresOn}::date + 1)::timestamp at time zone 'Europe/Berlin'), ${c.get("user").id}
      from s
      returning id, expires_at, (select name from s) as suite_name`));
    if (!row) return c.notFound();
    await audit(c, "ingest_token.created", String(row.id), { suite_id: suiteId, name: f.get("name"), expires_at: row.expires_at });

    return showDialogStep(c, {
      title: `Upload-Token für „${row.suite_name}“`,
      icon: "key-round",
      body: (
        <>
          <p>Im GitLab-Projekt als maskierte CI/CD-Variable <code>VANTAGE_TOKEN</code> hinterlegen. Das Token wird nur jetzt angezeigt; gespeichert ist nur sein Hash.</p>
          <SecretBox id="ingest-token" value={token} />
          <p class="muted small">{row.expires_at ? `Gültig bis einschließlich ${lastValidDay(row.expires_at)}.` : "Läuft nicht ab; bei Bedarf in den Einstellungen widerrufen."}</p>
          <details class="disclosure">
            <summary>Upload in der Pipeline</summary>
            <pre class="ci-snippet">{ciSnippet(hubConfig.publicUrl)}</pre>
          </details>
        </>
      ),
    });
  });

  app.post("/env/:id/tests/tokens/:token/revoke", async (c) => {
    const env = await adminEnv(c);
    const tokenId = parseId(c.req.param("token"));
    if (!env || !tokenId) return c.notFound();
    const rows = (await rls(c, (tx) => tx`
      update ingest_tokens set revoked_at = now()
      where id = ${tokenId} and revoked_at is null and suite_id in (select id from test_suites where environment_id = ${env.id})
      returning name, suite_id`)) as { name: string; suite_id: number }[];
    if (!rows[0]) return c.notFound();
    await audit(c, "ingest_token.revoked", String(tokenId), { suite_id: rows[0].suite_id, name: rows[0].name });
    return redirectWith(c, back(env), { kind: "ok", text: `Token „${rows[0].name}“ widerrufen.` });
  });
}
