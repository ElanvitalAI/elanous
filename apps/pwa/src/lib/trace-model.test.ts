import { describe, expect, test } from 'bun:test';
import type { LogRow } from '@/nexus/client';
import { buildTraceModel, crumbs, decisionEvidence, findingSignature, lensRows, repeatedFindings, runGantt, drillDown, drillUp, facets, lensFromSearch, lensRuns, lensToSearch, runDecisions, serverDecisionChain, mergeServerRuns, ledgerRunStatus, traceGraph } from './trace-model';

const now = Date.parse('2026-09-28T02:00:00.000Z');
const r = (min: number, category: string, event: string, data: Record<string, unknown>, instance = 'prod'): LogRow => ({ ts: new Date(now - min * 60_000).toISOString(), category, event, data, instance });
const rows: LogRow[] = [
  r(50, 'dev-pipeline', 'plan', { runId: 'run-a' }),
  r(40, 'review-loop', 'judge-verdict', { runId: 'run-a', pr: '5', verdict: 'rework', round: 1, asks: 2 }),
  r(30, 'review-loop', 'auto-merged', { runId: 'run-a', pr: '5' }),
  r(45, 'dev-pipeline', 'plan', { runId: 'run-b', parentRunId: 'run-a' }, 'test:wt-launch'),
  r(20, 'self-gate', 'gate-failed', { runId: 'run-b' }, 'test:wt-launch'),
  r(12, 'dev-pipeline', 'plan', { runId: 'run-c' }, 'test:wt-launch'),
  r(10, 'dev-pipeline', 'rejected', { runId: 'run-c', reason: 'preflight' }, 'test:wt-launch'),
];
const model = buildTraceModel(rows, [], { now, windowMinutes: 120 });

