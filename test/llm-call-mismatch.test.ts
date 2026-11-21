import { describe, expect, test } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { llmNetworkSend, withLlmCallContext } from '../src/session-runtime/llm-call-gateway.js';

const rows = (event: 'attempt' | 'mismatch') => debug.events(100).filter(e => e.category === 'llm.call' && e.event === event);
const send = async () => new Response('ok');
const URL_WITH_SECRET = 'https://api.example.test/private/path?token=SECRET';

async function call(fields: Parameters<typeof llmNetworkSend>[2]) {
  debug.clear();
  await llmNetworkSend(URL_WITH_SECRET, {}, fields, send);
}

describe('declared != observed: one warn row, only when a requested value was declared and differs', () => {
  test('nothing declared, or declared equal to what was called: no mismatch row', async () => {
    await call({ provider: 'openai', model: 'gpt-actual' });
    expect(rows('mismatch')).toEqual([]);
    expect(rows('attempt')).toEqual([expect.anything()]);
    await call({ provider: 'openai', model: 'gpt-actual', requestedProvider: 'openai', requestedModel: 'gpt-actual' });
    expect(rows('mismatch')).toEqual([]);
    await call({ provider: 'openai', model: 'gpt-actual', requestedProvider: 'openai' });
    expect(rows('mismatch')).toEqual([]);
  });

  test('a different provider (fallback): one attempt row and one warn row naming both sides', async () => {
    await call({ provider: 'openai-codex', model: 'gpt-actual', requestedProvider: 'glm', requestedModel: 'glm-asked' });
    expect(rows('attempt')).toEqual([expect.anything()]);
    expect(rows('mismatch').map(row => row.data)).toEqual([
      expect.objectContaining({ requestedProvider: 'glm', provider: 'openai-codex', requestedModel: 'glm-asked', model: 'gpt-actual' }),
    ]);
    expect(rows('mismatch').every(row => row.level === 'warn')).toBe(true);
  });

  test('the same provider but a different model is also a mismatch', async () => {
    await call({ provider: 'openai', model: 'gpt-actual', requestedProvider: 'openai', requestedModel: 'gpt-asked' });
    expect(rows('mismatch').map(row => row.data)).toEqual([expect.objectContaining({ requestedModel: 'gpt-asked', model: 'gpt-actual' })]);
  });

  test('a context-scoped request is compared too, and the row never carries a URL path, query or secret', async () => {
    debug.clear();
    await withLlmCallContext({ requestedProvider: 'glm' }, () => llmNetworkSend(URL_WITH_SECRET, {}, { provider: 'openai-codex' }, send));
    expect(rows('attempt')).toEqual([expect.anything()]);
    expect(rows('mismatch')).toEqual([expect.anything()]);
    expect(JSON.stringify(rows('mismatch'))).not.toMatch(/SECRET|private|token/);
  });

  test('a failing send still leaves its mismatch row and the send error is unchanged', async () => {
    debug.clear();
    const failure = new Error('network down');
    await expect(llmNetworkSend(URL_WITH_SECRET, {}, { provider: 'a', requestedProvider: 'b' }, async () => { throw failure; })).rejects.toBe(failure);
    expect(rows('attempt')).toEqual([expect.anything()]);
    expect(rows('mismatch')).toEqual([expect.anything()]);
  });

  test('wire alias — registry name `openai-codex` vs wire name `codex` (same subscription backend) is NOT a mismatch, both directions', async () => {
    // 레지스트리는 `openai-codex`(provider.name · llm.ts:9509), 와이어는 `codex`
    // (retryOptsFor('codex', …) · llm.ts:2237 → retry-api.ts:149). 정규화 없이는 codex
    // 경로 매호출 warn — 24h 실측 mismatch 38,395/attempt 41,683(≈92%)가 이 별칭쌍(LLM-CALL-LEDGER-NO-GAP).
    await call({ provider: 'codex', model: 'gpt-actual', requestedProvider: 'openai-codex', requestedModel: 'gpt-actual' });
    expect(rows('mismatch')).toEqual([]);
    expect(rows('attempt')).toEqual([expect.anything()]);
    await call({ provider: 'openai-codex', model: 'gpt-actual', requestedProvider: 'codex', requestedModel: 'gpt-actual' });
    expect(rows('mismatch')).toEqual([]);
    expect(rows('attempt')).toEqual([expect.anything()]);
    // 진짜 다른 공급자는 여전히 warn — 정규화가 관문을 넓히면 안 된다.
    await call({ provider: 'codex', model: 'gpt-actual', requestedProvider: 'glm', requestedModel: 'gpt-actual' });
    expect(rows('mismatch')).toEqual([expect.anything()]);
  });
});
