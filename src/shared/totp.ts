/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), compatible with every authenticator app. */

import { randomBytes } from "./crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number): Promise<string> {
  const msg = new ArrayBuffer(8);
  new DataView(msg).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}

export function totpCode(secretBase32: string, at = Date.now()): Promise<string> {
  return hotp(base32Decode(secretBase32), Math.floor(at / 30_000));
}

/** Accepts the current step and one step either side (clock drift). */
export async function verifyTotp(secretBase32: string, code: string, at = Date.now()): Promise<boolean> {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(at / 30_000);
  for (const delta of [0, -1, 1]) {
    if ((await hotp(secret, step + delta)) === normalized) return true;
  }
  return false;
}

export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
