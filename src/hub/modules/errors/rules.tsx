/**
 * Ignore rules on the errors pages (#69811): the list card, the dialog that creates a rule (empty, or
 * from "Ähnliche ignorieren" on a group with a suggested pattern) with its live preview, and the
 * admin routes. Everyone who sees an environment's errors sees its rules; creating and deleting is
 * for admins, since a rule hides errors from everyone who looks at the environment.
 */
import type { Context, Hono } from "hono";
import type { SQL } from "bun";
import { intArray } from "../../../shared/db";
import { formData, parseId, redirectWith } from "../../../shared/http";
import { Ago, Card, ConfirmAction, DialogButton, Empty, Field, FormDialog, formatNumber } from "../../../shared/ui/components";
import { all, rls } from "../../db";
import { audit, loadEnv, type EnvContext } from "../../ui";
import { compileRule, patternProblem, ruleMatches } from "./ignore-rules";
import { errorTitle } from "./query";

const DIALOG = "error-rule";
const MAX_NOTE = 500;
/** Groups the preview and "apply to open groups" look at, the most recently seen first. */
const MATCH_LIMIT = 5000;

export interface RuleRow {
  id: number;
  environment_id: number | null;
  pattern: string;
  note: string | null;
  matched: number;
  last_matched_at: Date | null;
  created_at: Date;
  /** null for viewers who may not read the user list */
  created_by_name: string | null;
}

/** The rules that hold for an environment: its own and its project's. */
export function selectRules(tx: SQL, env: EnvContext): Promise<RuleRow[]> {
  return all<RuleRow>(tx`
    select r.id, r.environment_id, r.pattern, r.note, r.matched::float8 as matched, r.last_matched_at, r.created_at, u.name as created_by_name
    from error_ignore_rules r left join users u on u.id = r.created_by
    where r.environment_id = ${env.id} or (r.environment_id is null and r.project_id = ${env.projectId})
    order by r.created_at, r.id`);
}

const scopeLabel = (env: EnvContext, rule: { environment_id: number | null }) => (rule.environment_id === null ? "Alle Umgebungen" : env.name);

