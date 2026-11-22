import { expect, test } from 'bun:test';
import { extractSessionProviderTurnConfig } from '../repl/session-provider-turn.js';

// TUI-NEXT-PROVIDER-FLAG-IGNORED (0.3.33 roster 2위 · HAND-ELN-ELS-API):
// `elanous --tui next --provider glm --model glm-5` 의 세션 선택이
// repl 턴에서 ELANOUS_NEXT_TUI_STREAM 게이트 뒤에 갇혀, 비-스트림 턴에선
// 무시되던 결함. 계산을 순수 함수로 뽑아내 두 경로 모두 적용을 단언.

const baseCfg = { llm: { provider: 'openai-codex', model: 'gpt-6-sol' } } as any;

test('sessionProvider applies regardless of the stream env gate', () => {
  // 스트림 자식(종전 적용 경로) — 회귀 보증
  const streamed = extractSessionProviderTurnConfig(
    baseCfg, { provider: 'glm', model: 'glm-5' }, true);
  expect(streamed.llm.provider).toBe('glm');
  expect(streamed.llm.model).toBe('glm-5');
  // 비-스트림 턴(결함 경로) — 게이트 없이 동일 적용
  const plain = extractSessionProviderTurnConfig(
    baseCfg, { provider: 'glm', model: 'glm-5' }, false);
  expect(plain.llm.provider).toBe('glm');
  expect(plain.llm.model).toBe('glm-5');
});

test('no sessionProvider leaves the config untouched on both paths', () => {
  expect(extractSessionProviderTurnConfig(baseCfg, undefined, true)).toBe(baseCfg);
  expect(extractSessionProviderTurnConfig(baseCfg, undefined, false)).toBe(baseCfg);
});
