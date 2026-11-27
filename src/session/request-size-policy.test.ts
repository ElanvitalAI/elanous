/**
 * TURN-REQUEST-SIZE-LOSS (0.3.38 P0) — the request-size thresholds live in config (`chat.requestSize`, defaults in code),
 * and the compaction summarizer's input is held to `summaryInputMaxChars` (an 855k-char transcript timed out / overflowed
 * the window on 11-27, so compaction never landed). Expected values are literals, independent of the product constants.
 */
import { describe, expect, test } from 'bun:test';
import { parseChatConfig } from '../user-config/chat.js';
import { boundedCompactTranscript } from '../compact/summarize.js';
import { createRequestSizeGuard, trimOldestMessages } from './request-size-guard.js';
import type { LLMMessage } from '../llm.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('chat.requestSize config', () => {
  test('defaults: 400 000 cap · compact at 0.85 · trim to 0.7 · summarizer input 200 000', () => {
    expect(parseChatConfig({}).requestSize).toEqual({ maxChars: 400_000, compactRatio: 0.85, trimTargetRatio: 0.7, summaryInputMaxChars: 200_000 }); // 출처: #40493 — chat.requestSize defaults (TURN-REQUEST-SIZE-LOSS)
  });
  test('a hand-set value wins; out-of-range values are clamped; other keys keep their defaults', () => {
    const parsed = parseChatConfig({ requestSize: { maxChars: 300_000, trimTargetRatio: 5, summaryInputMaxChars: 'x' } }).requestSize; // 출처: #40493 — chat.requestSize defaults (TURN-REQUEST-SIZE-LOSS)
    expect(parsed).toEqual({ maxChars: 300_000, compactRatio: 0.85, trimTargetRatio: 0.95, summaryInputMaxChars: 200_000 }); // 출처: #40493 — chat.requestSize defaults (TURN-REQUEST-SIZE-LOSS)
  });
  test('the guard takes its cap and trim ratio from the policy, an explicit cap still wins', () => {
    const guard = createRequestSizeGuard({ compactOptions: () => ({}) });
    expect(guard.maxChars).toBe(400_000);
    expect(guard.compactAtChars).toBe(340_000);
    expect(guard.trimTargetRatio).toBe(0.7);
    expect(createRequestSizeGuard({ maxChars: 1_000, compactOptions: () => ({}) }).compactAtChars).toBe(850); // 출처: #40493 — chat.requestSize defaults (TURN-REQUEST-SIZE-LOSS)
  });
});

describe('summarizer input bound', () => {
  test('an 855k-char record is sent to the summarizer at most 200 000 chars, head and tail kept', () => {
    const history: LLMMessage[] = Array.from({ length: 1_000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `row-${i} ${'x'.repeat(850)}` }));
    const text = boundedCompactTranscript(history);
    expect(text.length).toBeLessThanOrEqual(200_000);
    expect(text).toContain('row-0 ');
    expect(text).toContain('row-999 ');
    expect(text).toContain('…[truncated ');
  });
  test('a small record is unchanged', () => {
    expect(boundedCompactTranscript([{ role: 'user', content: 'hello' }])).toBe('USER: hello');
  });
});

describe('trimOldestMessages — pure rung', () => {
  const measure = (messages: LLMMessage[]) => JSON.stringify(messages).length;
  test('keeps system rows and the current turn, drops whole tool pairs, archives what it dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trim-oldest-'));
    try {
      const messages: LLMMessage[] = [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'old '.repeat(500) },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r'.repeat(300) }] },
        { role: 'assistant', content: 'old reply '.repeat(100) },
        { role: 'user', content: 'now' },
      ];
      const out = (await trimOldestMessages(messages, measure, 1_500, { sessionId: 's', archiveDir: dir }))!;
      expect(out).not.toBe(null);
      expect(measure(out.messages)).toBeLessThanOrEqual(1_500);
      expect(out.messages[0]).toEqual({ role: 'system', content: 'rules' });
      expect(out.messages.at(-1)).toEqual({ role: 'user', content: 'now' });
      const ids = JSON.stringify(out.messages);
      expect(ids.includes('"t1"')).toBe(false); // the pair went together
      expect(String(out.messages[1]!.content)).toContain('saved to: ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('null when only the protected rows remain over the target, or the archive is off', async () => {
    const messages: LLMMessage[] = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'n'.repeat(5_000) }];
    expect(await trimOldestMessages(messages, measure, 800, { archiveDir: tmpdir() })).toBe(null);
    const more: LLMMessage[] = [{ role: 'user', content: 'old '.repeat(500) }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'now' }];
    expect(await trimOldestMessages(more, measure, 400, { archiveEnabled: false })).toBe(null);
  });
});
