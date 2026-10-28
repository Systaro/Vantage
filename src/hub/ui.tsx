import type { Context } from "hono";
import type { Child, PropsWithChildren } from "hono/jsx";
import { getCookie, setCookie } from "hono/cookie";
import { clientIp, cookieName, cookieOptions, takeFlash } from "../shared/http";
import { Badge, PageHead, Tabs } from "../shared/ui/components";
import { Icon, type IconName } from "../shared/ui/icons";
import { AppLayout, type NavSection } from "../shared/ui/layout";
import { all, first, rls } from "./db";

interface NavEnv {
  id: number;
  name: string;
  project_id: number;
  project_name: string;
  org_id: number;
  org_name: string;
  down: number;
  up: number;
  open: number;
}

const PROJECT_COOKIE = "vantage_project";

/** Remembers the project the user last looked at, so global pages keep the same sidebar context. */
export function rememberProject(c: Context, projectId: number) {
  if (c.req.path.startsWith("/api/")) return;
  setCookie(c, cookieName(PROJECT_COOKIE), String(projectId), cookieOptions(180 * 86400));
}

export function envDot(e: Pick<NavEnv, "down" | "open" | "up">): "ok" | "bad" | "warn" | "idle" {
  return e.down > 0 ? "bad" : e.open > 0 ? "warn" : e.up > 0 ? "ok" : "idle";
}

export function worstDot(dots: ("ok" | "bad" | "warn" | "idle")[]): "ok" | "bad" | "warn" | "idle" {
  for (const d of ["bad", "warn", "ok"] as const) if (dots.includes(d)) return d;
  return "idle";
}

/** The customer/project picker: a dialog on top of the page (no clipping), with a filter field. */
function ProjectSwitcherDialog(props: { envs: NavEnv[]; currentProjectId: number | null }) {
  const orgs = new Map<number, { name: string; projects: Map<number, { name: string; envs: NavEnv[] }> }>();
  for (const e of props.envs) {
    if (!orgs.has(e.org_id)) orgs.set(e.org_id, { name: e.org_name, projects: new Map() });
    const org = orgs.get(e.org_id)!;
    if (!org.projects.has(e.project_id)) org.projects.set(e.project_id, { name: e.project_name, envs: [] });
    org.projects.get(e.project_id)!.envs.push(e);
  }
  return (
    <dialog id="project-switcher" class="switcher-dialog" aria-label="Projekt wählen">
      <div class="switcher-head">
        <Icon name="search" />
        <input type="search" placeholder="Kunde oder Projekt suchen" data-filter="#project-switcher .switcher-item" autocomplete="off" />
        <button type="button" class="btn ghost small icon-only" data-dialog-close aria-label="Schließen"><Icon name="x" /></button>
      </div>
      <div class="switcher-body">
        <a class="switcher-item switcher-all" href="/" data-search="alle projekte übersicht">
          <span class="switcher-icon"><Icon name="layout-dashboard" size="sm" /></span>
          <span class="switcher-name">Alle Projekte</span>
        </a>
        {[...orgs.values()].map((org) => (
          <div class="switcher-org">
            <div class="switcher-org-name"><Icon name="building-2" size="sm" />{org.name}</div>
            {[...org.projects.entries()].map(([pid, p]) => (
              <a
                class={`switcher-item${pid === props.currentProjectId ? " current" : ""}`}
                href={`/projects/${pid}`}
                data-search={`${org.name} ${p.name}`.toLowerCase()}
              >
                <span class="switcher-icon">{p.name.slice(0, 1).toUpperCase()}</span>
                <span class="switcher-name">{p.name}</span>
                <span class="switcher-envs">
                  {p.envs.map((e) => <span class={`dot ${envDot(e)}`} title={e.name} />)}
                </span>
                {pid === props.currentProjectId && <Icon name="check" size="sm" />}
              </a>
            ))}
          </div>
        ))}
        <p class="switcher-empty" hidden>Nichts gefunden.</p>
      </div>
    </dialog>
  );
}

/**
 * Every hub page sits in the app shell. The sidebar starts with the customer/project switcher; below
 * it the chosen project's overview and environments (with status dots), then global entries and admin.
 * `section`: "overview", "incidents", "notifications", "project", "admin:<tab>".
 */
