import { expect, test } from 'bun:test';
import * as secondOrderModule from './second-order.js';
import {
  SECOND_ORDER_LENS,
  applySecondOrderLens,
  buildSecondOrderResultChain,
  detectSecondOrderTrigger,
} from './second-order.js';

const DECISION_QUESTION = '우리 팀이 다음 분기에 세일즈포스로 전환해야 할까?';
const FORECAST_QUESTION = '2027년 반도체 수출 규모는 얼마나 늘어날까?';
const OPEN_QUESTION = 'RFC-PRO §2 의 T2 렌즈는 무엇을 정의하는가?';

const SYNTHESIS = [
  '기존 계약 잔여 기간과 전환 비용을 확정한다.',
  '영업 생산성의 현재 기준선을 측정한다.',
  '전환 6개월 뒤 파이프라인 회전이 개선되는지 본다.',
  '재교육 부담으로 초기 생산성이 하락하는지 본다.',
  '2년차에 영업비용이 감소하는지 확인한다.',
  '3년차 계약 재협상에서 단가 우위가 유지되는지 확인한다.',
];

test('lens definition declares the T2 cell and the three chain orders', () => {
  expect(SECOND_ORDER_LENS.id).toBe('second-order');
  expect(SECOND_ORDER_LENS.cell).toBe('THINK-LENS-T2-SECOND-ORDER');
  expect(SECOND_ORDER_LENS.tier).toBe('T2');
  expect(SECOND_ORDER_LENS.rfc).toBe('RFC-PRO §2');
  expect(SECOND_ORDER_LENS.stages.map(stage => stage.order)).toEqual(['primary', 'secondary', 'tertiary']);
  expect(SECOND_ORDER_LENS.stages.map(stage => stage.label)).toEqual(['1차 결과', '2차 결과', '3차 결과']);
  expect(SECOND_ORDER_LENS.stages.map(stage => stage.horizonDays)).toEqual([30, 180, 540]);
});

test('a decision question triggers the lens as a decision question', () => {
  const trigger = detectSecondOrderTrigger(DECISION_QUESTION);

  expect(trigger.triggered).toBe(true);
  expect(trigger.kind).toBe('decision');
  expect(trigger.score).toBe(1);
  expect(trigger.matchedSignals).toContain('decision-form');
  expect(trigger.reason.length).toBeGreaterThan(0);
});

test('a forecast question triggers the lens as a forecast question', () => {
  const trigger = detectSecondOrderTrigger(FORECAST_QUESTION);

  expect(trigger.triggered).toBe(true);
  expect(trigger.kind).toBe('forecast');
  expect(trigger.matchedSignals).toContain('forecast-form');
  expect(detectSecondOrderTrigger('Will demand increase next year?')).toMatchObject({ triggered: true, kind: 'forecast' });
});

test('decision wording inside an explanatory sentence does not trigger the lens', () => {
  expect(detectSecondOrderTrigger('The memo asks should we invest, then lists the risks.'))
    .toMatchObject({ triggered: false, kind: 'none' });
});

test('a current-cost question is not a forecast but a future-cost question is', () => {
  expect(detectSecondOrderTrigger('How much does the suite cost to run?').triggered).toBe(false);
  expect(detectSecondOrderTrigger('How much will the suite cost to run?')).toMatchObject({ triggered: true, kind: 'forecast' });
});

test('a question that is neither a decision nor a forecast does not trigger the lens', () => {
  const korean = detectSecondOrderTrigger(OPEN_QUESTION);
  const english = detectSecondOrderTrigger('What does the second-order lens define?');

  expect(korean.triggered).toBe(false);
  expect(korean.kind).toBe('none');
  expect(korean.matchedSignals).toEqual([]);
  expect(english.triggered).toBe(false);
  expect(english.kind).toBe('none');
});

test('an empty question is rejected instead of silently not triggering', () => {
  expect(() => detectSecondOrderTrigger(' \n ')).toThrow('question must not be empty');
});

