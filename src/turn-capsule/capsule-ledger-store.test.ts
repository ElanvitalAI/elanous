import { describe, expect, spyOn, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { CAPSULE_LEDGER_COMPACT_LINES, INTERRUPTED_SUMMARY, type CapsuleLedgerEntry } from './capsule-ledger.js';
import { capsuleLedgerPath, createCapsuleLedgerStore, defaultOwnerAlive } from './capsule-ledger-store.js';

const start = (capsuleId: string, ownerPid: number): CapsuleLedgerEntry => ({
  op: 'start', capsuleId, kind: 'agent', sessionId: 's-1', ownerPid, ownerStartedAt: 5, startedAt: 10, label: capsuleId,
});
const withDir = (run: (path: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-ledger-'));
  try { run(join(dir, 'nested', 'capsule-ledger.jsonl')); } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('capsule ledger store (K3-b)', () => {
  test('append creates the directory and file; read skips a torn last line (crash mid-write)', () => withDir((path) => {
    const store = createCapsuleLedgerStore(path, () => true);
    expect(store.append(start('a', 1))).toBe(true);
    appendFileSync(path, '{"op":"done","capsuleId":"a","sta');
    const { entries, lines } = store.read();
    expect(lines).toBe(2);
    expect(entries).toEqual([start('a', 1)]);
  }));

  test('crash then append: a torn tail is healed with a newline so the next valid entry survives (JUD #38615)', () => withDir((path) => {
    const store = createCapsuleLedgerStore(path, () => true);
    expect(store.append(start('a', 1))).toBe(true);
    appendFileSync(path, '{"op":"done","capsuleId":"a","sta');
    expect(store.append(start('b', 1))).toBe(true);
    const { entries, lines } = store.read();
    expect(lines).toBe(3); // 출처: #38615 유효 2줄 + 찢긴 1줄
    expect(entries).toEqual([start('a', 1), start('b', 1)]);
  }));

  test('boot: a dead owner\'s running capsule is appended as interrupted, once; turn-life logged', () => withDir((path) => {
    const log = spyOn(debug, 'log');
    const store = createCapsuleLedgerStore(path, (pid) => pid === 2);
    store.append(start('dead', 1));
    store.append(start('live', 2));
    const first = store.reconcileAtBoot(100);
    const second = store.reconcileAtBoot(200);
    const reconciled = log.mock.calls.filter((call) => call[0] === 'turn-life' && call[1] === 'turn-life:capsule-ledger-reconciled');
    log.mockRestore();
    expect(first.interrupted.map((e) => e.capsuleId)).toEqual(['dead']);
    expect(second.interrupted).toEqual([]);
    expect(second.undelivered.map((r) => [r.capsuleId, r.done?.summary])).toEqual([['dead', INTERRUPTED_SUMMARY]]);
    expect(readFileSync(path, 'utf8').trim().split('\n').length).toBe(3);
    expect(reconciled.map((call) => call[2])).toEqual([
      { interrupted: 1, undelivered: 1, ledgerLines: 2, compacted: false },
      { interrupted: 0, undelivered: 1, ledgerLines: 3, compacted: false },
    ]);
  }));

  test('boot past the compaction threshold rewrites the file without done ∧ delivered capsules', () => withDir((path) => {
    const store = createCapsuleLedgerStore(path, () => true);
    store.append(start('keep', 1));
    const filler: string[] = [];
    for (let i = 0; i <= CAPSULE_LEDGER_COMPACT_LINES / 3; i++) {
      filler.push(JSON.stringify(start(`f${i}`, 1)), JSON.stringify({ op: 'done', capsuleId: `f${i}`, status: 'ok', endedAt: 1, summary: '' }),
        JSON.stringify({ op: 'delivered', capsuleIds: [`f${i}`], turnId: 't', at: 2 }));
    }
    appendFileSync(path, `${filler.join('\n')}\n`);
    store.reconcileAtBoot(1);
    expect(store.read().entries).toEqual([start('keep', 1)]);
  }));

  test('an unreadable or unwritable ledger is fail-open: no throw, empty report', () => {
    const store = createCapsuleLedgerStore('/dev/null/capsule-ledger.jsonl', () => false);
    expect(store.append(start('a', 1))).toBe(false);
    expect(store.reconcileAtBoot(1)).toEqual({ interrupted: [], undelivered: [] });
  });

  test('owner check: same pid with a start time within tolerance is alive; other start time or ps failure is dead', () => {
    const alive = defaultOwnerAlive((pid) => (pid === 7 ? 1_000_000 : null));
    expect(alive(7, 1_000_000)).toBe(true);
    expect(alive(7, 1_000_000 - 60_000)).toBe(false);
    expect(alive(8, 1_000_000)).toBe(false);
    expect(alive(-1, 0)).toBe(false);
    expect(defaultOwnerAlive(() => { throw new Error('ps missing'); })(7, 1)).toBe(false);
  });

  test('path follows ELANOUS_DATA_DIR', () => {
    expect(capsuleLedgerPath({ ELANOUS_DATA_DIR: '/x/data' })).toBe('/x/data/capsule-ledger.jsonl');
  });
});