describe('trace model (RFC v6 T2)', () => {
  test('runs carry universe (first writer), status, parent link; universes count runs', () => {
    const a = model.runs.find((x) => x.runId === 'run-a')!;
    const b = model.runs.find((x) => x.runId === 'run-b')!;
    expect(a).toMatchObject({ universe: 'prod', status: 'landed', pr: '5' });
    expect(b).toMatchObject({ universe: 'test:wt-launch', parentRunId: 'run-a' });
    expect(model.universes.map((u) => [u.name, u.runs])).toEqual([['test:wt-launch', 2], ['prod', 1]]);
  });

  test('lens filters accumulate; facets count what each chip would leave', () => {
    const lens = { level: 'L1' as const, universe: 'test:wt-launch', windowMin: 120 };
    expect(lensRuns(model, lens).map((x) => x.runId).sort()).toEqual(['run-b', 'run-c']);
    const f = facets(model, lens);
    expect(f.universe).toEqual({ prod: 1, 'test:wt-launch': 2 });
    expect(f.status.landed).toBe(0);
    expect(lensRuns(model, { ...lens, q: 'run-c' }).map((x) => x.runId)).toEqual(['run-c']);
  });

  test('graphs per level: L0 universes ⊃ runs · L1 parent edges · L2 stages and decisions of one run', () => {
    const l0 = traceGraph(model, { level: 'L0', windowMin: 120 });
    expect(l0.nodes.filter((n) => n.kind === 'universe')).toHaveLength(2);
    expect(l0.edges).toContainEqual({ source: 'u:prod', target: 'r:run-a', kind: 'contains' });
    const l1 = traceGraph(model, { level: 'L1', windowMin: 120 });
    expect(l1.edges).toContainEqual({ source: 'r:run-a', target: 'r:run-b', kind: 'parent' });
    const l2 = traceGraph(model, { level: 'L2', runId: 'run-a', windowMin: 120 });
    expect(l2.nodes.map((n) => n.id)).toContain('s:review');
    expect(l2.nodes.some((n) => n.kind === 'decision')).toBe(true);
    expect(runDecisions(model, 'run-a').map((d) => d.kind)).toEqual(['PLAN', 'VERIFY', 'SHIP']);
  });

  test('URL state round-trips; drill down/up adds and removes one lens slot', () => {
    const lens = { level: 'L2' as const, universe: 'prod', runId: 'run-a', status: 'landed' as const, q: 'x', windowMin: 360 };
    expect(lensFromSearch(lensToSearch(lens))).toEqual(lens);
    expect(lensFromSearch('?level=bogus')).toEqual({ level: 'L1', windowMin: 1440 });
    expect(drillDown({ level: 'L0', windowMin: 1440 }, { id: 'u:prod', kind: 'universe' })).toEqual({ level: 'L1', universe: 'prod', windowMin: 1440 });
    expect(drillDown({ level: 'L1', windowMin: 1440 }, { id: 'r:run-a', kind: 'run' })).toEqual({ level: 'L2', runId: 'run-a', windowMin: 1440 });
    expect(drillUp(lens)).toEqual({ level: 'L1', universe: 'prod', status: 'landed', q: 'x', windowMin: 360 });
    expect(crumbs(lens).map((c) => c.key)).toEqual(['universe', 'status', 'runId', 'q']);
  });

  test('L3: decision index in the lens and URL; L4 evidence = source row, nearby rows, re-find command, PR', () => {
    const l3 = drillDown({ level: 'L2', runId: 'run-a', windowMin: 120 }, { id: 'd:1', kind: 'decision' });
    expect(l3).toEqual({ level: 'L3', runId: 'run-a', decision: 1, windowMin: 120 });
    expect(lensFromSearch(lensToSearch(l3))).toEqual(l3);
    expect(drillUp(l3)).toEqual({ level: 'L2', runId: 'run-a', windowMin: 120 });
    const d = runDecisions(model, 'run-a')[2]!;
    const ev = decisionEvidence(model, d, 'prod');
    expect(ev.source?.event).toBe('auto-merged');
    expect(ev.command).toContain('elanous logs --instance prod --category review-loop');
    expect(ev.command).toContain('--grep run-a');
    expect(ev.pr).toBe('5');
  });

  test('time brush filters by overlap and round-trips in the URL; gantt spans per stage', () => {
    const from = now - 35 * 60_000; const to = now - 5 * 60_000;
    const lens = { level: 'L1' as const, from, to, windowMin: 120 };
    // run-a: 50→30분 전 · run-b: 45→20 · run-c: 12→10 — 35~5분 전이면 셋 다 겹치고, 15~5분 전이면 run-c 만.
    expect(lensRuns(model, lens).length).toBe(3);
    expect(lensRuns(model, { ...lens, from: now - 15 * 60_000 }).map((x) => x.runId).sort()).toEqual(['run-c']);
    expect(lensFromSearch(lensToSearch(lens))).toEqual(lens);
    expect(crumbs(lens)[0]!.key).toBe('time');
    const g = runGantt(model, 'run-a');
    expect(g.map((x) => x.stage)).toEqual(['author', 'review', 'land']);
    expect(g[0]!.start).toBe(now - 50 * 60_000);
  });

  test('«같은 지적» — VERIFY «왜» 서명이 둘 이상의 런에 나오면 칩 · 렌즈로 좁힌다', () => {
    const d = (min: number, runId: string, reason: string, kind = 'VERIFY'): LogRow => r(min, 'harness.decision', 'decision', { kind, what: '리뷰 must-fix', reason, runId });
    const rows2 = [...rows,
      d(9, 'run-a', 'src/x.ts:12 에서 null 검사가 빠졌다 (#21035)'),
      d(8, 'run-b', 'src/x.ts:40 에서 null 검사가 빠졌다 (#21040)'),
      d(7, 'run-c', '시험이 경계를 안 문다'),
      d(6, 'run-c', '시험이 경계를 안 문다', 'PLAN'),
    ];
    const m = buildTraceModel(rows2, [], { now, windowMinutes: 120 });
    expect(findingSignature({ kind: 'PLAN', why: 'x y z w q', what: '' })).toBeNull();
    const rep = repeatedFindings(m);
    expect(rep).toHaveLength(1);
    expect(rep[0]!.runs).toBe(2);
    const lens = { level: 'L1' as const, finding: rep[0]!.sig, windowMin: 120 };
    expect(lensRuns(m, lens).map((x) => x.runId).sort()).toEqual(['run-a', 'run-b']);
    expect(lensFromSearch(lensToSearch(lens))).toEqual(lens);
    expect(crumbs(lens)[0]!.key).toBe('finding');
  });

  test('«발표» rows — only runs left in the lens (rows without a runId stay for the stage bands)', () => {
    const extra = [...rows, r(3, 'llm.usage', 'llm-usage', { model: 'm', inputTokens: 1, outputTokens: 1 })];
    const m = buildTraceModel(extra, [], { now, windowMinutes: 120 });
    expect(lensRows(m, { level: 'L1', windowMin: 120 })).toBe(m.rows);
    const narrowed = lensRows(m, { level: 'L1', universe: 'prod', windowMin: 120 });
    expect(new Set(narrowed.map((x) => x.data?.runId).filter(Boolean))).toEqual(new Set(['run-a']));
    expect(narrowed.some((x) => x.category === 'llm.usage')).toBe(true);
    expect(lensRows(m, { level: 'L2', runId: 'run-b', windowMin: 120 }).filter((x) => x.data?.runId).every((x) => x.data?.runId === 'run-b')).toBe(true);
  });
});

