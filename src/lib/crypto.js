import crypto from 'crypto';
import { env } from '../config/env.js';

// AES-256-GCM envelope for secrets at rest (MFA seeds, provider credentials).
export const encryptSecret = (plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', env.dataEncryptionKey, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
};

export const decryptSecret = (payload) => {
  if (!payload) return null;
  const [version, ivB64, tagB64, dataB64] = String(payload).split(':');
  if (version !== 'v1') throw new Error('Unsupported secret envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', env.dataEncryptionKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
};

export const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex');

// Stable hash of a JSON-compatible value (object keys sorted).
export const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
};

export const hashCanonical = (value) => sha256(canonicalJson(value));

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const timingSafeEqualStr = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

export const uuid = () => crypto.randomUUID();
