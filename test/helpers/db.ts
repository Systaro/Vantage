/**
 * Throwaway databases for tests: one per test file, migrated, with connections for every role.
 * Requires the dev Postgres (docker/compose.dev.yml) and PG_ADMIN_URL.
 */
import { join } from "node:path";
import { SQL } from "bun";
import { migrate } from "../../src/shared/migrate";

const ADMIN_URL = process.env.PG_ADMIN_URL ?? "postgres://postgres:vantage_dev@127.0.0.1:5460/postgres";

function withDatabase(url: string, db: string, user: string, password = "vantage_dev"): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.username = user;
  u.password = password;
  return u.toString();
}

export interface TestDb {
  name: string;
  owner: SQL;
  hub: SQL;
  worker: SQL;
  drop(): Promise<void>;
}

export async function createHubTestDb(): Promise<TestDb> {
  const name = `vantage_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new SQL(ADMIN_URL);
  await admin.unsafe(`create database ${name} owner vantage_owner`);
  await admin.end();

  const owner = new SQL(withDatabase(ADMIN_URL, name, "vantage_owner"));
  await migrate(owner, join(import.meta.dir, "..", "..", "src", "hub", "migrations"), () => {});
  const hub = new SQL(withDatabase(ADMIN_URL, name, "vantage_hub"));
  const worker = new SQL(withDatabase(ADMIN_URL, name, "vantage_worker"));

  return {
    name,
    owner,
    hub,
    worker,
    async drop() {
      await Promise.all([hub.end(), worker.end(), owner.end()]);
      const a = new SQL(ADMIN_URL);
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export async function createOpsTestDb(): Promise<{ name: string; sql: SQL; drop(): Promise<void> }> {
  const name = `vantage_ops_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new SQL(ADMIN_URL);
  await admin.unsafe(`create database ${name} owner vantage_ops`);
  await admin.end();
  const sql = new SQL(withDatabase(ADMIN_URL, name, "vantage_ops"));
  await migrate(sql, join(import.meta.dir, "..", "..", "src", "ops", "migrations"), () => {});
  return {
    name,
    sql,
    async drop() {
      await sql.end();
      const a = new SQL(ADMIN_URL);
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

/** Runs `fn` as the given user under RLS, the way every hub request does. */
export function asUser<T>(hub: SQL, userId: number | null, fn: (tx: SQL) => Promise<T>): Promise<T> {
  return hub.begin(async (tx) => {
    if (userId !== null) await tx`select set_config('vantage.user_id', ${String(userId)}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
