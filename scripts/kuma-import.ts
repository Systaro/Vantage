/**
 * Takes the Uptime Kuma monitors over into Vantage (docs/self-hosting.md "Uptime Kuma"): organisations,
 * projects and environments from scripts/kuma/mapping.json, the monitors from the export of
 * scripts/kuma/export.py on stdin, and the users, grants and mail channels that Kuma's notifications
 * stood for. Writes through the hub role as the mapping's admin, under the same policies as the UI,
 * in one transaction with one audit entry.
 *
 *   ssh <kuma host> 'sudo python3 - | sudo docker compose -f /data/vantage/compose.yml exec -T hub \
 *     bun run scripts/kuma-import.ts [--apply]' < scripts/kuma/export.py
 *
 * Without --apply the whole import runs and is rolled back: the printed plan has passed every
 * constraint and policy. Monitors carry their Kuma id (config.kumaId), so a second run skips what
 * is already there. Push monitors keep Kuma's token (stored as its hash) for /api/push/<token>.
 * The plan never prints secrets.
 */
import { join } from "node:path";
import type { SQL } from "bun";
import { sealConfig, summarize } from "../src/hub/modules/alerts/channels";
import { convertKumaMonitor, monitorKey, type KumaMonitor, type PlannedMonitor } from "../src/hub/modules/uptime/kuma-import";
import { env } from "../src/shared/config";
import { encryptString, sha256Hex } from "../src/shared/crypto";
import { connect } from "../src/shared/db";

interface Mapping {
  actor: string;
  organisations: { slug: string; name: string }[];
  projects: { path: string; name: string }[];
  environments: { path: string; name: string; kind: string; url?: string }[];
  monitors: Record<string, [string, string] | null>;
  users: { email: string; name?: string; kind?: string; grants: { project: string; level: string }[] }[];
  channels: { name: string; recipients: string[]; enabled: boolean; monitors: number[] }[];
}

const SORT: Record<string, number> = { production: 0, staging: 10, test: 20, demo: 30, development: 40, other: 50 };
const apply = process.argv.includes("--apply");
const mapping = (await Bun.file(join(import.meta.dir, "kuma", "mapping.json")).json()) as Mapping;
const exported = JSON.parse(await Bun.stdin.text()) as { monitors: KumaMonitor[] };
const secret = env("HUB_SECRET");
const sql = connect(env("HUB_DATABASE_URL"), 1);
const plan: string[] = [];
const counts = { monitors: 0, skipped: 0, unmapped: 0, users: 0, grants: 0, channels: 0, routes: 0 };

function describe(p: PlannedMonitor): string {
  const c = p.config as any;
  const timing = p.kind === "heartbeat"
    ? `Push, alle ${p.interval} s + ${c.graceSeconds} s Toleranz`
    : `alle ${p.interval} s, ${p.retries}× Wiederholung alle ${p.retryInterval ?? 20} s, Zeitlimit ${p.timeoutMs / 1000} s`;
  if (p.kind === "heartbeat") return timing;
  return [
    `${c.method} ${c.url}`,
    c.expectStatus !== "200-299" && `Status ${c.expectStatus}`,
    c.json && `JSON ${c.json.path} ${c.json.op} ${c.json.expected}`,
    p.secrets.headers && `${Object.keys(p.secrets.headers).length} Header (verschlüsselt)`,
    p.secrets.query && "Query (verschlüsselt)",
    c.body && `Inhalt ${c.body.length} Zeichen`,
    c.tlsExpiry && "Zertifikat",
    timing,
  ].filter(Boolean).join(" · ");
}

async function withSecrets(p: PlannedMonitor): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = { ...p.config };
  if (p.secrets.headers) config.headersEnc = await encryptString(secret, JSON.stringify(p.secrets.headers));
  if (p.secrets.query) config.queryEnc = await encryptString(secret, p.secrets.query);
  return JSON.parse(JSON.stringify(config));
}

