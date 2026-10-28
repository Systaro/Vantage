/** Environment access with fail-fast for required values. */

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function envOptional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

export const isProduction = process.env.NODE_ENV === "production";
