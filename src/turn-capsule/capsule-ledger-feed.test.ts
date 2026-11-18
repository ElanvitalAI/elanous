import { describe, expect, test } from 'bun:test';
import { foldLedger, reconcileLedger } from './capsule-ledger.js';
import { BOOT_NOTICE_NAMED_MAX, bootCapsuleNotice, deliveredEntry, ledgerEntriesFromFrame } from './capsule-ledger-feed.js';

const owner = { pid: 42, startedAt: 1_000 };

describe('capsule ledger feed (K3-c pure)', () => {
  test('progress first → start once; done later → done only · a done with no progress → start + done', () => {
    const seen = new Set<string>();
    expect(ledgerEntriesFromFrame({ type: 'capsule-progress', capsuleId: 'a', kind: 'agent', sessionId: 's', at: 5, line: 'scan · started' }, owner, seen))
      .toEqual([{ op: 'start', capsuleId: 'a', kind: 'agent', sessionId: 's', ownerPid: 42, ownerStartedAt: 1_000, startedAt: 5, label: 'scan · started' }]);
    expect(ledgerEntriesFromFrame({ type: 'capsule-progress', capsuleId: 'a', kind: 'agent', sessionId: 's', at: 6, line: 'scan · #2 Grep' }, owner, seen)).toEqual([]);
    expect(ledgerEntriesFromFrame({ type: 'capsule-done', capsuleId: 'a', kind: 'agent', sessionId: 's', startedAt: 5, endedAt: 9, status: 'ok', summary: 'scan · ok · 0s' }, owner, seen))
      .toEqual([{ op: 'done', capsuleId: 'a', status: 'ok', endedAt: 9, summary: 'scan · ok · 0s' }]);
    expect(ledgerEntriesFromFrame({ type: 'capsule-done', capsuleId: 'b', kind: 'agent', sessionId: 's', startedAt: 3, endedAt: 4, status: 'failed', summary: 'b · failed · 0s' }, owner, seen)
      .map((entry) => entry.op)).toEqual(['start', 'done']);
  });

  test('delivered only when the notice turn responded and named capsules', () => {
    expect(deliveredEntry(['a'], 'tui-4', 'responded', 9)).toEqual({ op: 'delivered', capsuleIds: ['a'], turnId: 'tui-4', at: 9 });
    for (const outcome of ['failed', 'cancelled', 'stopped']) expect(deliveredEntry(['a'], 'tui-4', outcome, 9)).toBeNull();
    expect(deliveredEntry([], 'tui-4', 'responded', 9)).toBeNull();
  });

  test('boot notice: counts done vs interrupted, names each with its capsule id; nothing → null', () => {
    const seen = new Set<string>();
    const entries = [
      ...ledgerEntriesFromFrame({ type: 'capsule-progress', capsuleId: 'run', kind: 'agent', sessionId: 's', at: 1, line: 'long scan' }, owner, seen),
      ...ledgerEntriesFromFrame({ type: 'capsule-done', capsuleId: 'fin', kind: 'agent', sessionId: 's', startedAt: 1, endedAt: 2, status: 'ok', summary: 'lint · ok · 1s' }, owner, seen),
    ];
    const { undelivered } = reconcileLedger(entries, () => false, 50);
    expect(bootCapsuleNotice(undelivered)).toEqual({
      text: '재기동 전 캡슐 2건(완료 1 · 중단 1): long scan — cancelled · capsule:run / lint · ok · 1s — ok · capsule:fin',
      capsuleIds: ['run', 'fin'],
    });
    expect(bootCapsuleNotice([])).toBeNull();
    expect(bootCapsuleNotice(foldLedger(entries.filter((entry) => entry.op === 'start')))).toBeNull();
  });

  test('boot notice names at most the cap and counts the rest; every id is still listed for delivery', () => {
    const seen = new Set<string>();
    const entries = Array.from({ length: BOOT_NOTICE_NAMED_MAX + 2 }, (_, i) => ledgerEntriesFromFrame(
      { type: 'capsule-done', capsuleId: `c${i}`, kind: 'agent', sessionId: 's', startedAt: 1, endedAt: 2, status: 'ok', summary: `t${i}` }, owner, seen)).flat();
    const notice = bootCapsuleNotice(reconcileLedger(entries, () => true, 3).undelivered)!;
    expect(notice.text.endsWith(' · 외 2건')).toBe(true);
    expect(notice.capsuleIds.length).toBe(BOOT_NOTICE_NAMED_MAX + 2);
  });
});
