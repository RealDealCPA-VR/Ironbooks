/**
 * TOTP (RFC 6238) two-factor auth — pure Node crypto, no dependencies.
 * Compatible with Google Authenticator / Authy / 1Password (SHA-1, 6 digits, 30s period).
 */
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(bytes = 20): string {
  const buf = crypto.randomBytes(bytes);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/,'').toUpperCase().replace(/\s/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** Generate the 6-digit code for a given secret + unix-ms time. */
export function generateTotp(secret: string, timeMs: number, step = 30): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

/** The time step (RFC 6238 counter) a unix-ms time falls in. */
export function totpStepAt(timeMs: number, step = 30): number {
  return Math.floor(timeMs / 1000 / step);
}

/**
 * The time step a token was made for, within ±window steps of `timeMs` (clock drift), or null when
 * it matches none. The newest matching step wins. Every candidate is compared in constant time, so
 * how long a check takes says nothing about how close a guess was.
 *
 * A code is valid for about 90 seconds; callers that sign someone in remember the step they
 * accepted and refuse any step that is not newer (lib/services/totpCodes.ts), so a code that was
 * seen once can't be used again.
 */
export function matchTotpStep(secret: string, token: string, timeMs: number, window = 1, step = 30): number | null {
  if (!secret || typeof token !== 'string' || !/^\d{6}$/.test(token.trim())) return null;
  const typed = Buffer.from(token.trim());
  const now = totpStepAt(timeMs, step);
  let found: number | null = null;
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(generateTotp(secret, (now + w) * step * 1000, step));
    if (crypto.timingSafeEqual(expected, typed)) found = now + w;
  }
  return found;
}

/** Verify a token within ±window steps to tolerate clock drift (no memory of codes already used). */
export function verifyTotp(secret: string, token: string, timeMs: number, window = 1, step = 30): boolean {
  return matchTotpStep(secret, token, timeMs, window, step) !== null;
}

/** otpauth:// URI for QR provisioning. */
export function otpauthUrl(secret: string, account: string, issuer = 'Ironbooks'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
