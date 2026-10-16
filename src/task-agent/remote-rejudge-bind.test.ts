import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteLedgerMirrorDir } from './parent-host.js';
import { rejudgeCandidates, remoteBoundRunTerminal } from './rejudge-on-head.js';
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
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 1, skipped: 0, pulledUnmirrored: 0 });
    expect(f.cards()[f.card.id]).toMatchObject({ runId: parent, runChildId: child, pr: { number: 26926, url }, goalId: 'a'.repeat(16) });
    expect(rejudgeCandidates(f.cards())).toEqual([f.card.id]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 0, bound: 0, skipped: 0, pulledUnmirrored: 0 });
  } finally { f.cleanup(); }
});

test('child-only, wrong-host and incomplete mirrors do not bind or create cards', async () => {
  const f = setup();
  try {
    f.ledger('node-b', child, [{ event: 'pr-opened', data: { number: 26926, url } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1, pulledUnmirrored: 0 });
    f.ledger('other-host', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1, pulledUnmirrored: 0 });
    f.ledger('node-b', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
    rmSync(join(remoteLedgerMirrorDir(f.root, 'node-b'), `${child}.jsonl`));
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1, pulledUnmirrored: 0 });
    f.ledger('node-b', child, [{ event: 'pr-opened', data: { number: 26926, url } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1, pulledUnmirrored: 0 });
    expect(f.cards()[f.card.id]?.pr).toBeUndefined();
    f.ledger('node-b', parent, [{ event: 'pod-ledger-incomplete', data: { reason: 'child-ledger-missing' } }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1, pulledUnmirrored: 0 });
    writeTaskCards(f.statePath, [{ ...f.card, refSource: 'manual' }]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 0, bound: 0, skipped: 0, pulledUnmirrored: 0 });
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
      .toEqual({ scanned: 1, bound: 1, skipped: 0, pulledUnmirrored: 0 });
    expect(calls).toEqual([`node-b:${parent}`]);
    expect(rejudgeCandidates(f.cards())).toEqual([f.card.id]);
  } finally { f.cleanup(); }
});

test('remote pulling is limited to unbound launched cards from the last 24 hours', async () => {
  const f = setup();
  try {
    const cards: TaskCard[] = [
      { ...f.card, createdAt: '2026-10-11T11:59:59.000Z' },
      { ...f.card, id: 'not-launched', status: 'done' as TaskCard['status'] },
      { ...f.card, id: 'local', parentHost: undefined },
      { ...f.card, id: 'already-bound', pr: { number: 26926, url } },
      { ...f.card, id: 'future', createdAt: '2026-10-12T12:00:01.000Z' },
    ];
    writeTaskCards(f.statePath, cards);
    // 거울이 이미 있으면 24h 밖 카드는 당기지 않는다(TA-BIND-PULL-ONCE 는 «거울 없음»일 때만).
    f.ledger('node-b', parent, [{ event: 'start', data: {} }]);
    let pulls = 0;
    const mirror = (() => { pulls++; return []; }) as typeof import('./parent-host.js').mirrorRemoteRunLedgers;
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, { now: () => now, mirror }))
      .toEqual({ scanned: 2, bound: 0, skipped: 2, pulledUnmirrored: 0 });
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
      .toEqual({ scanned: 1, bound: 1, skipped: 0, pulledUnmirrored: 0 });
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
      .toEqual({ scanned: 1, bound: 0, skipped: 1, pulledUnmirrored: 0 });
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
    })).toEqual({ scanned: 2, bound: 1, skipped: 1, pulledUnmirrored: 0 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ card: f.card.id, runId: parent, host: 'node-b' });
    expect(failures[0]?.reason).toContain(child);
    expect(f.cards()[f.card.id]?.pr).toBeUndefined();
    expect(f.cards()[nextCard.id]?.pr).toMatchObject({ number: 26926, url });
  } finally { f.cleanup(); }
});

test('TA-BIND-PR-TERMINAL: a blocked-draft child (no pr-opened) binds from the parent pr-terminal of that exact child', async () => {
  const f = setup();
  try {
    f.ledger('node-b', parent, [{ event: 'pod-child-run', data: { childRunId: child } },
      { event: 'pr-terminal', data: { childRunId: child, prNumber: 26926, prUrl: url, branch: 'self-impl/x-r222222' } }]);
    f.ledger('node-b', child, [{ event: 'rework-blocked-draft-pr', data: { branch: 'self-impl/x-r222222', stage: 'gate-failed' } },
      { event: 'pr.comment.mode', data: { number: 26926, mode: 'status-created' } },
      { event: 'run-status', data: { runStatus: 'completed' } }]);
    expect(rejudgeCandidates(f.cards())).toEqual([]);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 1, skipped: 0, pulledUnmirrored: 0 });
    expect(f.cards()[f.card.id]).toMatchObject({ runId: parent, runChildId: child, pr: { number: 26926, url } });
    // 후보 규칙은 그대로 — taLand 카드라서 후보다(묶기만 새 근거를 받는다).
    expect(rejudgeCandidates(f.cards())).toEqual([f.card.id]);
  } finally { f.cleanup(); }
});

