import { verifyToken } from '../services/tokens.js';
import { User, Session } from '../models/index.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { hasPermission } from '../security/permissions.js';
import { MFA_REQUIRED_ROLES } from '../models/identity.js';

const bearer = (req) => {
  const header = req.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

const buildAuth = (user, session) => ({
  user: { id: user.id, name: user.name, email: user.email, role: user.role },
  userId: user.id,
  role: user.role,
  locationIds: user.locationIds || [],
  primaryLocationId: user.primaryLocationId || (user.locationIds || [])[0] || null,
  customerId: user.customerId || null,
  sessionId: session.id,
  mfaVerified: Boolean(session.mfaVerified)
});

const resolve = async (req) => {
  const token = bearer(req);
  if (!token) return null;
  let payload;
  try {
    payload = verifyToken(token, 'access');
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid access token', err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN');
  }
  const [user, session] = await Promise.all([
    User.findOne({ id: payload.sub }).lean(),
    Session.findOne({ id: payload.sid }).lean()
  ]);
  if (!user || user.status !== 'active') throw unauthorized('Account is not active', 'ACCOUNT_INACTIVE');
  if ((user.tokenVersion || 0) !== payload.tv) throw unauthorized('Session was revoked', 'SESSION_REVOKED');
  if (!session || session.status !== 'active' || session.userId !== user.id || session.expiresAt < new Date()) {
    throw unauthorized('Session was revoked', 'SESSION_REVOKED');
  }
  if (MFA_REQUIRED_ROLES.includes(user.role) && !session.mfaVerified) {
    throw unauthorized('Multi-factor authentication is required', 'MFA_REQUIRED');
  }
  return buildAuth(user, session);
};

export const authenticate = async (req, _res, next) => {
  try {
    const auth = await resolve(req);
    if (!auth) throw unauthorized();
    req.auth = auth;
    req.user = auth.user; // compatibility with earlier handlers
    next();
  } catch (err) {
    next(err);
  }
};

export const optionalAuth = async (req, _res, next) => {
  try {
    const auth = await resolve(req);
    if (auth) {
      req.auth = auth;
      req.user = auth.user;
    }
    next();
  } catch {
    next();
  }
};

export const requirePermission = (...permissions) => (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  const missing = permissions.filter(p => !hasPermission(req.auth.role, p));
  if (missing.length > 0) return next(forbidden(`Missing permission: ${missing.join(', ')}`));
  next();
};

export const requireAnyPermission = (...permissions) => (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  if (!permissions.some(p => hasPermission(req.auth.role, p))) {
    return next(forbidden(`Requires one of: ${permissions.join(', ')}`));
  }
  next();
};

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  if (!roles.includes(req.auth.role)) return next(forbidden(`Role '${req.auth.role}' cannot access this resource`));
  next();
};

export const requireStaff = (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  if (req.auth.role === 'customer') return next(forbidden('Staff access only'));
  next();
};

// Backwards-compatible names used by the original route files.
export const protect = authenticate;
export const authorizeRoles = requireRole;
