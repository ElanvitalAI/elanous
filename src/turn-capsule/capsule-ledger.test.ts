import { describe, expect, test } from 'bun:test';
import {
  CAPSULE_LEDGER_COMPACT_LINES, INTERRUPTED_SUMMARY, compactLedger, encodeLedgerEntry, foldLedger, parseLedgerLine,
  reconcileLedger, type CapsuleLedgerEntry,
} from './capsule-ledger.js';

const start = (capsuleId: string, ownerPid = 100): CapsuleLedgerEntry => ({
  op: 'start', capsuleId, kind: 'agent', sessionId: 's-1', ownerPid, ownerStartedAt: 5, startedAt: 10, label: `L-${capsuleId}`,
});
const done = (capsuleId: string, status: 'ok' | 'failed' = 'ok'): CapsuleLedgerEntry => ({
  op: 'done', capsuleId, status, endedAt: 50, summary: `${capsuleId} · ${status}`,
});
const delivered = (ids: string[]): CapsuleLedgerEntry => ({ op: 'delivered', capsuleIds: ids, turnId: 'tui-3', at: 60 });

describe('capsule ledger (K3-a)', () => {
  test('encode → parse round-trips each op; a torn or malformed line is skipped (null), never fatal', () => {
    for (const entry of [start('a'), done('a'), delivered(['a'])]) {
      expect(parseLedgerLine(encodeLedgerEntry(entry).trimEnd())).toEqual(entry);
    }
    expect(parseLedgerLine('{"op":"start","capsuleId":"a","ki')).toBeNull();
    expect(parseLedgerLine(JSON.stringify({ ...start('a'), kind: 'daemon' }))).toBeNull();
    expect(parseLedgerLine(JSON.stringify({ ...done('a'), status: 'done' }))).toBeNull();
    expect(parseLedgerLine(JSON.stringify({ op: 'delivered', capsuleIds: [''], turnId: 't', at: 1 }))).toBeNull();
  });

  test('fold: one record per capsule in first-seen order · first done wins · delivered marks every listed id', () => {
    const records = foldLedger([start('a'), start('b'), done('b', 'failed'), done('b', 'ok'), delivered(['b', 'x'])]);
    expect(records.map((r) => [r.capsuleId, r.done?.status ?? null, r.delivered])).toEqual([
      ['a', null, false], ['b', 'failed', true], ['x', null, true],
    ]);
  });

  test('reconcile: dead owner ∧ no done → interrupted (cancelled) · done ∧ undelivered → reported · live running untouched', () => {
    const entries = [start('dead', 1), start('live', 2), start('fin', 1), done('fin'), start('old', 1), done('old'), delivered(['old'])];
    const alive = (pid: number, startedAt: number) => pid === 2 && startedAt === 5;
    const result = reconcileLedger(entries, alive, 999);
    expect(result.interrupted).toEqual([{ op: 'done', capsuleId: 'dead', status: 'cancelled', endedAt: 999, summary: INTERRUPTED_SUMMARY }]);
    expect(result.undelivered.map((r) => [r.capsuleId, r.done?.status])).toEqual([['dead', 'cancelled'], ['fin', 'ok']]);
  });

  test('reconcile: pid reuse — same pid, different start time = dead owner', () => {
    const result = reconcileLedger([start('a', 7)], (pid, startedAt) => pid === 7 && startedAt === 6, 1);
    expect(result.interrupted.map((d) => d.capsuleId)).toEqual(['a']);
  });

  test('reconcile twice after appending the interrupted lines is stable: no second interruption', () => {
    const entries = [start('dead', 1)];
    const first = reconcileLedger(entries, () => false, 10);
    const second = reconcileLedger([...entries, ...first.interrupted], () => false, 20);
    expect(second.interrupted).toEqual([]);
    expect(second.undelivered.map((r) => r.done?.endedAt)).toEqual([10]);
  });

  test('compact: not needed under the threshold; past it, drops done ∧ delivered capsules and trims delivered lists', () => {
    const entries = [start('a'), done('a'), start('b'), done('b'), delivered(['a', 'c']), start('c')];
    expect(compactLedger(entries, CAPSULE_LEDGER_COMPACT_LINES)).toBeNull();
    expect(compactLedger(entries, CAPSULE_LEDGER_COMPACT_LINES + 1)).toEqual([
      start('b'), done('b'), { op: 'delivered', capsuleIds: ['c'], turnId: 'tui-3', at: 60 }, start('c'),
    ]);
  });
});
