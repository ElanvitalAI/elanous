// COMPACT P0 경계 수리(JUD-B #124147 · OP #124161) — overflow drop-oldest 재시도가
// 사람 user 행을 지우지 않는다.
//
// 결함: compactSessionHistory 의 «첫 요약 null 뒤 재시도»가 preserve 창밖 가장 오래된
// 비-system 행을 working 에서 빼는데, 그 행이 사람 user 지시면 원문 보존 계약
// (OP #123867)이 깨진다 — 재시도가 성공하면 저장까지 이어져 지시가 영구 소실된다.
//
// 수리 계약(OP #124161): 재시도는 assistant·tool_result 캐리어 행만 줄인다.
// drop 후보가 사람 user 행뿐이면 흘리지 않고 no-op 로 끝난다(보존이 압축 성공보다 우선).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_DEFAULTS } from '../user-config/chat.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import type { CompactProvider } from '../compact/provider.js';
import { appendMessage, createSession, loadSession, type SerializedMessage } from './index.js';
import { compactSessionHistory } from './compact-session.js';
import { isHumanUserMessage } from '../compact/pipeline.js';
import type { LLMMessage } from '../llm.js';

const roots: string[] = [];
afterEach(() => { resetAutoCompactStateForTest(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const baseProvider: CompactProvider = {
  async summarize(args) { return { summary: '요약(지시 언급 없음).', sourceMessageCount: args.messages.length }; },
  getContextWindow: () => 32000,
  getAutoCompactThreshold: () => 0.8,
};

const DIRECTIVE_1 = '지시① force push 전면 금지 — 조각 수리는 일반 push 만.';
const DIRECTIVE_2 = '지시② 영수증 통과 수는 명령 원문과 출력 줄을 그대로.';
const DIRECTIVE_3 = '지시③ 시험 결과는 실제 실행한 명령과 그 출력 그대로만 기술.';

function userTextsOf(rows: readonly SerializedMessage[]): string[] {
  return rows.filter(r => r.role === 'user').map(r => r.content);
}

test('overflow 재시도(첫 요약 null)는 사람 user 지시를 지우지 않는다 — assistant 행만 줄인다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'compact-user-overflow-')); roots.push(root);
  const session = createSession({ source: 'tui', model: 'test' }, root);
  const add = (row: SerializedMessage) => appendMessage(session.id, row, root);
  // preserve 창밖 가장 오래된 행 = 사람 user 지시① — 구 dropOldestIndex 는 이 행부터 뺀다.
  add({ role: 'user', content: DIRECTIVE_1, ts: '1' });
  add({ role: 'assistant', content: '수령 확인.', ts: '2' });
  add({ role: 'user', content: DIRECTIVE_2, ts: '3' });
  add({ role: 'assistant', content: '수령 확인.', ts: '4' });
  add({ role: 'user', content: 'tail 요청', ts: '5' });
  add({ role: 'assistant', content: 'tail 응답', ts: '6', replyFinal: true });
  let calls = 0;
  const overflowProvider: CompactProvider = {
    ...baseProvider,
    async summarize(args) {
      calls += 1;
      return calls === 1 ? null : { summary: '요약(지시 언급 없음).', sourceMessageCount: args.messages.length };
    },
  };
  const result = await compactSessionHistory(session.id, {
    root, config: { ...CHAT_DEFAULTS.autoCompact, preserveLastN: 2 }, force: true, provider: overflowProvider,
  });
  expect(result.overflowRetries).toBe(1);
  expect(result.fired).toBe(true);
  const after = loadSession(session.id, root)!.messages;
  const userTexts = userTextsOf(after);
  expect(userTexts.includes(DIRECTIVE_1)).toBe(true);
  expect(userTexts.includes(DIRECTIVE_2)).toBe(true);
});

test('drop 후보가 사람 user 행뿐이면 흘리지 않고 즉시 no-op — overflowRetries 0·원문 무결', async () => {
  const root = mkdtempSync(join(tmpdir(), 'compact-user-exhaust-')); roots.push(root);
  const session = createSession({ source: 'tui', model: 'test' }, root);
  const add = (row: SerializedMessage) => appendMessage(session.id, row, root);
  add({ role: 'user', content: DIRECTIVE_1, ts: '1' });
  add({ role: 'user', content: DIRECTIVE_2, ts: '2' });
  add({ role: 'user', content: DIRECTIVE_3, ts: '3' });
  add({ role: 'assistant', content: 'tail 응답', ts: '4', replyFinal: true });
  const nullProvider: CompactProvider = { ...baseProvider, async summarize() { return null; } };
  const result = await compactSessionHistory(session.id, {
    root, config: { ...CHAT_DEFAULTS.autoCompact, preserveLastN: 1 }, force: true, provider: nullProvider,
  });
  expect(result.fired).toBe(false);
  // 구 코드는 사람 user 3행을 연달아 흘려 maxRetries(3) 까지 간다 — 계약 위반의 직접 증거.
  expect(result.overflowRetries).toBe(0);
  const after = loadSession(session.id, root)!.messages;
  expect(after).toHaveLength(4);
  for (const d of [DIRECTIVE_1, DIRECTIVE_2, DIRECTIVE_3]) expect(userTextsOf(after).includes(d)).toBe(true);
});

test('isHumanUserMessage — 혼합 tool_result+text 행은 캐리어(사람 아님)·구조 기준 분류', () => {
  // 문자열 user = 사람.
  expect(isHumanUserMessage({ role: 'user', content: '문자열 지시' } as LLMMessage)).toBe(true);
  // text 블록만 실은 user = 사람.
  expect(isHumanUserMessage({ role: 'user', content: [{ type: 'text', text: '블록 지시' }] } as LLMMessage)).toBe(true);
  // tool_result+text 혼합 user = 도구 출력 캐리어(사람 아님) — 원문 보존·overflow drop 후보가
  // 이 분류를 공유한다(짝 tool_use 만 요약돼 유령 tool_result 가 되는 일을 막는다).
  expect(isHumanUserMessage({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }, { type: 'text', text: '덧붙임' }] } as LLMMessage)).toBe(false);
  expect(isHumanUserMessage({ role: 'assistant', content: 'x' } as LLMMessage)).toBe(false);
  expect(isHumanUserMessage({ role: 'system', content: 'x' } as LLMMessage)).toBe(false);
});
