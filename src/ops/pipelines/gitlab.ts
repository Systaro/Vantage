/**
 * GitLab pipeline triggers for scheduled test runs. The trigger token is stored encrypted with
 * OPS_SECRET and only decrypted for the request; it is never rendered or logged.
 */
import type { SQL } from "bun";
import { decryptString } from "../../shared/crypto";
import { setAlert, subjectOf } from "../alerts";
import { first } from "../../shared/db";

export interface PipelineVariable {
  key: string;
  value: string;
}

export const VARIABLE_KEY = /^[A-Z_][A-Z0-9_]*$/;
/** Numeric id or `group/sub/project`; segments start with a letter, digit or _ (so never "." or ".."). */
export const PROJECT_PATTERN = /^([0-9]{1,12}|[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*){1,10})$/;
export const REF_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;

/** `KEY=value` per line → variables, or a German error message. */
export function parseVariables(text: string): { ok: true; variables: PipelineVariable[] } | { ok: false; error: string } {
  const variables: PipelineVariable[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    const key = eq < 0 ? line : line.slice(0, eq).trim();
    if (eq < 0 || !VARIABLE_KEY.test(key) || key.length > 255) {
      return { ok: false, error: `Variablen, Zeile ${i + 1}: erwartet „SCHLÜSSEL=Wert“, Schlüssel nur A–Z, 0–9 und _ (nicht mit einer Ziffer beginnend).` };
    }
    if (seen.has(key)) return { ok: false, error: `Variablen: „${key}“ kommt doppelt vor.` };
    const value = line.slice(eq + 1);
    if (value.length > 10_000) return { ok: false, error: `Variablen: Wert von „${key}“ ist zu lang.` };
    seen.add(key);
    variables.push({ key, value });
  }
  if (variables.length > 50) return { ok: false, error: "Variablen: höchstens 50." };
  return { ok: true, variables };
}

export function variablesText(vars: PipelineVariable[]): string {
  return vars.map((v) => `${v.key}=${v.value}`).join("\n");
}

export type TriggerResult =
  | { ok: true; httpStatus: number; pipelineId: number | null; webUrl: string | null }
  | { ok: false; httpStatus: number | null; error: string };

export async function triggerPipeline(
  gitlabUrl: string,
  p: { project: string; ref: string; token: string; variables: PipelineVariable[] },
  fetchImpl: typeof fetch = fetch,
): Promise<TriggerResult> {
  const body = new URLSearchParams();
  body.set("token", p.token);
  body.set("ref", p.ref);
  for (const v of p.variables) body.set(`variables[${v.key}]`, v.value);
  let res: Response;
  try {
    res = await fetchImpl(`${gitlabUrl}/api/v4/projects/${encodeURIComponent(p.project)}/trigger/pipeline`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, httpStatus: null, error: `GitLab nicht erreichbar: ${(err as Error).message}`.slice(0, 500) };
  }
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = json?.message ?? json?.error ?? text;
    return { ok: false, httpStatus: res.status, error: `GitLab antwortet ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`.slice(0, 500) };
  }
  const id = Number(json?.id);
  const webUrl = typeof json?.web_url === "string" && /^https?:\/\//.test(json.web_url) ? json.web_url.slice(0, 1000) : null;
  return { ok: true, httpStatus: res.status, pipelineId: Number.isSafeInteger(id) ? id : null, webUrl };
}

export interface PipelineDeps {
  sql: SQL;
  secret: string;
  gitlabUrl: string;
  publicUrl: string;
  fetch?: typeof fetch;
  onAlert?: () => void;
}

const inFlight = new Set<number>();

/** Triggers one schedule, records the attempt and keeps the schedule's alert state current. */
export async function runPipelineSchedule(
  d: PipelineDeps,
  scheduleId: number,
  trigger: "manual" | "schedule",
  actor: { id: number | null; label: string },
): Promise<{ ok: boolean; message: string; triggerId?: number }> {
  if (inFlight.has(scheduleId)) return { ok: false, message: "Diese Pipeline wird gerade schon ausgelöst." };
  inFlight.add(scheduleId);
  try {
    const s = await first<any>(d.sql`select * from pipeline_schedules where id = ${scheduleId}`);
    if (!s) return { ok: false, message: "Zeitplan nicht gefunden." };
    if (!s.enabled) return { ok: false, message: "Der Zeitplan ist deaktiviert." };
    let token: string;
    try {
      token = await decryptString(d.secret, s.token_enc);
    } catch {
      token = "";
    }
    const result: TriggerResult = token
      ? await triggerPipeline(d.gitlabUrl, { project: s.project, ref: s.ref, token, variables: s.variables ?? [] }, d.fetch)
      : { ok: false, httpStatus: null, error: "Das Trigger-Token lässt sich nicht entschlüsseln (OPS_SECRET geändert?). Bitte neu eintragen." };
    const row = await first<{ id: number }>(d.sql`
      insert into pipeline_triggers (schedule_id, trigger, started_by, started_by_label, status, http_status, pipeline_id, web_url, error)
      values (${s.id}, ${trigger}, ${actor.id}, ${actor.label}, ${result.ok ? "ok" : "failed"}, ${result.httpStatus},
              ${result.ok ? result.pipelineId : null}, ${result.ok ? result.webUrl : null}, ${result.ok ? null : result.error})
      returning id`);
    const subject = subjectOf("pipeline", s.name);
    const link = `${d.publicUrl}/schedules/${s.id}`;
    const change = result.ok
      ? await setAlert(d.sql, subject, null, { title: `Pipeline „${s.name}“ wird wieder ausgelöst`, link })
      : await setAlert(d.sql, subject, {
          severity: "warning",
          title: `Pipeline „${s.name}“ ließ sich nicht auslösen`,
          body: `${s.project} @ ${s.ref}: ${result.error}`,
          link,
        });
    if (change) d.onAlert?.();
    return result.ok
      ? { ok: true, message: `Pipeline ausgelöst${result.pipelineId ? ` (#${result.pipelineId})` : ""}.`, triggerId: row!.id }
      : { ok: false, message: result.error, triggerId: row!.id };
  } finally {
    inFlight.delete(scheduleId);
  }
}
