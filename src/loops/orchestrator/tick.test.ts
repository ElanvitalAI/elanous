import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import { addItem, setItem, listChecklist } from '../../release-loop/checklist.js';
import { splitCard } from '../../flow-loop/split.js';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CardStore } from '../../task-cards/card-store.js';
import { buildUserConfig, resetUserConfig } from '../../user-config.js';
import { nextOrchestratorWindowAt, reconciliation, reportLine, runOrchestratorNode, type Node, type PlacementInput, type TickDeps } from './tick.js';
import { openMsgStore } from '../../msg/msg-store.js';
import { checkLoopNeighbors, SEAT_NEIGHBORS } from '../neighbor-runtime.js';
import { handleSeatRequests } from '../../nexus/api/seat-requests.js';

const stages: Node[] = ['intake', 'split', 'place', 'delegate', 'launch', 'reconcile', 'report'];
const fixture = async (run: (root: string, id: string, logged: Array<{ event: string; reason: string; targetLoopId?: string }>) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), 'orch-test-'));
  const store = new CardStore(root);
  const wanted = store.createCard({ goalId: 'wish:one', title: '새 카드' });
  const existing = store.createCard({ goalId: 'wish:two', title: '이미 분할' });
  store.appendSection(existing.id, { key: 'orch:split', owner: 'orchestrator', content: 'already split' });
  store.close();
  const logged: Array<{ event: string; reason: string; targetLoopId?: string }> = [];
  try { await run(root, wanted.id, logged); }
  finally { rmSync(root, { recursive: true, force: true }); }
};
const invoke = async (root: string, runId: string, window: '08' | '12' | '18', deps: TickDeps, logged: Array<{ event: string; reason: string; targetLoopId?: string }>) => {
  let final;
  for (const node of stages) final = await runOrchestratorNode(node, { root, runId, window, now: new Date('2026-10-04T00:00:00Z'),
    print: () => {}, observe: (event, data) => logged.push({ event, reason: data.reason, ...(data.targetLoopId ? { targetLoopId: data.targetLoopId } : {}) }),
    seatTurn: async () => ({ status: 'skipped-empty' }), ...deps });
  return final!;
};

test('orchestrator renews its signal during a held node and reports a failed node as degraded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-held-signal-'));
  const start = new Date('2026-10-05T00:00:00Z');
  let clock = start;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const signal = () => {
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try { return store.db.query('SELECT at, health, ends_at FROM loop_signals WHERE loop_id=?').get('orchestrator'); }
    finally { store.close(); }
  };
  try {
    await runOrchestratorNode('intake', { root, now: start, mode: 'shadow', runId: 'held', window: '08' });
    const running = runOrchestratorNode('split', { root, now: () => clock, mode: 'shadow', runId: 'held', window: '08',
      heartbeatIntervalMs: 10, loadAdapter: async () => { entered(); await held; throw Error('split unavailable'); } });
    await started;
    clock = new Date(start.getTime() + 241 * 60_000);
    const deadline = Date.now() + 1000;
    while ((signal() as { at: string }).at !== clock.toISOString() && Date.now() < deadline) await Bun.sleep(10);
    expect(signal()).toEqual({ at: clock.toISOString(), health: 'healthy', ends_at: '2026-10-05T10:00:00.000Z' });
    release();
    await expect(running).rejects.toThrow('split unavailable');
    expect(signal()).toMatchObject({ health: 'degraded' });
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('orchestrator node sends the durable signal consumed by seat neighbors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-signal-'));
  const now = new Date('2026-10-05T00:00:00Z');
  try {
    await runOrchestratorNode('intake', { root, now, mode: 'shadow', runId: 'heartbeat-check', window: '08' });
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.db.query('SELECT at, health, ends_at FROM loop_signals WHERE loop_id=?').get('orchestrator'))
        .toEqual({ at: now.toISOString(), health: 'healthy', ends_at: '2026-10-05T04:00:00.000Z' });
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the orchestrator lease spans the scheduled gap: no false absence overnight, absence once the next window is missed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-gap-'));
  const ranAt = new Date('2026-10-05T09:05:00Z'); // 18:05 KST — the last window of the day
  const orchestrator = SEAT_NEIGHBORS.MK!.filter(peer => peer.id === 'orchestrator');
  try {
    expect(nextOrchestratorWindowAt(ranAt).toISOString()).toBe('2026-10-05T23:00:00.000Z'); // 08:00 KST next day
    await runOrchestratorNode('intake', { root, now: ranAt, mode: 'shadow', runId: 'gap', window: '18' });
    for (const at of ['2026-10-05T12:00:00Z', '2026-10-05T18:00:00Z', '2026-10-05T23:30:00Z']) // 21:00 · 03:00 · 08:30 KST
      expect(checkLoopNeighbors(root, 'mk-seat', orchestrator, new Date(at))).toEqual([]);
    expect(checkLoopNeighbors(root, 'mk-seat', orchestrator, new Date('2026-10-06T00:01:00Z')))
      .toMatchObject([{ neighbor: 'orchestrator', reason: 'end-expired', action: 'escalate', to: 'human' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('orchestrator degradation and per-tick cap', () => {
  test('L1 makes one rule-only cell per card, grades its body, never calls split and leads the briefing', async () => fixture(async (root, id, logged) => {
    const store = new CardStore(root);
    store.appendSection(id, { key: 'intake:wish:1', owner: 'steward', content: '설명\n루브릭: A3 E3 R2 D2 M2 B1 S2 X1' });
    const other = store.createCard({ goalId: 'wish:third', title: '두 번째' });
    store.close();
    let calls = 0;
    let printed = '';
    const state = await invoke(root, 'l1', '08', { mode: 'shadow', degradation: () => ({ llm: false, board: true }),
      split: () => { calls++; return []; }, print: line => { printed = line; }, loadAdapter: async () => undefined }, logged);
    expect(calls).toBe(0);
    expect(state.cells.map(cell => ({ id: cell.id, origin: cell.origin, priority: cell.priority }))).toEqual([
      { id: other.id, origin: 'candidate', priority: 'P2' }, { id, origin: 'candidate', priority: 'P1' },
    ]);
    expect(state.missing).not.toContain('flow1a-absent');
    expect(printed.split('\n')[0]).toBe('강등 L1: LLM 불가');
  }));

  test('L2 skips new delegation and launch, but still reconciles and reports', async () => fixture(async (root, id, logged) => {
    let turns = 0;
    let printed = '';
    const state = await invoke(root, 'l2', '08', { mode: 'shadow', degradation: () => ({ llm: true, board: false }),
      split: () => [{ id: 'C1', title: '칸', seat: 'MK' }],
      seatTurn: async () => { turns++; return { status: 'queued' }; }, print: line => { printed = line; } }, logged);
    expect(state.wouldDelegate).toBe(0);
    expect(state.launched).toEqual([]);
    expect(turns).toBe(0);
    expect(logged.filter(row => row.event === 'degraded-skip')).toEqual([
      { event: 'degraded-skip', reason: 'place' },
      { event: 'degraded-skip', reason: 'delegate' },
      { event: 'degraded-skip', reason: 'launch' },
    ]);
    expect(state.nodes.reconcile).toBe('skipped');
    const noon = await invoke(root, 'l2-noon', '12', { mode: 'shadow', degradation: () => ({ llm: true, board: false }),
      print: line => { printed = line; } }, logged);
    expect(noon.nodes.reconcile).toBe('ok');
    expect(noon.reconciled.unknown).toBe(1);
    expect(printed.startsWith('강등 L2: board 불가\n')).toBe(true);
    const bothDown = await invoke(root, 'l2-both', '12', { mode: 'shadow',
      degradation: () => ({ llm: false, board: false }), print: line => { printed = line; } }, logged);
    expect(bothDown.degradation).toEqual({ level: 2, reason: 'LLM·board 불가' });
    expect(printed.startsWith('강등 L2: LLM·board 불가\n')).toBe(true);
  }));

  test('configured cap defers two of three cells and carries them to the following tick', async () => fixture(async (root, id, logged) => {
    const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
    setElanousConfigDir(configDir);
    try {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 1 } } }));
      const deps: TickDeps = { mode: 'shadow', gridHosts: [], split: () => ['C1', 'C2', 'C3'].map(cell => ({ id: cell, title: cell, seat: 'MK' })),
        placeCell: () => null };
      const first = await invoke(root, 'cap-first', '08', deps, logged);
      expect(first.wouldDelegate).toBe(1);
      expect(first.deferredCells?.map(cell => cell.id)).toEqual(['C2', 'C3']);
      expect(logged.filter(row => row.event === 'cap-deferred').map(row => row.reason)).toEqual([`orch:${id}:C2`, `orch:${id}:C3`]);
      const next = await invoke(root, 'cap-next', '08', deps, logged);
      expect(next.wouldDelegate).toBe(1);
      expect(next.delegatedKeys).toEqual([`orch:${id}:C2`]);
      expect(next.deferredCells?.map(cell => cell.id)).toEqual(['C3']);
      const last = await invoke(root, 'cap-last', '08', deps, logged);
      expect(last.delegatedKeys).toEqual([`orch:${id}:C3`]);
      expect(last.deferredCells).toEqual([]);
      const fourth = await invoke(root, 'cap-fourth', '08', deps, logged);
      expect(fourth.wouldDelegate).toBe(0);
      expect(fourth.deferredCells).toEqual([]);
    } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
  }), 30_000);

  test('deferred cells from a prior day are drained before fresh cells, even when the current cap is unset', async () => fixture(async (root, id, logged) => {
    const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
    setElanousConfigDir(configDir);
    try {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 0 } } }));
      const first = await invoke(root, 'carry-first', '08', { mode: 'shadow', gridHosts: [],
        split: () => [{ id: 'C1', title: '미룬 칸', seat: 'MK' }] }, logged);
      expect(first.deferredCells?.map(cell => cell.id)).toEqual(['C1']);
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: {} } }));
      const store = new CardStore(root);
      const fresh = store.createCard({ goalId: 'wish:fresh', title: '새 칸' });
      store.close();
      let state;
      for (const node of stages) state = await runOrchestratorNode(node, { root, runId: 'carry-second', window: '08', mode: 'shadow',
        now: new Date('2026-10-05T00:00:00Z'), split: card => [{ id: card.id, title: card.title, seat: 'TC' }],
        placeCell: () => null, gridHosts: [], loadAdapter: async () => undefined, print: () => {} });
      expect(state!.cells.map(cell => cell.id)).toEqual(['C1', fresh.id, id]);
      expect(state!.wouldDelegate).toBe(3);
      expect(state!.deferredCells).toEqual([]);
    } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
  }), 30_000);

  test('a new card never overtakes deferred work at the cap', async () => fixture(async (root, id, logged) => {
    const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
    setElanousConfigDir(configDir);
    try {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 1 } } }));
      const first = await invoke(root, 'queue-first', '08', { mode: 'shadow', gridHosts: [],
        split: () => [{ id: 'C1', title: '먼저', seat: 'MK' }, { id: 'C2', title: '이월', seat: 'TC' }], placeCell: () => null }, logged);
      expect(first.deferredCells?.map(cell => cell.id)).toEqual(['C2']);
      const store = new CardStore(root);
      const fresh = store.createCard({ goalId: 'wish:latest', title: '새 카드' });
      store.close();
      const next = await invoke(root, 'queue-next', '08', { mode: 'shadow', gridHosts: [],
        split: card => [{ id: card.id, title: card.title, seat: 'UX' }], placeCell: () => null }, logged);
      expect(next.delegatedKeys).toEqual([`orch:${id}:C2`]);
      expect(next.deferredCells?.map(cell => cell.id).sort()).toEqual([fresh.id, id].sort());
    } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
  }), 30_000);

  test('L1 live rule-only split does not write a split journal or request a seat turn', async () => fixture(async (root, id, logged) => {
    let turns = 0;
    const state = await invoke(root, 'l1-live', '08', { mode: 'live', degradation: () => ({ llm: false, board: true }),
      split: () => { throw new Error('split must not run'); }, placeCell: () => { throw new Error('unowned cell must not be placed'); },
      gridHosts: [], seatTurn: async () => { turns++; return { status: 'queued' }; } }, logged);
    expect(state.cells).toEqual([{ cardId: id, id, title: '새 카드', origin: 'candidate', priority: 'P2' }]);
    expect(turns).toBe(0);
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
    expect(readFileSync(join(root, 'task-cards', `${id}.jsonl`), 'utf8')).not.toContain('orch:split');
  }));

  test('L0 explicit healthy signal leaves the original splitter and report unchanged', async () => fixture(async (root, id, logged) => {
    let splitCalls = 0;
    let printed = '';
    const state = await invoke(root, 'healthy', '08', { mode: 'shadow',
      degradation: () => ({ llm: true, board: true }),
      split: () => { splitCalls++; return [{ id: 'C1', title: '칸', seat: 'MK' }]; },
      placeCell: () => null, print: line => { printed = line; } }, logged);
    expect(splitCalls).toBe(1);
    expect(state.cells).toEqual([{ cardId: id, id: 'C1', title: '칸', origin: 'flow1a', seat: 'MK' }]);
    expect(state.wouldDelegate).toBe(1);
    expect(printed).toBe('orchestrator 08 cards=1 cells=1 placed=0 delegated=would 1 reconciled=0/0/0/0 mode=shadow');
  }));

  test('live board outage does not launch queued work; recovery carries its unassigned cells forward', async () => fixture(async (root, id, logged) => {
    const pending = join(root, 'seat-requests', 'requests.jsonl');
    mkdirSync(join(root, 'seat-requests'), { recursive: true });
    writeFileSync(pending, `${JSON.stringify({ key: 'orch:older:C1', seat: 'MK', status: 'queued' })}\n`);
    let turns = 0;
    const deps: TickDeps = { root, runId: 'board-down', window: '08', mode: 'live',
      now: new Date('2026-10-04T00:00:00Z'), degradation: () => ({ llm: true, board: true }),
      split: () => [{ id: 'C2', title: '나중에 배정', seat: 'TC' }], placeCell: () => ({ version: '0.2.14' }),
      seatTurn: async () => { turns++; return { status: 'queued' }; }, print: () => {},
      observe: (event, data) => logged.push({ event, reason: data.reason }) };
    for (const node of ['intake', 'split', 'place'] as const) await runOrchestratorNode(node, deps);
    deps.degradation = () => ({ llm: true, board: false });
    let degraded;
    for (const node of ['delegate', 'launch', 'reconcile', 'report'] as const) degraded = await runOrchestratorNode(node, deps);
    expect(degraded!.delegated).toBe(0);
    expect(degraded!.launched).toEqual([]);
    expect(degraded!.deferredCells?.map(cell => cell.id)).toEqual(['C2']);
    expect(turns).toBe(0);
    expect(logged.filter(row => row.event === 'degraded-skip').map(row => row.reason)).toEqual(['delegate', 'launch']);
    const recovered = await invoke(root, 'board-recovered', '08', { mode: 'live',
      split: () => { throw new Error('already split'); }, placeCell: () => ({ version: '0.2.14' }),
      seatTurn: async () => { turns++; return { status: 'queued' }; } }, logged);
    expect(recovered.delegated).toBe(1);
    expect(recovered.delegatedKeys).toEqual([`orch:${id}:C2`]);
    expect(turns).toBe(1);
  }), 30_000);

  test('live cap queues only one placed request and never launches a deferred seat early', async () => fixture(async (root, id, logged) => {
    const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
    setElanousConfigDir(configDir);
    try {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 1 } } }));
      const seats: string[] = [];
      const state = await invoke(root, 'live-cap', '08', { mode: 'live', gridHosts: [],
        split: () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }, { id: 'C2', title: '둘째 칸', seat: 'TC' }],
        placeCell: () => ({ version: '0.2.14' }),
        seatTurn: async seat => { seats.push(seat); return { status: 'queued' }; } }, logged);
      expect(state.delegated).toBe(1);
      expect(state.deferredCells?.map(cell => cell.id)).toEqual(['C2']);
      expect(seats).toEqual(['MK']);
      expect(logged.filter(row => row.event === 'cap-deferred')).toEqual([{ event: 'cap-deferred', reason: `orch:${id}:C2`, targetLoopId: 'tc-seat' }]);
      const firstRows = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n');
      expect(firstRows).toHaveLength(1);
      const next = await invoke(root, 'live-cap-next', '08', { mode: 'live', gridHosts: [],
        split: () => { throw new Error('already split'); }, seatTurn: async seat => { seats.push(seat); return { status: 'queued' }; } }, logged);
      expect(next.delegated).toBe(1);
      expect(seats).toEqual(['MK', 'TC']);
      expect(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
  }), 30_000);

  test('no signal and no cap preserve cells, would-delegate count and exact report text', async () => fixture(async (root, id, logged) => {
    let printed = '';
    const state = await invoke(root, 'unchanged', '08', { mode: 'shadow',
      split: () => [{ id: 'C1', title: '칸', seat: 'MK' }], print: line => { printed = line; },
      placeCell: () => null }, logged);
    expect(state.cells).toEqual([{ cardId: id, id: 'C1', title: '칸', origin: 'flow1a', seat: 'MK' }]);
    expect(state.wouldDelegate).toBe(1);
    expect(printed).toBe('orchestrator 08 cards=1 cells=1 placed=0 delegated=would 1 reconciled=0/0/0/0 mode=shadow');
    expect(state.degradation).toBeUndefined();
  }));
});

