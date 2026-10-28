import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encryptString } from "../src/shared/crypto";
import { buildSmtpUrl, describeEsAuth, esAuthHeader, integrationFromEnv, isConfigured, parseSmtpUrl, senderProblem, urlProblem } from "../src/hub/modules/integrations/kinds";
import { esConnection, forgetIntegration, importIntegrationsFromEnv, initIntegrations, mailConnection, resolveIntegration } from "../src/hub/modules/integrations/store";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import { buildWorld, type World } from "./fixtures";

const SECRET = "integrations-test-secret-0123456789abcdef";
let db: TestDb;
let w: World;

beforeAll(async () => {
  db = await createHubTestDb();
  w = await buildWorld(db.owner);
  initIntegrations(db.hub, SECRET);
});
afterAll(() => db.drop());

describe("access", () => {
  beforeAll(async () => {
    await db.owner`insert into integrations (kind, config, secret_enc) values ('apm', ${{ url: "https://apm.example:9200" }}::jsonb, ${await encryptString(SECRET, "ApiKey c2VjcmV0")})`;
  });

  test("only admins see or change the table", async () => {
    expect(await asUser(db.hub, w.admin, (tx) => tx`select kind from integrations`)).toHaveLength(1);
    for (const user of [w.bobBergbauDiagnostics, w.staffNoGrants, null]) {
      expect(await asUser(db.hub, user, (tx) => tx`select kind from integrations`)).toHaveLength(0);
      expect(await asUser(db.hub, user, (tx) => tx`update integrations set config = '{}'::jsonb returning kind`)).toHaveLength(0);
    }
    const insert = asUser(db.hub, w.bobBergbauDiagnostics, (tx) => tx`insert into integrations (kind, config) values ('logs', '{}'::jsonb)`);
    await expect(insert).rejects.toThrow();
  });

  test("a customer's request still reaches the cluster, through integration_load only", async () => {
    forgetIntegration();
    expect(await esConnection("apm")).toEqual({ url: "https://apm.example:9200", auth: "ApiKey c2VjcmV0", ca: undefined });
    const [row] = (await asUser(db.hub, w.aliceNordwindShopOverview, (tx) => tx`select config from integration_load('apm')`)) as any[];
    expect(row.config.url).toBe("https://apm.example:9200");
  });

  test("the credential is stored encrypted", async () => {
    const [row] = (await db.owner`select secret_enc from integrations where kind = 'apm'`) as any[];
    expect(row.secret_enc).toStartWith("v1.");
    expect(row.secret_enc).not.toContain("c2VjcmV0");
  });
});

describe("environment variables are only the starting point", () => {
  const saved = { ...process.env };
  afterAll(() => {
    for (const k of ["LOGS_ES_URL", "LOGS_ES_AUTH", "SMTP_URL", "MAIL_FROM", "APM_ES_URL", "APM_ES_AUTH", "APM_ES_CA_FILE"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    forgetIntegration();
  });

  test("the worker takes them over once and never overwrites a saved row", async () => {
    process.env.LOGS_ES_URL = "https://logs.example/es";
    process.env.LOGS_ES_AUTH = "Basic dmFudGFnZTpwdw==";
    process.env.SMTP_URL = "smtp://relay.example:25";
    process.env.MAIL_FROM = "Vantage <vantage@example.test>";
    process.env.APM_ES_URL = "https://other.example:9200";
    delete process.env.APM_ES_CA_FILE;

    expect((await importIntegrationsFromEnv(db.worker, SECRET)).sort()).toEqual(["logs", "mail"]);
    expect(await importIntegrationsFromEnv(db.worker, SECRET)).toEqual([]);
    forgetIntegration();
    expect((await esConnection("logs"))?.auth).toBe("Basic dmFudGFnZTpwdw==");
    expect((await esConnection("apm"))?.url).toBe("https://apm.example:9200");
    expect(await mailConnection()).toEqual({ smtpUrl: "smtp://relay.example:25", from: "Vantage <vantage@example.test>" });
  });

  test("an emptied row means not connected, even with the variables still set", async () => {
    await db.owner`update integrations set config = '{}'::jsonb, secret_enc = null where kind = 'logs'`;
    forgetIntegration();
    const r = await resolveIntegration("logs");
    expect(r.source).toBe("vantage");
    expect(isConfigured("logs", r.row)).toBe(false);
    expect(await esConnection("logs")).toBeNull();
  });

  test("without a row the variables apply directly", () => {
    process.env.APM_ES_URL = "https://apm.example:9200";
    process.env.APM_ES_AUTH = "ApiKey c2VjcmV0";
    expect(integrationFromEnv("apm")).toEqual({ config: { url: "https://apm.example:9200" }, secret: "ApiKey c2VjcmV0" });
    expect(integrationFromEnv("wazuh")).toBeNull();
  });
});

describe("form values", () => {
  test("Elasticsearch logins become the Authorization header", () => {
    expect(esAuthHeader({ mode: "basic", user: "vantage", password: "pw", apiKey: "" }).header).toBe(`Basic ${Buffer.from("vantage:pw").toString("base64")}`);
    expect(esAuthHeader({ mode: "apikey", user: "", password: "", apiKey: "id123:key456" }).header).toBe(`ApiKey ${Buffer.from("id123:key456").toString("base64")}`);
    expect(esAuthHeader({ mode: "apikey", user: "", password: "", apiKey: "ApiKey aWQxMjM6a2V5NDU2" }).header).toBe("ApiKey aWQxMjM6a2V5NDU2");
    expect(esAuthHeader({ mode: "none", user: "", password: "", apiKey: "" })).toEqual({ header: null, problem: null });
    expect(esAuthHeader({ mode: "basic", user: "a:b", password: "pw", apiKey: "" }).problem).toBeTruthy();
    expect(describeEsAuth(`Basic ${Buffer.from("vantage:pw").toString("base64")}`)).toBe("Benutzer vantage");
    expect(describeEsAuth("ApiKey abc")).toBe("API-Key");
  });

  test("URLs carry no credentials or parameters", () => {
    expect(urlProblem("https://logs.example/es")).toBeNull();
    expect(urlProblem("https://user:pw@logs.example")).toContain("Zugangsdaten");
    expect(urlProblem("ftp://logs.example")).toBeTruthy();
    expect(urlProblem("https://logs.example/?x=1")).toBeTruthy();
  });

  test("the SMTP URL keeps Postal's user name with a slash intact", () => {
    const prod = "smtp://acme%2Facme-mail:p%40ss@relay.example.com:25?authMethod=CRAM-MD5";
    const parts = parseSmtpUrl(prod)!;
    expect(parts).toEqual({ host: "relay.example.com", port: "25", user: "acme/acme-mail", password: "p@ss", security: "none", authMethod: "CRAM-MD5" });
    expect(parseSmtpUrl(buildSmtpUrl(parts))).toEqual(parts);
    expect(parseSmtpUrl(buildSmtpUrl({ ...parts, security: "starttls", port: "587" }))?.security).toBe("starttls");
    expect(buildSmtpUrl({ ...parts, security: "tls", port: "465" })).toStartWith("smtps://");
  });

  test("senders", () => {
    expect(senderProblem("Vantage <vantage@systaro.de>")).toBeNull();
    expect(senderProblem("vantage@systaro.de")).toBeNull();
    expect(senderProblem("Vantage <vantage@localhost>")).toBeNull();
    expect(senderProblem("Vantage")).toBeTruthy();
    expect(senderProblem("<vantage@systaro.de")).toBeTruthy();
  });
});
