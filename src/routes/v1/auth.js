import { Router } from 'express';
import { z, h, ok, reqText } from './_helpers.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, optionalAuth } from '../../middleware/auth.js';
import { persistentLimiter } from '../../middleware/rateLimit.js';
import * as auth from '../../services/authService.js';
import { User } from '../../models/index.js';

const r = Router();
const email = z.string().trim().email().max(254);
const loginLimiter = persistentLimiter({ name: 'login', limit: 10, windowMs: 15 * 60000, key: (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}` });
const ipLimiter = (name, limit) => persistentLimiter({ name, limit, windowMs: 15 * 60000 });

r.post('/register', ipLimiter('register', 10), validate({ body: z.object({ name: reqText(120), email, password: z.string(), phone: z.string().trim().max(30).optional() }) }),
  h(async (req, res) => res.status(201).json(await auth.registerCustomer(req, req.body))));

r.post('/login', loginLimiter, validate({ body: z.object({ email, password: z.string().min(1).max(128) }) }),
  h(async (req, res) => res.json(await auth.login(req, req.body))));

r.post('/mfa/verify', ipLimiter('mfa', 15), validate({ body: z.object({ mfaToken: z.string(), code: z.string().max(20) }) }),
  h(async (req, res) => res.json(await auth.verifyMfaChallenge(req, req.body))));

r.post('/mfa/enroll/start', optionalAuth, validate({ body: z.object({ enrollmentToken: z.string().optional() }) }),
  h(async (req, res) => res.json(await auth.startMfaEnrollment(req, req.body))));

r.post('/mfa/enroll/confirm', optionalAuth, ipLimiter('mfa_enroll', 15), validate({ body: z.object({ enrollmentToken: z.string().optional(), code: z.string().max(10) }) }),
  h(async (req, res) => res.json(await auth.confirmMfaEnrollment(req, req.body))));

r.post('/refresh', ipLimiter('refresh', 120), validate({ body: z.object({ refreshToken: z.string().min(20) }) }),
  h(async (req, res) => res.json(await auth.refresh(req, req.body))));

r.post('/logout', optionalAuth, validate({ body: z.object({ refreshToken: z.string().optional() }) }),
  h(async (req, res) => res.json(await auth.logout(req, req.body))));

r.post('/logout-all', authenticate, h(async (req, res) => {
  await auth.logoutAllSessions(req, req.auth.userId, 'user_logout_all');
  ok(res);
}));

r.get('/me', authenticate, h(async (req, res) => ok(res, { user: auth.publicUser(await User.findOne({ id: req.auth.userId }).lean()) })));

r.post('/password/change', authenticate, validate({ body: z.object({ currentPassword: z.string(), newPassword: z.string() }) }),
  h(async (req, res) => res.json(await auth.changePassword(req, req.body))));

r.post('/password/forgot', ipLimiter('forgot', 5), validate({ body: z.object({ email }) }),
  h(async (req, res) => res.json(await auth.requestPasswordReset(req, req.body))));

r.post('/password/reset', ipLimiter('reset', 10), validate({ body: z.object({ email, token: z.string(), newPassword: z.string() }) }),
  h(async (req, res) => res.json(await auth.completePasswordReset(req, req.body))));

r.post('/invite/accept', ipLimiter('invite', 10), validate({ body: z.object({ email, token: z.string(), password: z.string() }) }),
  h(async (req, res) => res.json(await auth.acceptInvite(req, req.body))));

export default r;
