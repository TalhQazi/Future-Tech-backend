import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// Short-lived access tokens and single-purpose step tokens (MFA challenge,
// MFA enrollment, password change). Refresh tokens are opaque random values
// stored only as hashes — see services/authService.js.

const AUDIENCE = 'futuretech-app';

export const signAccessToken = (user, sessionId) =>
  jwt.sign(
    { sub: user.id, sid: sessionId, role: user.role, tv: user.tokenVersion || 0, typ: 'access' },
    env.jwtSecret,
    { algorithm: 'HS256', expiresIn: env.accessTokenTtlSeconds, issuer: env.jwtIssuer, audience: AUDIENCE }
  );

export const signStepToken = (user, typ, ttlSeconds, extra = {}) =>
  jwt.sign(
    { sub: user.id, tv: user.tokenVersion || 0, typ, ...extra },
    env.jwtSecret,
    { algorithm: 'HS256', expiresIn: ttlSeconds, issuer: env.jwtIssuer, audience: AUDIENCE }
  );

export const verifyToken = (token, expectedTyp) => {
  const payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'], issuer: env.jwtIssuer, audience: AUDIENCE });
  if (payload.typ !== expectedTyp) {
    const err = new Error('Wrong token type');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
};
