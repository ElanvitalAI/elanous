import { describe, expect, test } from 'bun:test';
import type { LogRow } from '@/nexus/client';
import { buildLiveBoard } from './live-signals';
import { buildJudgmentGraph, newDecisionKeys, phaseId, stepForces } from './live-graph';

const now = Date.parse('2026-09-28T01:00:00.000Z');
const r = (min: number, category: string, event: string, data: Record<string, unknown>): LogRow => ({ ts: new Date(now - min * 60_000).toISOString(), category, event, data });
const logs = [
  r(30, 'dev-pipeline', 'plan', { runId: 'run-a1' }),
  r(20, 'review-loop', 'judge-verdict', { runId: 'run-a1', pr: '5', verdict: 'rework', round: 1, asks: 7 }),
  r(15, 'review-loop', 'judge-verdict', { runId: 'run-a1', pr: '5', verdict: 'rework', round: 2, asks: 3 }),
  r(10, 'review-loop', 'auto-merged', { runId: 'run-a1', pr: '5' }),
  r(8, 'oauth.codex-account', 'rotation', { account: 'team', reason: 'default 95%' }),
  r(5, 'llm.usage', 'llm-usage', { model: 'gpt-6-sol', inputTokens: 10, outputTokens: 1 }),
];
const board = buildLiveBoard(logs, [], { now, windowMinutes: 60 });

describe('judgment graph', () => {
  test('harness in the middle, runs, PRs, models and decision targets as nodes', () => {
    const g = buildJudgmentGraph(board);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain('harness');
    expect(ids).toContain('run:run-a1');
    expect(ids).toContain('pr:5');
    expect(ids).toContain('model:gpt-6-sol');
    expect(ids).toContain('target:team');
    // 런 → 페이즈 → PR 세 겹(🅢 09-28) — PR 은 마지막 페이즈(착지)에 붙는다.
    expect(ids).toContain(phaseId('run-a1', 'author'));
    expect(ids).toContain(phaseId('run-a1', 'review'));
    expect(g.edges).toContainEqual({ from: phaseId('run-a1', 'land'), to: 'pr:5', kind: 'SHIP' });
    expect(g.edges).toContainEqual({ from: 'run:run-a1', to: phaseId('run-a1', 'author'), kind: 'PLAN' });
    // 신호 없는 단계는 노드가 없다(가짜 노드 금지).
    expect(ids).not.toContain(phaseId('run-a1', 'build'));
    expect(g.nodes.filter((n) => n.kind === 'phase' && n.current).map((n) => n.id)).toEqual([phaseId('run-a1', 'land')]);
    expect(g.edges.some((e) => e.to === 'target:team' && e.kind === 'ROUTE')).toBe(true);
  });

  test('convergence series per PR by round', () => {
    expect(board.convergence).toEqual([{ pr: '5', points: [{ round: 1, asks: 7 }, { round: 2, asks: 3 }] }]);
  });

  test('forces keep nodes inside the frame and the harness pinned', () => {
    const g = buildJudgmentGraph(board);
    for (let i = 0; i < 200; i++) stepForces(g);
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0.03); expect(n.x).toBeLessThanOrEqual(0.97);
      expect(n.y).toBeGreaterThanOrEqual(0.1); expect(n.y).toBeLessThanOrEqual(0.95);
    }
    // 바깥 고리 — 모델·행선지는 런보다 가운데서 멀다.
    const dist = (id: string) => { const n = g.nodes.find((x) => x.id === id)!; return Math.hypot(n.x - 0.5, n.y - 0.5); };
    expect(dist('model:gpt-6-sol')).toBeGreaterThan(dist('run:run-a1'));
    const h = g.nodes.find((n) => n.id === 'harness')!;
    expect([h.x, h.y]).toEqual([0.5, 0.5]);
  });

  test('only unseen decisions fire particles', () => {
    const first = newDecisionKeys(new Set(), board);
    expect(first.length).toBe(board.stream.length);
    expect(newDecisionKeys(new Set(first.map((f) => f.key)), board)).toEqual([]);
    expect(first.find((f) => f.kind === 'SHIP')?.to).toBe('pr:5');
  });
});

describe('judgment graph v5 density', () => {
  test('signal kinds hang off their phase, sites off their model, billing accounts on the outer ring', async () => {
    const { runEventKinds, usageRequests } = await import('./live-v5');
    const rows = [...logs,
      r(4, 'llm.usage', 'llm-usage', { model: 'gpt-6-sol', site: 'stream-llm', billingProvider: 'openai-codex', inputTokens: 5, outputTokens: 1 }),
      r(3, 'self-gate', 'gate-failed', { runId: 'run-a1' }),
    ];
    const b = buildLiveBoard(rows, [], { now, windowMinutes: 60 });
    const g = buildJudgmentGraph(b, { events: runEventKinds(rows), reqs: usageRequests(rows) });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain('ev:run-a1|review-loop.judge-verdict');
    expect(g.edges).toContainEqual({ from: phaseId('run-a1', 'review'), to: 'ev:run-a1|review-loop.judge-verdict', kind: 'VERIFY' });
    expect(g.edges).toContainEqual({ from: 'model:gpt-6-sol', to: 'site:gpt-6-sol|stream-llm', kind: 'ROUTE' });
    expect(g.edges).toContainEqual({ from: 'acct:openai-codex', to: 'model:gpt-6-sol', kind: 'ROUTE' });
    // 요청 한 건 = 점 하나 — 사이트 곁.
    expect(g.nodes.filter((n) => n.kind === 'request')).toHaveLength(2);
    expect(g.edges.some((e) => e.from === 'site:gpt-6-sol|stream-llm' && e.to.startsWith('req:'))).toBe(true);
    const failed = g.nodes.find((n) => n.id === 'ev:run-a1|self-gate.gate-failed')!;
    expect(failed.tone).toBe('bad');
  });

  test('a crowd (400+ nodes) does not pile onto the frame edge', async () => {
    const { usageRequests } = await import('./live-v5');
    const { runEventKinds } = await import('./live-v5');
    const many = Array.from({ length: 400 }, (_, i) => r(1 + (i % 50), 'llm.usage', 'llm-usage', { model: `m${i % 6}`, site: `s${i % 4}`, billingProvider: 'p', inputTokens: 10, outputTokens: 1 }));
    // 실제 구성처럼 — 런 30개 × 신호 종류 8개(v5 연합 실측에서 테두리에 줄을 서던 것).
    const runsRows = Array.from({ length: 30 * 8 }, (_, i) => r(2 + (i % 40), i % 8 === 0 ? 'dev-pipeline' : 'self-dev.supervisor', i % 8 === 0 ? 'plan' : `ev${i % 8}`, { runId: `run-${Math.floor(i / 8)}` }));
    const rows = [...logs, ...many, ...runsRows];
    const b = buildLiveBoard(rows, [], { now, windowMinutes: 60 });
    const g = buildJudgmentGraph(b, { reqs: usageRequests(rows), events: runEventKinds(rows) });
    for (let i = 0; i < 300; i++) stepForces(g);
    const onEdge = g.nodes.filter((n) => n.x <= 0.031 || n.x >= 0.969 || n.y <= 0.101 || n.y >= 0.949).length;
    expect(g.nodes.length).toBeGreaterThan(300);
    expect(onEdge / g.nodes.length).toBeLessThan(0.05);
  });
});
