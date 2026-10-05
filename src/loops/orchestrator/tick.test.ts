import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import { addItem, setItem, listChecklist } from '../../release-loop/checklist.js';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CardStore } from '../../task-cards/card-store.js';
import { buildUserConfig } from '../../user-config.js';
import { reportLine, runOrchestratorNode, type Node, type PlacementInput, type TickDeps } from './tick.js';
import { handleSeatRequests } from '../../nexus/api/seat-requests.js';

const stages: Node[] = ['intake', 'split', 'place', 'delegate', 'reconcile', 'report'];
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
    print: () => {}, observe: (event, data) => logged.push({ event, reason: data.reason, ...(data.targetLoopId ? { targetLoopId: data.targetLoopId } : {}) }), ...deps });
  return final!;
};

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
    const state = await invoke(root, 'shadow08', '08', {}, logged);
    expect(state.cards.map(card => card.id)).toEqual([id]);
    expect(state.cells).toEqual([{ cardId: id, id, title: '새 카드', origin: 'candidate' }]);
    // Availability follows the callable export, not the source file's presence.
    const placement = await import('../../release-loop/placement.js');
    expect(state.missing).toEqual(typeof placement.placeCell === 'function' ? ['flow1a-absent'] : ['flow1a-absent', 'relplan1-absent']);
    expect(logged.filter(row => row.event === 'node-missing').map(row => row.reason)).toEqual(state.missing);
    expect(logged.some(row => row.event === 'would-delegate')).toBe(false); // no owner is guessed
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
    expect(readFileSync(join(root, 'task-cards', `${id}.jsonl`), 'utf8')).toBe(before);
    expect(existsSync(join(root, 'release', 'features.sqlite'))).toBe(false);
    expect(readFileSync(join(root, 'loop', 'orchestrator', 'shadow08.json'), 'utf8')).toContain('flow1a-absent');
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
    expect(saved.nodes).toMatchObject({ intake: 'ok', split: 'ok', place: 'ok', delegate: 'ok' });
    expect(state.wouldDelegate).toBe(1);
    expect(logged).toContainEqual({ event: 'would-delegate', reason: `orch:${id}:C1 (unplaced)`, targetLoopId: 'cmo-seat' });
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
    expect(readFileSync(cardPath, 'utf8')).toBe(original);
  }));

  test('rerunning a completed node with the same runId keeps its ok result (review round 3)', async () => fixture(async (root, _id, logged) => {
    await invoke(root, 'rerun', '08', { mode: 'shadow', split: () => [{ id: 'C1', title: '칸', seat: 'MK' }] }, logged);
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
    expect(state.cells).toEqual([{ cardId: id, id, title: '새 카드', origin: 'candidate' }]);
    expect(state.missing).toContain('flow1a-absent');
    expect(placements).toBe(0);
    expect(state.placed).toBe(0);
    expect(state.delegated).toBe(0);
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
  }));

  test('CLI nodes share graph runId and window override across subprocesses', async () => fixture(async (root, id) => {
    const context = join(root, 'graph-context.json');
    writeFileSync(context, JSON.stringify({ graphId: 'orchestrator', runId: 'cli08' }));
    for (const node of stages) {
      const result = spawnSync('bun', [join(import.meta.dir, 'tick.ts'), node, '--window', '08'], {
        env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context, ELANOUS_STATE_DIR: root }, encoding: 'utf8',
      });
      expect(result.status).toBe(0);
    }
    const state = JSON.parse(readFileSync(join(root, 'loop', 'orchestrator', 'cli08.json'), 'utf8'));
    expect(state.cards.map((card: { id: string }) => card.id)).toEqual([id]);
    expect(state.nodes).toEqual({ intake: 'ok', split: 'ok', place: 'ok', delegate: 'ok', reconcile: 'skipped', report: 'ok' });
  }));

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
      mode: 'shadow', split: card => [{ id: `cell-${card.id}`, title: card.title, seat: 'MK' }],
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
      split: card => [{ id: `cell-${card.id}`, title: card.title, seat: 'MK' }],
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
      expect(state.missing).toContain('flow1a-absent');
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
});
