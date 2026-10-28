/**
 * Ignore rules (#69811): an admin's regular expression on an error's title ("Type: message", as the
 * list shows it) or its place. `recordGroups` drops the groups a rule matches before storing them, so
 * they make no group and no event; each rule counts the occurrences it dropped.
 *
 * JavaScript regexes backtrack, and a careless pattern on a long message could stall the worker: the
 * pattern is limited in length, nested repetition is refused, and only the first MATCH_CHARS
 * characters of a text are matched.
 */
import type { SQL } from "bun";
import { messageShape } from "./log-poller";
import type { PolledGroup } from "./poller";
import { errorTitle } from "./query";

export const MAX_PATTERN = 300;
const MATCH_CHARS = 2000;
/** A repeated group that repeats inside, like (a+)+ or (?:\w+\s?)*: the classic catastrophic backtracking. */
const NESTED_REPEAT = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,)/;

export function compileRule(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function patternProblem(pattern: string): string | null {
  if (!pattern) return "Bitte einen regulären Ausdruck angeben.";
  if (pattern.length > MAX_PATTERN) return `Der Ausdruck ist zu lang (höchstens ${MAX_PATTERN} Zeichen).`;
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch (err) {
    return `Kein gültiger regulärer Ausdruck: ${(err as Error).message}`;
  }
  if (NESTED_REPEAT.test(pattern)) return "Verschachtelte Wiederholungen wie (a+)+ sind nicht erlaubt, sie können die Fehlerauswertung lahmlegen.";
  if (re.test("")) return "Der Ausdruck trifft schon einen leeren Text und damit jeden Fehler.";
  return null;
}

export function ruleMatches(re: RegExp, info: Parameters<typeof errorTitle>[0] & { culprit: string | null }): boolean {
  return re.test(errorTitle(info).slice(0, MATCH_CHARS)) || (!!info.culprit && re.test(info.culprit.slice(0, MATCH_CHARS)));
}

/** The rules of one environment: its own and its project's. */
export async function rulesFor(tx: SQL, envId: number): Promise<{ id: number; re: RegExp }[]> {
  const rows = (await tx`
    select r.id, r.pattern from error_ignore_rules r join environments e on e.id = ${envId}
    where r.environment_id = e.id or (r.environment_id is null and r.project_id = e.project_id)
    order by r.id`) as { id: number; pattern: string }[];
  return rows.flatMap((r) => {
    const re = compileRule(r.pattern);
    return re ? [{ id: r.id, re }] : [];
  });
}

/** The groups no rule matches; the matched ones are counted on the first rule that matches them. */
export async function dropIgnored(tx: SQL, envId: number, groups: PolledGroup[]): Promise<PolledGroup[]> {
  if (!groups.length) return groups;
  const rules = await rulesFor(tx, envId);
  if (!rules.length) return groups;
  const dropped = new Map<number, { n: number; last: Date }>();
  const kept = groups.filter((g) => {
    const rule = rules.find((r) => ruleMatches(r.re, g.info));
    if (!rule) return true;
    const d = dropped.get(rule.id);
    dropped.set(rule.id, { n: (d?.n ?? 0) + g.count, last: d && d.last > g.lastSeen ? d.last : g.lastSeen });
    return false;
  });
  for (const [id, d] of dropped) {
    await tx`
      update error_ignore_rules set matched = matched + ${d.n}, last_matched_at = greatest(last_matched_at, ${d.last})
      where id = ${id}`;
  }
  return kept;
}

const PLACEHOLDER = /<(n|id|token|text|email)>/g;
const WILDCARD: Record<string, string> = { n: "\\d+", id: "\\S+", token: "\\S+", email: "\\S+", text: ".+?" };
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A starting point for "Ähnliche ignorieren": the start of the group's message, its variable parts
 * (numbers, ids, quoted values) as wildcards, so the rule also takes the next session or order number.
 */
export function suggestPattern(g: { exception_type: string | null; message: string | null }): string {
  let shape = messageShape(g.message ?? "");
  if (!shape) return g.exception_type ? escapeRegex(g.exception_type) : "";
  if (shape.length > 100) {
    const cut = shape.slice(0, 100);
    const at = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf(";"), cut.lastIndexOf(":"));
    shape = (at > 40 ? cut.slice(0, at) : cut).replace(/<[a-z]*$/, "");
  }
  let out = "";
  let done = 0;
  for (const m of shape.matchAll(PLACEHOLDER)) {
    out += escapeRegex(shape.slice(done, m.index)) + WILDCARD[m[1]!];
    done = m.index + m[0].length;
  }
  return (out + escapeRegex(shape.slice(done))).trim();
}
