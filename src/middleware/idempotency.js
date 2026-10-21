import { IdempotencyRecord } from '../models/index.js';
import { hashCanonical } from '../lib/crypto.js';
import { badRequest, conflict, unprocessable } from '../lib/errors.js';

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_MS = 60 * 1000;

/**
 * Idempotency-Key support for consequential POSTs (payments, approvals,
 * stock movements, offline queue replays). A retried request with the same key
 * and body receives the original response instead of executing twice.
 *   required: true  -> the header must be present
 */
export const idempotent = ({ required = false } = {}) => async (req, res, next) => {
  const key = req.get('Idempotency-Key');
  if (!key) {
    if (required) return next(badRequest('Idempotency-Key header is required for this operation'));
    return next();
  }
  if (!KEY_RE.test(key)) return next(badRequest('Idempotency-Key must be 8-128 characters [A-Za-z0-9._:-]'));

  const scope = req.auth?.userId || `anon:${req.ip}`;
  const requestHash = hashCanonical({ m: req.method, p: req.baseUrl + req.path, b: req.body ?? null });
  const now = new Date();

  try {
    const existing = await IdempotencyRecord.findOne({ key, scope });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return next(unprocessable('Idempotency-Key was already used with a different request', undefined, 'IDEMPOTENCY_KEY_REUSED'));
      }
      if (existing.status === 'completed') {
        res.setHeader('Idempotent-Replay', 'true');
        return res.status(existing.responseStatus).json(existing.responseBody);
      }
      if (existing.lockedUntil && existing.lockedUntil > now) {
        return next(conflict('The original request with this Idempotency-Key is still being processed', 'IDEMPOTENCY_IN_PROGRESS'));
      }
      // stale lock from a crashed attempt: take it over
      await IdempotencyRecord.updateOne({ _id: existing._id }, { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } });
    } else {
      await IdempotencyRecord.create({
        key, scope, method: req.method, path: req.baseUrl + req.path, requestHash,
        lockedUntil: new Date(now.getTime() + LOCK_MS),
        expiresAt: new Date(now.getTime() + TTL_MS)
      });
    }
  } catch (err) {
    if (err?.code === 11000) {
      return next(conflict('The original request with this Idempotency-Key is still being processed', 'IDEMPOTENCY_IN_PROGRESS'));
    }
    return next(err);
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    const done = status < 500
      ? IdempotencyRecord.updateOne({ key, scope }, { $set: { status: 'completed', responseStatus: status, responseBody: body, lockedUntil: null } })
      : IdempotencyRecord.deleteOne({ key, scope }); // allow a clean retry after server errors
    done.catch(() => {}).finally(() => originalJson(body));
    return res;
  };
  next();
};
