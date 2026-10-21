import os from 'os';
import { Job } from '../models/index.js';

// MongoDB-backed outbox / background jobs.
// - enqueueJob() is called inside the business transaction (pass the session)
//   so an event exists only if the business change committed.
// - processDueJobs() claims jobs with a lease; a crashed worker's lease expires
//   and another worker retries. Handlers must be idempotent.

const handlers = new Map();
const WORKER_ID = `${os.hostname()}:${process.pid}`;
const LEASE_MS = 2 * 60 * 1000;

export const registerJobHandler = (type, fn) => handlers.set(type, fn);

export const enqueueJob = async (type, payload = {}, dedupeKey, { runAt, session, maxAttempts } = {}) => {
  try {
    const [job] = await Job.create([{ type, payload, dedupeKey, runAt: runAt || new Date(), maxAttempts: maxAttempts || 8 }], { session });
    return job;
  } catch (err) {
    if (err?.code === 11000 && dedupeKey) return Job.findOne({ dedupeKey }).session(session || null);
    throw err;
  }
};

const backoffMs = (attempts) => Math.min(60 * 60 * 1000, 2 ** attempts * 15 * 1000);

const claimNext = () => {
  const now = new Date();
  return Job.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', runAt: { $lte: now } },
        { status: 'processing', lockedUntil: { $lt: now } } // abandoned lease
      ]
    },
    { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + LEASE_MS), lockedBy: WORKER_ID }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true }
  );
};

export const processDueJobs = async ({ limit = 25 } = {}) => {
  const results = { processed: 0, failed: 0, dead: 0 };
  for (let i = 0; i < limit; i += 1) {
    const job = await claimNext();
    if (!job) break;
    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for ${job.type}`);
      const result = await handler(job.payload, job);
      await Job.updateOne({ _id: job._id, lockedBy: WORKER_ID }, { $set: { status: 'completed', completedAt: new Date(), result: result ?? null, lockedUntil: null, lastError: null } });
      results.processed += 1;
    } catch (err) {
      const dead = job.attempts >= job.maxAttempts || err?.permanent;
      await Job.updateOne({ _id: job._id, lockedBy: WORKER_ID }, {
        $set: {
          status: dead ? 'dead' : 'pending',
          runAt: new Date(Date.now() + backoffMs(job.attempts)),
          lastError: String(err?.message || err).slice(0, 1000),
          lockedUntil: null
        }
      });
      if (dead) results.dead += 1; else results.failed += 1;
    }
  }
  return results;
};

let timer = null;
export const startInProcessWorker = (intervalMs = 10_000) => {
  if (timer) return;
  const tick = async () => {
    try {
      await processDueJobs();
    } catch (err) {
      console.error('[jobs] worker tick failed:', err.message);
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log(`[jobs] in-process worker started (${intervalMs} ms)`);
};

export const jobStats = async () => {
  const rows = await Job.aggregate([{ $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 } } }]);
  return rows.map(r => ({ type: r._id.type, status: r._id.status, count: r.n }));
};
