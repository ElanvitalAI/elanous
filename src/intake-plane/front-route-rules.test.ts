import { expect, test } from 'bun:test';
import {
  INTAKE_FRONT_ROUTE_RULES,
  decideIntakeFrontRoute,
} from './front-route-rules.js';

const ROUTE = { consent: 'route' as const };

test('URL 만 있으면 absorb', () => {
  const decision = decideIntakeFrontRoute({ text: 'https://youtu.be/x', ...ROUTE });
  expect(decision.track).toBe('absorb');
  expect(decision.decidedBy).toBe('rule');
  expect(decision.confidence).toBeGreaterThanOrEqual(0);
  expect(decision.confidence).toBeLessThanOrEqual(1);
});

test('URL 과 흡수류 낱말만 있으면 absorb', () => {
  const decision = decideIntakeFrontRoute({ text: '이거 정리해줘 https://a.example', ...ROUTE });
  expect(decision.track).toBe('absorb');
  expect(decision.decidedBy).toBe('rule');
});

test('구현 동사와 github URL 이 함께면 graph · decidedBy rule', () => {
  const decision = decideIntakeFrontRoute({
    text: '이 저장소 보고 구현해줘 https://github.com/a/b',
    ...ROUTE,
  });
  expect(decision.track).toBe('graph');
  expect(decision.decidedBy).toBe('rule');
});

test('URL 없이 구현류 낱말로 끝나는 명령은 graph', () => {
  const decision = decideIntakeFrontRoute({ text: '로그인 버튼 추가해줘', ...ROUTE });
  expect(decision.track).toBe('graph');
  expect(decision.decidedBy).toBe('rule');
});

test('4줄 체크리스트는 tasks', () => {
  const text = ['- 하나', '- 둘', '* 셋', '[ ] 넷'].join('\n');
  const decision = decideIntakeFrontRoute({ text, ...ROUTE });
  expect(decision.track).toBe('tasks');
  expect(decision.decidedBy).toBe('rule');
  expect(decision.reason).toBe('list');
});

test('규칙이 모르는 글은 ask-human · reason rule-unknown', () => {
  const decision = decideIntakeFrontRoute({ text: '오늘 날씨 어때', ...ROUTE });
  expect(decision.track).toBe('ask-human');
  expect(decision.reason).toBe('rule-unknown');
  expect(decision.decidedBy).toBe('rule');
});

test("hint:'tasks' 는 규칙보다 앞선다", () => {
  const decision = decideIntakeFrontRoute({
    text: '오늘 날씨 어때',
    hint: 'tasks',
    ...ROUTE,
  });
  expect(decision.track).toBe('tasks');
  expect(decision.decidedBy).toBe('human');
  expect(decision.confidence).toBe(1);
});

test('consent 없이도 https://youtu.be/x 는 absorb', () => {
  const decision = decideIntakeFrontRoute({ text: 'https://youtu.be/x' });
  expect(decision.track).toBe('absorb');
  expect(decision.reason).toBe('url-only');
  expect(decision.decidedBy).toBe('rule');
});

test('consent 없이도 구현 미션은 graph', () => {
  const decision = decideIntakeFrontRoute({ text: '이 저장소 보고 구현해줘 https://github.com/a/b' });
  expect(decision.track).toBe('graph');
  expect(decision.reason).toBe('url-implement');
  expect(decision.decidedBy).toBe('rule');
});

test('consent 가 route 가 아니면 분류기를 부르지 않고 ask-human', () => {
  const decision = decideIntakeFrontRoute({ text: '오늘 날씨 어때' });
  expect(decision.track).toBe('ask-human');
  expect(decision.reason).toBe(INTAKE_FRONT_ROUTE_RULES.missingConsentReason);
  expect(decision.decidedBy).toBe('rule');
});

test('규칙이 답하는 입력은 consent 값과 관계없이 같다', () => {
  const text = '로그인 버튼 추가해줘';
  const without = decideIntakeFrontRoute({ text });
  const withRoute = decideIntakeFrontRoute({ text, consent: 'route' });
  expect(without).toEqual(withRoute);
  expect(without.track).toBe('graph');
});

test('같은 입력은 같은 출력', () => {
  const input = { text: '로그인 버튼 추가해줘', consent: 'route' };
  expect(decideIntakeFrontRoute(input)).toEqual(decideIntakeFrontRoute(input));
});
