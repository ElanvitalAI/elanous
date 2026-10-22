import { describe, expect, test } from 'bun:test';
import { detectImplPhase } from '../../src/impl-discipline/index.js';

describe('detectImplPhase — plan-loaded', () => {
  test('PLAN-*.md filename trigger', () => {
    expect(detectImplPhase({ text: 'docs/PLAN-session-m.md 읽어줘' }))
      .toBe('plan-loaded');
  });

  test('HANDOFF-*.md filename trigger', () => {
    expect(detectImplPhase({ text: 'HANDOFF-session-n.md 확인해' }))
      .toBe('plan-loaded');
  });

  test('SPEC-*.md filename trigger', () => {
    expect(detectImplPhase({ text: 'SPEC-api.md 보고 시작' }))
      .toBe('plan-loaded');
  });

  test('@file: attachment referencing a plan doc', () => {
    expect(detectImplPhase({ text: '@file:docs/PLAN-session-n.md 시작' }))
      .toBe('plan-loaded');
  });

  test('Korean 핸드오프 keyword (no filename)', () => {
    expect(detectImplPhase({ text: '핸드오프 따라 구현해줘' }))
      .toBe('plan-loaded');
  });

  test('English handoff keyword', () => {
    expect(detectImplPhase({ text: 'follow the handoff and implement' }))
      .toBe('plan-loaded');
  });

  test('plan-loaded wins over implementation-ready when both fire', () => {
    expect(detectImplPhase({ text: 'PLAN-session-m.md 따라 구현해' }))
      .toBe('plan-loaded');
  });

  test('case insensitive — lowercase filename', () => {
    expect(detectImplPhase({ text: 'plan-session-m.md 열어봐' }))
      .toBe('plan-loaded');
  });
});

describe('detectImplPhase — implementation-ready', () => {
  test('Korean 구현 verb', () => {
    expect(detectImplPhase({ text: '이 함수 구현해줘' }))
      .toBe('implementation-ready');
  });

  test('English implement verb', () => {
    expect(detectImplPhase({ text: 'implement the login flow' }))
      .toBe('implementation-ready');
  });

  test('build verb', () => {
    expect(detectImplPhase({ text: 'build a settings screen' }))
      .toBe('implementation-ready');
  });

  test('만들어 verb', () => {
    expect(detectImplPhase({ text: '버튼 하나 만들어줘' }))
      .toBe('implementation-ready');
  });

  test('포팅 verb', () => {
    expect(detectImplPhase({ text: '이 모듈 포팅해' }))
      .toBe('implementation-ready');
  });

  test('impl verb with leading whitespace', () => {
    expect(detectImplPhase({ text: '   구현 시작' }))
      .toBe('implementation-ready');
  });
});

describe('detectImplPhase — explicit new-project RFC boundary', () => {
  test('new repository implementation routes to design-first', () => {
    expect(detectImplPhase({ text: '새 저장소에 독서 앱을 만들어줘' }))
      .toBe('design-first');
    expect(detectImplPhase({ text: '빈 저장소에서 독서 앱 만들어줘' }))
      .toBe('design-first');
    expect(detectImplPhase({ text: '독서 앱을 처음부터 만들어줘' }))
      .toBe('design-first');
    expect(detectImplPhase({ text: '새 저장소에 이 앱을 포팅해줘' }))
      .toBe('design-first');
  });

  test('small code change remains immediate implementation', () => {
    expect(detectImplPhase({ text: '이 함수 구현해줘' }))
      .toBe('implementation-ready');
    expect(detectImplPhase({ text: '이 함수 처음부터 구현해줘' }))
      .toBe('implementation-ready');
  });
});

describe('detectImplPhase — idle', () => {
  test('empty string', () => {
    expect(detectImplPhase({ text: '' })).toBe('idle');
  });

  test('whitespace only', () => {
    expect(detectImplPhase({ text: '   \n  ' })).toBe('idle');
  });

  test('generic UI change request without impl verb', () => {
    expect(detectImplPhase({ text: '버튼 색 빨갛게 바꿔줘' })).toBe('idle');
  });

  test('analysis intent downgrades impl verb', () => {
    expect(detectImplPhase({ text: '이 함수 구현 방식 분석해줘' }))
      .toBe('idle');
  });

  test('review intent downgrades impl verb', () => {
    expect(detectImplPhase({ text: '이 구현 리뷰해봐' }))
      .toBe('idle');
  });

  test('explain downgrades implement', () => {
    expect(detectImplPhase({ text: 'explain how this implement works' }))
      .toBe('idle');
  });

  test('plain PLAN.md (no suffix) does NOT trigger plan-loaded', () => {
    expect(detectImplPhase({ text: 'PLAN.md 는 어디 있어?' }))
      .toBe('idle');
  });

  test('PLAN as substring in unrelated word', () => {
    expect(detectImplPhase({ text: 'planning 은 어떻게 해요?' }))
      .toBe('idle');
  });

  test('question about a function', () => {
    expect(detectImplPhase({ text: 'foo 함수가 뭐야?' }))
      .toBe('idle');
  });
});
