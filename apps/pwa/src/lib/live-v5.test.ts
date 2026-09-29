import { describe, expect, test } from 'bun:test';
import type { LogRow } from '@/nexus/client';
import { buildLiveBoard } from './live-signals';
import { gateTally, histogram, modelSiteHeatmap, modelTicker, planPieces, podDispatches, runSpans, runUniverses, selfHealedPrs, stageLoad, stageRetries, usageCandles, usageRequests } from './live-v5';

const now = Date.parse('2026-09-28T01:00:30.000Z');
const r = (min: number, category: string, event: string, data: Record<string, unknown>): LogRow => ({ ts: new Date(now - min * 60_000).toISOString(), category, event, data });
const u = (min: number, model: string, site = 'stream-llm', tokens = 100) => r(min, 'llm.usage', 'llm-usage', { model, site, billing: 'subscription', billingProvider: 'openai-codex', inputTokens: tokens, outputTokens: 10, cost: { apiEquivalentUsd: 0.001 } });

describe('live v5 data', () => {
  const rows = [u(1, 'luna'), u(1, 'luna', 'router'), u(2, 'sol'), u(20, 'luna'), u(25, 'sol'), u(26, 'sol'),
    r(30, 'dev-pipeline', 'plan', { runId: 'run-a' }), r(10, 'self-gate', 'gate-passed', { runId: 'run-a' }), r(5, 'self-gate', 'gate-failed', { runId: 'run-a' })];
  const reqs = usageRequests(rows);

  test('requests: newest first, fields from llm.usage only', () => {
    expect(reqs).toHaveLength(6);
    expect(reqs[0]).toMatchObject({ model: 'luna', input: 100, output: 10, provider: 'openai-codex', apiUsd: 0.001 });
    expect(reqs[0]!.t).toBeGreaterThanOrEqual(reqs[1]!.t);
  });

  test('candles: one bar per minute with empty minutes kept; last bar is this minute', () => {
    const c = usageCandles(reqs, now, 30);
    expect(c).toHaveLength(30);
    expect(c.reduce((n, x) => n + x.count, 0)).toBe(6);
    expect(c.at(-2)!.byModel).toEqual({ luna: 2 });
    // 창이 길면 칸을 넓힌다 — 10분 칸 넷이면 26분 전 요청까지 담긴다.
    expect(usageCandles(reqs, now, 4, 10 * 60_000).reduce((n, x) => n + x.count, 0)).toBe(6);
  });

  test('ticker: ▲ when the late half has more requests than the early half', () => {
    const t = modelTicker(reqs, now, 40 * 60_000);
    expect(t.find((x) => x.model === 'luna')!.delta).toBe(1);
    expect(t.find((x) => x.model === 'sol')!.delta).toBe(-1);
  });

  test('heatmap model × site, histogram, spans, gate tally, stage load', () => {
    const h = modelSiteHeatmap(reqs);
    expect(h.cells['luna|stream-llm']).toBe(2);
    expect(h.cells['luna|router']).toBe(1);
    expect(h.max).toBe(3);
    expect(histogram([1, 2, 3, 4], 4)).toEqual({ bins: [1, 1, 1, 1], lo: 1, hi: 4, max: 1 });
    expect(histogram([], 3).bins).toEqual([0, 0, 0]);
    expect(runSpans(rows)).toEqual([{ runId: 'run-a', ms: 25 * 60_000 }]);
    expect(gateTally(rows)).toEqual({ pass: 1, fail: 1 });
    const load = stageLoad(buildLiveBoard(rows, [], { now, windowMinutes: 60 }));
    expect(load.busiest).toBe('gate');
    expect(load.counts.gate).toBe(1);
  });

  test('self-healed = must-fix then merged; universes by the first instance that logged the run', () => {
    const rr = [
      r(9, 'review-loop', 'judge-verdict', { pr: '7', asks: 2 }),
      r(8, 'review-loop', 'auto-merged', { pr: '7' }),
      r(7, 'review-loop', 'rework-start', { pr: '8' }),
      r(6, 'review-loop', 'auto-merged', { pr: '9' }),
      { ...r(5, 'dev-pipeline', 'plan', { runId: 'run-x' }), instance: 'test:wt-launch' },
    ];
    expect(selfHealedPrs(rr)).toEqual(['7']);
    expect(runUniverses(rr)).toEqual([{ runId: 'run-x', instance: 'test:wt-launch' }]);
  });

  test('plan tree pieces (names win over counts, latest per run) · pod dispatches · retry rings', () => {
    const rr = [
      r(9, 'goal-author', 'goal-steps-decomposed', { runId: 'run-p', stepCount: 3 }),
      r(8, 'self-dev.supervisor', 'decompose-and-retry.applied', { runId: 'run-p', pieceFeatures: ['A 조각', 'B 조각'] }),
      r(7, 'goal-author', 'goal-steps-decomposed', { runId: 'run-q', stepCount: 1 }),
      r(6, 'harness.substrate', 'dispatch-pod', { podPool: 'pool-node-b@node-b:25' }),
      r(5, 'review-loop', 'rework-start', { runId: 'run-p', pr: '9', round: 2 }),
      r(4, 'self-gate', 'gate-failed', { runId: 'run-p' }),
    ];
    expect(planPieces(rr)).toEqual([{ runId: 'run-p', pieces: ['A 조각', 'B 조각'] }]);
    expect(podDispatches(rr)).toEqual([{ pool: 'pool-node-b@node-b:25', ts: rr[3]!.ts }]);
    expect(stageRetries(rr)).toEqual([{ runId: 'run-p', stage: 'review', retries: 2 }, { runId: 'run-p', stage: 'gate', retries: 1 }]);
  });
});
