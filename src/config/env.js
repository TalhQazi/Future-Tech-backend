import 'dotenv/config';
import crypto from 'crypto';

// Centralised, validated runtime configuration. Production refuses to boot with
// missing or publicly known secrets instead of silently running insecurely.

const KNOWN_WEAK_SECRETS = new Set([
  'futuretech_secret_jwt_key_2026_super_secure',
  'secret',
  'changeme'
]);

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';
const problems = [];
const warnings = [];

const str = (name, fallback = '') => (process.env[name] ?? fallback).toString().trim();
const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    problems.push(`${name} must be an integer`);
    return fallback;
  }
  return n;
};
const bool = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};
const list = (name) => str(name).split(',').map(s => s.trim()).filter(Boolean);

// --- JWT secret ---------------------------------------------------------------
let jwtSecret = str('JWT_SECRET');
if (!jwtSecret || KNOWN_WEAK_SECRETS.has(jwtSecret) || jwtSecret.length < 32) {
  if (isProd) {
    problems.push('JWT_SECRET must be set to a unique random value of at least 32 characters (the value from .env.example is public).');
  } else {
    warnings.push('JWT_SECRET is missing or weak; using a development-only secret. Never deploy like this.');
    jwtSecret = jwtSecret && jwtSecret.length >= 16 ? `${jwtSecret}::dev-only-padding-0000000000` : 'dev-only-jwt-secret-do-not-use-in-production-000';
  }
}

// --- Data encryption key (MFA secrets, provider tokens at rest) ---------------
let dataEncryptionKey;
const rawKey = str('DATA_ENCRYPTION_KEY');
if (rawKey) {
  const decoded = Buffer.from(rawKey, 'base64');
  if (decoded.length !== 32) {
    problems.push('DATA_ENCRYPTION_KEY must be 32 bytes encoded as base64 (generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))").');
  } else {
    dataEncryptionKey = decoded;
  }
} else if (isProd) {
  problems.push('DATA_ENCRYPTION_KEY is required in production.');
} else {
  warnings.push('DATA_ENCRYPTION_KEY not set; deriving a development key from JWT_SECRET.');
  dataEncryptionKey = crypto.createHash('sha256').update(`ft-dev-data-key::${jwtSecret}`).digest();
}

// --- Database -----------------------------------------------------------------
const mongoUri = str('MONGODB_URI');
if (!mongoUri) problems.push('MONGODB_URI is required. The API persists all data in MongoDB.');

// --- CORS -----------------------------------------------------------------------
const corsOrigins = list('CORS_ORIGINS');
if (isProd && corsOrigins.length === 0) {
  problems.push('CORS_ORIGINS must list the allowed frontend origins in production (comma separated).');
}
if (!isProd && corsOrigins.length === 0) {
  corsOrigins.push('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173');
}

export const env = Object.freeze({
  nodeEnv,
  isProd,
  port: int('PORT', 5000),
  trustProxy: int('TRUST_PROXY_HOPS', isProd ? 1 : 0),
  mongoUri,
  jwtSecret,
  jwtIssuer: str('JWT_ISSUER', 'futuretech-api'),
  accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
  refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 14),
  sessionMaxAgeDays: int('SESSION_MAX_AGE_DAYS', 30),
  dataEncryptionKey,
  corsOrigins,
  appBaseUrl: str('APP_BASE_URL', 'http://localhost:3000'),
  defaultCurrency: str('DEFAULT_CURRENCY', 'USD').toUpperCase(),
  cronSecret: str('CRON_SECRET'),
  runWorkerInProcess: bool('RUN_WORKER_IN_PROCESS', !isProd),
  storage: {
    driver: str('STORAGE_DRIVER', 'gridfs'), // 'gridfs' | 'local'
    localDir: str('STORAGE_LOCAL_DIR', 'uploads'),
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 25 * 1024 * 1024)
  },
  payments: {
    stripeSecretKey: str('STRIPE_SECRET_KEY'),
    stripeWebhookSecret: str('STRIPE_WEBHOOK_SECRET')
  },
  notifications: {
    twilioAccountSid: str('TWILIO_ACCOUNT_SID'),
    twilioAuthToken: str('TWILIO_AUTH_TOKEN'),
    twilioFromNumber: str('TWILIO_FROM_NUMBER'),
    sendgridApiKey: str('SENDGRID_API_KEY'),
    emailFrom: str('EMAIL_FROM')
  },
  automind: {
    gatewayUrl: str('AUTOMIND_GATEWAY_URL'),
    apiKey: str('AUTOMIND_API_KEY'),
    ingestSecret: str('AUTOMIND_INGEST_SECRET')
  },
  ai: {
    // AI is disabled in this phase; a provider plugs in via src/adapters/ai/index.js
    provider: str('AI_PROVIDER', 'none').toLowerCase()
  },
  technicalData: {
    providerName: str('TECHDATA_PROVIDER_NAME'),
    providerUrl: str('TECHDATA_PROVIDER_URL'),
    apiKey: str('TECHDATA_API_KEY')
  },
  vin: {
    nhtsaBaseUrl: str('NHTSA_VPIC_URL', 'https://vpic.nhtsa.dot.gov/api'),
    recallsBaseUrl: str('NHTSA_RECALLS_URL', 'https://api.nhtsa.gov')
  }
});

export const configProblems = problems;
export const configWarnings = warnings;

export function assertConfig() {
  for (const w of warnings) console.warn(`[config] ${w}`);
  if (problems.length > 0) {
    const message = `Invalid configuration:\n - ${problems.join('\n - ')}`;
    throw new Error(message);
  }
}