test('TA-BIND-PR-TERMINAL: pr-terminal for another child, another number or a mismatched URL does not bind', async () => {
  const other = 'run-77777777-7777-4777-8777-777777777777';
  const cases: Array<Record<string, unknown>> = [
    { childRunId: other, prNumber: 26926, prUrl: url },
    { childRunId: child, prNumber: 26927, prUrl: url },
    { childRunId: child, prNumber: 26926, prUrl: 'https://github.com/ElanvitalAI/elanous/pull/26927' },
    { childRunId: child, prNumber: 26926 },
  ];
  for (const data of cases) {
    const f = setup();
    try {
      f.ledger('node-b', parent, [{ event: 'pod-child-run', data: { childRunId: child } }, { event: 'pr-terminal', data }]);
      f.ledger('node-b', child, [{ event: 'rework-blocked-draft-pr', data: { stage: 'gate-failed' } },
        { event: 'run-status', data: { runStatus: 'completed' } }]);
      expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 1, bound: 0, skipped: 1, pulledUnmirrored: 0 });
      expect(f.cards()[f.card.id]?.pr).toBeUndefined();
      expect(rejudgeCandidates(f.cards())).toEqual([]);
    } finally { f.cleanup(); }
  }
});

test('TA-BIND-PULL-ONCE: an older launch with no HQ mirror is pulled once, bounded per tick', async () => {
  const f = setup();
  try {
    const old = '2026-10-10T00:00:00.000Z';
    const runs = ['run-a1111111-1111-4111-8111-111111111111', 'run-a2222222-2222-4222-8222-222222222222', 'run-a3333333-3333-4333-8333-333333333333'];
    writeTaskCards(f.statePath, [{ ...f.card, status: 'done' }, ...runs.map((runId, i) => ({ ...f.card, id: `old-${i}`, runId, createdAt: old }))]);
    const pulled: string[] = [];
    const mirror = ((_: { host: string }, runId: string) => {
      pulled.push(runId);
      f.ledger('node-b', runId, [{ event: 'start', data: {} }]);
      return [runId];
    }) as typeof import('./parent-host.js').mirrorRemoteRunLedgers;
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, { now: () => now, mirror, unmirroredPullCap: 2 }))
      .toEqual({ scanned: 3, bound: 0, skipped: 3, pulledUnmirrored: 2 });
    expect(pulled).toEqual(runs.slice(0, 2));
    // 다음 틱: 거울이 생긴 둘은 다시 안 당기고, 남은 하나만 당긴다.
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, { now: () => now, mirror, unmirroredPullCap: 2 }))
      .toEqual({ scanned: 3, bound: 0, skipped: 3, pulledUnmirrored: 1 });
    expect(pulled).toEqual(runs);
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, { now: () => now, mirror, unmirroredPullCap: 2 }))
      .toEqual({ scanned: 3, bound: 0, skipped: 3, pulledUnmirrored: 0 });
    expect(pulled).toHaveLength(3);
    // 당김은 «묶기만» — PR 근거가 없으니 묶이지 않고 rejudge/land 후보도 그대로 0.
    expect(rejudgeCandidates(f.cards())).toEqual([]);
  } finally { f.cleanup(); }
});

// 실례(10-15 node-b 실측 원장 꼴) — 부모 run-28994d6b → 자식 run-0a04e0d6 → #28037.
const REAL_PARENT = 'run-28994d6b-ea3d-45c2-869a-35dc6bf3fcc7';
const REAL_CHILD = 'run-0a04e0d6-4341-4b3e-8836-ac1ed93f947b';
const REAL_URL = 'https://github.com/ElanvitalAI/elanous/pull/28037';
const REAL_BRANCH = 'self-impl/goalid-0387a2b3fa629283-src-agent-runner-ts-src-intelligence-map-855b8a68-r0a04e0';
const realParentRows = [
  { event: 'pod-child-run', data: { childRunId: REAL_CHILD, job: 'si-task-86b518db0a7b-9d408231', attempt: 1 } },
  { event: 'pr-terminal', data: { childRunId: REAL_CHILD, prNumber: 28037, prUrl: REAL_URL, repository: 'ElanvitalAI/elanous', branch: REAL_BRANCH,
    headSha: null, terminalClass: 'merge-ready-not-merged', stage: 'pr-opened', hostRegateFailure: null, owner: 'OP', ownerSource: 'seat', card: '없음', at: '2026-10-15T13:00:57.228Z' } },
];
const realChildPrOpened = { event: 'pr-opened', data: { url: REAL_URL, number: 28037, branch: REAL_BRANCH, headCommit: '3776d4ac27c4654007dc80abb357eedd8128d3e0', autoMerge: false, autoReview: true } };
const realChildRows = [
  { event: 'pr.comment.mode', data: { number: 28037, mode: 'status-created', buffered: 2, runId: REAL_CHILD, goalId: '0387a2b3fa629283' } },
  { event: 'run-status', data: { stage: 'pr-opened', node: 'open-pr', runStatus: 'completed', completionStatus: 'completed', mergeReason: 'no-auto-flag', runId: REAL_CHILD, goalId: '0387a2b3fa629283' } },
];

