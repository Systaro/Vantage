/**
 * DEV ONLY: Wazuh indexer data in the local Elasticsearch: vulnerability states for three fictional
 * servers and a day of alerts. In Vantage: Verwaltung → Integrationen → Wazuh (Indexer), address
 * http://127.0.0.1:5461, no login. Idempotent: the two indices are recreated.
 *   bun run scripts/seed-wazuh.ts
 */
import { assertLocalEs, bulkIndex, DEV_ES, recreateIndex } from "./es-dev";

if (process.env.NODE_ENV === "production") throw new Error("seed is a development tool");
assertLocalEs(DEV_ES);

const kw = { type: "keyword" };
const VULN = "wazuh-states-vulnerabilities-wazuh";
const day = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
const ALERTS = `wazuh-alerts-4.x-${day}`;

const agents = [
  { id: "001", name: "web-01.nordwind.example", os: "Ubuntu 22.04.4 LTS (Jammy Jellyfish)" },
  { id: "002", name: "db-01.nordwind.example", os: "Debian GNU/Linux 12 (bookworm)" },
  { id: "003", name: "mine-app.bergbau.example", os: "Ubuntu 24.04.1 LTS (Noble Numbat)" },
];

// Packages with how many CVEs of each severity they carry (kernels collect the most).
const packages: [string, string, Record<string, number>][] = [
  ["linux-image-6.8.0-45-generic", "6.8.0-45.45", { Critical: 38, High: 210, Medium: 90, Low: 12, "-": 140 }],
  ["linux-modules-6.8.0-45-generic", "6.8.0-45.45", { Critical: 38, High: 210, Medium: 90, Low: 12, "-": 140 }],
  ["openssl", "3.0.2-0ubuntu1.15", { Critical: 1, High: 3, Medium: 4 }],
  ["libexpat1", "2.4.7-1ubuntu0.3", { Critical: 2, High: 1 }],
  ["sudo", "1.9.9-1ubuntu2.4", { High: 1, Medium: 1 }],
  ["curl", "7.81.0-1ubuntu1.16", { High: 2, Medium: 5, Low: 2 }],
  ["python3.10", "3.10.12-1~22.04.3", { High: 4, Medium: 6 }],
  ["vim", "2:8.2.3995-1ubuntu2.17", { Medium: 9, Low: 3 }],
];

const SCORE: Record<string, number> = { Critical: 9.8, High: 7.5, Medium: 5.5, Low: 3.1, "-": 0 };

let cve = 30000;
const vulns: Record<string, unknown>[] = [];
agents.forEach((a, ai) => {
  for (const [pkg, version, counts] of packages) {
    if (ai === 1 && pkg.startsWith("linux-")) continue; // the database server runs a different kernel package set
    for (const [severity, n] of Object.entries(counts)) {
      for (let i = 0; i < Math.max(1, Math.round(n / (ai + 1))); i++) {
        vulns.push({
          agent: { id: a.id, name: a.name, type: "Wazuh", version: "v4.14.7" },
          host: { os: { full: a.os } },
          package: { name: pkg, version, type: "deb" },
          vulnerability: {
            id: `CVE-2026-${cve++}`,
            severity,
            score: { base: SCORE[severity] ? SCORE[severity]! - (i % 3) * 0.1 : null },
            description: `${pkg}: fictional vulnerability ${i + 1} for development`,
            detected_at: new Date(Date.now() - (i % 20) * 86_400_000).toISOString(),
          },
        });
      }
    }
  }
});

await recreateIndex(VULN, {
  properties: {
    agent: { properties: { id: kw, name: kw } },
    host: { properties: { os: { properties: { full: kw } } } },
    package: { properties: { name: kw, version: kw } },
    vulnerability: { properties: { id: kw, severity: kw, score: { properties: { base: { type: "float" } } }, detected_at: { type: "date" } } },
  },
});
await bulkIndex(VULN, vulns);

const rules = [
  { id: "5710", level: 5, description: "sshd: Attempt to login using a non-existent user" },
  { id: "5760", level: 5, description: "sshd: authentication failed." },
  { id: "5503", level: 5, description: "PAM: User login failed." },
  { id: "31101", level: 5, description: "Web server 400 error code." },
  { id: "5402", level: 3, description: "Successful sudo to ROOT executed." },
  { id: "550", level: 7, description: "Integrity checksum changed." },
  { id: "5712", level: 10, description: "sshd: brute force trying to get access to the system. Non existent user." },
  { id: "100002", level: 12, description: "Possible shellshock attack detected." },
];
const alerts: Record<string, unknown>[] = [];
for (let i = 0; i < 1800; i++) {
  const a = agents[i % agents.length]!;
  const r = rules[i % 7 === 0 ? 6 : i % 97 === 0 ? 7 : i % 5]!;
  alerts.push({ timestamp: new Date(Date.now() - ((i * 47) % 86_000) * 1000).toISOString(), agent: { id: a.id, name: a.name }, rule: { id: r.id, level: r.level, description: r.description } });
}
await recreateIndex(ALERTS, {
  properties: { timestamp: { type: "date" }, agent: { properties: { id: kw, name: kw } }, rule: { properties: { id: kw, level: { type: "long" }, description: kw } } },
});
await bulkIndex(ALERTS, alerts);
await fetch(`${DEV_ES}/${VULN},${ALERTS}/_refresh`, { method: "POST" });
console.log(`seeded wazuh: ${vulns.length} vulnerability states for ${agents.length} agents, ${alerts.length} alerts in ${ALERTS}`);
