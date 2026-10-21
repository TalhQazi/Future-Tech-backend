import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { withTransaction } from '../config/db.js';
import { User, Session, RefreshToken, Customer } from '../models/index.js';
import { MFA_REQUIRED_ROLES } from '../models/identity.js';
import { signAccessToken, signStepToken, verifyToken } from './tokens.js';
import { audit } from './audit.js';
import { sha256, randomToken, encryptSecret, decryptSecret, timingSafeEqualStr } from '../lib/crypto.js';
import { generateTotpSecret, verifyTotp, otpauthUri } from '../lib/totp.js';
import { unauthorized, badRequest, conflict, forbidden } from '../lib/errors.js';
import { permissionsFor } from '../security/permissions.js';
import { notificationAdapters } from '../adapters/notifications.js';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

export const passwordPolicyError = (password) => {
  if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters';
  if (password.length > 128) return 'Password must be at most 128 characters';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain letters and numbers';
  return null;
};

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

export const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  status: user.status,
  phone: user.phone,
  specialty: user.specialty,
  avatar: user.avatar,
  locationIds: user.locationIds || [],
  primaryLocationId: user.primaryLocationId || (user.locationIds || [])[0] || null,
  customerId: user.customerId || null,
  mfaEnabled: Boolean(user.mfa?.enabled),
  mfaRequired: MFA_REQUIRED_ROLES.includes(user.role),
  mustChangePassword: Boolean(user.mustChangePassword),
  permissions: permissionsFor(user.role)
});

const loadUserWithSecrets = (filter) =>
  User.findOne(filter).select('+passwordHash +password +mfa.secretEnc +mfa.pendingSecretEnc +mfa.recoveryCodeHashes');

const reqMeta = (req) => ({ ip: req.ip, userAgent: (req.get('User-Agent') || '').slice(0, 300) });

// Issues a session + rotating refresh token + short-lived access token.
const issueSession = async (req, user, { mfaVerified }) => {
  const now = Date.now();
  const sessionExpiry = new Date(now + env.sessionMaxAgeDays * DAY_MS);
  const [session] = await Session.create([{
    userId: user.id,
    mfaVerified,
    ...reqMeta(req),
    lastSeenAt: new Date(now),
    expiresAt: sessionExpiry,
    purgeAt: new Date(sessionExpiry.getTime() + 30 * DAY_MS)
  }]);
  const refreshToken = randomToken(48);
  const refreshExpiry = new Date(Math.min(now + env.refreshTokenTtlDays * DAY_MS, sessionExpiry.getTime()));
  await RefreshToken.create({
    tokenHash: sha256(refreshToken),
    sessionId: session.id,
    userId: user.id,
    expiresAt: refreshExpiry,
    purgeAt: new Date(refreshExpiry.getTime() + 7 * DAY_MS)
  });
  await User.updateOne({ id: user.id }, { $set: { lastLoginAt: new Date(now), failedLoginCount: 0 }, $unset: { lockedUntil: 1 } });
  return {
    token: signAccessToken(user, session.id),
    refreshToken,
    expiresIn: env.accessTokenTtlSeconds,
    user: publicUser(user)
  };
};

const verifyPassword = async (user, password) => {
  if (user.passwordHash) return bcrypt.compare(password, user.passwordHash);
  // Legacy plain-text password from the prototype: compare in constant time,
  // then upgrade to a bcrypt hash and remove the plain-text value.
  if (user.password && timingSafeEqualStr(user.password, password)) {
    const passwordHash = await hashPassword(password);
    await User.updateOne({ id: user.id }, { $set: { passwordHash, passwordChangedAt: new Date() }, $unset: { password: 1 } });
    user.passwordHash = passwordHash;
    return true;
  }
  return false;
};

const recordFailure = async (req, user, reason) => {
  if (user) {
    const failed = (user.failedLoginCount || 0) + 1;
    const update = { $set: { failedLoginCount: failed } };
    if (failed >= MAX_FAILED_LOGINS) update.$set.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000);
    await User.updateOne({ id: user.id }, update);
  }
  await audit(req, {
    eventType: 'LOGIN_FAILED', category: 'security', entityType: 'User', entityId: user?.id,
    actorId: user?.id || 'anonymous', actorRole: user?.role || 'anonymous', action: `Sign-in failed (${reason})`
  });
};