describe('orchestrator graph command nodes', () => {
  test('configuration defaults to shadow and accepts only explicit live/off', async () => fixture(async (root) => {
    const path = join(root, 'config.json');
    expect(buildUserConfig(path).loops?.orchestrator?.mode).toBe('shadow');
    for (const [configured, expected] of [['live', 'live'], ['off', 'off'], ['invalid', 'shadow']] as const) {
      writeFileSync(path, JSON.stringify({ loops: { orchestrator: { mode: configured } } }));
      expect(buildUserConfig(path).loops?.orchestrator?.mode).toBe(expected);
    }
  }));
  test('shadow without adapters picks only the unsplit wish, records both absences and does not touch the request journal', async () => fixture(async (root, id, logged) => {
    const before = readFileSync(join(root, 'task-cards', `${id}.jsonl`), 'utf8');
    const state = await invoke(root, 'shadow08', '08', { loadAdapter: async (path, name) =>
      path === '../../flow-loop/split.js' && name === 'splitCard' ? splitCard : undefined }, logged);
    expect(state.cards.map(card => card.id)).toEqual([id]);
    expect(state.cells).toEqual([{ cardId: id, id, title: '새 카드', origin: 'flow1a' }]);
    expect(state.missing).toEqual(['relplan1-absent']);
    expect(logged.filter(row => row.event === 'node-missing').map(row => row.reason)).toEqual(state.missing);
    expect(logged.some(row => row.event === 'would-delegate')).toBe(false); // no owner is guessed
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
    expect(readFileSync(join(root, 'task-cards', `${id}.jsonl`), 'utf8')).toBe(before);
    expect(existsSync(join(root, 'release', 'features.sqlite'))).toBe(false);
    expect(readFileSync(join(root, 'loop', 'orchestrator', 'shadow08.json'), 'utf8')).toContain('split:');
  }));

  test('shadow asks the splitter in shadow mode only, never the placer, and leaves card and placement ledgers as they were', async () => fixture(async (root, id, logged) => {
    const cardPath = join(root, 'task-cards', `${id}.jsonl`);
    const placementPath = join(root, 'release', 'features.sqlite');
    const cardBefore = readFileSync(cardPath);
    mkdirSync(join(root, 'release'), { recursive: true });
    writeFileSync(placementPath, 'existing placement ledger');
    const placementBefore = readFileSync(placementPath);
    const shadowFlags: Array<boolean | undefined> = [];
    const state = await invoke(root, 'shadow-assigned', '08', {
      cards: () => { writeFileSync(cardPath, 'mutated'); return []; },
      // A FLOW1a splitter writes only outside shadow; the loop must pass the flag.
      split: (_card, opts) => { shadowFlags.push(opts?.shadow); if (!opts?.shadow) writeFileSync(cardPath, 'mutated'); return [{ id: 'C1', title: '첫 칸', seat: 'MK' }]; },
      placeCell: () => { writeFileSync(placementPath, 'mutated'); return { version: '0.2.14' }; },
    }, logged);
    expect(shadowFlags).toEqual([true]);
    expect(state.cells).toEqual([{ cardId: id, id: 'C1', title: '첫 칸', origin: 'flow1a', seat: 'MK' }]);
    expect(logged.filter(row => row.reason.endsWith('shadow-not-invoked')).map(row => row.reason)).toEqual(['relplan1-shadow-not-invoked']);
    expect(readFileSync(cardPath)).toEqual(cardBefore);
    expect(readFileSync(placementPath)).toEqual(placementBefore);
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
  }));

  test('a real 08:00 shadow run (intake → split → place → delegate) produces the would-delegate it promises', async () => fixture(async (root, id, logged) => {
    const cardPath = join(root, 'task-cards', `${id}.jsonl`);
    const original = readFileSync(cardPath, 'utf8');
    const state = await invoke(root, 'shadow-projection', '08', { mode: 'shadow',
      split: () => [{ id: 'C1', title: '칸', seat: 'MK' }],
      placeCell: () => { throw new Error('shadow must not call place'); },
    }, logged);
    // The state file was written by the run itself, not by the test.
    const saved = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'shadow-projection.json'), 'utf8'));
    expect(saved.nodes).toMatchObject({ intake: 'ok', split: 'ok', place: 'ok', delegate: 'ok', launch: 'ok' });
    expect(state.wouldDelegate).toBe(1);
    expect(logged).toContainEqual({ event: 'would-delegate', reason: `orch:${id}:C1 (unplaced)`, targetLoopId: 'cmo-seat' });
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
    expect(readFileSync(cardPath, 'utf8')).toBe(original);
  }));

  test('rerunning a completed node with the same runId keeps its ok result (review round 3)', async () => fixture(async (root, _id, logged) => {
    await invoke(root, 'rerun', '08', { mode: 'shadow', split: () => [{ id: 'C1', title: '칸', seat: 'MK' }], placeCell: () => null }, logged);
    const again = await runOrchestratorNode('delegate', { root, runId: 'rerun', window: '08', mode: 'shadow', now: new Date('2026-10-04T00:00:00Z') });
    expect(again.nodes.delegate).toBe('ok');
    // and a later window still finds this morning's cells
    const noon = await runOrchestratorNode('intake', { root, runId: 'rerun-noon', window: '12', mode: 'shadow', now: new Date('2026-10-04T03:00:00Z') });
    expect(noon.nodes.intake).toBe('skipped');
  }));

  test('shadow reconciliation ignores a mutating checklist injection and preserves the ledger', async () => fixture(async (root, id, logged) => {
    setElanousConfigDir(root);
    try {
      addItem('0.2.14', { id: 'C1', title: '칸', owner: 'MK' });
      setItem('0.2.14', 'C1', { status: 'green' }, 'MK');
      const requestPath = join(root, 'seat-requests', 'requests.jsonl');
      const placementPath = join(root, 'release', 'features.sqlite');
      mkdirSync(join(root, 'seat-requests'), { recursive: true });
      writeFileSync(requestPath, `${JSON.stringify({ key: `orch:${id}:C1`, status: 'queued' })}\n`);
      const before = readFileSync(placementPath);
      const morning = await invoke(root, 'seed-shadow', '08', { mode: 'shadow' }, logged);
      const statePath = join(root, 'loop', 'orchestrator', 'seed-shadow.json');
      writeFileSync(statePath, JSON.stringify({ ...morning, cells: [{ cardId: id, id: 'C1', title: '칸', seat: 'MK', version: '0.2.14', origin: 'flow1a' }] }));
      const noon = await invoke(root, 'shadow-noon', '12', { mode: 'shadow',
        checklist: () => { writeFileSync(placementPath, 'mutated'); return [{ id: 'C1', status: 'red' }]; },
      }, logged);
      expect(noon.reconciled.reached).toBe(1);
      expect(readFileSync(placementPath)).toEqual(before);
    } finally { resetElanousConfigDir(); }
  }));

  test('live never places or delegates an unverified fallback candidate when only placement is available', async () => fixture(async (root, id, logged) => {
    let placements = 0;
    const state = await invoke(root, 'no-flow1a', '08', { mode: 'live',
      placeCell: () => { placements++; return { version: '0.2.14', seat: 'MK' }; },
    }, logged);
    expect(state.cells).toEqual([{ cardId: id, id, title: '새 카드', origin: 'flow1a' }]);
    expect(state.cells[0]?.seat).toBeUndefined();
    expect(placements).toBe(0);
    expect(state.placed).toBe(0);
    expect(state.delegated).toBe(0);
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
  }));

  test('changed graph YAML and recipes execute a shadow tick across subprocesses without a seat session', async () => fixture(async (root, id) => {
    const context = join(root, 'graph-context.json');
    writeFileSync(context, JSON.stringify({ graphId: 'orchestrator', runId: 'cli08' }));
    const graphDir = resolve(import.meta.dir, '../../../graphs/orchestrator');
    const graph = parseYaml(readFileSync(join(graphDir, 'orchestrator.yaml'), 'utf8'));
    const recipes = parseYaml(readFileSync(join(graphDir, 'recipes.yaml'), 'utf8'));
    let next = graph.entry_node as string;
    for (const expected of stages) {
      expect(next).toBe(expected);
      const definition = graph.nodes.find((row: { node_id: string }) => row.node_id === next);
      const recipe = recipes[definition.recipe.slice('cmd:'.length)];
      expect(recipe.command).toContain(`tick.ts\" ${expected}`);
      const result = spawnSync('bash', ['-c', `${recipe.command} --window 08`], {
        env: { ...process.env, ELANOUS_GRAPH_DIR: graphDir, ELANOUS_GRAPH_CONTEXT: context, ELANOUS_STATE_DIR: root }, encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const edge = graph.edges.find((row: { from: string }) => row.from === next);
      expect(edge.map.fail).toBe('failed');
      next = edge.map.ok;
    }
    expect(next).toBe('done');
    const state = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'cli08.json'), 'utf8'));
    expect(state.cards.map((card: { id: string }) => card.id)).toEqual([id]);
    expect(state.nodes).toEqual({ intake: 'ok', split: 'ok', place: 'ok', delegate: 'ok', launch: 'ok', reconcile: 'skipped', report: 'ok' });
    expect(state.steps.map((step: { node: Node }) => step.node)).toContain('split');
    expect(state.steps.map((step: { node: Node }) => step.node)).toContain('place');
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
  }), 60_000);

  test('ORCH-LIVE-1008: graph recipes take the window from ELANOUS_ORCH_WINDOW; set-but-invalid exits 2; --window wins', async () => fixture(async (root) => {
    const context = join(root, 'graph-context.json');
    writeFileSync(context, JSON.stringify({ graphId: 'orchestrator', runId: 'env08' }));
    const graphDir = resolve(import.meta.dir, '../../../graphs/orchestrator');
    const recipes = parseYaml(readFileSync(join(graphDir, 'recipes.yaml'), 'utf8'));
    const env = { ...process.env, ELANOUS_GRAPH_DIR: graphDir, ELANOUS_GRAPH_CONTEXT: context, ELANOUS_STATE_DIR: root };
    for (const node of ['intake', 'split']) {
      const result = spawnSync('bash', ['-c', recipes[`orchestrator-${node}`].command], { env: { ...env, ELANOUS_ORCH_WINDOW: '08' }, encoding: 'utf8' });
      expect(result.status).toBe(0);
    }
    const state = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'env08.json'), 'utf8'));
    expect(state.window).toBe('08');
    expect(state.nodes).toMatchObject({ intake: 'ok', split: 'ok' });
    const bad = spawnSync('bash', ['-c', recipes['orchestrator-intake'].command], { env: { ...env, ELANOUS_ORCH_WINDOW: '09' }, encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('ELANOUS_ORCH_WINDOW');
    for (const value of ['', '  ', ' 08 ']) {
      const blank = spawnSync('bash', ['-c', recipes['orchestrator-intake'].command], { env: { ...env, ELANOUS_ORCH_WINDOW: value }, encoding: 'utf8' });
      expect(blank.status).toBe(2);
      expect(blank.stderr).toContain('ELANOUS_ORCH_WINDOW');
    }
    // The flag wins over the variable: a 12 flag with ELANOUS_ORCH_WINDOW=08 writes a 12-window run.
    const flagContext = join(root, 'graph-context-flag.json');
    writeFileSync(flagContext, JSON.stringify({ graphId: 'orchestrator', runId: 'flag12' }));
    const flagWins = spawnSync('bash', ['-c', `${recipes['orchestrator-intake'].command} --window 12`], { env: { ...env, ELANOUS_GRAPH_CONTEXT: flagContext, ELANOUS_ORCH_WINDOW: '08' }, encoding: 'utf8' });
    expect(flagWins.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'flag12.json'), 'utf8')).window).toBe('12');
    const bare = spawnSync('bash', ['-c', `${recipes['orchestrator-intake'].command} --window`], { env, encoding: 'utf8' });
    expect(bare.status).toBe(2);
  }), 60_000);

  test('live writes two append-only requests once; noon skips intake and delegate and reconciles persisted cells', async () => fixture(async (root, id, logged) => {
    const requestPath = join(root, 'seat-requests', 'requests.jsonl');
    const deps: TickDeps = { mode: 'live', split: () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }, { id: 'C2', title: '둘째 칸', seat: 'TC' }],
      placeCell: () => ({ version: '0.2.14' }), checklist: () => [{ id: 'C1', status: 'green' }, { id: 'C2', status: 'red' }],
      loadAdapter: async () => undefined };
    const first = await invoke(root, 'live08a', '08', deps, logged);
    const original = readFileSync(requestPath, 'utf8');
    const lines = original.trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(row => ({ key: row.key, seat: row.seat, loopId: row.loopId, version: row.version }))).toEqual([
      { key: `orch:${id}:C1`, seat: 'MK', loopId: 'cmo-seat', version: '0.2.14' },
      { key: `orch:${id}:C2`, seat: 'TC', loopId: 'tc-seat', version: '0.2.14' },
    ]);
    expect(logged.filter(row => row.event === 'exchange' && row.reason === 'queued').map(row => row.targetLoopId)).toEqual(['cmo-seat', 'tc-seat']);
    expect(lines.every(row => row.status === 'queued' && row.source === 'orchestrator' && row.queuedAt && row.cell && row.text)).toBe(true);
    expect(first.delegated).toBe(2);
    const store = new CardStore(root);
    try { expect(store.getCard(id)?.sections.filter(section => section.key === 'orch:split')).toHaveLength(1); }
    finally { store.close(); }
    const second = await invoke(root, 'live08b', '08', deps, logged);
    expect(second.cards).toEqual([]);
    expect(second.cells).toEqual([]);
    expect(second.delegated).toBe(0);
    expect(readFileSync(requestPath, 'utf8')).toBe(original);
    const noon = await invoke(root, 'live12', '12', deps, logged);
    expect(noon.nodes.intake).toBe('skipped');
    expect(noon.nodes.delegate).toBe('skipped');
    expect(noon.reconciled).toEqual({ reached: 1, progressing: 0, blocked: 1, unknown: 0 });
    expect(readFileSync(requestPath, 'utf8')).toBe(original);
    const evening = await invoke(root, 'live18', '18', deps, logged);
    expect(evening.reconciled).toEqual(noon.reconciled);
    expect(evening.missing).toContain('k1b-absent');
  }));

  test('noon state reconciles distinct cards from two morning runs, not just the last one', async () => fixture(async (root, id, logged) => {
    const deps: TickDeps = { mode: 'live', split: card => [{ id: `cell-${card.goalId.slice(5)}`, title: card.title, seat: 'MK' }],
      placeCell: () => ({ version: '0.2.14' }), checklist: () => [
        { id: 'cell-one', status: 'green' }, { id: 'cell-three', status: 'red' },
      ] };
    const first = await invoke(root, 'morning-first', '08', deps, logged);
    expect(first.cards.map(card => card.id)).toEqual([id]);
    const store = new CardStore(root);
    const next = store.createCard({ goalId: 'wish:three', title: '세 번째 카드' });
    store.close();
    const second = await invoke(root, 'morning-second', '08', deps, logged);
    expect(second.cards.map(card => card.id)).toEqual([next.id]);
    const noon = await invoke(root, 'actual-noon', '12', deps, logged);
    const persisted = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'actual-noon.json'), 'utf8'));
    expect(noon.nodes.intake).toBe('skipped');
    expect(noon.nodes.delegate).toBe('skipped');
    expect(persisted.cells.map((cell: { cardId: string }) => cell.cardId).sort()).toEqual([id, next.id].sort());
    expect(persisted.reconciled).toEqual({ reached: 1, progressing: 0, blocked: 1, unknown: 0 });
  }));

  test('reconcile reports only bounded run summaries for completed, failed and running harness ledgers', async () => fixture(async (root, _id, logged) => {
    const dir = join(root, 'self-dev-runs');
    mkdirSync(dir);
    const rawGoal = 'GOAL_ORIGINAL_' + 'x'.repeat(180);
    const prBody = 'PR_BODY_' + 'y'.repeat(180);
    const updatedAt = new Date('2026-10-04T02:00:00Z').getTime();
    for (const [runId, status, summaryLine] of [
      ['success', 'done', 'CTX-SUCCESS · merged · PR #17'],
      ['failure', 'failed', 'CTX-FAILURE · gate-failed'],
      ['ongoing', 'running', `CTX-ONGOING · ${'z'.repeat(180)}`],
    ] as const) {
      writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId, createdAt: updatedAt, updatedAt,
        goals: [{ feature: rawGoal }], results: [{ taskId: runId, feature: rawGoal, status, prBody }], summaryLine }));
    }
    let output = '';
    const state = await invoke(root, 'summary12', '12', { mode: 'shadow', print: line => { output = line; } }, logged);
    expect(state.runSummaries).toHaveLength(3);
    expect(state.runSummaries).toContain('CTX-SUCCESS · merged · PR #17');
    expect(state.runSummaries).toContain('CTX-FAILURE · gate-failed');
    expect(state.runSummaries?.find(line => line.startsWith('CTX-ONGOING'))?.length).toBe(120);
    expect(state.runSummaries?.every(line => line.length <= 120)).toBe(true);
    expect(output.split('\n').slice(1)).toEqual(state.runSummaries ?? []);
    expect(output.split('\n')[0]).toBe(reportLine({ ...state, runSummaries: [] }));
    expect(output).not.toContain(rawGoal);
    expect(output).not.toContain(prBody);
    expect(output).not.toContain('z'.repeat(120));
  }));

  test('reconcile reads a checklist created by the release checklist API without writing to it', async () => fixture(async (root, id, logged) => {
    setElanousConfigDir(root);
    try {
      addItem('0.2.14', { id: 'C1', title: '칸', owner: 'MK' });
      setItem('0.2.14', 'C1', { status: 'red' }, 'MK');
      expect(listChecklist('0.2.14').items.find(item => item.id === 'C1')?.status).toBe('red');
      const deps: TickDeps = { mode: 'live', split: () => [{ id: 'C1', title: '칸', seat: 'MK' }], placeCell: () => ({ version: '0.2.14' }) };
      await invoke(root, 'read08', '08', deps, logged);
      const file = join(root, 'release', 'features.sqlite');
      const before = readFileSync(file);
      await invoke(root, 'read12', '12', deps, logged);
      const noon = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'read12.json'), 'utf8'));
      expect(noon.cells).toContainEqual({ cardId: id, id: 'C1', title: '칸', seat: 'MK', version: '0.2.14', origin: 'flow1a' });
      expect(noon.reconciled).toEqual({ reached: 0, progressing: 0, blocked: 1, unknown: 0 });
      expect(readFileSync(file)).toEqual(before);
    } finally { resetElanousConfigDir(); }
  }));

  test('live never delegates cells without a successful placement and valid version', async () => fixture(async (root, id, logged) => {
    const path = join(root, 'seat-requests', 'requests.jsonl');
    const split: TickDeps['split'] = () => [
      { id: 'C1', title: '배치됨', seat: 'MK' },
      { id: 'C2', title: '배치 실패', seat: 'TC' },
      { id: 'C3', title: '잘못된 판', seat: 'UX' },
    ];
    // A placer that places nothing (or no placer at all) must not delegate — independent of whether RELPLAN1 is on main.
    const noAdapter = await invoke(root, 'absent08', '08', { mode: 'live', split, placeCell: () => null }, logged);
    expect(noAdapter.delegated).toBe(0);
    expect(existsSync(path)).toBe(false);
    const store = new CardStore(root);
    const next = store.createCard({ goalId: 'wish:partial', title: '다음 카드' });
    store.close();
    const placed = await invoke(root, 'partial08', '08', { mode: 'live', split,
      placeCell: cell => cell.id === 'C1' ? { version: '0.2.14' } : cell.id === 'C2' ? null : { version: ' ' },
    }, logged);
    expect(placed.delegated).toBe(1);
    expect(readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toMatchObject([
      { key: `orch:${next.id}:C1`, seat: 'MK', loopId: 'cmo-seat', version: '0.2.14' },
    ]);
  }));

  test('18 window records the missing K1b adjustment seat and graph recipes match all command nodes', async () => fixture(async (root, _id, logged) => {
    const state = await invoke(root, 'at18', '18', { mode: 'shadow', loadAdapter: async () => undefined }, logged);
    expect(state.missing).toContain('k1b-absent');
    expect(logged).toContainEqual({ event: 'node-missing', reason: 'k1b-absent' });
    const repo = resolve(import.meta.dir, '../../..');
    const graph = parseYaml(readFileSync(join(repo, 'graphs/orchestrator/orchestrator.yaml'), 'utf8'));
    const recipes = parseYaml(readFileSync(join(repo, 'graphs/orchestrator/recipes.yaml'), 'utf8'));
    expect(graph.loop.trigger).toEqual({ cron: '0 8,12,18 * * *', events: ['manual'] });
    expect(graph.nodes.map((row: { node_id: string }) => row.node_id)).toEqual([...stages, 'done', 'failed']);
    for (const node of stages) {
      const recipe = recipes[`orchestrator-${node}`];
      expect(recipe.command).toContain(`tick.ts\" ${node}`);
      expect(graph.edges.find((edge: { from: string }) => edge.from === node).map.fail).toBe('failed');
    }
  }));
});

