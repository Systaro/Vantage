import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { berlinToday, compareRefs, DEFAULTS, judgeLogs, judgeMaintenance, judgeRecord, judgeServers, judgeTls, judgeUptime, judgeVulns } from "../src/hub/modules/isms/judge";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

let db: TestDb;
let w: World;

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
});
afterAll(() => db.drop());

describe("ISMS controls under RLS", () => {
  let shopControl: number;
  let mineControl: number;

  beforeAll(async () => {
    const insert = (project: number, env: number | null, ref: string, kind: string) =>
      db.owner`insert into isms_controls (project_id, environment_id, ref, title, kind) values (${project}, ${env}, ${ref}, ${`Kontrolle ${ref}`}, ${kind}) returning id`;
    shopControl = ((await insert(w.projects.shop, w.envs.shopProd, "A.8.16", "uptime")) as { id: number }[])[0]!.id;
    mineControl = ((await insert(w.projects.mine, null, "A.8.13", "record")) as { id: number }[])[0]!.id;
    await db.owner`insert into isms_records (control_id, done_on, result) values (${mineControl}, '2026-11-01', 'passed')`;
  });

  test("a project's controls and records are visible to whoever sees the project, and to no one else", async () => {
    const refs = async (user: number) => ((await asUser(db.hub, user, (tx) => tx`select ref from isms_controls order by ref`)) as { ref: string }[]).map((r) => r.ref);
    expect(await refs(w.aliceNordwindShopOverview)).toEqual(["A.8.16"]);
    expect(await refs(w.carolStageOnly)).toEqual(["A.8.16"]);
    expect(await refs(w.bobBergbauDiagnostics)).toEqual(["A.8.13"]);
    expect(await refs(w.staffNoGrants)).toEqual([]);
    expect(await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select id from isms_records`)).toHaveLength(0);
    expect(await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`select id from isms_records`)).toHaveLength(1);
  });

  test("only admins add or delete controls and records", async () => {
    await expect(asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`
      insert into isms_controls (project_id, ref, title, kind) values (${w.projects.mine}, 'X', 'x', 'record')`)).rejects.toThrow();
    await expect(asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`
      insert into isms_records (control_id, done_on, result) values (${mineControl}, '2026-11-02', 'passed')`)).rejects.toThrow();
    expect(await asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`delete from isms_controls where id = ${mineControl} returning id`)).toHaveLength(0);
    const added = await asUser(db.hub, w.admin, (tx) => tx`
      insert into isms_records (control_id, done_on, result) values (${mineControl}, '2026-11-02', 'deviation') returning id`);
    expect(added).toHaveLength(1);
  });

  test("a check on data needs an environment of the same project", async () => {
    await expect(asUser(db.hub, w.admin, (tx) => tx`
      insert into isms_controls (project_id, environment_id, ref, title, kind) values (${w.projects.shop}, ${w.envs.mineProd}, 'A.8.6', 'Server', 'servers')`)).rejects.toThrow(/does not belong/);
    await expect(asUser(db.hub, w.admin, (tx) => tx`
      insert into isms_controls (project_id, ref, title, kind) values (${w.projects.shop}, 'A.8.6', 'Server', 'servers')`)).rejects.toThrow();
  });

  test("vulnerability and maintenance checks are accepted kinds, still bound to an environment", async () => {
    for (const kind of ["vulns", "maintenance"]) {
      expect(await asUser(db.hub, w.admin, (tx) => tx`
        insert into isms_controls (project_id, environment_id, ref, title, kind) values (${w.projects.shop}, ${w.envs.shopProd}, 'A.8.8', 'x', ${kind}) returning id`)).toHaveLength(1);
      await expect(asUser(db.hub, w.admin, (tx) => tx`
        insert into isms_controls (project_id, ref, title, kind) values (${w.projects.shop}, 'A.8.8', 'x', ${kind})`)).rejects.toThrow();
    }
    await expect(asUser(db.hub, w.admin, (tx) => tx`
      insert into isms_controls (project_id, environment_id, ref, title, kind) values (${w.projects.shop}, ${w.envs.shopProd}, 'A.8.8', 'x', 'patches')`)).rejects.toThrow();
    await db.owner`delete from isms_controls where ref = 'A.8.8'`;
  });

  test("deleting a control takes its records along", async () => {
    await asUser(db.hub, w.admin, (tx) => tx`delete from isms_controls where id = ${mineControl}`);
    expect(await db.owner`select id from isms_records where control_id = ${mineControl}`).toHaveLength(0);
    expect(await db.owner`select id from isms_controls where id = ${shopControl}`).toHaveLength(1);
  });
});

describe("ISMS verdicts", () => {
  test("vulnerabilities: past the deadline is a deviation, open within it a hint", () => {
    const p = DEFAULTS.vulns;
    const base = { mapped: true, synced: 1, groups: [], problems: [] };
    expect(judgeVulns({ ...base, mapped: false }, p, "2026-11-10")).toMatchObject({ status: "unknown", value: "Keine Schwachstellen-Quelle zugeordnet" });
    expect(judgeVulns({ ...base, synced: 0 }, p, "2026-11-10").status).toBe("unknown");
    expect(judgeVulns(base, p, "2026-11-10")).toMatchObject({ status: "ok", value: "Keine offenen kritischen oder hohen" });
    expect(judgeVulns({ ...base, problems: ["SBOM von api älter als 30 Tage"] }, p, "2026-11-10").status).toBe("warn");
    const fresh = { ...base, groups: [{ severity: "critical" as const, day: "2026-11-05", n: 2 }, { severity: "high" as const, day: "2026-10-20", n: 3 }] };
    expect(judgeVulns(fresh, p, "2026-11-10")).toMatchObject({ status: "warn", value: "Offen: 2 kritisch, 3 hoch, in der Frist" });
    expect(judgeVulns(fresh, p, "2026-11-13")).toMatchObject({ status: "deviation", value: "Über der Frist: 2 kritisch" });
    expect(judgeVulns(fresh, p, "2026-11-25")).toMatchObject({ status: "deviation", value: "Über der Frist: 2 kritisch, 3 hoch", detail: "älteste offen seit 36 Tagen; Frist kritisch 7 Tage, hoch 31 Tage" });
  });

  test("maintenance: every server needs a recent run that went through", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const p = DEFAULTS.maintenance;
    const run = (host: string, at: string | null, failed = false) => ({ host, last_at: at, last_failed: at ? failed : null });
    expect(judgeMaintenance(null, p, now).status).toBe("unknown");
    expect(judgeMaintenance([run("app", "2026-11-10T03:00:00Z"), run("db", "2026-11-02T03:00:00Z")], p, now)).toMatchObject({ status: "ok", value: "2 Server, alle in den letzten 9 Tagen gewartet" });
    expect(judgeMaintenance([run("app", "2026-11-10T03:00:00Z")], p, now).value).toBe("1 Server, alle heute gewartet");
    expect(judgeMaintenance([run("app", "2026-11-10T03:00:00Z", true)], p, now)).toMatchObject({ status: "deviation", value: "Letzter Lauf fehlgeschlagen: app" });
    expect(judgeMaintenance([run("app", null)], p, now).value).toBe("Noch kein Lauf: app");
    expect(judgeMaintenance([run("app", "2026-09-01T03:00:00Z")], { max_age_days: 31, template: "Patch" }, now)).toMatchObject({
      status: "deviation", value: "Zu lange kein Lauf: app", detail: "Ziel: höchstens 31 Tage zwischen zwei Läufen, Vorlage „Patch“",
    });
  });

  test("uptime: the weakest monitor decides", () => {
    expect(judgeUptime([], { min_percent: 99.5 }).status).toBe("unknown");
    expect(judgeUptime([{ name: "API", percent: 99.9 }, { name: "Web", percent: 99.7 }], { min_percent: 99.5 })).toMatchObject({ status: "ok", value: "99,70 % in 30 Tagen" });
    expect(judgeUptime([{ name: "API", percent: 99.9 }, { name: "Web", percent: 98.1 }], { min_percent: 99.5 }).status).toBe("deviation");
  });

  test("certificates: the one that runs out first decides", () => {
    expect(judgeTls([{ name: "API", days_left: null }], { min_days: 14 }).status).toBe("unknown");
    expect(judgeTls([{ name: "API", days_left: 60 }, { name: "Web", days_left: 20 }], { min_days: 14 })).toMatchObject({ status: "ok", value: "Das nächste läuft in 20 Tagen ab" });
    expect(judgeTls([{ name: "API", days_left: 9 }], { min_days: 14 }).status).toBe("deviation");
    expect(judgeTls([{ name: "API", days_left: -1 }], { min_days: 14 }).value).toBe("Ein Zertifikat ist abgelaufen");
  });

  test("servers: silent or critical is a deviation, a warning a hint", () => {
    const check = (severity: "ok" | "warning" | "critical") => ({ label: "Platte /", severity, detail: "91 %" });
    expect(judgeServers([]).status).toBe("unknown");
    expect(judgeServers([{ name: "app", enabled: true, stale: true, checks: [] }]).status).toBe("deviation");
    expect(judgeServers([{ name: "app", enabled: true, stale: false, checks: [check("critical")] }]).status).toBe("deviation");
    expect(judgeServers([{ name: "app", enabled: true, stale: false, checks: [check("warning")] }]).status).toBe("warn");
    expect(judgeServers([{ name: "app", enabled: true, stale: false, checks: [check("ok"), check("ok")] }])).toMatchObject({ status: "ok", value: "1 Server, alle 2 Prüfungen in Ordnung" });
  });

  test("logs: they must keep coming and must not be kept too long", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    const hours = (h: number) => now - h * 3_600_000;
    const p = { retention_days: 90, max_silence_hours: 24 };
    expect(judgeLogs(null, p, now).status).toBe("unknown");
    expect(judgeLogs({ newest: null, oldest: null }, p, now).status).toBe("deviation");
    expect(judgeLogs({ newest: hours(30), oldest: hours(24 * 10) }, p, now).status).toBe("deviation");
    expect(judgeLogs({ newest: hours(1), oldest: hours(24 * 95) }, p, now).status).toBe("deviation");
    expect(judgeLogs({ newest: hours(1), oldest: hours(24 * 92) }, p, now).status).toBe("ok");
    expect(judgeLogs({ newest: hours(1), oldest: hours(24 * 10) }, p, now).detail).toBe("Aufbewahrung 90 Tage; die Sammlung reicht bisher 10 Tage zurück");
  });

  test("records: periodic ones fall due, one-time ones stay done", () => {
    const today = "2026-11-09";
    expect(judgeRecord(null, { interval_days: 183 }, today).status).toBe("due");
    expect(judgeRecord(null, { interval_days: null }, today).status).toBe("open");
    expect(judgeRecord({ done_on: "2026-01-02", result: "passed" }, { interval_days: null }, today)).toMatchObject({ status: "ok", value: "Umgesetzt am 02.01.2026" });
    expect(judgeRecord({ done_on: "2026-10-01", result: "passed" }, { interval_days: 183 }, today)).toMatchObject({ status: "ok", detail: "nächster bis 02.04.2027" });
    expect(judgeRecord({ done_on: "2026-10-01", result: "passed" }, { interval_days: 31 }, today)).toMatchObject({ status: "due", value: "Fällig seit 8 Tagen" });
    expect(judgeRecord({ done_on: "2026-11-08", result: "deviation" }, { interval_days: 31 }, today).status).toBe("deviation");
  });

  test("refs sort like the ISO annex, today is Berlin's", () => {
    expect(["A.8.13", "A.5.18", "A.8.7"].sort(compareRefs)).toEqual(["A.5.18", "A.8.7", "A.8.13"]);
    expect(berlinToday(Date.parse("2026-11-09T23:30:00Z"))).toBe("2026-11-10");
  });
});
