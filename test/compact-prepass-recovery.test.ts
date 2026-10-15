import { describe, expect, test } from 'bun:test';
import { messagesToResponsesInput, type LLMMessage } from '../src/llm.js';
import { isUnknownCodex400, repairCodexToolPairs, restoreRepairedHistory } from '../src/dashboard/input/compact-prepass-recovery.js';

test('generic Codex HTTP 400 recognition accepts body variants but excludes other providers', () => {
  expect(isUnknownCodex400('Codex API 400: { "detail": "Bad Request" }')).toBe(true);
  expect(isUnknownCodex400('Codex API 400: opaque malformed request')).toBe(true);
  expect(isUnknownCodex400('opaque', { status: 400, provider: 'codex' })).toBe(true);
  expect(isUnknownCodex400('OpenAI API 400: opaque', { status: 400, provider: 'openai' })).toBe(false);
  expect(isUnknownCodex400('Codex API 429: rate limited')).toBe(false);
});

test('restoration preserves appended messages and avoids replacing a divergent prefix', () => {
  const original = [{ id: 'orphan' }, { id: 'paired' }];
  const repaired = [original[1]!];
  const followup = { id: 'followup' };
  const history = [...repaired, followup];
  expect(restoreRepairedHistory(history, structuredClone(original), repaired, structuredClone(repaired)))
    .toEqual({ restored: true, preservedTail: 1 });
  expect(history).toEqual([...original, followup]);
  const divergent = [{ id: 'new-front' }, ...repaired, followup];
  expect(restoreRepairedHistory(divergent, structuredClone(original), repaired, structuredClone(repaired)).restored)
    .toBe(false);
  expect(divergent).toEqual([{ id: 'new-front' }, ...repaired, followup]);
  const mutated = [...repaired, followup];
  const expected = structuredClone(repaired);
  mutated[0]!.id = 'changed-in-place';
  expect(restoreRepairedHistory(mutated, structuredClone(original), repaired, expected).restored).toBe(false);
  expect(mutated[0]!.id).toBe('changed-in-place');
});

describe('repairCodexToolPairs', () => {
  test('removes unmatched calls and outputs while preserving the complete pair', () => {
    const history: LLMMessage[] = [
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'missing', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'orphan output' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'paired', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'paired', content: 'kept output' }] },
    ];
    const repaired = repairCodexToolPairs(history);
    expect(repaired.removedCalls).toBe(1);
    expect(repaired.removedResults).toBe(1);
    expect(messagesToResponsesInput(repaired.messages).input.filter(item => 'type' in item
      && item.type === 'function_call')).toHaveLength(1);
    expect(messagesToResponsesInput(repaired.messages).input.filter(item => 'type' in item
      && item.type === 'function_call_output')).toHaveLength(1);
    expect(JSON.stringify(history)).toContain('orphan output');
    expect(repaired.messages[0]).toBe(history[0]);
  });
  test('leaves repeated call IDs untouched because a single result has no unique owner', () => {
    const history: LLMMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'Read', input: {} }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'Write', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same', content: 'result' }] },
    ];
    const repaired = repairCodexToolPairs(history);
    expect(repaired.ambiguousIds).toEqual(['same']);
    expect(repaired.messages).toEqual(history);
    expect(repaired.removedCalls + repaired.removedResults).toBe(0);
  });
});
