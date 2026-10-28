/**
 * The hub's background process: uptime probes, alert routing and delivery, error polling and
 * retention. Runs as vantage_worker (BYPASSRLS) and has no HTTP port. A Postgres advisory lock makes
 * a second replica wait instead of probing everything twice.
 */
import { env } from "../shared/config";
import { connect } from "../shared/db";
import { alertsRetention, deliverNotifications, processEvents } from "./modules/alerts/engine";
import { semaphore } from "./modules/ansible/semaphore";
import { ansibleRetention, syncAnsible } from "./modules/ansible/sync";
import { pollLogErrors } from "./modules/errors/log-poller";
import { pollErrors } from "./modules/errors/poller";
import { checkIntegrations } from "./modules/integrations/checks";
import { importIntegrationsFromEnv, initIntegrations, mailConnection, semaphoreConnection } from "./modules/integrations/store";
import { processRunnerResults, processServerReports, runnersRetention, runnerWatchdogs } from "./modules/runners/process";
import { syncSecurity } from "./modules/security/sync";
import { purgeReports } from "./modules/tests/storage";
import { uptimeRetention, uptimeTick } from "./modules/uptime/engine";

const LOCK_ID = 7_100_001;
const sql = connect(env("WORKER_DATABASE_URL"), 12);
const secret = env("HUB_SECRET");
const delivery = { secret, publicUrl: env("HUB_PUBLIC_URL"), mail: mailConnection };
initIntegrations(sql, secret);
const log = (msg: string) => console.log(`[worker] ${msg}`);

let stopping = false;
const timers: ReturnType<typeof setInterval>[] = [];

/** Runs `fn` every `ms`, never overlapping with itself, logging failures instead of dying. */
function every(name: string, ms: number, fn: () => Promise<unknown>) {
  let busy = false;
  const run = async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      log(`${name} failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };
  timers.push(setInterval(run, ms));
  void run();
}

async function retention() {
  await uptimeRetention(sql);
  await alertsRetention(sql);
  await ansibleRetention(sql);
  await runnersRetention(sql);
  await sql`delete from audit_log where at < now() - interval '2 years'`;
  await sql`delete from login_attempts where at < now() - interval '30 days'`;
  await sql`delete from sessions where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days'`;
  await sql`delete from trusted_devices where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days'`;
  await sql`delete from invites where expires_at < now() - interval '30 days'`;
}

const lockConn = await sql.reserve();
log("waiting for the worker lock");
while (!stopping) {
  const [row] = (await lockConn`select pg_try_advisory_lock(${LOCK_ID}) as ok`) as { ok: boolean }[];
  if (row?.ok) break;
  await Bun.sleep(5000);
}
log("lock acquired, starting loops");

const imported = await importIntegrationsFromEnv(sql, secret);
if (imported.length) log(`integrations taken over from the environment: ${imported.join(", ")}`);

every("uptime", 1000, () => uptimeTick(sql, secret, log));
every("runners.results", 1000, async () => {
  await processRunnerResults(sql);
  await processServerReports(sql);
});
every("runners.watchdog", 30_000, () => runnerWatchdogs(sql));
every("alerts.route", 2000, () => processEvents(sql));
every("alerts.deliver", 3000, () => deliverNotifications(sql, delivery, log));
every("retention", 3600_000, retention);

every("errors", 60_000, () => pollErrors(sql, log));
every("log-errors", 60_000, () => pollLogErrors(sql, log));
every("tests.purge", 3600_000, () => purgeReports(sql, env("STORAGE_DIR", "./data/storage"), log));
every("integrations", 5 * 60_000, () => checkIntegrations(sql, log));
every("security", 60_000, () => syncSecurity(sql, log));
every("ansible", 60_000, async () => {
  if (await semaphoreConnection()) await syncAnsible(sql, semaphore, log);
});

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("stopping");
  for (const t of timers) clearInterval(t);
  await Bun.sleep(500);
  lockConn.release();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