describe('ORCH1b tick isolation and adapter exports', () => {
  test('a truncated card journal skips only that card and the other reaches split', async () => fixture(async (root, id, logged) => {
    const store = new CardStore(root);
    const broken = store.createCard({ goalId: 'wish:broken', title: '깨진 카드' });
    store.close();
    const path = join(root, 'task-cards', `${broken.id}.jsonl`);
    writeFileSync(path, readFileSync(path, 'utf8') + '{');
    const state = await invoke(root, 'broken08', '08', {
      mode: 'shadow', split: card => [{ id: `cell-${card.id}`, title: card.title, seat: 'MK' }], placeCell: () => null,
    }, logged);
    expect(state.cards.map(card => card.id)).toEqual([id]);
    expect(state.cells.map(cell => cell.cardId)).toEqual([id]);
    expect(state.skippedCards).toEqual([{ id: broken.id, reason: expect.stringContaining('incomplete card journal') }]);
    expect(logged).toContainEqual({ event: 'exchange', reason: 'card-unreadable' });
    expect(state.nodes.split).toBe('ok');
  }));

  test('a malformed complete JSON event skips only its journal and emits one unreadable observation', async () => fixture(async (root, id, logged) => {
    const store = new CardStore(root);
    const broken = store.createCard({ goalId: 'wish:malformed', title: '손상된 이벤트' });
    store.close();
    const path = join(root, 'task-cards', `${broken.id}.jsonl`);
    writeFileSync(path, readFileSync(path, 'utf8') + '{\n');
    const counts: number[] = [];
    const state = await invoke(root, 'malformed08', '08', { mode: 'shadow',
      split: card => [{ id: `cell-${card.id}`, title: card.title, seat: 'MK' }], placeCell: () => null,
      observe: (event, data) => { logged.push({ event, reason: data.reason }); if (data.reason === 'card-unreadable') counts.push(data.count); },
    }, logged);
    expect(state.cards.map(card => card.id)).toEqual([id]);
    expect(state.cells.map(cell => cell.cardId)).toEqual([id]);
    expect(state.skippedCards).toEqual([{ id: broken.id, reason: expect.stringContaining('SyntaxError') }]);
    expect(counts).toEqual([1]);
  }));

  test('an existing placement source without a callable placeCell is absent in shadow and live', async () => fixture(async (root, _id, logged) => {
    expect(existsSync(resolve(import.meta.dir, '../../release-loop/placement.ts'))).toBe(true);
    const loaded: string[] = [];
    const loadAdapter: TickDeps['loadAdapter'] = async (path, name) => {
      loaded.push(`${path}:${name}`);
      return path === '../../release-loop/placement.js' && name === 'placeCell' ? { notCallable: true } : undefined;
    };
    for (const mode of ['shadow', 'live'] as const) {
      const state = await invoke(root, `no-placer-${mode}`, '08', { mode, loadAdapter }, logged);
      expect(state.missing).toContain('relplan1-absent');
    expect(state.cells.every(cell => cell.origin === 'candidate')).toBe(true);
      expect(state.placed).toBe(0);
    }
    expect(loaded.filter(name => name === '../../release-loop/placement.js:placeCell')).toHaveLength(2);
  }));

  test('split host reaches the live delegate row only when supplied', async () => fixture(async (root, id, logged) => {
    const state = await invoke(root, 'host08', '08', {
      mode: 'live', split: () => [{ id: 'C1', title: 'host 칸', seat: 'MK', host: 'node-b' }, { id: 'C2', title: '일반 칸', seat: 'TC' }],
      placeCell: () => ({ version: '0.2.14' }),
    }, logged);
    const rows = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(state.cells[0]?.host).toBe('node-b');
    expect(rows[0]).toMatchObject({ key: `orch:${id}:C1`, receiptId: `orch:${id}:C1`, host: 'node-b' });
    expect(rows[1]).not.toHaveProperty('host');
  }));

  test('18 shadow observes an exported rebalance without invoking it', async () => fixture(async (root, id, logged) => {
    await invoke(root, 'rebalance-shadow-seed', '08', {
      mode: 'shadow', split: () => [{ id: 'C1', title: '칸', seat: 'MK' }], placeCell: () => { throw new Error('shadow must not place'); },
    }, logged);
    const path = join(root, 'loop', 'orchestrator', 'rebalance-shadow-seed.json');
    const seed = JSON.parse(readFileSync(path, 'utf8'));
    seed.cells[0].version = '0.2.14';
    writeFileSync(path, JSON.stringify(seed));
    let calls = 0;
    const counts: number[] = [];
    const loadAdapter: TickDeps['loadAdapter'] = async (_path, name) => name === 'rebalance' ? () => { calls++; return { decisions: [], blocked: [] }; } : undefined;
    const state = await invoke(root, 'rebalance18', '18', { mode: 'shadow', loadAdapter,
      observe: (event, data) => { logged.push({ event, reason: data.reason }); if (data.reason === 'rebalance-shadow-not-invoked') counts.push(data.count); },
    }, logged);
    expect(state.cells.map(cell => cell.cardId)).toEqual([id]);
    expect(state.missing).not.toContain('k1b-absent');
    expect(logged).toContainEqual({ event: 'exchange', reason: 'rebalance-shadow-not-invoked' });
    expect(counts).toEqual([1]);
    expect(calls).toBe(0);
    expect(state.rebalanced).toBeUndefined();
  }));

  test('18 live reports rejected CEO-load rebalance adjustments as well as moved count', async () => fixture(async (root, _id, logged) => {
    await invoke(root, 'ceo-rebalance-seed', '08', {
      mode: 'live', split: () => [{ id: 'sns', title: 'SNS', seat: 'MK' }], placeCell: () => ({ version: '0.2.14' }),
    }, logged);
    const seedPath = join(root, 'loop', 'orchestrator', 'ceo-rebalance-seed.json');
    const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
    let printed = '';
    const evening = await invoke(root, 'ceo-rebalance-evening', '18', {
      mode: 'live', print: line => { printed = line; },
      loadAdapter: async (_path, name) => name === 'rebalance' ? () => ({ decisions: [], blocked: [{ id: 'sns', reason: '대표 손 과부하 — 늦추기 · 자리 대행 · 묶기' }] }) : undefined,
    }, logged);
    expect(seed.cells[0]?.version).toBe('0.2.14');
    expect(evening.rebalanced).toBe(0);
    expect(evening.rebalanceBlocked).toEqual([{ id: 'sns', reason: '대표 손 과부하 — 늦추기 · 자리 대행 · 묶기' }]);
    expect(printed).toContain('⛔ 이월 거부 sns: 대표 손 과부하 — 늦추기 · 자리 대행 · 묶기');
    expect(logged).toContainEqual({ event: 'exchange', reason: 'rebalance-blocked: sns 대표 손 과부하 — 늦추기 · 자리 대행 · 묶기' });
  }));

  test('18 live invokes rebalance once per placed version and counts decisions', async () => fixture(async (root, id, logged) => {
    const state = await invoke(root, 'rebalance-seed', '08', {
      mode: 'live', split: () => [{ id: 'C1', title: '칸', seat: 'MK' }], placeCell: () => ({ version: '0.2.14' }),
    }, logged);
    const called: string[] = [];
    const evening = await invoke(root, 'rebalance-live', '18', {
      mode: 'live', loadAdapter: async (_path, name) => name === 'rebalance' ? (version: string) => { called.push(version); return { decisions: [{ id: 'C1' }, { id: 'C2' }], blocked: [] }; } : undefined,
    }, logged);
    expect(state.cells[0]?.version).toBe('0.2.14');
    expect(evening.cells.map(cell => cell.cardId)).toEqual([id]);
    expect(called).toEqual(['0.2.14']);
    expect(evening.rebalanced).toBe(2);
    expect(evening.missing).not.toContain('k1b-absent');
  }));
});

