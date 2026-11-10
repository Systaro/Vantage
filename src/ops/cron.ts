import { Cron } from "croner";

export const TIMEZONE = "Europe/Berlin";

/** Five-field cron (minute hour day month weekday) in Europe/Berlin. Null when valid. */
export function cronProblem(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return "Zeitplan: bitte genau fünf Felder angeben (Minute Stunde Tag Monat Wochentag), z. B. „30 2 * * *“.";
  try {
    const job = new Cron(fields.join(" "), { timezone: TIMEZONE, paused: true });
    const next = job.nextRun();
    job.stop();
    if (!next) return "Zeitplan: Dieser Ausdruck trifft nie zu.";
  } catch (err) {
    return `Zeitplan ungültig: ${(err as Error).message}`;
  }
  return null;
}

export function normalizeCron(expr: string): string {
  return expr.trim().split(/\s+/).join(" ");
}

export function nextRun(expr: string | null, from?: Date): Date | null {
  if (!expr) return null;
  try {
    const job = new Cron(expr, { timezone: TIMEZONE, paused: true });
    const next = job.nextRun(from ?? null);
    job.stop();
    return next;
  } catch {
    return null;
  }
}
