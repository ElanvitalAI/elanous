import { describe, expect, test } from 'bun:test';
import type { LogRow } from '@/nexus/client';
import { buildLiveSnapshot, cardText, classifySignal, logLine, redactLogText } from './live-signals';

const now = Date.parse('2026-09-28T01:00:00.000Z');
const at = (min: number) => new Date(now - min * 60_000).toISOString();
const row = (min: number, category: string, event: string, data: Record<string, unknown> = {}, level = 'debug'): LogRow =>
  ({ ts: at(min), category, event, data, level });

describe('classifySignal', () => {
  test('maps known categories to stages and marks failures red', () => {
    expect(classifySignal({ category: 'goal-author', event: 'ground-started' }).stage).toBe('author');
    expect(classifySignal({ category: 'dev-pipeline', event: 'harness.launch' }).stage).toBe('build');
    expect(classifySignal({ category: 'self-dev.reduce', event: 'gate-failed' })).toEqual({ stage: 'gate', tone: 'bad' });
    expect(classifySignal({ category: 'review-loop', event: 'judge-verdict' }).stage).toBe('review');
    expect(classifySignal({ category: 'review-loop', event: 'auto-merged' })).toEqual({ stage: 'land', tone: 'ok' });
    expect(classifySignal({ category: 'llm.usage', event: 'llm-usage' }).stage).toBeNull();
  });
});

describe('buildLiveSnapshot', () => {
  const logs: LogRow[] = [
    row(30, 'dev-pipeline', 'plan', { runId: 'run-a' }),
    row(25, 'dev-pipeline', 'harness.launch', { runId: 'run-a' }),
    row(20, 'review-loop', 'judge-verdict', { runId: 'run-a', pr: '101', verdict: 'rework', asks: 2 }),
    row(10, 'review-loop', 'auto-merged', { runId: 'run-a', pr: '101' }),
    row(5, 'dev-pipeline', 'plan', { runId: 'run-b' }),
    row(4, 'self-dev.reduce', 'gate-failed', { runId: 'run-b' }),
    row(3, 'llm.usage', 'llm-usage', { model: 'gpt-6-sol', inputTokens: 1000, outputTokens: 200 }),
    row(2, 'llm.usage', 'llm-usage', { model: 'grok-4.7', inputTokens: 10, outputTokens: 5 }),
    row(1, 'llm.usage', 'llm-usage', { model: 'gpt-6-sol', inputTokens: 1, outputTokens: 1 }),
    row(90, 'review-loop', 'auto-merged', { runId: 'run-old', pr: '1' }),
  ];
  const snap = buildLiveSnapshot(logs, [{ runId: 'run-b', status: 'running' }], { now, windowMinutes: 60 });

  test('groups signals by run, newest first, with stages seen and never invents unseen ones', () => {
    expect(snap.runs.map((r) => r.runId)).toEqual(['run-b', 'run-a']);
    const a = snap.runs.find((r) => r.runId === 'run-a')!;
    expect(a.stages).toEqual({ author: 'info', build: 'info', review: 'info', land: 'ok' });
    expect(a.stages.gate).toBeUndefined();
    expect(a.pr).toBe('101');
    const b = snap.runs.find((r) => r.runId === 'run-b')!;
    expect(b.blocked).toBe(true);
    expect(b.ledgerStatus).toBe('running');
  });

  test('counters and distributions come only from rows in the window', () => {
    expect(snap.counters.llmRequests).toBe(3);
    expect(snap.counters.tokens).toBe(1217);
    expect(snap.counters.landed).toBe(1);
    expect(snap.counters.blocked).toBe(1);
    expect(snap.counters.activeRuns).toBe(1);
    expect(snap.providers).toEqual([{ name: 'gpt-6-sol', count: 2 }, { name: 'grok-4.7', count: 1 }]);
    expect(snap.reviewVerdicts).toEqual([{ name: 'rework', count: 1 }]);
  });

  test('judgment cards read like decisions, newest first', () => {
    expect(snap.cards.map((c) => c.text)).toEqual(['게이트 실패 → 수리 라운드', '자동 병합 #101', '리뷰 판정: rework · #101 · 요구 2']);
  });
});

describe('text safety', () => {
  test('redacts key-like strings and bearer tokens', () => {
    expect(redactLogText('key sk-abcdefghijklmnop and Bearer abc.def.ghijk')).toBe('key [redacted] and Bearer [redacted]');
    expect(redactLogText('{"token":"supersecretvalue"}')).toBe('{"token":"[redacted]"}');
  });
  test('log line carries a short gist, redacted', () => {
    expect(logLine(row(1, 'review-loop', 'judge-verdict', { runId: 'run-a', verdict: 'pass', secret: 'x' }), 'UTC')).toBe('00:59:00 review-loop judge-verdict · runId=run-a verdict=pass');
  });
  test('unknown rows make no card', () => {
    expect(cardText(row(1, 'misc', 'thing'))).toBeNull();
  });
});

