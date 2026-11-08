import { parentPort, workerData } from 'node:worker_threads';
import { createAppLifecycleEvent } from './app-lifecycle-ledger.js';
import { createAppLifecycleStore } from './app-db.js';

const input = workerData as { path: string; id: string };
const store = createAppLifecycleStore(input.path);
try {
  store.ensureCreated(createAppLifecycleEvent({ appId: 'voice-note', action: 'created', environment: 'simulation', actor: 'system' }, { id: () => input.id }));
  parentPort?.postMessage({ ok: true });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : 'unknown' });
} finally { store.close(); }
