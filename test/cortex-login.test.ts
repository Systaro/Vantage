import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { buildWorld, type World } from "./fixtures";
import { asUser, createHubTestDb, type TestDb } from "./helpers/db";
import {
  authorizeUrl,
  checkCortex,
  cortexCheckedCode,
  discover,
  exchangeCode,
  newFlowSecrets,
  OidcError,
  verifyIdToken,
  type CortexIdentity,
} from "../src/hub/modules/cortex/oidc";
import type { OidcConnection } from "../src/hub/modules/integrations/kinds";
import { issuerProblem } from "../src/hub/modules/integrations/kinds";

// ── A Cortex stand-in: discovery, JWKS, token endpoint; the signing key can be swapped under the same kid ──

type KeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };
const newKey = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<KeyPair>;

let server: Server<undefined>;
let issuer: string;
let key: KeyPair;
let tokenAnswer: { status: number; body: unknown } = { status: 400, body: { error: "invalid_grant" } };
const tokenRequests: { auth: string | null; form: URLSearchParams }[] = [];
const conn = (): OidcConnection => ({ issuer, clientId: "sso_vantage", clientSecret: "s3cret" });

const b64 = (v: object | Uint8Array) => Buffer.from(v instanceof Uint8Array ? v : JSON.stringify(v)).toString("base64url");
async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "cortex-sso" }, signer = key): Promise<string> {
  const data = `${b64(header)}.${b64(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer.privateKey, new TextEncoder().encode(data)));
  return `${data}.${b64(sig)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  iss: issuer, aud: "sso_vantage", sub: "anna", exp: now() + 300, iat: now(), nonce: "n-1",
  user_id: 42, preferred_username: "anna", amr: ["otp", "mfa"], auth_time: now() - 60, ...over,
});

