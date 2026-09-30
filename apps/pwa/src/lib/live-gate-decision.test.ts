import { describe, expect, test } from 'bun:test';
import type { LogRow } from '@/nexus/client';
import { gateDecisionText } from './live-gate-decision';
import { buildLiveBoard } from './live-signals';

const gate = (name: string, decision: unknown, explanation = '') =>
  gateDecisionText(`execution-loop ${name} gate`, JSON.stringify({ decision, explanation }));

const now = Date.parse('2026-09-28T01:00:00.000Z');
const decisionRow = (what: string, reason: string, kind = 'PLAN'): LogRow => ({
  ts: new Date(now - 60_000).toISOString(), category: 'harness.decision', event: 'decision', level: 'debug',
  data: { what, reason, kind, target: 'card-1', runId: 'run-1' },
});

describe('gateDecisionText', () => {
  test('budget actions, next provider, first reason and account privacy', () => {
    for (const [action, label] of [
      ['proceed', '그대로 진행'], ['wait-reset', '한도 회복까지 대기'], ['stop', '멈춤'],
    ]) {
      expect(gate('budget', { action, reasons: ['한도 도달', '뒤 이유'] })).toEqual({ what: '관문 · 예산', why: `${label} · 한도 도달` });
    }
    expect(gate('budget', { action: 'next-provider', provider: 'grok', reasons: ['codex: private-account 95% ≥ 95'] }))
      .toEqual({ what: '관문 · 예산', why: '다른 제공자로(grok)' });
    expect(gate('budget', { action: 'next-provider', provider: 'grok', reasons: ['한도 도달'] }))
      .toEqual({ what: '관문 · 예산', why: '다른 제공자로(grok) · 한도 도달' });
    expect(gate('budget', { action: 'next-provider', provider: '/Users/private/key', reasons: ['/Users/private/key'] }))
      .toEqual({ what: '관문 · 예산', why: '다른 제공자로' });
  });

  test('placement renders validated pool names, local, unknown and memory limit', () => {
    expect(gate('placement', { substrate: 'pod', pool: 'fast-1', memory: { limit: '6GiB' }, localReasons: [] }))
      .toEqual({ what: '관문 · 장소', why: 'Pod fast-1 · 메모리 한도 6GiB' });
    expect(gate('placement', { substrate: 'pod', pool: 'pool-node-b@node-b:4' }))
      .toEqual({ what: '관문 · 장소', why: 'Pod pool-node-b@node-b:4' });
    expect(gate('placement', { substrate: 'pod', pool: 'alice' }))
      .toEqual({ what: '관문 · 장소', why: 'Pod' });
    expect(gate('placement', { substrate: 'pod', pool: '계정 123456789' }))
      .toEqual({ what: '관문 · 장소', why: 'Pod' });
    expect(gate('placement', { substrate: 'pod', pool: '/Users/private', memory: { limit: '/Users/private' } }))
      .toEqual({ what: '관문 · 장소', why: 'Pod' });
    expect(gate('placement', { substrate: 'pod', pool: null })).toEqual({ what: '관문 · 장소', why: 'Pod' });
    expect(gate('placement', { substrate: 'pod', pool: 'private-account' })).toEqual({ what: '관문 · 장소', why: 'Pod' });
    expect(gate('placement', { substrate: 'local', pool: null })).toEqual({ what: '관문 · 장소', why: '이 기기' });
    expect(gate('placement', { substrate: 'unknown', pool: null })).toEqual({ what: '관문 · 장소', why: '모름' });
  });

  test('relation counts overlaps without exposing identifiers; memory reports presence without content', () => {
    expect(gate('relation', { action: 'record', overlappingCards: [] })).toEqual({ what: '관문 · 관계', why: '겹치는 일 없음' });
    expect(gate('relation', { action: 'record', overlappingCards: ['card-1', '/Users/private'] }))
      .toEqual({ what: '관문 · 관계', why: '겹치는 카드 2개' });
    expect(gate('memory', { action: 'record', context: '/Users/private secret memory' }))
      .toEqual({ what: '관문 · 기억', why: '지난 기록 있음' });
    expect(gate('memory', { action: 'record', context: null })).toEqual({ what: '관문 · 기억', why: '지난 기록 없음' });
  });

  test('missing, malformed, unavailable and unknown decisions never display raw data', () => {
    for (const name of ['budget', 'placement', 'relation', 'memory']) {
      expect(gateDecisionText(`execution-loop ${name} gate`, '{"decision":')).toEqual({ what: expect.any(String), why: '확인 못 함' });
      expect(gate(name, '측정 불가', '측정 불가: /Users/private/account')).toEqual({ what: expect.any(String), why: '확인 못 함' });
      expect(gate(name, 'unavailable', '측정 불가: 시간 초과')).toEqual({ what: expect.any(String), why: '확인 못 함 · 측정 불가: 시간 초과' });
      expect(gate(name, {})).toEqual({ what: expect.any(String), why: '확인 못 함' });
    }
    expect(gate('budget', 'unavailable', '오'.repeat(100)))
      .toEqual({ what: '관문 · 예산', why: '확인 못 함' });
    expect(gate('budget', 'unavailable', '계정 123456789'))
      .toEqual({ what: '관문 · 예산', why: '확인 못 함' });
    expect(gate('budget', { action: 'proceed', reasons: ['계정 123456789'] }))
      .toEqual({ what: '관문 · 예산', why: '그대로 진행' });
    expect(gate('budget', { action: 'proceed', reasons: ['/Users/alice/private'] }))
      .toEqual({ what: '관문 · 예산', why: '그대로 진행' });
    expect(gate('budget', { action: 'proceed', reasons: ['{"account":"private"}'] }))
      .toEqual({ what: '관문 · 예산', why: '그대로 진행' });
    expect(gate('budget', { action: 'proceed', reasons: [`${'오'.repeat(80)}/Users/private`] }))
      .toEqual({ what: '관문 · 예산', why: '그대로 진행' });
    expect(gateDecisionText('execution-loop backup gate', '{}')).toBeNull();
    expect(gateDecisionText('ordinary decision', '{}')).toBeNull();
    for (const name of ['budget', 'placement', 'relation', 'memory']) {
      const result = gate(name, 'unavailable', '{"account":"private"}');
      expect(`${result?.what} ${result?.why}`).not.toContain('{"');
      expect(JSON.stringify(result)).not.toContain('/Users/');
    }
  });

  test('Live consumes gate copy, hides gate identifiers and preserves ordinary decisions', () => {
    const raw = JSON.stringify({ decision: { action: 'proceed', reasons: ['한도 도달'] }, explanation: '한도 도달' });
    const gateBoard = buildLiveBoard([decisionRow('execution-loop budget gate', raw)], [], { now, windowMinutes: 60 });
    expect(gateBoard.stream[0]).toMatchObject({ kind: 'PLAN', what: '관문 · 예산', why: '그대로 진행 · 한도 도달', target: null, runId: null });
    expect(`${gateBoard.stream[0]?.what} ${gateBoard.stream[0]?.why}`).not.toContain('{"');
    const ordinary = buildLiveBoard([decisionRow('기존 판단', raw)], [], { now, windowMinutes: 60 });
    expect(ordinary.stream[0]).toMatchObject({ kind: 'PLAN', what: '기존 판단', why: raw, target: 'card-1', runId: 'run-1' });
  });

  test('gate rows do not leak account or path through any other Live board field', () => {
    const account = 'private-account-987654321';
    const path = '/Users/private-account-987654321/work';
    const rows = [
      { name: 'budget', decision: { action: 'next-provider', provider: account, reasons: [path] } },
      { name: 'placement', decision: { substrate: 'pod', pool: account, memory: { limit: path } } },
      { name: 'relation', decision: { action: 'record', overlappingCards: [account] } },
      { name: 'memory', decision: { action: 'record', context: path } },
      { name: 'budget', decision: 'unavailable' },
    ].map(({ name, decision }) => ({
      ...decisionRow(`execution-loop ${name} gate`, JSON.stringify({ decision, explanation: path })),
      event: account,
      data: {
        kind: name === 'placement' ? 'ROUTE' : 'PLAN',
        what: `execution-loop ${name} gate`,
        reason: JSON.stringify({ decision, explanation: path }),
        account, target: name === 'memory' ? undefined : account,
        to: name === 'memory' ? undefined : path, purpose: path, runId: account, paths: 2,
      },
    }));
    const board = buildLiveBoard(rows, [], { now, windowMinutes: 60 });
    expect(board.stream).toHaveLength(rows.length);
    for (const line of board.stream) {
      expect(line).toMatchObject({ purpose: null, target: null, runId: null, paths: 2 });
    }
    const output = JSON.stringify(board);
    expect(output).not.toContain(account);
    expect(output).not.toContain('/Users/');
  });
});