describe('serverDecisionChain — 🅣 /v1/trace L3 → 판단 사슬', () => {
  const ev = (over: Partial<import('@/nexus/client').TraceEventWire>) => ({
    id: 'log:test%3Awt:1', ts: '2026-09-28T07:00:00.000Z', universe: 'test:wt', runId: 'run-a', kind: 'ROUTE', what: 'w',
    refs: { logId: 'log:test%3Awt:1' }, ...over,
  });
  test('그 런의 판단 여섯 가지만 · 옛것 → 최신 · 열쇠와 PR·커밋을 싣는다', () => {
    const chain = serverDecisionChain([
      ev({ ts: '2026-09-28T07:00:03.000Z', kind: 'SHIP', refs: { logId: 'log:u:3', pr: '#21590', commit: 'abc123' } }),
      ev({ ts: '2026-09-28T07:00:01.000Z', kind: 'PLAN', why: '이유', paths: ['a', 'b'] }),
      ev({ ts: '2026-09-28T07:00:02.000Z', kind: 'review' }),
      ev({ ts: '2026-09-28T07:00:00.500Z', kind: 'ROUTE', runId: 'run-b' }),
    ], 'run-a');
    expect(chain.map((d) => d.kind)).toEqual(['PLAN', 'SHIP']);
    expect(chain[0]).toMatchObject({ why: '이유', paths: 2, logId: 'log:test%3Awt:1', pr: null });
    expect(chain[1]).toMatchObject({ pr: '21590', commit: 'abc123', logId: 'log:u:3' });
  });
  test('없으면 빈 사슬 — 화면이 이 창 조회로 되돌아간다', () => {
    expect(serverDecisionChain([], 'run-a')).toEqual([]);
  });
});

describe('mergeServerRuns — 🅣 L1 런 집계로 창이 놓친 런을 채운다', () => {
  const now = Date.parse('2026-09-28T08:00:00.000Z');
  const base = buildTraceModel([], [], { now, windowMinutes: 1440 });
  const node = (runId: string, lastTs: string, extra: Record<string, unknown> = {}) => ({ id: `run:u:${runId}`, level: 'L1', label: runId, count: 7, universe: 'u', runId, firstTs: '2026-09-28T07:00:00.000Z', lastTs, ...extra });
  test('창에 없는 런을 더하고 상태는 지어내지 않는다 — 원장 · 최근 신호 · 아니면 quiet', () => {
    const m = mergeServerRuns(base, { nodes: [
      node('run-old', '2026-09-28T06:00:00.000Z'),
      node('run-fresh', '2026-09-28T07:55:00.000Z'),
      node('run-done', '2026-09-28T06:00:00.000Z'),
    ], edges: [{ source: 'run:u:run-old', target: 'run:u:run-fresh', kind: 'parent' }] }, [{ runId: 'run-done', status: 'completed' }], now);
    const by = Object.fromEntries(m.runs.map((r) => [r.runId, r]));
    expect(by['run-old'].status).toBe('quiet');
    expect(by['run-fresh'].status).toBe('running');
    expect(by['run-fresh'].parentRunId).toBe('run-old');
    expect(by['run-done'].status).toBe('landed');
    expect(by['run-old'].events).toBe(7);
    expect(m.universes.find((u) => u.name === 'u')?.runs).toBe(3);
  });
  test('서버가 없거나 이미 아는 런뿐이면 모델을 그대로 돌려준다', () => {
    expect(mergeServerRuns(base, undefined, [], now)).toBe(base);
    expect(mergeServerRuns(base, { nodes: [{ id: 'universe:u', level: 'L0', label: 'u', count: 1 }] }, [], now)).toBe(base);
  });
  test('원장 상태 문자열', () => {
    expect(['completed', 'failed', 'running', 'weird', undefined].map(ledgerRunStatus)).toEqual(['landed', 'blocked', 'running', null, null]);
  });
});
