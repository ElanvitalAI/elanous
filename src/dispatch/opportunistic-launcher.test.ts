import { expect, test } from 'bun:test';
import { OpportunisticLauncher } from './opportunistic-launcher.js';
import { ResourceScheduler } from './resource-scheduler.js';
import { TimeSlotManager } from './time-slot.js';

test('admission hold stops launch before reserving resources; observer gets rejection', async () => {
  const slot = new TimeSlotManager();
  const scheduler = new ResourceScheduler({ slot: () => slot.currentSlot() });
  const records: string[] = [];
  let launches = 0;
  const launcher = new OpportunisticLauncher({
    slot: () => slot.currentSlot(), scheduler,
    readyTasks: () => [{ id: 'held', priorityRank: 0, ready: true, capabilities: ['coding'] }],
    admit: () => 'budget-hold',
    launch: () => { launches++; },
    recordOutcome: (record) => { records.push(`${record.outcome}:${record.reason}`); },
  });
  const outcomes = await launcher.tick();
  expect(outcomes).toEqual([{ ok: false, taskId: 'held', reason: 'budget-hold' }]);
  expect(launches).toBe(0);
  expect(records).toEqual(['rejected:budget-hold']);
  expect(scheduler.inspect().modelInUse).toEqual({});
});