export async function HubPage(props: PropsWithChildren<{ c: Context; title: string; section?: string; envId?: number; projectId?: number }>) {
  const c = props.c;
  const user = c.get("user");
  const { envs, openIncidents } = await rls(c, async (tx) => ({
    envs: await all<NavEnv>(tx`
      select e.id, e.name, p.id as project_id, p.name as project_name, o.id as org_id, o.name as org_name,
        (select count(*)::int from monitor_state s where s.environment_id = e.id and s.status = 'down') as down,
        (select count(*)::int from monitor_state s where s.environment_id = e.id and s.status = 'up') as up,
        (select count(*)::int from incidents i where i.environment_id = e.id and i.resolved_at is null) as open
      from environments e join projects p on p.id = e.project_id join organisations o on o.id = p.organisation_id
      order by o.name, p.name, e.sort_order, e.name`),
    openIncidents: ((await tx`select count(*)::int as n from incidents where resolved_at is null`) as { n: number }[])[0]?.n ?? 0,
  }));

  // The project in focus: the page's own, else the one remembered from the last visit (if still visible).
  const remembered = Number(getCookie(c, cookieName(PROJECT_COOKIE)) ?? "");
  const projectId = props.projectId ?? (envs.some((e) => e.project_id === remembered) ? remembered : null);
  const projectEnvs = envs.filter((e) => e.project_id === projectId);
  const project = projectEnvs[0];

  const switcher = (
    <a href="/" class="switcher" data-dialog-open="project-switcher" aria-haspopup="dialog" title="Projekt wechseln (Strg+K)">
      <span class="switcher-icon">{project ? project.project_name.slice(0, 1).toUpperCase() : <Icon name="layers" size="sm" />}</span>
      <span class="switcher-label">
        <span class="switcher-org-label">{project ? project.org_name : "Kein Projekt gewählt"}</span>
        <strong>{project ? project.project_name : "Projekt wählen"}</strong>
      </span>
      <Icon name="chevron-right" size="sm" />
    </a>
  );

  const sections: NavSection[] = [];
  if (project) {
    const projectOpen = projectEnvs.reduce((n, e) => n + e.open, 0);
    sections.push({
      label: "Projekt",
      items: [
        { href: `/projects/${project.project_id}`, label: "Projektübersicht", icon: "layout-dashboard", active: props.section === "project", count: projectOpen, countTone: "bad" },
        ...projectEnvs.map((e) => ({ href: `/env/${e.id}`, label: e.name, active: props.envId === e.id, dot: envDot(e) })),
      ],
    });
  }
  sections.push({
    label: "Allgemein",
    items: [
      { href: "/", label: "Alle Projekte", icon: "layers", active: props.section === "overview" },
      { href: "/incidents", label: "Vorfälle", icon: "siren", active: props.section === "incidents", count: openIncidents, countTone: "bad" },
      { href: "/account/notifications", label: "Benachrichtigungen", icon: "bell", active: props.section === "notifications" },
    ],
  });
  if (user?.isAdmin) {
    sections.push({
      label: "Verwaltung",
      items: [
        { href: "/admin", label: "Organisationen", icon: "building-2", active: props.section === "admin:registry" },
        { href: "/admin/users", label: "Benutzer & Freigaben", icon: "users", active: props.section === "admin:users" },
        { href: "/admin/alerts", label: "Kanäle & Regeln", icon: "zap", active: props.section === "admin:alerts" },
        { href: "/admin/integrations", label: "Integrationen", icon: "plug", active: props.section === "admin:integrations" },
        { href: "/admin/ansible", label: "Ansible-Läufe", icon: "terminal", active: props.section === "admin:ansible" },
        { href: "/admin/runners", label: "Runner", icon: "network", active: props.section === "admin:runners" },
        { href: "/admin/tokens", label: "Maschinen-Tokens", icon: "key-round", active: props.section === "admin:tokens" },
        { href: "/admin/audit", label: "Protokoll", icon: "scroll-text", active: props.section === "admin:audit" },
      ],
    });
  }
  return (
    <AppLayout
      product="Vantage"
      title={props.title}
      sections={sections}
      user={user}
      flash={takeFlash(c)}
      switcher={envs.length > 0 ? switcher : undefined}
      dialogs={envs.length > 0 ? <ProjectSwitcherDialog envs={envs} currentProjectId={projectId} /> : undefined}
    >
      {props.children}
    </AppLayout>
  );
}


export interface EnvContext {
  id: number;
  slug: string;
  name: string;
  kind: string;
  url: string | null;
  projectId: number;
  projectSlug: string;
  projectName: string;
  orgId: number;
  orgSlug: string;
  orgName: string;
  /** 1 = overview, 2 = diagnostics, 3 = security */
  level: number;
  hasLogs: boolean;
  hasApm: boolean;
  /** A vulnerability source (Dependency-Track, Wazuh) is mapped; the tab itself needs level 3. */
  hasSecurity: boolean;
  /** Servers for the Ansible runs are mapped; the Wartung tab needs level 3 too. */
  hasAnsible: boolean;
  /** A runner reads servers of this environment; like the servers themselves only visible from level 2. */
  hasServers: boolean;
}

