// ── Wave 2 · pipeline (Layer 1+2) + truncate-proportional ──

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCompactPipeline } from '../src/compact/pipeline';
import { truncateProportional } from '../src/compact/truncate-proportional';
import { archivePath, archiveReferencePath } from '../src/compact/archive';
import type { LLMMessage } from '../src/llm';

function archDir(): string {
  return mkdtempSync(join(tmpdir(), 'compact-pipe-'));
}

describe('Wave 2 · pipeline orchestrator', () => {
  test('combines Layer 1 (budget trim) + Layer 2 (microcompact)', async () => {
    const huge = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const messages: LLMMessage[] = [];
    // 6 old turns with huge tool_results, plus 4 recent turns with small ones
    for (let i = 1; i <= 6; i++) {
      messages.push({
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: [{ type: 'tool_result', tool_use_id: `old-${i}`, content: huge }],
      });
    }
    for (let i = 1; i <= 4; i++) {
      messages.push({
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: [{ type: 'tool_result', tool_use_id: `new-${i}`, content: 'small' }],
      });
    }
    const r = await runCompactPipeline(messages, {
      policy: {
        toolOutputCharBudget: 200,
        toolOutputTailLines: 5,
        microcompactAgeThreshold: 2,
        preserveLastN: 4,
        archiveDir: archDir(),
      },
    });
    // Layer 1: huge results trimmed (only old ones; preserveLastN=4 spares the new-* batch)
    expect(r.diagnostics.layer1ResponsesTrimmed).toBe(6);
    expect(r.diagnostics.layer1ToolOutputBudgetSavedChars).toBeGreaterThan(0);
    // Layer 2: cleared old tool_results — but they were already trimmed by Layer 1,
    // so the count reflects how many got placeholder-replaced after that
    expect(r.diagnostics.layer2MicrocompactCleared).toBeGreaterThan(0);
    expect(r.diagnostics.archived).toBeGreaterThan(0);
  });

  test('archive jsonl written when archive enabled', async () => {
    const dir = archDir();
    const toolOutputCharBudget = archiveReferencePath('test-session-x', dir).length + 512;
    const messages: LLMMessage[] = [
      { role: 'user', content: 'pad' },
      {
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'a'.repeat(70_000) }],
      },
      { role: 'user', content: 'tail-1' },
      { role: 'assistant', content: 'tail-2' },
      { role: 'user', content: 'tail-3' },
      { role: 'assistant', content: 'tail-4' },
      { role: 'user', content: 'tail-5' },
      { role: 'assistant', content: 'tail-6' },
    ];
    await runCompactPipeline(messages, {
      sessionId: 'test-session-x',
      policy: {
        toolOutputCharBudget,
        archiveDir: dir,
        preserveLastN: 3,
      },
    });
    const path = archivePath('test-session-x', dir);
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf-8');
    const lines = body.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]!);
    expect(entry.layer).toBe('tool-output-budget');
    expect(entry.sessionId).toBe('test-session-x');
    expect(entry.content).toContain('a');
  });

  test('archive disabled = diagnostics.archived is 0', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'pad' },
      {
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'b'.repeat(70_000) }],
      },
      { role: 'user', content: 'tail-1' },
      { role: 'assistant', content: 'tail-2' },
      { role: 'user', content: 'tail-3' },
      { role: 'assistant', content: 'tail-4' },
      { role: 'user', content: 'tail-5' },
      { role: 'assistant', content: 'tail-6' },
    ];
    const r = await runCompactPipeline(messages, {
      policy: {
        toolOutputCharBudget: 100,
        archiveEnabled: false,
        preserveLastN: 3,
      },
    });
    expect(r.diagnostics.archived).toBe(0);
    expect(r.diagnostics.layer1ResponsesTrimmed).toBe(0);
    expect(r.diagnostics.layer2MicrocompactCleared).toBeGreaterThan(0);
  });

  test('does not mutate input messages array', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(70_000) }],
      },
      { role: 'user', content: 'pad' },
      { role: 'assistant', content: 'pad' },
      { role: 'user', content: 'pad' },
      { role: 'assistant', content: 'pad' },
      { role: 'user', content: 'pad' },
      { role: 'assistant', content: 'pad' },
    ];
    const before = JSON.stringify(messages);
    await runCompactPipeline(messages, {
      policy: { toolOutputCharBudget: 100, archiveDir: archDir(), preserveLastN: 3 },
    });
    expect(JSON.stringify(messages)).toBe(before);
  });
});

describe('Wave 2 · truncateProportional fallback', () => {
  test('returns input unchanged when under budget', () => {
    expect(truncateProportional({ text: 'abc', maxChars: 100 })).toBe('abc');
  });

  test('returns first maxChars when budget too small for marker', () => {
    const r = truncateProportional({ text: 'abcdefghij', maxChars: 5 });
    expect(r.length).toBe(5);
  });

  test('keeps head 20% / tail 80% by default with marker', () => {
    const text = 'A'.repeat(100) + 'B'.repeat(800) + 'C'.repeat(100);
    const r = truncateProportional({ text, maxChars: 200 });
    expect(r.startsWith('A')).toBe(true);
    expect(r.endsWith('C')).toBe(true);
    expect(r).toContain('truncated');
    expect(r.length).toBeLessThanOrEqual(200);
  });

  test('headRatio override flips the split', () => {
    const text = 'X'.repeat(50) + 'Y'.repeat(900) + 'Z'.repeat(50);
    const head80 = truncateProportional({ text, maxChars: 200, headRatio: 0.8 });
    expect(head80.startsWith('X')).toBe(true);
    // With 80% head, much less Z survives at the tail
    const tailZcount = (head80.match(/Z/g) ?? []).length;
    const headXcount = (head80.match(/X/g) ?? []).length;
    expect(headXcount).toBeGreaterThan(tailZcount);
  });
});
