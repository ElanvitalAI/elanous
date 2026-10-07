import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleLoopEdgesGet, type LoopEdge, type LoopEdgesDeps } from './loop-edges.js';

const base = Date.now() - 100_000;
const at = (offsetSeconds: number) => new Date(base + offsetSeconds * 1_000).toISOString();
const since = new Date(Date.now() - 120_000).toISOString();
const windowed = `http://nexus.test/v1/loops/edges?since=${encodeURIComponent(since)}&limit=50`;
const RUN = 'run-11111111-2222-3333-4444-555555555555';
const OTHER_RUN = 'run-99999999-2222-3333-4444-555555555555';

type Row = Record<string, unknown>;
function fixture(opts: { cards?: Row[]; handed?: Row[]; runs?: Record<string, Row[]> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loop-edges-ta-'));
  mkdirSync(join(root, 'loop', 'orchestrator'), { recursive: true });
  writeFileSync(join(root, 'loop', 'orchestrator', 'handed.jsonl'), (opts.handed ?? []).map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(root, 'task-agent-actions.json'), JSON.stringify({ landingDay: 'PRIVATE-OTHER-FIELD', tasks: Object.fromEntries((opts.cards ?? []).map(card => [card.id, card])) }));
  const ledgerDir = join(root, 'run-ledger');
  mkdirSync(ledgerDir);
  for (const [runId, rows] of Object.entries(opts.runs ?? {})) {
    writeFileSync(join(ledgerDir, `${runId}.jsonl`), rows.map(row => JSON.stringify({ runId, ...row })).join('\n') + '\n');
  }
  const deps: LoopEdgesDeps = { cardRoot: root, ledgerDir, listCoord: () => [], listLoopOwners: () => [], listPodFinishes: () => [] };
  return { root, deps };
}

async function edgesOf(url: string, deps: LoopEdgesDeps): Promise<{ raw: string; edges: LoopEdge[] }> {
  const response = handleLoopEdgesGet(new Request(url), deps);
  expect(response.status).toBe(200);
  const raw = await response.text();
  return { raw, edges: (JSON.parse(raw) as { edges: LoopEdge[] }).edges };
}

const piece = (id: string, text: string, launchAt: string, extra: Row = {}): Row => ({
  id, text, seat: 'UX', checklistId: 'LOOP-INTERACT', createdAt: launchAt, status: 'launched', mission: 'ta-mission',
  history: [{ at: launchAt, event: 'launch', detail: `harness say --seat UX ${text}` }], ...extra,
});
const mission: Row = {
  id: 'ta-mission', text: 'PRIVATE-MISSION-TEXT', createdAt: at(0), status: 'handed', history: [], pieces: ['ta-piece'],
  greenProposal: { at: at(60), checklistId: 'LOOP-INTERACT', evidence: { 'ta-piece': '#24619' } },
};
const journeyRun = (feature: string, startAt: string): Row[] => [
  { event: 'start', timestamp: startAt, data: { seat: 'UX', feature } },
  { event: 'pr-opened', timestamp: at(40), data: { url: 'https://github.com/o/r/pull/24619', number: 24619, branch: 'PRIVATE-BRANCH', goalId: '106fcc8eb4541040' } },
  { event: 'merged', timestamp: at(50), data: { merged: true, number: 24619 } },
];

test('handed ledger row yields one hand edge with card ref', async () => {
  const { root, deps } = fixture({ handed: [
    { key: 'orch:c1:LOOP-INTERACT', cell: 'LOOP-INTERACT', seat: 'UX', mode: 'live', status: 'claimed', runId: 'tick-1', at: at(1) },
    { key: 'orch:c1:LOOP-INTERACT', cell: 'LOOP-INTERACT', cardId: 'ta-piece', mode: 'live', launched: true, status: 'handed', runId: 'tick-1', at: at(2) },
    { key: 'shadow:orch:c2:X-1', cell: 'X-1', status: 'released', runId: 'tick-2', reason: 'PRIVATE-REASON', at: at(3) },
  ] });
  try {
    const { raw, edges } = await edgesOf(windowed, deps);
    // A2(MK 10-07 08:10): hand 간선에 mode·tick 이 더해졌다 — 간선 수·순서·나머지 칸은 조각 A 그대로.
    expect(edges).toEqual([{ at: at(2), kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'ta-piece', cell: 'LOOP-INTERACT', mode: 'live', tick: 'tick-1' }]);
    expect(raw).not.toContain('PRIVATE-');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hand, launch, run, pr and green move chain in time order without prose', async () => {
  const { root, deps } = fixture({
    handed: [{ cell: 'LOOP-INTERACT', cardId: 'ta-piece', status: 'handed', at: at(10) }],
    cards: [piece('ta-piece', 'PRIVATE-UNIQUE-TASK', at(20)), mission],
    runs: { [RUN]: journeyRun('PRIVATE-UNIQUE-TASK', at(30)) },
  });
  try {
    const { raw, edges } = await edgesOf(windowed, deps);
    expect([...edges].reverse()).toEqual([
      { at: at(10), kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'ta-piece', cell: 'LOOP-INTERACT' },
      { at: at(20), kind: 'launch', from: 'agent:task-agent', to: 'UX', ref: 'ta-piece' },
      { at: at(30), kind: 'run', from: 'UX', to: `loop:${RUN}`, ref: RUN },
      { at: at(40), kind: 'run', from: `loop:${RUN}`, to: 'pr:24619', ref: RUN },
      { at: at(60), kind: 'move', from: 'agent:task-agent', to: 'release:LOOP-INTERACT', ref: 'ta-mission', move: 'green-proposal' },
    ]);
    expect(raw).not.toContain('PRIVATE-');
    expect(raw).not.toContain('harness');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ref filter returns only one journey, beyond the 60 minute window', async () => {
  const old = (offsetSeconds: number) => new Date(base - 3 * 60 * 60 * 1000 + offsetSeconds * 1_000).toISOString();
  const { root, deps } = fixture({
    handed: [
      { cell: 'LOOP-INTERACT', cardId: 'ta-piece', status: 'handed', at: old(10) },
      { cell: 'OTHER-CELL', cardId: 'ta-other', status: 'handed', at: at(11) },
    ],
    cards: [
      piece('ta-piece', 'PRIVATE-UNIQUE-TASK', old(20)),
      { ...piece('ta-other', 'PRIVATE-OTHER-TASK', at(21)), mission: undefined, seat: 'TC' },
      mission,
    ],
    runs: {
      [RUN]: [{ event: 'start', timestamp: old(30), data: { seat: 'UX', feature: 'PRIVATE-UNIQUE-TASK' } }],
      [OTHER_RUN]: [{ event: 'start', timestamp: at(31), data: { seat: 'TC', feature: 'PRIVATE-OTHER-TASK' } }],
    },
  });
  try {
    const { raw, edges } = await edgesOf('http://nexus.test/v1/loops/edges?ref=ta-piece&limit=50', deps);
    expect(edges.map(edge => [edge.kind, edge.ref])).toEqual([
      ['move', 'ta-mission'], ['run', RUN], ['launch', 'ta-piece'], ['hand', 'ta-piece'],
    ]);
    expect(raw).not.toContain('PRIVATE-');
    const other = await edgesOf('http://nexus.test/v1/loops/edges?ref=ta-other&limit=50', deps);
    expect(new Set(other.edges.map(edge => edge.ref))).toEqual(new Set(['ta-other', OTHER_RUN]));
    const byRun = await edgesOf(`http://nexus.test/v1/loops/edges?ref=${RUN}&limit=50`, deps);
    expect(new Set(byRun.edges.map(edge => edge.ref))).toEqual(new Set(['ta-piece', RUN, 'ta-mission']));
    expect(handleLoopEdgesGet(new Request('http://nexus.test/v1/loops/edges?ref=../x'), deps).status).toBe(400);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ambiguous feature match links no run', async () => {
  const twoCards = fixture({
    cards: [piece('ta-a', 'PRIVATE-SHARED', at(20)), piece('ta-b', 'PRIVATE-SHARED', at(21))],
    runs: { [RUN]: [{ event: 'start', timestamp: at(30), data: { seat: 'UX', feature: 'PRIVATE-SHARED' } }] },
  });
  const twoRuns = fixture({
    cards: [piece('ta-a', 'PRIVATE-ONE', at(20))],
    runs: {
      [RUN]: [{ event: 'start', timestamp: at(30), data: { seat: 'UX', feature: 'PRIVATE-ONE' } }],
      [OTHER_RUN]: [{ event: 'start', timestamp: at(31), data: { seat: 'UX', feature: 'PRIVATE-ONE' } }],
    },
  });
  const beforeLaunch = fixture({
    cards: [piece('ta-a', 'PRIVATE-EARLY', at(40))],
    runs: { [RUN]: [{ event: 'start', timestamp: at(30), data: { seat: 'UX', feature: 'PRIVATE-EARLY' } }] },
  });
  try {
    for (const { deps } of [twoCards, twoRuns, beforeLaunch]) {
      const { edges } = await edgesOf('http://nexus.test/v1/loops/edges?ref=ta-a&limit=50', deps);
      expect(edges.map(edge => edge.kind)).toEqual(['launch']);
    }
  } finally { for (const { root } of [twoCards, twoRuns, beforeLaunch]) rmSync(root, { recursive: true, force: true }); }
});

test('goalId links a run whose feature differs, and a pod child is reached through its parent', async () => {
  const CHILD = 'run-77777777-2222-3333-4444-555555555555';
  const { root, deps } = fixture({
    cards: [piece('ta-piece', 'PRIVATE-TASK', at(20), { goalId: '106fcc8eb4541040', mission: undefined })],
    runs: {
      [RUN]: [
        { event: 'start', timestamp: at(30), goalId: '106fcc8eb4541040', data: { seat: 'UX', feature: 'PRIVATE-AUTHORED-ASK' } },
        { event: 'pod-child-run', timestamp: at(31), data: { childRunId: CHILD, job: 'si-x' } },
      ],
      // Child ledger recovered after the pod ended; a failed recovery starts with pod-ledger-incomplete and has no start.
      [CHILD]: [
        { event: 'pod-ledger-incomplete', timestamp: at(32), data: { job: 'si-x', reason: 'collection-incomplete' } },
        { event: 'pr-opened', timestamp: at(40), data: { url: 'https://github.com/o/r/pull/7', number: 7, goalId: '106fcc8eb4541040' } },
      ],
    },
  });
  try {
    const { edges } = await edgesOf('http://nexus.test/v1/loops/edges?ref=ta-piece&limit=50', deps);
    expect(edges).toContainEqual({ at: at(30), kind: 'run', from: 'UX', to: `loop:${RUN}`, ref: RUN });
    expect(edges).toContainEqual({ at: at(40), kind: 'run', from: `loop:${CHILD}`, to: 'pr:7', ref: CHILD });
    expect(edges.some(edge => edge.to === `loop:${CHILD}`)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pod job-finished supplies the pr edge once, and an unreadable pr number yields none', async () => {
  const { root, deps } = fixture({
    runs: { [RUN]: [
      { event: 'start', timestamp: at(30), data: { seat: 'UX', feature: 'PRIVATE' } },
      { event: 'pr-opened', timestamp: at(40), data: { url: 'https://github.com/o/r/pull/abc', number: '24619' } },
    ] },
  });
  try {
    const noPr = await edgesOf(windowed, deps);
    expect(noPr.edges.some(edge => edge.to.startsWith('pr:'))).toBe(false);
    const withPod = await edgesOf(windowed, { ...deps, listPodFinishes: () => [
      { at: at(45), childRunId: RUN, prNumber: 24620 }, { at: at(46), childRunId: RUN, prNumber: 24620 },
    ] });
    expect(withPod.edges.filter(edge => edge.to.startsWith('pr:'))).toEqual([{ at: at(45), kind: 'run', from: `loop:${RUN}`, to: 'pr:24620', ref: RUN }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a card runId (TA-CARD-RUN-LINK) links its run even when the feature match is ambiguous', async () => {
  const { root, deps } = fixture({
    cards: [piece('ta-a', 'PRIVATE-ONE', at(20), { runId: OTHER_RUN })],
    runs: {
      [RUN]: [{ event: 'start', timestamp: at(30), data: { seat: 'UX', feature: 'PRIVATE-ONE' } }],
      [OTHER_RUN]: [{ event: 'start', timestamp: at(31), data: { seat: 'UX', feature: 'PRIVATE-ONE' } }],
    },
  });
  try {
    const { edges } = await edgesOf('http://nexus.test/v1/loops/edges?ref=ta-a&limit=50', deps);
    expect(edges.filter(edge => edge.kind === 'run').map(edge => edge.ref)).toEqual([OTHER_RUN]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('JOURNEY-HAND-LINK: ?ref=<wish> follows the orchestrator hand to the TASK-AGENT card and its launch', async () => {
  const { root, deps } = fixture({ handed: [
    { key: 'orch:wish-1:wish-1-1', cell: 'wish-1-1', cardId: 'ta-piece', mode: 'live', status: 'handed', runId: 'tick-1', at: at(2) },
    { key: 'orch:wish-2:wish-2-1', cell: 'wish-2-1', cardId: 'ta-other', mode: 'live', status: 'handed', runId: 'tick-1', at: at(3) },
  ] });
  try {
    const { edges } = await edgesOf('http://nexus.test/v1/loops/edges?ref=wish-1&limit=50', deps);
    expect(edges.filter(edge => edge.kind === 'hand').map(edge => edge.ref)).toEqual(['ta-piece']);
    // 다른 소원의 넘김은 끌려오지 않는다
    expect(edges.some(edge => edge.ref === 'ta-other')).toBe(false);
    // 키가 없는 옛 행은 지금처럼 TA 카드 ref 로만 보인다
    const byCard = await edgesOf('http://nexus.test/v1/loops/edges?ref=ta-piece&limit=50', deps);
    expect(byCard.edges.some(edge => edge.kind === 'hand')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
