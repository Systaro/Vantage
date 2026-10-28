/**
 * The OpenID Connect side of the Cortex login: discovery, the authorization request with PKCE,
 * the code exchange and the ID token check. No library: Cortex signs with RS256, which WebCrypto
 * verifies, and every check OIDC Core 3.1.3.7 asks of a client is spelled out here. No database
 * access, so the worker's connection check can use it too.
 */
import { createHash, randomBytes } from "node:crypto";
import type { OidcConnection } from "../integrations/kinds";

const TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_SECONDS = 60;
/** Vantage skips its own TOTP step only when the code was typed into Cortex this recently. */
export const CORTEX_CODE_MAX_AGE_SECONDS = 12 * 3600;
export const CORTEX_SCOPES = "openid profile";

export class OidcError extends Error {}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** What Vantage takes from a verified ID token. */
export interface CortexIdentity {
  /** Cortex's `user_id`: never given to another account, unlike `sub` (the username). */
  userId: string;
  username: string;
  amr: string[];
  authTime: number | null;
}

const discoveries = new Map<string, { at: number; value: Promise<Discovery> }>();
const keySets = new Map<string, Promise<JsonWebKey[]>>();

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  } catch (err) {
    throw new OidcError(`Cortex ist nicht erreichbar (${(err as Error).message}).`);
  }
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new OidcError(`Cortex antwortet unter ${new URL(url).pathname} nicht mit JSON (HTTP ${res.status}).`);
  }
}

function endpoint(value: unknown, issuer: string, name: string): string {
  let u: URL;
  try {
    u = new URL(String(value));
  } catch {
    throw new OidcError(`Die Discovery von Cortex nennt keinen gültigen ${name}.`);
  }
  if (u.protocol !== new URL(issuer).protocol) throw new OidcError(`Der ${name} von Cortex nutzt ein anderes Protokoll als die Cortex-Adresse.`);
  return u.toString();
}

async function loadDiscovery(issuer: string): Promise<Discovery> {
  const { status, body } = await fetchJson(`${issuer}/.well-known/openid-configuration`);
  if (status !== 200) throw new OidcError(`Cortex liefert keine OpenID-Konfiguration (HTTP ${status}).`);
  // OIDC Discovery 4.3: the document must name exactly the issuer it was fetched for.
  if (body.issuer !== issuer) throw new OidcError(`Cortex meldet sich als „${String(body.issuer)}“, eingetragen ist „${issuer}“.`);
  return {
    issuer,
    authorization_endpoint: endpoint(body.authorization_endpoint, issuer, "Anmelde-Endpunkt"),
    token_endpoint: endpoint(body.token_endpoint, issuer, "Token-Endpunkt"),
    jwks_uri: endpoint(body.jwks_uri, issuer, "Schlüssel-Endpunkt"),
  };
}

export function discover(issuer: string): Promise<Discovery> {
  const hit = discoveries.get(issuer);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.value;
  const value = loadDiscovery(issuer);
  discoveries.set(issuer, { at: Date.now(), value });
  value.catch(() => discoveries.delete(issuer));
  return value;
}

async function loadKeys(jwksUri: string): Promise<JsonWebKey[]> {
  const { status, body } = await fetchJson(jwksUri);
  if (status !== 200 || !Array.isArray(body.keys)) throw new OidcError(`Cortex liefert keine Signaturschlüssel (HTTP ${status}).`);
  const keys = (body.keys as any[]).filter((k) => k?.kty === "RSA" && (!k.use || k.use === "sig") && (!k.alg || k.alg === "RS256"));
  if (keys.length === 0) throw new OidcError("Cortex veröffentlicht keinen RS256-Schlüssel.");
  return keys;
}

