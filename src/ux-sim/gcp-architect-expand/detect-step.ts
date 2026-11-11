import { authorizeSingleGcp } from './consumer.js';
import { readLocalPressure } from './local-signals.js';

export function runDetectStep(): void {
// The public entry has only free grants. No graph input can claim a paid membership.
const grant = authorizeSingleGcp({ currentTier: () => 'free' });
if (!grant.allowed) {
  console.log(JSON.stringify({ outcome: 'fail', reason: `entitlement:${grant.reason}` }));
} else {
  const signal = readLocalPressure();
  const axes = [signal.cpu, signal.memory, signal.disk, signal.queue];
  const outcome = signal.shortage ? 'shortage' : axes.some(axis => axis.status === 'unknown') ? 'unknown' : 'none';
  console.log(JSON.stringify({ outcome, signal }));
}
}
if (import.meta.main) runDetectStep();
