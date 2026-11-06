// ── Wave 2 · Layer 1 · tool-output budget ──

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyToolOutputBudget } from '../src/compact/tool-output-budget';
import { archiveReferencePath } from '../src/compact/archive';
import type { LLMMessage } from '../src/llm';
import { dispatchRead } from '../src/code-edit/tools';

const archiveDirs: string[] = [];
function archDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'compact-tob-'));
  archiveDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of archiveDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Wave 2 · Layer 1 · tool-output budget', () => {
  test('quotes delimiter characters in archive paths for Read', async () => {
    const dir = join(archDir(), 'a]b"c\\d');
    const original = 'original\n'.repeat(1000);
    const messages: LLMMessage[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'quoted', content: original }] }];
    const result = applyToolOutputBudget(messages, { sessionId: 'quoted', policy: { archiveDir: dir, preserveLastN: 0, toolOutputCharBudget: 512, toolOutputTailLines: 1 } });
    const block = (result.messages[0]!.content as Array<{ content: string }>)[0]!;
    const path = JSON.parse(block.content.match(/saved to: ("(?:\\.|[^"\\])*")\]/)![1]!) as string;
    expect(path).toBe(join(dir, 'quoted.jsonl'));
    const read = await dispatchRead({ file_path: path });
    const record = JSON.parse(read.output.split('\n').find(line => line.startsWith('{'))!);
    expect(record.origin.tool_use_id).toBe('quoted');
    expect(record.content).toBe(original);
  });
  test('does not truncate a recovery reference or required tail to fit a tiny budget', () => {
    const original = `${'head\n'.repeat(1000)}last line`;
    const messages: LLMMessage[] = [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tiny-budget', content: original },
    ] }];
    const result = applyToolOutputBudget(messages, {
      sessionId: 'tiny', policy: { archiveDir: archDir(), preserveLastN: 0, toolOutputCharBudget: 10, toolOutputTailLines: 1 },
    });
    expect(result.responsesTrimmed).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  test('reserves the recovery reference and selected tail within the budget', () => {
    const original = `${'head\n'.repeat(1000)}tail-1\ntail-2`;
    const messages: LLMMessage[] = [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'budget-tail', content: original },
    ] }];
    const dir = archDir();
    const result = applyToolOutputBudget(messages, {
      sessionId: 'budget', policy: { archiveDir: dir, preserveLastN: 0, toolOutputCharBudget: 256, toolOutputTailLines: 2 },
    });
    expect(result.responsesTrimmed).toBe(1);
    const block = (result.messages[0]!.content as Array<{ content: string }>)[0]!;
    expect(block.content.length).toBeLessThanOrEqual(256);
    expect(block.content).toContain(join(dir, 'budget.jsonl'));
    expect(block.content).toContain('tail-1\ntail-2');
  });

  test('long archive path remains readable through the production Read tool', async () => {
    const dir = join(archDir(), ...Array.from({ length: 3 }, () => 'long-segment-'.repeat(15)));
    const original = `${'original\n'.repeat(1_000)}last line`;
    const messages: LLMMessage[] = [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'long-path', content: original },
    ] }];
    const result = applyToolOutputBudget(messages, {
      sessionId: 'long-session', policy: { archiveDir: dir, preserveLastN: 0, toolOutputCharBudget: 1_200, toolOutputTailLines: 1 },
    });
    expect(result.responsesTrimmed).toBe(1);
    const block = (result.messages[0]!.content as Array<{ tool_use_id: string; content: string }>)[0]!;
    const path = block.content.match(/saved to: ([^\]]+)\]/)?.[1];
    expect(path).toBe(join(dir, 'long-session.jsonl'));
    expect(block.content.length).toBeLessThanOrEqual(1_200);
    const read = await dispatchRead({ file_path: path });
    const record = JSON.parse(read.output.split('\n').find(line => line.startsWith('{'))!);
    expect(record.origin.tool_use_id).toBe(block.tool_use_id);
    expect(record.content).toBe(original);
  });

  test('small tool result passes through untouched', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'short' }],
      },
    ];
    const r = applyToolOutputBudget(messages, {
      policy: { archiveDir: archDir() },
    });
    expect(r.responsesTrimmed).toBe(0);
    expect(r.savedChars).toBe(0);
    expect(r.messages).toEqual(messages);
  });

  test('huge tool result trimmed to last N lines + file pointer', () => {
    const huge = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    // Pad messages so the eligible message falls outside preserveLastN.
    const messages: LLMMessage[] = [
      { role: 'user', content: 'pad-1' },
      {
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: 't42', content: huge }],
      },
      { role: 'user', content: 'pad-2' },
      { role: 'assistant', content: 'pad-3' },
      { role: 'user', content: 'pad-4' },
      { role: 'assistant', content: 'pad-5' },
      { role: 'user', content: 'pad-6' },
      { role: 'assistant', content: 'pad-7' },
    ];
    const archiveDir = join(archDir(), 'a]b"c\\d');
    const recoveryReference = archiveReferencePath('default', archiveDir);
    const r = applyToolOutputBudget(messages, {
      // Derive the budget from the escaped recovery reference, so temp paths
      // and JSON escaping cannot push the pointer over the budget.
      policy: { toolOutputCharBudget: recoveryReference.length + 512, toolOutputTailLines: 30, archiveDir, preserveLastN: 3 },
    });
    expect(r.responsesTrimmed).toBe(1);
    expect(r.savedChars).toBeGreaterThan(0);

    const firstAssistant = r.messages[1];
    expect(firstAssistant?.role).toBe('assistant');
    const block = (firstAssistant?.content as any)[0];
    expect(block.type).toBe('tool_result');
    expect(block.content).toContain('Full output');
    expect(block.content).toContain('saved to:');
    // Tail preserved — last 30 lines should be present
    expect(block.content).toContain('line 999');
    expect(block.content).toContain('line 970');
    // Head should NOT be present (line 0..969 dropped)
    expect(block.content.includes('\nline 0\n')).toBe(false);
  });

  test('preserveLastN window exempts recent tool results', () => {
    const huge = 'x'.repeat(200_000);
    const messages: LLMMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: huge }],
      },
    ];
    // preserveLastN=10 covers everything → nothing trimmed
    const r = applyToolOutputBudget(messages, {
      policy: { toolOutputCharBudget: 100, archiveDir: archDir(), preserveLastN: 10 },
    });
    expect(r.responsesTrimmed).toBe(0);
  });

  test('non-tool-result blocks pass through', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'large text would be ignored ' + 'x'.repeat(200_000) },
          { type: 'tool_use', id: 'u', name: 'tool', input: {} },
        ],
      },
    ];
    const r = applyToolOutputBudget(messages, {
      policy: { toolOutputCharBudget: 100, archiveDir: archDir(), preserveLastN: 0 },
    });
    expect(r.responsesTrimmed).toBe(0);
  });

  test('archive disabled preserves the original without a false recovery pointer', () => {
    const huge = 'y'.repeat(80_000);
    const messages: LLMMessage[] = [
      { role: 'user', content: 'pad' },
      {
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: 'b', content: huge }],
      },
      { role: 'user', content: 'tail-1' },
      { role: 'assistant', content: 'tail-2' },
      { role: 'user', content: 'tail-3' },
      { role: 'assistant', content: 'tail-4' },
      { role: 'user', content: 'tail-5' },
      { role: 'assistant', content: 'tail-6' },
    ];
    const dir = archDir();
    const r = applyToolOutputBudget(messages, {
      policy: { toolOutputCharBudget: 100, archiveDir: dir, archiveEnabled: false, preserveLastN: 3 },
    });
    expect(readdirSync(dir)).toEqual([]);
    expect(r.responsesTrimmed).toBe(0);
    expect(r.savedChars).toBe(0);
    expect(r.messages).toEqual(messages);
  });
});
