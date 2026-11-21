import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryRoot, saveMemory } from './memory.js';
import { seatMemoryRecallText } from './seat-memory/seat-memory-layers.js';
import { resetSeatMemoryRecallForTest, saveSeatMemory, seatMemoryDir } from './seat-memory/seat-memory.js';
import { resetTurnSessionLayers, sessionMemoryLayer } from './dashboard/turn-session-layers.js';
import { knowFind } from './knowledge/know-find.js';
import { createMemoryDevice } from './ux-sim/sim-world/memory/scenarios.js';

test('inherited isolated state root confines file memory in a child process', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'memory-isolated-child-'));
  const oldState = process.env.ELANOUS_STATE_DIR;
  const oldXdg = process.env.XDG_DATA_HOME;
  try {
    process.env.ELANOUS_STATE_DIR = isolated;
    process.env.XDG_DATA_HOME = join(isolated, 'wrong-xdg');
    expect(memoryRoot()).toBe(join(isolated, 'elanous', 'memory'));
    const saved = saveMemory({ id: 'isolation-probe', type: 'user', name: 'probe',
      description: 'probe', body: 'synthetic', pinned: true });
    expect(saved.id).toBe('isolation-probe');
  } finally {
    if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
    if (oldXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldXdg;
    rmSync(isolated, { recursive: true, force: true });
  }
});

// SIM-WORLD logical time and store provide deterministic events; the observations below come from
// the real seat turn recall, TUI memory layer, and knowledge search entrypoints.
describe('SIM-WORLD recall quality (R01–R06)', () => {
  const roots: string[] = [];
  const world = () => { const root = mkdtempSync(join(tmpdir(), 'recall-quality-world-')); roots.push(root); return root; };
  const seat = (root: string, name: 'OP' | 'TC') => {
    const cwd = join(root, 'elanous-hq', 'seats', name);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, 'elanous-hq', 'seat-state', name), { recursive: true });
    return cwd;
  };
  const save = (root: string, owner: 'OP' | 'TC', name: string, body: string) => {
    const result = saveSeatMemory({ name, description: `${name} release cadence`, type: 'project', body }, seatMemoryDir(owner, join(root, 'memory')), owner);
    expect(result.ok).toBe(true);
  };
  const recall = (root: string, cwd: string, sessionId: string, userText = 'release cadence now') =>
    seatMemoryRecallText({ cwd, sessionId, userText }, { home: root, env: {}, seatMemoryRoot: join(root, 'memory') });
  afterEach(() => { resetSeatMemoryRecallForTest(); resetTurnSessionLayers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  test('R01 owner filter: a seat turn sees its own correction history only', () => {
    const root = world(); const op = seat(root, 'OP'); const tc = seat(root, 'TC');
    save(root, 'OP', 'op-release', 'OP-ONLY cadence');
    save(root, 'TC', 'tc-release', 'TC-ONLY cadence');
    const opText = recall(root, op, 'r01-op') ?? '';
    const tcText = recall(root, tc, 'r01-tc') ?? '';
    expect(opText).toContain('OP-ONLY'); expect(opText).not.toContain('TC-ONLY');
    expect(tcText).toContain('TC-ONLY'); expect(tcText).not.toContain('OP-ONLY');
  });

  test('R02 time decay: expired sim fact vanishes and knowledge ranks a fresh directive ahead', async () => {
    const device = createMemoryDevice();
    await device.store.write({ tenant: 'cx13', graphId: 'recall', runId: 'r02', nodeId: 'seed', key: 'cadence', text: 'old cadence', ttlMs: 86_400_000 });
    device.clock.advance(2 * 86_400_000);
    expect(await device.store.read({ tenant: 'cx13', graphId: 'recall', runId: 'r02', scopes: ['instance'] })).toEqual([]);
    const old = new Date(device.clock.now() - 31 * 86_400_000).toISOString();
    const fresh = new Date(device.clock.now() - 86_400_000).toISOString();
    const found = knowFind('release cadence', {
      now: () => new Date(device.clock.now()), versions: () => [], decisions: () => [], seatDecisions: () => [], lessons: () => [],
      directives: () => [
        { ts: old, text: 'release cadence old', source_file: '/sim/old', line_no: 1 },
        { ts: fresh, text: 'release cadence current', source_file: '/sim/new', line_no: 2 },
      ],
    });
    expect(found.rows.map(row => [row.id, row.current])).toEqual([['/sim/new:2', true], ['/sim/old:1', false]]);
  });

  test('R03 correction: an edited fact reaches the next turn of the same session', () => {
    const root = world(); const op = seat(root, 'OP');
    save(root, 'OP', 'release-cadence', 'OLD-CADENCE release cadence');
    expect(recall(root, op, 'r03')).toContain('OLD-CADENCE');
    save(root, 'OP', 'release-cadence', 'NEW-CADENCE release cadence');
    const corrected = recall(root, op, 'r03');
    expect(corrected).toContain('NEW-CADENCE');
    expect(corrected).not.toContain('OLD-CADENCE');
  });

  test('R04 relevance: an unrelated turn and a short query recall no body', () => {
    const root = world(); const op = seat(root, 'OP');
    save(root, 'OP', 'release-cadence', 'RELEASE-ONLY cadence');
    expect(recall(root, op, 'r04-a', 'lunch menu today')).toBeNull();
    expect(recall(root, op, 'r04-b', 'release')).toBeNull();
    expect(recall(root, op, 'r04-c')).toContain('RELEASE-ONLY');
  });

  test('R05 session cadence: unchanged fact appears once per conversation and again in a new one', () => {
    const root = world(); const op = seat(root, 'OP');
    save(root, 'OP', 'release-cadence', 'ONCE-ONLY cadence');
    expect(recall(root, op, 'r05-first')).toContain('ONCE-ONLY');
    expect(recall(root, op, 'r05-first')).toBeNull();
    expect(recall(root, op, 'r05-second')).toContain('ONCE-ONLY');
  });

  test('R06 global owner filter: TUI memory index and body exclude the other seat', () => {
    const root = world(); const store = join(root, 'global');
    const card = (owner: 'OP' | 'TC') => ({ project: '', seat: owner, topic: 'release', source: 'sim-world', updatedAt: '2026-11-19T00:00:00Z', status: 'active' as const });
    saveMemory({ id: '11111111-1111-4111-8111-111111111111', type: 'project', name: 'op-release', description: 'release cadence', body: 'OP-GLOBAL-ONLY', contextCard: card('OP') }, store);
    saveMemory({ id: '22222222-2222-4222-8222-222222222222', type: 'project', name: 'tc-release', description: 'release cadence', body: 'TC-GLOBAL-ONLY', contextCard: card('TC') }, store);
    const op = sessionMemoryLayer({ cwd: seat(root, 'OP'), sessionKey: 'r06-op', root: store, maxTokens: 2000 }).map(row => String(row.content)).join('\n');
    const tc = sessionMemoryLayer({ cwd: seat(root, 'TC'), sessionKey: 'r06-tc', root: store, maxTokens: 2000 }).map(row => String(row.content)).join('\n');
    expect(op).toContain('OP-GLOBAL-ONLY'); expect(op).not.toContain('TC-GLOBAL-ONLY');
    expect(tc).toContain('TC-GLOBAL-ONLY'); expect(tc).not.toContain('OP-GLOBAL-ONLY');
  });
});
