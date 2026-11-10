/** `bun run migrate` — migrates the hub database and the ops database with their owner roles. */
import { join } from "node:path";
import { env } from "./config";
import { connect } from "./db";
import { migrate } from "./migrate";

const targets = process.argv.slice(2);
const which = targets.length ? targets : ["hub", "ops"];

for (const target of which) {
  if (target !== "hub" && target !== "ops") throw new Error(`Unknown migration target "${target}"`);
  const url = target === "hub" ? env("HUB_MIGRATE_URL") : env("OPS_MIGRATE_URL");
  const sql = connect(url, 1);
  const applied = await migrate(sql, join(import.meta.dir, "..", target, "migrations"));
  console.log(`${target}: ${applied.length ? `${applied.length} applied` : "up to date"}`);
  await sql.end();
}
