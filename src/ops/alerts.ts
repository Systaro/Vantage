/**
 * Alert state → hub events. Every component that reports a problem (host checks, silent hosts, the
 * sweep watchdog, scheduled Ansible runs, pipeline triggers) goes through `setAlert`, which compares
 * with the stored state and writes the outbox row in the same transaction. Repeating the same state
 * sends nothing; a severity change sends `firing` again with the new severity.
 */
import type { SQL } from "bun";
import { sha256Hex } from "../shared/crypto";
import { first } from "../shared/db";

export type Severity = "warning" | "critical";

export interface AlertSpec {
  severity: Severity;
  title: string;
  body?: string | null;
  link?: string | null;
  environment?: string | null;
}

export interface OutboxEvent {
  subject: string;
  state: "firing" | "resolved" | "notice";
  severity: "critical" | "warning" | "info";
  title: string;
  body?: string | null;
  link?: string | null;
  environment?: string | null;
}

const clip = (s: string | null | undefined, max: number) => (s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : null);

/** Subjects are limited to 200 characters; long ones (deep mount paths) keep a hash for uniqueness. */
export function subjectOf(...parts: string[]): string {
  const s = parts.join(":");
  return s.length <= 200 ? s : `${s.slice(0, 186)}~${sha256Hex(s).slice(0, 12)}`;
}

export async function enqueueEvent(tx: SQL, e: OutboxEvent): Promise<void> {
  await tx`insert into outbox (subject, state, severity, title, body, link, environment)
    values (${e.subject.slice(0, 200)}, ${e.state}, ${e.severity}, ${clip(e.title, 300) ?? "–"}, ${clip(e.body, 4000)},
            ${e.link && e.link.length <= 1000 ? e.link : null}, ${e.environment ?? null})`;
}

export type AlertChange = "fired" | "escalated" | "resolved" | null;

export async function setAlert(
  sql: SQL,
  subject: string,
  next: AlertSpec | null,
  resolved?: { title: string; body?: string | null; link?: string | null; environment?: string | null },
): Promise<AlertChange> {
  return (await sql.begin(async (tx) => {
    const cur = await first<{ severity: Severity; title: string; link: string | null; environment: string | null }>(
      tx`select severity, title, link, environment from alerts where subject = ${subject} for update`,
    );
    if (next) {
      if (!cur) {
        const inserted = await tx`insert into alerts (subject, severity, title, body, link, environment)
          values (${subject}, ${next.severity}, ${clip(next.title, 300)}, ${clip(next.body, 4000)}, ${next.link ?? null}, ${next.environment ?? null})
          on conflict (subject) do nothing returning subject`;
        if (!inserted.length) return null;
        await enqueueEvent(tx, { subject, state: "firing", ...next });
        return "fired";
      }
      await tx`update alerts set severity = ${next.severity}, title = ${clip(next.title, 300)}, body = ${clip(next.body, 4000)},
               link = ${next.link ?? null}, environment = ${next.environment ?? null}, updated_at = now() where subject = ${subject}`;
      if (cur.severity === next.severity) return null;
      await enqueueEvent(tx, { subject, state: "firing", ...next });
      return "escalated";
    }
    if (!cur) return null;
    await tx`delete from alerts where subject = ${subject}`;
    await enqueueEvent(tx, {
      subject,
      state: "resolved",
      severity: cur.severity,
      title: resolved?.title ?? `Behoben: ${cur.title}`,
      body: resolved?.body ?? null,
      link: resolved?.link ?? cur.link,
      environment: resolved?.environment !== undefined ? resolved.environment : cur.environment,
    });
    return "resolved";
  })) as AlertChange;
}

/** Resolves every open alert whose subject starts with `prefix` (host deleted or renamed). */
export async function resolveAlertsWithPrefix(sql: SQL, prefix: string, title: (subject: string, oldTitle: string) => string): Promise<number> {
  const rows = (await sql`select subject, title from alerts where starts_with(subject, ${prefix})`) as { subject: string; title: string }[];
  for (const r of rows) await setAlert(sql, r.subject, null, { title: title(r.subject, r.title) });
  return rows.length;
}
