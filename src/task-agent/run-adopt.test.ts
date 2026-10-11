import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { writeLaunchBinding } from '../harness/launch-registry.js';
import { runLedgerDir } from '../self-implement/run-ledger.js';
import { writeTaskCards, readTaskAgentState, type TaskCard } from './task-hand.js';
import { adoptRunCard, adoptUncardedRuns, type RunBirth } from './run-adopt.js';
import { recordTaskAgentShadowMove } from './shadow.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'run-adopt-'));
  const statePath = join(root, 'task-agent-actions.json');
  const runsDir = join(root, 'self-dev-runs');
  const registryDir = join(root, 'registry');
  const goalPath = join(root, 'seat-state', 'MK', 'GOAL.md');
  mkdirSync(join(root, 'seat-state', 'MK'), { recursive: true });
  writeFileSync(goalPath, '\n  Build a card\n칸 TA-OWN-ALL-RUNS\n제목: OTHER-2 — heading');
  const birth: RunBirth = { runId: 'run-adopt-one', cwd: root, goalPath, runsDir, env: {} };
  const deps = { statePath, registryDir, now: () => new Date('2026-10-10T00:00:00Z') };
  return { root, statePath, runsDir, registryDir, goalPath, birth, deps, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function stamp(root: string, runId: string, actor: string, entrance = 'harness-ask') {
  const dir = runLedgerDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), JSON.stringify({ runId, event: 'run-origin', data: { launch: { entrance, actor, viaQueue: false } } }) + '\n');
}

test('birth uses stamped door and actor, explicit cell, first nonempty goal line; adoption is locked and idempotent', () => {
  const f = fixture();
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const log = (_category: string, event: string, data: Record<string, unknown>) => logs.push({ event, data });
  try {
    stamp(f.root, f.birth.runId, 'TC');
    writeFileSync(f.statePath, JSON.stringify({ failureCounts: { a: 2 } }));
    const first = adoptRunCard(f.birth, { ...f.deps, log });
    expect(first).toMatchObject({ adopted: true, card: { id: 'ta-run-adopt-one', text: 'Build a card', goal: f.goalPath, runId: f.birth.runId, status: 'launched', seat: 'TC', checklistId: 'TA-OWN-ALL-RUNS', history: [{ event: 'adopted', detail: 'harness-ask' }] } });
    expect(adoptRunCard(f.birth, { ...f.deps, log })).toEqual({ adopted: false, reason: 'already-carded' });
    expect(Object.keys(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(f.statePath).tasks)).toEqual(['ta-run-adopt-one']);
    expect(JSON.parse(readFileSync(f.statePath, 'utf8')).failureCounts).toEqual({ a: 2 });
    expect(logs).toMatchObject([{ event: 'run-adopted', data: { card: 'ta-run-adopt-one', runId: f.birth.runId, origin: 'harness-ask', seat: 'TC', checklistId: 'TA-OWN-ALL-RUNS' } }, { event: 'run-adopt-skipped', data: { reason: 'already-carded' } }]);
  } finally { f.cleanup(); }
});

test('handed, Pod child, foreign universe and existing runId never create a new card', () => {
  const f = fixture();
  const logs: string[] = [];
  const log = (_category: string, event: string, data: Record<string, unknown>) => { if (event === 'run-adopt-skipped') logs.push(String(data.reason)); };
  try {
    expect(adoptRunCard({ ...f.birth, env: { ELANOUS_TASK_CARD_ID: 'ta-existing' } }, { ...f.deps, log })).toEqual({ adopted: false, reason: 'handed' });
    expect(adoptRunCard({ ...f.birth, env: { ELANOUS_POD_NAME: 'child' } }, { ...f.deps, log })).toEqual({ adopted: false, reason: 'pod-child' });
    expect(adoptRunCard({ ...f.birth, runsDir: join(f.root, '.elanous-test', 'self-dev-runs') }, { ...f.deps, log })).toEqual({ adopted: false, reason: 'universe-mismatch' });
    expect(readTaskAgentState(f.statePath)).toEqual({});
    const existing: TaskCard = { id: 'ta-from-hand', runId: f.birth.runId, text: 'owned', createdAt: '', status: 'launched', history: [] };
    writeTaskCards(f.statePath, [existing]);
    expect(adoptRunCard(f.birth, { ...f.deps, log })).toEqual({ adopted: false, reason: 'already-carded' });
    expect(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(f.statePath).tasks).toEqual({ [existing.id]: existing });
    expect(logs).toEqual(['handed', 'pod-child', 'universe-mismatch', 'already-carded']);
  } finally { f.cleanup(); }
});

