/**
 * DEV ONLY: a small, fictional world to click through. Idempotent.
 *   Nordwind GmbH  → Webshop (prod, stage), CRM (prod)
 *   Bergbau AG     → Minenportal (prod, test)
 * Users (all password "vantage-dev-password", TOTP secret JBSWY3DPEHPK3PXP for every dev user):
 *   admin@vantage.local (admin), dev@systaro.example (staff, no grants),
 *   alice@nordwind.example (Webshop, overview), bob@bergbau.example (Minenportal, diagnostics),
 *   carol@agency.example (Webshop stage only, diagnostics)
 * Module seeds (monitors, runs, ES data) live in scripts/seed-<module>.ts and are run from here.
 */
import { encryptString, hashPassword } from "../src/shared/crypto";
import { env } from "../src/shared/config";
import { connect } from "../src/shared/db";

if (process.env.NODE_ENV === "production") throw new Error("seed is a development tool");
const sql = connect(env("HUB_MIGRATE_URL"), 2);
const secret = env("HUB_SECRET");
export const DEV_TOTP = "JBSWY3DPEHPK3PXP";

async function id(q: Promise<unknown>): Promise<number> {
  return ((await q) as { id: number }[])[0]!.id;
}

const org = (slug: string, name: string) =>
  id(sql`insert into organisations (slug, name) values (${slug}, ${name}) on conflict (slug) do update set name = excluded.name returning id`);
const project = (orgId: number, slug: string, name: string) =>
  id(sql`insert into projects (organisation_id, slug, name) values (${orgId}, ${slug}, ${name})
         on conflict (organisation_id, slug) do update set name = excluded.name returning id`);
const environment = (projectId: number, slug: string, name: string, kind: string, url: string, sort: number) =>
  id(sql`insert into environments (project_id, slug, name, kind, url, sort_order) values (${projectId}, ${slug}, ${name}, ${kind}, ${url}, ${sort})
         on conflict (project_id, slug) do update set name = excluded.name, kind = excluded.kind, url = excluded.url returning id`);

const nordwind = await org("nordwind", "Nordwind GmbH");
const bergbau = await org("bergbau", "Bergbau AG");
const shop = await project(nordwind, "shop", "Webshop");
const crm = await project(nordwind, "crm", "CRM");
const mine = await project(bergbau, "mine", "Minenportal");
const envs = {
  shopProd: await environment(shop, "prod", "Produktion", "production", "https://shop.nordwind.example", 0),
  shopStage: await environment(shop, "stage", "Stage", "staging", "https://stage.shop.nordwind.example", 1),
  crmProd: await environment(crm, "prod", "Produktion", "production", "https://crm.nordwind.example", 0),
  mineProd: await environment(mine, "prod", "Produktion", "production", "https://portal.bergbau.example", 0),
  mineTest: await environment(mine, "test", "Test", "test", "https://test.portal.bergbau.example", 1),
};

const passwordHash = await hashPassword("vantage-dev-password");
const totp = await encryptString(secret, DEV_TOTP);
const user = (email: string, name: string, kind: string, isAdmin = false) =>
  id(sql`insert into users (email, name, kind, is_admin, password_hash, totp_secret_enc) values (${email}, ${name}, ${kind}, ${isAdmin}, ${passwordHash}, ${totp})
         on conflict (email) do update set password_hash = excluded.password_hash, totp_secret_enc = excluded.totp_secret_enc returning id`);
const users = {
  admin: await user("admin@vantage.local", "Dev Admin", "staff", true),
  dev: await user("dev@systaro.example", "Dev Ohne Freigaben", "staff"),
  alice: await user("alice@nordwind.example", "Alice Nordwind", "customer"),
  bob: await user("bob@bergbau.example", "Bob Bergbau", "customer"),
  carol: await user("carol@agency.example", "Carol Agentur", "customer"),
};

const grant = async (userId: number, projectId: number, level: string, envIds?: number[]) => {
  const g = await id(sql`insert into grants (user_id, project_id, level, all_environments) values (${userId}, ${projectId}, ${level}, ${!envIds})
                         on conflict (user_id, project_id) do update set level = excluded.level, all_environments = excluded.all_environments returning id`);
  await sql`delete from grant_environments where grant_id = ${g}`;
  for (const e of envIds ?? []) await sql`insert into grant_environments (grant_id, environment_id) values (${g}, ${e})`;
};
await grant(users.alice, shop, "overview");
await grant(users.bob, mine, "diagnostics");
await grant(users.carol, shop, "diagnostics", [envs.shopStage]);

export const world = { orgs: { nordwind, bergbau }, projects: { shop, crm, mine }, envs, users };
await Bun.write("data/seed-world.json", JSON.stringify(world, null, 2));
console.log("seeded core", JSON.stringify(world));

for (const mod of ["uptime", "tests", "es"]) {
  const file = `scripts/seed-${mod}.ts`;
  if (await Bun.file(file).exists()) {
    const proc = Bun.spawnSync(["bun", "run", file], { stdout: "inherit", stderr: "inherit" });
    if (proc.exitCode !== 0) throw new Error(`${file} failed`);
  }
}
await sql.end();