describe('truncated reasons from the log store (≈250 chars · «+Nc»)', () => {
  // Real prefixes observed on the production log 2026-09-30 00:11 (TZ4 launch).
  const placement = '{"decision":{"substrate":"unknown","pool":null,"source":"unknown","poolReachability":"unknown","localReasons":[],"unknownInputs":["needsBrowser","needsVideo","needsAppSigning","localFiles","substrate"]},"explanation":"placement=unknown; unmeasured=needsBro«+89c»';
  const relation = '{"decision":{"action":"record","overlappingCards":[],"preflightOverlaps":"unknown","dependsOn":"unknown","similarCards":"unknown","sameGoalActiveRuns":"unknown"},"explanation":"overlap=none; preflight=unknown; dependsOn=unknown; similar=unknown; active=unk«+51c»';
  const memory = '{"decision":{"action":"record","context":"[elanous 기억 — 참조 컨텍스트]\\n- [memory source=surface-events; kind=utterance] <task-notification>\\n<task-id>x</task-id>«+1212c»';
  test('known leading fields are recovered instead of «확인 못 함»', () => {
    expect(gateDecisionText('execution-loop placement gate', placement)).toEqual({ what: '관문 · 장소', why: '모름' });
    expect(gateDecisionText('execution-loop relation gate', relation)).toEqual({ what: '관문 · 관계', why: '겹치는 일 없음' });
    expect(gateDecisionText('execution-loop memory gate', memory)).toEqual({ what: '관문 · 기억', why: '지난 기록 있음' });
  });
  test('recovered text never carries the raw payload', () => {
    for (const [name, raw] of [['placement', placement], ['relation', relation], ['memory', memory]] as const) {
      const out = gateDecisionText(`execution-loop ${name} gate`, raw)!;
      expect(out.why).not.toContain('{');
      expect(out.why).not.toContain('task-notification');
    }
  });
  test('garbage still reads as «확인 못 함»', () => {
    expect(gateDecisionText('execution-loop relation gate', 'not json «+3c»')?.why).toBe('확인 못 함');
  });
});