beforeAll(async () => {
  key = await newKey();
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/.well-known/openid-configuration") {
        return Response.json({ issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`, jwks_uri: `${issuer}/oauth2/jwks` });
      }
      if (path === "/oauth2/jwks") {
        const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
        return Response.json({ keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid: "cortex-sso", use: "sig", alg: "RS256" }] });
      }
      if (path === "/oauth2/token") {
        tokenRequests.push({ auth: req.headers.get("authorization"), form: new URLSearchParams(await req.text()) });
        return Response.json(tokenAnswer.body, { status: tokenAnswer.status });
      }
      return new Response("not found", { status: 404 });
    },
  });
  issuer = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

describe("ID token check", () => {
  test("a token from Cortex for Vantage, with the nonce of this login, gives the identity", async () => {
    const d = await discover(issuer);
    const id = await verifyIdToken(await sign(claims()), d, conn(), "n-1");
    expect(id).toEqual({ userId: "42", username: "anna", amr: ["otp", "mfa"], authTime: expect.any(Number) });
  });

  test("issuer, audience, lifetime, nonce and algorithm are each enforced", async () => {
    const d = await discover(issuer);
    const refused = async (token: string, nonce = "n-1") => {
      const err = await verifyIdToken(token, d, conn(), nonce).catch((e) => e);
      expect(err).toBeInstanceOf(OidcError);
      return (err as Error).message;
    };
    expect(await refused(await sign(claims({ iss: "https://evil.example" })))).toContain("Aussteller");
    expect(await refused(await sign(claims({ aud: "sso_other" })))).toContain("andere Anwendung");
    expect(await refused(await sign(claims({ aud: ["sso_vantage", "sso_other"] })))).toContain("andere Anwendung");
    expect(await refused(await sign(claims({ exp: now() - 3600 })))).toContain("abgelaufen");
    expect(await refused(await sign(claims()), "n-2")).toContain("nicht zu dieser Anmeldung");
    expect(await refused(await sign(claims(), { alg: "HS256", kid: "cortex-sso" }))).toContain("RS256");
    expect(await refused(await sign(claims(), undefined, await newKey()))).toContain("Signatur");
    const unsigned = `${b64({ alg: "none" })}.${b64(claims())}.`;
    expect(await refused(unsigned)).toContain("RS256");
  });

  test("without Cortex's user_id no account is linked or opened", async () => {
    const d = await discover(issuer);
    const err = await verifyIdToken(await sign(claims({ user_id: undefined })), d, conn(), "n-1").catch((e) => e);
    expect((err as Error).message).toContain("user_id");
  });

  test("a new signing key under the same key id (Cortex restarted) is fetched again, not refused", async () => {
    const d = await discover(issuer);
    await verifyIdToken(await sign(claims()), d, conn(), "n-1");
    key = await newKey();
    const id = await verifyIdToken(await sign(claims()), d, conn(), "n-1");
    expect(id.userId).toBe("42");
  });
});

describe("second factor", () => {
  const id = (amr: string[], authTime: number | null): CortexIdentity => ({ userId: "1", username: "anna", amr, authTime });

  test("only a code typed into Cortex within 12 hours replaces Vantage's own", () => {
    expect(cortexCheckedCode(id(["otp", "mfa"], now() - 3600))).toBe(true);
    expect(cortexCheckedCode(id(["otp", "mfa"], now() - 13 * 3600))).toBe(false);
    expect(cortexCheckedCode(id(["otp", "mfa"], null))).toBe(false);
    expect(cortexCheckedCode(id(["otp", "mfa"], now() + 3600))).toBe(false);
    // A remembered browser, a password, Microsoft or a sign-in link: Vantage asks for its code.
    expect(cortexCheckedCode(id(["pwd", "swk", "mfa"], now()))).toBe(false);
    expect(cortexCheckedCode(id(["pwd"], now()))).toBe(false);
    expect(cortexCheckedCode(id(["fed"], now()))).toBe(false);
    expect(cortexCheckedCode(id([], now()))).toBe(false);
  });
});

describe("the round trip", () => {
  test("the authorization request carries state, nonce and an S256 challenge of the verifier", async () => {
    const s = newFlowSecrets();
    const url = new URL(authorizeUrl(await discover(issuer), conn(), { redirectUri: "https://vantage.example/login/cortex/callback", state: s.state, nonce: s.nonce, challenge: s.challenge }));
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code", client_id: "sso_vantage", redirect_uri: "https://vantage.example/login/cortex/callback",
      scope: "openid profile", state: s.state, nonce: s.nonce, code_challenge: s.challenge, code_challenge_method: "S256",
    });
    expect(s.challenge).toBe(new Bun.CryptoHasher("sha256").update(s.verifier).digest("base64url"));
    expect(newFlowSecrets().state).not.toBe(s.state);
  });

  test("the code exchange authenticates the client and sends the verifier", async () => {
    tokenAnswer = { status: 200, body: { id_token: "x.y.z", access_token: "a", token_type: "Bearer" } };
    const token = await exchangeCode(await discover(issuer), conn(), { code: "c-1", verifier: "v-1", redirectUri: "https://vantage.example/cb" });
    expect(token).toBe("x.y.z");
    const sent = tokenRequests.at(-1)!;
    expect(sent.auth).toBe(`Basic ${Buffer.from("sso_vantage:s3cret").toString("base64")}`);
    expect(Object.fromEntries(sent.form)).toEqual({ grant_type: "authorization_code", code: "c-1", redirect_uri: "https://vantage.example/cb", code_verifier: "v-1" });

    tokenAnswer = { status: 401, body: { error: "invalid_client" } };
    expect((await exchangeCode(await discover(issuer), conn(), { code: "c", verifier: "v", redirectUri: "r" }).catch((e) => e)).message).toContain("Secret");
  });

  test("the connection check tells a known client from a wrong secret", async () => {
    tokenAnswer = { status: 400, body: { error: "invalid_grant" } };
    expect(await checkCortex(conn())).toContain("Cortex kennt den Client");
    tokenAnswer = { status: 401, body: { error: "invalid_client" } };
    expect((await checkCortex(conn()).catch((e) => e)).message).toContain("lehnt Client-ID oder Secret ab");
    expect((await checkCortex({ ...conn(), issuer: `${issuer}/other` }).catch((e) => e))).toBeInstanceOf(OidcError);
  });

  test("the issuer is the plain https address", () => {
    expect(issuerProblem("https://cortex.example.com")).toBeNull();
    expect(issuerProblem("https://cortex.example.com/")).toContain("/");
    expect(issuerProblem("http://cortex.example.com")).toContain("https");
    expect(issuerProblem("http://localhost:7040")).toBeNull();
  });
});

// ── Links in the database ─────────────────────────────────────────────────────────────────────────

describe("links", () => {
  let db: TestDb;
  let w: World;
  const ISS = "https://cortex.example";
  const link = (userId: number, cortexId: string, name = "anna") =>
    asUser(db.hub, userId, async (tx) => ((await tx`select account_link_cortex(${ISS}, ${cortexId}, ${name}) as r`) as { r: string }[])[0]!.r);
  const loginFor = async (cortexId: string) => ((await db.hub`select * from auth_user_for_cortex(${ISS}, ${cortexId})`) as { id: number }[])[0]?.id ?? null;

  beforeAll(async () => {
    db = await createHubTestDb();
    w = await buildWorld(db.owner);
    // A login only opens an account that is fully set up.
    await db.owner`update users set password_hash = 'x', totp_secret_enc = 'y'`;
  });
  afterAll(() => db.drop());

  test("staff link their own account; a Cortex account belongs to one Vantage account", async () => {
    expect(await link(w.staffNoGrants, "42")).toBe("ok");
    expect(await loginFor("42")).toBe(w.staffNoGrants);
    expect(await link(w.admin, "42")).toBe("taken");
    expect(await link(w.staffNoGrants, "42", "anna.neu")).toBe("ok");
    expect(await link(w.aliceNordwindShopOverview, "77")).toBe("not_staff");
    expect(await loginFor("77")).toBeNull();
  });

  test("everyone sees only their own link, admins all; nobody writes the table directly", async () => {
    await link(w.admin, "1");
    const seen = (userId: number) => asUser(db.hub, userId, (tx) => tx`select user_id from cortex_links order by user_id`) as Promise<{ user_id: number }[]>;
    expect((await seen(w.staffNoGrants)).map((r) => r.user_id)).toEqual([w.staffNoGrants]);
    expect((await seen(w.admin)).length).toBe(2);
    expect((await seen(w.bobBergbauDiagnostics)).length).toBe(0);
    await expect(asUser(db.hub, w.staffNoGrants, (tx) => tx`insert into cortex_links (user_id, issuer, cortex_user_id, cortex_username) values (${w.staffNoGrants}, ${ISS}, '9', 'x')`)).rejects.toThrow();
    const gone = await asUser(db.hub, w.staffNoGrants, (tx) => tx`delete from cortex_links where user_id = ${w.admin} returning user_id`);
    expect(gone.length).toBe(0);
  });

  test("a locked account, a customer or a reset account does not open through Cortex", async () => {
    await db.owner`update users set disabled_at = now() where id = ${w.staffNoGrants}`;
    expect(await loginFor("42")).toBeNull();
    await db.owner`update users set disabled_at = null where id = ${w.staffNoGrants}`;
    expect(await loginFor("42")).toBe(w.staffNoGrants);

    await db.owner`update users set kind = 'customer' where id = ${w.staffNoGrants}`;
    expect(await loginFor("42")).toBeNull();
    await db.owner`update users set kind = 'staff' where id = ${w.staffNoGrants}`;

    await asUser(db.hub, w.admin, (tx) => tx`select admin_reset_user(${w.staffNoGrants})`);
    expect(await loginFor("42")).toBeNull();
    expect((await db.owner`select 1 from cortex_links where user_id = ${w.staffNoGrants}`).length).toBe(0);
  });
});