async function registry(tx: SQL) {
  const orgs = new Map<string, number>();
  for (const o of (await tx`select id, slug from organisations`) as { id: number; slug: string }[]) orgs.set(o.slug, o.id);
  for (const o of mapping.organisations) {
    if (orgs.has(o.slug)) continue;
    const [row] = (await tx`insert into organisations (slug, name) values (${o.slug}, ${o.name}) returning id`) as { id: number }[];
    orgs.set(o.slug, row!.id);
    plan.push(`+ Organisation ${o.name}`);
  }
  const projects = new Map<string, number>();
  for (const p of (await tx`select p.id, o.slug || '/' || p.slug as path from projects p join organisations o on o.id = p.organisation_id`) as { id: number; path: string }[]) projects.set(p.path, p.id);
  for (const p of mapping.projects) {
    if (projects.has(p.path)) continue;
    const [org, slug] = p.path.split("/");
    const [row] = (await tx`insert into projects (organisation_id, slug, name) values (${orgs.get(org!)!}, ${slug!}, ${p.name}) returning id`) as { id: number }[];
    projects.set(p.path, row!.id);
    plan.push(`+ Projekt ${p.path} „${p.name}“`);
  }
  const envs = new Map<string, number>();
  for (const e of (await tx`select e.id, o.slug || '/' || p.slug || '/' || e.slug as path from environments e join projects p on p.id = e.project_id join organisations o on o.id = p.organisation_id`) as { id: number; path: string }[]) envs.set(e.path, e.id);
  for (const e of mapping.environments) {
    if (envs.has(e.path)) continue;
    const project = projects.get(e.path.split("/").slice(0, 2).join("/"));
    if (!project) throw new Error(`Projekt für ${e.path} fehlt in der Zuordnung`);
    const [row] = (await tx`insert into environments (project_id, slug, name, kind, url, sort_order)
      values (${project}, ${e.path.split("/")[2]!}, ${e.name}, ${e.kind}, ${e.url ?? null}, ${SORT[e.kind] ?? 50}) returning id`) as { id: number }[];
    envs.set(e.path, row!.id);
    plan.push(`+ Umgebung ${e.path} „${e.name}“ (${e.kind})`);
  }
  return { projects, envs };
}

async function monitors(tx: SQL, envs: Map<string, number>) {
  const existing = (await tx`select id, environment_id, name, kind, config from monitors`) as { id: number; environment_id: number; name: string; kind: string; config: any }[];
  const byKumaId = new Map<number, number>();
  const keys = new Map<string, { id: number; name: string }>();
  for (const m of existing) {
    if (m.config?.kumaId) byKumaId.set(Number(m.config.kumaId), m.id);
    const key = monitorKey(m.kind, m.config);
    if (key) keys.set(`${m.environment_id} ${key}`, { id: m.id, name: m.name });
  }
  for (const k of exported.monitors) {
    if (k.type === "group") continue;
    const entry = mapping.monitors[String(k.id)];
    if (!k.active) {
      plan.push(`- ${k.name.trim()}: in Kuma pausiert`);
      counts.skipped++;
      continue;
    }
    if (entry === undefined) {
      plan.push(`! ${k.name.trim()} (Kuma ${k.id}): fehlt in der Zuordnung`);
      counts.unmapped++;
      continue;
    }
    if (entry === null) {
      plan.push(`- ${k.name.trim()}: prüft dasselbe wie ein anderer Kuma-Monitor`);
      counts.skipped++;
      continue;
    }
    const [envPath, name] = entry;
    const envId = envs.get(envPath);
    if (!envId) throw new Error(`Umgebung ${envPath} fehlt in der Zuordnung`);
    if (byKumaId.has(k.id)) {
      plan.push(`= ${envPath} ${name}: schon übernommen`);
      continue;
    }
    const planned = convertKumaMonitor(k, name);
    if ("skip" in planned) {
      plan.push(`! ${envPath} ${name}: ${planned.skip}`);
      counts.skipped++;
      continue;
    }
    const key = monitorKey(planned.kind, planned.config);
    const same = key ? keys.get(`${envId} ${key}`) : undefined;
    if (same) {
      plan.push(`= ${envPath} ${name}: Vantage prüft das schon („${same.name}“)`);
      byKumaId.set(k.id, same.id);
      counts.skipped++;
      continue;
    }
    const [row] = (await tx`
      insert into monitors (environment_id, name, kind, config, interval_seconds, timeout_ms, retries, retry_interval_seconds, enabled, heartbeat_token_hash)
      values (${envId}, ${name}, ${planned.kind}, ${await withSecrets(planned)}::jsonb, ${planned.interval}, ${planned.timeoutMs}, ${planned.retries},
              ${planned.retryInterval}, true, ${planned.secrets.pushToken ? sha256Hex(planned.secrets.pushToken) : null})
      returning id`) as { id: number }[];
    byKumaId.set(k.id, row!.id);
    if (key) keys.set(`${envId} ${key}`, { id: row!.id, name });
    plan.push(`+ ${envPath}: ${name} · ${describe(planned)}`);
    counts.monitors++;
  }
  return byKumaId;
}