export const login = async (req, { email, password }) => {
  const user = await loadUserWithSecrets({ email: email.toLowerCase().trim() });
  // Same generic error for unknown email and wrong password.
  if (!user || user.status === 'disabled') {
    await recordFailure(req, user, user ? 'disabled' : 'unknown_email');
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (user.status === 'invited') throw unauthorized('Accept your invitation to set a password first', 'INVITE_PENDING');
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw unauthorized('Too many failed attempts. Try again in a few minutes.', 'ACCOUNT_LOCKED');
  }
  const ok = await verifyPassword(user, password);
  if (!ok) {
    await recordFailure(req, user, 'bad_password');
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  const mfaRequired = MFA_REQUIRED_ROLES.includes(user.role);
  if (user.mfa?.enabled) {
    return { success: true, requiresMfa: true, mfaToken: signStepToken(user, 'mfa_challenge', 300), message: 'Enter the code from your authenticator app' };
  }
  if (mfaRequired) {
    return {
      success: true,
      requiresMfaEnrollment: true,
      enrollmentToken: signStepToken(user, 'mfa_enroll', 900),
      message: 'Your role requires multi-factor authentication. Set up an authenticator app to continue.'
    };
  }
  const result = await issueSession(req, user, { mfaVerified: false });
  await audit(req, { eventType: 'USER_LOGIN', category: 'security', entityType: 'User', entityId: user.id, actorId: user.id, actorRole: user.role, actorName: user.name, action: 'Signed in' });
  return { success: true, ...result };
};

const consumeTotpOrRecovery = async (user, code) => {
  const secret = decryptSecret(user.mfa.secretEnc);
  const counter = verifyTotp(secret, code);
  if (counter !== null) {
    // Atomic replay protection: only accept counters newer than the last one used.
    const res = await User.updateOne(
      { id: user.id, 'mfa.lastUsedCounter': { $lt: counter } },
      { $set: { 'mfa.lastUsedCounter': counter } }
    );
    return res.modifiedCount === 1 ? 'totp' : null;
  }
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length >= 8) {
    const hash = sha256(`recovery:${normalized}`);
    const res = await User.updateOne(
      { id: user.id, 'mfa.recoveryCodeHashes': hash },
      { $pull: { 'mfa.recoveryCodeHashes': hash } }
    );
    if (res.modifiedCount === 1) return 'recovery_code';
  }
  return null;
};

export const verifyMfaChallenge = async (req, { mfaToken, code }) => {
  let payload;
  try {
    payload = verifyToken(mfaToken, 'mfa_challenge');
  } catch {
    throw unauthorized('MFA challenge expired. Sign in again.', 'MFA_CHALLENGE_EXPIRED');
  }
  const user = await loadUserWithSecrets({ id: payload.sub });
  if (!user || user.status !== 'active' || (user.tokenVersion || 0) !== payload.tv || !user.mfa?.enabled) {
    throw unauthorized('MFA challenge is no longer valid', 'MFA_CHALLENGE_INVALID');
  }
  const method = await consumeTotpOrRecovery(user, code);
  if (!method) {
    await recordFailure(req, user, 'bad_mfa_code');
    throw unauthorized('Invalid verification code', 'INVALID_MFA_CODE');
  }
  const result = await issueSession(req, user, { mfaVerified: true });
  await audit(req, {
    eventType: 'USER_LOGIN', category: 'security', entityType: 'User', entityId: user.id, actorId: user.id, actorRole: user.role,
    actorName: user.name, action: `Signed in with MFA (${method === 'recovery_code' ? 'recovery code' : 'authenticator'})`
  });
  return { success: true, ...result };
};

const generateRecoveryCodes = () => Array.from({ length: 8 }, () => randomToken(8).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10).padEnd(10, 'X'));

