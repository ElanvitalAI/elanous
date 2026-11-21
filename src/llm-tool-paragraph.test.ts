import { afterAll, beforeAll, expect, test } from 'bun:test';
import { _setStreamDisconnectRetryDelayForTest } from './llm/stream-fallback.js';
import { streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from './llm.js';

// These rounds run on an injected fixture provider; a global ELANOUS_TEST_FAKE_LLM=1 (gate pods) is a forced-fake fence that
// outranks it by design (llm-usage-attribution.test.ts), so lift the switch for this file and restore it.
let priorTestFakeLlm: string | undefined;
beforeAll(() => { priorTestFakeLlm = process.env.ELANOUS_TEST_FAKE_LLM; delete process.env.ELANOUS_TEST_FAKE_LLM; });
afterAll(() => { if (priorTestFakeLlm === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM; else process.env.ELANOUS_TEST_FAKE_LLM = priorTestFakeLlm; });

async function renderRounds(rounds: Array<Array<LLMStreamEvent | Error>>) {
  let round = 0;
  const provider: LLMProvider = {
    name: 'probe-provider', defaultModel: 'gpt-4o-mini', available: () => true,
    async *chat() {},
    async *streamChat() { for (const step of rounds[round++] ?? []) { if (step instanceof Error) throw step; yield step; } },
  };
  const deltas: string[] = [];
  let cumulative = '';
  const turnTextChars: number[] = [];
  const text = await streamLLMWithTools([{ role: 'user', content: 'design and deploy' }], {
    onText: (delta, full) => { deltas.push(delta); if (delta) cumulative = full; },
    dispatchTool: async () => ({ ok: true }),
    onTurnEnd: (info) => { turnTextChars.push(info.textChars); },
  }, { provider, model: 'gpt-4o-mini', tools: [{ name: 'probe', description: 'test tool', parameters: {} }], maxTurns: rounds.length });
  return { text, cumulative, deltas, turnTextChars, visible: deltas.join('') };
}
const tool: LLMStreamEvent = { type: 'tool_call', id: 'paragraph-tool', name: 'probe', args: {} };

test('assistant text across a tool round forms separate paragraphs in deltas and final text', async () => {
  const result = await renderRounds([
    [{ type: 'text', delta: '준비하겠습니다.' }, tool],
    [{ type: 'text', delta: '요구사항을 ' }, { type: 'text', delta: '검증했습니다.' }],
  ]);
  expect(result.visible).toBe('준비하겠습니다.\n\n요구사항을 검증했습니다.');
  expect(result.cumulative).toBe(result.visible);
});

test('existing paragraph whitespace is preserved without extra blank paragraphs', async () => {
  const result = await renderRounds([
    [{ type: 'text', delta: 'first\n\n' }, tool],
    [{ type: 'text', delta: 'second' }],
  ]);
  expect(result.visible).toBe('first\n\nsecond');
  expect(result.cumulative).toBe(result.visible);
});

test('tool-only rounds do not prepend blank paragraphs to the first answer', async () => {
  const result = await renderRounds([[tool], [{ type: 'text', delta: 'first answer' }]]);
  expect(result.visible).toBe('first answer');
  expect(result.cumulative).toBe(result.visible);
});

test('paragraph leading whitespace split across deltas does not gain extra newlines', async () => {
  for (const chunks of [['\n', '\n', 'second'], [' ', '\n', '\n', 'second'], ['', '\n\n', 'second']]) {
    const result = await renderRounds([
      [{ type: 'text', delta: 'first' }, tool],
      chunks.map(delta => ({ type: 'text' as const, delta })),
    ]);
    expect(result.visible).toBe('first' + chunks.join(''));
    expect(result.cumulative).toBe(result.visible);
  }
});

test('disconnect after a tool paragraph rewinds and replays the separator as ordinary text', async () => {
  _setStreamDisconnectRetryDelayForTest(() => 0);
  try {
    const result = await renderRounds([
      [{ type: 'text', delta: 'first' }, tool],
      [{ type: 'text', delta: 'second' }, Object.assign(new Error('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' })],
      [{ type: 'text', delta: 'second' }],
    ]);
    expect(result.visible).toBe('first\n\nsecond');
    expect(result.cumulative).toBe(result.visible);
    expect(result.deltas).not.toContain('\n\n');
    expect(result.turnTextChars).toContain('\n\nsecond'.length);
  } finally { _setStreamDisconnectRetryDelayForTest(undefined); }
});

test('the paragraph glue between rounds is not part of the returned final answer that replaces earlier rounds', async () => {
  const result = await renderRounds([
    [{ type: 'text', delta: '준비하겠습니다.' }, tool],
    [{ type: 'text', delta: '완료했습니다.' }],
  ]);
  expect(result.visible).toBe('준비하겠습니다.\n\n완료했습니다.');
  expect(result.text).toBe('완료했습니다.');
});
