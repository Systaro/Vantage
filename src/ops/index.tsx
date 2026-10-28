/**
 * The ops process: HTTP server plus every scheduler (cron runner, central sweep, silent detection,
 * outbox sender, retention). SIGTERM / SIGINT stop the schedulers, give running playbooks 30 s and
 * then cancel them; the container's stop grace period must allow for that (≥ 45 s).
 */
import { mkdirSync } from "node:fs";
import { createOpsApp } from "./app";
import { loadOpsConfig } from "./config";
import { connect } from "../shared/db";
import { createOps } from "./service";

const config = loadOpsConfig();
mkdirSync(config.dataDir, { recursive: true });
const sql = connect(config.databaseUrl);
const ops = createOps(config, sql);
const app = createOpsApp(ops);

const server = Bun.serve({
  port: config.port,
  hostname: process.env.OPS_LISTEN ?? "0.0.0.0",
  // Live logs are long-lived SSE responses; Bun's default 10 s idle timeout would cut them.
  idleTimeout: 0,
  fetch: (req, srv) => app.fetch(req, srv),
});
await ops.start();

console.log(`[ops] listening on ${server.url} (public ${config.publicUrl}), ansible project ${config.ansible.projectDir}`);
if (!config.hubEventToken) console.warn("[ops] OPS_HUB_EVENT_TOKEN is empty: events stay in the outbox until it is set");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[ops] ${signal}: stopping schedulers, waiting up to 30 s for running playbooks`);
  await server.stop(true);
  await ops.stop(30_000);
  await sql.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
