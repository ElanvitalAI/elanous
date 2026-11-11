import { expect, test } from 'bun:test';
import { validateProposalPressure } from '../../../../scripts/gcp-architect-expand/demo/pressure-input.js';

const measured = { observedAt: '2026-11-10T10:00:00.000Z', shortage: true,
  cpu: { status: 'shortage', observed: 1.2, source: 'self-dev/shard-run:load1/cores' },
  memory: { status: 'sufficient', observed: 8, source: 'self-dev/shard-run:freeMemoryGiB' },
  disk: { status: 'sufficient', observed: 20, source: 'self-dev/shard-run:freeTmpGiB' },
  queue: { status: 'shortage', observed: 14, source: 'harness/queue:queued' } };

test('existing measured pressure retains physical units and shortage axes', () => {
  const result = validateProposalPressure(measured);
  expect(result.source).toBe('existing-self-dev-and-harness-queue');
  expect(result.shortage).toEqual(['cpu', 'queue']);
  expect(JSON.stringify(result.signal)).toBe(JSON.stringify(measured));
});

test('unknown or invalid measured pressure and incomplete synthetic pressure fail closed', () => {
  for (const raw of [
    { ...measured, memory: { ...measured.memory, status: 'unknown', observed: null } },
    { ...measured, queue: { ...measured.queue, observed: 1.5 } },
    { ...measured, shortage: false },
    { cpuUsed: 0.9, memoryUsed: undefined, diskUsed: 0.9, queued: 14,
      observedAt: measured.observedAt, source: 'synthetic-demo-fixture' },
  ]) expect(() => validateProposalPressure(raw)).toThrow();
});
