/**
 * DEV ONLY: test suites, one ingest token per suite and ten Playwright runs per suite spread over
 * the last days. Run by scripts/seed.ts after it wrote data/seed-world.json. Idempotent: existing
 * suites and tokens are kept, runs are only added to suites that have fewer than ten.
 *   Webshop prod      → "E2E Smoke"   (newest run has an HTML report)
 *   Webshop stage     → "Regression"  (ends red; newest run has an HTML report)
 *   Minenportal prod  → "Portal E2E"
 * Runs are generated as Playwright JSON, parsed by the real parser and stored with ingest_test_run()
 * on the owner connection. Tokens land in data/dev-tokens.json for curl uploads.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "../src/shared/config";
import { newToken, sha256Hex } from "../src/shared/crypto";
import { connect } from "../src/shared/db";
import { parsePlaywrightReport } from "../src/hub/modules/tests/playwright";
import { reportDir } from "../src/hub/modules/tests/storage";

if (process.env.NODE_ENV === "production") throw new Error("seed is a development tool");
const sql = connect(env("HUB_MIGRATE_URL"), 2);
const storageDir = env("STORAGE_DIR", "./data/storage");
const TOKENS_FILE = "data/dev-tokens.json";
const RUNS_PER_SUITE = 10;

const world = JSON.parse(await Bun.file("data/seed-world.json").text()) as { envs: Record<string, number> };

interface TestDef { file: string; describe: string; title: string }
interface SuiteDef {
  key: string;
  envId: number;
  envLabel: string;
  slug: string;
  name: string;
  description: string;
  gitlab: string;
  branch: string;
  projects: string[];
  tests: TestDef[];
  /** One letter per run, oldest first: P passed, F failed, K flaky. */
  pattern: string;
  reportRuns: number[];
}

const t = (file: string, describe: string, ...titles: string[]): TestDef[] => titles.map((title) => ({ file, describe, title }));

const SUITES: SuiteDef[] = [
  {
    key: "shop-prod-e2e-smoke",
    envId: world.envs.shopProd!,
    envLabel: "Webshop Produktion",
    slug: "e2e-smoke",
    name: "E2E Smoke",
    description: "Startseite, Suche, Warenkorb und Checkout nach jedem Deployment",
    gitlab: "https://git.example/nordwind/webshop-e2e",
    branch: "main",
    projects: ["chromium"],
    tests: [
      ...t("startseite.spec.ts", "Startseite", "zeigt die aktuellen Angebote", "Navigation zu allen Kategorien"),
      ...t("suche.spec.ts", "Suche", "findet Artikel nach Name", "zeigt einen Hinweis bei leerem Ergebnis"),
      ...t("warenkorb.spec.ts", "Warenkorb", "Artikel hinzufügen und Menge ändern", "Gutschein einlösen"),
      ...t("checkout.spec.ts", "Checkout", "Bezahlung auf Rechnung", "Bezahlung mit Kreditkarte (3-D Secure)"),
    ],
    pattern: "PPPKPPFPPP",
    reportRuns: [9],
  },
  {
    key: "shop-stage-regression",
    envId: world.envs.shopStage!,
    envLabel: "Webshop Stage",
    slug: "regression",
    name: "Regression",
    description: "Vollständige Regression vor jedem Release",
    gitlab: "https://git.example/nordwind/webshop-e2e",
    branch: "release/2026.10",
    projects: ["chromium", "firefox"],
    tests: [
      ...t("konto/anmeldung.spec.ts", "Konto › Anmeldung", "mit gültigen Zugangsdaten", "sperrt nach fünf Fehlversuchen", "Passwort vergessen"),
      ...t("konto/adressen.spec.ts", "Konto › Adressen", "neue Lieferadresse anlegen", "Rechnungsadresse ändern"),
      ...t("katalog/filter.spec.ts", "Katalog › Filter", "nach Preis filtern", "nach Marke filtern", "Filter zurücksetzen"),
      ...t("checkout/versand.spec.ts", "Checkout › Versand", "Standardversand", "Expressversand nur werktags", "Abholung im Markt"),
      ...t("checkout/zahlung.spec.ts", "Checkout › Zahlung", "PayPal", "Rechnung ab 2. Bestellung", "abgelehnte Kreditkarte"),
    ],
    pattern: "PFFKPFPKFF",
    reportRuns: [9],
  },
  {
    key: "mine-prod-portal-e2e",
    envId: world.envs.mineProd!,
    envLabel: "Minenportal Produktion",
    slug: "portal-e2e",
    name: "Portal E2E",
    description: "Anmeldung, Schichtplan und Messwerte im Minenportal",
    gitlab: "https://git.example/bergbau/minenportal",
    branch: "main",
    projects: ["chromium"],
    tests: [
      ...t("anmeldung.spec.ts", "Anmeldung", "mit Zwei-Faktor-Code", "Abmelden beendet die Sitzung"),
      ...t("schichtplan.spec.ts", "Schichtplan", "Woche anzeigen", "Schicht tauschen"),
      ...t("messwerte.spec.ts", "Messwerte", "Gaswarnung wird angezeigt", "Export als CSV"),
    ],
    pattern: "PPPFPPPKPK",
    reportRuns: [],
  },
];

