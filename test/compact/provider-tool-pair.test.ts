import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultCompactProvider, runCompactPipeline } from '../../src/compact';
import { debug } from '../../src/debug/log';
import * as llmModule from '../../src/llm';
import type { LLMMessage } from '../../src/llm';

const toolUse = (id: string): LLMMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'Read', input: {} }],
});
const toolResult = (id: string): LLMMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: `${id} result` }],
});

function archDir(): string {
  return mkdtempSync(join(tmpdir(), 'compact-tool-pair-'));
}

let transcript = '';

beforeEach(() => {
  transcript = '';
  debug.enable();
  debug.clear();
  spyOn(llmModule, 'streamLLM').mockImplementation(async (messages) => {
    transcript = String(messages[1]?.content);
    return 'fake compact summary';
  });
});

afterEach(() => {
  mock.restore();
  debug.disable();
});

describe('compact provider tool-pair boundary', () => {
  test('repairs a split pair in summary input and the pipeline preserved tail', async () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old request' },
      toolUse('A'),
      toolResult('A'),
      { role: 'user', content: 'supervisor memo' },
      toolUse('B'),
      toolResult('B'),
    ];

    const result = await runCompactPipeline(messages, {
      policy: { archiveDir: archDir(), preserveLastN: 4 },
      provider: getDefaultCompactProvider(),
    });

    expect(transcript).toContain('old request');
    expect(transcript).not.toContain('A result');
    expect(result.messages.some((message) => message === messages[2])).toBe(true);
    const resultIds = result.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id)
      : []);
    const useIds = new Set(result.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_use').map((block) => block.id)
      : []));
    expect(resultIds.every((id) => useIds.has(id))).toBe(true);
    expect(debug.events().some((entry) => entry.category === 'compact'
      && entry.event === 'tool-pair-boundary-shift'
      && (entry.data as { from?: number }).from === 3
      && (entry.data as { to?: number }).to === 2
      && JSON.stringify((entry.data as { orphanIds?: string[] }).orphanIds) === '["A"]')).toBe(true);
  });

  test('repeats the retreat until every newly retained result has its call in the final tail', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'old request' },
      toolUse('A'),
      toolUse('B'),
      toolResult('A'),
      toolResult('B'),
    ];

    const result = await runCompactPipeline(messages, {
      policy: { archiveDir: archDir(), preserveLastN: 1 },
      provider: getDefaultCompactProvider(),
    });

    // ★ COMPACT P0 (OP #123867) — 슬라이스 안 사람 user('old request') 1건이 요약 뒤에도 원문 보존(5→6).
    expect(result.messages).toHaveLength(6);
    expect(result.messages[0]?.content).toContain('fake compact summary');
    expect(result.messages[1]).toBe(messages[0]);
    expect(result.messages.slice(2)).toEqual(messages.slice(1));
    const resultIds = result.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id)
      : []);
    const useIds = new Set(result.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_use').map((block) => block.id)
      : []));
    expect(resultIds.every((id) => useIds.has(id))).toBe(true);
    expect(transcript).toContain('old request');
    expect(debug.events().some((entry) => entry.category === 'compact'
      && entry.event === 'tool-pair-boundary-shift'
      && (entry.data as { from?: number }).from === 4
      && (entry.data as { to?: number }).to === 1
      && JSON.stringify((entry.data as { orphanIds?: string[] }).orphanIds) === '["B","A"]')).toBe(true);
  });

  test('leaves already-safe boundaries unchanged', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'old request' },
      toolUse('A'),
      toolResult('A'),
      { role: 'user', content: 'memo' },
      { role: 'assistant', content: 'recent reply' },
    ];

    const result = await runCompactPipeline(messages, {
      policy: { archiveDir: archDir(), preserveLastN: 2 },
      provider: getDefaultCompactProvider(),
    });

    expect(transcript).toContain('old request');
    // ★ COMPACT P0 (OP #123867) — 사람 user('old request') 원문 보존으로 1건 추가(3→4).
    //    toolResult A(role user·tool_result 캐리어)는 보존 제외 — 짝(toolUse A)과 함께 요약된다.
    expect(result.messages).toHaveLength(4);
    expect(result.messages[1]).toBe(messages[0]);
    expect(result.messages[2]).toBe(messages[3]);
    expect(result.messages[3]).toBe(messages[4]);
    const resultIds = result.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id)
      : []);
    const useIds = new Set(result.messages.flatMap((message) => Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_use').map((block) => block.id)
      : []));
    expect(resultIds.every((id) => useIds.has(id))).toBe(true);
    expect(debug.events().some((entry) => entry.event === 'tool-pair-boundary-shift')).toBe(false);
  });

  test('returns null after full retreat leaves no non-system source to summarize', async () => {
    const result = await getDefaultCompactProvider().summarize({
      messages: [
        toolUse('A'),
        toolResult('A'),
      ],
      preserveLastN: 1,
    });

    expect(result).toBeNull();
    expect(debug.events().some((entry) => entry.category === 'compact'
      && entry.event === 'tool-pair-boundary-shift')).toBe(true);
  });
});
