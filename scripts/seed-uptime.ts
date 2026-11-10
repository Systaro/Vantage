/**
 * DEV ONLY: monitors for the seeded environments, pointed at local targets (hub, dev ES, Mailpit, a
 * closed port), one light TLS/DNS check against systaro.de, a heartbeat, and 7 days of synthetic
 * check history so charts have something to show. Idempotent: replaces monitors of the seeded envs.
 */
import { newToken, sha256Hex } from "../src/shared/crypto";
import { env } from "../src/shared/config";
import { connect } from "../src/shared/db";

if (process.env.NODE_ENV === "production") throw new Error("seed is a development tool");
const world = JSON.parse(await Bun.file("data/seed-world.json").text());
const sql = connect(env("HUB_MIGRATE_URL"), 2);
const e = world.envs;

await sql`delete from monitors where environment_id in ${sql([e.shopProd, e.shopStage, e.crmProd, e.mineProd, e.mineTest])}`;
await sql`delete from incidents where subject_key like 'monitor:%'`;

const heartbeat = newToken("vhb");
const monitors: [number, string, string, object, number, string | null][] = [
  [e.shopProd, "Startseite", "http", { url: "http://localhost:7100/healthz", method: "GET", expectStatus: "200-299", followRedirects: true }, 60, null],
  [e.shopProd, "Suche (Elasticsearch)", "http", { url: "http://127.0.0.1:5461/", method: "GET", expectStatus: "200", keyword: "You Know, for Search" }, 60, null],
  [e.shopProd, "Zertifikat systaro.de", "tls", { host: "systaro.de", port: 443, warnDays: 14, critDays: 3 }, 3600, null],
  [e.shopProd, "Nächtliches Backup", "heartbeat", { graceSeconds: 120 }, 86400, sha256Hex(heartbeat)],
  [e.shopStage, "Startseite", "http", { url: "http://127.0.0.1:5463/", method: "GET", expectStatus: "200-299" }, 60, null],
  [e.shopStage, "Zahlungsdienst", "tcp", { host: "127.0.0.1", port: 5999 }, 60, null],
  [e.crmProd, "DNS", "dns", { name: "systaro.de", type: "A" }, 3600, null],
  [e.mineProd, "Portal", "http", { url: "http://localhost:7100/healthz", method: "GET", expectStatus: "200-299" }, 60, null],
  [e.mineProd, "Datenbank-Port", "tcp", { host: "127.0.0.1", port: 5460 }, 60, null],
];

for (const [envId, name, kind, config, interval, hbHash] of monitors) {
  const [m] = (await sql`insert into monitors (environment_id, name, kind, config, interval_seconds, retries, heartbeat_token_hash)
                        values (${envId}, ${name}, ${kind}, ${config}::jsonb, ${interval}, 1, ${hbHash}) returning id`) as { id: number }[];
  // Synthetic history: one check every 10 minutes for 7 days, latency with a daily rhythm, rare failures.
  const failing = kind === "tcp" && envId === e.shopStage;
  await sql`
    insert into monitor_checks (monitor_id, environment_id, at, ok, latency_ms, status_code, message)
    select ${m!.id}, ${envId}, ts,
           ok, case when ok then (60 + 40 * sin(extract(epoch from ts) / 13750) + random() * 30)::int else null end,
           case when ${kind} = 'http' and ok then 200 else null end,
           case when ok then 'ok (Testdaten)' else 'Verbindung abgelehnt (Testdaten)' end
    from (select ts, case when ${failing} then ts > now() - interval '3 hours' and false else random() > 0.004 end as ok
          from generate_series(now() - interval '7 days', now() - interval '10 minutes', interval '10 minutes') ts) s`;
}
await sql`insert into events (source, environment_id, subject_key, state, severity, title, body, at, processed_at)
          select 'uptime', ${e.shopProd}, 'monitor:demo-history', 'firing', 'critical', 'DOWN: Webshop Produktion – Startseite', 'HTTP 503 (Testdaten)', now() - interval '2 days', now()`;
await sql`insert into incidents (subject_key, source, environment_id, severity, title, opened_at, last_seen_at, resolved_at)
          values ('monitor:demo-history', 'uptime', ${e.shopProd}, 'critical', 'DOWN: Webshop Produktion – Startseite', now() - interval '2 days', now() - interval '2 days' + interval '14 minutes', now() - interval '2 days' + interval '14 minutes')`;

await Bun.write("data/dev-heartbeat.txt", `${env("HUB_PUBLIC_URL")}/api/v1/heartbeat/${heartbeat}\n`);
console.log(`seeded ${monitors.length} monitors; heartbeat URL in data/dev-heartbeat.txt`);
await sql.end();
