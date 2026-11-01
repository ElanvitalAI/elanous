import { describe, expect, test } from 'bun:test';
import {
  createNextSidetabHostHandler, createReplNextSidetabTool, formatSidetabLines, isNextSidetabCall, nextSidetabToolSpec,
  type SidetabRow,
  sidetabRowsFromManifest,
} from './model.js';
import type { PtyManifestRow } from '../pty-shell/pty-manifest.js';
import { noteExternalWrite, notePtyAccessMode, ptyWriteControlState, forgetExternalWriteProvenance } from '../pty-shell/pty-write-provenance.js';

function manifestRow(overrides: Partial<PtyManifestRow>): PtyManifestRow {
  return {
    id: 'pty:fixture', kind: 'agent', cmd: 'agent', ownerPid: 11, ptyPid: 12, instance: 'project',
    startedAt: 1, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, updatedAt: 1, frame: '', frameAt: 0,
    runId: '', runIdSource: '', spaceId: '', sessionId: '', parentPtyId: '', parentPid: 0, parentKind: '',
    closedAt: 0, codeSha: '', ...overrides,
  };
}

const rows: SidetabRow[] = [
  { id: 'tui:one', label: 'one', kind: 'tui', badge: 'idle', sessionId: 'one' },
  { id: 'pty:shell', label: 'shell · Next TUI', kind: 'shell', badge: 'busy' },
];

