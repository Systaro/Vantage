/**
 * Tokens, hashes and at-rest encryption. Everything here is WebCrypto / Bun built-ins.
 *
 * Token format: `<prefix>_<43 chars base64url>` (32 random bytes). Only the SHA-256 hex of the full
 * token is stored; the prefix makes leaked tokens greppable and tells humans what a token is for.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function newToken(prefix: string): string {
  return `${prefix}_${base64url(randomBytes(32))}`;
}

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function hmacHex(key: string, value: string): string {
  return new Bun.CryptoHasher("sha256", key).update(value).digest("hex");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    // The secret is a long random string from the environment; SHA-256 turns it into 32 key bytes.
    const raw = new Uint8Array(new Bun.CryptoHasher("sha256").update(`vantage-at-rest:${secret}`).digest());
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(secret, key);
  }
  return key;
}

/** AES-256-GCM. Output: `v1.<iv b64url>.<ciphertext b64url>`. */
export async function encryptString(secret: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), encoder.encode(plaintext));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(ct))}`;
}

export async function decryptString(secret: string, payload: string): Promise<string> {
  const [version, ivPart, ctPart] = payload.split(".");
  if (version !== "v1" || !ivPart || !ctPart) throw new Error("Unknown ciphertext format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(Buffer.from(ivPart, "base64url")) },
    await aesKey(secret),
    new Uint8Array(Buffer.from(ctPart, "base64url")),
  );
  return decoder.decode(pt);
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
