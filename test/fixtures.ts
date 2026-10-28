/**
 * Two customers, two projects each, plus staff — the minimum to prove isolation. Created with the
 * owner connection (bypasses RLS), because that is how the seed is built, not how users act.
 */
import type { SQL } from "bun";

export interface World {
  admin: number;
  staffNoGrants: number;
  aliceNordwindShopOverview: number;
  bobBergbauDiagnostics: number;
  carolStageOnly: number;
  orgs: { nordwind: number; bergbau: number };
  projects: { shop: number; crm: number; mine: number };
  envs: { shopProd: number; shopStage: number; crmProd: number; mineProd: number; mineTest: number };
}

async function one(sql: SQL, q: Promise<unknown[]>): Promise<number> {
  const rows = (await q) as { id: number }[];
  return rows[0]!.id;
}

export async function buildWorld(owner: SQL): Promise<World> {
  const nordwind = await one(owner, owner`insert into organisations (slug, name) values ('nordwind', 'Nordwind GmbH') returning id`);
  const bergbau = await one(owner, owner`insert into organisations (slug, name) values ('bergbau', 'Bergbau AG') returning id`);
  const shop = await one(owner, owner`insert into projects (organisation_id, slug, name) values (${nordwind}, 'shop', 'Webshop') returning id`);
  const crm = await one(owner, owner`insert into projects (organisation_id, slug, name) values (${nordwind}, 'crm', 'CRM') returning id`);
  const mine = await one(owner, owner`insert into projects (organisation_id, slug, name) values (${bergbau}, 'mine', 'Minenportal') returning id`);
  const env = (project: number, slug: string, kind: string) =>
    one(owner, owner`insert into environments (project_id, slug, name, kind) values (${project}, ${slug}, ${slug}, ${kind}) returning id`);
  const shopProd = await env(shop, "prod", "production");
  const shopStage = await env(shop, "stage", "staging");
  const crmProd = await env(crm, "prod", "production");
  const mineProd = await env(mine, "prod", "production");
  const mineTest = await env(mine, "test", "test");

  const user = (email: string, kind: string, isAdmin = false) =>
    one(owner, owner`insert into users (email, name, kind, is_admin) values (${email}, ${email.split("@")[0]!}, ${kind}, ${isAdmin}) returning id`);
  const admin = await user("admin@systaro.de", "staff", true);
  const staffNoGrants = await user("dev@systaro.de", "staff");
  const alice = await user("alice@nordwind.example", "customer");
  const bob = await user("bob@bergbau.example", "customer");
  const carol = await user("carol@agency.example", "customer");

  await owner`insert into grants (user_id, project_id, level) values (${alice}, ${shop}, 'overview')`;
  await owner`insert into grants (user_id, project_id, level) values (${bob}, ${mine}, 'diagnostics')`;
  const carolGrant = await one(owner, owner`insert into grants (user_id, project_id, level, all_environments) values (${carol}, ${shop}, 'diagnostics', false) returning id`);
  await owner`insert into grant_environments (grant_id, environment_id) values (${carolGrant}, ${shopStage})`;

  return {
    admin,
    staffNoGrants,
    aliceNordwindShopOverview: alice,
    bobBergbauDiagnostics: bob,
    carolStageOnly: carol,
    orgs: { nordwind, bergbau },
    projects: { shop, crm, mine },
    envs: { shopProd, shopStage, crmProd, mineProd, mineTest },
  };
}
