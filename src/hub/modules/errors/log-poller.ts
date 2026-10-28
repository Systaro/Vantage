/**
 * Error groups from the logs, for applications that send nothing to APM. Run by the worker every
 * 60 s with its BYPASSRLS connection: per logs source (unless it has `errorGroups: false`), the ERROR
 * entries since its last poll are grouped here and stored like the APM groups (poller.ts,
 * `recordGroups`), with the same triage and "Neuer Fehler" events. An environment with several
 * sources gets one set of groups: the same error from two of them is one group.
 *
 * A group is one place in the code failing the same way: the logger, the exception class from the
 * first line of the stack trace and the first frames of the application's own code below it (framework
 * frames only when there are none), line numbers left out so a deploy does not split it. Framework
 * frames differ with the way a request came in (GET or POST, which filters ran) and would split one
 * error into several. Without a stack trace it is the logger and the first line of the message with
 * its variable parts (numbers, ids, quoted values) taken out. Elasticsearch cannot compute that
 * key, so the entries are read (up to `pageSize × maxPages` per poll) and grouped in the worker.
 */
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { EsError, logsEs, type EsClient } from "../es/client";
import { buildErrorPollSearch, toLogRow, type LogRow } from "../logs/query";
import { parseLogsConfig, type LogsSource } from "../sources/config";
import { recordGroups, type PolledGroup } from "./poller";

export interface LogPollDeps {
  es: EsClient;
  now: () => number;
  /** Shippers deliver with a delay; entries younger than this are left for the next poll. */
  lagMs: number;
  pageSize: number;
  maxPages: number;
}

const DAY = 24 * 3600_000;
const MAX_WINDOW = DAY;
/** Groups last seen longer ago than this (a catch-up after an outage) are stored without an event. */
const NOTIFY_WITHIN = 30 * 60_000;
const FRAMES = 5;
/** Frames of the JVM, the frameworks and generated proxies: never what an error is "about". */
const LIBRARY_FRAME = /^(?:java|javax|jakarta|jdk|sun|com\.sun|kotlin|kotlinx|scala|groovy|org\.codehaus\.groovy|org\.springframework|org\.hibernate|org\.apache|org\.postgresql|org\.eclipse|org\.slf4j|ch\.qos|com\.fasterxml|com\.zaxxer|com\.google|io\.micrometer|io\.netty|io\.undertow|reactor|net\.bytebuddy|okhttp3|feign|org\.aspectj)\.|\$\$/;