/** Loads an environment the current user may see at `minLevel`, or null (→ 404, never 403). */
export async function loadEnv(c: Context, id: number, minLevel = 1): Promise<EnvContext | null> {
  return rls(c, async (tx) => {
    const row = await first<any>(tx`
      select e.id, e.slug, e.name, e.kind, e.url, p.id as project_id, p.slug as project_slug, p.name as project_name,
             o.id as org_id, o.slug as org_slug, o.name as org_name,
             vantage_level(vantage_uid(), e.id) as level
      from environments e join projects p on p.id = e.project_id join organisations o on o.id = p.organisation_id
      where e.id = ${id}`);
    if (!row || row.level < minLevel) return null;
    rememberProject(c, row.project_id);
    // environment_sources is only readable with level 2, so for overview users both stay false.
    const sources = (await tx`select kind from environment_sources where environment_id = ${id}`) as { kind: string }[];
    const servers = await first(tx`select 1 from servers where environment_id = ${id} limit 1`);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      url: row.url,
      projectId: row.project_id,
      projectSlug: row.project_slug,
      projectName: row.project_name,
      orgId: row.org_id,
      orgSlug: row.org_slug,
      orgName: row.org_name,
      level: row.level,
      hasLogs: sources.some((s) => s.kind === "logs"),
      hasApm: sources.some((s) => s.kind === "apm"),
      hasSecurity: sources.some((s) => s.kind === "dependency_track" || s.kind === "wazuh"),
      hasAnsible: sources.some((s) => s.kind === "ansible"),
      hasServers: !!servers,
    };
  });
}

export const ENV_KIND_LABEL: Record<string, string> = {
  production: "Produktion",
  staging: "Staging",
  test: "Test",
  demo: "Demo",
  development: "Entwicklung",
  other: "Sonstige",
};

/** The environment's kind; with `name`, left out when the name already says it ("Production", "Demo"). */
export function EnvKindBadge(props: { kind: string; name?: string }) {
  const label = ENV_KIND_LABEL[props.kind] ?? props.kind;
  const named = props.name?.trim().toLowerCase();
  if (named && (named === props.kind || named === label.toLowerCase())) return null;
  return <Badge tone={props.kind === "production" ? "accent" : "idle"}>{label}</Badge>;
}

export function envLabel(env: { projectName: string; name: string }) {
  return `${env.projectName} ${env.name}`;
}

export function EnvShell(props: PropsWithChildren<{ c: Context; env: EnvContext; tab: string; title: string; actions?: Child }>) {
  const e = props.env;
  const base = `/env/${e.id}`;
  const tabs: { key: string; href: string; label: string; icon: IconName }[] = [
    { key: "overview", href: base, label: "Übersicht", icon: "layout-dashboard" },
    { key: "uptime", href: `${base}/uptime`, label: "Uptime", icon: "heart-pulse" },
    ...(e.level >= 2 && e.hasServers ? [{ key: "servers", href: `${base}/servers`, label: "Server", icon: "server" as const }] : []),
    { key: "tests", href: `${base}/tests`, label: "Tests", icon: "flask-conical" },
    { key: "incidents", href: `${base}/incidents`, label: "Vorfälle", icon: "siren" },
  ];
  if (e.level >= 2 && (e.hasApm || e.hasLogs)) tabs.push({ key: "errors", href: `${base}/errors`, label: "Fehler", icon: "bug" });
  if (e.level >= 2 && e.hasLogs) tabs.push({ key: "logs", href: `${base}/logs`, label: "Logs", icon: "file-text" });
  if (e.level >= 2 && e.hasApm) tabs.push({ key: "apm", href: `${base}/apm`, label: "APM", icon: "gauge" });
  if (e.level >= 3 && e.hasSecurity) tabs.push({ key: "security", href: `${base}/security`, label: "Sicherheit", icon: "shield-check" });
  if (e.level >= 3 && e.hasAnsible) tabs.push({ key: "maintenance", href: `${base}/maintenance`, label: "Wartung", icon: "terminal" });
  if (props.c.get("user")?.isAdmin) tabs.push({ key: "settings", href: `${base}/settings`, label: "Einstellungen", icon: "settings" });
  return (
    <HubPage c={props.c} title={`${props.title} – ${envLabel(e)}`} envId={e.id} projectId={e.projectId}>
      <PageHead
        crumbs={[{ href: "/", label: e.orgName }, { href: `/projects/${e.projectId}`, label: e.projectName }]}
        icon="layers"
        title={
          <span class="row">
            {e.name}
            <EnvKindBadge kind={e.kind} />
          </span>
        }
        sub={e.url ? <a href={e.url} rel="noopener noreferrer" class="row"><Icon name="globe" size="sm" />{e.url}</a> : undefined}
        actions={props.actions}
      />
      <Tabs items={tabs.map((t) => ({ href: t.href, label: t.label, icon: t.icon, active: t.key === props.tab }))} />
      {props.children}
    </HubPage>
  );
}

export async function audit(c: Context, action: string, target: string | null, detail: Record<string, unknown> = {}) {
  await rls(c, (tx) => tx`select audit(${action}, ${target}, ${detail}::jsonb, ${clientIp(c)})`);
}