async function people(tx: SQL, actorId: number, projects: Map<string, number>, byKumaId: Map<number, number>) {
  for (const u of mapping.users) {
    let [user] = (await tx`select id from users where email = ${u.email}`) as { id: number }[];
    if (!user) {
      if (!u.name) throw new Error(`${u.email}: neuer Benutzer ohne Namen`);
      [user] = (await tx`insert into users (email, name, kind, is_admin, created_by) values (${u.email}, ${u.name}, ${u.kind ?? "staff"}, false, ${actorId}) returning id`) as { id: number }[];
      plan.push(`+ Benutzer ${u.name} <${u.email}> (ohne Einladung)`);
      counts.users++;
    }
    for (const g of u.grants) {
      const project = projects.get(g.project);
      if (!project) throw new Error(`Projekt ${g.project} fehlt`);
      const added = await tx`insert into grants (user_id, project_id, level, all_environments, note, created_by)
        values (${user!.id}, ${project}, ${g.level}, true, 'Übernommen aus Uptime Kuma', ${actorId})
        on conflict (user_id, project_id) do nothing returning id`;
      if (added.length) {
        plan.push(`+ Freigabe ${u.email} → ${g.project} (${g.level})`);
        counts.grants++;
      }
    }
  }
  for (const ch of mapping.channels) {
    const [found] = (await tx`select id from channels where name = ${ch.name}`) as { id: number }[];
    if (found) {
      plan.push(`= Kanal ${ch.name}: schon da`);
      continue;
    }
    const cfg = { kind: "email" as const, recipients: ch.recipients };
    const [channel] = (await tx`insert into channels (name, kind, config_enc, summary, enabled)
      values (${ch.name}, 'email', ${await sealConfig(secret, cfg)}, ${summarize(cfg)}, ${ch.enabled}) returning id`) as { id: number }[];
    plan.push(`+ Kanal ${ch.name} (E-Mail, ${ch.enabled ? "aktiv" : "deaktiviert"})`);
    counts.channels++;
    for (const kumaId of ch.monitors) {
      const monitorId = byKumaId.get(kumaId);
      if (!monitorId) throw new Error(`Kanal ${ch.name}: Kuma-Monitor ${kumaId} wurde nicht übernommen`);
      await tx`insert into routes (channel_id, scope_kind, scope_id, sources, min_severity) values (${channel!.id}, 'monitor', ${monitorId}, '{uptime}', 'warning')`;
      const [m] = (await tx`select name from monitors where id = ${monitorId}`) as { name: string }[];
      plan.push(`  + Regel: Monitor „${m!.name}“, Uptime ab Warnung`);
      counts.routes++;
    }
  }
}

class DryRun extends Error {}

const [actor] = (await sql`select id from auth_user_for_login(${mapping.actor})`) as { id: number }[];
if (!actor) throw new Error(`${mapping.actor} hat keinen Vantage-Zugang`);
try {
  await sql.begin(async (tx) => {
    await tx`select set_config('vantage.user_id', ${String(actor.id)}, true)`;
    const [me] = (await tx`select is_admin from users where id = ${actor.id}`) as { is_admin: boolean }[];
    if (!me?.is_admin) throw new Error(`${mapping.actor} ist kein Administrator`);
    const { projects, envs } = await registry(tx);
    const byKumaId = await monitors(tx, envs);
    await people(tx, actor.id, projects, byKumaId);
    await tx`select audit('kuma.import', null, ${counts}::jsonb, null, null)`;
    if (!apply) throw new DryRun();
  });
} catch (err) {
  if (!(err instanceof DryRun)) throw err;
}
console.log(plan.join("\n"));
console.log(`\n${apply ? "Übernommen" : "Probelauf, nichts gespeichert"}: ${JSON.stringify(counts)}`);
await sql.close();