describe('ORCH1 complete card cycle without a seat Claude session', () => {
  test('real FLOW1 adapter, RELPLAN decision, request queue, launch receipt and next tick have stage evidence', async () => fixture(async (root, id, logged) => {
    const store = new CardStore(root);
    store.appendSection(id, { key: 'intake:wish:1', owner: 'steward', content: JSON.stringify({ text: '[MK] 원고 초안 준비' }) });
    store.close();
    const calls: string[] = [];
    const placeCell: NonNullable<TickDeps['placeCell']> = (input, opts) => {
      calls.push(`place:${input.owner}:${opts?.dryRun}`);
      return { version: '0.2.16' };
    };
    const original = readFileSync(join(root, 'task-cards', `${id}.jsonl`), 'utf8');
    const shadow = await invoke(root, 'cycle-shadow', '08', { mode: 'shadow', placeCell: () => { throw new Error('shadow must not invoke injected writer'); } }, logged);
    expect(shadow.cells).toMatchObject([{ seat: 'MK', title: '원고 초안 준비', origin: 'flow1a' }]);
    expect(shadow.steps.map(step => step.node)).toEqual(expect.arrayContaining(['intake', 'split', 'place', 'delegate']));
    expect(shadow.wouldDelegate).toBe(1);
    expect(shadow.launched).toEqual([]);
    expect(readFileSync(join(root, 'task-cards', `${id}.jsonl`), 'utf8')).toBe(original);
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
    const live = await invoke(root, 'cycle-live', '08', { mode: 'live', placeCell, seatTurn: async (seat, stateRoot) => {
      const rows = readFileSync(join(stateRoot, 'seat-requests', 'requests.jsonl'), 'utf8');
      expect(rows).toContain('원고 초안 준비');
      calls.push(`seat:${seat}`);
      return { status: 'queued', queueId: 'hq-00000000-0000-0000-0000-000000000001', item: { source: 'request', id: JSON.parse(rows.trim()).key } };
    } }, logged);
    expect(calls).toEqual(['place:MK:false', 'seat:MK']);
    expect(live.placed).toBe(1);
    expect(live.delegated).toBe(1);
    const requestKey = `orch:${id}:${live.cells[0]!.id}`;
    expect(live.launched).toEqual([{ seat: 'MK', status: 'queued', key: requestKey, queueId: 'hq-00000000-0000-0000-0000-000000000001' }]);
    const request = JSON.parse(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim());
    expect(request).toMatchObject({ seat: 'MK', version: '0.2.16', cell: live.cells[0]!.id, text: '원고 초안 준비' });
    expect(live.steps.map(step => step.node)).toEqual(expect.arrayContaining(['intake', 'split', 'place', 'delegate', 'launch']));
    const noon = await invoke(root, 'cycle-next', '12', { mode: 'live', queueOutcome: () => 'pending', checklist: () => [{ id: live.cells[0]!.id, status: 'yellow' }] }, logged);
    expect(noon.queueOutcomes).toEqual([{ queueId: 'hq-00000000-0000-0000-0000-000000000001', key: requestKey, outcome: 'pending' }]);
    expect(noon.reconciled.progressing).toBe(1);
    // 체크리스트에 칸이 아직 없어도 그 칸의 큐 결과(pending)로 진행 중이라 판정한다.
    const noonNoChecklist = await invoke(root, 'cycle-next-2', '12', { mode: 'live', queueOutcome: () => 'pending', checklist: () => [] }, logged);
    expect(noonNoChecklist.reconciled).toEqual({ reached: 0, progressing: 1, blocked: 0, unknown: 0 });
    expect(noon.steps).toContainEqual(expect.objectContaining({ node: 'reconcile', reason: 'queue-outcome:hq-00000000-0000-0000-0000-000000000001:pending' }));
    expect(JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'cycle-next.json'), 'utf8')).steps).toEqual(noon.steps);
  }));
});

