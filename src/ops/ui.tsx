import type { Context } from "hono";
import type { Child, PropsWithChildren } from "hono/jsx";
import type { SQL } from "bun";
import { clientIp, takeFlash } from "../shared/http";
import { Badge, Empty, type Tone } from "../shared/ui/components";
import { Icon, type IconName } from "../shared/ui/icons";
import { AppLayout, PlainLayout, type NavSection } from "../shared/ui/layout";
import type { RunStatus } from "./ansible/runner";
import { STATUS_TEXT } from "./ansible/runner";
import { can } from "./roles";

export const PRODUCT = "Vantage Ops";
export const SESSION_COOKIE = "vantage_ops_session";

const NAV: { key: string; href: string; label: string; icon: IconName }[] = [
  { key: "dashboard", href: "/", label: "Übersicht", icon: "layout-dashboard" },
  { key: "hosts", href: "/hosts", label: "Hosts", icon: "server" },
  { key: "templates", href: "/templates", label: "Ansible-Vorlagen", icon: "terminal" },
  { key: "runs", href: "/runs", label: "Läufe", icon: "list-checks" },
  { key: "schedules", href: "/schedules", label: "Pipelines", icon: "git-branch" },
  { key: "events", href: "/events", label: "Ereignisse an den Hub", icon: "activity" },
];
const ADMIN_NAV: typeof NAV = [
  { key: "users", href: "/users", label: "Benutzer", icon: "users" },
  { key: "audit", href: "/audit", label: "Protokoll", icon: "scroll-text" },
];

export function OpsPage(props: PropsWithChildren<{ c: Context; title: string; section?: string; head?: Child }>) {
  const user = props.c.get("user");
  const link = (i: (typeof NAV)[number]) => ({ href: i.href, label: i.label, icon: i.icon, active: i.key === props.section });
  const sections: NavSection[] = [{ items: NAV.map(link) }];
  if (can(user, "admin")) sections.push({ label: "Verwaltung", items: ADMIN_NAV.map(link) });
  return (
    <AppLayout product={PRODUCT} title={props.title} sections={sections} user={user} flash={takeFlash(props.c)} head={props.head}>
      {props.children}
    </AppLayout>
  );
}

export function MessagePage(props: { title: string; text: string; c?: Context }) {
  return (
    <PlainLayout product={PRODUCT} title={props.title}>
      <div class="card">
        <Empty title={props.title} icon="circle-alert" action={<a class="btn primary" href="/">Zur Übersicht</a>}>{props.text}</Empty>
      </div>
    </PlainLayout>
  );
}

/** The bottom row of a form: primary submit on the left, an optional way back next to it. */
export function FormActions(props: { label: string; cancelHref?: string; icon?: IconName }) {
  return (
    <div class="ops-form-actions">
      <button class="btn primary" type="submit"><Icon name={props.icon ?? "check"} size="sm" />{props.label}</button>
      {props.cancelHref && <a class="btn ghost" href={props.cancelHref}>Abbrechen</a>}
    </div>
  );
}

/** A heading between card groups on a detail page ("Einstellungen"). */
export function SectionHead(props: { title: string; sub?: Child }) {
  return (
    <div class="ops-section-head">
      <h2>{props.title}</h2>
      {props.sub && <p class="muted small">{props.sub}</p>}
    </div>
  );
}

/** Long paths (mount points, check keys) may wrap after each slash instead of mid-word. */
export function Breakable(props: { text: string }) {
  const parts = props.text.split("/");
  return <>{parts.map((p, i) => (i < parts.length - 1 ? <>{p}/<wbr /></> : p))}</>;
}

/** Who did it, for runs and triggers: the user's e-mail. */
export function actor(c: Context): { id: number; label: string } {
  const u = c.get("user");
  return { id: u.id, label: u.email };
}

export async function audit(sql: SQL, c: Context, action: string, target: string | null, detail: Record<string, unknown> = {}) {
  const u = c.get("user");
  await sql`insert into audit_log (actor_id, actor_label, action, target, detail, ip)
    values (${u?.id ?? null}, ${u?.email ?? null}, ${action}, ${target}, ${detail}::jsonb, ${clientIp(c)})`;
}

const RUN_TONE: Record<RunStatus, Tone> = { queued: "idle", running: "info", ok: "ok", failed: "bad", cancelled: "warn", error: "bad" };

export function RunBadge(props: { status: RunStatus }) {
  return <Badge tone={RUN_TONE[props.status]} dot>{STATUS_TEXT[props.status]}</Badge>;
}

const SEV_TONE: Record<string, Tone> = { ok: "ok", warning: "warn", critical: "bad", silent: "bad", unknown: "idle" };
const SEV_TEXT: Record<string, string> = { ok: "in Ordnung", warning: "Warnung", critical: "kritisch", silent: "stumm", unknown: "keine Daten" };

export function SeverityBadge(props: { severity: string }) {
  return <Badge tone={SEV_TONE[props.severity] ?? "idle"} dot>{SEV_TEXT[props.severity] ?? props.severity}</Badge>;
}

/** Links stored in alerts are absolute (they go to the hub); inside ops they become paths. */
export function localPath(publicUrl: string, link: string | null | undefined): string | undefined {
  return link?.startsWith(`${publicUrl}/`) ? link.slice(publicUrl.length) : undefined;
}

export function safeHref(url: string | null | undefined): string | undefined {
  return url && /^https?:\/\//.test(url) ? url : undefined;
}

export { emailProblem, isUniqueViolation, nameProblem } from "../shared/validate";
