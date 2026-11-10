/**
 * "Verbindung testen": one cheap read per system that proves address, certificate and credential.
 * Runs from the admin page and every few minutes in the worker; the outcome is stored on the row.
 * Every probe is something the read-only access Vantage gets is allowed to do (the logs proxy, for
 * one, only passes _search and _cat/indices on logstash-*).
 */
import nodemailer from "nodemailer";
import type { SQL } from "bun";
import { hubConfig } from "../../config";
import { checkCortex, OidcError } from "../cortex/oidc";
import { semaphore, SemaphoreError } from "../ansible/semaphore";
import { apmIndices, configuredIndex, EsError, HttpEsClient, type EsClient } from "../es/client";
import { INTEGRATIONS, isConfigured, type IntegrationKind } from "./kinds";
import { cortexConnection, dependencyTrackConnection, esConnection, mailConnection, recordCheck, resolveIntegration, semaphoreConnection } from "./store";

export interface CheckResult {
  ok: boolean;
  message: string;
}

const TIMEOUT_MS = 15_000;
const num = (n: number) => new Intl.NumberFormat("de-DE").format(n);
const last24h = { range: { "@timestamp": { gte: "now-24h" } } };

async function checkEs(kind: "logs" | "apm" | "wazuh", probe: (es: EsClient) => Promise<string>): Promise<CheckResult> {
  const conn = await esConnection(kind);
  if (!conn) return { ok: false, message: "Nicht eingerichtet." };
  try {
    return { ok: true, message: await probe(new HttpEsClient({ label: INTEGRATIONS[kind].label, connection: conn, timeoutMs: TIMEOUT_MS })) };
  } catch (err) {
    if (err instanceof EsError) return { ok: false, message: err.message };
    throw err;
  }
}

async function checkDependencyTrack(): Promise<CheckResult> {
  const conn = await dependencyTrackConnection();
  if (!conn) return { ok: false, message: "Nicht eingerichtet." };
  let res: Response;
  try {
    res = await fetch(`${conn.url.replace(/\/+$/, "")}/api/v1/project?pageSize=1&pageNumber=1`, {
      headers: { "x-api-key": conn.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    return { ok: false, message: `Nicht erreichbar (${(err as Error).message})` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, message: `Der API-Key wird abgelehnt (HTTP ${res.status}). Er braucht die Berechtigungen VIEW_PORTFOLIO und VIEW_VULNERABILITY.` };
  if (!res.ok) return { ok: false, message: `Unerwartete Antwort: HTTP ${res.status}` };
  const total = Number(res.headers.get("x-total-count"));
  return { ok: true, message: Number.isFinite(total) ? `Verbindung steht: ${num(total)} Projekte sichtbar.` : "Verbindung steht." };
}

async function checkSemaphore(): Promise<CheckResult> {
  if (!(await semaphoreConnection())) return { ok: false, message: "Nicht eingerichtet." };
  try {
    const project = await semaphore.project();
    const [newest] = await semaphore.lastTasks(1);
    return { ok: true, message: `Verbindung steht: Projekt „${project.name.trim()}“${newest ? `, neuester Lauf #${newest.id}` : ", noch ohne Läufe"}.` };
  } catch (err) {
    if (err instanceof SemaphoreError) return { ok: false, message: err.message };
    throw err;
  }
}

async function checkMail(): Promise<CheckResult> {
  const conn = await mailConnection();
  if (!conn) return { ok: false, message: "Nicht eingerichtet." };
  const transport = nodemailer.createTransport(conn.smtpUrl);
  try {
    await transport.verify();
    return { ok: true, message: "Der Mailserver antwortet und nimmt die Anmeldung an." };
  } catch (err) {
    return { ok: false, message: `Mailserver: ${(err as Error).message}`.slice(0, 300) };
  } finally {
    transport.close();
  }
}

async function checkCortexLogin(): Promise<CheckResult> {
  const conn = await cortexConnection();
  if (!conn) return { ok: false, message: "Nicht eingerichtet." };
  try {
    return { ok: true, message: await checkCortex(conn) };
  } catch (err) {
    if (err instanceof OidcError) return { ok: false, message: err.message };
    throw err;
  }
}

export function checkIntegration(kind: IntegrationKind): Promise<CheckResult> {
  switch (kind) {
    case "logs":
      return checkEs("logs", async (es) => {
        const prefixes = hubConfig.logs.prefixes;
        const indices = (await Promise.all(prefixes.map((p) => es.catIndices(configuredIndex(`${p}*`))))).flat();
        return `Verbindung steht: ${num(indices.length)} Indizes (${prefixes.map((p) => `${p}*`).join(", ")}).`;
      });
    case "apm":
      return checkEs("apm", async (es) => {
        const res = await es.search(apmIndices.errors, { size: 0, track_total_hits: true, query: last24h });
        return `Verbindung steht: ${num(res.hits.total?.value ?? 0)} Fehlerdokumente in den letzten 24 Stunden.`;
      });
    case "wazuh":
      // The vulnerability states are what Vantage syncs; alerts may lag (see the security tab).
      return checkEs("wazuh", async (es) => {
        const res = await es.search(configuredIndex("wazuh-states-vulnerabilities-*"), { size: 0, track_total_hits: true });
        return `Verbindung steht: ${num(res.hits.total?.value ?? 0)} Schwachstellen-Einträge im Indexer.`;
      });
    case "dependency_track":
      return checkDependencyTrack();
    case "semaphore":
      return checkSemaphore();
    case "mail":
      return checkMail();
    case "cortex":
      return checkCortexLogin();
  }
}

/** Worker loop: re-checks every system that has a row in Vantage, so the admin page shows its state. */
export async function checkIntegrations(sql: SQL, log: (m: string) => void): Promise<void> {
  for (const kind of Object.keys(INTEGRATIONS) as IntegrationKind[]) {
    const { row, source } = await resolveIntegration(kind);
    if (source !== "vantage" || !isConfigured(kind, row)) continue;
    const result = await checkIntegration(kind);
    await recordCheck(sql, kind, result.ok, result.message);
    if (!result.ok) log(`integration ${kind}: ${result.message}`);
  }
}
