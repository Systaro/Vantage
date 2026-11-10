/**
 * Bootstrap: creates the first Vantage Ops administrator and prints a one-time invite link.
 *   bun run scripts/create-ops-admin.ts admin@systaro.de "Vorname Nachname"
 * For an existing account (lost authenticator, no admin left) it makes the user admin, clears password
 * and TOTP, ends all sessions and issues a fresh invite. Uses OPS_MIGRATE_URL, because no admin exists
 * yet who could do it in the UI.
 */
import { newToken, sha256Hex } from "../src/shared/crypto";
import { env } from "../src/shared/config";
import { connect } from "../src/shared/db";

const [email, name] = process.argv.slice(2);
if (!email || !name || !/^[^@\s]+@[^@\s]+$/.test(email)) {
  console.error('usage: bun run scripts/create-ops-admin.ts <email> "<name>"');
  process.exit(1);
}
const sql = connect(env("OPS_MIGRATE_URL"), 1);
const token = newToken("voi");
const id = await sql.begin(async (tx) => {
  const [user] = (await tx`
    insert into users (email, name, role) values (${email.toLowerCase()}, ${name}, 'admin')
    on conflict (email) do update set role = 'admin', disabled_at = null, password_hash = null, totp_secret_enc = null
    returning id`) as { id: number }[];
  await tx`update sessions set revoked_at = now() where user_id = ${user!.id} and revoked_at is null`;
  await tx`update invites set used_at = now() where user_id = ${user!.id} and used_at is null`;
  await tx`insert into invites (user_id, token_hash, expires_at) values (${user!.id}, ${sha256Hex(token)}, now() + interval '72 hours')`;
  await tx`insert into audit_log (actor_label, action, target, detail) values ('scripts/create-ops-admin.ts', 'user.bootstrap_admin', ${email.toLowerCase()}, '{}'::jsonb)`;
  return user!.id;
});
console.log(`Ops admin ${email} (id ${id}). Invite, valid 72 h, shown once:\n${env("OPS_PUBLIC_URL", "http://localhost:7101").replace(/\/+$/, "")}/invite/${token}`);
await sql.end();
