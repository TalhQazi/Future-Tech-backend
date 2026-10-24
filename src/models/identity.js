import { Schema, idField, baseOptions, immutablePlugin, model } from './common.js';

export const ROLES = ['advisor', 'technician', 'manager', 'parts', 'accounting', 'executive', 'admin', 'customer'];
export const STAFF_ROLES = ROLES.filter(r => r !== 'customer');
export const MFA_REQUIRED_ROLES = ['manager', 'admin', 'accounting', 'executive'];

const UserSchema = new Schema({
  id: idField,
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, select: false },
  // Legacy plain-text column from the original prototype. Upgraded to a bcrypt
  // hash and removed on the user's next successful sign-in.
  password: { type: String, select: false },
  role: { type: String, enum: ROLES, required: true },
  status: { type: String, enum: ['active', 'invited', 'disabled'], default: 'active', index: true },
  phone: { type: String, trim: true, default: '' },
  specialty: { type: String, trim: true, default: '' },
  avatar: { type: String, default: '' },
  locationIds: { type: [String], default: [], index: true },
  primaryLocationId: String,
  customerId: { type: String, index: true },
  laborCostRateCents: { type: Number, default: null }, // technician cost rate for profitability
  certifications: { type: [String], default: [] },
  mfa: {
    enabled: { type: Boolean, default: false },
    secretEnc: { type: String, select: false },
    pendingSecretEnc: { type: String, select: false },
    enrolledAt: Date,
    lastUsedCounter: { type: Number, default: 0 },
    recoveryCodeHashes: { type: [String], select: false, default: [] }
  },
  mfaEnabled: { type: Boolean, default: false }, // legacy mirror of mfa.enabled
  tokenVersion: { type: Number, default: 0 },
  mustChangePassword: { type: Boolean, default: false },
  failedLoginCount: { type: Number, default: 0 },
  lockedUntil: Date,
  lastLoginAt: Date,
  passwordChangedAt: Date,
  inviteTokenHash: { type: String, select: false },
  inviteExpiresAt: Date,
  resetTokenHash: { type: String, select: false },
  resetExpiresAt: Date,
  createdBy: String
}, baseOptions());

UserSchema.index({ role: 1, status: 1 });

const SessionSchema = new Schema({
  id: idField,
  userId: { type: String, required: true, index: true },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  mfaVerified: { type: Boolean, default: false },
  ip: String,
  userAgent: String,
  lastSeenAt: Date,
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  revokedReason: String,
  // TTL cleanup a month after the absolute expiry; audit trail lives in auditlogs
  purgeAt: { type: Date, index: { expireAfterSeconds: 0 } }
}, baseOptions());

const RefreshTokenSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  sessionId: { type: String, required: true, index: true },
  userId: { type: String, required: true },
  status: { type: String, enum: ['active', 'used', 'revoked'], default: 'active' },
  expiresAt: { type: Date, required: true },
  usedAt: Date,
  replacedByHash: String,
  purgeAt: { type: Date, index: { expireAfterSeconds: 0 } }
}, baseOptions());

// Append-only audit history. Shares the original `auditlogs` collection and
// keeps its fields (eventType, entityType, entityId, actorId, actorRole, action).
const AuditEventSchema = new Schema({
  id: idField,
  timestamp: { type: Date, default: Date.now, index: true },
  eventType: { type: String, required: true, index: true },
  category: { type: String, enum: ['security', 'financial', 'permission', 'safety', 'approval', 'override', 'ai', 'inventory', 'operational', 'data'], default: 'operational', index: true },
  entityType: String,
  entityId: { type: String, index: true },
  locationId: { type: String, index: true },
  actorId: String,
  actorRole: String,
  actorName: String,
  action: { type: String, required: true },
  reason: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
  metadata: Schema.Types.Mixed,
  ipAddress: String,
  correlationId: String
}, { versionKey: false, minimize: false });
AuditEventSchema.plugin(immutablePlugin);

const IdempotencyRecordSchema = new Schema({
  key: { type: String, required: true },
  scope: { type: String, required: true }, // user id (or 'anon:ip')
  method: String,
  path: String,
  requestHash: String,
  status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
  responseStatus: Number,
  responseBody: Schema.Types.Mixed,
  lockedUntil: Date,
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } }
}, { timestamps: true, versionKey: false });
IdempotencyRecordSchema.index({ key: 1, scope: 1 }, { unique: true });

const CounterSchema = new Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 }
}, { versionKey: false });

const RateLimitBucketSchema = new Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  resetAt: { type: Date, index: { expireAfterSeconds: 0 } }
}, { versionKey: false });

const MigrationSchema = new Schema({
  name: { type: String, required: true, unique: true },
  appliedAt: { type: Date, default: Date.now },
  summary: Schema.Types.Mixed
}, { versionKey: false });

// Durable outbox / background job record. Consumers must be idempotent: the
// same job can be delivered more than once after crashes or lock expiry.
const JobSchema = new Schema({
  id: idField,
  type: { type: String, required: true, index: true },
  payload: { type: Schema.Types.Mixed, default: {} },
  dedupeKey: { type: String, unique: true, sparse: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'dead'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 8 },
  runAt: { type: Date, default: Date.now, index: true },
  lockedUntil: Date,
  lockedBy: String,
  lastError: String,
  result: Schema.Types.Mixed,
  completedAt: Date
}, baseOptions());
JobSchema.index({ status: 1, runAt: 1 });

export const User = model('User', UserSchema, 'users');
export const Session = model('Session', SessionSchema, 'sessions');
export const RefreshToken = model('RefreshToken', RefreshTokenSchema, 'refreshtokens');
export const AuditEvent = model('AuditEvent', AuditEventSchema, 'auditlogs');
export const IdempotencyRecord = model('IdempotencyRecord', IdempotencyRecordSchema, 'idempotencyrecords');
export const Counter = model('Counter', CounterSchema, 'counters');
export const RateLimitBucket = model('RateLimitBucket', RateLimitBucketSchema, 'ratelimitbuckets');
export const Migration = model('Migration', MigrationSchema, 'migrations');
export const Job = model('Job', JobSchema, 'jobs');
