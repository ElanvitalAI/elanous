import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { inspectHoldHygiene, runHoldHygiene, starvingCycles } from './hold-hygiene.js';
import { runOrchestratorNode } from '../loops/orchestrator/tick.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hold-hygiene-'));
  const dispatcherDir = join(root, 'feeder');
  mkdirSync(dispatcherDir);
  const trafficPath = join(root, 'traffic.json');
  const metaPath = join(root, 'hold-meta.jsonl');
  const now = new Date('2026-10-13T13:00:00Z');
  const deps = { root, now, dispatcherDir, trafficPath, metaPath, cells: [] as Array<{ id: string; owner: string; status: string }> };
  return { deps, close: () => rmSync(root, { recursive: true, force: true }) };
}

function messages(root: string, to: string) {
  const store = openMsgStore(join(root, 'msg', 'messages.db'));
  try { return store.listByRecipient(to); } finally { store.close(); }
}

test('three consecutive budgeted empty dispatch cycles notify OP and seat with counted skip reasons once per 30 minutes', () => {
  const f = fixture();
  try {
    writeFileSync(f.deps.dispatcherDir + '/dispatcher-TC.out', [
      '역압 예산 4', '건너뜀 잠금', '역압 예산 6', '건너뜀 잠금', '건너뜀 경로 없음',
      '역압 예산 2', '건너뜀 경로 없음', '역압 예산 1',
    ].join('\n'));
    expect(starvingCycles(readFileSync(f.deps.dispatcherDir + '/dispatcher-TC.out', 'utf8'))).toEqual({ reasons: { '잠금': 2, '경로 없음': 2 } });
    const sent = runHoldHygiene(f.deps);
    expect(sent.map(row => row.to)).toEqual(['OP', 'TC']);
    expect(messages(f.deps.root, 'TC')[0]?.body).toContain('잠금 ×2 · 경로 없음 ×2');
    expect(messages(f.deps.root, 'OP')).toHaveLength(1);
    expect(runHoldHygiene(f.deps)).toEqual([]);
    expect(runHoldHygiene({ ...f.deps, now: new Date(f.deps.now.getTime() + 30 * 60_000) })).toHaveLength(2);
  } finally { f.close(); }
});

test('an open budget cycle cannot trigger starvation before its launch is known', () => {
  const f = fixture();
  try {
    const log = join(f.deps.dispatcherDir, 'dispatcher-TC.out');
    const twoCompleted = '역압 예산 4\n건너뜀 잠금\n역압 예산 4\n건너뜀 잠금\n';
    writeFileSync(log, `${twoCompleted}역압 예산 4\n건너뜀 경로 없음\n`);
    expect(starvingCycles(readFileSync(log, 'utf8'))).toBeNull();
    expect(runHoldHygiene(f.deps)).toEqual([]);
    writeFileSync(log, `${twoCompleted}역압 예산 4\n건너뜀 경로 없음\n발사 A\n역압 예산 4\n`);
    expect(starvingCycles(readFileSync(log, 'utf8'))).toBeNull();
    expect(runHoldHygiene(f.deps)).toEqual([]);
    writeFileSync(log, `${twoCompleted}역압 예산 4\n건너뜀 경로 없음\n역압 예산 4\n`);
    expect(runHoldHygiene(f.deps).map(row => row.to)).toEqual(['OP', 'TC']);
  } finally { f.close(); }
});

test('live orchestrator report invokes hygiene; shadow report sends nothing', async () => {
  const f = fixture();
  try {
    writeFileSync(f.deps.trafficPath, JSON.stringify({ global: 'green', hold: ['one'] }));
    f.deps.cells = [{ id: 'one', owner: 'TC', status: 'yellow' }];
    const stateDir = join(f.deps.root, 'loop', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    const state = (runId: string, mode: 'live' | 'shadow') => ({ runId, mode, day: '2026-10-13', window: '08', cards: [], skippedCards: [], cells: [], placed: 0,
      delegated: 0, wouldDelegate: 0, reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 }, steps: [], nodes: { reconcile: 'ok' }, missing: [] });
    writeFileSync(join(stateDir, 'live.json'), JSON.stringify(state('live', 'live')));
    writeFileSync(join(stateDir, 'shadow.json'), JSON.stringify(state('shadow', 'shadow')));
    const shared = { root: f.deps.root, now: f.deps.now, window: '08' as const, hygieneCells: () => f.deps.cells,
      hygienePaths: { trafficPath: f.deps.trafficPath, metaPath: f.deps.metaPath, dispatcherDir: f.deps.dispatcherDir }, print: () => {} };
    await runOrchestratorNode('report', { ...shared, mode: 'shadow', runId: 'shadow' });
    expect(messages(f.deps.root, 'TC')).toEqual([]);
    await runOrchestratorNode('report', { ...shared, mode: 'live', runId: 'live' });
    expect(messages(f.deps.root, 'TC')).toHaveLength(1);
  } finally { f.close(); }
});

test('a launch, no-capacity, zero budget or fewer than three cycles never claims starvation', () => {
  const f = fixture();
  try {
    const log = join(f.deps.dispatcherDir, 'dispatcher-MK.out');
    for (const last of ['역압 예산 4\n발사 A\n역압 예산 1', '역압 예산 4\n여유 없음\n역압 예산 1', '역압 예산 0\n역압 예산 1', '']) {
      writeFileSync(log, `역압 예산 4\n건너뜀 X\n역압 예산 4\n건너뜀 X\n${last}`);
      expect(runHoldHygiene(f.deps)).toEqual([]);
    }
    expect(messages(f.deps.root, 'MK')).toEqual([]);
  } finally { f.close(); }
});

test('yellow held cells with absent reasons or expired until ask exactly their owner, never unhold', () => {
  const f = fixture();
  try {
    f.deps.cells = [
      { id: 'kept', owner: 'TC', status: 'yellow' },
      { id: 'missing', owner: 'UX', status: 'yellow' },
      { id: 'expired', owner: 'MK', status: 'yellow' },
      { id: 'green', owner: 'OP', status: 'green' },
      { id: 'not-held', owner: 'OP', status: 'yellow' },
    ];
    const original = JSON.stringify({ global: 'green', hold: ['kept', 'missing', 'expired', 'green'] });
    writeFileSync(f.deps.trafficPath, original);
    writeFileSync(f.deps.metaPath, [
      { id: 'kept', op: 'add', reason: 'manual work', until: '202610142200' },
      { id: 'expired', op: 'add', reason: 'temporary', until: '202610132100' },
    ].map(row => JSON.stringify(row)).join('\n'));
    expect(inspectHoldHygiene(f.deps).map(row => [row.to, row.key])).toEqual([
      ['UX', 'hold:missing:UX'], ['MK', 'hold:expired:MK'],
    ]);
    expect(runHoldHygiene(f.deps).map(row => row.to)).toEqual(['UX', 'MK']);
    expect(messages(f.deps.root, 'TC')).toEqual([]);
    expect(messages(f.deps.root, 'UX')[0]?.body).toContain('풀기/유지');
    expect(readFileSync(f.deps.trafficPath, 'utf8')).toBe(original);
    rmSync(f.deps.metaPath);
    expect(inspectHoldHygiene(f.deps).map(row => row.to)).toEqual(['TC', 'UX', 'MK']);
  } finally { f.close(); }
});
