import { SQL } from "bun";

/**
 * Bun's Postgres client. Three things that bite (verified with Bun 1.3.14):
 * - A plain JS array as a parameter breaks the wire protocol. Use `sql.array(values, "int4")`.
 * - For jsonb, pass the object itself (`${obj}::jsonb`). `JSON.stringify` first stores a JSON string.
 * - bigint columns come back as strings, which is why ids are `integer` unless volume demands more.
 */
export type Sql = SQL;

export function connect(url: string, max = 10): SQL {
  return new SQL({ url, max, idleTimeout: 30 });
}

export function intArray(sql: SQL, values: number[]) {
  return sql.array(values, "int4");
}

export function textArray(sql: SQL, values: string[]) {
  return sql.array(values, "text");
}

export type Row = Record<string, any>;

export async function first<T = Row>(q: Promise<unknown>): Promise<T | null> {
  const rows = (await q) as T[];
  return rows[0] ?? null;
}

export async function all<T = Row>(q: Promise<unknown>): Promise<T[]> {
  return (await q) as T[];
}
