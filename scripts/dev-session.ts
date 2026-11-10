/**
 * DEV ONLY: creates a session for an existing user and prints the cookie, so pages behind the login
 * can be checked with curl or a browser without going through TOTP. Uses the owner connection, which
 * only exists on a developer machine. Refuses to run with NODE_ENV=production.
 *   bun run scripts/dev-session.ts alice@nordwind.example
 */
import { newToken, sha256Hex } from "../src/shared/crypto";
import { env } from "../src/shared/config";
import { connect } from "../src/shared/db";

if (process.env.NODE_ENV === "production") throw new Error("dev-session is a development tool");
const email = process.argv[2];
if (!email) throw new Error("usage: bun run scripts/dev-session.ts <email>");
const sql = connect(env("HUB_MIGRATE_URL"), 1);
const [user] = (await sql`select id from users where email = ${email.toLowerCase()}`) as { id: number }[];
if (!user) throw new Error(`no user ${email}`);
const token = newToken("vs");
await sql`insert into sessions (user_id, token_hash, expires_at, ip, user_agent) values (${user.id}, ${sha256Hex(token)}, now() + interval '1 day', 'dev', 'dev-session')`;
console.log(`vantage_session=${token}`);
await sql.end();
