import { Counter } from '../models/index.js';

// Gap-tolerant, collision-free human-readable numbers (RO, invoice, receipt...).
export const nextSequence = async (key, session = null) => {
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );
  return counter.seq;
};

const pad = (n, width = 5) => String(n).padStart(width, '0');

export const nextNumber = async (prefix, scope, year, session = null) => {
  const key = `${prefix}:${scope}:${year}`;
  const seq = await nextSequence(key, session);
  return `${prefix}-${scope}-${year}-${pad(seq)}`;
};

export const shortCode = (code) => (code || 'HQ').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-6) || 'HQ';