test('unknown origin, path seat, conservative title and fallback text', () => {
  const f = fixture();
  try {
    writeFileSync(f.goalPath, '제목: SAFE-CELL-12 — work');
    const first = adoptRunCard(f.birth, { ...f.deps, knownChecklistIds: new Set(['SAFE-CELL']) });
    expect(first).toMatchObject({ card: { seat: 'MK', checklistId: 'SAFE-CELL', history: [{ detail: 'unknown' }] } });
    const second = adoptRunCard({ ...f.birth, runId: 'run-second' }, f.deps);
    expect(second).toMatchObject({ card: { seat: 'MK' } });
    expect(second.adopted && second.card.checklistId).toBeUndefined();
    const fallback = adoptRunCard({ ...f.birth, runId: 'run-third', goalPath: join(f.root, 'missing.md') }, f.deps);
    expect(fallback).toMatchObject({ card: { text: 'harness run run-third' } });
    expect(fallback.adopted && fallback.card.seat).toBeUndefined();
  } finally { f.cleanup(); }
});

test('registry backfill scans once, skips foreign universe and does not duplicate adopted cards', () => {
  const f = fixture();
  try {
    for (const [runId, runsDir] of [[f.birth.runId, f.runsDir], ['run-foreign', join(f.root, 'test', 'self-dev-runs')]] as const) {
      writeLaunchBinding(runId, { pid: 1, startedAt: 1, cwd: f.root, goalPath: f.goalPath, runsDir }, f.registryDir);
    }
    expect(adoptRunCard(f.birth, f.deps).adopted).toBe(true);
    expect(adoptUncardedRuns(f.deps)).toEqual({ scanned: 2, adopted: 0, skipped: { 'already-carded': 1, 'universe-mismatch': 1 } });
    expect(Object.keys(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(f.statePath).tasks)).toEqual(['ta-run-adopt-one']);
    writeLaunchBinding('run-new', { pid: 1, startedAt: 1, cwd: f.root, goalPath: f.goalPath, runsDir: f.runsDir }, f.registryDir);
    expect(adoptUncardedRuns(f.deps)).toEqual({ scanned: 3, adopted: 1, skipped: { 'already-carded': 1, 'universe-mismatch': 1 } });
  } finally { f.cleanup(); }
});

test('adopt twice then backfill once leaves one card found by needs-human shadow runId', async () => {
  const f = fixture();
  const previous = process.env.ELANOUS_STATE_DIR;
  setElanousConfigDir(f.root);
  process.env.ELANOUS_STATE_DIR = f.root;
  try {
    expect(adoptRunCard(f.birth, f.deps).adopted).toBe(true);
    expect(adoptRunCard(f.birth, f.deps)).toEqual({ adopted: false, reason: 'already-carded' });
    writeLaunchBinding(f.birth.runId, { pid: 1, startedAt: 1, cwd: f.root, goalPath: f.goalPath, runsDir: f.runsDir }, f.registryDir);
    expect(adoptUncardedRuns(f.deps)).toEqual({ scanned: 1, adopted: 0, skipped: { 'already-carded': 1 } });
    const observed: Array<Record<string, unknown>> = [];
    await recordTaskAgentShadowMove({ runId: f.birth.runId, stopReason: 'needs-human', results: [{ taskId: 'not-the-card', feature: 'different feature', status: 'done', prNumber: 5 }] },
      { log: (_category, event, data) => { if (event === 'shadow-move') observed.push(data); } });
    expect(observed).toMatchObject([{ card: `ta-${f.birth.runId}` }]);
    expect(Object.keys(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(f.statePath).tasks)).toHaveLength(1);
  } finally {
    resetElanousConfigDir();
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    f.cleanup();
  }
});

