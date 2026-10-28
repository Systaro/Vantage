/**
 * Validation for everything an admin types into an environment source. The index pattern ends up in
 * the URL path of every log query, so it is checked strictly here and again before each request.
 */

const PATTERN_CHARS = /^[a-z0-9._*-]+$/;
const MAX_PATTERN = 200;

/** Returns a German explanation of what is wrong with the pattern, or null when it may be used. */
export function indexPatternProblem(pattern: string, prefixes: readonly string[]): string | null {
  if (!pattern) return "Das Indexmuster fehlt.";
  if (pattern.length > MAX_PATTERN) return `Das Indexmuster darf höchstens ${MAX_PATTERN} Zeichen haben.`;
  if (/\s/.test(pattern)) return "Das Indexmuster darf keine Leerzeichen enthalten.";
  if (pattern.includes(",")) return "Nur ein Muster pro Quelle, ohne Kommas.";
  if (pattern.includes(":")) return "Clusterübergreifende Muster („cluster:index“) sind nicht erlaubt.";
  if (pattern.startsWith("*")) return "Das Muster darf nicht mit „*“ beginnen.";
  if (pattern.includes("_all")) return "„_all“ ist nicht erlaubt.";
  if (pattern.includes("..")) return "„..“ ist nicht erlaubt.";
  if (!PATTERN_CHARS.test(pattern)) return "Erlaubt sind nur Kleinbuchstaben, Ziffern, „.“, „_“, „-“ und „*“.";
  const prefix = prefixes.find((p) => pattern.startsWith(p));
  if (!prefix) return `Das Muster muss mit ${prefixes.map((p) => `„${p}“`).join(" oder ")} beginnen.`;
  const literal = pattern.slice(prefix.length).split("*")[0]!;
  if (literal.length < 2) return `Nach „${prefix}“ müssen vor dem ersten „*“ mindestens zwei feste Zeichen stehen.`;
  return null;
}

const FIELD = /^[A-Za-z0-9_@][A-Za-z0-9_.@-]{0,99}$/;

/** The optional exact-match filter for shared indices: both parts or neither. */
export function filterProblem(field: string, value: string): string | null {
  if (!field && !value) return null;
  if (!field || !value) return "Filterfeld und Filterwert gehören zusammen: beide ausfüllen oder beide leer lassen.";
  if (!FIELD.test(field) || field.includes("..")) return "Filterfeld: nur Buchstaben, Ziffern, „.“, „_“, „@“ und „-“, z. B. appname.keyword.";
  if (value.length > 200 || /[\u0000-\u001f]/.test(value)) return "Der Filterwert darf höchstens 200 Zeichen ohne Steuerzeichen haben.";
  return null;
}

export const MAX_SOURCE_NAME = 40;

export function sourceNameProblem(name: string): string | null {
  if (!name) return "Der Name fehlt.";
  if (name.length > MAX_SOURCE_NAME) return `Der Name darf höchstens ${MAX_SOURCE_NAME} Zeichen haben.`;
  if (/[\u0000-\u001f]/.test(name)) return "Der Name darf keine Steuerzeichen enthalten.";
  return null;
}

/** The name a logs source gets when none is typed: its pattern without prefix and wildcard. */
export function defaultSourceName(pattern: string, prefixes: readonly string[]): string {
  const prefix = prefixes.find((p) => pattern.startsWith(p)) ?? "";
  const name = pattern.slice(prefix.length).split("*")[0]!.replace(/[-_.]+$/, "");
  return (name || pattern).slice(0, MAX_SOURCE_NAME);
}

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9 _.:\/-]{0,99}$/;

export function apmServiceProblem(service: string, environment: string): string | null {
  if (!SERVICE.test(service)) return "service.name: 1 bis 100 Zeichen, Buchstaben, Ziffern, Leerzeichen und „_ . : / -“.";
  if (!SERVICE.test(environment)) return "service.environment: 1 bis 100 Zeichen, Buchstaben, Ziffern, Leerzeichen und „_ . : / -“.";
  return null;
}

/**
 * The family an index belongs to: the name without its date or rollover suffix, so that
 * `logstash-shop-prod-2026-10` and `logstash-shop-prod-2026-09` show up as one line in the preview.
 */
export function indexFamily(index: string): string {
  return index.replace(/[-._]\d{4}(?:[-._]\d{2}){0,2}$/, "").replace(/-\d{6}$/, "");
}
