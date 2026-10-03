import { describe, expect, test } from 'bun:test';
import { predecessorMerged, predecessorState } from './dependency-state.js';
import type { RunLedgerMatch, RunLedgerEntry } from '../self-implement/run-ledger.js';

const ledger = (goalId: string, number: number, merged: boolean): RunLedgerMatch => ({
  runId: 'run-test', ledgerDirectory: '/test', ledgerPath: '/test/run-test.jsonl', targetName: null,
  entries: [
    { runId: 'run-test', goalId, event: 'start', data: {} },
    { runId: 'run-test', goalId, event: 'pr-opened', data: { number } },
    { runId: 'run-test', goalId, event: 'merged', data: { number, merged } },
  ] satisfies RunLedgerEntry[],
});

describe('Pod predecessor state', async () => {
  test('a PR number grants admission only on an observed MERGED state', async () => {
    expect(await predecessorMerged(123, { prState: () => 'OPEN' })).toBe(false);
    expect(await predecessorMerged('#123', { prState: () => 'CLOSED' })).toBe(false);
    expect(await predecessorMerged(123, { prState: () => 'MERGED' })).toBe(true);
    expect(await predecessorMerged(123, { prState: () => { throw new Error('unavailable'); } })).toBe(false);
    expect(await predecessorMerged(0, { prState: () => 'MERGED' })).toBe(false);
  });

  test('a goal ID requires an exact run-ledger PR whose GitHub state is merged', async () => {
    const existing = ledger('goal-before', 123, true);
    const numericGoal = '1234567890123456';
    expect(await predecessorMerged(numericGoal, { ledgers: () => [ledger(numericGoal, 123, true)], prState: (n) => n === 123 ? 'MERGED' : 'OPEN' })).toBe(true);
    expect(await predecessorMerged('goal-before', { ledgers: () => [existing], prState: () => 'OPEN' })).toBe(false);
    expect(await predecessorMerged('goal-before', { ledgers: () => [existing], prState: () => 'MERGED' })).toBe(true);
    expect(await predecessorMerged('other-goal', { ledgers: () => [existing], prState: () => 'MERGED' })).toBe(false);
    expect(await predecessorMerged('goal-before', { ledgers: () => [ledger('goal-before', 123, false)], prState: () => 'MERGED' })).toBe(true);
    expect(await predecessorMerged('goal-before', { ledgers: () => [existing, existing], prState: () => 'MERGED' })).toBe(true);
    expect(await predecessorMerged('goal-before', { ledgers: () => [existing, ledger('goal-before', 124, true)], prState: (n) => n === 124 ? 'MERGED' : 'OPEN' })).toBe(true);
    const checked: number[] = [];
    expect(await predecessorMerged('goal-before', {
      ledgers: () => [existing, ledger('goal-before', 124, true)],
      prState: (n) => { checked.push(n); if (n === 123) throw new Error('PR 123 unavailable'); return 'MERGED'; },
    })).toBe(true);
    expect(checked).toEqual([123, 124]);
    expect(await predecessorMerged('goal-before', { ledgers: () => [{ ...existing, entries: existing.entries.filter((entry) => entry.event !== 'pr-opened') }], prState: () => 'MERGED' })).toBe(false);
    expect(await predecessorMerged('goal-before', { ledgers: () => [{ ...existing, entries: [existing.entries[0]!, { ...existing.entries[1]!, goalId: 'other-goal' }] }], prState: () => 'MERGED' })).toBe(false);
    expect(await predecessorMerged('goal-before', { ledgers: () => { throw new Error('unavailable'); }, prState: () => 'MERGED' })).toBe(false);
  });
  test('a predecessor closed without merging is blocked; open or unknown stays waiting', async () => {
    expect(await predecessorState(123, { prState: () => 'CLOSED' })).toBe('blocked');
    expect(await predecessorState('#123', { prState: () => 'OPEN' })).toBe('waiting');
    expect(await predecessorState(123, { prState: () => null })).toBe('waiting');
    expect(await predecessorState('goal-before', { ledgers: () => [ledger('goal-before', 123, false), ledger('goal-before', 124, false)], prState: () => 'CLOSED' })).toBe('blocked');
    expect(await predecessorState('goal-before', { ledgers: () => [ledger('goal-before', 123, false), ledger('goal-before', 124, false)], prState: (n) => n === 123 ? 'CLOSED' : 'OPEN' })).toBe('waiting');
    expect(await predecessorState('goal-before', { ledgers: () => [], prState: () => 'CLOSED' })).toBe('waiting');
  });

  test('a slow PR lookup is asynchronous and receives the cancellation signal', async () => {
    let finish!: (state: string) => void;
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    const pending = predecessorState(123, { prState: (_n, signal) => { seen = signal; return new Promise((resolve) => { finish = resolve; }); } }, controller.signal);
    let loopRan = false;
    setTimeout(() => { loopRan = true; }, 0);
    await Bun.sleep(5);
    expect(loopRan).toBe(true);
    expect(seen).toBe(controller.signal);
    controller.abort();
    expect(seen?.aborted).toBe(true);
    finish('MERGED');
    expect(await pending).toBe('merged');
  });
});