describe('TC review must-fixes (ORCH1 #23638)', () => {
  test('live delegate rows satisfy the seat-requests journal contract — the daemon reader still lists every seat', async () => fixture(async (root, id, logged) => {
    const deps: TickDeps = { mode: 'live', split: () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }, { id: 'C2', title: '둘째 칸', seat: 'TC' }],
      placeCell: () => ({ version: '0.2.14' }) };
    await invoke(root, 'mf1', '08', deps, logged);
    const rows = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.every(row => typeof row.receiptId === 'string' && row.receiptId === row.key)).toBe(true);
    const response = await handleSeatRequests(new Request('http://local/v1/seat-requests?limit=10'), { root: () => root });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ key: string }> };
    expect((body.items as unknown as Array<{ receiptId: string }>).map(item => item.receiptId).sort()).toEqual([`orch:${id}:C1`, `orch:${id}:C2`]);
  }));

  test('place hands the placer its required shape and skips owner-less cells as unplaced', async () => fixture(async (root, _id, logged) => {
    const seen: PlacementInput[] = [];
    // Same guards as RELPLAN1 placeCell: owner, priority P0/P1/P2 and predecessors array are required.
    const placeCell = (input: PlacementInput) => {
      if (!input.owner) throw new Error('owner required');
      if (!['P0', 'P1', 'P2'].includes(input.priority)) throw new Error('잘못된 우선순위');
      if (!Array.isArray(input.predecessors)) throw new Error('선행 칸 id 가 잘못됐다');
      seen.push(input);
      return { version: '0.2.15' };
    };
    const state = await invoke(root, 'mf2', '08', { mode: 'live',
      split: () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }, { id: 'C2', title: '주인 없는 칸' }], placeCell }, logged);
    expect(seen).toEqual([{ id: 'C1', title: '첫 칸', owner: 'MK', priority: 'P2', predecessors: [] }]);
    expect(state.placed).toBe(1);
    expect(state.unplaced).toBe(1);
  }));

  test('shadow with an injected placer still counts owner-less cells as unplaced', async () => fixture(async (root, _id, logged) => {
    const state = await invoke(root, 'mf3', '08', { mode: 'shadow',
      split: () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }, { id: 'C2', title: '주인 없는 칸' }], placeCell: () => ({ version: '0.2.16' }) }, logged);
    expect(state.unplaced).toBe(1);
  }));

  test('reconciliation falls back to the seat queue outcome only when the checklist has no status', () => {
    const cells = [{ cardId: 'k', id: 'C1', title: 't', origin: 'flow1a', seat: 'MK', version: '0.2.16' },
      { cardId: 'k', id: 'C2', title: 't', origin: 'flow1a', seat: 'TC', version: '0.2.16' }] as never;
    const requests = [{ key: 'orch:k:C1', status: 'queued' }, { key: 'orch:k:C2', status: 'queued' }];
    expect(reconciliation(cells, requests, () => [])).toEqual({ reached: 0, progressing: 0, blocked: 0, unknown: 2 });
    expect(reconciliation(cells, requests, () => [], [{ key: 'orch:k:C1', outcome: 'pending' }, { key: 'orch:k:C2', outcome: 'retryable' }]))
      .toEqual({ reached: 0, progressing: 1, blocked: 1, unknown: 0 });
    expect(reconciliation(cells, requests, () => [{ id: 'C1', status: 'green' }], [{ key: 'orch:k:C1', outcome: 'retryable' }]).reached).toBe(1);
    // 같은 자리의 다른 칸은 남의 큐 결과를 물려받지 않는다.
    const sameSeat = [{ cardId: 'k', id: 'C1', title: 't', origin: 'flow1a', seat: 'MK', version: '0.2.16' },
      { cardId: 'k', id: 'C3', title: 't', origin: 'flow1a', seat: 'MK', version: '0.2.16' }] as never;
    expect(reconciliation(sameSeat, [...requests, { key: 'orch:k:C3', status: 'queued' }], () => [], [{ key: 'orch:k:C1', outcome: 'pending' }]))
      .toEqual({ reached: 0, progressing: 1, blocked: 0, unknown: 1 });
  });

  test('a seat turn that handled some other request is not recorded as this card launch', async () => fixture(async (root, _id, logged) => {
    const state = await invoke(root, 'mf4', '08', { mode: 'live', split: () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }], placeCell: () => ({ version: '0.2.16' }),
      seatTurn: async () => ({ status: 'queued', queueId: 'hq-x', item: { source: 'request', id: 'orch:other-card:C9' } }) }, logged);
    expect(state.launched).toEqual([{ seat: 'MK', status: 'queued', queueId: 'hq-x' }]);
    expect(state.steps).toContainEqual(expect.objectContaining({ reason: 'seat-turn-other-request:MK' }));
  }));
});

