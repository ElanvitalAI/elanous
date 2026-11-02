import { describe, expect, test } from 'bun:test';
import {
  compareFrozenDispatcherSnapshot,
  frozenDispatcherSnapshotHash,
  type FrozenDispatcherCell,
  type FrozenDispatcherSnapshot,
} from './entrance-dispatch-shadow-adapter.js';

function cell(cellId: string, shellDecision: 'would-run' | 'would-skip', seat: FrozenDispatcherCell['seat'] = 'OP'): FrozenDispatcherCell {
  return {
    cellId, cardId: `card-${cellId}`, title: `frozen ${cellId}`, seat, version: '0.2.45',
    candidateKey: (cellId === 'CELL-P0' ? 'a' : 'b').repeat(64),
    shellDecision, shellReason: shellDecision === 'would-run' ? 'mock capacity admitted' : 'picker:priority-outside',
  };
}

function snapshot(cycleId = 'same-frozen-cycle-1'): FrozenDispatcherSnapshot {
  return {
    cycleId, at: '2026-11-02T00:00:00.000Z',
    cells: [cell('CELL-P0', 'would-run'), cell('CELL-P1', 'would-skip')],
  };
}

describe('entrance dispatcher graph shadow adapter', () => {
  test('compares observed graph launch rows and marks absent per-cell outcomes unobserved', async () => {
    const frozen = snapshot();
    const compared = await compareFrozenDispatcherSnapshot(frozen);

    expect(compared.map(row => [row.cellId, row.shellDecision, row.graphDecision, row.parity])).toEqual([
      ['CELL-P0', 'would-run', 'would-run', true],
      ['CELL-P1', 'would-skip', 'unobserved', null],
    ]);
    expect(compared[0]?.graphStatus).toBe('would-launch');
    expect(compared.map(row => row.snapshotHash)).toEqual([frozenDispatcherSnapshotHash(frozen), frozenDispatcherSnapshotHash(frozen)]);
    expect(compared.every(row => /^[a-f0-9]{64}$/.test(row.snapshotHash))).toBe(true);
  });

  test('keeps a real disagreement visible and never turns missing graph evidence into parity', async () => {
    const disagreement = snapshot('disagreement');
    disagreement.cells[0]!.shellDecision = 'would-skip';
    const compared = await compareFrozenDispatcherSnapshot(disagreement);
    expect(compared[0]).toMatchObject({ graphDecision: 'would-run', parity: false });

    const noInventory = await compareFrozenDispatcherSnapshot({
      ...snapshot('incomplete-inventory'), cells: [cell('CELL-P0', 'would-skip')],
    }, { inventory: 'incomplete' });
    expect(noInventory[0]).toMatchObject({ graphDecision: 'unobserved', parity: null });
    await expect(compareFrozenDispatcherSnapshot(snapshot('failed-inventory'), { failLaunchInventory: true }))
      .rejects.toThrow('mock launch inventory failure');
  });

  test('hashes the execution order and exposes capacity-dependent row selection', async () => {
    const forward = { ...snapshot('order'), cells: [cell('CELL-P0', 'would-run'), cell('CELL-P1', 'would-run')] };
    const reverse = { ...forward, cells: [...forward.cells].reverse() };
    expect(frozenDispatcherSnapshotHash(reverse)).not.toBe(frozenDispatcherSnapshotHash(forward));
    const [forwardResult, reverseResult] = await Promise.all([
      compareFrozenDispatcherSnapshot(forward), compareFrozenDispatcherSnapshot(reverse),
    ]);
    expect(forwardResult.map(row => [row.cellId, row.graphDecision])).toEqual([
      ['CELL-P0', 'would-run'], ['CELL-P1', 'unobserved'],
    ]);
    expect(reverseResult.map(row => [row.cellId, row.graphDecision])).toEqual([
      ['CELL-P1', 'would-run'], ['CELL-P0', 'unobserved'],
    ]);

    const saturated = { ...snapshot('saturated'), cells: [cell('CELL-P0', 'would-run')], runningBySeat: { OP: 20 } };
    const saturatedResult = await compareFrozenDispatcherSnapshot(saturated);
    expect(saturatedResult[0]).toMatchObject({ graphDecision: 'unobserved', parity: null });
  });

  test('rejects duplicate and ambiguous graph identity before execution', async () => {
    const duplicate = snapshot('duplicate');
    duplicate.cells[1] = { ...duplicate.cells[1]!, cellId: duplicate.cells[0]!.cellId };
    await expect(compareFrozenDispatcherSnapshot(duplicate)).rejects.toThrow('duplicate cell ID');

    const ambiguous = snapshot('ambiguous');
    ambiguous.cells[0]!.cellId = 'CELL:0';
    await expect(compareFrozenDispatcherSnapshot(ambiguous)).rejects.toThrow('must not contain colon');
  });
});
