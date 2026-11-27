import { expect, test } from 'bun:test';
import { planScheduledGraph } from './scheduled-graph-plan.js';

const schedule = { version: '0.3.38', rehearsalAt: '2026-11-27T08:00Z', cutAt: '2026-11-27T09:00Z', publishAt: '2026-11-27T10:00Z' };
const base = { mode: 'live' as const, version: schedule.version, schedule, now: new Date('2026-11-27T09:00Z'), hasRun: false };
test('only the configured live version without a run and a complete due schedule is eligible', () => {
  expect(planScheduledGraph(base).kind).toBe('due');
  expect(planScheduledGraph({ ...base, mode: 'shadow' }).kind).toBe('none');
  expect(planScheduledGraph({ ...base, hasRun: true }).kind).toBe('none');
  expect(planScheduledGraph({ ...base, now: new Date('2026-11-27T08:59Z') }).kind).toBe('red');
  expect(planScheduledGraph({ ...base, schedule: null }).kind).toBe('red');
  expect(planScheduledGraph({ ...base, schedule: { ...schedule, version: '0.3.39' } }).kind).toBe('red');
});
test('missing and invalid required times cannot be inferred', () => {
  for (const field of ['rehearsalAt', 'cutAt', 'publishAt'] as const) {
    const result = planScheduledGraph({ ...base, schedule: { ...schedule, [field]: undefined } });
    expect(result).toEqual({ kind: 'red', version: schedule.version, reason: `live version has no run: ${field} is missing or invalid` });
  }
});