// ORCH-TA-HAND (0.2.18 · 10-08 데모): 오케스트레이터가 고른 칸을 TASK-AGENT(handTask)로 넘긴다.
describe('ORCH-TA-HAND — delegate hands the picked cell to TASK-AGENT', () => {
  const split: TickDeps['split'] = () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }, { id: 'C2', title: '둘째 칸', seat: 'TC' }];
  const base: TickDeps = { mode: 'live', split, placeCell: () => ({ version: '0.2.18' }), loadAdapter: async () => undefined };
  const requests = (root: string) => { const path = join(root, 'seat-requests', 'requests.jsonl'); return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; };
  // A delegate node that died mid-way is retried by the next invocation (its node mark is not «ok») — the real re-entry.
  const retryDelegate = (root: string, runId: string, deps: TickDeps) => {
    const path = join(root, 'loop', 'orchestrator', `${runId}.json`);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    delete state.nodes.delegate;
    writeFileSync(path, JSON.stringify(state));
    return runOrchestratorNode('delegate', { root, runId, window: '08', now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {}, ...deps });
  };
  const cards = (root: string) => { const path = join(root, 'task-agent-actions.json'); return existsSync(path) ? JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) : ''; };

  test('config: absent or invalid = off; shadow/live and a cell id parse', async () => fixture(async (root) => {
    const path = join(root, 'config.json');
    expect(buildUserConfig(path).loops?.orchestrator?.handToTaskAgent).toBeUndefined();
    writeFileSync(path, JSON.stringify({ loops: { orchestrator: { handToTaskAgent: 'nope', handToTaskAgentCell: ' ' } } }));
    expect(buildUserConfig(path).loops?.orchestrator).not.toHaveProperty('handToTaskAgent');
    expect(buildUserConfig(path).loops?.orchestrator).not.toHaveProperty('handToTaskAgentCell');
    writeFileSync(path, JSON.stringify({ loops: { orchestrator: { handToTaskAgent: 'live', handToTaskAgentCell: ' C2 ' } } }));
    expect(buildUserConfig(path).loops?.orchestrator).toMatchObject({ handToTaskAgent: 'live', handToTaskAgentCell: 'C2' });
  }));

  test('off: handTask is never called and the seat journal is unchanged', async () => fixture(async (root, id, logged) => {
    let calls = 0;
    const state = await invoke(root, 'off08', '08', { ...base, handToTaskAgent: 'off', handTask: async () => { calls++; throw new Error('must not run'); } }, logged);
    expect(calls).toBe(0);
    expect(state.handed).toBeUndefined();
    expect(state.delegated).toBe(2);
    expect(requests(root).map(row => row.key)).toEqual([`orch:${id}:C1`, `orch:${id}:C2`]);
  }));

  test('shadow: one card per cell, launch 0, seat path unchanged, and not handed twice', async () => fixture(async (root, id, logged) => {
    const launches: string[][] = [];
    const deps: TickDeps = { ...base, handToTaskAgent: 'shadow', taskLauncher: async (args) => { launches.push(args); } };
    const state = await invoke(root, 'shadow08', '08', deps, logged);
    expect(launches).toHaveLength(0);
    expect(state.handed?.map(row => ({ cell: row.cell, mode: row.mode, launched: row.launched }))).toEqual([
      { cell: 'C1', mode: 'shadow', launched: false }, { cell: 'C2', mode: 'shadow', launched: false }]);
    expect(cards(root)).toContain('"checklistId":"C1"');
    expect(state.delegated).toBe(2);
    expect(logged.filter(row => row.event === 'hand-to-task-agent')).toHaveLength(2);
    const before = cards(root);
    const again = await retryDelegate(root, 'shadow08', deps);
    expect(again.handed).toHaveLength(2);
    expect(cards(root)).toBe(before);
  }));

  test('live: the real handTask launches once through the launcher (pod · merge-by-host) and the seat journal stays empty', async () => fixture(async (root, id, logged) => {
    const launches: string[][] = [];
    const deps: TickDeps = { ...base, handToTaskAgent: 'live', taskLauncher: async (args) => { launches.push(args); } };
    const state = await invoke(root, 'live08', '08', deps, logged);
    expect(launches).toHaveLength(2);
    expect(launches[0]).toEqual(expect.arrayContaining(['harness', 'say', '--merge-by-host']));
    expect(launches[0]!.join(' ')).toContain('pod');
    expect(state.handed?.every(row => row.mode === 'live' && row.launched)).toBe(true);
    expect(requests(root)).toEqual([]);
    expect(state.delegated).toBe(0);
    expect(cards(root)).toContain('"status":"launched"');
    // A second delegate pass on the same cells never launches again.
    await retryDelegate(root, 'live08', deps);
    expect(launches).toHaveLength(2);
    expect(requests(root)).toEqual([]);
    // Turning the hand off (or filtering to another cell) never sends a live-handed cell down the seat path.
    for (const later of [{ handToTaskAgent: 'off' as const }, { handToTaskAgent: 'live' as const, handToTaskAgentCell: 'C9' }]) {
      const rerun = await retryDelegate(root, 'live08', { ...deps, ...later });
      expect(rerun.delegated).toBe(0);
      expect(requests(root)).toEqual([]);
    }
    expect(launches).toHaveLength(2);
  }));

  test('live hand under a shadow tick is card-only; a cell filter hands only that cell', async () => fixture(async (root, id, logged) => {
    const launches: string[][] = [];
    const shadowTick = await invoke(root, 'tickshadow08', '08', { ...base, mode: 'shadow', handToTaskAgent: 'live', handToTaskAgentCell: 'C2', taskLauncher: async (args) => { launches.push(args); } }, logged);
    expect(launches).toHaveLength(0);
    expect(shadowTick.handed?.map(row => [row.cell, row.mode])).toEqual([['C2', 'shadow']]);
    expect(logged.filter(row => row.event === 'hand-to-task-agent').map(row => row.reason)).toEqual([expect.stringContaining(`orch:${id}:C2:`)]);
  }));

  test('a failed live launch stays claimed: no seat fallback and no relaunch', async () => fixture(async (root, id, logged) => {
    let attempts = 0;
    const deps: TickDeps = { ...base, handToTaskAgent: 'live', handToTaskAgentCell: 'C1', taskLauncher: async () => { attempts++; throw new Error('spawn failed'); } };
    const state = await invoke(root, 'fail08', '08', deps, logged);
    expect(attempts).toBe(1);
    expect(logged.some(row => row.event === 'hand-to-task-agent-failed' && row.reason.startsWith(`orch:${id}:C1:`))).toBe(true);
    expect(requests(root).map(row => row.cell)).toEqual(['C2']);
    expect(state.delegated).toBe(1);
    await retryDelegate(root, 'fail08', deps);
    expect(attempts).toBe(1);
  }));
});

// Real processes: a delegate tick that dies mid-way, and two delegate ticks racing on one root.
const TICK_MODULE = join(import.meta.dir, 'tick.ts');
const childScript = (root: string) => {
  const path = join(root, 'delegate-child.ts');
  writeFileSync(path, `import { appendFileSync, existsSync } from 'node:fs';
import { runOrchestratorNode } from ${JSON.stringify(TICK_MODULE)};
const [root, runId, handCell, sleepMs, exitOn, signal = '-', waitFor = '-'] = process.argv.slice(2);
await runOrchestratorNode('delegate', { root, runId, window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {},
  handToTaskAgent: 'live', ...(handCell !== '-' ? { handToTaskAgentCell: handCell } : {}),
  handTask: async (opts) => {
    // File barriers: announce we are inside the hand, then wait for the peer — the race order is forced, not timed.
    if (signal !== '-') appendFileSync(root + '/' + signal, 'x');
    if (waitFor !== '-') { for (let i = 0; i < 400 && !existsSync(root + '/' + waitFor); i++) await Bun.sleep(25); }
    await Bun.sleep(Number(sleepMs));
    return { card: { id: 'card-' + runId + '-' + opts.checklistId }, move: { kind: 'launch' }, mode: 'live', launched: true }; },
  observe: (event, data) => {
    appendFileSync(root + '/obs-' + runId + '.jsonl', JSON.stringify({ event, reason: data.reason }) + '\\n');
    if (exitOn !== '-' && event === exitOn) process.exit(137);
  } });
`);
  return path;
};
const runChild = (script: string, args: string[]) => Bun.spawn([process.execPath, script, ...args], { stdout: 'ignore', stderr: 'pipe', env: { ...process.env } });
const placedRun = async (root: string, runId: string) => {
  for (const node of ['intake', 'split', 'place'] as const) await runOrchestratorNode(node, { root, runId, window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {},
    split: () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }, { id: 'C2', title: '둘째 칸', seat: 'TC' }], placeCell: () => ({ version: '0.2.18' }), loadAdapter: async () => undefined });
};
const ledgerRows = (root: string) => { const path = join(root, 'loop', 'orchestrator', 'handed.jsonl'); return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; };
const journalRows = (root: string) => { const path = join(root, 'seat-requests', 'requests.jsonl'); return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; };

test('ORCH-TA-HAND: a delegate process killed right after its hand is observed is restored from the ledger on re-entry', async () => fixture(async (root) => {
  await placedRun(root, 'crash08');
  const child = runChild(childScript(root), [root, 'crash08', 'C1', '0', 'hand-to-task-agent']);
  expect(await child.exited).toBe(137);
  const statePath = join(root, 'loop', 'orchestrator', 'crash08.json');
  const leftover = JSON.parse(readFileSync(statePath, 'utf8'));
  expect(leftover.nodes.delegate).toBeUndefined();
  expect(leftover.handed).toBeUndefined();
  expect(ledgerRows(root).filter(row => row.status === 'handed').map(row => row.cardId)).toEqual(['card-crash08-C1']);
  let handCalls = 0;
  const reentered = await runOrchestratorNode('delegate', { root, runId: 'crash08', window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {},
    handToTaskAgent: 'live', handToTaskAgentCell: 'C1', handTask: async () => { handCalls++; throw new Error('must not hand again'); } });
  expect(handCalls).toBe(0);
  expect(reentered.handed?.map(row => row.cardId)).toEqual(['card-crash08-C1']);
  expect(JSON.parse(readFileSync(statePath, 'utf8')).handed.map((row: { cardId: string }) => row.cardId)).toEqual(['card-crash08-C1']);
}), 30_000);

test('ORCH-TA-HAND: two real delegate ticks racing on C2 leave exactly one of a seat row and a live claim', async () => fixture(async (root) => {
  // Tick B hands only C1 and is held inside that hand, so it reads the ledger before tick A live-claims C2 and reaches C2's seat append after it.
  await placedRun(root, 'raceA');
  // The same placed cells in a second run (a second tick of the same day) — the card is split once, so copy the placed state.
  const placed = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'raceA.json'), 'utf8'));
  writeFileSync(join(root, 'loop', 'orchestrator', 'raceB.json'), JSON.stringify({ ...placed, runId: 'raceB' }));
  const script = childScript(root);
  // B reads the ledger, enters C1's hand and signals «b-in-hand», then waits for «a-handed».
  const b = runChild(script, [root, 'raceB', 'C1', '0', '-', 'b-in-hand', 'a-handed']);
  for (let i = 0; i < 400 && !existsSync(join(root, 'b-in-hand')); i++) await Bun.sleep(25);
  expect(existsSync(join(root, 'b-in-hand'))).toBe(true);
  // A live-claims C2 and signals «a-handed» from inside its hand — only then does B reach C2's seat append.
  const a = runChild(script, [root, 'raceA', 'C2', '0', '-', 'a-handed', '-']);
  expect([await a.exited, await b.exited]).toEqual([0, 0]);
  const c2Claims = ledgerRows(root).filter(row => row.cell === 'C2' && row.status === 'claimed' && !String(row.key).startsWith('shadow:'));
  const c2Seat = journalRows(root).filter(row => row.cell === 'C2');
  // Both ticks really worked the same cells: B handed C1, and C2 went to exactly one path.
  expect(ledgerRows(root).filter(row => row.status === 'handed').map(row => row.cardId)).toContain('card-raceB-C1');
  expect(JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'raceB.json'), 'utf8')).cells.map((cell: { id: string }) => cell.id)).toEqual(['C1', 'C2']);
  expect(c2Claims.length + c2Seat.length).toBe(1);
  // B really reached C2's seat append and was suppressed inside the lock (not skipped by its early ledger read).
  const bObs = readFileSync(join(root, 'obs-raceB.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(bObs.some(row => row.event === 'exchange' && String(row.reason).startsWith('seat-suppressed-handed:') && String(row.reason).endsWith(':C2'))).toBe(true);
  expect(c2Claims).toHaveLength(1);
  expect(c2Seat).toHaveLength(0);
}), 30_000);

