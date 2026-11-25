// 조용한 모델 폴백을 화면에 — 요청(terra) ≠ 실제(GLM) 이면 상태줄이 «⚠ fallback: <모델>» 을 보이고
// llm.fallback-active 를 전환마다 한 번 남긴다. 폴백 정책(사다리)은 건드리지 않는다.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { llmObserveSend } from '../session-runtime/llm-call-gateway.js';
import { formatNextTuiStatusLine, nextTuiShortStatus } from '../tui/chat/status-line.js';
import { activeLlmFallback, resetLlmFallbacksForTest, statusModelWithFallback } from './fallback-active.js';

afterEach(() => resetLlmFallbacksForTest());

const requested = { requestedProvider: 'openai-codex', requestedModel: 'gpt-6.1-terra' } as const;
const send = (sessionId: string, provider: string, model: string, selectionSource?: 'fallback' | 'session') =>
  llmObserveSend('https://example.invalid/v1', { sessionId, provider, model, ...requested, ...(selectionSource ? { selectionSource } : {}) }, () => 'sent');

test('a provider fallback shows the actual model on the status line and logs llm.fallback-active once per switch', () => {
  const logs: Array<[string, string]> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => { logs.push([category, event]); }) as typeof debug.log);
  try {
    const sid = 'sess-fallback-1';
    expect(send(sid, 'openai-codex', 'gpt-6.1-terra', 'session')).toBe('sent');
    expect(activeLlmFallback(sid)).toBeUndefined();
    expect(statusModelWithFallback(sid, 'openai-codex/gpt-6.1-terra')).toBe('openai-codex/gpt-6.1-terra');

    send(sid, 'openrouter', 'z-ai/glm-5.3', 'fallback');
    send(sid, 'openrouter', 'z-ai/glm-5.3', 'fallback');
    send(sid, 'openrouter', 'z-ai/glm-5.3', 'fallback');
    expect(activeLlmFallback(sid)).toMatchObject({ provider: 'openrouter', model: 'z-ai/glm-5.3', requestedModel: 'gpt-6.1-terra' });
    expect(logs.filter(([c, e]) => c === 'llm' && e === 'fallback-active')).toHaveLength(1);
    // The mismatch warn row the ledger already had stays (one per attempt).
    expect(logs.filter(([c, e]) => c === 'llm.call' && e === 'mismatch')).toHaveLength(3);

    const label = statusModelWithFallback(sid, 'openai-codex/gpt-6.1-terra');
    expect(label).toBe('⚠ fallback: glm-5.3');
    const line = formatNextTuiStatusLine({ turnState: '응답 중', model: label, queued: 0, backgroundTasks: 0, width: 200 });
    expect(line).toContain('⚠ fallback: glm-5.3');
    expect(line).not.toContain('terra');
    expect(nextTuiShortStatus({ turnState: '응답 중', model: label, queued: 0, backgroundTasks: 0, width: 80 }).model).toBe('⚠ fallback: glm-5.3');

    // Another session is untouched.
    expect(statusModelWithFallback('other-session', 'openai-codex/gpt-6.1-terra')).toBe('openai-codex/gpt-6.1-terra');

    // A second switch logs again; going back to the requested provider clears the mark.
    send(sid, 'anthropic', 'claude-opus-5.5', 'fallback');
    expect(logs.filter(([c, e]) => c === 'llm' && e === 'fallback-active')).toHaveLength(2);
    send(sid, 'codex', 'gpt-6.1-terra', 'session');
    expect(activeLlmFallback(sid)).toBeUndefined();
    expect(logs.filter(([c, e]) => c === 'llm' && e === 'fallback-cleared')).toHaveLength(1);
    expect(statusModelWithFallback(sid, 'openai-codex/gpt-6.1-terra')).toBe('openai-codex/gpt-6.1-terra');
  } finally {
    spy.mockRestore();
  }
});