describe('short summary reasons (#22024 · `gate-decision-summary.ts`)', () => {
  test('each gate summary reads as plain words', () => {
    expect(gateDecisionText('execution-loop budget gate', 'action=next-provider · provider=grok · reason=codex: default 100%·team 100% ≥ 95'))
      .toEqual({ what: '관문 · 예산', why: '다른 제공자로(grok)' });
    expect(gateDecisionText('execution-loop placement gate', 'substrate=pod · pool=pool-node-b@node-b:8 · memory=32Gi · unknown=needsBrowser'))
      .toEqual({ what: '관문 · 장소', why: 'Pod pool-node-b@node-b:8 · 메모리 한도 32Gi' });
    expect(gateDecisionText('execution-loop placement gate', 'substrate=unknown · pool=none · unknown=needsBrowser,substrate'))
      .toEqual({ what: '관문 · 장소', why: '모름' });
    expect(gateDecisionText('execution-loop relation gate', 'overlap=0 · unknown=preflightOverlaps,dependsOn'))
      .toEqual({ what: '관문 · 관계', why: '겹치는 일 없음' });
    expect(gateDecisionText('execution-loop relation gate', 'overlap=2 · unknown='))
      .toEqual({ what: '관문 · 관계', why: '겹치는 카드 2개' });
    expect(gateDecisionText('execution-loop memory gate', 'context=recalled · fragments=0'))
      .toEqual({ what: '관문 · 기억', why: '지난 기록 있음' });
    expect(gateDecisionText('execution-loop memory gate', 'context=none · fragments=0'))
      .toEqual({ what: '관문 · 기억', why: '지난 기록 없음' });
  });
  test('unavailable and malformed summaries stay «확인 못 함»', () => {
    expect(gateDecisionText('execution-loop memory gate', 'unavailable')?.why).toBe('확인 못 함');
    expect(gateDecisionText('execution-loop budget gate', 'unavailable · explanation=timeout after 1500ms')?.why).toBe('확인 못 함');
    expect(gateDecisionText('execution-loop relation gate', 'overlap=lots')?.why).toBe('확인 못 함');
  });
});
