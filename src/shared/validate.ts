/** Small validation helpers shared by hub and ops forms. */

export function nameProblem(name: string): string | null {
  return name.length >= 1 && name.length <= 200 ? null : "Der Name muss 1 bis 200 Zeichen lang sein.";
}

/** The users tables' check constraint, plus the length limit of an address. */
export function emailProblem(email: string): string | null {
  return /^[^@\s]+@[^@\s]+$/.test(email) && email.length <= 254 ? null : "Die E-Mail-Adresse ist ungültig.";
}

/** Postgres unique violation (23505), however the driver reports it. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { errno?: string; code?: string; message?: string };
  return e?.errno === "23505" || e?.code === "23505" || /duplicate key/.test(e?.message ?? "");
}
