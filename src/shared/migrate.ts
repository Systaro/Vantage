import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "bun";

/**
 * Applies `NNN_name.sql` files in order, each in its own transaction, recorded in
 * `schema_migrations`. Files are never edited after they ran somewhere; fixes go in a new file.
 */
export async function migrate(sql: SQL, dir: string, log: (msg: string) => void = console.log): Promise<string[]> {
  await sql.unsafe(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const done = new Set((await sql`select name from schema_migrations`).map((r: { name: string }) => r.name));
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const text = await Bun.file(join(dir, file)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    log(`migrated ${file}`);
    applied.push(file);
  }
  return applied;
}