// Deterministic randomness, so a re-seeded database looks the same.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const ERRORS = [
  (d: TestDef) =>
    `\u001b[31mError: \u001b[39m\u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoBeVisible\u001b[2m()\u001b[22m failed\n\n` +
    `Locator: getByRole('button', { name: '${d.describe.split(" › ").at(-1)} fortsetzen' })\nExpected: visible\nTimeout: 5000ms\nError: element(s) not found\n\n` +
    `Call log:\n\u001b[2m  - Expect "toBeVisible" with timeout 5000ms\u001b[22m\n\u001b[2m  - waiting for getByRole('button')\u001b[22m\n`,
  () =>
    `\u001b[31mError: \u001b[39mexpect(received).toBe(expected) // Object.is equality\n\nExpected: \u001b[32m200\u001b[39m\nReceived: \u001b[31m502\u001b[39m\n`,
  () => `\u001b[31mTimeoutError: \u001b[39mpage.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "/", waiting until "load"\n`,
];

function buildReport(def: SuiteDef, outcome: string, start: Date, rnd: () => number) {
  const cases = def.projects.flatMap((project) => def.tests.map((test) => ({ test, project })));
  const skippedIndex = def.tests.length > 6 ? 1 : -1;
  const pick = (n: number) => {
    const chosen = new Set<number>();
    while (chosen.size < Math.min(n, cases.length - 1)) {
      const i = Math.floor(rnd() * cases.length);
      if (i !== skippedIndex) chosen.add(i);
    }
    return chosen;
  };
  const failing = outcome === "F" ? pick(1 + Math.floor(rnd() * 3)) : new Set<number>();
  const flaky = outcome === "K" ? pick(1 + Math.floor(rnd() * 2)) : new Set<number>();
  let clock = start.getTime();
  const stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };

  const tests = cases.map(({ test, project }, i) => {
    const result = (status: string, retry: number, error?: string) => {
      const duration = status === "skipped" ? 0 : Math.round(800 + rnd() * 9000);
      const r = { workerIndex: i % 4, status, duration, retry, startTime: new Date(clock).toISOString(), errors: error ? [{ message: error }] : [], error: error ? { message: error } : undefined };
      clock += Math.round(duration / 4);
      return r;
    };
    const err = ERRORS[Math.floor(rnd() * ERRORS.length)]!(test);
    let status: string;
    let results;
    if (i === skippedIndex) {
      status = "skipped";
      results = [result("skipped", 0)];
    } else if (failing.has(i)) {
      status = "unexpected";
      results = [result("failed", 0, err), result("failed", 1, err), result(err.includes("TimeoutError") ? "timedOut" : "failed", 2, err)];
    } else if (flaky.has(i)) {
      status = "flaky";
      results = [result("failed", 0, err), result("passed", 1)];
    } else {
      status = "expected";
      results = [result("passed", 0)];
    }
    stats[status as keyof typeof stats]++;
    return { test, project, status, results };
  });

  const byFile = new Map<string, typeof tests>();
  for (const x of tests) byFile.set(x.test.file, [...(byFile.get(x.test.file) ?? []), x]);
  const suites = [...byFile.entries()].map(([file, list]) => ({
    title: file,
    file,
    specs: [],
    suites: [{
      title: list[0]!.test.describe,
      file,
      specs: [...new Set(list.map((x) => x.test.title))].map((title) => ({
        title,
        file,
        ok: list.filter((x) => x.test.title === title).every((x) => x.status !== "unexpected"),
        tests: list.filter((x) => x.test.title === title).map((x) => ({
          projectName: x.project,
          projectId: x.project,
          expectedStatus: x.status === "skipped" ? "skipped" : "passed",
          status: x.status,
          results: x.results,
        })),
      })),
    }],
  }));
  return { config: { version: "1.50.0" }, suites, errors: [], stats: { startTime: start.toISOString(), duration: clock - start.getTime() + 4000, ...stats } };
}