test('writeRunPidRecord birth writes binding then adopts, null registry leaves card alone; adoption failure is fail-soft', async () => {
  const f = fixture();
  const previous = process.env.ELANOUS_STATE_DIR;
  const previousPod = process.env.ELANOUS_POD_NAME;
  const previousCard = process.env.ELANOUS_TASK_CARD_ID;
  delete process.env.ELANOUS_POD_NAME;
  delete process.env.ELANOUS_TASK_CARD_ID;
  process.env.ELANOUS_STATE_DIR = f.root;
  setElanousConfigDir(f.root);
  const { writeRunPidRecord } = await import('../self-dev/orchestrate.js');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    writeRunPidRecord('run-unregistered', f.runsDir, null);
    expect(readTaskAgentState(f.statePath)).toEqual({});
    writeRunPidRecord('run-hook', f.runsDir, f.registryDir);
    expect(log.mock.calls.filter(call => call[1] === 'run-adopt-skipped' || call[1] === 'run-adopt-failed').map(call => [call[1], call[2]])).toEqual([]);
    expect(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(f.statePath).tasks['ta-run-hook']).toMatchObject({ runId: 'run-hook', status: 'launched' });
    writeFileSync(f.statePath, '{broken');
    expect(() => writeRunPidRecord('run-fail-soft', f.runsDir, f.registryDir)).not.toThrow();
    expect(log.mock.calls.some(call => call[0] === 'task-agent' && call[1] === 'run-adopt-failed')).toBe(true);
  } finally {
    log.mockRestore();
    resetElanousConfigDir();
    if (previousPod === undefined) delete process.env.ELANOUS_POD_NAME;
    else process.env.ELANOUS_POD_NAME = previousPod;
    if (previousCard === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
    else process.env.ELANOUS_TASK_CARD_ID = previousCard;
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    f.cleanup();
  }
});

test('backfill skips Pod-child and handed bindings by their launch-time markers; a birth without runsDir is not adopted', () => {
  const f = fixture();
  try {
    writeLaunchBinding('run-pod', { pid: 1, startedAt: 1, cwd: f.root, runsDir: f.runsDir, podName: 'si-run-pod' }, f.registryDir);
    writeLaunchBinding('run-handed', { pid: 1, startedAt: 1, cwd: f.root, runsDir: f.runsDir, taskCardId: 'ta-handed' }, f.registryDir);
    expect(adoptUncardedRuns(f.deps)).toEqual({ scanned: 2, adopted: 0, skipped: { 'pod-child': 1, handed: 1 } });
    expect(readTaskAgentState(f.statePath)).toEqual({});
    expect(adoptRunCard({ ...f.birth, runsDir: undefined }, f.deps)).toEqual({ adopted: false, reason: 'other-universe' });
  } finally { f.cleanup(); }
});

test('writeRunPidRecord under a Pod/handed env leaves the marker in the binding, so the hook and the backfill both skip it', async () => {
  const f = fixture();
  const saved = { state: process.env.ELANOUS_STATE_DIR, pod: process.env.ELANOUS_POD_NAME, card: process.env.ELANOUS_TASK_CARD_ID };
  const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  process.env.ELANOUS_STATE_DIR = f.root;
  setElanousConfigDir(f.root);
  const { writeRunPidRecord } = await import('../self-dev/orchestrate.js');
  const { readLaunchBinding } = await import('../harness/launch-registry.js');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    process.env.ELANOUS_POD_NAME = 'si-pod-child';
    delete process.env.ELANOUS_TASK_CARD_ID;
    writeRunPidRecord('run-pod-live', f.runsDir, f.registryDir);
    delete process.env.ELANOUS_POD_NAME;
    process.env.ELANOUS_TASK_CARD_ID = 'ta-handed-live';
    writeRunPidRecord('run-handed-live', f.runsDir, f.registryDir);
    delete process.env.ELANOUS_TASK_CARD_ID;
    expect(readLaunchBinding('run-pod-live', f.registryDir)).toMatchObject({ podName: 'si-pod-child' });
    expect(readLaunchBinding('run-handed-live', f.registryDir)).toMatchObject({ taskCardId: 'ta-handed-live' });
    expect(readTaskAgentState(f.statePath)).toEqual({});
    expect(adoptUncardedRuns(f.deps)).toEqual({ scanned: 2, adopted: 0, skipped: { 'pod-child': 1, handed: 1 } });
    expect(readTaskAgentState(f.statePath)).toEqual({});
  } finally {
    log.mockRestore();
    resetElanousConfigDir();
    restore('ELANOUS_STATE_DIR', saved.state);
    restore('ELANOUS_POD_NAME', saved.pod);
    restore('ELANOUS_TASK_CARD_ID', saved.card);
    f.cleanup();
  }
});

