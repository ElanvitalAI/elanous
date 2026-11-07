import { describe, expect, test } from 'bun:test';
import { runMacrophageHeal, type MacrophageScrap } from './macrophage-heal.js';

const now = new Date('2026-11-06T00:00:00Z');

describe('release-loop macrophage live planner', () => {
  test('defaults to live decision events between phases without applying cleanup', () => {
    const inventory: MacrophageScrap[] = [
      { id: 'parked', kind: 'parked-pr', owner: 'seat-a', evidence: { repairRecipe: 'retry' } },
      { id: 'orphan', kind: 'orphan-job', evidence: { ownerRunStatus: 'done', ownershipVerified: true } },
    ];
    const deferred = runMacrophageHeal({ phase: 'active', mode: 'simulation', now, consecutiveFailureLimit: 3, inventory });
    expect(deferred).toEqual({ status: 'deferred', events: [], remaining: ['parked', 'orphan'] });

    const live = runMacrophageHeal({ phase: 'idle', now, consecutiveFailureLimit: 3, inventory });
    expect(live.status).toBe('planned');
    expect(live.events).toHaveLength(inventory.length);
    expect(live.events.every((event) => !event.applied && event.result.startsWith('planned ') && event.result.endsWith('; no cleanup applied'))).toBe(true);
    expect(live.remaining).toEqual(['parked', 'orphan']);
  });

  test('simulates only evidence-approved mutations inside the in-memory inventory', () => {
    const inventory: MacrophageScrap[] = [
      { id: 'draft-close', kind: 'stale-draft', owner: 'seat-a', evidence: { draftAction: 'close' } },
      { id: 'orphan-owned', kind: 'orphan-worktree', evidence: { ownerRunStatus: 'done', ownershipVerified: true } },
      { id: 'orphan-live', kind: 'orphan-pod', evidence: { ownerRunStatus: 'running', ownershipVerified: true } },
      { id: 'merged-worktree-live-owner', kind: 'orphan-worktree', owner: 'seat-live', evidence: {
        ownerRunStatus: 'running', ownershipVerified: true, mergedMainline: true, worktreePath: '/safe/worktree' } },
      { id: 'hold-expired', kind: 'expired-hold', owner: 'seat-b', evidence: { holdUntil: '2026-11-05T00:00:00Z' } },
      { id: 'hold-live-owner', kind: 'expired-hold', owner: 'seat-b', evidence: { holdUntil: '2026-11-05T00:00:00Z', ownerRunStatus: 'running' } },
      { id: 'draft-live-owner', kind: 'stale-draft', owner: 'seat-a', evidence: { draftAction: 'close', ownerRunStatus: 'running' } },
      { id: 'hold-future', kind: 'expired-hold', owner: 'seat-b', evidence: { holdUntil: '2026-11-07T00:00:00Z' } },
      { id: 'receipt-valid', kind: 'stale-receipt', evidence: { receiptStale: true, receiptVerified: true, ownerRunStatus: 'failed' } },
      { id: 'receipt-unverified', kind: 'stale-receipt', evidence: { receiptStale: true, receiptVerified: false, ownerRunStatus: 'done' } },
    ];
    const result = runMacrophageHeal({ phase: 'idle', mode: 'simulation', now, consecutiveFailureLimit: 3, inventory });
    expect(result.status).toBe('simulated');
    expect(result.events.filter((event) => event.applied).map((event) => event.id)).toEqual(['draft-close', 'orphan-owned', 'hold-expired', 'receipt-valid']);
    expect(result.remaining).toEqual(['orphan-live', 'merged-worktree-live-owner', 'hold-live-owner', 'draft-live-owner', 'hold-future', 'receipt-unverified']);
    expect(inventory.map((scrap) => scrap.id)).toHaveLength(10);
  });

  test('requires an explicit positive consecutive-failure threshold', () => {
    expect(() => runMacrophageHeal({ phase: 'idle', now, consecutiveFailureLimit: 0, inventory: [] })).toThrow(RangeError);
  });

  test('rejects duplicate identities and preserves unknown flaky evidence', () => {
    const duplicate: MacrophageScrap[] = [
      { id: 'same', kind: 'orphan-job', evidence: { ownerRunStatus: 'done', ownershipVerified: true } },
      { id: 'same', kind: 'orphan-pod', evidence: { ownerRunStatus: 'running', ownershipVerified: true } },
    ];
    expect(() => runMacrophageHeal({ phase: 'idle', mode: 'simulation', now, consecutiveFailureLimit: 3, inventory: duplicate })).toThrow(/unique/);
    const unknown = runMacrophageHeal({ phase: 'idle', now, consecutiveFailureLimit: 3,
      inventory: [{ id: 'test-unknown', kind: 'flaky-timeout-test', evidence: {} }] });
    expect(unknown.events[0]?.evidence).toContain('flaky=unknown; timeoutBurned=unknown');
    expect(unknown.events[0]?.action).toBe('retain');
  });
});
