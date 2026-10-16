// failure-ledger — C4 실패 조사 원장(Waza 차용 B) 테스트. Capsule 나침반 대비·shouldHandoff·순수 고정.
// [[RFC-plan-as-rfc-generation-2026-07-22]] §8 C4. 골루프-우선: 원장은 진단(렌즈)·제어흐름 무접촉.

import { describe, test, expect } from 'bun:test';
import { openInvestigation, shouldHandoff, renderLedger, HANDOFF_THRESHOLD, type FailureInvestigation, type OpenInvestigationInput } from './failure-ledger.js';
import { buildHarnessCapsuleFromPlan } from './plan-sizing.js';

const AT = '2026-07-23T00:00:00.000Z';
const cap = buildHarnessCapsuleFromPlan({ objective: 'o', steps: ['s'], createdAt: AT, successCriteria: ['A 완주', 'B 검증'] });

const inv = (over: Partial<OpenInvestigationInput> = {}): FailureInvestigation => openInvestigation({
  stage: 'review', attempt: 1, symptoms: ['finding X'], hypothesis: 'h', probe: 'p',
  expectedIfTrue: 'e', observed: 'o', verdict: 'inconclusive', ...over,
});

describe('openInvestigation — Capsule 나침반 대비 조사 생성', () => {
  test('capsule 있으면 unmetCriteria 를 successCriteria(C2 인터뷰)에서 채움', () => {
    const i = inv({ capsule: cap });
    expect(i.unmetCriteria).toEqual(['A 완주', 'B 검증']);
  });
  test('capsule 없으면 unmetCriteria 빈 배열(날조 없음)', () => {
    expect(inv().unmetCriteria).toEqual([]);
  });
  test('Waza B 전체 필드 보존(expectedIfTrue/observed 포함)', () => {
    const i = inv({ expectedIfTrue: 'ok=false', observed: 'ok=true', verdict: 'refuted' });
    expect(i.expectedIfTrue).toBe('ok=false');
    expect(i.observed).toBe('ok=true');
    expect(i.verdict).toBe('refuted');
  });
});

describe('shouldHandoff — Waza Hunt "세 가설 뒤 handoff"(순수·판정만)', () => {
  test(`엔트리 < ${HANDOFF_THRESHOLD} → false(아직 시도 여지)`, () => {
    expect(shouldHandoff([inv(), inv()])).toBe(false);
  });
  test('최근 3개 모두 미지지(refuted/inconclusive) → true(벽 신호)', () => {
    expect(shouldHandoff([inv({ verdict: 'refuted' }), inv({ verdict: 'inconclusive' }), inv({ verdict: 'refuted' })])).toBe(true);
  });
  test('최근 3개 중 하나라도 supported → false(진전 있음·자르지 않음)', () => {
    expect(shouldHandoff([inv({ verdict: 'refuted' }), inv({ verdict: 'supported' }), inv({ verdict: 'inconclusive' })])).toBe(false);
  });
});

describe('renderLedger — handoff 번들 요약', () => {
  test('가설·verdict·미충족 성공기준 렌더', () => {
    const s = renderLedger([inv({ capsule: cap, hypothesis: '리뷰 미통과 — null 체크 누락', verdict: 'supported' })]);
    expect(s).toContain('실패 조사 원장');
    expect(s).toContain('null 체크 누락');
    expect(s).toContain('A 완주');   // 미충족 성공기준(나침반)
  });
  test('빈 원장 → 빈 문자열', () => {
    expect(renderLedger([])).toBe('');
  });
  test('조사 >3 누적 시 전체 렌더(앞쪽 누락 없음·건수 헤더·ACP review #5197)', () => {
    const many = [inv({ hypothesis: 'h1' }), inv({ hypothesis: 'h2' }), inv({ hypothesis: 'h3' }), inv({ hypothesis: 'h4' })];
    const s = renderLedger(many);
    expect(s).toContain('(4건)');
    expect(s).toContain('h1');   // 앞쪽 조사도 유지(종전엔 최근 3건만 → 누락)
    expect(s).toContain('h4');
  });

  test('보존 스냅샷 — renderLedger 출력 형식은 지금과 같다(전문 고정)', () => {
    const ledger = [
      inv({ stage: 'execute', attempt: 2, hypothesis: '원인 A', probe: '게이트 통과?', observed: '통과', verdict: 'supported', capsule: cap }),
      inv({ hypothesis: '원인 B', verdict: 'refuted' }),
    ];
    expect(renderLedger(ledger)).toBe([
      '[실패 조사 원장 (2건) — 무슨 가설을 무슨 probe 가 어떻게 판정했나]',
      '- [execute r2·supported] 원인 A (probe: 게이트 통과? → 통과)',
      '- [review r1·refuted] 원인 B (probe: p → o)',
      '미충족 성공기준: A 완주 · B 검증',
    ].join('\n'));
  });
});
