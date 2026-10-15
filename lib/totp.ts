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

/** Verify a token within ±window steps to tolerate clock drift. */
export function verifyTotp(secret: string, token: string, timeMs: number, window = 1, step = 30): boolean {
  if (!secret || !/^\d{6}$/.test(token?.trim() ?? '')) return false;
  const t = token.trim();
  for (let w = -window; w <= window; w++) {
    if (generateTotp(secret, timeMs + w * step * 1000, step) === t) return true;
  }
  return false;
}

/** otpauth:// URI for QR provisioning. */
export function otpauthUrl(secret: string, account: string, issuer = 'Ironbooks'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
