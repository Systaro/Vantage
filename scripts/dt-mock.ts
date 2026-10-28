/**
 * DEV ONLY: a stand-in for the Dependency-Track API on 127.0.0.1:5464, with a few projects and
 * realistic findings, so the security tab can be built and checked without the real server.
 * In Vantage: Verwaltung → Integrationen → Dependency-Track, API-Adresse http://127.0.0.1:5464,
 * API-Key dev-dependency-track-key-0001.
 *   bun run scripts/dt-mock.ts
 */
if (process.env.NODE_ENV === "production") throw new Error("dt-mock is a development tool");

const KEY = "dev-dependency-track-key-0001";
const DAY = 86_400_000;

const projects = [
  { uuid: "4c3f1a2b-6d5e-4f70-8a91-b2c3d4e5f601", name: "shop-backend", version: "main", active: true, lastBomImport: Date.now() - 2 * DAY },
  { uuid: "4c3f1a2b-6d5e-4f70-8a91-b2c3d4e5f602", name: "shop-frontend", version: "main", active: true, lastBomImport: Date.now() - 45 * DAY },
  { uuid: "4c3f1a2b-6d5e-4f70-8a91-b2c3d4e5f603", name: "mine-portal", version: "2.4", active: true, lastBomImport: Date.now() - DAY },
  { uuid: "4c3f1a2b-6d5e-4f70-8a91-b2c3d4e5f604", name: "crm", version: null, active: true, lastBomImport: null },
];

const vuln = (component: string, version: string, vulnId: string, severity: string, cvss: number | null, title: string, n: number) => ({
  component: { uuid: `5d000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: component.split(":").pop(), group: component.includes(":") ? component.split(":")[0] : null, version },
  vulnerability: { uuid: `6e000000-0000-4000-8000-${String(n).padStart(12, "0")}`, vulnId, source: vulnId.startsWith("GHSA") ? "GITHUB" : "NVD", severity, cvssV3BaseScore: cvss, title },
  analysis: { isSuppressed: false },
});

const findings: Record<string, unknown[]> = {
  [projects[0]!.uuid]: [
    vuln("org.apache.logging.log4j:log4j-core", "2.14.1", "CVE-2021-44228", "CRITICAL", 10, "Log4Shell: Remote Code Execution über JNDI-Lookups", 1),
    vuln("org.springframework:spring-web", "5.3.18", "CVE-2024-22243", "HIGH", 8.1, "Open Redirect / SSRF in UriComponentsBuilder", 2),
    vuln("com.fasterxml.jackson.core:jackson-databind", "2.13.2", "CVE-2022-42003", "HIGH", 7.5, "Deep wrapper array nesting leads to resource exhaustion", 3),
    vuln("io.netty:netty-codec-http", "4.1.77.Final", "CVE-2023-44487", "HIGH", 7.5, "HTTP/2 Rapid Reset", 4),
    vuln("org.yaml:snakeyaml", "1.30", "CVE-2022-1471", "HIGH", 8.3, "Constructor deserialization remote code execution", 5),
    vuln("ch.qos.logback:logback-core", "1.2.11", "CVE-2023-6378", "MEDIUM", 5.3, "Serialization vulnerability in logback receiver", 6),
    vuln("org.apache.commons:commons-text", "1.9", "GHSA-599f-7c49-w659", "CRITICAL", 9.8, "Arbitrary code execution in Apache Commons Text", 7),
    vuln("com.google.guava:guava", "31.0", "CVE-2023-2976", "MEDIUM", 5.5, "Use of temporary directory with insecure permissions", 8),
    vuln("org.bouncycastle:bcprov-jdk15on", "1.70", "CVE-2023-33201", "LOW", 3.1, "LDAP injection in the LDAP CertStore", 9),
  ],
  [projects[1]!.uuid]: [
    vuln("axios", "0.27.2", "CVE-2023-45857", "MEDIUM", 6.5, "Cross-Site Request Forgery durch XSRF-TOKEN-Leck", 10),
    vuln("semver", "7.3.7", "CVE-2022-25883", "MEDIUM", 5.3, "Regular Expression Denial of Service", 11),
  ],
  [projects[2]!.uuid]: [],
  [projects[3]!.uuid]: [],
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 5464,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/version") return Response.json({ version: "4.14.2-mock", application: "Dependency-Track" });
    if (req.headers.get("x-api-key") !== KEY) return new Response("Unauthorized", { status: 401 });
    if (url.pathname === "/api/v1/project") return Response.json(projects, { headers: { "x-total-count": String(projects.length) } });
    const project = /^\/api\/v1\/project\/([0-9a-f-]{36})$/.exec(url.pathname)?.[1];
    if (project) {
      const p = projects.find((x) => x.uuid === project);
      return p ? Response.json(p) : new Response("Not found", { status: 404 });
    }
    const forProject = /^\/api\/v1\/finding\/project\/([0-9a-f-]{36})$/.exec(url.pathname)?.[1];
    if (forProject) return findings[forProject] ? Response.json(findings[forProject]) : new Response("Not found", { status: 404 });
    return new Response("Not found", { status: 404 });
  },
});
console.log(`[dt-mock] Dependency-Track stand-in on http://${server.hostname}:${server.port}, API key ${KEY}`);
