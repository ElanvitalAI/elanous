import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ReleaseRunView } from '../nexus/api/ops-api.js';
import { ALIVE_EVERY_MS, diffRun, markOf, releaseGraphFile, releaseNowText, releaseWatchTick, type WatchState } from './release-watch.js';

/** 시험은 이 기계의 실제 런 원장을 읽지 않는다 — 그래프 스냅샷 없음으로 고정. */
const NO_GRAPH = (): string | undefined => undefined;

const T0 = Date.parse('2026-10-07T09:00:00.000Z');
const PATH = ['version-release', 'cutoff', 'gate', 'publish', 'done'];

function run(over: Partial<ReleaseRunView> & { ended?: number; runningAt?: string } = {}): ReleaseRunView {
  const ended = over.ended ?? 0;
  const nodes = PATH.slice(0, ended).map((nodeId) => ({ nodeId, ok: true as boolean | null, summary: '' }));
  const status = over.status ?? 'running';
  if (status === 'running' && ended < PATH.length) nodes.push({ nodeId: PATH[ended]!, ok: null, summary: '', ...(over.runningAt ? { startedAt: over.runningAt } : {}) } as never);
  return { runId: 'r1', status, startedAt: new Date(T0).toISOString(), version: '0.2.19', path: PATH.slice(0, ended + 1), nodes, ...over } as ReleaseRunView;
}

function harness(initial: WatchState = { runs: {} }, opts: { away?: boolean; sendOk?: boolean } = {}) {
  let state = initial;
  const sent: string[] = [];
  const urgent: string[] = [];
  let current: ReleaseRunView[] = [];
  let now = T0;
  const deps = {
    presence: () => ({ away: opts.away ?? true }),
    runs: () => current,
    readState: () => state,
    writeState: (next: WatchState) => { state = next; },
    send: (text: string) => { sent.push(text); return opts.sendOk ?? true; },
    sendUrgent: (text: string) => { urgent.push(text); return opts.sendOk ?? true; },
    now: () => now,
    graphFile: NO_GRAPH,
  };
  return {
    deps, sent, urgent,
    set(runs: ReleaseRunView[], at = now) { current = runs; now = at; },
    get state() { return state; },
  };
}

