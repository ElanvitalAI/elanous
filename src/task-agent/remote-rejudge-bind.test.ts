import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteLedgerMirrorDir } from './parent-host.js';
import { rejudgeCandidates } from './rejudge-on-head.js';
import { bindMirroredRemoteRejudgeCards } from './remote-rejudge-bind.js';
import { readTaskAgentState, writeTaskCards, type TaskCard } from './task-hand.js';

const parent = 'run-11111111-1111-4111-8111-111111111111';
const child = 'run-22222222-2222-4222-8222-222222222222';
const url = 'https://github.com/ElanvitalAI/elanous/pull/26926';
const now = Date.parse('2026-10-12T12:00:00.000Z');
const mirrored = { now: () => now, mirror: () => [] };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'remote-rejudge-bind-'));
  const statePath = join(root, 'task-agent-actions.json');
  const card: TaskCard = { id: 'ta-remote-parent', text: 'repair existing PR', status: 'launched', taLand: true,
    runId: parent, parentHost: { host: 'node-b' }, createdAt: '2026-10-12T00:00:00.000Z', history: [] };
  writeTaskCards(statePath, [card]);
  const ledger = (host: string, runId: string, rows: Array<{ event: string; data: Record<string, unknown> }>) => {
    const dir = remoteLedgerMirrorDir(root, host);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${runId}.jsonl`), rows.map((row) => JSON.stringify({ runId, ...row })).join('\n') + '\n');
  };
  const cards = () => readTaskAgentState<{ tasks: Record<string, TaskCard> }>(statePath).tasks;
  return { root, statePath, card, ledger, cards, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('remote parent mirror binds exact child PR before rejudge candidate selection; repeat is idempotent', async () => {
  const f = setup();
  try {
    f.ledger('node-b', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
    f.ledger('node-b', child, [{ event: 'pr-opened', data: { number: 26926, url, goalId: 'a'.repeat(16) } },
      { event: 'run-status', data: { runStatus: 'completed' } }]);
    expect(rejudgeCandidates(f.cards())).toEqual([]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 1, skipped: 0 });
    expect(f.cards()[f.card.id]).toMatchObject({ runId: parent, runChildId: child, pr: { number: 26926, url }, goalId: 'a'.repeat(16) });
    expect(rejudgeCandidates(f.cards())).toEqual([f.card.id]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 0, bound: 0, skipped: 0 });
  } finally { f.cleanup(); }
});

test('child-only, wrong-host, incomplete and non-TA mirrors do not bind or create cards', async () => {
  const f = setup();
  try {
    f.ledger('node-b', child, [{ event: 'pr-opened', data: { number: 26926, url } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1 });
    f.ledger('other-host', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1 });
    f.ledger('node-b', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
    rmSync(join(remoteLedgerMirrorDir(f.root, 'node-b'), `${child}.jsonl`));
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1 });
    f.ledger('node-b', child, [{ event: 'pr-opened', data: { number: 26926, url } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1 });
    expect(f.cards()[f.card.id]?.pr).toBeUndefined();
    f.ledger('node-b', parent, [{ event: 'pod-ledger-incomplete', data: { reason: 'child-ledger-missing' } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1 });
    writeTaskCards(f.statePath, [{ ...f.card, taLand: undefined }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 0, bound: 0, skipped: 0 });
    expect(f.cards()[f.card.id]?.pr).toBeUndefined();
    expect(Object.keys(f.cards())).toEqual([f.card.id]);
  } finally { f.cleanup(); }
});

test('fresh remote TA card pulls parent and child ledgers before PR selection', async () => {
  const f = setup();
  try {
    const calls: string[] = [];
    const mirror = ((target: { host: string }, runId: string, root: string) => {
      calls.push(`${target.host}:${runId}`);
      expect(root).toBe(f.root);
      f.ledger('node-b', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
      f.ledger('node-b', child, [{ event: 'pr-opened', data: { number: 26926, url } },
        { event: 'run-status', data: { runStatus: 'completed' } }]);
      return [parent, child];
    }) as typeof import('./parent-host.js').mirrorRemoteRunLedgers;
    expect(rejudgeCandidates(f.cards())).toEqual([]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, { now: () => now, mirror }))
      .toEqual({ scanned: 1, bound: 1, skipped: 0 });
    expect(calls).toEqual([`node-b:${parent}`]);
    expect(rejudgeCandidates(f.cards())).toEqual([f.card.id]);
  } finally { f.cleanup(); }
});

test('remote pulling is limited to unbound TA launches from the last 24 hours', async () => {
  const f = setup();
  try {
    const cards: TaskCard[] = [
      { ...f.card, createdAt: '2026-10-11T11:59:59.000Z' },
      { ...f.card, id: 'not-ta', taLand: undefined },
      { ...f.card, id: 'local', parentHost: undefined },
      { ...f.card, id: 'already-bound', pr: { number: 26926, url } },
      { ...f.card, id: 'future', createdAt: '2026-10-12T12:00:01.000Z' },
    ];
    writeTaskCards(f.statePath, cards);
    let pulls = 0;
    const mirror = (() => { pulls++; return []; }) as typeof import('./parent-host.js').mirrorRemoteRunLedgers;
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, { now: () => now, mirror }))
      .toEqual({ scanned: 2, bound: 0, skipped: 2 });
    expect(pulls).toBe(0);
  } finally { f.cleanup(); }
});

test('an older TA card binds from existing HQ parent and child mirrors without a remote pull', async () => {
  const f = setup();
  try {
    f.ledger('node-b', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
    f.ledger('node-b', child, [{ event: 'pr-opened', data: { number: 26926, url } },
      { event: 'run-status', data: { runStatus: 'completed' } }]);
    writeTaskCards(f.statePath, [{ ...f.card, createdAt: '2026-10-11T11:59:59.000Z' }]);
    let pulls = 0;
    const mirror = (() => { pulls++; return []; }) as typeof import('./parent-host.js').mirrorRemoteRunLedgers;
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, { now: () => now, mirror }))
      .toEqual({ scanned: 1, bound: 1, skipped: 0 });
    expect(pulls).toBe(0);
    expect(f.cards()[f.card.id]?.pr).toMatchObject({ number: 26926, url });
  } finally { f.cleanup(); }
});

test('a recent relaunch may pull remote ledgers even when the card was created earlier', async () => {
  const f = setup();
  try {
    let pulls = 0;
    const mirror = (() => { pulls++; return []; }) as typeof import('./parent-host.js').mirrorRemoteRunLedgers;
    writeTaskCards(f.statePath, [{ ...f.card, createdAt: '2026-10-10T00:00:00.000Z',
      history: [{ at: '2026-10-12T11:00:00.000Z', event: 'launch' }] }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, { now: () => now, mirror }))
      .toEqual({ scanned: 1, bound: 0, skipped: 1 });
    expect(pulls).toBe(1);
  } finally { f.cleanup(); }
});

test('a child ledger read error is reported and does not prevent the next remote card from binding', async () => {
  const f = setup();
  try {
    const nextParent = 'run-33333333-3333-4333-8333-333333333333';
    const nextChild = 'run-44444444-4444-4444-8444-444444444444';
    const nextCard = { ...f.card, id: 'ta-next-parent', runId: nextParent };
    writeTaskCards(f.statePath, [nextCard]);
    const failures: Array<{ card: string; runId: string; host: string; reason: string }> = [];
    const mirror = ((_: { host: string }, runId: string) => {
      if (runId === parent) {
        f.ledger('node-b', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
        mkdirSync(join(remoteLedgerMirrorDir(f.root, 'node-b'), `${child}.jsonl`));
      } else {
        f.ledger('node-b', nextParent, [{ event: 'pod-child-run', data: { childRunId: nextChild } }]);
        f.ledger('node-b', nextChild, [{ event: 'pr-opened', data: { number: 26926, url } },
          { event: 'run-status', data: { runStatus: 'completed' } }]);
      }
      return [];
    }) as typeof import('./parent-host.js').mirrorRemoteRunLedgers;
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, {
      now: () => now, mirror, onFailure: failure => failures.push(failure),
    })).toEqual({ scanned: 2, bound: 1, skipped: 1 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ card: f.card.id, runId: parent, host: 'node-b' });
    expect(failures[0]?.reason).toContain(child);
    expect(f.cards()[f.card.id]?.pr).toBeUndefined();
    expect(f.cards()[nextCard.id]?.pr).toMatchObject({ number: 26926, url });
  } finally { f.cleanup(); }
});
