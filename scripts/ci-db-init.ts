/**
 * CI only: creates the roles from docker/postgres-init.sql on the job's postgres service, so the
 * RLS tests run against the same role layout as dev and production.
 */
import { SQL } from "bun";

const sql = new SQL(process.env.PG_ADMIN_URL!);
const text = await Bun.file("docker/postgres-init.sql").text();
for (const statement of text.split(";").map((s) => s.replace(/--.*$/gm, "").trim()).filter(Boolean)) {
  if (/^create database/i.test(statement)) continue;
  await sql.unsafe(statement);
}
await sql.end();
console.log("roles created");
