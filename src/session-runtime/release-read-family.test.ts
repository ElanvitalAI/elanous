import { expect, test } from 'bun:test';
import { CORE_TOOL_SPECS } from '../domains/core-tools.js';
import { classifyTuiChatIntent } from '../core-turn/short-question.js';
import { buildSessionRuntimeToolSpecs } from './index.js';

const hostTools = CORE_TOOL_SPECS.map(spec => ({ ...spec, handler: async () => ({}) }));
const questions = [
  '현재 버전 발행 상태와 0.2.23 피처 알려줘',
  '0.2.24 피처 뭐 있어',
  'TUI-OPS-QA 칸 상태 어때',
  '다음 판 컷 언제야',
  '지금 운영 상태 어때',
];

// All core specs are available as actual host definitions, not merely string mentions in the prompt.
test('TUI essential catalog always exposes release_status and context_now for all five questions', () => {
  for (const question of questions) {
    const names = buildSessionRuntimeToolSpecs({ userText: question, hostTools }).map(spec => spec.name);
    expect(names).toContain('release_status');
    expect(names).toContain('context_now');
    expect(names).not.toContain('release_change');
    expect(names).not.toContain('coo_admin');
    expect(names).not.toContain('ops_seats');
    expect(names).not.toContain('decisions_pending');
    if (question === questions[4]) expect(names).toContain('ops_status');
  }
});

test('TUI exposes owner-read tools only for matching lookup intents', () => {
  const decisionQuestion = '나한테 온 결정 카드 있어?';
  const pendingQuestion = '결정 대기 있어?';
  const seatQuestion = '지금 자리별 현황 알려줘';
  const englishDecisionQuestion = 'Pending Decision?';
  const writeRequest = '결정 카드 만들어줘';
  const unrelatedApprovalQuestion = '승인 대기 상태 알려줘';
  expect(classifyTuiChatIntent(decisionQuestion).route).toBe('조회');
  expect(classifyTuiChatIntent(pendingQuestion).route).toBe('조회');
  expect(classifyTuiChatIntent(seatQuestion).route).toBe('조회');
  expect(classifyTuiChatIntent(englishDecisionQuestion).route).toBe('조회');
  expect(classifyTuiChatIntent(writeRequest).route).toBe('코딩·구현');
  const decisionCatalog = buildSessionRuntimeToolSpecs({ userText: decisionQuestion, hostTools });
  const pendingDecisions = buildSessionRuntimeToolSpecs({ userText: pendingQuestion, hostTools }).map(spec => spec.name);
  const seatCatalog = buildSessionRuntimeToolSpecs({ userText: seatQuestion, hostTools });
  const decisions = decisionCatalog.map(spec => spec.name);
  const seats = seatCatalog.map(spec => spec.name);
  const englishDecisions = buildSessionRuntimeToolSpecs({ userText: englishDecisionQuestion, hostTools }).map(spec => spec.name);
  const write = buildSessionRuntimeToolSpecs({ userText: writeRequest, hostTools }).map(spec => spec.name);
  expect(classifyTuiChatIntent(unrelatedApprovalQuestion).route).toBe('조회');
  const unrelatedApproval = buildSessionRuntimeToolSpecs({ userText: unrelatedApprovalQuestion, hostTools }).map(spec => spec.name);
  const unavailableSeats = buildSessionRuntimeToolSpecs({
    userText: seatQuestion, hostTools, toolAvailability: { ops_seats: false },
  }).map(spec => spec.name);
  const generic = buildSessionRuntimeToolSpecs({ userText: '안녕하세요', hostTools }).map(spec => spec.name);

  expect(decisions).toContain('decisions_pending');
  expect(pendingDecisions).toContain('decisions_pending');
  expect(decisionCatalog.find(spec => spec.name === 'decisions_pending')?.parameters)
    .toEqual(CORE_TOOL_SPECS.find(spec => spec.name === 'decisions_pending')?.parameters);
  expect(decisions).not.toContain('ops_seats');
  expect(englishDecisions).toContain('decisions_pending');
  expect(seats).toContain('ops_seats');
  expect(seatCatalog.find(spec => spec.name === 'ops_seats')?.parameters)
    .toEqual(CORE_TOOL_SPECS.find(spec => spec.name === 'ops_seats')?.parameters);
  expect(seats).not.toContain('decisions_pending');
  expect(write).not.toContain('decisions_pending');
  expect(write).not.toContain('ops_seats');
  expect(unrelatedApproval).not.toContain('decisions_pending');
  expect(unavailableSeats).not.toContain('ops_seats');
  expect(generic).not.toContain('ops_seats');
  expect(generic).not.toContain('decisions_pending');
});

// TUI-DIET-D1-TAIL — the «rich dynamic catalog» case was removed with the legacy catalog branch it guarded.
