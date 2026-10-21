import crypto from 'crypto';

// RFC 6238 TOTP (HMAC-SHA1, 30 s period, 6 digits) — compatible with Google
// Authenticator, Microsoft Authenticator, 1Password, Authy and similar apps.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;

export const base32Encode = (buf) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (input) => {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

export const totpAt = (secretBase32, counter) => {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS).toString();
  return code.padStart(DIGITS, '0');
};

export const currentCounter = (now = Date.now()) => Math.floor(now / 1000 / PERIOD_SECONDS);

/**
 * Verifies a code within ±window periods. Returns the matched counter, or null.
 * Callers must reject counters <= the last accepted one to prevent replay.
 */
export const verifyTotp = (secretBase32, code, { window = 1, now = Date.now() } = {}) => {
  const token = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return null;
  const counter = currentCounter(now);
  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = totpAt(secretBase32, counter + delta);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token))) return counter + delta;
  }
  return null;
};

export const otpauthUri = ({ secret, accountName, issuer }) => {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
};