test('ORCH-TA-HAND: a shadow hand whose seat row landed before the run state was saved is restored on re-entry', async () => fixture(async (root) => {
  await placedRun(root, 'shadowcrash08');
  const statePath = join(root, 'loop', 'orchestrator', 'shadowcrash08.json');
  // Kill on the seat row's «queued» observation — the shadow hand and the seat append are both on disk, the state is not.
  const script = join(root, 'shadow-child.ts');
  writeFileSync(script, `import { runOrchestratorNode } from ${JSON.stringify(TICK_MODULE)};
const [root] = process.argv.slice(2);
await runOrchestratorNode('delegate', { root, runId: 'shadowcrash08', window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {},
  handToTaskAgent: 'shadow', handToTaskAgentCell: 'C1',
  handTask: async (opts) => ({ card: { id: 'card-shadow-' + opts.checklistId }, move: { kind: 'launch' }, mode: 'shadow', launched: false }),
  observe: (event, data) => { if (event === 'exchange' && data.reason === 'queued') process.exit(137); } });
`);
  expect(await runChild(script, [root]).exited).toBe(137);
  expect(JSON.parse(readFileSync(statePath, 'utf8')).handed).toBeUndefined();
  expect(journalRows(root).map(row => row.cell)).toEqual(['C1']);
  const reentered = await runOrchestratorNode('delegate', { root, runId: 'shadowcrash08', window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {},
    handToTaskAgent: 'shadow', handToTaskAgentCell: 'C1', handTask: async () => { throw new Error('must not hand again'); } });
  expect(reentered.handed?.map(row => [row.cell, row.cardId, row.mode])).toEqual([['C1', 'card-shadow-C1', 'shadow']]);
}), 30_000);

test('ORCH-TA-HAND: an injected mode still honors the configured cell filter; shadow-before-placement then live launches; a seat-delegated cell stays on the seat path', async () => fixture(async (root, id, logged) => {
  const split: TickDeps['split'] = () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }, { id: 'C2', title: '둘째 칸', seat: 'TC' }];
  const launches: string[][] = [];
  setElanousConfigDir(root);
  resetUserConfig();
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ loops: { orchestrator: { handToTaskAgentCell: 'C2' } } }));
    resetUserConfig();
    // ① shadow tick (no placement): only the configured cell C2 gets a shadow card.
    const shadow = await invoke(root, 'mix08s', '08', { mode: 'shadow', split, loadAdapter: async () => undefined, handToTaskAgent: 'live', taskLauncher: async (args) => { launches.push(args); } }, logged);
    expect(shadow.handed?.map(row => [row.cell, row.mode])).toEqual([['C2', 'shadow']]);
    expect(launches).toHaveLength(0);
    // ② the same cells in a live tick: C2 (never seat-delegated) now launches through TASK-AGENT; C1 (outside the filter) takes the seat path.
    const placed = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'mix08s.json'), 'utf8'));
    writeFileSync(join(root, 'loop', 'orchestrator', 'mix08l.json'), JSON.stringify({ ...placed, runId: 'mix08l', mode: 'live',
      cells: placed.cells.map((cell: Record<string, unknown>) => ({ ...cell, version: '0.2.18' })), nodes: { intake: 'ok', split: 'ok', place: 'ok' }, handed: [] }));
    const live = await runOrchestratorNode('delegate', { root, runId: 'mix08l', window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {},
      handToTaskAgent: 'live', taskLauncher: async (args) => { launches.push(args); } });
    expect(launches).toHaveLength(1);
    expect(live.handed?.filter(row => row.mode === 'live').map(row => row.cell)).toEqual(['C2']);
    expect(journalRowsOf(root).map(row => row.cell)).toEqual(['C1']);
    // ③ C1 is on the seat path now — switching the filter to C1 never launches it through TASK-AGENT as well.
    writeFileSync(join(root, 'config.json'), JSON.stringify({ loops: { orchestrator: { handToTaskAgentCell: 'C1' } } }));
    resetUserConfig();
    const again = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'mix08l.json'), 'utf8'));
    delete again.nodes.delegate;
    writeFileSync(join(root, 'loop', 'orchestrator', 'mix08l.json'), JSON.stringify(again));
    await runOrchestratorNode('delegate', { root, runId: 'mix08l', window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {},
      handToTaskAgent: 'live', taskLauncher: async (args) => { launches.push(args); } });
    expect(launches).toHaveLength(1);
    expect(journalRowsOf(root).map(row => row.cell)).toEqual(['C1']);
  } finally { resetElanousConfigDir(); resetUserConfig(); }
}));
const journalRowsOf = (root: string) => { const path = join(root, 'seat-requests', 'requests.jsonl'); return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; };

test('ORCH-TA-HAND: another run re-reading the ledger never claims a hand it did not make', async () => fixture(async (root) => {
  await placedRun(root, 'ownA');
  await runOrchestratorNode('delegate', { root, runId: 'ownA', window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {},
    handToTaskAgent: 'live', handToTaskAgentCell: 'C1', taskLauncher: async () => {} });
  const placed = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'ownA.json'), 'utf8'));
  writeFileSync(join(root, 'loop', 'orchestrator', 'ownB.json'), JSON.stringify({ ...placed, runId: 'ownB', handed: undefined, nodes: { intake: 'ok', split: 'ok', place: 'ok' } }));
  const b = await runOrchestratorNode('delegate', { root, runId: 'ownB', window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {}, handToTaskAgent: 'off', handToTaskAgentCell: '-' });
  expect(b.handed).toBeUndefined();
  expect(journalRowsOf(root).map(row => row.cell)).toEqual(['C2']);
}));

const shadowPlaced = async (root: string, runId: string) => {
  // Shadow tick: cells stay unplaced, so a re-entered delegate reaches the shadow hand again (no seat row is written).
  const base = { root, runId, window: '08' as const, mode: 'shadow' as const, now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {} };
  await runOrchestratorNode('intake', base);
  await runOrchestratorNode('split', { ...base, split: () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }] });
  await runOrchestratorNode('place', { ...base, loadAdapter: async () => undefined });
  return async (handTask: TickDeps['handTask']) => {
    const statePath = join(root, 'loop', 'orchestrator', `${runId}.json`);
    if (existsSync(statePath)) { const saved = JSON.parse(readFileSync(statePath, 'utf8')); delete saved.nodes.delegate; writeFileSync(statePath, JSON.stringify(saved)); }
    return runOrchestratorNode('delegate', { ...base, handToTaskAgent: 'shadow', handToTaskAgentCell: 'C1', handTask });
  };
};
const agentCards = (root: string) => {
  const path = join(root, 'task-agent-actions.json');
  const tasks = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')).tasks ?? {}) : {};
  return Object.values(tasks).filter((card) => (card as { checklistId?: string }).checklistId === 'C1');
};

test('ORCH-TA-HAND: a shadow hand that fails before its card releases the claim and the next tick writes exactly one real card', async () => fixture(async (root) => {
  const delegate = await shadowPlaced(root, 'rel08');
  const { handTask: realHandTask } = await import('../../task-agent/task-hand.js');
  let calls = 0;
  const handTask: TickDeps['handTask'] = async (opts) => { calls++; if (calls === 1) throw new Error('card store busy'); return realHandTask(opts); };
  expect((await delegate(handTask)).handed).toBeUndefined();
  expect(agentCards(root)).toHaveLength(0);
  const second = await delegate(handTask);
  expect(calls).toBe(2);
  expect(agentCards(root)).toHaveLength(1);
  expect(second.handed?.map(row => row.cardId)).toEqual([(agentCards(root)[0] as { id: string }).id]);
  expect(ledgerRows(root).map(row => row.status)).toEqual(['claimed', 'released', 'claimed', 'handed']);
}));

test('ORCH-TA-HAND: a released shadow claim is retried by the next run (a different runId), and a malformed task store keeps the claim', async () => fixture(async (root) => {
  const delegate = await shadowPlaced(root, 'next08a');
  const { handTask: realHandTask } = await import('../../task-agent/task-hand.js');
  let calls = 0;
  const handTask: TickDeps['handTask'] = async (opts) => { calls++; if (calls === 1) throw new Error('card store busy'); return realHandTask(opts); };
  await delegate(handTask);
  const placed = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'next08a.json'), 'utf8'));
  writeFileSync(join(root, 'loop', 'orchestrator', 'next08b.json'), JSON.stringify({ ...placed, runId: 'next08b', nodes: { intake: 'ok', split: 'ok', place: 'ok' } }));
  const next = await runOrchestratorNode('delegate', { root, runId: 'next08b', window: '08', mode: 'shadow', now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {}, handToTaskAgent: 'shadow', handToTaskAgentCell: 'C1', handTask });
  expect(calls).toBe(2);
  expect(agentCards(root)).toHaveLength(1);
  expect(next.handed).toHaveLength(1);
}));

test('ORCH-TA-HAND: a malformed task store never reads as «no card» — the failed shadow claim is kept', async () => fixture(async (root) => {
  const delegate = await shadowPlaced(root, 'bad08');
  for (const malformed of ['{}', '{"tasks": []}', '{"tasks": {"x": 3}}']) {
    writeFileSync(join(root, 'task-agent-actions.json'), malformed);
    const before = ledgerRows(root).length;
    await delegate(async () => { throw new Error('card store busy'); });
    const added = ledgerRows(root).slice(before).map(row => row.status);
    // The first pass claims (and keeps); later passes see the kept claim and never hand again.
    expect(added.includes('released')).toBe(false);
  }
  expect(ledgerRows(root).map(row => row.status)).toEqual(['claimed']);
}));

test('ORCH-TA-HAND: a shadow hand that fails after writing its card keeps the claim — no second card', async () => fixture(async (root) => {
  const delegate = await shadowPlaced(root, 'keep08');
  const { handTask: realHandTask } = await import('../../task-agent/task-hand.js');
  let calls = 0;
  const handTask: TickDeps['handTask'] = async (opts) => { calls++; await realHandTask(opts); throw new Error('after the card'); };
  await delegate(handTask);
  await delegate(handTask);
  expect(calls).toBe(1);
  expect(agentCards(root)).toHaveLength(1);
  expect(ledgerRows(root).map(row => row.status)).toEqual(['claimed']);
}));

// COORD-HA ② × ORCH-TA-HAND: a live hand is an assignment — it counts toward the per-tick cap, and L2 hands nothing.
test('COORD-HA × ORCH-TA-HAND: a live hand uses the per-tick cap; L2 never hands', async () => fixture(async (root, id, logged) => {
  const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
  setElanousConfigDir(configDir);
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 1 } } }));
    const launches: string[][] = [];
    const split: TickDeps['split'] = () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }, { id: 'C2', title: '둘째 칸', seat: 'TC' }];
    const state = await invoke(root, 'capHand', '08', { mode: 'live', split, placeCell: () => ({ version: '0.2.19' }), loadAdapter: async () => undefined,
      handToTaskAgent: 'live', handToTaskAgentCell: 'C1', taskLauncher: async (args) => { launches.push(args); } }, logged);
    expect(launches).toHaveLength(1);
    expect(state.delegatedKeys).toEqual([`orch:${id}:C1`]);
    expect(state.deferredCells?.map(cell => cell.id)).toEqual(['C2']);
    expect(logged.filter(row => row.event === 'cap-deferred').map(row => row.reason)).toEqual([`orch:${id}:C2`]);
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
  } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
}));