export function IgnoreRulesCard(props: { env: EnvContext; rules: RuleRow[]; admin: boolean }) {
  const { env, rules, admin } = props;
  if (!admin && rules.length === 0) return null;
  return (
    <Card
      id="ignore-rules"
      title="Ignorier-Regeln"
      icon="filter"
      description="Passende Fehler verwirft Vantage schon beim Abruf: keine Fehlergruppe, keine Benachrichtigung."
      actions={admin && <DialogButton dialog={DIALOG} icon="plus" class="small">Regel anlegen</DialogButton>}
      flush
    >
      {rules.length === 0 ? (
        <Empty title="Keine Ignorier-Regeln" icon="filter">
          Für wechselnde Einzelfälle, die immer wieder als neuer Fehler auftauchen. Einzelne Gruppen lassen sich auch direkt ignorieren.
        </Empty>
      ) : (
        <div class="table-wrap">
          <table>
            <thead><tr><th>Ausdruck</th><th>Gilt für</th><th class="num">Verworfen</th><th>Angelegt</th>{admin && <th></th>}</tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr>
                  <td class="error-cell">
                    <code class="rule-pattern">{r.pattern}</code>
                    {r.note && <div class="cell-sub">{r.note}</div>}
                  </td>
                  <td class="small">{scopeLabel(env, r)}</td>
                  <td class="num">
                    {formatNumber(r.matched)}
                    <div class="cell-sub nowrap">{r.last_matched_at ? <>zuletzt <Ago at={r.last_matched_at} /></> : "noch nie"}</div>
                  </td>
                  <td class="nowrap small">
                    <Ago at={r.created_at} />
                    {r.created_by_name && <div class="cell-sub">{r.created_by_name}</div>}
                  </td>
                  {admin && (
                    <td class="right">
                      <ConfirmAction
                        action={`/admin/env/${env.id}/error-rules/${r.id}/delete`}
                        label="Löschen"
                        question="Regel löschen? Passende Fehler werden dann wieder erfasst."
                        confirmLabel="Ja, löschen"
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** The opener for the detail page: the dialog prefilled with a pattern for this group's kind of error. */
export function IgnoreSimilarButton() {
  return <DialogButton dialog={DIALOG} icon="filter" class="small">Ähnliche ignorieren</DialogButton>;
}

export function RuleDialog(props: { env: EnvContext; pattern?: string }) {
  const { env, pattern } = props;
  const preview = `/admin/env/${env.id}/error-rules/preview`;
  const live = { "hx-get": preview, "hx-target": "#rule-preview", "hx-sync": "this:replace" };
  return (
    <FormDialog
      id={DIALOG}
      title="Ignorier-Regel anlegen"
      description="Ein regulärer Ausdruck (JavaScript-Syntax) auf den Titel eines Fehlers, wie die Liste ihn zeigt, oder auf seinen Ort. Er muss nur einen Teil treffen, Groß- und Kleinschreibung zählt nicht."
      icon="filter"
      action={`/admin/env/${env.id}/error-rules`}
      submitLabel="Regel anlegen"
      wide
    >
      <Field label="Regulärer Ausdruck" for="rule-pattern" hint={<>Wechselnde Teile als Platzhalter, z. B. <code>in session \S+</code> oder <code>Auftrag \d+</code></>}>
        <input
          id="rule-pattern"
          name="pattern"
          type="text"
          class="mono"
          required
          autocomplete="off"
          spellcheck={false}
          value={pattern ?? ""}
          hx-trigger="input changed delay:400ms"
          hx-include="#rule-scope"
          {...live}
        />
      </Field>
      <div class="fields">
        <Field label="Gilt für" for="rule-scope">
          <select id="rule-scope" name="scope" hx-trigger="change" hx-include="#rule-pattern" {...live}>
            <option value="environment">Nur {env.name}</option>
            <option value="project">Alle Umgebungen von {env.projectName}</option>
          </select>
        </Field>
        <Field label="Notiz (optional)" for="rule-note" hint="Warum diese Fehler keine sind">
          <input id="rule-note" name="note" type="text" autocomplete="off" />
        </Field>
      </div>
      <label class="check">
        <input type="checkbox" name="apply" value="1" checked />
        Passende offene Fehlergruppen gleich auf „Ignoriert“ setzen
      </label>
      <div
        id="rule-preview"
        class="src-preview"
        aria-live="polite"
        {...(pattern ? { "hx-get": `${preview}?scope=environment&pattern=${encodeURIComponent(pattern)}`, "hx-trigger": "intersect once" } : {})}
      >
        <p class="muted small">Beim Tippen erscheint hier, auf welche Fehlergruppen der Ausdruck passt.</p>
      </div>
    </FormDialog>
  );
}

interface MatchRow {
  id: number;
  environment_id: number;
  exception_type: string | null;
  message: string | null;
  culprit: string | null;
  status: "open" | "resolved" | "ignored";
  occurrences: number;
}

type Scope = "environment" | "project";
const asScope = (v: string | undefined | null): Scope => (v === "project" ? "project" : "environment");

/** The environment's or the project's groups the rule matches; only groups of environments the user sees. */
async function matchingGroups(c: Context, env: EnvContext, scope: Scope, re: RegExp, openOnly: boolean) {
  const rows = await rls(c, (tx) => all<MatchRow>(tx`
    select g.id, g.environment_id, g.exception_type, g.message, g.culprit, g.status, g.occurrences::float8 as occurrences
    from error_groups g join environments e on e.id = g.environment_id
    where e.project_id = ${env.projectId} and (${scope === "project"}::boolean or e.id = ${env.id})
      and (${!openOnly}::boolean or g.status = 'open')
    order by g.last_seen_at desc limit ${MATCH_LIMIT}`));
  return { total: rows.length, matched: rows.filter((g) => ruleMatches(re, g)) };
}

const groupsWord = (n: number) => (n === 1 ? "Fehlergruppe" : "Fehlergruppen");

async function RulePreview(props: { c: Context; env: EnvContext; pattern: string; scope: Scope }) {
  const { c, env, pattern, scope } = props;
  if (!pattern) return <p class="muted small">Beim Tippen erscheint hier, auf welche Fehlergruppen der Ausdruck passt.</p>;
  const problem = patternProblem(pattern);
  if (problem) return <p class="status-bad small">{problem}</p>;
  const { total, matched } = await matchingGroups(c, env, scope, compileRule(pattern)!, false);
  const where = scope === "project" ? `in allen Umgebungen von ${env.projectName}` : "dieser Umgebung";
  if (matched.length === 0) {
    return <p class="status-warn small">Passt derzeit auf keine der {formatNumber(total)} {groupsWord(total)} {where}. Anlegen geht trotzdem, die Regel greift dann bei neuen Fehlern.</p>;
  }
  const count = (s: MatchRow["status"]) => matched.filter((g) => g.status === s).length;
  const occurrences = matched.reduce((n, g) => n + g.occurrences, 0);
  return (
    <div class="stack">
      <p class="small">
        Passt auf {formatNumber(matched.length)} von {formatNumber(total)} {groupsWord(total)} {where} ({formatNumber(count("open"))} offen,{" "}
        {formatNumber(count("resolved"))} erledigt, {formatNumber(count("ignored"))} ignoriert), zusammen {formatNumber(occurrences)} Vorkommen.
        {matched.length === total && total > 1 && <span class="status-warn"> Das sind alle: ist der Ausdruck zu weit gefasst?</span>}
      </p>
      <ul class="rule-examples">
        {matched.slice(0, 5).map((g) => <li class="mono small">{errorTitle(g).slice(0, 200)}</li>)}
      </ul>
    </div>
  );
}

export function mountErrorRules(app: Hono) {
  app.get("/admin/env/:id/error-rules/preview", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 2);
    if (!env) return c.notFound();
    const pattern = (c.req.query("pattern") ?? "").trim();
    return c.html(<RulePreview c={c} env={env} pattern={pattern} scope={asScope(c.req.query("scope"))} />);
  });

  app.post("/admin/env/:id/error-rules", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 2);
    if (!env) return c.notFound();
    const back = `/env/${env.id}/errors`;
    const f = await formData(c);
    const pattern = (f.get("pattern") ?? "").trim();
    const problem = patternProblem(pattern);
    if (problem) return redirectWith(c, back, { kind: "bad", text: problem });
    const note = (f.get("note") ?? "").trim();
    if (note.length > MAX_NOTE) return redirectWith(c, back, { kind: "bad", text: `Die Notiz ist zu lang (höchstens ${MAX_NOTE} Zeichen).` });
    const scope = asScope(f.get("scope"));
    const environmentId = scope === "project" ? null : env.id;

    const [rule] = await rls(c, (tx) => tx`
      insert into error_ignore_rules (project_id, environment_id, pattern, note, created_by)
      values (${env.projectId}, ${environmentId}, ${pattern}, ${note || null}, ${c.get("user").id}) returning id`) as { id: number }[];
    let ignored = 0;
    if (f.get("apply") === "1") {
      const { matched } = await matchingGroups(c, env, scope, compileRule(pattern)!, true);
      if (matched.length) {
        const rows = await rls(c, (tx) => tx`
          update error_groups set status = 'ignored' where id = any(${intArray(tx, matched.map((g) => g.id))}) and status = 'open' returning id`);
        ignored = rows.length;
      }
    }
    await audit(c, "error_rule.created", String(rule!.id), { project_id: env.projectId, environment_id: environmentId, pattern, groups_ignored: ignored });
    const text = ignored ? `Regel angelegt, ${formatNumber(ignored)} offene ${groupsWord(ignored)} auf „Ignoriert“ gesetzt.` : "Regel angelegt.";
    return redirectWith(c, `${back}#ignore-rules`, { kind: "ok", text });
  });

  app.post("/admin/env/:id/error-rules/:ruleId/delete", async (c) => {
    const env = await loadEnv(c, parseId(c.req.param("id")) ?? 0, 2);
    const ruleId = parseId(c.req.param("ruleId"));
    if (!env || !ruleId) return c.notFound();
    const rows = await rls(c, (tx) => tx`
      delete from error_ignore_rules
      where id = ${ruleId} and (environment_id = ${env.id} or (environment_id is null and project_id = ${env.projectId}))
      returning pattern, environment_id`) as { pattern: string; environment_id: number | null }[];
    if (!rows.length) return c.notFound();
    await audit(c, "error_rule.deleted", String(ruleId), { project_id: env.projectId, environment_id: rows[0]!.environment_id, pattern: rows[0]!.pattern });
    return redirectWith(c, `/env/${env.id}/errors#ignore-rules`, { kind: "ok", text: "Regel gelöscht." });
  });
}
