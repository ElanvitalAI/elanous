import { describe, expect, test } from 'bun:test';
import { writePtyWithOutcome, writePtyWithOutcomeDetail } from './pty-write-outcome.js';
import type { PtyHandle } from './registry.js';

function handle(canWrite: boolean, write: () => void): PtyHandle {
  return { canWrite: () => canWrite, write } as unknown as PtyHandle;
}

describe('writePtyWithOutcome', () => {
  test('preserves success, denied, and write-failed outcomes without event listeners', () => {
    let writes = 0;
    expect(writePtyWithOutcome(handle(true, () => { writes++; }), 'ok')).toBe('success');
    expect(writes).toBe(1);
    expect(writePtyWithOutcome(handle(false, () => { writes++; }), 'blocked')).toBe('denied');
    expect(writes).toBe(1);
    expect(writePtyWithOutcome(handle(true, () => { throw new Error('closed'); }), 'failed')).toBe('write-failed');
  });

  test('preserves recognized external-input refusal reasons but not arbitrary adapter errors', () => {
    for (const reason of ['tui-busy-text-without-enter', 'tui-external-input-queue-full'] as const) {
      expect(writePtyWithOutcomeDetail(handle(true, () => { throw new Error(reason); }), 'refused'))
        .toEqual({ status: 'write-failed', reason });
    }
    expect(writePtyWithOutcomeDetail(handle(true, () => { throw new Error('private adapter detail'); }), 'failed'))
      .toEqual({ status: 'write-failed' });
  });
});