// Enrollment works either with an enrollment token (privileged first sign-in)
// or for an already signed-in user enabling MFA voluntarily.
const resolveEnrollmentUser = async (req, enrollmentToken) => {
  if (enrollmentToken) {
    let payload;
    try {
      payload = verifyToken(enrollmentToken, 'mfa_enroll');
    } catch {
      throw unauthorized('Enrollment session expired. Sign in again.', 'MFA_ENROLLMENT_EXPIRED');
    }
    const user = await loadUserWithSecrets({ id: payload.sub });
    if (!user || user.status !== 'active' || (user.tokenVersion || 0) !== payload.tv) throw unauthorized('Enrollment is no longer valid');
    return { user, viaEnrollmentToken: true };
  }
  if (!req.auth) throw unauthorized();
  const user = await loadUserWithSecrets({ id: req.auth.userId });
  return { user, viaEnrollmentToken: false };
};

export const startMfaEnrollment = async (req, { enrollmentToken }) => {
  const { user } = await resolveEnrollmentUser(req, enrollmentToken);
  if (user.mfa?.enabled) throw conflict('MFA is already enabled. Reset it before enrolling a new device.');
  const secret = generateTotpSecret();
  await User.updateOne({ id: user.id }, { $set: { 'mfa.pendingSecretEnc': encryptSecret(secret) } });
  return {
    success: true,
    secret,
    otpauthUri: otpauthUri({ secret, accountName: user.email, issuer: 'FutureTech Shop OS' }),
    message: 'Scan the QR code or enter the key in your authenticator app, then confirm with a 6-digit code.'
  };
};

export const confirmMfaEnrollment = async (req, { enrollmentToken, code }) => {
  const { user, viaEnrollmentToken } = await resolveEnrollmentUser(req, enrollmentToken);
  if (!user.mfa?.pendingSecretEnc) throw badRequest('Start MFA enrollment first');
  const secret = decryptSecret(user.mfa.pendingSecretEnc);
  const counter = verifyTotp(secret, code);
  if (counter === null) throw badRequest('That code did not match. Check the time on your device and try again.');
  const recoveryCodes = generateRecoveryCodes();
  await User.updateOne({ id: user.id }, {
    $set: {
      'mfa.enabled': true,
      'mfa.secretEnc': encryptSecret(secret),
      'mfa.enrolledAt': new Date(),
      'mfa.lastUsedCounter': counter,
      'mfa.recoveryCodeHashes': recoveryCodes.map(c => sha256(`recovery:${c}`)),
      mfaEnabled: true
    },
    $unset: { 'mfa.pendingSecretEnc': 1 }
  });
  await audit(req, { eventType: 'MFA_ENABLED', category: 'security', entityType: 'User', entityId: user.id, actorId: user.id, actorRole: user.role, actorName: user.name, action: 'Enrolled an authenticator app for MFA' });
  const fresh = await User.findOne({ id: user.id });
  const session = viaEnrollmentToken ? await issueSession(req, fresh, { mfaVerified: true }) : {};
  return { success: true, recoveryCodes, message: 'MFA enabled. Store the recovery codes somewhere safe; each works once.', ...session };
};

export const refresh = async (req, { refreshToken }) => {
  const tokenHash = sha256(refreshToken);
  const record = await RefreshToken.findOne({ tokenHash });
  if (!record) throw unauthorized('Refresh token is invalid', 'INVALID_REFRESH_TOKEN');

  if (record.status !== 'active') {
    // A rotated token is being replayed. A legitimate concurrent refresh lands
    // within a couple of seconds; anything else is treated as token theft.
    const graceMs = 10_000;
    if (record.status === 'used' && record.usedAt && Date.now() - record.usedAt.getTime() < graceMs) {
      throw unauthorized('Refresh already in progress', 'REFRESH_RACE');
    }
    await Session.updateOne({ id: record.sessionId }, { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: 'refresh_token_reuse' } });
    await RefreshToken.updateMany({ sessionId: record.sessionId, status: 'active' }, { $set: { status: 'revoked' } });
    await audit(req, { eventType: 'REFRESH_TOKEN_REUSE', category: 'security', entityType: 'Session', entityId: record.sessionId, actorId: record.userId, action: 'Refresh token reuse detected; session revoked' });
    throw unauthorized('Session revoked for security reasons. Sign in again.', 'SESSION_REVOKED');
  }
  if (record.expiresAt < new Date()) throw unauthorized('Session expired. Sign in again.', 'REFRESH_TOKEN_EXPIRED');

  const [session, user] = await Promise.all([
    Session.findOne({ id: record.sessionId }),
    User.findOne({ id: record.userId })
  ]);
  if (!session || session.status !== 'active' || session.expiresAt < new Date()) throw unauthorized('Session ended. Sign in again.', 'SESSION_REVOKED');
  if (!user || user.status !== 'active') throw unauthorized('Account is not active', 'ACCOUNT_INACTIVE');

  const nextToken = randomToken(48);
  const nextHash = sha256(nextToken);
  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, status: 'active' },
    { $set: { status: 'used', usedAt: new Date(), replacedByHash: nextHash } }
  );
  if (!claimed) throw unauthorized('Refresh already in progress', 'REFRESH_RACE');

  const refreshExpiry = new Date(Math.min(Date.now() + env.refreshTokenTtlDays * DAY_MS, session.expiresAt.getTime()));
  await RefreshToken.create({ tokenHash: nextHash, sessionId: session.id, userId: user.id, expiresAt: refreshExpiry, purgeAt: new Date(refreshExpiry.getTime() + 7 * DAY_MS) });
  await Session.updateOne({ id: session.id }, { $set: { lastSeenAt: new Date() } });

  return {
    success: true,
    token: signAccessToken(user, session.id),
    refreshToken: nextToken,
    expiresIn: env.accessTokenTtlSeconds,
    user: publicUser(user)
  };
};

