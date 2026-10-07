import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleLoopEdgesGet, type LoopEdge, type LoopEdgesDeps } from './loop-edges.js';

// LOOP-INTERACT 조각 A2 (MK 10-07 08:10) — hand 간선 mode(shadow/live) · 끊긴 간선 · tick · ?mode=live.
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const since = encodeURIComponent(new Date(Date.now() - 60 * 60_000).toISOString());
const url = (extra = '') => `http://nexus.test/v1/loops/edges?since=${since}&limit=50${extra}`;

type Row = Record<string, unknown>;
function fixture(handed: Row[], extra: Partial<LoopEdgesDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loop-edges-hand-mode-'));
  mkdirSync(join(root, 'loop', 'orchestrator'), { recursive: true });
  writeFileSync(join(root, 'loop', 'orchestrator', 'handed.jsonl'), handed.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(root, 'task-agent-actions.json'), JSON.stringify({ tasks: {} }));
  const ledgerDir = join(root, 'run-ledger');
  mkdirSync(ledgerDir);
  const deps: LoopEdgesDeps = { cardRoot: root, ledgerDir, listCoord: () => [], listLoopOwners: () => [], listPodFinishes: () => [], ...extra };
  return { root, deps };
}
async function hands(requestUrl: string, deps: LoopEdgesDeps): Promise<{ raw: string; edges: LoopEdge[] }> {
  const response = handleLoopEdgesGet(new Request(requestUrl), deps);
  expect(response.status).toBe(200);
  const raw = await response.text();
  return { raw, edges: (JSON.parse(raw) as { edges: LoopEdge[] }).edges.filter(edge => edge.kind === 'hand') };
}