/** `java.lang.IllegalStateException: …` (or `…Exception` alone) at the start of a stack trace. */
const EXCEPTION = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)(?::|$)/;
/** `at org.example.Foo.bar(Foo.java:42)`: the method, without file and line. */
const FRAME = /^\s*at\s+([\w$.<>/-]+)\(/;

const EMAIL = /[^\s@<>]+@[^\s@<>]+\.\w+/y;
const WORD_BREAK = /[\s@<>]/;

/**
 * `text.replace(/[^\s@<>]+@[^\s@<>]+\.\w+/g, "<email>")` without its quadratic search: the regex tries
 * every position of a long word that has no "@" again, about a millisecond per long message. A match
 * can only begin where a word begins or where the previous match ended, so only those are tried.
 */
export function replaceEmails(text: string): string {
  let out = "";
  let done = 0;
  for (let i = 0; i < text.length; i++) {
    if (i !== done && !WORD_BREAK.test(text[i - 1]!)) continue;
    EMAIL.lastIndex = i;
    if (!EMAIL.exec(text)) continue;
    out += `${text.slice(done, i)}<email>`;
    done = EMAIL.lastIndex;
    i = done - 1;
  }
  return out + text.slice(done);
}

/**
 * The message's first line without what changes from one occurrence to the next. Session ids are
 * random letters as often as not (`in session uymxomlv`), so the word before them marks them, not
 * their digits; a bare `session <word>` is left alone, it is as likely `session expired`.
 */
export function messageShape(message: string): string {
  const unquoted = (message.split("\n", 1)[0] ?? "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, "<token>")
    .replace(/\b((?:in|for) session )[\w-]{4,}/gi, "$1<id>")
    .replace(/\b(session(?:[ _-]?id)?|sid|token)(\s*[:=#]\s*|\s+)(?=[\w-]*\d)[\w-]{6,}/gi, "$1$2<id>")
    .replace(/'[^']*'|"[^"]*"/g, "<text>");
  return replaceEmails(unquoted)
    .replace(/([\w$])@[0-9a-f]{1,8}\b/g, "$1@<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export interface LogErrorSignature {
  key: string;
  type: string | null;
  message: string | null;
  culprit: string | null;
}

export function logErrorSignature(row: LogRow): LogErrorSignature {
  const lines = row.stack.split("\n");
  const type = EXCEPTION.exec(lines[0]?.trim() ?? "")?.[1] ?? null;
  const frames = lines.map((l) => FRAME.exec(l)?.[1]).filter((f): f is string => !!f);
  const own = frames.filter((f) => !LIBRARY_FRAME.test(f));
  const keyFrames = (own.length ? own : frames).slice(0, FRAMES);
  const basis = type && keyFrames.length ? [row.logger, type, ...keyFrames] : [row.logger, type ?? "", messageShape(row.message)];
  return {
    key: `log:${createHash("sha1").update(basis.join("|")).digest("hex")}`,
    type,
    message: row.message.split("\n", 1)[0]!.trim().slice(0, 2000) || null,
    culprit: own[0] ?? frames[0] ?? (row.logger || null),
  };
}

/** Rows in reading order (oldest first) to one group per signature; the newest row describes it. */
export function groupLogErrors(rows: LogRow[]): PolledGroup[] {
  const groups = new Map<string, PolledGroup>();
  for (const row of rows) {
    const sig = logErrorSignature(row);
    const at = new Date(row.ts);
    const g = groups.get(sig.key);
    const info = { type: sig.type, message: sig.message, culprit: sig.culprit, handled: null };
    if (!g) {
      groups.set(sig.key, { key: sig.key, info, count: 1, firstSeen: at, lastSeen: at, sampleEntryId: row.id });
      continue;
    }
    g.count += 1;
    if (at < g.firstSeen) g.firstSeen = at;
    if (at >= g.lastSeen) Object.assign(g, { lastSeen: at, info, sampleEntryId: row.id });
  }
  return [...groups.values()];
}

/**
 * The entries of [since, windowEnd), page by page in time order. A full page ends just before its
 * last millisecond, which the next page (or poll) reads whole, so nothing is counted twice and
 * nothing is skipped; only a millisecond that fills a page by itself is taken as it comes.
 */
export async function readErrorEntries(d: LogPollDeps, source: LogsSource, since: number, windowEnd: number): Promise<{ rows: LogRow[]; until: number }> {
  const rows: LogRow[] = [];
  let done = since;
  for (let page = 0; page < d.maxPages && done < windowEnd; page++) {
    const { index, body } = buildErrorPollSearch(source, done, windowEnd, d.pageSize);
    const hits = (await d.es.search(index, body)).hits.hits.map(toLogRow);
    if (hits.length < d.pageSize) {
      rows.push(...hits);
      done = windowEnd;
      break;
    }
    const lastTs = hits.at(-1)!.ts;
    if (hits[0]!.ts === lastTs) {
      rows.push(...hits);
      done = lastTs + 1;
      continue;
    }
    rows.push(...hits.filter((h) => h.ts < lastTs));
    done = lastTs;
  }
  return { rows, until: done };
}

export async function pollLogErrors(sql: SQL, log: (msg: string) => void = () => {}, deps: Partial<LogPollDeps> = {}): Promise<void> {
  const d: LogPollDeps = { es: logsEs, now: Date.now, lagMs: 60_000, pageSize: 1000, maxPages: 5, ...deps };
  const rows = (await sql`
    select s.id, s.environment_id, s.config, p.polled_until
    from environment_sources s left join log_error_poll_state p on p.source_id = s.id
    where s.kind = 'logs' order by s.environment_id, s.id`) as { id: number; environment_id: number; config: unknown; polled_until: Date | null }[];
  for (const row of rows) {
    const at = `environment ${row.environment_id}, source ${row.id}`;
    try {
      const source = parseLogsConfig(row.config);
      if (!source) throw new EsError("Logs-Quelle ist ungültig konfiguriert");
      if (source.errorGroups === false) continue;
      await pollSource(sql, d, row, source, at, log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`log errors: ${at}: ${message}`);
      await sql`
        insert into log_error_poll_state (source_id, polled_until, last_error) values (${row.id}, null, ${message.slice(0, 1000)})
        on conflict (source_id) do update set last_error = excluded.last_error, updated_at = now()`;
    }
  }
}

async function pollSource(
  sql: SQL,
  d: LogPollDeps,
  row: { id: number; environment_id: number; polled_until: Date | null },
  source: LogsSource,
  at: string,
  log: (msg: string) => void,
) {
  const polledUntil = row.polled_until;
  const now = d.now();
  const until = now - d.lagMs;
  const backfill = polledUntil === null;
  const since = backfill ? until - DAY : polledUntil.getTime();
  if (until <= since) return;
  const read = await readErrorEntries(d, source, since, Math.min(until, since + MAX_WINDOW));
  const groups = groupLogErrors(read.rows);
  await sql.begin(async (tx) => {
    const events = await recordGroups(tx, row.environment_id, "logs", groups, backfill ? Infinity : now - NOTIFY_WITHIN);
    await tx`
      insert into log_error_poll_state (source_id, polled_until, last_error, updated_at) values (${row.id}, ${new Date(read.until)}, null, now())
      on conflict (source_id) do update set polled_until = excluded.polled_until, last_error = null, updated_at = now()`;
    if (groups.length || events) {
      log(`log errors: ${at}: ${read.rows.length} entries in ${groups.length} group(s), ${events} event(s)${backfill ? " (backfill)" : ""}`);
    }
  });
}
