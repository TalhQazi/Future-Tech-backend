import crypto from 'crypto';
import { badRequest } from '../lib/errors.js';

const VALID_CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;

export const correlationId = (req, res, next) => {
  const incoming = req.get('X-Correlation-ID');
  req.correlationId = incoming && VALID_CORRELATION.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Correlation-ID', req.correlationId);
  next();
};

// Structured access log without bodies, query strings or tokens (no PII).
export const requestLogger = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api')) return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const line = {
      t: new Date().toISOString(),
      cid: req.correlationId,
      m: req.method,
      p: req.originalUrl.split('?')[0],
      s: res.statusCode,
      ms: Math.round(ms),
      u: req.auth?.userId
    };
    console.log(JSON.stringify(line));
  });
  next();
};

// Rejects MongoDB operator injection ({"$gt": ""}) and dotted keys in input.
const hasDangerousKey = (value, depth = 0) => {
  if (depth > 12 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(v => hasDangerousKey(v, depth + 1));
  return Object.keys(value).some(k => k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || hasDangerousKey(value[k], depth + 1));
};

export const rejectMongoOperators = (req, _res, next) => {
  if (hasDangerousKey(req.body) || hasDangerousKey(req.query) || hasDangerousKey(req.params)) {
    return next(badRequest('Request contains disallowed keys'));
  }
  next();
};
