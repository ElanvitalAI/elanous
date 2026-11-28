// ── Wave 2 · Layer 2 · microcompact ──

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverToolOutputChunk } from '../src/compact/archive';
import { applyMicrocompact } from '../src/compact/microcompact';
import type { LLMMessage } from '../src/llm';

function archDir(): string {
  return mkdtempSync(join(tmpdir(), 'compact-mc-'));
}

const PLACEHOLDER = '[Old tool result content cleared]';

describe('Wave 2 · Layer 2 · microcompact', () => {
  test('clears tool_result content older than threshold turns', () => {
    // 8 turns; threshold = 3 → turns 1..5 eligible (counting from
    // tail: 8,7,6 are kept). preserveLastN=2 covers turns 7-8.
    const messages: LLMMessage[] = [];
    for (let i = 1; i <= 8; i++) {
      messages.push({
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `payload ${i} ` + 'x'.repeat(500) }],
      });
    }
    const dir = archDir();
    const r = applyMicrocompact(messages, {
      sessionId: 'micro-test',
      policy: {
        microcompactAgeThreshold: 3,
        preserveLastN: 2,
        archiveDir: dir,
      },
    });
    // First 5 turns should be cleared
    expect(r.cleared).toBe(5);
    expect(r.savedChars).toBeGreaterThan(0);
    // Verify placeholder applied to old turns
    for (let i = 0; i < 5; i++) {
      const block = (r.messages[i]?.content as any)[0];
      expect(block.content).toStartWith(PLACEHOLDER);
      const sha = block.content.match(/sha256-utf16le: ([a-f0-9]{64})/)?.[1];
      expect(sha).toBeDefined();
      expect(recoverToolOutputChunk('micro-test', `t${i + 1}`, 0, 5000, dir, sha)).toMatchObject({ok: true, content: `payload ${i + 1} ` + 'x'.repeat(500)});
    }
    // Recent turns kept
    const recent = (r.messages[7]?.content as any)[0];
    expect(recent.content).toContain('payload 8');
  });

  test('preserves the original if the archive cannot be written', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'failed-archive', content: 'original evidence' }] },
      { role: 'assistant', content: 'newer turn' },
    ];
    // A regular file cannot be used as an archive directory.
    const r = applyMicrocompact(messages, { sessionId: 'failure', policy: {
      microcompactAgeThreshold: 0, preserveLastN: 1, archiveDir: import.meta.path,
    } });
    expect(r.cleared).toBe(0);
    expect(r.messages).toEqual(messages);
  });

  test('idempotent — running twice does not double-clear', () => {
    const messages: LLMMessage[] = [];
    for (let i = 1; i <= 6; i++) {
      messages.push({
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'data' }],
      });
    }
    const dir = archDir();
    const r1 = applyMicrocompact(messages, {
      policy: { microcompactAgeThreshold: 1, preserveLastN: 1, archiveDir: dir },
    });
    const r2 = applyMicrocompact(r1.messages, {
      policy: { microcompactAgeThreshold: 1, preserveLastN: 1, archiveDir: dir },
    });
    expect(r1.cleared).toBeGreaterThan(0);
    expect(r2.cleared).toBe(0);
  });

  test('preserveLastN window has priority over threshold', () => {
    const messages: LLMMessage[] = [];
    for (let i = 1; i <= 4; i++) {
      messages.push({
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `x${i}` }],
      });
    }
    // threshold=0 (everything old) but preserveLastN=10 (everything preserved)
    const r = applyMicrocompact(messages, {
      policy: { microcompactAgeThreshold: 0, preserveLastN: 10, archiveDir: archDir() },
    });
    expect(r.cleared).toBe(0);
  });

  test('non-tool-result content untouched', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'plain user text' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'response' }],
      },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'k' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'k' },
    ];
    const r = applyMicrocompact(messages, {
      policy: { microcompactAgeThreshold: 0, preserveLastN: 0, archiveDir: archDir() },
    });
    expect(r.cleared).toBe(0);
    expect(r.messages).toEqual(messages);
  });
});
