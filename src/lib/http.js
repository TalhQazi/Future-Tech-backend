import { notFound } from './errors.js';

// Wraps async route handlers so rejected promises reach the error middleware.
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Converts lean Mongo documents into API shapes: drops _id, exposes __v as `version`.
export const toDTO = (doc) => {
  if (!doc) return doc;
  if (Array.isArray(doc)) return doc.map(toDTO);
  const obj = typeof doc.toObject === 'function' ? doc.toObject({ versionKey: true }) : { ...doc };
  const { _id, __v, ...rest } = obj;
  if (__v !== undefined) rest.version = __v;
  return rest;
};

export const orNotFound = (doc, entity) => {
  if (!doc) throw notFound(entity);
  return doc;
};

// Reads the expected optimistic-concurrency version from If-Match or the body.
export const expectedVersion = (req) => {
  const header = req.get('If-Match');
  if (header !== undefined && header !== '') {
    const n = Number.parseInt(header.replace(/"/g, ''), 10);
    if (Number.isInteger(n)) return n;
  }
  const bodyVersion = req.body?.expectedVersion;
  return Number.isInteger(bodyVersion) ? bodyVersion : undefined;
};

export const parsePagination = (query, { defaultLimit = 25, maxLimit = 100 } = {}) => {
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  return { limit, page, skip: (page - 1) * limit };
};

export const paginationMeta = ({ page, limit }, total) => ({
  page,
  limit,
  total,
  pages: Math.max(1, Math.ceil(total / limit))
});

// Escapes user text for use inside a RegExp (search boxes).
export const escapeRegex = (s = '') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