describe('renderer-independent sidetab model and actions', () => {
  test('legacy all/mine scope keeps run-bearing PTYs selectable without grouping or a new default cap', () => {
    const parent = manifestRow({ id: `tui:${process.pid}`, kind: 'tui', ownerPid: process.pid, ptyPid: process.pid, sessionId: 'mine' });
    const children = Array.from({ length: 10 }, (_, index) => manifestRow({
      id: `child-${index}`, kind: 'agent', runId: `run-${index}`, parentPtyId: `tui:${process.pid}`,
      nickname: `child-${index}`, instance: 'project',
    }));
    const manifest = [parent, ...children];
    const legacyAll = sidetabRowsFromManifest(manifest, 'project', undefined, { all: true });
    const legacyMine = sidetabRowsFromManifest(manifest, 'project', undefined, { all: false });

    expect(legacyAll.map((row) => row.id)).toEqual(manifest.map((row) => row.id));
    expect(legacyAll.some((row) => row.kind === 'harness-run' || row.kind === 'overflow')).toBe(false);
    expect(legacyMine).toHaveLength(11);
    expect(legacyMine.filter((row) => row.kind === 'agent')).toHaveLength(10);
  });

  test('SIDETAB-HARNESS-CHILD-TABS: groups 50 runs, orders attention, filters metadata, expands children and read-only Pod rows, and caps tabs', () => {
    const manifest: PtyManifestRow[] = [];
    const harnessRuns = Array.from({ length: 50 }, (_, index) => ({
      runId: `run-${String(index).padStart(2, '0')}`,
      label: `run-${String(index).padStart(2, '0')}`,
      status: index === 17 ? 'stuck' : index === 18 ? 'asking' : 'running',
      attention: index === 17 || index === 18,
      seat: index % 2 ? 'TC' : 'OPC', host: 'node-b', cardId: `card-${index}`, version: '0.2.42',
    }));
    for (const run of harnessRuns) {
      for (let child = 0; child < 3; child++) manifest.push(manifestRow({
        id: `${run.runId}:child-${child}`, kind: 'agent', runId: run.runId, parentPtyId: `tui:${process.pid}`,
        nickname: `child-${child}`, instance: 'project',
      }));
    }
    const pods = harnessRuns.map((run, index) => ({ id: `pod-${index}`, runId: run.runId, label: `pod-${index}`, host: 'node-b', seat: 'TC', cardId: `card-${index}`, version: '0.2.42' }));
    const runs = sidetabRowsFromManifest(manifest, 'project', () => ({ turn: 'busy', stale: false }), {
      mode: 'runs', harnessRuns, podRows: pods, maxTabs: 8,
    });
    expect(runs).toHaveLength(8);
    expect(runs[0]).toMatchObject({ runId: 'run-17', attention: true, status: 'stuck' });
    expect(runs[1]).toMatchObject({ runId: 'run-18', attention: true, status: 'asking' });
    expect(runs.at(-1)).toMatchObject({ kind: 'overflow', label: '+43 더' });

    const filtered = sidetabRowsFromManifest(manifest, 'project', () => ({ turn: 'busy', stale: false }), {
      mode: 'runs', harnessRuns, filters: ['seat:TC', 'status:asking|stuck|failed', 'host:node-b', 'card:card-17', 'version:0.2.42'],
    });
    expect(filtered.map(({ runId }) => runId)).toEqual(['run-17']);

    const expanded = sidetabRowsFromManifest(manifest.filter((row) => row.runId === 'run-17'), 'project', () => ({ turn: 'busy', stale: false }), {
      mode: 'runs', harnessRuns: [harnessRuns[17]!], podRows: [pods[17]!], expandedRunIds: ['run-17'],
    });
    expect(expanded.map(({ id, virtual }) => [id, virtual ?? false])).toEqual([
      ['run:run-17', false], ['run-17:child-0', false], ['run-17:child-1', false], ['run-17:child-2', false], ['pod:pod-17', true],
    ]);

    const mine = sidetabRowsFromManifest([
      manifestRow({ id: `tui:${process.pid}`, kind: 'tui', ownerPid: process.pid, ptyPid: process.pid, sessionId: 'mine' }),
      manifestRow({ id: 'foreign:child', kind: 'agent', parentPtyId: 'tui:foreign', parentPid: 123, runId: 'foreign-run', instance: 'other' }),
    ], 'project', undefined, {
      mode: 'mine', currentPid: process.pid, crossInstanceParent: ['foreign:child'],
      harnessRuns: [{ runId: 'foreign-run', parentPtyId: 'tui:foreign', attention: true, status: 'asking' }],
    });
    expect(mine.map(({ id }) => id)).toEqual(['attention:outside-runs', `tui:${process.pid}`]);
  });

  test('SIDETAB-AGENT-CONTROL-INDICATOR: derives controlState on generated rows and lets the latest human actor win over an active mission', () => {
    const manifest: PtyManifestRow[] = [{
      id: 'pty:control', kind: 'tui', nickname: 'control', cmd: 'tui', ownerPid: 8, ptyPid: 9,
      instance: 'test', startedAt: 1, alive: true, exitCode: null, snapshot: '', snapshotAt: 1,
      parentPid: 0, parentPtyId: '', parentKind: '', nestDepth: 0, sessionId: 'control',
      updatedAt: 1, frame: '', frameAt: 1, runId: '', runIdSource: '', spaceId: '', closedAt: 0, codeSha: '',
    }];
    const ptyId = 'pty:control';
    const control = (lastWriter: 'agent' | 'human') => {
      notePtyAccessMode(ptyId, lastWriter === 'agent' ? 'auto' : 'write');
      noteExternalWrite(ptyId, lastWriter);
      const provenance = ptyWriteControlState(ptyId)!;
      const state = sidetabRowsFromManifest(manifest, 'test', () => ({ turn: 'busy', stale: false }), {
        currentPid: 8,
        all: true,
        controlByPtyId: { [ptyId]: { ...provenance, activeMission: 'Codex task' } },
      })[0]?.controlState;
      return state;
    };

    expect(control('agent')).toEqual({
      actor: 'agent', badge: '🤖', label: '🤖 엘라누스 조작 중',
      title: '🤖 엘라누스가 미션 진행 중 · 입력하면 넘겨받기', emphasized: true,
    });
    expect(control('human')).toEqual({ actor: 'human', badge: '👤', label: '사람', title: '', emphasized: false });
    const humanProvenance = ptyWriteControlState(ptyId)!;
    const humanRow = sidetabRowsFromManifest(manifest, 'test', () => ({ turn: 'busy', stale: false }), {
      all: true,
      controlByPtyId: { [ptyId]: { ...humanProvenance, activeMission: 'Codex task' } },
    })[0]!;
    const humanLines = formatSidetabLines([humanRow], 0, 50);
    expect(humanLines[0]).not.toContain('\\u001b[1;36m');
    expect(humanLines[2]).toContain('› 👤 busy control');
    expect(humanLines.every((line) => Bun.stringWidth(line) === 50)).toBe(true);
    expect(control('agent')).toEqual({
      actor: 'agent', badge: '🤖', label: '🤖 엘라누스 조작 중',
      title: '🤖 엘라누스가 미션 진행 중 · 입력하면 넘겨받기', emphasized: true,
    });
    const agentRow = sidetabRowsFromManifest(manifest, 'test', () => ({ turn: 'busy', stale: false }), {
      all: true,
      controlByPtyId: { 'pty:control': { accessMode: 'auto', lastWriter: 'agent', activeMission: 'Codex task' } },
    })[0]!;
    expect(formatSidetabLines([agentRow], 0, 50)[0]).toContain('\u001b[1;36m');
    expect(formatSidetabLines([agentRow], 0, 50)[0]).toContain('🤖 엘라누스가 미션 진행 중 · 입력하면 넘겨받기');
    expect(formatSidetabLines([agentRow], 0, 50)[2]).toContain('\u001b[1;36m');
    expect(formatSidetabLines([agentRow], 0, 50)[2]).toContain('› 🤖 busy control');
    forgetExternalWriteProvenance(ptyId);
  });

  test('SIDETAB-AGENT-CONTROL-INDICATOR: derives waiting state without changing rows lacking control inputs', () => {
    const manifest: PtyManifestRow[] = [{
      id: 'pty:waiting', kind: 'tui', cmd: 'tui', ownerPid: 8, ptyPid: 9,
      instance: 'test', startedAt: 1, alive: true, exitCode: null, snapshot: '', snapshotAt: 1,
      parentPid: 0, parentPtyId: '', parentKind: '', nestDepth: 0, sessionId: 'waiting',
      updatedAt: 1, frame: '', frameAt: 1, runId: '', runIdSource: '', spaceId: '', closedAt: 0, codeSha: '',
    }];
    const withControl = sidetabRowsFromManifest(manifest, 'test', undefined, {
      all: true, controlByPtyId: { 'pty:waiting': { accessMode: 'read', lastWriter: null, activeMission: null } },
    });
    const legacy = sidetabRowsFromManifest(manifest, 'test', undefined, { all: true });

    expect(withControl[0]?.controlState).toEqual({ actor: 'waiting', badge: '⏸', label: '대기', title: '', emphasized: false });
    expect(legacy[0]).not.toHaveProperty('controlState');
  });
});

