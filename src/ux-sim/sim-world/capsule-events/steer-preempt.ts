import { createNextTuiQueue } from '../../../tui/core/queue.js';
import { createChildNoticeProducers } from '../../../tui/core/notice-producers.js';
import { wireCapsuleDoneKnock } from '../../../tui/capsule-done-knock.js';
import type { CapsuleEvent } from '../../../turn-capsule/contract.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

export const simWorldDevices: readonly SimWorldDeviceDef<{ burst: number }>[] = [{
  id: 'CAPSULE-BURST-137', title: '137 concurrent completion frames with three failures and a human interrupt',
  create: () => ({ burst: 137 }),
}];

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'SEAT-STEER-PREEMPT-137',
  title: 'one pending capsule summary, one wake, person before notice, no lost failure count',
  devices: ['CAPSULE-BURST-137'],
  async run(ctx) {
    const { burst } = ctx.device<{ burst: number }>('CAPSULE-BURST-137');
    const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
    const notices = createChildNoticeProducers(queue);
    let listener: ((event: CapsuleEvent) => void) | undefined;
    let wakes = 0;
    const stop = wireCapsuleDoneKnock({ sessionId: 'sim-seat',
      subscribe: (_sessionId, onEvent) => { listener = onEvent; return () => { listener = undefined; }; },
      enqueue: (event) => notices.capsuleDone(event, event.endedAt), knock: () => { wakes += 1; },
    });
    for (let i = 0; i < burst; i++) listener?.({ type: 'capsule-done', capsuleId: `sim-${i}`, kind: 'agent',
      sessionId: 'sim-seat', startedAt: 1, endedAt: 2, status: i < 3 ? 'failed' : 'ok', summary: `result ${i}` });
    listener?.({ type: 'capsule-done', capsuleId: 'sim-0', kind: 'agent', sessionId: 'sim-seat',
      startedAt: 1, endedAt: 2, status: 'failed', summary: 'duplicate' });
    const pending = queue.items[0];
    const bounded = queue.count === 1 && wakes === 0 && pending?.capsuleCount === burst && pending.capsuleFailed === 3;
    queue.enqueue('사람 Esc 또는 Ctrl+Q');
    const first = queue.dequeue();
    const consumedWithPerson = queue.consumeCapsuleDoneSummary();
    const personFirst = first.kind === 'submit' && first.itemKind === 'user'
      && consumedWithPerson && queue.count === 0;
    ctx.recorder.event('capsule-burst-coalesced', { burst, queueMax: 1, wakes, failed: pending?.capsuleFailed, bounded });
    ctx.recorder.event('capsule-burst-person-first', { personFirst, remaining: queue.count });
    stop();
    return bounded && personFirst ? { ok: true } : { ok: false,
      diff: `bounded=${bounded} personFirst=${personFirst} wakes=${wakes} count=${pending?.capsuleCount}` };
  },
}];
