/**
 * Error polling (design §6.3), run by the worker every 60 s with its BYPASSRLS connection.
 * Per environment with an APM source: group the error documents since the last poll by
 * `error.grouping_key`, upsert `error_groups`, and emit `notice` events for new groups and for
 * resolved groups that came back. The very first poll is a silent 24 h backfill.
 */
import type { SQL } from "bun";
import { apmEs, apmIndices, EsError, type EsClient, type EsIndex } from "../es/client";
import { parseApmConfig } from "../sources/config";
import { dropIgnored } from "./ignore-rules";
import { buildPollSearch, describeError, errorTitle, type ErrorSummary } from "./query";

export interface PollDeps {
  es: EsClient;
  index: EsIndex;
  now: () => number;
  /** APM agents flush every few seconds; documents younger than this are left for the next poll. */
  lagMs: number;
}

const DAY = 24 * 3600_000;
/** One poll never asks for more than a day; after an outage the worker catches up a day per run. */
const MAX_WINDOW = DAY;

export async function pollErrors(sql: SQL, log: (msg: string) => void = () => {}, deps: Partial<PollDeps> = {}): Promise<void> {
  const d: PollDeps = { es: apmEs, index: apmIndices.errors, now: Date.now, lagMs: 60_000, ...deps };
  const rows = (await sql`
    select s.environment_id, s.config, p.polled_until
    from environment_sources s left join error_poll_state p on p.environment_id = s.environment_id
    where s.kind = 'apm' order by s.environment_id`) as { environment_id: number; config: unknown; polled_until: Date | null }[];
  for (const row of rows) {
    const envId = row.environment_id;
    try {
      const source = parseApmConfig(row.config);
      if (!source) throw new EsError("APM-Quelle ist ungültig konfiguriert");
      await pollEnvironment(sql, d, envId, source, row.polled_until, log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`errors: environment ${envId}: ${message}`);
      await sql`
        insert into error_poll_state (environment_id, polled_until, last_error) values (${envId}, null, ${message.slice(0, 1000)})
        on conflict (environment_id) do update set last_error = excluded.last_error, updated_at = now()`;
    }
  }
}

async function pollEnvironment(
  sql: SQL,
  d: PollDeps,
  envId: number,
  source: { service: string; environment: string },
  polledUntil: Date | null,
  log: (msg: string) => void,
) {
  const until = d.now() - d.lagMs;
  const backfill = polledUntil === null;
  const since = backfill ? until - DAY : polledUntil.getTime();
  if (until <= since) return;
  const windowEnd = Math.min(until, since + MAX_WINDOW);

  const { index, body } = buildPollSearch(source, since, windowEnd, d.index);
  const res = await d.es.search(index, body);
  const buckets = (res.aggregations?.groups?.buckets ?? []) as any[];
  const groups: PolledGroup[] = [];
  for (const b of buckets) {
    const key = String(b.key);
    if (!key || key.length > 200) continue;
    groups.push({
      key,
      info: describeError(b.newest?.hits?.hits?.[0]?._source),
      count: Number(b.doc_count) || 0,
      firstSeen: new Date(b.first?.value ?? windowEnd),
      lastSeen: new Date(b.last?.value ?? windowEnd),
    });
  }

  await sql.begin(async (tx) => {
    const events = await recordGroups(tx, envId, "apm", groups, backfill ? Infinity : -Infinity);
    await tx`
      insert into error_poll_state (environment_id, polled_until, last_error, updated_at) values (${envId}, ${new Date(windowEnd)}, null, now())
      on conflict (environment_id) do update set polled_until = excluded.polled_until, last_error = null, updated_at = now()`;
    if (groups.length || events) {
      log(`errors: environment ${envId}: ${groups.length} group(s), ${events} event(s)${backfill ? " (backfill)" : ""}`);
    }
  });
}

export interface PolledGroup {
  /** `error.grouping_key` from APM, or "log:<hash>" for a group built from log entries. */
  key: string;
  info: ErrorSummary;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  /** logs: the newest entry's id */
  sampleEntryId?: string;
}

/**
 * Error events per environment within an hour. What would go past it becomes one summary event, and
 * after a summary the environment stays quiet for the rest of the hour: an application that suddenly
 * fails in a hundred new ways is one mail, not a hundred, and the errors page lists all of them.
 */
