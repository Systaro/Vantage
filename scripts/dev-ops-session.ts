/**
 * DEV ONLY: prints a session cookie for Vantage Ops, so pages behind the login can be checked with
 * curl or a browser without going through TOTP. With a role, a missing user is created with that
 * role (and an unusable random password, so it can only be used through this script).
 * Refuses to run with NODE_ENV=production.
 *   bun run scripts/dev-ops-session.ts viewer@systaro.de [admin|operator|viewer]
 */
import { encryptString, hashPassword, newToken, sha256Hex } from "../src/shared/crypto";
import { env } from "../src/shared/config";
import { connect } from "../src/shared/db";
import { newTotpSecret } from "../src/shared/totp";

if (process.env.NODE_ENV === "production") throw new Error("dev-ops-session is a development tool");
const [email, role] = process.argv.slice(2);
if (!email || (role && !["admin", "operator", "viewer"].includes(role))) {
  throw new Error("usage: bun run scripts/dev-ops-session.ts <email> [admin|operator|viewer]");
}
const sql = connect(env("OPS_MIGRATE_URL"), 1);
let [user] = (await sql`select id, password_hash is not null and totp_secret_enc is not null as ready from users where email = ${email.toLowerCase()}`) as {
  id: number;
  ready: boolean;
}[];
if (!user && role) {
  const secret = await encryptString(env("OPS_SECRET"), newTotpSecret());
  [user] = (await sql`insert into users (email, name, role, password_hash, totp_secret_enc)
    values (${email.toLowerCase()}, ${email.split("@")[0]!}, ${role}, ${await hashPassword(newToken("dev"))}, ${secret})
    returning id, true as ready`) as { id: number; ready: boolean }[];
} else if (user && role) {
  await sql`update users set role = ${role} where id = ${user.id}`;
}
if (!user) throw new Error(`no ops user ${email} (pass a role to create one)`);
if (!user.ready) throw new Error(`${email} has not accepted the invite yet; sessions need a password and TOTP`);
const token = newToken("vs");
await sql`insert into sessions (user_id, token_hash, expires_at, ip, user_agent) values (${user.id}, ${sha256Hex(token)}, now() + interval '1 day', 'dev', 'dev-ops-session')`;
console.log(`vantage_ops_session=${token}`);
await sql.end();