import { buildLiveBoard, decisionKind } from './live-signals';

describe('decisions (v3 §0b)', () => {
  test('kinds are named by what the harness decided', () => {
    expect(decisionKind({ category: 'review-loop', event: 'judge-verdict' })).toBe('VERIFY');
    expect(decisionKind({ category: 'review-loop', event: 'rework-start' })).toBe('HEAL');
    expect(decisionKind({ category: 'review-loop', event: 'auto-merged' })).toBe('SHIP');
    expect(decisionKind({ category: 'oauth.codex-account', event: 'rotation' })).toBe('ROUTE');
    expect(decisionKind({ category: 'dev-pipeline', event: 'rejected' })).toBe('ESCALATE');
    expect(decisionKind({ category: 'dev-pipeline', event: 'plan' })).toBe('PLAN');
    expect(decisionKind({ category: 'llm.usage', event: 'llm-usage' })).toBeNull();
  });

  const logs = [
    row(40, 'dev-pipeline', 'plan', { runId: 'run-h' }),
    row(30, 'review-loop', 'judge-verdict', { runId: 'run-h', pr: '7', verdict: 'rework', round: 1 }),
    row(25, 'review-loop', 'rework-start', { runId: 'run-h', pr: '7', round: 2 }),
    row(20, 'review-loop', 'auto-merged', { runId: 'run-h', pr: '7' }),
    row(10, 'oauth.codex-account', 'rotation', { account: 'team', reason: 'default 95%' }),
    row(5, 'llm.usage', 'llm-usage', { model: 'gpt-6-sol', inputTokens: 600, outputTokens: 0, billing: 'subscription' }),
  ];
  const board = buildLiveBoard(logs, [], { now, windowMinutes: 60 });

  test('gauges: decisions, shipped, self-heal rate, burn', () => {
    expect(board.gauges.decisions).toBe(5);
    expect(board.gauges.shipped).toBe(1);
    expect(board.gauges.selfHealRuns).toBe(1);
    expect(board.gauges.selfHealRate).toBe(100);
    expect(board.gauges.burnTokensPerMin).toBe(10);
    expect(board.rounds['run-h']).toBe(2);
  });

  test('stream carries why/target when the log has them and the missing-fields table counts the rest', () => {
    const rot = board.stream.find((s) => s.kind === 'ROUTE')!;
    expect(rot.why).toBe('default 95%');
    expect(rot.target).toBe('team');
    const ship = board.stream.find((s) => s.kind === 'SHIP')!;
    expect(ship.target).toBe('#7');
    expect(board.missing.find((m) => m.key === 'review-loop judge-verdict')?.lacks).toEqual(['why', 'purpose', 'target']);
    expect(board.scorecard).toEqual([{ model: 'gpt-6-sol', requests: 1, tokens: 600, billing: 'subscription' }]);
  });
});

describe('harness.decision (🅢 #21452 emitDecision)', () => {
  test('uses the kind, what, why, purpose, target and paths the harness emitted', () => {
    const board = buildLiveBoard([
      row(2, 'harness.decision', 'decision', { kind: 'route', what: 'codex team 선택', reason: 'default 95%', purpose: '한도 보존', target: 'pod node-b', paths: 3, runId: 'run-z' }),
      row(1, 'harness.decision', 'decision', { kind: 'bogus', what: 'x' }),
    ], [], { now, windowMinutes: 60 });
    expect(board.emitted).toBe(2);
    expect(board.stream).toHaveLength(1);
    expect(board.stream[0]).toMatchObject({ kind: 'ROUTE', what: 'codex team 선택', why: 'default 95%', purpose: '한도 보존', target: 'pod node-b', paths: 3, runId: 'run-z' });
  });
});

describe('09-28 S decisions', () => {
  test('clock shows the device time zone (KST here) and emitted decisions win over synthesized ones of the same kind', () => {
    expect(logLine(row(1, 'review-loop', 'judge-start', {}), 'Asia/Seoul')).toBe('09:59:00 review-loop judge-start');
    const board = buildLiveBoard([
      row(3, 'oauth.codex-account', 'rotation', { account: 'team', reason: 'x' }),
      row(2, 'harness.decision', 'decision', { kind: 'ROUTE', what: 'codex team', reason: 'default 95%', target: 'team' }),
      row(1, 'review-loop', 'judge-verdict', { runId: 'r', pr: '1', verdict: 'pass', round: 1 }),
    ], [], { now, windowMinutes: 60 });
    expect(board.stream.map((s) => s.what)).toEqual(['리뷰 판정: pass · #1', 'codex team']);
  });
});
