/**
 * Environment sources: where an environment's logs and APM data live. Rows are read under RLS
 * (diagnostics level) and re-validated on every read, so a row edited behind the hub's back can
 * still never steer a query to another index or drop the service filter.
 */
import type { Context } from "hono";
import { all, first, rls } from "../../db";
import { parseApmConfig, parseNamedLogsSource, type ApmSource, type NamedLogsSource } from "./config";

/** The logs sources of an environment as the current user may see them, oldest first (none → 404). */
export function loadLogsSources(c: Context, envId: number): Promise<NamedLogsSource[]> {
  return rls(c, async (tx) => {
    const rows = await all<{ id: number; name: string | null; config: unknown }>(tx`
      select id, name, config from environment_sources where environment_id = ${envId} and kind = 'logs' order by id`);
    return rows.flatMap((r) => parseNamedLogsSource(r) ?? []);
  });
}

export function loadApmSource(c: Context, envId: number): Promise<ApmSource | null> {
  return rls(c, async (tx) => parseApmConfig((await first<{ config: unknown }>(tx`
    select config from environment_sources where environment_id = ${envId} and kind = 'apm'`))?.config ?? null));
}