async function writeDevReport(runId: number, suite: string, summary: { passed: number; failed: number; flaky: number }) {
  const dir = reportDir(storageDir, runId);
  mkdirSync(join(dir, "data"), { recursive: true });
  await Bun.write(join(dir, "data", "summary.json"), JSON.stringify({ run: runId, suite, ...summary }));
  await Bun.write(
    join(dir, "data", "screenshot.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#efe7fd"/><text x="24" y="96" font-family="sans-serif" font-size="18" fill="#6d28d9">Screenshot (Dev-Seed)</text></svg>`,
  );
  await Bun.write(
    join(dir, "index.html"),
    `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><title>Playwright Test Report – ${suite} #${runId}</title>
<style>body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; color: #1c1a24; } img { border: 1px solid #e3e1ea; }</style></head>
<body>
<h1>Playwright Test Report</h1>
<p>Vom Dev-Seed erzeugter Platzhalter für Lauf #${runId} („${suite}“). Inline-Skript, fetch und Bild prüfen die CSP des Report-Origins.</p>
<p id="summary">Lade data/summary.json ...</p>
<img src="data/screenshot.svg" alt="Screenshot" width="320" height="180">
<script type="module">
const s = await (await fetch("data/summary.json")).json();
document.getElementById("summary").textContent = s.passed + " bestanden, " + s.failed + " fehlgeschlagen, " + s.flaky + " wackelig";
</script>
</body>
</html>
`,
  );
}

const tokens: Record<string, { suiteId: number; suite: string; environment: string; token: string }> = existsSync(TOKENS_FILE)
  ? JSON.parse(await Bun.file(TOKENS_FILE).text())
  : {};

for (const [index, def] of SUITES.entries()) {
  const [suite] = (await sql`
    insert into test_suites (environment_id, slug, name, description) values (${def.envId}, ${def.slug}, ${def.name}, ${def.description})
    on conflict (environment_id, slug) do update set name = excluded.name, description = excluded.description
    returning id`) as { id: number }[];
  const suiteId = suite!.id;

  let token = tokens[def.key]?.token;
  const valid = token
    ? ((await sql`select 1 from ingest_tokens where token_hash = ${sha256Hex(token)} and suite_id = ${suiteId} and revoked_at is null`) as unknown[]).length > 0
    : false;
  if (!token || !valid) {
    token = newToken("vti");
    await sql`insert into ingest_tokens (suite_id, name, token_hash, token_prefix) values (${suiteId}, 'dev-seed', ${sha256Hex(token)}, ${token.slice(0, 10)})`;
  }
  tokens[def.key] = { suiteId, suite: def.name, environment: def.envLabel, token };

  const [{ n }] = (await sql`select count(*)::int as n from test_runs where suite_id = ${suiteId}`) as [{ n: number }];
  if (n < RUNS_PER_SUITE) {
    const rnd = prng(4711 + index);
    const hash = sha256Hex(token);
    for (let i = 0; i < RUNS_PER_SUITE; i++) {
      const received = new Date(Date.now() - (RUNS_PER_SUITE - 1 - i) * 13 * 3600_000 - (1 + rnd() * 2) * 3600_000);
      const report = buildReport(def, def.pattern[i]!, new Date(received.getTime() - 4 * 60_000), rnd);
      const parsed = parsePlaywrightReport(report);
      const pipeline = 18_000 + index * 1000 + i * 7;
      const sha = Array.from({ length: 40 }, () => Math.floor(rnd() * 16).toString(16)).join("");
      const run = {
        ...parsed.run,
        commit_sha: sha,
        branch: def.branch,
        pipeline_url: `${def.gitlab}/-/pipelines/${pipeline}`,
        job_url: `${def.gitlab}/-/jobs/${pipeline * 3 + 1}`,
        has_report: def.reportRuns.includes(i),
      };
      const [row] = (await sql`select ingest_test_run(${hash}, ${run}::jsonb, ${parsed.cases}::jsonb) as id`) as { id: number }[];
      await sql`update test_runs set received_at = ${received} where id = ${row!.id}`;
    }
  }

  const withReports = (await sql`
    select id, passed, failed, flaky from test_runs where suite_id = ${suiteId} and has_report and not report_purged`) as { id: number; passed: number; failed: number; flaky: number }[];
  for (const r of withReports) {
    if (!existsSync(join(reportDir(storageDir, r.id), "index.html"))) await writeDevReport(r.id, def.name, r);
  }
}

await Bun.write(TOKENS_FILE, JSON.stringify(tokens, null, 2));
console.log(`seeded tests: ${SUITES.length} suites, tokens in ${TOKENS_FILE}`);
await sql.end();
