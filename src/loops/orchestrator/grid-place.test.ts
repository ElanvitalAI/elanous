import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../task-cards/card-store.js';
import { splitCard } from '../../flow-loop/split.js';
import { addHarnessQueue, harnessQueuePath, listHarnessQueue, queueLaunchArgs, setQueuedPoolHint } from '../../harness/harness-queue.js';
import { runSeatLoopOnce } from '../../seat-loop/seat-loop.js';
import { placeOnGrid, type GridHost } from './grid-place.js';
import { runOrchestratorNode, type TickDeps } from './tick.js';

const hosts: GridHost[] = [
  { name: 'node-b', capabilities: new Set(['pod']), available: true },
  { name: 'node-c', capabilities: new Set(['pod']), available: true },
  { name: 'mbp', capabilities: new Set(['browser']), available: true },
];

describe('placeOnGrid', () => {
  test('uses the first available capable host in input order, and falls through blocked node-b to node-c', () => {
    expect(placeOnGrid({ kind: 'pod' }, hosts)).toEqual({ host: 'node-b' });
    expect(placeOnGrid({ kind: 'pod' }, [{ ...hosts[0]!, available: false }, ...hosts.slice(1)]))
      .toEqual({ host: 'node-c' });
  });

  test('both pod hosts blocked returns null with a reason', () => {
    const result = placeOnGrid({ kind: 'pod' }, hosts.map(host => ({ ...host, available: false })));
    expect(result.host).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  test('browser chooses only mbp regardless of title or list order', () => {
    expect(placeOnGrid({ kind: 'browser' }, hosts)).toEqual({ host: 'mbp' });
    const namedCell = { kind: 'browser', title: 'pod on node-b' };
    expect(placeOnGrid(namedCell, hosts)).toEqual({ host: 'mbp' });
  });

  test('missing kind stays unknown rather than assuming pod', () => {
    expect(placeOnGrid({}, hosts)).toEqual({ host: null, reason: 'no host with unknown capability' });
  });
});

test('place node records the grid proposal and carries a live host without changing RELPLAN arguments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-place-test-'));
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid', title: 'pod on node-b' });
    store.close();
    const reasons: string[] = [];
    const order: string[] = [];
    const placed: unknown[] = [];
    const deps: TickDeps = {
      root, runId: 'grid-test', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      split: () => [{ id: 'C1', title: 'pod on node-b', kind: 'pod', seat: 'MK' }],
      gridHosts: [{ ...hosts[0]!, available: false }, ...hosts.slice(1)],
      placeCell: (...args) => { order.push('place'); placed.push(args); return { version: '0.2.17' }; },
      observe: (_event, data) => { reasons.push(data.reason); if (data.reason.startsWith('would-host:')) order.push('observe'); },
    };
    await runOrchestratorNode('intake', deps);
    await runOrchestratorNode('split', deps);
    const state = await runOrchestratorNode('place', deps);
    expect(state.cards.map(row => row.id)).toEqual([card.id]);
    expect(reasons).toContain('would-host:C1:node-c');
    expect(order).toEqual(['observe', 'place']);
    expect(state.cells[0]?.host).toBe('node-c');
    expect(placed).toEqual([[{ id: 'C1', title: 'pod on node-b', owner: 'MK', priority: 'P2', predecessors: [] },
      { dryRun: false, now: deps.now }]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tick place→delegate carries live choice into the request and launch hint, or falls back when both are blocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-live-test-'));
  try {
    for (const [runId, inventory, expected] of [
      ['grid-live', [{ ...hosts[0]!, available: false }, ...hosts.slice(1)], 'node-c'],
      ['grid-blocked', hosts.map(host => ({ ...host, available: false })), undefined],
    ] as const) {
      const store = new CardStore(root);
      const card = store.createCard({ goalId: `wish:${runId}`, title: 'Pod 배포 준비' });
      store.close();
      const seen: Array<string | undefined> = [];
      const deps: TickDeps = { root, runId, window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
        cards: () => [card], split: () => [{ id: runId, title: 'Pod 배포 준비', kind: 'pod', seat: 'MK' }],
        gridHosts: inventory, placeCell: () => ({ version: '0.2.17' }),
        seatTurn: async (_seat, _root, host) => { seen.push(host); return { status: 'skipped-empty' }; } };
      for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, deps);
      const state = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', `${runId}.json`), 'utf8'));
      const rows = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const row = rows.find(item => item.key === `orch:${card.id}:${runId}`);
      expect(state.cells[0]?.host).toBe(expected);
      expect(row?.host).toBe(expected);
      expect(seen).toEqual([expected]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('live launch uses the chosen host as a pool hint, not as a hard host assignment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-launch-hint-'));
  const previous = { pool: process.env.ELANOUS_POD_POOL, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8,pool-node-c@node-c:2';
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-hint', title: 'Pod 준비' });
    store.close();
    const deps: TickDeps = { root, runId: 'hint', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: 'Pod 준비', kind: 'pod', seat: 'MK' }],
      gridHosts: [{ ...hosts[0]!, available: false }, ...hosts.slice(1)], placeCell: () => ({ version: '0.2.17' }),
      seatTurn: async (seat, stateRoot, host, options) => {
        expect(host).toBe('node-c');
        expect(options?.enqueue).toBeDefined();
        return runSeatLoopOnce(seat, { root: stateRoot, config: { mode: 'live-safe', seats: [seat] },
          run: async () => JSON.stringify({ outcome: 'proceed' }),
          running: () => [], now: () => new Date('2026-10-04T00:00:00Z'),
          versions: () => [], schedules: () => [], ...options,
        });
      } };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, deps);
    const row = listHarnessQueue({ root })[0];
    expect(row?.launchArgs).toBeUndefined();
    expect(row?.poolHint).toBe('pool-node-c@node-c:2,pool-node-b@node-b:8');
    expect(queueLaunchArgs(row!)).toEqual(['harness', 'say', expect.any(String), '--substrate', 'pod', '--pod-pool', row!.poolHint]);
    expect(queueLaunchArgs(row!)).not.toContain('--host');
    const customArgs = ['harness', 'say', row!.input, '--substrate', 'pod', '--base', 'custom', '--json', '--no-auto-merge'];
    expect(queueLaunchArgs({ ...row!, launchArgs: customArgs })).toEqual([...customArgs, '--pod-pool', row!.poolHint!]);
    const explicitPoolArgs = [...customArgs, '--pod-pool', 'operator-pool'];
    expect(queueLaunchArgs({ ...row!, launchArgs: explicitPoolArgs })).toEqual(explicitPoolArgs);
    const nonPodArgs = ['harness', 'say', row!.input, '--substrate', 'local', '--base', 'custom', '--json'];
    expect(queueLaunchArgs({ ...row!, launchArgs: nonPodArgs })).toEqual(nonPodArgs);
    expect(queueLaunchArgs({ ...row!, launchArgs: ['harness', 'say', row!.input, '--base', 'custom'] }))
      .toEqual(['harness', 'say', row!.input, '--base', 'custom']);
    expect(row?.idempotencyKey).toEqual(expect.any(String));
    const request = JSON.parse(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim());
    expect(request.host).toBe('node-c');
  } finally {
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('two real same-seat requests with different hosts carry the picked request pool into launch args', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-two-requests-'));
  const previous = { pool: process.env.ELANOUS_POD_POOL, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8,pool-node-c@node-c:2';
    const store = new CardStore(root);
    const first = store.createCard({ goalId: 'wish:grid-first', title: '첫 Pod 준비' });
    store.close();
    const run = async (runId: string, card: typeof first, gridHosts: GridHost[]) => {
      const deps: TickDeps = { root, runId, window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
        cards: () => [card], split: () => [{ id: runId, title: card.title, seat: 'MK', kind: 'pod' }],
        gridHosts, placeCell: () => ({ version: '0.2.17' }),
        seatTurn: (seat, stateRoot, _host, options) => runSeatLoopOnce(seat, {
          root: stateRoot, config: { mode: 'live-safe', seats: [seat] },
          run: async () => JSON.stringify({ outcome: 'proceed' }), running: () => [],
          now: () => new Date('2026-10-04T00:00:00Z'), versions: () => [], schedules: () => [], ...options,
        }) };
      for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, deps);
    };
    await run('C1', first, hosts);
    const nextStore = new CardStore(root);
    const second = nextStore.createCard({ goalId: 'wish:grid-second', title: '둘째 Pod 준비' });
    nextStore.close();
    await run('C2', second, [{ ...hosts[0]!, available: false }, ...hosts.slice(1)]);
    const requests = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests.map(row => row.host)).toEqual(['node-b', 'node-c']);
    const queue = listHarnessQueue({ root });
    expect(queue).toHaveLength(2);
    expect(queue.map(row => row.launchArgs)).toEqual([undefined, undefined]);
    expect(queue.map(row => row.poolHint)).toEqual([
      'pool-node-b@node-b:8,pool-node-c@node-c:2', 'pool-node-c@node-c:2,pool-node-b@node-b:8',
    ]);
    expect(queueLaunchArgs(queue[1]!)).toEqual(['harness', 'say', expect.stringContaining(`orch:${second.id}:C2`),
      '--substrate', 'pod', '--pod-pool', 'pool-node-c@node-c:2,pool-node-b@node-b:8']);
  } finally {
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an older pending request keeps its own pool when this tick placed a different host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-pending-host-'));
  const previous = { pool: process.env.ELANOUS_POD_POOL, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8,pool-node-c@node-c:2';
    const store = new CardStore(root);
    const older = store.createCard({ goalId: 'wish:grid-pending-old', title: '오래된 Pod 준비' });
    store.close();
    const oldDeps: TickDeps = { root, runId: 'old', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [older], split: () => [{ id: 'old', title: older.title, seat: 'MK', kind: 'pod' }],
      gridHosts: hosts, placeCell: () => ({ version: '0.2.17' }), seatTurn: async () => ({ status: 'skipped-empty' }) };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, oldDeps);
    const newStore = new CardStore(root);
    const newer = newStore.createCard({ goalId: 'wish:grid-pending-new', title: '새 Pod 준비' });
    newStore.close();
    const requestPath = join(root, 'seat-requests', 'requests.jsonl');
    const previousRequest = JSON.parse(readFileSync(requestPath, 'utf8').trim());
    const earlier = new Date(Date.parse(previousRequest.queuedAt) - 60_000).toISOString();
    writeFileSync(requestPath, `${JSON.stringify({ ...previousRequest, queuedAt: earlier })}\n`);
    const newDeps: TickDeps = { ...oldDeps, runId: 'new', cards: () => [newer],
      split: () => [{ id: 'new', title: newer.title, seat: 'MK', kind: 'pod' }],
      gridHosts: [{ ...hosts[0]!, available: false }, ...hosts.slice(1)],
      seatTurn: (seat, stateRoot, host, options) => {
        expect(host).toBe('node-c');
        return runSeatLoopOnce(seat, { root: stateRoot, config: { mode: 'live-safe', seats: [seat] },
          run: async () => JSON.stringify({ outcome: 'proceed' }), running: () => [],
          now: () => new Date('2026-10-04T00:00:00Z'), versions: () => [], schedules: () => [], ...options });
      } };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, newDeps);
    const queue = listHarnessQueue({ root });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.input).toContain(`orch:${older.id}:old`);
    expect(queue[0]?.poolHint).toBe('pool-node-b@node-b:8,pool-node-c@node-c:2');
    expect(queueLaunchArgs(queue[0]!).at(-1)).toBe(queue[0]?.poolHint);
  } finally {
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('the next tick rehosts the same queued cell, preserving its request identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-rehost-test-'));
  const previous = { pool: process.env.ELANOUS_POD_POOL, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8,pool-node-c@node-c:2';
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-rehost', title: 'Pod 준비' });
    store.close();
    const reasons: string[] = [];
    const base: TickDeps = { root, window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: 'Pod 준비', kind: 'pod', seat: 'MK' }],
      placeCell: () => ({ version: '0.2.17' }), gridHosts: hosts,
      observe: (_event, data) => { reasons.push(data.reason); } };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, { ...base, runId: 'morning', seatTurn: async () => ({ status: 'skipped-empty' }) });
    const next: TickDeps = { ...base, runId: 'next', gridHosts: [{ ...hosts[0]!, available: false }, ...hosts.slice(1)],
      seatTurn: async (seat, stateRoot, host, options) => {
        expect(host).toBe('node-c');
        return runSeatLoopOnce(seat, { root: stateRoot, config: { mode: 'live-safe', seats: [seat] },
          run: async () => JSON.stringify({ outcome: 'proceed' }), running: () => [],
          now: () => new Date('2026-10-04T00:00:00Z'), versions: () => [], schedules: () => [], ...options });
      } };
    for (const node of ['intake', 'split', 'place', 'delegate'] as const) await runOrchestratorNode(node, next);
    const beforeLaunch = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(beforeLaunch.at(-1)?.host).toBe('node-c');
    await runOrchestratorNode('launch', next);
    const queued = listHarnessQueue({ root });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.poolHint).toBe('pool-node-c@node-c:2,pool-node-b@node-b:8');
    expect(queueLaunchArgs(queued[0]!).at(-1)).toBe(queued[0]?.poolHint);
    const rows = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.key)).toEqual([`orch:${card.id}:C1`, `orch:${card.id}:C1`]);
    expect(rows.map(row => row.host)).toEqual(['node-b', 'node-c']);
    expect(rows.map(row => row.gridHost)).toEqual([true, true]);
    expect(reasons).toContain('rehost:C1:node-b→node-c');
    const state = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'next.json'), 'utf8'));
    expect(state.cells[0]?.host).toBe('node-c');
  } finally {
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a request already in the harness queue gets its pool hint moved when the next tick rehosts it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-requeue-test-'));
  const previous = { pool: process.env.ELANOUS_POD_POOL, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8,pool-node-c@node-c:2';
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-requeue', title: 'Pod 준비' });
    store.close();
    const reasons: string[] = [];
    const realTurn: TickDeps['seatTurn'] = async (seat, stateRoot, _host, options) => runSeatLoopOnce(seat, { root: stateRoot,
      config: { mode: 'live-safe', seats: [seat] }, run: async () => JSON.stringify({ outcome: 'proceed' }), running: () => [],
      now: () => new Date('2026-10-04T00:00:00Z'), versions: () => [], schedules: () => [], ...options });
    const base: TickDeps = { root, window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: 'Pod 준비', kind: 'pod', seat: 'MK' }],
      placeCell: () => ({ version: '0.2.17' }), observe: (_event, data) => { reasons.push(data.reason); } };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, { ...base, runId: 'morning', gridHosts: hosts, seatTurn: realTurn });
    const first = listHarnessQueue({ root });
    expect(first).toHaveLength(1);
    expect(first[0]?.poolHint).toBe('pool-node-b@node-b:8,pool-node-c@node-c:2');
    // 다음 틱: node-b 이 빠졌다 — 아직 발사 전인 같은 의뢰의 대기열 항목이 node-c 쪽 힌트로 바뀌어야 한다.
    // 자정을 넘긴 다음 날 틱 — 날짜가 달라도 아직 발사 전인 항목은 옮겨야 한다.
    const next: TickDeps = { ...base, runId: 'next', now: new Date('2026-10-05T00:00:00Z'), gridHosts: [{ ...hosts[0]!, available: false }, ...hosts.slice(1)], seatTurn: realTurn };
    for (const node of ['intake', 'split', 'place'] as const) await runOrchestratorNode(node, next);
    const moved = listHarnessQueue({ root });
    expect(moved.map(item => item.id)).toEqual(first.map(item => item.id));
    expect(moved[0]?.poolHint).toBe('pool-node-c@node-c:2,pool-node-b@node-b:8');
    expect(queueLaunchArgs(moved[0]!).at(-1)).toBe('pool-node-c@node-c:2,pool-node-b@node-b:8');
    expect(reasons.some(reason => reason.startsWith(`rehost-queue:orch:${card.id}:C1:pool-node-c`))).toBe(true);
  } finally {
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a chosen host that is not in the configured pod pool is reported, never turned into an invented pool hint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-unmapped-test-'));
  const previous = { pool: process.env.ELANOUS_POD_POOL, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    delete process.env.ELANOUS_POD_POOL;
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-unmapped', title: 'Pod 준비' });
    store.close();
    const reasons: string[] = [];
    const deps: TickDeps = { root, runId: 'unmapped', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: 'Pod 준비', kind: 'pod', seat: 'MK' }],
      placeCell: () => ({ version: '0.2.17' }), gridHosts: [{ ...hosts[0]!, available: false }, ...hosts.slice(1)],
      seatTurn: async (_seat, _root, _host, options) => { expect(options).toBeUndefined(); return { status: 'skipped-empty' }; },
      observe: (_event, data) => { reasons.push(data.reason); } };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, deps);
    expect(reasons).toContain(`grid-host-unmapped:orch:${card.id}:C1:node-c`);
  } finally {
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a request that already left the queue keeps its launched host; the new choice is only observed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-left-queue-test-'));
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-left', title: 'Pod 준비' });
    store.close();
    const reasons: string[] = [];
    const base: TickDeps = { root, window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: 'Pod 준비', kind: 'pod', seat: 'MK' }],
      placeCell: () => ({ version: '0.2.17' }), observe: (_event, data) => { reasons.push(data.reason); } };
    for (const node of ['intake', 'split', 'place', 'delegate'] as const) await runOrchestratorNode(node, { ...base, runId: 'morning', gridHosts: hosts });
    const journal = join(root, 'seat-requests', 'requests.jsonl');
    const first = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(first.at(-1)?.host).toBe('node-b');
    writeFileSync(journal, `${readFileSync(journal, 'utf8')}${JSON.stringify({ ...first.at(-1), status: 'launched' })}\n`);
    const next: TickDeps = { ...base, runId: 'next', gridHosts: [{ ...hosts[0]!, available: false }, ...hosts.slice(1)] };
    for (const node of ['intake', 'split', 'place'] as const) await runOrchestratorNode(node, next);
    const rows = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(rows.at(-1)).toMatchObject({ status: 'launched', host: 'node-b' });
    expect(reasons).toContain('would-host:C1:node-c');
    expect(reasons.some(reason => reason.startsWith('rehost:C1'))).toBe(false);
    const state = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'next.json'), 'utf8'));
    expect(state.cells[0]?.host).toBe('node-b');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('when every pod host is blocked on the next tick, the grid-made queue hint is cleared (existing path), a non-grid hint is not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-clear-hint-'));
  const previous = { pool: process.env.ELANOUS_POD_POOL, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8,pool-node-c@node-c:2';
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-clear', title: 'Pod 준비' });
    store.close();
    const realTurn: TickDeps['seatTurn'] = async (seat, stateRoot, _host, options) => runSeatLoopOnce(seat, { root: stateRoot,
      config: { mode: 'live-safe', seats: [seat] }, run: async () => JSON.stringify({ outcome: 'proceed' }), running: () => [],
      now: () => new Date('2026-10-04T00:00:00Z'), versions: () => [], schedules: () => [], ...options });
    const base: TickDeps = { root, window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: 'Pod 준비', kind: 'pod', seat: 'MK' }],
      placeCell: () => ({ version: '0.2.17' }) };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, { ...base, runId: 'morning', gridHosts: hosts, seatTurn: realTurn });
    expect(listHarnessQueue({ root })[0]?.poolHint).toBe('pool-node-b@node-b:8,pool-node-c@node-c:2');
    expect(listHarnessQueue({ root })[0]?.poolHintSource).toBe('grid');
    const blocked: TickDeps = { ...base, runId: 'next', gridHosts: hosts.map(host => ({ ...host, available: false })), seatTurn: realTurn };
    for (const node of ['intake', 'split', 'place'] as const) await runOrchestratorNode(node, blocked);
    expect(listHarnessQueue({ root })[0]?.poolHint).toBeUndefined();
    expect(listHarnessQueue({ root })[0]?.poolHintSource).toBeUndefined();
  } finally {
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a queued item keeps its pool hint when the caller premise fails inside the queue lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-hint-premise-'));
  try {
    const item = await addHarnessQueue({ seat: 'MK', say: 'pod job', poolHint: 'pool-node-b@node-b:8,pool-node-c@node-c:2', poolHintSource: 'grid' }, { root });
    expect(await setQueuedPoolHint(item.id, 'pool-node-c@node-c:2,pool-node-b@node-b:8', { root }, () => false)).toBe(false);
    expect(listHarnessQueue({ root })[0]?.poolHint).toBe('pool-node-b@node-b:8,pool-node-c@node-c:2');
    expect(await setQueuedPoolHint(item.id, 'pool-node-c@node-c:2,pool-node-b@node-b:8', { root }, () => true)).toBe(true);
    expect(listHarnessQueue({ root })[0]?.poolHint).toBe('pool-node-c@node-c:2,pool-node-b@node-b:8');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a shadow launch tick never reads the request journal, so a corrupt live journal cannot fail it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-shadow-journal-'));
  try {
    const store = new CardStore(root);
    store.createCard({ goalId: 'wish:grid-shadow-journal', title: 'pod' });
    store.close();
    const deps: TickDeps = { root, runId: 'shadow-journal', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'shadow',
      split: () => [{ id: 'C1', title: 'pod', kind: 'pod', seat: 'MK' }], gridHosts: hosts,
      seatTurn: async () => ({ status: 'skipped-empty' }) };
    for (const node of ['intake', 'split', 'place', 'delegate'] as const) await runOrchestratorNode(node, deps);
    // delegate 뒤 저널이 깨져도 shadow launch 는 읽지 않으므로 넘어지지 않는다.
    mkdirSync(join(root, 'seat-requests'), { recursive: true });
    writeFileSync(join(root, 'seat-requests', 'requests.jsonl'), '{not json\n');
    await runOrchestratorNode('launch', deps);
    expect(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8')).toBe('{not json\n');
    // 사람이 넣은 힌트(소유 기록 없음)는 GRID 가 바꾸지 못한다.
    const manual = await addHarnessQueue({ seat: 'MK', say: 'manual pod job', poolHint: 'pool-node-b@node-b:8,pool-node-c@node-c:2' }, { root });
    expect(await setQueuedPoolHint(manual.id, 'pool-node-c@node-c:2,pool-node-b@node-b:8', { root }, () => true)).toBe(false);
    expect(await setQueuedPoolHint(manual.id, undefined, { root }, () => true)).toBe(false);
    expect(listHarnessQueue({ root }).find(row => row.id === manual.id)?.poolHint).toBe('pool-node-b@node-b:8,pool-node-c@node-c:2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a hand-set hint on the same GRID request survives both rehost and the both-blocked clear', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-manual-hint-'));
  const previous = { pool: process.env.ELANOUS_POD_POOL, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8,pool-node-c@node-c:2';
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-manual', title: 'Pod 준비' });
    store.close();
    const realTurn: TickDeps['seatTurn'] = async (seat, stateRoot, _host, options) => runSeatLoopOnce(seat, { root: stateRoot,
      config: { mode: 'live-safe', seats: [seat] }, run: async () => JSON.stringify({ outcome: 'proceed' }), running: () => [],
      now: () => new Date('2026-10-04T00:00:00Z'), versions: () => [], schedules: () => [], ...options });
    const base: TickDeps = { root, window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: 'Pod 준비', kind: 'pod', seat: 'MK' }],
      placeCell: () => ({ version: '0.2.17' }), seatTurn: realTurn };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, { ...base, runId: 'morning', gridHosts: hosts });
    // 사람이 같은 대기열 항목의 힌트를 손으로 바꿨다(소유 기록 없음).
    const path = harnessQueuePath(root);
    const rows = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
    rows[0]!.poolHint = 'pool-node-c@node-c:2';
    delete rows[0]!.poolHintSource;
    writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`);
    for (const node of ['intake', 'split', 'place'] as const) await runOrchestratorNode(node, { ...base, runId: 'rehost', gridHosts: [{ ...hosts[0]!, available: false }, ...hosts.slice(1)] });
    expect(listHarnessQueue({ root })[0]?.poolHint).toBe('pool-node-c@node-c:2');
    for (const node of ['intake', 'split', 'place'] as const) await runOrchestratorNode(node, { ...base, runId: 'blocked', gridHosts: hosts.map(host => ({ ...host, available: false })) });
    expect(listHarnessQueue({ root })[0]?.poolHint).toBe('pool-node-c@node-c:2');
  } finally {
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a blank host name makes the explicit inventory unreadable: no proposal, observed', async () => {
  const { root, cardId, reasons } = await runLiveWithEnvInventory('grid-blank-name', JSON.stringify([{ name: '  ', capabilities: ['pod'], available: true }]));
  try {
    expect(reasons.filter(reason => reason.startsWith('would-host:'))).toEqual([]);
    expect(reasons).toContain('grid-inventory-unreadable');
    expect(requestHost(root, `orch:${cardId}:grid-blank-name`) ?? undefined).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('live choice updates a kind-optional cell and its queued row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-optional-kind-'));
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-optional', title: '작업' });
    store.close();
    const deps: TickDeps = { root, runId: 'optional', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: '작업', seat: 'MK' }],
      gridHosts: [{ name: 'unknown-host', capabilities: new Set(['unknown']), available: true }],
      placeCell: () => ({ version: '0.2.17' }),
      seatTurn: async (_seat, _root, host) => { expect(host).toBe('unknown-host'); return { status: 'skipped-empty' }; } };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, deps);
    const state = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'optional.json'), 'utf8'));
    const row = JSON.parse(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim());
    expect(state.cells[0].host).toBe('unknown-host');
    expect(row.host).toBe('unknown-host');
    expect(row.kind).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FLOW1 kind reaches the grid without dropping seatless rows', () => {
  const card = { id: 'card-kind', goalId: 'wish:kind', title: '제목', createdAt: '2026-10-04T00:00:00Z', status: 'open' as const,
    sections: [{ key: 'intake:wish:1', owner: 'steward', content: JSON.stringify({ kind: 'pod', text: '[MK] 구현\n담당 미정' }), createdAt: '2026-10-04T00:00:00Z' }] };
  expect(splitCard(card)).toEqual([{ id: 'card-kind-1', title: '구현', seat: 'MK', kind: 'pod' },
    { id: 'card-kind-2', title: '담당 미정', kind: 'pod' }]);
});

test('inventory absent preserves a live splitter host and the existing delegate route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-absent-live-'));
  const previous = { grid: process.env.ELANOUS_GRID_HOSTS, pool: process.env.ELANOUS_POD_POOL, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    delete process.env.ELANOUS_GRID_HOSTS;
    delete process.env.ELANOUS_POD_POOL;
    process.env.ELANOUS_CONFIG_DIR = root;
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-absent', title: '배포' });
    store.close();
    const reasons: string[] = [];
    const seen: Array<{ host?: string; hasOverride: boolean }> = [];
    const deps: TickDeps = { root, runId: 'absent', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: '배포', kind: 'pod', seat: 'MK', host: 'legacy' }],
      placeCell: () => ({ version: '0.2.17' }), observe: (_event, data) => { reasons.push(data.reason); },
      seatTurn: async (_seat, _root, host, options) => { seen.push({ host, hasOverride: options !== undefined }); return { status: 'skipped-empty' }; } };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, deps);
    const row = JSON.parse(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim());
    expect(row.host).toBe('legacy');
    expect(seen).toEqual([{ host: 'legacy', hasOverride: false }]);
    expect(reasons.filter(reason => reason.startsWith('would-host:'))).toEqual([]);
  } finally {
    if (previous.grid === undefined) delete process.env.ELANOUS_GRID_HOSTS; else process.env.ELANOUS_GRID_HOSTS = previous.grid;
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unmatched legacy host survives a blocked proposal without silently changing launch input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-legacy-host-'));
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-legacy', title: '배포' });
    store.close();
    const seen: Array<string | undefined> = [];
    const deps: TickDeps = { root, runId: 'legacy', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: '배포', kind: 'pod', seat: 'MK', host: 'legacy' }],
      gridHosts: hosts.map(host => ({ ...host, available: false })), placeCell: () => ({ version: '0.2.17' }),
      seatTurn: async (_seat, _root, host) => { seen.push(host); return { status: 'skipped-empty' }; } };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, deps);
    const state = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'legacy.json'), 'utf8'));
    const request = JSON.parse(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim());
    expect(state.cells[0]?.host).toBe('legacy');
    expect(request.host).toBe('legacy');
    expect(seen).toEqual(['legacy']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a legacy splitter host is not treated as a grid pool hint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-legacy-pool-'));
  const previous = { pool: process.env.ELANOUS_POD_POOL, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8,pool-node-c@node-c:2';
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:legacy-pool', title: 'Pod 준비' });
    store.close();
    const deps: TickDeps = { root, runId: 'legacy-pool', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: 'Pod 준비', kind: 'pod', seat: 'MK', host: 'node-b' }],
      gridHosts: [], placeCell: () => ({ version: '0.2.17' }),
      seatTurn: (seat, stateRoot, host, options) => {
        expect(host).toBe('node-b');
        expect(options).toBeUndefined();
        return runSeatLoopOnce(seat, { root: stateRoot, config: { mode: 'live-safe', seats: [seat] },
          run: async () => JSON.stringify({ outcome: 'proceed' }), running: () => [],
          now: () => new Date('2026-10-04T00:00:00Z'), versions: () => [], schedules: () => [], ...options });
      } };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, deps);
    const request = JSON.parse(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim());
    expect(request.host).toBe('node-b');
    expect(request.gridHost).toBeUndefined();
    const row = listHarnessQueue({ root })[0];
    expect(row?.poolHint).toBeUndefined();
    expect(queueLaunchArgs(row!)).toEqual(['harness', 'say', row!.input, '--substrate', 'pod']);
  } finally {
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an inventory becoming unreadable preserves the prior queued host and skips grid proposals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-inventory-missing-'));
  const previous = { pool: process.env.ELANOUS_POD_POOL, grid: process.env.ELANOUS_GRID_HOSTS, config: process.env.ELANOUS_CONFIG_DIR };
  try {
    process.env.ELANOUS_CONFIG_DIR = root;
    delete process.env.ELANOUS_POD_POOL;
    delete process.env.ELANOUS_GRID_HOSTS;
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-inventory-missing', title: 'Pod 준비' });
    store.close();
    const reasons: string[] = [];
    const deps: TickDeps = { root, window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: 'Pod 준비', kind: 'pod', seat: 'MK' }],
      placeCell: () => ({ version: '0.2.17' }), observe: (_event, data) => { reasons.push(data.reason); },
      seatTurn: async () => ({ status: 'skipped-empty' }) };
    for (const node of ['intake', 'split', 'place', 'delegate'] as const)
      await runOrchestratorNode(node, { ...deps, runId: 'first', gridHosts: hosts });
    const before = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8');
    for (const node of ['intake', 'split', 'place', 'delegate'] as const)
      await runOrchestratorNode(node, { ...deps, runId: 'second' });
    expect(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8')).toBe(before);
    expect(reasons.filter(reason => reason.startsWith('would-host:'))).toEqual(['would-host:C1:node-b']);
  } finally {
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.grid === undefined) delete process.env.ELANOUS_GRID_HOSTS; else process.env.ELANOUS_GRID_HOSTS = previous.grid;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a previously selected host disappearing without an available alternative removes the stale request hint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-unavailable-'));
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-unavailable', title: 'Pod 준비' });
    store.close();
    const base: TickDeps = { root, window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: 'C1', title: 'Pod 준비', kind: 'pod', seat: 'MK' }],
      placeCell: () => ({ version: '0.2.17' }), gridHosts: hosts,
      seatTurn: async () => ({ status: 'skipped-empty' }) };
    for (const node of ['intake', 'split', 'place', 'delegate', 'launch'] as const) await runOrchestratorNode(node, { ...base, runId: 'first' });
    const second: TickDeps = { ...base, runId: 'second', gridHosts: [],
      seatTurn: async (_seat, _root, host, options) => {
        expect(host).toBeUndefined();
        expect(options).toBeUndefined();
        return { status: 'skipped-empty' };
      } };
    await runOrchestratorNode('intake', second);
    await runOrchestratorNode('split', second);
    for (const node of ['place', 'delegate'] as const) await runOrchestratorNode(node, second);
    const beforeLaunch = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(beforeLaunch.at(-1)?.host).toBeUndefined();
    expect(JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'second.json'), 'utf8')).cells[0].host).toBeUndefined();
    await runOrchestratorNode('launch', second);
    const rows = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.host)).toEqual(['node-b', undefined]);
    expect(rows.map(row => row.gridHost)).toEqual([true, undefined]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real pool readiness feeds the place node without an injected inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-pool-test-'));
  const previous = { path: process.env.PATH, pool: process.env.ELANOUS_POD_POOL, grid: process.env.ELANOUS_GRID_HOSTS, config: process.env.ELANOUS_CONFIG_DIR, state: process.env.ELANOUS_STATE_DIR };
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const kubectl = join(bin, 'kubectl');
    writeFileSync(kubectl, '#!/bin/sh\ncase "$*" in *pool-node-b*) exit 1;; *pool-node-c*) exit 0;; esac\nexit 1\n');
    chmodSync(kubectl, 0o755);
    process.env.PATH = `${bin}:${previous.path ?? ''}`;
    delete process.env.ELANOUS_POD_POOL;
    process.env.ELANOUS_CONFIG_DIR = root;
    process.env.ELANOUS_STATE_DIR = root;
    writeFileSync(join(root, 'config.json'), JSON.stringify({ pod: { pool: 'pool-node-b@node-b:8,pool-node-c@node-c:2' } }));
    delete process.env.ELANOUS_GRID_HOSTS;
    const store = new CardStore(root);
    const card = store.createCard({ goalId: 'wish:grid-pool', title: '[MK] pod goal' });
    store.appendSection(card.id, { key: 'intake:wish:1', owner: 'steward', content: JSON.stringify({ text: '[MK] pod goal', kind: 'pod' }) });
    store.close();
    const context = join(root, 'graph-context.json');
    writeFileSync(context, JSON.stringify({ graphId: 'orchestrator', runId: 'grid-pool' }));
    const env = { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root, ELANOUS_GRAPH_CONTEXT: context,
      ELANOUS_POD_POOL: 'pool-node-b@node-b:8,pool-node-c@node-c:2' };
    for (const node of ['intake', 'split', 'place']) {
      const result = spawnSync('bun', [join(import.meta.dir, 'tick.ts'), node, '--window', '08'], { env, encoding: 'utf8' });
      expect(result.status, `${node}: ${result.stderr.slice(-500)}`).toBe(0);
    }
    const state = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'grid-pool.json'), 'utf8')) as { cells: Array<{ id: string; kind?: string }>; steps: Array<{ reason: string }> };
    expect(state.cells).toMatchObject([{ id: `${card.id}-1`, kind: 'pod' }]);
    expect(state.steps.map(step => step.reason)).toContain(`would-host:${card.id}-1:node-c`);
  } finally {
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    if (previous.pool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previous.pool;
    if (previous.grid === undefined) delete process.env.ELANOUS_GRID_HOSTS; else process.env.ELANOUS_GRID_HOSTS = previous.grid;
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previous.config;
    if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous.state;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('unknown inventory is not recorded as a null host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-unknown-test-'));
  const previous = process.env.ELANOUS_GRID_HOSTS;
  const previousPool = process.env.ELANOUS_POD_POOL;
  const previousConfig = process.env.ELANOUS_CONFIG_DIR;
  process.env.ELANOUS_CONFIG_DIR = root;
  delete process.env.ELANOUS_GRID_HOSTS;
  delete process.env.ELANOUS_POD_POOL;
  try {
    const store = new CardStore(root);
    store.createCard({ goalId: 'wish:grid-unknown', title: 'pod' });
    store.close();
    const reasons: string[] = [];
    const deps: TickDeps = {
      root, runId: 'grid-unknown', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'shadow',
      split: () => [{ id: 'C3', title: 'pod', kind: 'pod', seat: 'MK' }],
      placeCell: () => { throw new Error('shadow must not invoke placement'); },
      observe: (_event, data) => { reasons.push(data.reason); },
    };
    await runOrchestratorNode('intake', deps);
    await runOrchestratorNode('split', deps);
    await runOrchestratorNode('place', deps);
    expect(reasons.filter(reason => reason.startsWith('would-host:'))).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRID_HOSTS;
    else process.env.ELANOUS_GRID_HOSTS = previous;
    if (previousPool === undefined) delete process.env.ELANOUS_POD_POOL;
    else process.env.ELANOUS_POD_POOL = previousPool;
    if (previousConfig === undefined) delete process.env.ELANOUS_CONFIG_DIR;
    else process.env.ELANOUS_CONFIG_DIR = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual tick.ts place entry reads the supplied inventory when node-b is blocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-entry-test-'));
  try {
    const store = new CardStore(root);
    store.createCard({ goalId: 'wish:grid-entry', title: 'pod' });
    store.close();
    const context = join(root, 'graph-context.json');
    writeFileSync(context, JSON.stringify({ graphId: 'orchestrator', runId: 'grid-entry' }));
    const inventory = [{ name: 'node-b', capabilities: ['pod'], available: false },
      { name: 'node-c', capabilities: ['pod'], available: true },
      { name: 'mbp', capabilities: ['browser'], available: true }];
    const deps: TickDeps = { root, runId: 'grid-entry', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'shadow',
      split: () => [{ id: 'C1', title: 'pod', kind: 'pod', seat: 'MK' }] };
    await runOrchestratorNode('intake', deps);
    await runOrchestratorNode('split', deps);
    const env = { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root, ELANOUS_GRAPH_CONTEXT: context,
      ELANOUS_GRID_HOSTS: JSON.stringify(inventory) };
    const result = spawnSync('bun', [join(import.meta.dir, 'tick.ts'), 'place', '--window', '08'], { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const state = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'grid-entry.json'), 'utf8')) as { steps: Array<{ reason: string }> };
    expect(state.steps.map(step => step.reason)).toContain('would-host:C1:node-c');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

async function runLiveWithEnvInventory(runId: string, gridHosts: string): Promise<{ root: string; cardId: string; reasons: string[] }> {
  const root = mkdtempSync(join(tmpdir(), `${runId}-`));
  const previous = process.env.ELANOUS_GRID_HOSTS;
  process.env.ELANOUS_GRID_HOSTS = gridHosts;
  const reasons: string[] = [];
  try {
    const store = new CardStore(root);
    const card = store.createCard({ goalId: `wish:${runId}`, title: 'Pod 배포 준비' });
    store.close();
    // gridHosts 는 주입하지 않는다 — tick.ts 가 ELANOUS_GRID_HOSTS 를 스스로 읽는다. 배치 기록기만 가짜(판 원장 무접촉).
    const deps: TickDeps = { root, runId, window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'live',
      cards: () => [card], split: () => [{ id: runId, title: 'Pod 배포 준비', kind: 'pod', seat: 'MK' }],
      placeCell: () => ({ version: '0.2.18' }), observe: (_event, data) => { reasons.push(data.reason); } };
    for (const node of ['intake', 'split', 'place', 'delegate'] as const) await runOrchestratorNode(node, deps);
    return { root, cardId: card.id, reasons };
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRID_HOSTS; else process.env.ELANOUS_GRID_HOSTS = previous;
  }
}

function requestHost(root: string, key: string): string | undefined | null {
  const path = join(root, 'seat-requests', 'requests.jsonl');
  if (!existsSync(path)) return null;
  const row = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { key: string; host?: string }).filter(item => item.key === key).at(-1);
  return row ? row.host : null;
}

test('live tick reads the env inventory (no injected hosts) and writes host=node-c into requests.jsonl when node-b is blocked', async () => {
  const inventory = [{ name: 'node-b', capabilities: ['pod'], available: false }, { name: 'node-c', capabilities: ['pod'], available: true }];
  const { root, cardId, reasons } = await runLiveWithEnvInventory('grid-live-env', JSON.stringify(inventory));
  try {
    expect(reasons).toContain('would-host:grid-live-env:node-c');
    expect(requestHost(root, `orch:${cardId}:grid-live-env`)).toBe('node-c');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unreadable explicit inventory proposes nothing and never falls back to the pod pool roster', async () => {
  const previousPool = process.env.ELANOUS_POD_POOL;
  process.env.ELANOUS_POD_POOL = 'pool-node-b@node-b:8,pool-node-c@node-c:2';
  try {
    const { root, cardId, reasons } = await runLiveWithEnvInventory('grid-bad-inventory', '{not json');
    try {
      expect(reasons.filter(reason => reason.startsWith('would-host:'))).toEqual([]);
      expect(reasons).toContain('grid-inventory-unreadable');
      // 행이 생기더라도 host 는 없다 — 기존 경로.
      expect(requestHost(root, `orch:${cardId}:grid-bad-inventory`) ?? undefined).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  } finally {
    if (previousPool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = previousPool;
  }
});

test('shadow node reports blocked hosts but never calls the injected placement writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grid-shadow-test-'));
  try {
    const store = new CardStore(root);
    store.createCard({ goalId: 'wish:grid-shadow', title: 'pod' });
    store.close();
    const reasons: string[] = [];
    const deps: TickDeps = {
      root, runId: 'grid-shadow', window: '08', now: new Date('2026-10-04T00:00:00Z'), mode: 'shadow',
      split: () => [{ id: 'C2', title: 'pod', kind: 'pod', seat: 'MK' }],
      gridHosts: hosts.map(host => ({ ...host, available: false })),
      placeCell: () => { throw new Error('shadow must not invoke placement'); },
      observe: (_event, data) => { reasons.push(data.reason); },
    };
    await runOrchestratorNode('intake', deps);
    await runOrchestratorNode('split', deps);
    const state = await runOrchestratorNode('place', deps);
    await runOrchestratorNode('delegate', deps);
    expect(reasons).toContain('would-host:C2:null');
    expect(state.steps.map(step => step.reason)).toContain('would-host:C2:null');
    expect(state.placed).toBe(0);
    expect(state.cells[0]?.host).toBeUndefined();
    expect(readFileSync(join(root, 'loop', 'orchestrator', 'grid-shadow.json'), 'utf8')).not.toContain('"host"');
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
