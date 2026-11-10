import type { Context } from "hono";
import type { SQL } from "bun";
import { env } from "../shared/config";
import { connect } from "../shared/db";
import { hubConfig } from "./config";

/** The hub's only database connection: role vantage_hub, row-level security enforced. */
export const hubSql = connect(hubConfig.databaseUrl ?? env("HUB_DATABASE_URL"));

/**
 * Runs `fn` as the logged-in user. Every read of observability data goes through here; a query that
 * bypasses it runs without `vantage.user_id` and sees nothing (the policies fail closed).
 */
export function rls<T>(c: Context, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const user = c.get("user");
  if (!user) throw new Error("rls() called without a logged-in user");
  return hubSql.begin(async (tx) => {
    await tx`select set_config('vantage.user_id', ${String(user.id)}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

export { all, first, type Row } from "../shared/db";
