import rateLimit from 'express-rate-limit';
import { RateLimitBucket } from '../models/index.js';
import { tooManyRequests } from '../lib/errors.js';

// General API limiter (per instance). Abuse-sensitive endpoints (sign-in,
// MFA, password reset) also use the MongoDB-backed limiter below so limits
// hold across serverless instances.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.', correlationId: req.correlationId })
});

export const persistentLimiter = ({ name, limit, windowMs, key = (req) => req.ip }) => async (req, _res, next) => {
  try {
    const bucketKey = `${name}:${key(req)}`;
    const now = new Date();
    const bucket = await RateLimitBucket.findOneAndUpdate(
      { key: bucketKey, resetAt: { $gt: now } },
      { $inc: { count: 1 } },
      { new: true }
    );
    if (!bucket) {
      await RateLimitBucket.findOneAndUpdate(
        { key: bucketKey },
        { $set: { count: 1, resetAt: new Date(now.getTime() + windowMs) } },
        { upsert: true }
      );
      return next();
    }
    if (bucket.count > limit) return next(tooManyRequests('Too many attempts. Please wait and try again.'));
    next();
  } catch (err) {
    if (err?.code === 11000) return next(); // concurrent first hit created the bucket
    next(err);
  }
};
