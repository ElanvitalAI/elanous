import { describe, expect, test } from 'bun:test';
import { messagesToResponsesInput, type LLMMessage } from '../src/llm.js';
import { capturePrepassRecoverySnapshot, isUnknownCodex400, repairCodexToolPairs,
  restorePrepassRecoverySnapshot, restoreRepairedHistory } from '../src/dashboard/input/compact-prepass-recovery.js';

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

describe('capture/restore recovery snapshot', () => {
  const baseMessages = (): LLMMessage[] => [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'pair', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pair', content: 'kept output' }] },
  ];

  test('capture deep-copies history so later mutation of the original leaves the snapshot intact', () => {
    const messages = baseMessages();
    const snapshot = capturePrepassRecoverySnapshot(
      { persistentActiveId: 'persistent-1', acpId: 'acp-1', messages });
    expect(snapshot.persistentActiveId).toBe('persistent-1');
    expect(snapshot.acpId).toBe('acp-1');
    (messages[0]!.content as string) = 'mutated-after-capture';
    (messages[1]!.content as unknown as Array<{ type: string; id: string }>)[0]!.id = 'mutated-id';
    messages.pop();
    expect((snapshot.messages[0]!.content as string)).toBe('hello');
    expect((snapshot.messages[1]!.content as Array<{ type: string; id: string }>)[0]!.id).toBe('pair');
    expect(snapshot.messages).toHaveLength(3);
  });

  test('restore returns an independent copy so mutating the restored result leaves the snapshot untouched', () => {
    const snapshot = capturePrepassRecoverySnapshot(
      { persistentActiveId: 'persistent-2', acpId: 'acp-2', messages: baseMessages() });
    const restored = restorePrepassRecoverySnapshot(snapshot);
    expect(restored.persistentActiveId).toBe('persistent-2');
    expect(restored.acpId).toBe('acp-2');
    (restored.messages[0]!.content as string) = 'mutated-restored';
    restored.messages.pop();
    expect(restored.messages).toHaveLength(2);
    expect((snapshot.messages[0]!.content as string)).toBe('hello');
    expect(snapshot.messages).toHaveLength(3);
    expect((snapshot.messages).at(-1)).not.toBeUndefined();
  });

  test('restoring the same snapshot twice yields equal but non-aliased results', () => {
    const snapshot = capturePrepassRecoverySnapshot(
      { persistentActiveId: 'persistent-3', acpId: 'acp-3', messages: baseMessages() });
    const first = restorePrepassRecoverySnapshot(snapshot);
    const second = restorePrepassRecoverySnapshot(snapshot);
    expect(first).toEqual(second);
    expect(first.messages).not.toBe(second.messages);
    expect(first.messages[0]).not.toBe(second.messages[0]);
    expect(first.messages[0]).not.toBe(snapshot.messages[0]);
    (first.messages[0]!.content as string) = 'poisoned-first';
    expect((second.messages[0]!.content as string)).toBe('hello');
    expect((snapshot.messages[0]!.content as string)).toBe('hello');
  });

  test('existing pair repair still works on histories captured and restored through the snapshot primitives', () => {
    const messages = baseMessages();
    messages.splice(2, 0, {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'orphan output' }],
    });
    const snapshot = capturePrepassRecoverySnapshot(
      { persistentActiveId: 'persistent-4', acpId: 'acp-4', messages });
    const restored = restorePrepassRecoverySnapshot(snapshot);
    const repaired = repairCodexToolPairs(restored.messages);
    expect(repaired.removedResults).toBe(1);
    expect(repaired.removedCalls).toBe(0);
    expect(repaired.ambiguousIds).toEqual([]);
    expect(JSON.stringify(repaired.messages)).not.toContain('orphan output');
    expect(JSON.stringify(repaired.messages)).toContain('kept output');
    expect(JSON.stringify(snapshot.messages)).toContain('orphan output');
  });
});
