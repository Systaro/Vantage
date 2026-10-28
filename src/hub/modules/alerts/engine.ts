/**
 * Worker side of alerting (design §5): events → incidents → notifications → delivery.
 * Access is re-checked for personal subscriptions both when a notification is created and when it
 * is sent, so a revoked grant or a disabled account stops mail immediately, even mid-retry.
 */
import type { SQL } from "bun";
import { deliver, openConfig, type DeliveryEnv, type Message } from "./channels";

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 } as const;
type Severity = keyof typeof SEVERITY_RANK;
const BACKOFF_MINUTES = [1, 5, 15, 60];

interface EventRow {
  id: number;
  at: Date;
  source: string;
  environment_id: number | null;
  subject_key: string;
  state: "firing" | "resolved" | "notice";
  severity: Severity;
  title: string;
  body: string | null;
  link: string | null;
}

interface Scope {
  environment_id: number | null;
  project_id: number | null;
  organisation_id: number | null;
  /** Uptime events (`monitor:<id>`, `monitor:<id>:tls-expiry`) also match routes for their monitor. */
  monitor_id?: number | null;
}

/**
 * Errors carry exception messages from the application, so they need diagnostics (level 2);
 * vulnerabilities need the security grant (level 3).
 */
export function requiredLevel(source: string): number {
  return source === "security" ? 3 : source === "errors" ? 2 : 1;
}

export function routeMatches(
  route: { scope_kind: string; scope_id: number | null; sources: string[]; min_severity: Severity },
  event: { source: string; severity: Severity },
  scope: Scope,
): boolean {
  if (!route.sources.includes(event.source)) return false;
  if (SEVERITY_RANK[event.severity] < SEVERITY_RANK[route.min_severity]) return false;
  switch (route.scope_kind) {
    case "all":
      return true;
    case "organisation":
      return scope.organisation_id !== null && route.scope_id === scope.organisation_id;
    case "project":
      return scope.project_id !== null && route.scope_id === scope.project_id;
    case "environment":
      return scope.environment_id !== null && route.scope_id === scope.environment_id;
    case "monitor":
      return scope.monitor_id != null && route.scope_id === scope.monitor_id;
    default:
      return false;
  }
}

async function userMayReceive(sql: SQL, userId: number, event: { source: string; environment_id: number | null }): Promise<boolean> {
  const [row] = (await sql`
    select u.disabled_at is null as active, u.is_admin,
           case when ${event.environment_id}::int is null then 0 else vantage_level(u.id, ${event.environment_id}::int) end as level
    from users u where u.id = ${userId}`) as { active: boolean; is_admin: boolean; level: number }[];
  if (!row?.active) return false;
  if (event.environment_id === null) return row.is_admin;
  return row.level >= requiredLevel(event.source);
}

async function fanOut(tx: SQL, ev: EventRow, severity: Severity) {
  const [scope] = (ev.environment_id === null
    ? [{ environment_id: null, project_id: null, organisation_id: null }]
    : await tx`select e.id as environment_id, p.id as project_id, p.organisation_id
               from environments e join projects p on p.id = e.project_id where e.id = ${ev.environment_id}`) as Scope[];
  if (!scope) return;
  const monitorId = /^monitor:(\d+)(?::|$)/.exec(ev.subject_key)?.[1];
  if (monitorId) scope.monitor_id = Number(monitorId);
  const routes = (await tx`select r.channel_id, r.scope_kind, r.scope_id, r.sources, r.min_severity
                           from routes r join channels c on c.id = r.channel_id where c.enabled`) as any[];
  const channels = new Set<number>();
  for (const r of routes) if (routeMatches(r, { source: ev.source, severity }, scope)) channels.add(r.channel_id);
  for (const channelId of channels) await tx`insert into notifications (event_id, channel_id) values (${ev.id}, ${channelId})`;

  const subs = (await tx`select user_id, scope_kind, scope_id, min_severity from subscriptions`) as any[];
  const users = new Set<number>();
  for (const s of subs) {
    if (!routeMatches({ ...s, sources: [ev.source] }, { source: ev.source, severity }, scope)) continue;
    if (await userMayReceive(tx, s.user_id, ev)) users.add(s.user_id);
  }
  for (const userId of users) await tx`insert into notifications (event_id, user_id) values (${ev.id}, ${userId})`;
}

