import { parentPort, workerData } from 'node:worker_threads';
import { renewGuardianHostLease } from './resource-ledger.js';

interface HeartbeatWorkerData { leaseIds: string[]; ledgerPath: string; intervalMs: number; ttlMs: number }
const data = workerData as HeartbeatWorkerData;
if (!parentPort || !Array.isArray(data.leaseIds) || !data.ledgerPath || data.intervalMs <= 0 || data.ttlMs <= data.intervalMs)
  throw new Error('invalid Guardian lease heartbeat worker input');

const tick = () => {
  for (const leaseId of data.leaseIds) {
    try {
      const now = new Date();
      const renewed = renewGuardianHostLease(leaseId, new Date(now.getTime() + data.ttlMs).toISOString(), now, data.ledgerPath);
      if (!renewed) parentPort!.postMessage({ type: 'renewal-refused', leaseId });
    } catch (error) {
      parentPort!.postMessage({ type: 'renewal-failed', leaseId, error: String(error) });
    }
  }
};

const timer = setInterval(tick, data.intervalMs);
parentPort.on('message', message => {
  if (message === 'stop') {
    clearInterval(timer);
    parentPort?.close();
  }
});