test('generic decision nouns do not trigger the lens without a decision question form', () => {
  for (const question of ['투자란 무엇인가?', '전환 비용이란?', '선택의 기준은 무엇인가?', '결정 이론을 설명해줘']) {
    expect(detectSecondOrderTrigger(question), question).toMatchObject({ triggered: false, kind: 'none' });
  }
});

test('the public module exposes no private trigger calibration surface', () => {
  expect(Object.keys(secondOrderModule)).not.toContain('openSecondOrderProSurface');
  expect(Object.keys(secondOrderModule).filter(key => /weight|threshold/i.test(key))).toEqual([]);
});

test('a host can inject its own trigger classifier without exposing calibration data in the public module', () => {
  const injected = applySecondOrderLens({ question: OPEN_QUESTION, synthesis: SYNTHESIS }, () => ({
    triggered: true, kind: 'decision', score: 1, matchedSignals: ['host-classifier'], reason: 'host policy',
  }));
  expect(injected.chain?.nodes).toHaveLength(6);
  expect(injected.trigger.matchedSignals).toEqual(['host-classifier']);
});

test('a decision question expands six synthesis steps into a primary to secondary to tertiary chain', () => {
  const chain = buildSecondOrderResultChain({ question: DECISION_QUESTION, synthesis: SYNTHESIS });

  expect(chain.lensId).toBe(SECOND_ORDER_LENS.id);
  expect(chain.question).toBe(DECISION_QUESTION);
  expect(chain.nodes.map(node => node.order)).toEqual([
    'primary', 'primary', 'secondary', 'secondary', 'tertiary', 'tertiary',
  ]);
  expect(chain.nodes.filter(node => node.order === 'primary').map(node => node.statement))
    .toEqual(SYNTHESIS.slice(0, 2).map(step => `1차 가설: ${step}`));
  expect(chain.nodes.filter(node => node.order === 'tertiary').every(node => node.statement.startsWith('3차 가설:'))).toBe(true);
  expect(new Set(chain.nodes.map(node => node.id)).size).toBe(chain.nodes.length);
  expect(chain.nodes.filter(node => node.order === 'primary').map(node => node.horizonDays)).toEqual([30, 30]);
  expect(chain.nodes.filter(node => node.order === 'tertiary').map(node => node.horizonDays)).toEqual([540, 540]);
});

test('every chain node declares which earlier nodes it derives from', () => {
  const chain = buildSecondOrderResultChain({ question: DECISION_QUESTION, synthesis: SYNTHESIS });
  const idsOf = (order: string) => chain.nodes.filter(node => node.order === order).map(node => node.id);

  expect(chain.nodes.filter(node => node.order === 'primary').every(node => node.derivedFrom.length === 0)).toBe(true);
  expect(chain.nodes.filter(item => item.order === 'secondary').map(node => [...node.derivedFrom]))
    .toEqual([['primary-1'], ['primary-2']]);
  expect(chain.nodes.filter(item => item.order === 'tertiary').map(node => [...node.derivedFrom]))
    .toEqual([['secondary-1'], ['secondary-2']]);
  expect(idsOf('primary')).toEqual(['primary-1', 'primary-2']);
});

test('a secondary effect without an evidence-backed measure stays unmeasured and is not called falsifiable', () => {
  const chain = buildSecondOrderResultChain({ question: DECISION_QUESTION, synthesis: SYNTHESIS });
  const secondary = chain.nodes.filter(node => node.order === 'secondary');

  expect(secondary.length).toBe(2);
  for (const node of secondary) {
    expect(node.verification).not.toBeNull();
    const verification = node.verification!;
    expect(verification.claim).toBe(node.statement);
    expect(verification.metric).toBeNull();
    expect(verification.scenarioCondition).toBeNull();
    expect(verification.expectedValue).toBeNull();
    expect(verification.threshold).toBeNull();
    expect(verification.unit).toBeNull();
    expect(verification.measurementStatus).toBe('unmeasured');
    expect(verification.falsifiable).toBeNull();
  }

  const first = secondary[0]!.verification!;
  expect(first.expectedValue).toBeNull();
  expect(first.threshold).toBeNull();
  expect(first.windowDays).toBe(90);
  expect(secondary[1]!.verification!.expectedValue).toBeNull();
  expect(secondary[1]!.verification!.windowDays).toBe(180);

  expect(chain.nodes.filter(node => node.order !== 'secondary').every(node => node.verification === null)).toBe(true);
});

