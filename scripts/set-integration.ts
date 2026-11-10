/**
 * Saves an integration from the command line the way Verwaltung → Integrationen does: as an admin,
 * under the same policy, with an audit entry, followed by the connection check. The credential comes
 * on stdin, so it never appears in a shell history, a process list or a terminal; settings are
 * key=value arguments (numbers stay numbers). Example, token straight from the Semaphore host:
 *
 *   ssh <semaphore host> 'cat /root/.vantage-semaphore-token' | ssh <vantage host> \
 *     'sudo docker compose -f /data/vantage/compose.yml exec -T hub bun run scripts/set-integration.ts \
 *      semaphore admin@example.com url=https://semaphore.example.com project_id=1'
 */
import { checkIntegration } from "../src/hub/modules/integrations/checks";
import { INTEGRATIONS, isConfigured, isIntegrationKind } from "../src/hub/modules/integrations/kinds";
import { initIntegrations, recordCheck, saveIntegration, sealSecret } from "../src/hub/modules/integrations/store";
import { env } from "../src/shared/config";
import { connect } from "../src/shared/db";

const [kind, actorEmail, ...pairs] = process.argv.slice(2);
if (!kind || !isIntegrationKind(kind) || !actorEmail) {
  console.error("usage: bun run scripts/set-integration.ts <kind> <admin e-mail> key=value … < credential");
  process.exit(2);
}
const config: Record<string, unknown> = {};
for (const p of pairs) {
  const i = p.indexOf("=");
  if (i < 1) throw new Error(`not key=value: ${p}`);
  const value = p.slice(i + 1);
  config[p.slice(0, i)] = /^\d{1,9}$/.test(value) ? Number(value) : value;
}
const credential = (await Bun.stdin.text()).trim() || null;
if (!isConfigured(kind, { config, secret: credential })) throw new Error(`${INTEGRATIONS[kind].label}: settings or credential incomplete`);

const secret = env("HUB_SECRET");
const sql = connect(env("HUB_DATABASE_URL"), 1);
initIntegrations(sql, secret);
const [actor] = (await sql`select id from auth_user_for_login(${actorEmail})`) as { id: number }[];
if (!actor) throw new Error(`${actorEmail} hat keinen Vantage-Zugang`);

/** Runs `fn` as the admin, like a request under rls(). */
const asActor = (fn: (tx: typeof sql) => Promise<unknown>) =>
  sql.begin(async (tx) => {
    await tx`select set_config('vantage.user_id', ${String(actor.id)}, true)`;
    const [me] = (await tx`select is_admin from users where id = ${actor.id}`) as { is_admin: boolean }[];
    if (!me?.is_admin) throw new Error(`${actorEmail} ist kein Administrator`);
    await fn(tx);
  });

const secretEnc = await sealSecret(secret, credential);
await asActor(async (tx) => {
  await saveIntegration(tx, kind, config, secretEnc, actor.id);
  await tx`select audit('integration.saved', ${kind}, ${{ url: config.url ?? config.issuer ?? null, credential: credential !== null, via: "script" }}::jsonb, null)`;
});
const result = await checkIntegration(kind);
await asActor((tx) => recordCheck(tx, kind, result.ok, result.message));
console.log(`${INTEGRATIONS[kind].label} gespeichert. ${result.ok ? "" : "Verbindung klappt noch nicht: "}${result.message}`);
await sql.end();
process.exit(result.ok ? 0 : 1);