describe('AWAY-MODE-1 — 발행 전이 따라가기', () => {
  test('처음 본 도는 런은 «따라가기 시작» 한 줄 — 지난 노드를 쏟지 않는다', () => {
    const d = diffRun(undefined, run({ ended: 2, runningAt: new Date(T0 + 5 * 60_000).toISOString() }), T0 + 25 * 60_000);
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toContain('0.2.19 발행 따라가기 시작 · 끝난 노드 2 · 지금 gate(20분째)');
  });

  test('22노드 그래프에서 완료 3개는 원장 path 길이가 아닌 3/22 — 시작·생존·지금', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-watch-graph-'));
    const graph = join(dir, 'release-loop.yaml');
    try {
      writeFileSync(graph, `graph_id: release-loop\nterminal_nodes: [done, failed]\nnodes:\n${[
        ...PATH.slice(0, 4), ...Array.from({ length: 18 }, (_, i) => `node-${i}`), 'done', 'failed',
      ].map((id) => `  - node_id: ${id}`).join('\n')}\n`);
      const r = run({ ended: 3, version: '0.2.21' });
      expect(r.path).toHaveLength(4);
      const h = harness();
      h.set([r]);
      const deps = { ...h.deps, graphFile: (candidate: ReleaseRunView) => candidate.runId === r.runId ? graph : undefined };
      expect(releaseWatchTick(deps)).toMatchObject({ outcome: 'sent', lines: 1 });
      expect(h.sent[0]).toContain('끝난 노드 3/22');
      expect(h.sent[0]).not.toContain('끝난 노드 3/4');
      expect(releaseWatchTick(deps).outcome).toBe('quiet');
      h.set([r], T0 + ALIVE_EVERY_MS - 1);
      expect(releaseWatchTick(deps).outcome).toBe('quiet');
      h.set([r], T0 + ALIVE_EVERY_MS);
      expect(releaseWatchTick(deps)).toMatchObject({ outcome: 'sent', lines: 1 });
      expect(h.sent[1]).toContain('끝난 노드 3/22');
      expect(releaseNowText([r], T0, () => graph)).toContain('끝난 노드 3/22');
      const unknown = harness();
      unknown.set([r]);
      expect(releaseWatchTick(unknown.deps).outcome).toBe('sent');
      expect(unknown.sent[0]).toContain('끝난 노드 3 ·');
      expect(unknown.sent[0]).not.toContain('끝난 노드 3/');
      const other = run({ runId: 'other', ended: 3 });
      other.nodes[0] = { nodeId: 'not-in-graph', ok: true, summary: '' };
      expect(diffRun(undefined, other, T0, graph).lines[0]).toContain('끝난 노드 3 ·');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('기본 경로 = 런 원장 옆 스냅샷 <런>.json.graph/graph.yaml — 종결 자리표는 분모에서 뺀다', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-watch-root-'));
    try {
      const r = run({ ended: 3, version: '0.2.21' });
      const file = releaseGraphFile(r, root)!;
      expect(file).toBe(join(root, 'graph-runs', 'release-loop', 'r1.json.graph', 'graph.yaml'));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `graph_id: release-loop\nterminal_nodes: [done, failed]\nnodes:\n${[
        ...PATH.slice(0, 4), ...Array.from({ length: 18 }, (_, i) => `node-${i}`), 'done', 'failed',
      ].map((id) => `  - { node_id: ${id}, kind: gate }`).join('\n')}\n`);
      expect(releaseNowText([r], T0, (x) => releaseGraphFile(x, root))).toContain('끝난 노드 3/22');
      const h = harness();
      h.set([r]);
      expect(releaseWatchTick({ ...h.deps, graphFile: (x) => releaseGraphFile(x, root) }).outcome).toBe('sent');
      expect(h.sent[0]).toContain('끝난 노드 3/22');
      expect(releaseGraphFile(run({ runId: '../escape', ended: 1 }), root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('그래프를 못 읽으면 시작·생존·지금의 분모를 생략한다', () => {
    const missing = join(tmpdir(), 'release-watch-no-such-graph', 'release-loop.yaml');
    const r = run({ ended: 3 });
    expect(diffRun(undefined, r, T0, missing).lines[0]).toContain('끝난 노드 3 ·');
    const prev = markOf(r, new Date(T0).toISOString());
    expect(diffRun(prev, r, T0 + ALIVE_EVERY_MS, missing).lines[0]).toEndWith('끝난 노드 3');
    expect(releaseNowText([r], T0, () => missing)).toContain('끝난 노드 3\n');
  });

  test('이미 끝난 판은 조용히 기준만 잡는다', () => {
    const d = diffRun(undefined, run({ status: 'done', ended: 5 }), T0);
    expect(d.lines).toEqual([]);
    expect(d.changed).toBe(true);
  });

  test('새로 끝난 노드마다 한 줄 · 게이트는 도입 수와 면제를 말한다', () => {
    const r = run({ ended: 3 });
    r.nodes[2] = { nodeId: 'gate', ok: true, summary: '', facts: { verdict: 'pass', introduced: 0, preexisting: 99, waiver: 'OP 면제 승인 · 부하 시간 초과' } };
    const d = diffRun({ status: 'running', ended: 2, running: 'gate', sentAt: new Date(T0).toISOString() }, r, T0);
    expect(d.lines[0]).toBe('✅ gate · 도입 0 · 기존 99 · pass\n   ⚠️ 면제 적용: OP 면제 승인 · 부하 시간 초과');
    expect(d.urgent).toBe(false);
  });

  test('막힘은 무엇·다음 수를 말하고 급함으로 표시한다', () => {
    const r = run({ status: 'failed', ended: 3 });
    r.nodes[2] = { nodeId: 'gate', ok: false, summary: 'introduced 2', facts: { introduced: 2 } };
    const d = diffRun({ status: 'running', ended: 2, running: 'gate', sentAt: new Date(T0).toISOString() }, r, T0);
    expect(d.urgent).toBe(true);
    expect(d.lines.join('\n')).toContain('⛔ 0.2.19 발행 막힘 · gate 실패 — introduced 2');
    expect(d.lines.join('\n')).toContain('다음 수:');
  });

  test('완료 줄은 걸린 시간을 말한다', () => {
    const d = diffRun({ status: 'running', ended: 4, running: 'done', sentAt: new Date(T0).toISOString() }, run({ status: 'done', ended: 5 }), T0 + 125 * 60_000);
    expect(d.lines.at(-1)).toBe('🎉 0.2.19 발행 완료 · 노드 4 · 2시간 5분');
  });

  test('60분 동안 새 전이가 없으면 생존 줄 하나 — 그 전엔 없다', () => {
    const r = run({ ended: 2, runningAt: new Date(T0).toISOString() });
    const prev = markOf(r, new Date(T0).toISOString());
    expect(diffRun(prev, r, T0 + ALIVE_EVERY_MS - 1).lines).toEqual([]);
    expect(diffRun(prev, r, T0 + ALIVE_EVERY_MS).lines[0]).toBe('💓 0.2.19 발행 진행 중 · 지금 gate(60분째) · 끝난 노드 2');
  });

  test('틱: 같은 전이는 두 번 안 보낸다', () => {
    const h = harness();
    h.set([run({ ended: 1 })]);
    expect(releaseWatchTick(h.deps).outcome).toBe('sent');
    expect(releaseWatchTick(h.deps).outcome).toBe('quiet');
    h.set([run({ ended: 2 })]);
    expect(releaseWatchTick(h.deps)).toMatchObject({ outcome: 'sent', lines: 2 });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toContain('✅ cutoff');
    expect(h.sent[1]).toContain('▶ gate 시작');
    expect(h.sent[1]).toContain('https://op.elanous.ai/app/ops/release');
  });

  test('틱: 못 보내면 기준을 안 옮겨 다음 틱이 다시 보낸다', () => {
    const h = harness({ runs: {} }, { sendOk: false });
    h.set([run({ ended: 1 })]);
    expect(releaseWatchTick(h.deps).outcome).toBe('send-failed');
    expect(h.state.runs).toEqual({});
  });

  test('틱: 막힘은 급한 길(야간 무음을 뚫는 길)로 간다', () => {
    const h = harness();
    h.set([run({ ended: 2 })]);
    releaseWatchTick(h.deps);
    const failed = run({ status: 'failed', ended: 3 });
    failed.nodes[2] = { nodeId: 'gate', ok: false, summary: '' };
    h.set([failed]);
    expect(releaseWatchTick(h.deps)).toMatchObject({ outcome: 'sent', urgent: true });
    expect(h.urgent).toHaveLength(1);
  });

  test('틱: 자리에 있으면 아무것도 안 보내고 기준을 지운다', () => {
    const h = harness({ runs: { r1: { status: 'running', ended: 1, sentAt: new Date(T0).toISOString() } } }, { away: false });
    h.set([run({ ended: 3 })]);
    expect(releaseWatchTick(h.deps).outcome).toBe('present');
    expect(h.sent).toEqual([]);
    expect(h.state.runs).toEqual({});
  });

  test('/release 요약: 못 읽음과 없음을 가른다', () => {
    expect(releaseNowText('unavailable', Date.now(), NO_GRAPH)).toContain('「없다」가 아니다');
    expect(releaseNowText([], Date.now(), NO_GRAPH)).toContain('발행 런 기록 없음');
    expect(releaseNowText([run({ ended: 2, runningAt: new Date(T0).toISOString() })], T0 + 10 * 60_000, NO_GRAPH)).toContain('지금: gate (10분째)');
  });
});

describe('AWAY-MODE-1 — 원장 실물 꼴', () => {
  test('종결 자리표 노드(done·failed)는 노드 줄로 안 나오고 실패 런은 막힘으로 말한다', () => {
    const r = run({ status: 'failed', ended: 3 });
    r.nodes[2] = { nodeId: 'gate', ok: false, summary: '' };
    r.nodes.push({ nodeId: 'failed', ok: true, summary: '' });
    const d = diffRun({ status: 'running', ended: 2, running: 'gate', sentAt: new Date(T0).toISOString() }, r, T0);
    expect(d.lines.join('\n')).not.toContain('✅ failed');
    expect(d.lines.join('\n')).toContain('⛔ 0.2.19 발행 막힘 · gate 실패');
  });

  test('«running» 인 채 버려진 옛 런은 따라가지 않는다', () => {
    const h = harness();
    h.set([run({ ended: 2, startedAt: new Date(T0 - 40 * 3600_000).toISOString() })], T0);
    expect(releaseWatchTick(h.deps)).toMatchObject({ outcome: 'quiet', followed: 0 });
    expect(h.sent).toEqual([]);
  });
});

describe('GATE-LIVE-OBS — 외출 알림의 조각 줄', () => {
  const shards = (timeout: number) => {
    const list = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `pod-${i}`, state: 'running' as const, plannedMin: 20 })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `pod-w${i}`, state: 'pending' as const, waitReason: 'CPU 부족', plannedMin: 10 })),
      ...Array.from({ length: timeout }, (_, i) => ({ id: `pod-t${i}`, state: 'timeout' as const, plannedMin: 20 })),
    ];
    const counts = { pending: 2, running: 3, done: 0, retry: 0, timeout, failed: 0 };
    return { v: 1 as const, version: '0.2.19', updatedAt: new Date(T0).toISOString(), shards: list,
      summary: { total: list.length, counts, waitReasons: [{ reason: 'CPU 부족', count: 2 }], etaMin: 27, staleMin: 0, overrunMin: 0, doneWithFailures: 0, verdict: null } };
  };

  test('잘림·실패 조각이 늘 때만 한 줄 · 같은 수면 조용하다', () => {
    const first = run({ ended: 2, gateShards: shards(0) });
    const mark = markOf(first, new Date(T0).toISOString());
    expect(mark.shardsBad).toBe(0);
    expect(diffRun(mark, first, T0 + 60_000).lines).toEqual([]);
    const worse = run({ ended: 2, gateShards: shards(2) });
    const { lines, changed } = diffRun(mark, worse, T0 + 60_000);
    expect(changed).toBe(true);
    expect(lines).toEqual(['⚠️ gate 조각 잘림·실패 2 · 조각 7 · 돌기 3 · 대기 2(CPU 부족 2) · 잘림 2 · 남은 약 27분']);
    expect(diffRun(markOf(worse, new Date(T0).toISOString()), worse, T0 + 60_000).lines).toEqual([]);
  });

  test('/release 지금 요약에 조각 줄이 붙는다', () => {
    const text = releaseNowText([run({ ended: 2, gateShards: shards(1) })], T0, NO_GRAPH);
    expect(text).toContain('지금: gate');
    expect(text).toContain('조각 6 · 돌기 3 · 대기 2(CPU 부족 2) · 잘림 1 · 남은 약 27분');
  });
});
