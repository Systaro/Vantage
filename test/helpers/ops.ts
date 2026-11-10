/**
 * Ops test harness: a throwaway database, temp data / project directories, the ops service with
 * fake binaries, the Hono app, and users with sessions for each role. Nothing here touches real
 * hosts, real GitLab or the real hub.
 */
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { createOpsApp } from "../../src/ops/app";
import { AGENT_SCRIPT, type OpsConfig } from "../../src/ops/config";
import { createOps, type Ops, type OpsOverrides } from "../../src/ops/service";
import { encryptString, hashPassword, newToken, sha256Hex } from "../../src/shared/crypto";
import { newTotpSecret } from "../../src/shared/totp";
import { createOpsTestDb } from "./db";

export const PUBLIC_URL = "http://ops.test";
export const SECRET = "test-ops-secret-0123456789abcdef0123456789";
export const FIXTURE_PROJECT = join(import.meta.dir, "..", "fixtures", "ansible");

export interface OpsHarness {
  sql: SQL;
  ops: Ops;
  app: ReturnType<typeof createOpsApp>;
  dir: string;
  projectDir: string;
  config: OpsConfig;
  users: Record<"admin" | "operator" | "viewer", { id: number; email: string; cookie: string }>;
  request(path: string, init?: { method?: string; cookie?: string; form?: Record<string, string>; headers?: Record<string, string>; body?: BodyInit }): Promise<Response>;
  close(): Promise<void>;
}

export function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

export async function createUser(sql: SQL, email: string, role: string): Promise<{ id: number; email: string; cookie: string }> {
  const [u] = (await sql`insert into users (email, name, role, password_hash, totp_secret_enc)
    values (${email}, ${email.split("@")[0]!}, ${role}, ${await hashPassword("a-long-test-password")}, ${await encryptString(SECRET, newTotpSecret())})
    returning id`) as { id: number }[];
  const token = newToken("vs");
  await sql`insert into sessions (user_id, token_hash, expires_at) values (${u!.id}, ${sha256Hex(token)}, now() + interval '1 hour')`;
  return { id: u!.id, email, cookie: `vantage_ops_session=${token}` };
}

export async function createOpsHarness(opts: { config?: (c: OpsConfig) => Partial<OpsConfig>; overrides?: OpsOverrides } = {}): Promise<OpsHarness> {
  const db = await createOpsTestDb();
  const dir = mkdtempSync(join(tmpdir(), "vantage-ops-test-"));
  const projectDir = join(dir, "project");
  cpSync(FIXTURE_PROJECT, projectDir, { recursive: true });
  const base: OpsConfig = {
    port: 0,
    publicUrl: PUBLIC_URL,
    secret: SECRET,
    databaseUrl: "unused",
    dataDir: join(dir, "data"),
    hubUrl: "http://127.0.0.1:9",
    hubEventToken: undefined,
    ansible: { projectDir, gitPull: false, bin: "ansible-playbook", gitBin: "git" },
    gitlabUrl: "http://127.0.0.1:9",
    sshBin: "/nonexistent/ssh",
    agentScript: AGENT_SCRIPT,
  };
  const config = { ...base, ...opts.config?.(base) };
  const ops = createOps(config, db.sql, { log: () => {}, ...opts.overrides });
  const app = createOpsApp(ops);
  const users = {
    admin: await createUser(db.sql, "admin@systaro.de", "admin"),
    operator: await createUser(db.sql, "operator@systaro.de", "operator"),
    viewer: await createUser(db.sql, "viewer@systaro.de", "viewer"),
  };
  return {
    sql: db.sql,
    ops,
    app,
    dir,
    projectDir,
    config,
    users,
    request(path, init = {}) {
      const headers: Record<string, string> = { origin: PUBLIC_URL, ...init.headers };
      if (init.cookie) headers.cookie = init.cookie;
      let body = init.body;
      if (init.form) {
        body = new URLSearchParams(init.form);
        headers["content-type"] = "application/x-www-form-urlencoded";
      }
      return Promise.resolve(app.request(`${PUBLIC_URL}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" }));
    },
    async close() {
      ops.scheduler.stop();
      await ops.monitor.stop();
      await ops.runner.shutdown(0);
      await ops.outbox.stop();
      await db.drop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The flash message a redirect carries, decoded. */
export function flashOf(res: Response): { kind: string; text: string } | null {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("vantage_flash="));
  if (!raw) return null;
  return JSON.parse(Buffer.from(raw.split(";")[0]!.slice("vantage_flash=".length), "base64url").toString("utf8"));
}

export async function outboxRows(sql: SQL): Promise<{ subject: string; state: string; severity: string; title: string; environment: string | null }[]> {
  return (await sql`select subject, state, severity, title, environment from outbox order by id`) as any[];
}
