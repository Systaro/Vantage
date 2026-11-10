/**
 * Worker side of the Ansible runs: every minute the newest runs from Semaphore go into ansible_runs,
 * and each finished run's output is read once for its PLAY RECAP (ansible_run_hosts). The first
 * sync takes the last 200 runs (about a week), later ones the last 50; runs still going are looked
 * up one by one until they finish. Which environment a run belongs to is decided at read time,
 * through the servers an environment lists, so remapping a server needs no resync.
 */
import type { SQL } from "bun";
import { FINAL_STATUSES, RecapParser, SemaphoreError, type SemaphoreApi, type SemaphoreTask } from "./semaphore";

const BACKFILL = 200;
const RECENT = 50;
const OUTPUTS_PER_TICK = 20;
const OPEN_PER_TICK = 20;
const MAX_ATTEMPTS = 3;

const date = (v: string | null | undefined) => (v ? new Date(v) : null);

async function upsertRun(sql: SQL, t: SemaphoreTask) {
  await sql`
    insert into ansible_runs (id, template_id, template_name, playbook, status, trigger, created_at, started_at, ended_at, synced_at)
    values (${t.id}, ${t.template_id}, ${(t.tpl_alias?.trim() || `Vorlage ${t.template_id}`).slice(0, 300)}, ${t.tpl_playbook?.slice(0, 300) || null},
            ${t.status.slice(0, 40)}, ${t.schedule_id ? "schedule" : "manual"}, ${new Date(t.created)}, ${date(t.start)}, ${date(t.end)}, now())
    on conflict (id) do update set status = excluded.status, started_at = excluded.started_at, ended_at = excluded.ended_at, synced_at = now(),
      template_name = case when ${!!t.tpl_alias} then excluded.template_name else ansible_runs.template_name end,
      playbook = coalesce(excluded.playbook, ansible_runs.playbook)`;
}

/** Reads a finished run's output and stores what each server reported. */
async function parseRun(sql: SQL, api: SemaphoreApi, id: number): Promise<boolean> {
  const parser = new RecapParser();
  try {
    await api.output(id, (line) => parser.push(line));
  } catch (err) {
    if (!(err instanceof SemaphoreError)) throw err;
    await sql`update ansible_runs set parse_attempts = parse_attempts + 1, parse_error = ${err.message.slice(0, 300)},
                parsed_at = case when parse_attempts + 1 >= ${MAX_ATTEMPTS} then now() end where id = ${id}`;
    return false;
  }
  const hosts = parser.result();
  await sql.begin(async (tx) => {
    await tx`delete from ansible_run_hosts where run_id = ${id}`;
    for (const h of hosts) {
      await tx`insert into ansible_run_hosts (run_id, host, ok, changed, unreachable, failed, skipped, rescued, ignored, failed_task)
               values (${id}, ${h.host}, ${h.ok}, ${h.changed}, ${h.unreachable}, ${h.failed}, ${h.skipped}, ${h.rescued}, ${h.ignored}, ${h.failedTask})`;
    }
    await tx`update ansible_runs set parsed_at = now(), parse_attempts = parse_attempts + 1, parse_error = null where id = ${id}`;
  });
  return true;
}

/** One worker tick. Returns how many runs were read for their servers. */
export async function syncAnsible(sql: SQL, api: SemaphoreApi, log: (m: string) => void): Promise<number> {
  const n = ((await sql`select count(*)::int as n from ansible_runs`) as { n: number }[])[0]?.n ?? 0;
  const tasks = await api.lastTasks(n === 0 ? BACKFILL : RECENT);
  for (const t of tasks) await upsertRun(sql, t);

  // Runs that were still going when they dropped out of the recent list.
  const seen = sql.array([0, ...tasks.map((t) => t.id)], "int4");
  const open = (await sql`select id from ansible_runs where status <> all(${sql.array(FINAL_STATUSES, "text")}) and id <> all(${seen})
                          order by id desc limit ${OPEN_PER_TICK}`) as { id: number }[];
  for (const { id } of open) {
    const t = await api.task(id);
    if (t) await upsertRun(sql, t);
    else await sql`delete from ansible_runs where id = ${id}`;
  }

  const due = (await sql`select id from ansible_runs where parsed_at is null and status = any(${sql.array(FINAL_STATUSES, "text")})
                         order by id desc limit ${OUTPUTS_PER_TICK}`) as { id: number }[];
  let parsed = 0;
  for (const { id } of due) if (await parseRun(sql, api, id)) parsed++;
  if (n === 0 && tasks.length) log(`ansible: first sync, ${tasks.length} runs from Semaphore`);
  return parsed;
}

export async function ansibleRetention(sql: SQL) {
  await sql`delete from ansible_runs where created_at < now() - interval '1 year'`;
}