const MAX_EVENTS_PER_HOUR = 10;

/**
 * Upserts the groups of one poll that no ignore rule drops and emits a `notice` event for each group
 * that is new or came back after "Erledigt", if it was last seen at or after `notifyFrom` (a backfill
 * passes Infinity), within the hourly limit. Returns the number of events written.
 */
export async function recordGroups(tx: SQL, envId: number, source: "apm" | "logs", polled: PolledGroup[], notifyFrom: number): Promise<number> {
  const groups = await dropIgnored(tx, envId, polled);
  const events: { key: string; title: string; body: string | null; groupId: number }[] = [];
  for (const g of groups) {
    const { info } = g;
    const notify = g.lastSeen.getTime() >= notifyFrom;
    const [prev] = (await tx`
      select id, status from error_groups where environment_id = ${envId} and grouping_key = ${g.key} for update`) as { id: number; status: string }[];
    if (!prev) {
      const [row] = (await tx`
        insert into error_groups (environment_id, grouping_key, source, exception_type, message, culprit, handled, first_seen_at, last_seen_at, occurrences, sample_entry_id)
        values (${envId}, ${g.key}, ${source}, ${info.type}, ${info.message}, ${info.culprit}, ${info.handled}, ${g.firstSeen}, ${g.lastSeen}, ${g.count}, ${g.sampleEntryId ?? null})
        returning id`) as { id: number }[];
      if (notify) events.push({ key: g.key, groupId: row!.id, title: `Neuer Fehler: ${errorTitle(info)}`, body: info.culprit && `Ort: ${info.culprit}` });
      continue;
    }
    // Column references in SET see the old row, so `status = 'resolved'` asks for the state before this poll.
    await tx`
      update error_groups set
        occurrences = occurrences + ${g.count},
        first_seen_at = least(first_seen_at, ${g.firstSeen}),
        last_seen_at = greatest(last_seen_at, ${g.lastSeen}),
        exception_type = coalesce(${info.type}, exception_type),
        message = coalesce(${info.message}, message),
        culprit = coalesce(${info.culprit}, culprit),
        handled = coalesce(${info.handled}, handled),
        sample_entry_id = coalesce(${g.sampleEntryId ?? null}, sample_entry_id),
        status_changed_at = case when status = 'resolved' then now() else status_changed_at end,
        status_changed_by = case when status = 'resolved' then null else status_changed_by end,
        status = case when status = 'resolved' then 'open' else status end
      where id = ${prev.id}`;
    if (prev.status === "resolved" && notify) {
      events.push({ key: g.key, groupId: prev.id, title: `Fehler wieder aufgetreten: ${errorTitle(info)}`, body: info.culprit && `Ort: ${info.culprit}` });
    }
  }
  if (!events.length) return 0;
  const burstKey = `errors:${envId}:burst:`;
  const [recent] = (await tx`
    select count(*)::int as sent, count(*) filter (where subject_key like ${`${burstKey}%`})::int as bursts
    from events where source = 'errors' and environment_id = ${envId} and at > now() - interval '1 hour'`) as { sent: number; bursts: number }[];
  if (recent!.bursts) return 0;
  if (recent!.sent + events.length > MAX_EVENTS_PER_HOUR) {
    const body = [...events.slice(0, 5).map((e) => e.title), "", "Für diese Umgebung folgt in der nächsten Stunde keine weitere Fehlermeldung. Die Fehlerseite zeigt alle Fehler."];
    await tx`
      insert into events (source, environment_id, subject_key, state, severity, title, body, link)
      values ('errors', ${envId}, ${`${burstKey}${Date.now()}`}, 'notice', 'warning', ${`${events.length} neue oder wieder aufgetretene Fehler`},
        ${body.join("\n").slice(0, 2000)}, ${`/env/${envId}/errors`})`;
    return 1;
  }
  for (const e of events) {
    await tx`
      insert into events (source, environment_id, subject_key, state, severity, title, body, link)
      values ('errors', ${envId}, ${`error:${envId}:${e.key}`}, 'notice', 'warning', ${e.title.slice(0, 300)}, ${e.body}, ${`/env/${envId}/errors/${e.groupId}`})`;
  }
  return events.length;
}