/** Turns unprocessed events into incidents and pending notifications. Returns events handled. */
export async function processEvents(sql: SQL, limit = 100): Promise<number> {
  const events = (await sql`select * from events where processed_at is null order by id limit ${limit}`) as EventRow[];
  for (const ev of events) {
    await sql.begin(async (tx) => {
      let notifySeverity: Severity | null = null;
      if (ev.state === "notice") {
        notifySeverity = ev.severity;
      } else if (ev.state === "firing") {
        const [open] = (await tx`select id, severity from incidents where subject_key = ${ev.subject_key} and resolved_at is null for update`) as { id: number; severity: Severity }[];
        if (!open) {
          await tx`insert into incidents (subject_key, source, environment_id, severity, title, opened_event_id)
                   values (${ev.subject_key}, ${ev.source}, ${ev.environment_id}, ${ev.severity}, ${ev.title}, ${ev.id})`;
          notifySeverity = ev.severity;
        } else {
          // Repeated firing is silent, except when it escalates (a disk at 85 % that now passes 95 %).
          // The environment follows the latest event: a host re-tagged in ops takes its open incident along.
          await tx`update incidents set last_seen_at = now(), severity = ${ev.severity}, title = ${ev.title}, environment_id = ${ev.environment_id} where id = ${open.id}`;
          if (SEVERITY_RANK[ev.severity] > SEVERITY_RANK[open.severity]) notifySeverity = ev.severity;
        }
      } else {
        const closed = (await tx`update incidents set resolved_at = now(), last_seen_at = now()
                                 where subject_key = ${ev.subject_key} and resolved_at is null returning severity`) as { severity: Severity }[];
        if (closed[0]) notifySeverity = closed[0].severity;
      }
      if (notifySeverity) await fanOut(tx, ev, notifySeverity);
      await tx`update events set processed_at = now() where id = ${ev.id}`;
    });
  }
  return events.length;
}

/**
 * Links to other systems (ops events point at the internal ops UI) go only to admins and to
 * Systaro-internal channels; everyone else gets the environment's incident page in the hub.
 */
export function publicLink(link: string | null, publicUrl: string, internal: boolean, environmentId: number | null): string | null {
  const target = link && (link.startsWith("/") || internal) ? link : environmentId ? `/env/${environmentId}/incidents` : null;
  return target ? new URL(target, publicUrl).toString() : null;
}

export interface DeliveryContext extends DeliveryEnv {
  secret: string;
}

/** Sends due notifications. Returns how many were attempted. */
export async function deliverNotifications(sql: SQL, ctx: DeliveryContext, log: (m: string) => void = console.log, limit = 25): Promise<number> {
  const due = (await sql`
    select n.id, n.attempts, n.channel_id, n.user_id, e.id as event_id, e.at, e.source, e.environment_id, e.state, e.severity, e.title, e.body, e.link,
           c.config_enc, c.enabled as channel_enabled, u.email, coalesce(u.is_admin, false) as is_admin,
           case when e.environment_id is null then null else p.name || ' · ' || env.name end as context
    from notifications n
    join events e on e.id = n.event_id
    left join channels c on c.id = n.channel_id
    left join users u on u.id = n.user_id
    left join environments env on env.id = e.environment_id
    left join projects p on p.id = env.project_id
    where n.status = 'pending' and n.next_attempt_at <= now()
    order by n.next_attempt_at limit ${limit}`) as any[];

  for (const n of due) {
    const message: Message = {
      state: n.state,
      severity: n.severity,
      title: n.title,
      body: n.body,
      url: publicLink(n.link, ctx.publicUrl, n.channel_id ? true : n.is_admin, n.environment_id),
      context: n.context,
      at: new Date(n.at),
      source: n.source,
      eventId: Number(n.event_id),
    };
    try {
      if (n.channel_id) {
        if (!n.channel_enabled) {
          await sql`update notifications set status = 'skipped', error = 'Kanal deaktiviert' where id = ${n.id}`;
          continue;
        }
        await deliver(ctx, await openConfig(ctx.secret, n.config_enc), message);
      } else {
        if (!(await userMayReceive(sql, n.user_id, n))) {
          await sql`update notifications set status = 'skipped', error = 'kein Zugriff mehr' where id = ${n.id}`;
          continue;
        }
        await deliver(ctx, { kind: "user", email: n.email }, message);
      }
      await sql`update notifications set status = 'sent', sent_at = now(), attempts = attempts + 1, error = null where id = ${n.id}`;
    } catch (err) {
      const attempts = n.attempts + 1;
      const delay = BACKOFF_MINUTES[attempts - 1];
      const error = (err as Error).message.slice(0, 500);
      if (delay === undefined) {
        await sql`update notifications set status = 'failed', attempts = ${attempts}, error = ${error} where id = ${n.id}`;
        log(`[alerts] notification ${n.id} failed permanently: ${error}`);
      } else {
        await sql`update notifications set attempts = ${attempts}, error = ${error}, next_attempt_at = now() + make_interval(mins => ${delay}) where id = ${n.id}`;
      }
    }
  }
  return due.length;
}

export async function alertsRetention(sql: SQL): Promise<void> {
  await sql`delete from notifications where created_at < now() - interval '180 days'`;
  await sql`delete from incidents where resolved_at < now() - interval '180 days'`;
  await sql`delete from events e where at < now() - interval '180 days'
            and not exists (select 1 from incidents i where i.opened_event_id = e.id)`;
}
