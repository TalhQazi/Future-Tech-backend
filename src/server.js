import { env, assertConfig } from './config/env.js';
import app, { ensureReady } from './app.js';
import { startInProcessWorker } from './services/jobService.js';

assertConfig();

// On Vercel the app is exported as a function; elsewhere it listens on a port.
if (!process.env.VERCEL) {
  ensureReady()
    .then(() => {
      if (env.runWorkerInProcess) startInProcessWorker();
      app.listen(env.port, '0.0.0.0', () => console.log(`[api] FutureTech API listening on :${env.port} (/api/v1)`));
    })
    .catch((err) => {
      console.error('[api] startup failed:', err.message);
      process.exit(1);
    });
}

export default app;
