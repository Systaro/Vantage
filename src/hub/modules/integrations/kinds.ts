/**
 * The external systems Vantage connects to, what each one stores, and how a stored row (or, until an
 * admin saves one, the old environment variables) becomes a typed connection. No database access
 * here, so the worker can import it without the hub connection.
 */
import { readFileSync } from "node:fs";
import { envOptional } from "../../../shared/config";
import type { IconName } from "../../../shared/ui/icons";

export const INTEGRATION_KINDS = ["logs", "apm", "wazuh", "dependency_track", "semaphore", "mail", "cortex"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export function isIntegrationKind(value: string): value is IntegrationKind {
  return (INTEGRATION_KINDS as readonly string[]).includes(value);
}

/** An Elasticsearch / OpenSearch cluster: logs, APM and the Wazuh indexer all speak this. */
export interface EsConnection {
  url: string;
  /** Authorization header value ("ApiKey …" / "Basic …"), used verbatim and never logged. */
  auth?: string;
  /** PEM of the CA behind a self-signed cluster certificate. */
  ca?: string;
}

export interface DependencyTrackConnection {
  url: string;
  apiKey: string;
}

/** Semaphore (Ansible UI): one project, read with a project member's API token (role guest). */
export interface SemaphoreConnection {
  url: string;
  projectId: number;
  token: string;
}

export interface MailConnection {
  smtpUrl: string;
  from: string;
}

/** Cortex as OpenID Connect provider for the staff login (a confidential client). */
export interface OidcConnection {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface IntegrationInfo {
  label: string;
  icon: IconName;
  /** What Vantage takes from it, shown on the card. */
  provides: string;
  type: "elasticsearch" | "dependency_track" | "semaphore" | "mail" | "oidc";
}

export const INTEGRATIONS: Record<IntegrationKind, IntegrationInfo> = {
  logs: { label: "Logs (Elasticsearch)", icon: "scroll-text", type: "elasticsearch", provides: "Logs-Tab und Logs-Karte der Umgebungen. Die Umgebungen wählen ihr Indexmuster selbst." },
  apm: { label: "APM (Elasticsearch)", icon: "gauge", type: "elasticsearch", provides: "Tabs Fehler und APM, Fehlergruppen und ihre Benachrichtigungen." },
  wazuh: { label: "Wazuh (Indexer)", icon: "shield-check", type: "elasticsearch", provides: "Sicherheitslage der Server: Agenten, Alarme, Schwachstellen." },
  dependency_track: { label: "Dependency-Track", icon: "bug", type: "dependency_track", provides: "Bekannte Schwachstellen (CVEs) in den Abhängigkeiten der Anwendungen." },
  semaphore: { label: "Ansible (Semaphore)", icon: "terminal", type: "semaphore", provides: "Tab Wartung: die Ansible-Läufe auf den Servern der Umgebungen, je Server mit Ergebnis." },
  mail: { label: "E-Mail-Versand", icon: "mail", type: "mail", provides: "Benachrichtigungen per E-Mail an Kanäle und Abonnenten." },
  cortex: { label: "Cortex-Anmeldung", icon: "key-round", type: "oidc", provides: "Anmeldung über Cortex für Systaro-Konten, die ihr Cortex-Konto unter Mein Konto verknüpft haben. Der Anmeldelink steht dort, nicht auf der Anmeldeseite." },
};

/** A stored row: non-secret settings plus the decrypted credential. */
export interface StoredIntegration {
  config: Record<string, unknown>;
  secret: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function toEsConnection(row: StoredIntegration | null): EsConnection | null {
  const url = str(row?.config.url);
  if (!row || !url) return null;
  return { url, auth: row.secret ?? undefined, ca: str(row.config.ca) };
}

export function toDependencyTrackConnection(row: StoredIntegration | null): DependencyTrackConnection | null {
  const url = str(row?.config.url);
  if (!row || !url || !row.secret) return null;
  return { url, apiKey: row.secret };
}

export function toSemaphoreConnection(row: StoredIntegration | null): SemaphoreConnection | null {
  const url = str(row?.config.url);
  const projectId = Number(row?.config.project_id);
  if (!row || !url || !row.secret || !Number.isInteger(projectId) || projectId <= 0) return null;
  return { url: url.replace(/\/+$/, ""), projectId, token: row.secret };
}

export function toMailConnection(row: StoredIntegration | null): MailConnection | null {
  if (!row?.secret) return null;
  return { smtpUrl: row.secret, from: str(row.config.from) ?? "Vantage <vantage@localhost>" };
}

export function toOidcConnection(row: StoredIntegration | null): OidcConnection | null {
  const issuer = str(row?.config.issuer);
  const clientId = str(row?.config.client_id);
  if (!row || !issuer || !clientId || !row.secret) return null;
  return { issuer, clientId, clientSecret: row.secret };
}

export function isConfigured(kind: IntegrationKind, row: StoredIntegration | null): boolean {
  switch (INTEGRATIONS[kind].type) {
    case "elasticsearch":
      return toEsConnection(row) !== null;
    case "dependency_track":
      return toDependencyTrackConnection(row) !== null;
    case "semaphore":
      return toSemaphoreConnection(row) !== null;
    case "mail":
      return toMailConnection(row) !== null;
    case "oidc":
      return toOidcConnection(row) !== null;
  }
}

/**
 * Before integrations were configured in Vantage, the connections came from environment variables.
 * Until an admin saves a row, those still apply; the worker copies them into the table on start.
 */
export function integrationFromEnv(kind: IntegrationKind): StoredIntegration | null {
  switch (kind) {
    case "logs": {
      const url = envOptional("LOGS_ES_URL");
      return url ? { config: { url }, secret: envOptional("LOGS_ES_AUTH") ?? null } : null;
    }
    case "apm": {
      const url = envOptional("APM_ES_URL");
      if (!url) return null;
      const caFile = envOptional("APM_ES_CA_FILE");
      return { config: caFile ? { url, ca: readFileSync(caFile, "utf8") } : { url }, secret: envOptional("APM_ES_AUTH") ?? null };
    }
    case "mail": {
      const smtpUrl = envOptional("SMTP_URL");
      return smtpUrl ? { config: { from: envOptional("MAIL_FROM") ?? "Vantage <vantage@localhost>" }, secret: smtpUrl } : null;
    }
    default:
      return null;
  }
}

// ── Mail relay: stored as one smtp:// URL (the secret), edited as separate fields ─────────────────

export interface SmtpParts {
  host: string;
  port: string;
  user: string;
  password: string;
  security: "none" | "starttls" | "tls";
  authMethod: string;
}

export const SMTP_AUTH_METHODS = ["", "CRAM-MD5", "PLAIN", "LOGIN"];

export function parseSmtpUrl(url: string | null | undefined): SmtpParts | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const tls = u.protocol === "smtps:";
    return {
      host: u.hostname,
      port: u.port || (tls ? "465" : "25"),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      security: tls ? "tls" : u.searchParams.get("requireTLS") === "true" ? "starttls" : "none",
      authMethod: u.searchParams.get("authMethod") ?? "",
    };
  } catch {
    return null;
  }
}

export function buildSmtpUrl(p: SmtpParts): string {
  const u = new URL(`${p.security === "tls" ? "smtps" : "smtp"}://${p.host}:${p.port}`);
  if (p.user) {
    // The URL setters percent-encode user and password (a "/" in Postal's user names included).
    u.username = p.user;
    u.password = p.password;
  }
  if (p.security === "starttls") u.searchParams.set("requireTLS", "true");
  if (p.authMethod) u.searchParams.set("authMethod", p.authMethod);
  return u.toString();
}

// ── Form validation (admin dialog) ───────────────────────────────────────────────────────────────

const PEM = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/;

export function urlProblem(url: string, label = "URL"): string | null {
  if (!url) return `${label} fehlt.`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `${label} ist keine gültige Adresse.`;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return `${label} muss mit https:// beginnen.`;
  if (u.username || u.password) return "Zugangsdaten gehören nicht in die URL, sondern ins Feld darunter.";
  if (u.search || u.hash) return `${label} darf keine Parameter enthalten.`;
  return null;
}

export function caProblem(ca: string): string | null {
  return !ca || PEM.test(ca) ? null : "Das CA-Zertifikat muss im PEM-Format sein (-----BEGIN CERTIFICATE----- …).";
}

/** Builds the Authorization header from the dialog's auth fields; null = no credential. */
export function esAuthHeader(f: { mode: string; user: string; password: string; apiKey: string }): { header: string | null; problem: string | null } {
  switch (f.mode) {
    case "none":
      return { header: null, problem: null };
    case "basic":
      if (!f.user || !f.password) return { header: null, problem: "Benutzer und Passwort angeben." };
      if (f.user.includes(":")) return { header: null, problem: "Der Benutzername darf keinen Doppelpunkt enthalten." };
      return { header: `Basic ${Buffer.from(`${f.user}:${f.password}`).toString("base64")}`, problem: null };
    case "apikey": {
      // Elasticsearch shows API keys as "encoded" (base64 of id:key) or as id and key separately.
      const key = f.apiKey.replace(/^ApiKey\s+/i, "");
      if (!key) return { header: null, problem: "API-Key angeben." };
      const encoded = key.includes(":") ? Buffer.from(key).toString("base64") : key;
      if (!/^[A-Za-z0-9+/=_-]{8,}$/.test(encoded)) return { header: null, problem: "Der API-Key hat ein unerwartetes Format." };
      return { header: `ApiKey ${encoded}`, problem: null };
    }
    default:
      return { header: null, problem: "Unbekannte Anmeldeart." };
  }
}

/** The issuer as Cortex publishes it: https, no path beyond the host, no trailing slash. */
export function issuerProblem(issuer: string): string | null {
  const problem = urlProblem(issuer, "Cortex-Adresse");
  if (problem) return problem;
  const u = new URL(issuer);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return "Die Cortex-Adresse muss mit https:// beginnen.";
  return issuer.endsWith("/") ? "Die Cortex-Adresse ohne „/“ am Ende angeben." : null;
}

export function smtpUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "SMTP-Adresse ist keine gültige URL (smtp://benutzer:passwort@host:port).";
  }
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") return "SMTP-Adresse muss mit smtp:// oder smtps:// beginnen.";
  if (!u.hostname) return "In der SMTP-Adresse fehlt der Server.";
  return null;
}

const ADDRESS = "[^<>@\\s]+@[^<>@\\s]+";
const SENDER = new RegExp(`^(${ADDRESS}|[^<>@]*<${ADDRESS}>)$`);

export function senderProblem(from: string): string | null {
  return SENDER.test(from) ? null : "Absender als „Name <adresse@domain>“ oder nur als Adresse angeben.";
}

/** Where the credential is shown to admins: never the value, only whether one is set. */
export function describeEsAuth(auth: string | null | undefined): string {
  if (!auth) return "keine";
  if (/^Basic /i.test(auth)) {
    const user = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":")[0];
    return `Benutzer ${user}`;
  }
  return /^ApiKey /i.test(auth) ? "API-Key" : "eigener Header";
}
