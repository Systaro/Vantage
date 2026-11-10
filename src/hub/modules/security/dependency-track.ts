/**
 * Dependency-Track REST API (v4), read only. Where it is and the API key come from the
 * "dependency_track" integration; which projects belong to an environment from its
 * environment_sources row. Project UUIDs are validated before they reach a URL.
 */
import { dependencyTrackConnection } from "../integrations/store";

export class DtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DtError";
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PROJECTS = 20;
const TIMEOUT_MS = 20_000;

export interface DtProject {
  uuid: string;
  name: string;
  version?: string | null;
  active?: boolean;
  /** Epoch milliseconds of the last SBOM upload. */
  lastBomImport?: number | null;
}

export interface DtFinding {
  component: { uuid: string; name: string; group?: string | null; version?: string | null };
  vulnerability: {
    uuid: string;
    vulnId: string;
    source?: string;
    severity?: string;
    cvssV3BaseScore?: number | null;
    cvssV2BaseScore?: number | null;
    title?: string | null;
  };
  analysis?: { state?: string | null; isSuppressed?: boolean };
}

export interface DtApi {
  listProjects(): Promise<DtProject[]>;
  getProject(uuid: string): Promise<DtProject>;
  getFindings(uuid: string): Promise<DtFinding[]>;
}

async function get<T>(path: string): Promise<T> {
  const conn = await dependencyTrackConnection();
  if (!conn) throw new DtError("Dependency-Track ist nicht angebunden (Verwaltung → Integrationen).");
  let res: Response;
  try {
    res = await fetch(`${conn.url.replace(/\/+$/, "")}${path}`, {
      headers: { "x-api-key": conn.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    throw new DtError(`Dependency-Track nicht erreichbar (${(err as Error).message})`);
  }
  if (res.status === 401 || res.status === 403) throw new DtError(`Dependency-Track lehnt den API-Key ab (HTTP ${res.status}).`);
  if (res.status === 404) throw new DtError("Das Projekt gibt es in Dependency-Track nicht (mehr).");
  if (!res.ok) throw new DtError(`Dependency-Track antwortet mit HTTP ${res.status}.`);
  return (await res.json()) as T;
}

function checkedUuid(uuid: string): string {
  if (!UUID.test(uuid)) throw new DtError("Ungültige Projekt-ID.");
  return uuid.toLowerCase();
}

export const dependencyTrack: DtApi = {
  listProjects: () => get<DtProject[]>("/api/v1/project?excludeInactive=true&pageSize=500&pageNumber=1&sortName=name&sortOrder=asc"),
  getProject: (uuid) => get<DtProject>(`/api/v1/project/${checkedUuid(uuid)}`),
  getFindings: (uuid) => get<DtFinding[]>(`/api/v1/finding/project/${checkedUuid(uuid)}?suppressed=false`),
};

/** The project UUIDs of an environment's source row, re-validated on every read. */
export function parseDependencyTrackConfig(raw: unknown): string[] | null {
  const projects = (raw as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects) || projects.length === 0 || projects.length > MAX_PROJECTS) return null;
  if (!projects.every((p) => typeof p === "string" && UUID.test(p))) return null;
  return [...new Set(projects.map((p: string) => p.toLowerCase()))];
}

export type Severity = "critical" | "high" | "medium" | "low" | "unassigned";

export function severityOf(dt: string | undefined): Severity {
  switch ((dt ?? "").toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    case "LOW":
    case "INFO":
      return "low";
    default:
      return "unassigned";
  }
}

/** Findings an analyst has dismissed in Dependency-Track do not count here either. */
export function isRelevant(f: DtFinding): boolean {
  if (f.analysis?.isSuppressed) return false;
  return !["NOT_AFFECTED", "FALSE_POSITIVE"].includes((f.analysis?.state ?? "").toUpperCase());
}

export function projectLabel(p: Pick<DtProject, "name" | "version">): string {
  return p.version ? `${p.name} ${p.version}` : p.name;
}
