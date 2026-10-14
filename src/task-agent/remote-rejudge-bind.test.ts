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
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath)).toEqual({ scanned: 1, bound: 1, skipped: 0 });
    expect(f.cards()[f.card.id]).toMatchObject({ runId: parent, runChildId: child, pr: { number: 26926, url }, goalId: 'a'.repeat(16) });
    expect(rejudgeCandidates(f.cards())).toEqual([f.card.id]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath)).toEqual({ scanned: 0, bound: 0, skipped: 0 });
  } finally { f.cleanup(); }
});

test('child-only, wrong-host, incomplete and non-TA mirrors do not bind or create cards', async () => {
  const f = setup();
  try {
    f.ledger('node-b', child, [{ event: 'pr-opened', data: { number: 26926, url } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath)).toEqual({ scanned: 1, bound: 0, skipped: 1 });
    f.ledger('other-host', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath)).toEqual({ scanned: 1, bound: 0, skipped: 1 });
    f.ledger('node-b', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
    rmSync(join(remoteLedgerMirrorDir(f.root, 'node-b'), `${child}.jsonl`));
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath)).toEqual({ scanned: 1, bound: 0, skipped: 1 });
    f.ledger('node-b', child, [{ event: 'pr-opened', data: { number: 26926, url } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath)).toEqual({ scanned: 1, bound: 0, skipped: 1 });
    expect(f.cards()[f.card.id]?.pr).toBeUndefined();
    f.ledger('node-b', parent, [{ event: 'pod-ledger-incomplete', data: { reason: 'child-ledger-missing' } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath)).toEqual({ scanned: 1, bound: 0, skipped: 1 });
    writeTaskCards(f.statePath, [{ ...f.card, taLand: undefined }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath)).toEqual({ scanned: 0, bound: 0, skipped: 0 });
    expect(f.cards()[f.card.id]?.pr).toBeUndefined();
    expect(Object.keys(f.cards())).toEqual([f.card.id]);
  } finally { f.cleanup(); }
});