for (const [name, childRows] of [['child pr-opened', [realChildPrOpened, ...realChildRows]], ['parent pr-terminal only (blocked-draft shape)', realChildRows]] as const) {
  test(`real node-b ledger shape: ${REAL_PARENT} → ${REAL_CHILD} → #28037 binds from ${name}; rejudge candidates keep the taLand rule`, async () => {
    const f = setup();
    try {
      const real = { ...f.card, id: 'ta-20261015-e1c17a', runId: REAL_PARENT, createdAt: '2026-10-15T12:43:08.346Z',
        history: [{ at: '2026-10-15T12:43:16.417Z', event: 'launch' }] } as TaskCard;
      writeTaskCards(f.statePath, [real]);
      f.ledger('node-b', REAL_PARENT, realParentRows);
      f.ledger('node-b', REAL_CHILD, [...childRows]);
      const before = rejudgeCandidates(f.cards());
      expect(before).toEqual([]);
      const result = await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, { now: () => Date.parse('2026-10-15T14:00:00.000Z'), mirror: () => [] });
      expect(result.bound).toBe(1);
      expect(f.cards()[real.id]).toMatchObject({ runId: REAL_PARENT, runChildId: REAL_CHILD, pr: { number: 28037, url: REAL_URL } });
      // 후보 규칙은 불변 — rejudgeCandidates 는 그대로 «묶인 taLand 카드»만 고른다.
      expect(rejudgeCandidates(f.cards())).toEqual([real.id]);
      expect(rejudgeCandidates({ x: { ...f.cards()[real.id]!, taLand: undefined } })).toEqual([]);
    } finally { f.cleanup(); }
  });
}

test('TA-BIND-WIDEN: a non-taLand launched card is bound, but rejudge/land candidates stay taLand-only', async () => {
  const f = setup();
  try {
    const plainParent = 'run-55555555-5555-4555-8555-555555555555';
    const plainChild = 'run-66666666-6666-4666-8666-666666666666';
    const plainUrl = 'https://github.com/ElanvitalAI/elanous/pull/26927';
    const plain: TaskCard = { ...f.card, id: 'plain-launched', taLand: undefined, runId: plainParent };
    writeTaskCards(f.statePath, [f.card, plain]);
    f.ledger('node-b', parent, [{ event: 'pod-child-run', data: { childRunId: child } }]);
    f.ledger('node-b', child, [{ event: 'pr-opened', data: { number: 26926, url } },
      { event: 'run-status', data: { runStatus: 'completed' } }]);
    f.ledger('node-b', plainParent, [{ event: 'pod-child-run', data: { childRunId: plainChild } }]);
    f.ledger('node-b', plainChild, [{ event: 'pr-opened', data: { number: 26927, url: plainUrl } },
      { event: 'run-status', data: { runStatus: 'completed' } }]);
    expect(rejudgeCandidates(f.cards())).toEqual([]);
    // 묶기 수는 둘(taLand 하나 ⊕ 아닌 것 하나) — 옛 조건(taLand 만)이면 1 이었다.
    expect(await bindMirroredRemoteRejudgeCards(f.cards(), f.statePath, mirrored)).toEqual({ scanned: 2, bound: 2, skipped: 0, pulledUnmirrored: 0 });
    expect(f.cards()[plain.id]).toMatchObject({ runId: plainParent, runChildId: plainChild, pr: { number: 26927, url: plainUrl } });
    expect(f.cards()[plain.id]?.taLand).toBeUndefined();
    // 재판정(=리뷰·재게이트·land) 후보는 taLand 카드뿐 — 넓힌 묶기가 rejudge/land 부하로 번지지 않는다.
    expect(rejudgeCandidates(f.cards())).toEqual([f.card.id]);
    expect(remoteBoundRunTerminal(f.cards()[plain.id]!, () => [])).toBe(false);
    expect(f.cards()[plain.id]?.reviewRequests).toBeUndefined();
  } finally { f.cleanup(); }
});
