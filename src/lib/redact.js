// PII redaction for logs, audit summaries and AI prompts.

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

export const maskEmail = (email = '') => email.replace(EMAIL_RE, (_, first, domain) => `${first}***@${domain}`);

export const maskPhone = (phone = '') => {
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 4 ? `***-${digits.slice(-4)}` : '***';
};

export const redactText = (text = '') =>
  String(text)
    .replace(CARD_RE, '[redacted-card]')
    .replace(EMAIL_RE, (_, first, domain) => `${first}***@${domain}`)
    .replace(PHONE_RE, (m) => maskPhone(m));

const SENSITIVE_KEYS = new Set([
  'password', 'passwordHash', 'token', 'refreshToken', 'accessToken', 'secret', 'mfaSecret',
  'secretEnc', 'pendingSecretEnc', 'recoveryCodes', 'recoveryCodeHashes', 'cardNumber', 'cvv',
  'authorization', 'apiKey'
]);

export const redactObject = (value, depth = 0) => {
  if (depth > 6 || value === null || typeof value !== 'object') {
    return typeof value === 'string' ? redactText(value) : value;
  }
  if (Array.isArray(value)) return value.map(v => redactObject(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k)) out[k] = '[redacted]';
    else if (k === 'email' && typeof v === 'string') out[k] = maskEmail(v);
    else if (k === 'phone' && typeof v === 'string') out[k] = maskPhone(v);
    else out[k] = redactObject(v, depth + 1);
  }
  return out;
};
