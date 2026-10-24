import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';
import { runMigrations } from './migrations.js';
import { correlationId, requestLogger, rejectMongoOperators } from './middleware/request.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { serviceUnavailable } from './lib/errors.js';
import { authenticate } from './middleware/auth.js';
import authRoutes from './routes/v1/auth.js';
import adminRoutes from './routes/v1/admin.js';
import crmRoutes from './routes/v1/crm.js';
import roRoutes from './routes/v1/repairOrders.js';
import operationsRoutes from './routes/v1/operations.js';
import futuretechRoutes from './routes/v1/futuretech.js';
import engagementRoutes from './routes/v1/engagement.js';
import intelligenceRoutes from './routes/v1/intelligence.js';
import mongoose from 'mongoose';
// registers background job handlers
import './services/messageService.js';
import './services/intelligenceService.js';

let ready = null;
export const ensureReady = () => {
  if (!ready) {
    ready = connectDB().then(runMigrations).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
};

const app = express();
app.set('trust proxy', env.trustProxy);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-Match', 'X-Correlation-ID'],
  exposedHeaders: ['X-Correlation-ID', 'Idempotent-Replay'],
  maxAge: 600
}));
app.use(correlationId);
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    if (req.originalUrl.includes('/webhook') || req.originalUrl.includes('/automind/ingest')) req.rawBody = buf;
  }
}));
app.use(requestLogger);
app.use('/api', apiLimiter);
app.use(rejectMongoOperators);
app.use('/api', async (_req, _res, next) => {
  try {
    await ensureReady();
    next();
  } catch (err) {
    console.error('[db] not ready:', err.message);
    next(serviceUnavailable('Database is unavailable. Try again shortly.', 'DATABASE_UNAVAILABLE'));
  }
});

const health = (_req, res) => res.json({ success: true, status: 'healthy', apiVersion: 'v1', time: new Date().toISOString() });
app.get('/api/v1/health', health);
app.get('/api/health', health);
// Readiness: database connection usable
app.get('/api/v1/ready', (_req, res) => {
  const up = mongoose.connection.readyState === 1;
  res.status(up ? 200 : 503).json({ success: up, database: up ? 'connected' : 'unavailable' });
});

// Single authentication gate; only these paths are reachable without a session.
const PUBLIC_PATHS = [/^\/auth\//, /^\/health$/, /^\/ready$/, /^\/payments\/stripe\/webhook$/, /^\/internal\/jobs\/run$/, /^\/automind\/ingest$/];
app.use('/api/v1', (req, res, next) => (PUBLIC_PATHS.some(rx => rx.test(req.path)) ? next() : authenticate(req, res, next)));

const routers = [['/auth', authRoutes], ['', adminRoutes], ['', crmRoutes], ['', roRoutes], ['', operationsRoutes], ['', futuretechRoutes], ['', engagementRoutes], ['', intelligenceRoutes]];
for (const [prefix, router] of routers) {
  app.use(`/api/v1${prefix}`, router);
}

app.use('/api', notFoundHandler);
app.use(errorHandler);

export default app;