export const logout = async (req, { refreshToken }) => {
  let sessionId = req.auth?.sessionId;
  if (!sessionId && refreshToken) {
    const record = await RefreshToken.findOne({ tokenHash: sha256(refreshToken) });
    sessionId = record?.sessionId;
  }
  if (sessionId) {
    await Session.updateOne({ id: sessionId }, { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: 'logout' } });
    await RefreshToken.updateMany({ sessionId, status: 'active' }, { $set: { status: 'revoked' } });
  }
  return { success: true, message: 'Signed out' };
};

export const logoutAllSessions = async (req, userId, reason = 'logout_all') => {
  await User.updateOne({ id: userId }, { $inc: { tokenVersion: 1 } });
  const sessions = await Session.find({ userId, status: 'active' }, { id: 1 }).lean();
  await Session.updateMany({ userId, status: 'active' }, { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: reason } });
  await RefreshToken.updateMany({ sessionId: { $in: sessions.map(s => s.id) }, status: 'active' }, { $set: { status: 'revoked' } });
};

// Public self-registration is limited to customers. Staff accounts are
// created by managers/admins (services/userService.js).
export const registerCustomer = async (req, { name, email, password, phone }) => {
  const policy = passwordPolicyError(password);
  if (policy) throw badRequest(policy);
  const cleanEmail = email.toLowerCase().trim();
  if (await User.exists({ email: cleanEmail })) {
    throw conflict('An account with this email already exists. Sign in or reset your password.', 'EMAIL_IN_USE');
  }
  const passwordHash = await hashPassword(password);
  const user = await withTransaction(async (session) => {
    const [customer] = await Customer.create([{ name: name.trim(), email: cleanEmail, phone: (phone || '').trim(), createdBy: 'self_registration' }], { session });
    const [created] = await User.create([{
      name: name.trim(), email: cleanEmail, passwordHash, role: 'customer', phone: (phone || '').trim(),
      customerId: customer.id, passwordChangedAt: new Date()
    }], { session });
    await Customer.updateOne({ id: customer.id }, { $set: { userId: created.id } }, { session });
    await audit(req, { eventType: 'USER_REGISTERED', category: 'security', entityType: 'User', entityId: created.id, actorId: created.id, actorRole: 'customer', actorName: created.name, action: 'Customer portal account registered' }, session);
    return created;
  });
  const result = await issueSession(req, user, { mfaVerified: false });
  return { success: true, message: 'Account created', ...result };
};