test('shadow key → mode shadow · live key → mode live · tick from runId', async () => {
  const { root, deps } = fixture([
    { key: 'shadow:orch:c1:CELL-A', cell: 'CELL-A', cardId: 'ta-shadow', status: 'handed', runId: '2026-10-07-am', at: ago(30) },
    { key: 'orch:c2:CELL-B', cell: 'CELL-B', cardId: 'ta-live', status: 'handed', runId: '2026-10-07-pm', at: ago(20) },
  ]);
  try {
    const { edges } = await hands(url(), deps);
    expect(edges.map(({ at: _at, ...edge }) => edge)).toEqual([
      { kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'ta-live', cell: 'CELL-B', mode: 'live', tick: '2026-10-07-pm' },
      { kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'ta-shadow', cell: 'CELL-A', mode: 'shadow', tick: '2026-10-07-am' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('row mode field wins over key prefix · bad runId drops tick', async () => {
  const { root, deps } = fixture([
    { key: 'orch:c1:CELL-A', cell: 'CELL-A', cardId: 'ta-1', mode: 'shadow', status: 'handed', runId: '../evil', at: ago(5) },
  ]);
  try {
    const { edges } = await hands(url(), deps);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.mode).toBe('shadow');
    expect('tick' in edges[0]!).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same cell shadow then live → two distinct hand edges', async () => {
  const { root, deps } = fixture([
    { key: 'shadow:orch:c1:CELL-A', cell: 'CELL-A', mode: 'shadow', status: 'claimed', runId: 't1', at: ago(40) },
    { key: 'shadow:orch:c1:CELL-A', cell: 'CELL-A', cardId: 'ta-s', mode: 'shadow', status: 'handed', runId: 't1', at: ago(40) },
    { key: 'orch:c1:CELL-A', cell: 'CELL-A', mode: 'live', status: 'claimed', runId: 't2', at: ago(15) },
    { key: 'orch:c1:CELL-A', cell: 'CELL-A', cardId: 'ta-l', mode: 'live', status: 'handed', runId: 't2', at: ago(15) },
  ]);
  try {
    const { edges } = await hands(url(), deps);
    expect(edges.map(edge => [edge.ref, edge.cell, edge.mode, edge.broken])).toEqual([
      ['ta-l', 'CELL-A', 'live', undefined], ['ta-s', 'CELL-A', 'shadow', undefined],
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('live claimed only, 11 minutes → one broken edge · 5 minutes → none · shadow released → none', async () => {
  const old = fixture([
    { key: 'orch:c9:CELL-X', cell: 'CELL-X', seat: 'UX', mode: 'live', status: 'claimed', runId: 'tick-9', at: ago(11) },
    { key: 'shadow:orch:c8:CELL-Y', cell: 'CELL-Y', mode: 'shadow', status: 'claimed', runId: 'tick-8', at: ago(30) },
    { key: 'shadow:orch:c8:CELL-Y', cell: 'CELL-Y', status: 'released', runId: 'tick-8', reason: 'PRIVATE-REASON', at: ago(30) },
  ]);
  const fresh = fixture([
    { key: 'orch:c9:CELL-X', cell: 'CELL-X', seat: 'UX', mode: 'live', status: 'claimed', runId: 'tick-9', at: ago(5) },
  ]);
  try {
    const { raw, edges } = await hands(url(), old.deps);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'c9', cell: 'CELL-X', mode: 'live', tick: 'tick-9', broken: true });
    expect(raw).not.toContain('PRIVATE-');
    expect((await hands(url(), fresh.deps)).edges).toEqual([]);
  } finally {
    rmSync(old.root, { recursive: true, force: true });
    rmSync(fresh.root, { recursive: true, force: true });
  }
});

test('live claimed then released is not broken', async () => {
  const { root, deps } = fixture([
    { key: 'orch:c9:CELL-X', cell: 'CELL-X', mode: 'live', status: 'claimed', runId: 'tick-9', at: ago(20) },
    { key: 'orch:c9:CELL-X', cell: 'CELL-X', status: 'released', runId: 'tick-9', at: ago(19) },
  ]);
  try { expect((await hands(url(), deps)).edges).toEqual([]); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('?mode=live keeps only live hand edges, other kinds untouched · bad mode → 400', async () => {
  const { root, deps } = fixture([
    { key: 'shadow:orch:c1:CELL-A', cell: 'CELL-A', cardId: 'ta-shadow', status: 'handed', at: ago(30) },
    { key: 'orch:c2:CELL-B', cell: 'CELL-B', cardId: 'ta-live', status: 'handed', at: ago(20) },
    { key: 'orch:c3:CELL-C', cell: 'CELL-C', mode: 'live', status: 'claimed', at: ago(25) },
  ], {
    listRunStarts: () => [{ runId: 'run-a', at: ago(10), seat: 'UX' }],
    seatIds: () => ['UX'],
  });
  try {
    const all = await edgesAll(url(), deps);
    const live = await edgesAll(url('&mode=live'), deps);
    expect(all.filter(edge => edge.kind === 'hand').map(edge => edge.ref).sort()).toEqual(['c3', 'ta-live', 'ta-shadow']);
    expect(live.filter(edge => edge.kind === 'hand').map(edge => [edge.ref, edge.mode])).toEqual([['ta-live', 'live'], ['c3', 'live']]);
    expect(live.filter(edge => edge.kind !== 'hand')).toEqual(all.filter(edge => edge.kind !== 'hand'));
    expect(live.some(edge => edge.kind === 'run')).toBe(true);
    expect(handleLoopEdgesGet(new Request(url('&mode=bogus')), deps).status).toBe(400);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function edgesAll(requestUrl: string, deps: LoopEdgesDeps): Promise<LoopEdge[]> {
  const response = handleLoopEdgesGet(new Request(requestUrl), deps);
  expect(response.status).toBe(200);
  return (await response.json() as { edges: LoopEdge[] }).edges;
}

// TC 10-07 08:13 — 카드엔 goalId·runId 가 없다. 런 원장 start.feature 는 boundReadableText(120) 로 잘린다
// (` [truncated; originalChars=N]` 표식) ⇒ 잘린 접두(≥40자)로도 «유일할 때만» 잇는다 · 카드 runId 가 있으면 최우선.
const LONG = 'LOOP-INTERACT 조각 B — PWA 루프 화면에 넘김 간선을 그리고 끊긴 넘김을 빨간 점선으로 표시하며 여정 필터를 붙인다 그리고 더 긴 꼬리 문장이 이어진다 — 원장 상한 120자를 넘기려고 같은 말을 한 번 더 길게 적어 둔다 끝';
const truncated = (text: string) => {
  const marker = ` [truncated; originalChars=${text.length}]`;
  return text.length <= 120 ? text : `${text.slice(0, 120 - marker.length)}${marker}`;
};
const RUN_A = 'run-aaaaaaaa-2222-3333-4444-555555555555';
const RUN_B = 'run-bbbbbbbb-2222-3333-4444-555555555555';
const launchedCard = (id: string, text: string, launchAt: string, extra: Row = {}) => ({
  id, text, seat: 'UX', checklistId: 'LOOP-INTERACT', createdAt: launchAt, status: 'launched',
  history: [{ at: launchAt, event: 'launch', detail: 'x' }], ...extra,
});
async function journeyRefs(cardId: string, cards: Row[], facts: Array<{ runId: string; feature: string; startAt: string }>): Promise<Set<string>> {
  const { root, deps } = fixture([], {
    listTaskCards: () => cards as never,
    listRunFacts: () => facts.map(fact => ({ ...fact, seat: 'UX', prs: [], children: [] })),
    seatIds: () => ['UX'],
  });
  try {
    const response = handleLoopEdgesGet(new Request(`http://nexus.test/v1/loops/edges?ref=${cardId}&limit=50`), deps);
    expect(response.status).toBe(200);
    return new Set((await response.json() as { edges: LoopEdge[] }).edges.map(edge => edge.ref));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('truncated feature (prefix ≥ 40) links the one launched card to its run', async () => {
  expect(truncated(LONG)).toContain('[truncated; originalChars=');
  const refs = await journeyRefs('ta-long', [launchedCard('ta-long', LONG, ago(30))], [{ runId: RUN_A, feature: truncated(LONG), startAt: ago(25) }]);
  expect(refs).toEqual(new Set(['ta-long', RUN_A]));
});

test('two launched cards sharing the truncated prefix link nothing', async () => {
  const refs = await journeyRefs('ta-long', [
    launchedCard('ta-long', LONG, ago(30)), launchedCard('ta-long2', `${LONG} 다른 꼬리`, ago(29)),
  ], [{ runId: RUN_A, feature: truncated(LONG), startAt: ago(25) }]);
  expect(refs.has(RUN_A)).toBe(false);
});

test('short (< 40) truncated prefix links nothing', async () => {
  const text = '짧은 카드 문장이고 이것은 꽤 길어 보이지만 접두는 짧다';
  const refs = await journeyRefs('ta-short', [launchedCard('ta-short', text, ago(30))], [{ runId: RUN_A, feature: `${text.slice(0, 10)}…`, startAt: ago(25) }]);
  expect(refs.has(RUN_A)).toBe(false);
});

test('card runId wins regardless of feature', async () => {
  const refs = await journeyRefs('ta-explicit', [launchedCard('ta-explicit', 'PRIVATE-UNRELATED', ago(30), { runId: RUN_B })], [
    { runId: RUN_A, feature: 'PRIVATE-UNRELATED', startAt: ago(25) },
    { runId: RUN_B, feature: 'something else entirely', startAt: ago(40) },
  ]);
  expect(refs.has(RUN_B)).toBe(true);
  expect(refs.has(RUN_A)).toBe(false);
});