test('evidence facts produce distinct hypotheses, explicit edges, and evidence-specific verification targets', () => {
  const evidenceFacts = [
    { questionId: 'q1', question: '계약 구조는?', content: '기존 계약 잔여 기간은 중앙값 14개월이다.', source: 'fixture:contracts', outcome: 'complete' as const },
    { questionId: 'q2', question: '정리 비용은?', content: 'CRM 중복 레코드는 16%이며 정리 비용이 발생한다.', source: 'fixture:crm-audit', outcome: 'complete' as const },
    { questionId: 'q3', question: '시범 지표는?', content: '파일럿에서 리드 응답시간 중앙값이 5시간에서 3시간으로 단축됐다.', source: 'fixture:pilot-a', outcome: 'complete' as const, observedWindow: '파일럿 전' },
    { questionId: 'q4', question: '교육 영향은?', content: '교육 4주 동안 첫달 리드 처리량이 10% 감소했다.', source: 'fixture:pilot-b', outcome: 'complete' as const },
    { questionId: 'q5', question: '장기 전환은?', content: '2년차 영업비용 감소 여부는 아직 측정되지 않았다.', source: 'fixture:forecast-a', outcome: 'complete' as const },
    { questionId: 'q6', question: '갱신 조건은?', content: '3년차 재계약 단가 변화 자료가 없다.', source: 'fixture:forecast-b', outcome: 'complete' as const },
  ];
  const chain = buildSecondOrderResultChain({
    question: DECISION_QUESTION,
    synthesis: SYNTHESIS,
    synthesisQuestionIds: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'],
    evidenceFacts,
  });
  const secondary = chain.nodes.filter(node => node.order === 'secondary');

  expect(chain.nodes.every(node => node.statement !== DECISION_QUESTION)).toBe(true);
  expect(chain.nodes[0]!.statement).toContain('기존 계약 잔여 기간은 중앙값 14개월');
  expect(chain.nodes[2]!.statement).toContain('리드 응답시간 중앙값이 5시간에서 3시간');
  expect(chain.nodes[2]!.derivedFrom).toEqual(['primary-1']);
  expect(chain.nodes[4]!.statement).toContain('영업비용 감소 여부');
  expect(secondary[0]!.verification).toMatchObject({
    metric: '응답시간',
    scenarioCondition: expect.stringContaining('응답시간'),
    evidenceSource: 'fixture:pilot-a',
    falsifiable: null,
    measurementStatus: 'needs-operationalization',
  });
  expect(secondary[1]!.verification).toMatchObject({
    metric: '처리량',
    evidenceSource: 'fixture:pilot-b',
    falsifiable: null,
  });
});

test('the chain generator refuses a synthesis that cannot fill three orders', () => {
  expect(() => buildSecondOrderResultChain({ question: DECISION_QUESTION, synthesis: ['하나', '둘'] }))
    .toThrow('at least three steps');
  expect(() => buildSecondOrderResultChain({ question: DECISION_QUESTION, synthesis: ['하나', ' ', '셋'] }))
    .toThrow('synthesis[1] must not be empty');
});

test('applying the lens returns the chain for a decision question and no chain otherwise', () => {
  const applied = applySecondOrderLens({ question: DECISION_QUESTION, synthesis: SYNTHESIS });

  expect(applied.lens).toBe(SECOND_ORDER_LENS);
  expect(applied.trigger.triggered).toBe(true);
  expect(applied.chain?.nodes.length).toBe(6);

  const skipped = applySecondOrderLens({ question: OPEN_QUESTION, synthesis: [] });

  expect(skipped.trigger.triggered).toBe(false);
  expect(skipped.chain).toBeNull();
  expect(skipped.lens).toBe(SECOND_ORDER_LENS);
});
