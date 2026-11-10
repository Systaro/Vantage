/**
 * Source config shapes and their validation. No database access here, so the worker (which polls
 * APM with its own role) can use it without loading the hub connection.
 */
import { hubConfig } from "../../config";
import { apmServiceProblem, filterProblem, indexPatternProblem, sourceNameProblem } from "./pattern";

export interface LogsSource {
  index: string;
  filterField?: string;
  filterValue?: string;
  /** false: no error groups from this source's ERROR entries (the default is to build them). */
  errorGroups?: false;
}

/** One of an environment's logs sources (#69812): its row id and its name, unique in the environment. */
export interface NamedLogsSource extends LogsSource {
  id: number;
  name: string;
}

export interface ApmSource {
  service: string;
  environment: string;
}

export function parseLogsConfig(raw: unknown, prefixes: readonly string[] = hubConfig.logs.prefixes): LogsSource | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.index !== "string") return null;
  const field = typeof r.filterField === "string" ? r.filterField : "";
  const value = typeof r.filterValue === "string" ? r.filterValue : "";
  if (indexPatternProblem(r.index, prefixes) || filterProblem(field, value)) return null;
  const source: LogsSource = field ? { index: r.index, filterField: field, filterValue: value } : { index: r.index };
  if (r.errorGroups === false) source.errorGroups = false;
  return source;
}

export function parseNamedLogsSource(row: { id: number; name: string | null; config: unknown }, prefixes: readonly string[] = hubConfig.logs.prefixes): NamedLogsSource | null {
  const source = parseLogsConfig(row.config, prefixes);
  if (!source || !row.name || sourceNameProblem(row.name)) return null;
  return { id: row.id, name: row.name, ...source };
}

export function parseApmConfig(raw: unknown): ApmSource | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.service !== "string" || typeof r.environment !== "string") return null;
  if (apmServiceProblem(r.service, r.environment)) return null;
  return { service: r.service, environment: r.environment };
}
