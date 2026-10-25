import { createHmac } from "node:crypto";

// RFC 6238 time-based one-time passwords with node:crypto only (no dependency). Supabase's authenticator factor uses the
// defaults: HMAC-SHA1, 6 digits, 30 second step, base32 secret. The test-vector unit test is tests/unit/e2e-helpers.test.ts.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`not a base32 character: ${ch}`);
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226). `key` is the raw secret bytes. */
export function hotp(key: Buffer, counter: number, digits = 6, algo: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algo, key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** TOTP (RFC 6238) for a base32 secret at `nowMs` (default: now). */
export function totp(secretBase32: string, nowMs = Date.now(), opts: { step?: number; digits?: number; algo?: "sha1" | "sha256" | "sha512" } = {}): string {
  const step = opts.step ?? 30;
  return hotp(base32Decode(secretBase32), Math.floor(nowMs / 1000 / step), opts.digits ?? 6, opts.algo ?? "sha1");
}

/** Seconds left in the current 30 s window: a code is best not used in the last second or two. */
export const secondsLeft = (nowMs = Date.now(), step = 30) => step - (Math.floor(nowMs / 1000) % step);
