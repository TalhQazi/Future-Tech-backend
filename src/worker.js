// Dedicated background worker: node src/worker.js
import { assertConfig } from './config/env.js';
import { ensureReady } from './app.js';
import { startInProcessWorker } from './services/jobService.js';

assertConfig();
ensureReady()
  .then(() => startInProcessWorker(5000))
  .catch((err) => {
    console.error('[worker] startup failed:', err.message);
    process.exit(1);
  });