describe('renderer-independent sidetab model and actions', () => {
  test('publishes the same bounded action contract without importing a renderer', () => {
    expect(nextSidetabToolSpec.name).toBe('NextSidetab');
    expect((nextSidetabToolSpec.parameters.properties as { action: { enum: string[] } }).action.enum).toEqual(['list', 'switch', 'attach', 'detach', 'new', 'mission', 'kill']);
    expect(isNextSidetabCall({ type: 'elanous.sidetab.call', callId: 'one', request: { action: 'list' } })).toBe(true);
    expect(isNextSidetabCall({ type: 'bad', callId: 'one', request: { action: 'list' } })).toBe(false);
  });

  test('resolves exact and unique partial targets and keeps detach/new independent of row lookup', async () => {
    const calls: string[] = [];
    const handler = createNextSidetabHostHandler({
      rows: () => rows, selected: () => 1,
      switchSession: async (row) => { calls.push(`switch:${row.id}`); return { ok: true }; },
      attach: async (row) => { calls.push(`attach:${row.id}`); return { ok: true }; },
      detach: () => { calls.push('detach'); return { ok: true }; },
      spawn: (character) => ({ character }), kill: (row) => ({ killed: row.id }),
    });
    expect(await handler({ action: 'list' })).toEqual(rows);
    expect(await handler({ action: 'switch', target: 'tui:one' })).toEqual({ ok: true });
    expect(await handler({ action: 'attach', target: 'shell' })).toEqual({ ok: true });
    expect(await handler({ action: 'detach' })).toEqual({ ok: true });
    expect(await handler({ action: 'new', character: 'elanous' })).toEqual({ character: 'elanous' });
    expect(calls).toEqual(['switch:tui:one', 'attach:pty:shell', 'detach']);
  });

  test('requires explicit kill confirmation and refuses the current TUI', async () => {
    let kills = 0;
    const handler = createNextSidetabHostHandler({
      rows: () => rows, selected: () => 1,
      switchSession: async () => ({}), attach: async () => ({}), detach: () => ({}),
      spawn: () => ({}), kill: () => { kills++; return { ok: true }; },
    });
    expect(await handler({ action: 'kill', target: 'shell' })).toMatchObject({ needsConfirmation: true });
    expect(await handler({ action: 'kill', target: 'shell', confirm: true })).toEqual({ ok: true });
    expect(kills).toBe(1);

    const currentHandler = createNextSidetabHostHandler({
      rows: () => [{ ...rows[0]!, currentProcess: true }], selected: () => 0,
      switchSession: async () => ({}), attach: async () => ({}), detach: () => ({}),
      spawn: () => ({}), kill: () => { kills++; return { ok: true }; },
    });
    expect(await currentHandler({ action: 'kill', target: 'tui:one', confirm: true })).toEqual({
      error: '현재 TUI 세션은 사이드탭에서 종료할 수 없습니다',
    });
    expect(kills).toBe(1);
  });

  test('gives visible missions enough IPC time to complete', async () => {
    const tool = createReplNextSidetabTool({ send: () => true, on: () => {} }, { ELANOUS_NEXT_TUI_SIDETAB_IPC: '1' }, 5, 35)!;
    const started = Date.now();
    const result = await tool.dispatch({ action: 'mission', agent: 'codex', mission: 'create a demo note' });
    expect(result).toEqual({ error: 'Next TUI did not answer the side-tab request' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});

test('routes a mission through the visible Codex sidetab runner and requires mission text', async () => {
  const missions: string[] = [];
  const handler = createNextSidetabHostHandler({
    rows: () => rows, selected: () => 0,
    switchSession: async () => ({}), attach: async () => ({}), detach: () => ({}),
    spawn: () => ({}), kill: () => ({}),
    runMission: async (agent, mission) => { missions.push(`${agent}:${mission}`); return { ok: true, path: '/tmp/result.md', firstLine: '# done' }; },
  });

  expect(await handler({ action: 'mission', mission: '  Write a note.  ' })).toEqual({
    ok: true, path: '/tmp/result.md', firstLine: '# done',
  });
  expect(await handler({ action: 'mission', agent: 'claude', mission: 'Review the note.' })).toMatchObject({ ok: true });
  expect(await handler({ action: 'mission', agent: 'gemini' as never, mission: 'Review the note.' })).toEqual({ error: 'agent는 codex 또는 claude여야 합니다' });
  expect(await handler({ action: 'mission' })).toEqual({ error: 'mission 텍스트가 필요합니다' });
  expect(missions).toEqual(['codex:Write a note.', 'claude:Review the note.']);
});

test('routes parallelMission to the pair runner and rejects a blank second branch', async () => {
  const calls: string[] = [];
  const handler = createNextSidetabHostHandler({
    rows: () => rows, selected: () => 0,
    switchSession: async () => ({ ok: true }), attach: async () => ({ ok: true }),
    detach: () => ({ ok: true }), spawn: () => ({ ok: true }), kill: () => ({ ok: true }),
    runMission: async () => ({ single: true }),
    runMissionPair: async (agent, mission, parallelMission) => {
      calls.push(`${agent}:${mission}|${parallelMission}`);
      return { ok: true, results: { codex: { path: '/codex.md' }, claude: { path: '/claude.md' } } };
    },
  });
  await expect(handler({ action: 'mission', agent: 'claude', mission: 'review', parallelMission: 'implement' })).resolves.toMatchObject({
    ok: true, results: { codex: { path: '/codex.md' }, claude: { path: '/claude.md' } },
  });
  await expect(handler({ action: 'mission', mission: 'review', parallelMission: '  ' })).resolves.toEqual({ error: 'parallelMission 텍스트가 비었습니다' });
  expect(calls).toEqual(['claude:review|implement']);
});
