import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);

// One connection per process (and per warm serverless instance).
const state = globalThis.__ftMongo || (globalThis.__ftMongo = {
  promise: null,
  supportsTransactions: false
});

export const connectDB = async () => {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!state.promise) {
    state.promise = mongoose
      .connect(env.mongoUri, {
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 20,
        autoIndex: true
      })
      .then(async (m) => {
        try {
          const hello = await m.connection.db.admin().command({ hello: 1 });
          state.supportsTransactions = Boolean(hello.setName || hello.msg === 'isdbgrid');
        } catch {
          state.supportsTransactions = false;
        }
        if (!state.supportsTransactions) {
          console.warn('[db] MongoDB is not a replica set: multi-document transactions are unavailable. Use MongoDB Atlas or start mongod with --replSet for full integrity guarantees.');
        }
        console.log(`[db] MongoDB connected: ${m.connection.host}/${m.connection.name}`);
        return m.connection;
      })
      .catch((err) => {
        state.promise = null;
        throw err;
      });
  }
  return state.promise;
};

export const supportsTransactions = () => state.supportsTransactions;

/**
 * Runs fn inside a MongoDB transaction when the deployment supports it.
 * fn receives the session (or null) and must pass it to every read/write.
 * Business operations are additionally written with conditional atomic updates,
 * so they stay consistent even on a standalone development server.
 */
export const withTransaction = async (fn) => {
  if (!state.supportsTransactions) return fn(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return result;
  } finally {
    await session.endSession();
  }
};