/** The signing keys, cached; `fresh` fetches them again (Cortex may have a new key under the same id). */
export function signingKeys(jwksUri: string, fresh = false): Promise<JsonWebKey[]> {
  const hit = keySets.get(jwksUri);
  if (hit && !fresh) return hit;
  const value = loadKeys(jwksUri);
  keySets.set(jwksUri, value);
  value.catch(() => keySets.delete(jwksUri));
  return value;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** Per flow: what the browser carries to Cortex (state, nonce, challenge) and back (the verifier stays with Vantage's cookie). */
export function newFlowSecrets() {
  const verifier = b64url(randomBytes(32));
  return { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function authorizeUrl(d: Discovery, conn: OidcConnection, p: { redirectUri: string; state: string; nonce: string; challenge: string }): string {
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: conn.clientId,
    redirect_uri: p.redirectUri,
    scope: CORTEX_SCOPES,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

/** RFC 6749 2.3.1: id and secret are form-encoded before they go into the Basic header. */
function basicAuth(conn: OidcConnection): string {
  const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");
  return `Basic ${Buffer.from(`${enc(conn.clientId)}:${enc(conn.clientSecret)}`).toString("base64")}`;
}

function tokenRequest(d: Discovery, conn: OidcConnection, params: Record<string, string>) {
  return fetchJson(d.token_endpoint, {
    method: "POST",
    headers: { authorization: basicAuth(conn), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
}

export async function exchangeCode(d: Discovery, conn: OidcConnection, p: { code: string; verifier: string; redirectUri: string }): Promise<string> {
  const { status, body } = await tokenRequest(d, conn, { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
  if (status === 401 || body?.error === "invalid_client") throw new OidcError("Cortex lehnt Client-ID oder Secret ab.");
  if (status !== 200) throw new OidcError(`Cortex hat die Anmeldung nicht bestätigt (${String(body?.error ?? `HTTP ${status}`)}).`);
  if (typeof body.id_token !== "string") throw new OidcError("Cortex hat kein ID-Token geschickt.");
  return body.id_token;
}

function decodePart(part: string | undefined): any {
  try {
    return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));
  } catch {
    throw new OidcError("Das ID-Token von Cortex ist beschädigt.");
  }
}

async function signedBy(keys: JsonWebKey[], kid: string | undefined, data: Uint8Array<ArrayBuffer>, signature: Uint8Array<ArrayBuffer>): Promise<boolean> {
  for (const jwk of keys.filter((k) => !kid || !(k as any).kid || (k as any).kid === kid)) {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data)) return true;
  }
  return false;
}

/** Signature, issuer, audience, lifetime and nonce; then the claims Vantage needs. */
export async function verifyIdToken(token: string, d: Discovery, conn: OidcConnection, nonce: string, now = Date.now() / 1000): Promise<CortexIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("Das ID-Token von Cortex ist beschädigt.");
  const header = decodePart(parts[0]);
  if (header.alg !== "RS256") throw new OidcError(`Das ID-Token ist mit „${String(header.alg)}“ signiert, erwartet ist RS256.`);
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = new Uint8Array(Buffer.from(parts[2]!, "base64url"));
  const valid = (await signedBy(await signingKeys(d.jwks_uri), header.kid, data, signature))
    || (await signedBy(await signingKeys(d.jwks_uri, true), header.kid, data, signature));
  if (!valid) throw new OidcError("Die Signatur des ID-Tokens passt zu keinem Schlüssel von Cortex.");

  const claims = decodePart(parts[1]);
  const aud: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== conn.issuer) throw new OidcError("Das ID-Token kommt von einem anderen Aussteller.");
  if (!aud.includes(conn.clientId) || (aud.length > 1 && claims.azp !== conn.clientId)) throw new OidcError("Das ID-Token ist für eine andere Anwendung ausgestellt.");
  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SECONDS) throw new OidcError("Das ID-Token ist abgelaufen.");
  if (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_SECONDS) throw new OidcError("Das ID-Token ist in der Zukunft ausgestellt; stimmt die Uhr des Servers?");
  if (typeof claims.nonce !== "string" || claims.nonce !== nonce) throw new OidcError("Das ID-Token gehört nicht zu dieser Anmeldung.");
  if (claims.user_id === undefined || claims.user_id === null || String(claims.user_id) === "") {
    throw new OidcError("Cortex schickt noch keine feste Benutzerkennung (user_id). Ohne sie verknüpft Vantage kein Konto.");
  }
  return {
    userId: String(claims.user_id),
    username: String(claims.preferred_username ?? claims.sub ?? ""),
    amr: Array.isArray(claims.amr) ? claims.amr.map(String) : [],
    authTime: typeof claims.auth_time === "number" ? claims.auth_time : null,
  };
}

/** Whether the authenticator code was typed into Cortex for this session, recently enough to count here. */
export function cortexCheckedCode(id: CortexIdentity, now = Date.now() / 1000): boolean {
  if (!id.amr.includes("otp") || id.authTime === null) return false;
  return id.authTime <= now + CLOCK_SKEW_SECONDS && now - id.authTime <= CORTEX_CODE_MAX_AGE_SECONDS;
}

/**
 * „Verbindung testen“: discovery, keys, and a code exchange with a code that cannot exist. Cortex
 * checks the client first, so a known client gets invalid_grant and a wrong secret invalid_client.
 */
export async function checkCortex(conn: OidcConnection): Promise<string> {
  const d = await loadDiscovery(conn.issuer);
  discoveries.set(conn.issuer, { at: Date.now(), value: Promise.resolve(d) });
  const keys = await signingKeys(d.jwks_uri, true);
  const { status, body } = await tokenRequest(d, conn, { grant_type: "authorization_code", code: "vantage-connection-check", redirect_uri: `${conn.issuer}/` });
  if (status === 401 || body?.error === "invalid_client") throw new OidcError("Cortex lehnt Client-ID oder Secret ab.");
  if (body?.error !== "invalid_grant") throw new OidcError(`Unerwartete Antwort des Token-Endpunkts: ${String(body?.error ?? `HTTP ${status}`)}.`);
  return `Verbindung steht: Cortex kennt den Client, ${keys.length === 1 ? "1 Signaturschlüssel" : `${keys.length} Signaturschlüssel`}.`;
}