export const changePassword = async (req, { currentPassword, newPassword }) => {
  const user = await loadUserWithSecrets({ id: req.auth.userId });
  if (!(await verifyPassword(user, currentPassword))) throw badRequest('Current password is incorrect');
  const policy = passwordPolicyError(newPassword);
  if (policy) throw badRequest(policy);
  if (await bcrypt.compare(newPassword, user.passwordHash)) throw badRequest('Choose a password different from the current one');
  await User.updateOne({ id: user.id }, { $set: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), mustChangePassword: false } });
  // Revoke every other session, keep this one usable.
  const others = await Session.find({ userId: user.id, status: 'active', id: { $ne: req.auth.sessionId } }, { id: 1 }).lean();
  await Session.updateMany({ id: { $in: others.map(s => s.id) } }, { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: 'password_changed' } });
  await RefreshToken.updateMany({ sessionId: { $in: others.map(s => s.id) }, status: 'active' }, { $set: { status: 'revoked' } });
  await audit(req, { eventType: 'PASSWORD_CHANGED', category: 'security', entityType: 'User', entityId: user.id, action: 'Password changed; other sessions revoked' });
  return { success: true, message: 'Password updated' };
};

// Password reset: the response never reveals whether the email exists.
export const requestPasswordReset = async (req, { email }) => {
  const user = await User.findOne({ email: email.toLowerCase().trim(), status: 'active' });
  const generic = { success: true, message: 'If an account exists for that email, a reset link has been sent.' };
  if (!user) return generic;
  const token = randomToken(32);
  await User.updateOne({ id: user.id }, { $set: { resetTokenHash: sha256(token), resetExpiresAt: new Date(Date.now() + 30 * 60000) } });
  const link = `${env.appBaseUrl}/#/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  const result = await notificationAdapters.email.send({
    to: user.email,
    subject: 'Reset your FutureTech password',
    body: `A password reset was requested for your account.\n\nReset link (valid 30 minutes): ${link}\n\nIf you did not request this, ignore this email.`
  });
  await audit(req, { eventType: 'PASSWORD_RESET_REQUESTED', category: 'security', entityType: 'User', entityId: user.id, actorId: user.id, actorRole: user.role, action: `Password reset requested (email delivery: ${result.status})` });
  return generic;
};

export const completePasswordReset = async (req, { email, token, newPassword }) => {
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+resetTokenHash');
  if (!user || !user.resetTokenHash || !user.resetExpiresAt || user.resetExpiresAt < new Date() || !timingSafeEqualStr(user.resetTokenHash, sha256(token))) {
    throw badRequest('This reset link is invalid or has expired');
  }
  const policy = passwordPolicyError(newPassword);
  if (policy) throw badRequest(policy);
  await User.updateOne({ id: user.id }, {
    $set: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), mustChangePassword: false, failedLoginCount: 0 },
    $unset: { resetTokenHash: 1, resetExpiresAt: 1, lockedUntil: 1, password: 1 }
  });
  await logoutAllSessions(req, user.id, 'password_reset');
  await audit(req, { eventType: 'PASSWORD_RESET_COMPLETED', category: 'security', entityType: 'User', entityId: user.id, actorId: user.id, actorRole: user.role, action: 'Password reset completed; all sessions revoked' });
  return { success: true, message: 'Password updated. Sign in with your new password.' };
};

export const acceptInvite = async (req, { email, token, password }) => {
  const user = await User.findOne({ email: email.toLowerCase().trim(), status: 'invited' }).select('+inviteTokenHash');
  if (!user || !user.inviteTokenHash || !user.inviteExpiresAt || user.inviteExpiresAt < new Date() || !timingSafeEqualStr(user.inviteTokenHash, sha256(token))) {
    throw badRequest('This invitation is invalid or has expired. Ask the shop to send a new one.');
  }
  const policy = passwordPolicyError(password);
  if (policy) throw badRequest(policy);
  await User.updateOne({ id: user.id }, {
    $set: { passwordHash: await hashPassword(password), passwordChangedAt: new Date(), status: 'active', mustChangePassword: false },
    $unset: { inviteTokenHash: 1, inviteExpiresAt: 1 }
  });
  await audit(req, { eventType: 'INVITE_ACCEPTED', category: 'security', entityType: 'User', entityId: user.id, actorId: user.id, actorRole: user.role, action: 'Invitation accepted and password set' });
  return { success: true, message: 'Account activated. Sign in to continue.' };
};

export const assertNotSelfPrivilegeChange = (auth, targetUserId) => {
  if (auth.userId === targetUserId) throw forbidden('You cannot change your own role, status or locations');
};
