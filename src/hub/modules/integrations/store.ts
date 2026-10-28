/**
 * Integration rows at runtime. Hub and worker each call `initIntegrations` once with their own
 * connection and HUB_SECRET. Lookups go through `integration_load()` (SECURITY DEFINER), so the hub
 * reads a connection for any logged-in user without ever selecting the admin-only table, and they
 * are cached briefly: a change on /admin/integrations applies within half a minute in the worker and
 * at once in the hub (which forgets its cache on save).
 */
import type { SQL } from "bun";
import { decryptString, encryptString } from "../../../shared/crypto";
import {
  INTEGRATION_KINDS,
  integrationFromEnv,
  toDependencyTrackConnection,
  toEsConnection,
  toMailConnection,
  toOidcConnection,
  toSemaphoreConnection,
  type DependencyTrackConnection,
  type EsConnection,
  type IntegrationKind,
  type MailConnection,
  type OidcConnection,
  type SemaphoreConnection,
  type StoredIntegration,
} from "./kinds";

const TTL_MS = 30_000;

export interface ResolvedIntegration {
  row: StoredIntegration | null;
  /** "vantage": a saved row; "env": still the old environment variables; null: not set up. */
  source: "vantage" | "env" | null;
}

let ctx: { sql: SQL; secret: string } | null = null;
const cache = new Map<IntegrationKind, { at: number; value: Promise<ResolvedIntegration> }>();

export function initIntegrations(sql: SQL, secret: string) {
  ctx = { sql, secret };
  cache.clear();
}

export function forgetIntegration(kind?: IntegrationKind) {
  if (kind) cache.delete(kind);
  else cache.clear();
}

function fromEnv(kind: IntegrationKind): ResolvedIntegration {
  const row = integrationFromEnv(kind);
  return { row, source: row ? "env" : null };
}

async function read(kind: IntegrationKind): Promise<ResolvedIntegration> {
  // Without a database (scripts, unit tests) only the environment can say where a cluster is.
  if (!ctx) return fromEnv(kind);
  const [r] = (await ctx.sql`select config, secret_enc from integration_load(${kind})`) as { config: Record<string, unknown> | null; secret_enc: string | null }[];
  if (!r) return fromEnv(kind);
  return { row: { config: r.config ?? {}, secret: r.secret_enc ? await decryptString(ctx.secret, r.secret_enc) : null }, source: "vantage" };
}

export function resolveIntegration(kind: IntegrationKind): Promise<ResolvedIntegration> {
  const hit = cache.get(kind);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = read(kind);
  cache.set(kind, { at: Date.now(), value });
  value.catch(() => cache.delete(kind));
  return value;
}

export async function esConnection(kind: "logs" | "apm" | "wazuh"): Promise<EsConnection | null> {
  return toEsConnection((await resolveIntegration(kind)).row);
}

export async function dependencyTrackConnection(): Promise<DependencyTrackConnection | null> {
  return toDependencyTrackConnection((await resolveIntegration("dependency_track")).row);
}

export async function semaphoreConnection(): Promise<SemaphoreConnection | null> {
  return toSemaphoreConnection((await resolveIntegration("semaphore")).row);
}

export async function mailConnection(): Promise<MailConnection | null> {
  return toMailConnection((await resolveIntegration("mail")).row);
}

export async function cortexConnection(): Promise<OidcConnection | null> {
  return toOidcConnection((await resolveIntegration("cortex")).row);
}

/** Seals a credential for the `secret_enc` column. */
export function sealSecret(secret: string, value: string | null): Promise<string | null> {
  return value ? encryptString(secret, value) : Promise.resolve(null);
}

/**
 * Worker start: connections that still come from environment variables move into the table, once.
 * A row that exists (even an emptied one) always wins, so removing an integration in Vantage never
 * brings the old variables back.
 */
export async function importIntegrationsFromEnv(sql: SQL, secret: string): Promise<IntegrationKind[]> {
  const imported: IntegrationKind[] = [];
  for (const kind of INTEGRATION_KINDS) {
    const env = integrationFromEnv(kind);
    if (!env) continue;
    const rows = await sql`
      insert into integrations (kind, config, secret_enc) values (${kind}, ${env.config}::jsonb, ${await sealSecret(secret, env.secret)})
      on conflict (kind) do nothing returning kind`;
    if (rows.length) imported.push(kind);
  }
  if (imported.length) forgetIntegration();
  return imported;
}

/** Saves a system's settings as the RLS user in `tx` (the policy admits admins only); its last check is cleared. */
export async function saveIntegration(tx: SQL, kind: IntegrationKind, config: Record<string, unknown>, secretEnc: string | null, userId: number): Promise<void> {
  await tx`
    insert into integrations (kind, config, secret_enc, updated_at, updated_by, checked_at, check_ok, check_message)
    values (${kind}, ${config}::jsonb, ${secretEnc}, now(), ${userId}, null, null, null)
    on conflict (kind) do update set config = excluded.config, secret_enc = excluded.secret_enc, updated_at = now(),
      updated_by = excluded.updated_by, checked_at = null, check_ok = null, check_message = null`;
  forgetIntegration(kind);
}

/** Stores the outcome of a connection check; a system without a row (environment only) has no status. */
export async function recordCheck(sql: SQL, kind: IntegrationKind, ok: boolean, message: string): Promise<void> {
  await sql`update integrations set checked_at = now(), check_ok = ${ok}, check_message = ${message.slice(0, 500)} where kind = ${kind}`;
}
