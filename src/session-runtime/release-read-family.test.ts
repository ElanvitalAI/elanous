import { expect, test } from 'bun:test';
import { CORE_TOOL_SPECS } from '../domains/core-tools.js';
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
    const names = buildSessionRuntimeToolSpecs({ userText: question, hostTools, rich: false }).map(spec => spec.name);
    expect(names).toContain('release_status');
    expect(names).toContain('context_now');
    expect(names).not.toContain('release_change');
    expect(names).not.toContain('coo_admin');
    expect(names).not.toContain('ops_seats');
    expect(names).not.toContain('decisions_pending');
    if (question === questions[4]) expect(names).toContain('ops_status');
  }
});

test('rich dynamic catalog opens release-read on each release question but not weather', () => {
  for (const question of questions) {
    const names = buildSessionRuntimeToolSpecs({ userText: question, hostTools }).map(spec => spec.name);
    expect(names).toContain('release_status');
    expect(names).toContain('context_now');
  }
  const weather = buildSessionRuntimeToolSpecs({ userText: '오늘 날씨 어때', hostTools }).map(spec => spec.name);
  expect(weather).not.toContain('release_status');
});