test('run-owned card (adopted, no reviewRequests/regates/landAttempts) takes the live review, its card history line and the review-result capture in the injected state file', async () => {
  const f = fixture();
  const head = 'e'.repeat(40);
  const reviews: number[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  try {
    const adopted = adoptRunCard(f.birth, { ...f.deps, log: () => {} });
    expect(adopted.adopted).toBe(true);
    const deps = {
      statePath: f.statePath, env: {}, liveMoves: new Set(['review'] as const),
      log: (_c: string, event: string, data: Record<string, unknown>) => { logs.push({ event, data }); },
      // live 에 statePath 를 주지 않는다 — 카드를 읽은 파일(statePath seam)에 실행부·기록·회수가 같이 간다.
      live: { now: () => new Date('2026-10-10T01:00:00.000Z'), prHead: async () => ({ head, state: 'OPEN' }), requestReview: async (pr: number) => { reviews.push(pr); } },
    };
    const input = { runId: f.birth.runId, stopReason: 'needs-human' as const, results: [{ taskId: 'self-dev-other', feature: 'not the card text', status: 'done', prNumber: 31, worktreePath: f.root }] as never };
    const out = await recordTaskAgentShadowMove(input, deps);
    expect(out.liveMove).toMatchObject({ kind: 'review', card: 'ta-run-adopt-one', executed: true, ok: true });
    expect(reviews).toEqual([31]);
    const card = readTaskAgentState<{ tasks: Record<string, TaskCard> }>(f.statePath).tasks['ta-run-adopt-one']!;
    expect(card.reviewRequests).toHaveLength(1);
    expect(card.reviewRequests![0]).toMatchObject({ pr: 31, head });
    expect(card.history.filter((item) => item.event === 'live-move')).toHaveLength(1);
    // 결과 파일이 오면 다음 판단 전에 같은 원장으로 회수된다.
    const resultPath = card.reviewRequests![0]!.resultPath!;
    mkdirSync(join(resultPath, '..'), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ pr: 31, verdict: 'pass', mustFix: [], reviewed: true, headCommit: head }) + '\n');
    await recordTaskAgentShadowMove(input, deps);
    const after = readTaskAgentState<{ tasks: Record<string, TaskCard> }>(f.statePath).tasks['ta-run-adopt-one']!;
    expect(after.history.filter((item) => item.event === 'live-move-result')).toHaveLength(1);
    expect(after.history.find((item) => item.event === 'live-move-result')).toMatchObject({ pr: 31, verdict: 'pass', mustFix: 0 });
  } finally { f.cleanup(); }
});

test('universe root mismatch: skipped with one universe-mismatch observation (statePath · runsDir) and no card; same root → one card', () => {
  const f = fixture();
  const other = mkdtempSync(join(tmpdir(), 'run-adopt-other-'));
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const log = (_category: string, event: string, data: Record<string, unknown>) => logs.push({ event, data });
  try {
    const foreignRunsDir = join(other, 'self-dev-runs');
    expect(adoptRunCard({ ...f.birth, runsDir: foreignRunsDir }, { ...f.deps, log })).toEqual({ adopted: false, reason: 'universe-mismatch' });
    const skipped = logs.filter((entry) => entry.event === 'run-adopt-skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.data).toMatchObject({ runId: f.birth.runId, reason: 'universe-mismatch', statePath: f.statePath, runsDir: foreignRunsDir });
    expect(Object.keys(readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(f.statePath).tasks ?? {})).toEqual([]);
    expect(adoptRunCard(f.birth, { ...f.deps, log }).adopted).toBe(true);
    expect(Object.keys(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(f.statePath).tasks)).toEqual(['ta-run-adopt-one']);
  } finally { f.cleanup(); rmSync(other, { recursive: true, force: true }); }
});

test('same universe reached through a symlink (state via link · runsDir via real path) is one universe → one card', () => {
  const f = fixture();
  const linkParent = mkdtempSync(join(tmpdir(), 'run-adopt-link-'));
  const link = join(linkParent, 'root-link');
  try {
    mkdirSync(f.runsDir, { recursive: true });
    symlinkSync(f.root, link);
    const statePath = join(link, 'task-agent-actions.json');
    const result = adoptRunCard(f.birth, { ...f.deps, statePath, log: () => {} });
    expect(result.adopted).toBe(true);
    expect(Object.keys(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(f.statePath).tasks)).toEqual(['ta-run-adopt-one']);
  } finally { f.cleanup(); rmSync(linkParent, { recursive: true, force: true }); }
});

test('without an injected state path the universe is resolved once from the instance root (default effectiveInstanceRoot seam)', () => {
  const f = fixture();
  try {
    const result = adoptRunCard(f.birth, { instanceRoot: () => f.root, registryDir: f.registryDir, log: () => {} });
    expect(result.adopted).toBe(true);
    expect(Object.keys(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(f.statePath).tasks)).toEqual(['ta-run-adopt-one']);
  } finally { f.cleanup(); }
});