test('COORD-HA × ORCH-TA-HAND: a placed cell reaching delegate at L2 (board down) is deferred — the live hand is not attempted', async () => fixture(async (root, id, logged) => {
  const base: TickDeps = { root, runId: 'l2Hand', window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {},
    observe: (event, data) => logged.push({ event, reason: data.reason }), seatTurn: async () => ({ status: 'skipped-empty' }),
    split: () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }], placeCell: () => ({ version: '0.2.19' }), loadAdapter: async () => undefined };
  for (const node of ['intake', 'split', 'place'] as const) await runOrchestratorNode(node, base);
  let hands = 0;
  const state = await runOrchestratorNode('delegate', { ...base, degradation: () => ({ llm: true, board: false }),
    handToTaskAgent: 'live', handTask: async () => { hands++; throw new Error('must not hand at L2'); } });
  expect(state.cells.map(cell => cell.version)).toEqual(['0.2.19']);
  expect(hands).toBe(0);
  expect(state.handed).toBeUndefined();
  expect(state.deferredCells?.map(cell => cell.id)).toEqual(['C1']);
}));

test('COORD-HA: a cell split normally that meets L2 at placement is carried and delegated on the next tick', async () => fixture(async (root, id, logged) => {
  // (L2 from the very start splits rule-only and marks nothing on the card, so the card simply splits again next tick.)
  const split: TickDeps['split'] = () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }];
  const base: TickDeps = { root, runId: 'l2place', window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {},
    observe: (event, data) => logged.push({ event, reason: data.reason }), seatTurn: async () => ({ status: 'skipped-empty' }),
    split, placeCell: () => ({ version: '0.2.19' }), loadAdapter: async () => undefined };
  for (const node of ['intake', 'split'] as const) await runOrchestratorNode(node, base);
  const degraded: TickDeps = { ...base, degradation: () => ({ llm: true, board: false }) };
  await runOrchestratorNode('place', degraded);
  const down = await runOrchestratorNode('delegate', degraded);
  expect(down.cells.map(cell => cell.version)).toEqual([undefined]);
  expect(down.deferredCells?.map(cell => cell.id)).toEqual(['C1']);
  for (const node of ['launch', 'reconcile', 'report'] as const) await runOrchestratorNode(node, degraded);
  // Next tick, board back: the card is already split (no new cells), yet the carried cell is placed and delegated.
  const back = await invoke(root, 'l2back', '08', { mode: 'live', split, placeCell: () => ({ version: '0.2.19' }), loadAdapter: async () => undefined }, logged);
  expect(back.delegated).toBe(1);
  expect(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8')).toContain(`orch:${id}:C1`);
}));

test('COORD-HA × ORCH-TA-HAND: a capped cell still gets its shadow card; an unplaced cell is never handed live even with cap 0', async () => fixture(async (root, id, logged) => {
  const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
  setElanousConfigDir(configDir);
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 0 } } }));
    const launches: string[][] = [];
    const split: TickDeps['split'] = () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }];
    const capped = await invoke(root, 'capShadow', '08', { mode: 'live', split, placeCell: () => ({ version: '0.2.19' }), loadAdapter: async () => undefined,
      handToTaskAgent: 'live', taskLauncher: async (args) => { launches.push(args); } }, logged);
    expect(launches).toHaveLength(0);
    expect(capped.handed?.map(row => [row.cell, row.mode])).toEqual([['C1', 'shadow']]);
    expect(capped.deferredCells?.map(cell => cell.id)).toEqual(['C1']);
  } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
}));

test('COORD-HA × ORCH-TA-HAND: with cap 0 an unplaced cell in a live tick is never launched (shadow card only)', async () => fixture(async (root, id, logged) => {
  const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
  setElanousConfigDir(configDir);
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 0 } } }));
    const launches: string[][] = [];
    const state = await invoke(root, 'capUnplaced', '08', { mode: 'live', split: () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }], placeCell: () => null,
      loadAdapter: async () => undefined, handToTaskAgent: 'live', taskLauncher: async (args) => { launches.push(args); } }, logged);
    expect(launches).toHaveLength(0);
    expect(state.handed?.every(row => row.mode === 'shadow' && !row.launched)).toBe(true);
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
  } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
}));

test('COORD-HA: a degradation applied at split stays on the report even if the signal recovers before report', async () => fixture(async (root, id, logged) => {
  let llm = false;
  let printed = '';
  const state = await invoke(root, 'recover', '08', { mode: 'shadow', degradation: () => ({ llm, board: true }),
    split: () => { throw new Error('split must not be called at L1'); }, loadAdapter: async () => undefined,
    print: line => { printed = line; },
    observe: (event, data) => { logged.push({ event, reason: data.reason }); if (data.node === 'split') llm = true; } }, logged);
  expect(state.degradation).toBeUndefined();
  expect(printed.split('\n')[0]).toBe('강등 L1: LLM 불가');
}));

test('COORD-HA: a capped cell carried over keeps priority over a newly split cell on the next tick', async () => fixture(async (root, id, logged) => {
  const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
  setElanousConfigDir(configDir);
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 1 } } }));
    let cells = [{ id: 'C1', title: 'C1', seat: 'MK' }, { id: 'C2', title: 'C2', seat: 'MK' }];
    const deps = (): TickDeps => ({ mode: 'shadow', gridHosts: [], split: () => cells, placeCell: () => null });
    const first = await invoke(root, 'prio-first', '08', deps(), logged);
    expect(first.deferredCells?.map(cell => cell.id)).toEqual(['C2']);
    // Shadow never marks the card split, so the next tick re-splits the same card — now as C0 then C2 (same key as the
    // carried C2). The carried C2 must still go first.
    cells = [{ id: 'C0', title: 'C0', seat: 'MK' }, { id: 'C2', title: 'C2', seat: 'MK' }];
    const next = await invoke(root, 'prio-next', '08', deps(), logged);
    expect(next.delegatedKeys).toEqual([`orch:${id}:C2`]);
  } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
}));

test('COORD-HA: only the 08 window delegates — 12 and 18 neither assign nor carry, so carry-over always follows the last 08 run', async () => fixture(async (root, id, logged) => {
  const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
  setElanousConfigDir(configDir);
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 1 } } }));
    const deps: TickDeps = { mode: 'shadow', gridHosts: [], split: () => ['C1', 'C2'].map(cell => ({ id: cell, title: cell, seat: 'MK' })), placeCell: () => null };
    const morning = await invoke(root, 'day-08', '08', deps, logged);
    expect(morning.deferredCells?.map(cell => cell.id)).toEqual(['C2']);
    for (const window of ['12', '18'] as const) {
      const later = await invoke(root, `day-${window}`, window, deps, logged);
      expect(later.nodes.delegate).toBe('skipped');
      expect(later.delegatedKeys).toBeUndefined();
      expect(later.deferredCells).toBeUndefined();
    }
    const nextMorning = await invoke(root, 'day2-08', '08', deps, logged);
    expect(nextMorning.delegatedKeys).toEqual([`orch:${id}:C2`]);
  } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
}));

test('COORD-HA: a bad signal seen only at intake (not applied) does not mark the report degraded', async () => fixture(async (root, id, logged) => {
  let llm = false;
  let printed = '';
  await invoke(root, 'intake-only', '08', { mode: 'shadow', degradation: () => ({ llm, board: true }), loadAdapter: async () => undefined,
    split: () => [{ id: 'C1', title: 'C1', seat: 'MK' }], print: line => { printed = line; },
    observe: (event, data) => { logged.push({ event, reason: data.reason }); if (data.node === 'intake') llm = true; } }, logged);
  expect(printed.startsWith('강등')).toBe(false);
}));

test('COORD-HA: removing the cap returns shadow to the legacy count — earlier would-delegates are not treated as assigned', async () => fixture(async (root, id, logged) => {
  const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
  setElanousConfigDir(configDir);
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 1 } } }));
    const deps: TickDeps = { mode: 'shadow', gridHosts: [], split: () => ['C1', 'C2'].map(cell => ({ id: cell, title: cell, seat: 'MK' })), placeCell: () => null };
    const capped = await invoke(root, 'uncap-1', '08', deps, logged);
    expect(capped.wouldDelegate).toBe(1);
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: {} } }));
    const uncapped = await invoke(root, 'uncap-2', '08', deps, logged);
    expect(uncapped.wouldDelegate).toBe(2);
    expect(logged.filter(row => row.event === 'would-delegate').slice(-2).map(row => row.reason.split(' ')[0]).sort())
      .toEqual([`orch:${id}:C1`, `orch:${id}:C2`]);
  } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
}));

test('COORD-HA: a delegate retried after assigning under cap 1 (state not saved) still assigns one in total', async () => fixture(async (root, id, logged) => {
  const configDir = mkdtempSync(join(tmpdir(), 'orch-config-'));
  setElanousConfigDir(configDir);
  try {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { maxDelegatePerTick: 1 } } }));
    const deps: TickDeps = { mode: 'live', split: () => [{ id: 'C1', title: 'C1', seat: 'MK' }, { id: 'C2', title: 'C2', seat: 'TC' }],
      placeCell: () => ({ version: '0.2.19' }), loadAdapter: async () => undefined };
    await invoke(root, 'retry-cap', '08', deps, logged);
    const journal = join(root, 'seat-requests', 'requests.jsonl');
    expect(readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line).cell)).toEqual(['C1']);
    // Simulate a death after the C1 row but before the run state recorded it: wipe the state's usage and re-enter delegate.
    const statePath = join(root, 'loop', 'orchestrator', 'retry-cap.json');
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    delete saved.nodes.delegate; saved.delegatedKeys = []; saved.deferredCells = [];
    writeFileSync(statePath, JSON.stringify(saved));
    await runOrchestratorNode('delegate', { ...deps, root, runId: 'retry-cap', window: '08', now: new Date('2026-10-04T00:00:00Z'), print: () => {}, observe: () => {} });
    expect(readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line).cell)).toEqual(['C1']);
  } finally { resetElanousConfigDir(); rmSync(configDir, { recursive: true, force: true }); }
}));

test('COORD-HA: board down only during place (back by delegate) still carries the unplaced cell', async () => fixture(async (root, id, logged) => {
  const split: TickDeps['split'] = () => [{ id: 'C1', title: '첫 칸', seat: 'MK' }];
  const base: TickDeps = { root, runId: 'placeOnly', window: '08', mode: 'live', now: new Date('2026-10-04T00:00:00Z'), print: () => {},
    observe: (event, data) => logged.push({ event, reason: data.reason }), seatTurn: async () => ({ status: 'skipped-empty' }),
    split, placeCell: () => ({ version: '0.2.19' }), loadAdapter: async () => undefined };
  for (const node of ['intake', 'split'] as const) await runOrchestratorNode(node, base);
  await runOrchestratorNode('place', { ...base, degradation: () => ({ llm: true, board: false }) });
  const delegated = await runOrchestratorNode('delegate', { ...base, degradation: () => ({ llm: true, board: true }) });
  expect(delegated.deferredCells?.map(cell => cell.id)).toEqual(['C1']);
  for (const node of ['launch', 'reconcile', 'report'] as const) await runOrchestratorNode(node, base);
  const next = await invoke(root, 'placeOnly-next', '08', { mode: 'live', split, placeCell: () => ({ version: '0.2.19' }), loadAdapter: async () => undefined }, logged);
  expect(next.delegated).toBe(1);
}));
