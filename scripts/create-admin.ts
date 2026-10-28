/**
 * Bootstrap: creates the first hub administrator and prints a one-time invite link.
 *   bun run scripts/create-admin.ts admin@systaro.de "Vorname Nachname"
 * Uses the owner connection (HUB_MIGRATE_URL), because no admin exists yet who could do it in the UI.
 */
import { newToken, sha256Hex } from "../src/shared/crypto";
import { env } from "../src/shared/config";
import { connect } from "../src/shared/db";

const [email, name] = process.argv.slice(2);
if (!email || !name) {
  console.error('usage: bun run scripts/create-admin.ts <email> "<name>"');
  process.exit(1);
}
const sql = connect(env("HUB_MIGRATE_URL"), 1);
const [user] = (await sql`
  insert into users (email, name, kind, is_admin) values (${email.toLowerCase()}, ${name}, 'staff', true)
  on conflict (email) do update set is_admin = true
  returning id`) as { id: number }[];
const token = newToken("vi");
await sql`insert into invites (user_id, token_hash, expires_at) values (${user!.id}, ${sha256Hex(token)}, now() + interval '72 hours')`;
console.log(`Admin ${email} (id ${user!.id}). Invite, valid 72 h, shown once:\n${env("HUB_PUBLIC_URL")}/invite/${token}`);
await sql.end();
