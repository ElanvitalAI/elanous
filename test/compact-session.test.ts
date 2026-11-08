// Unit tests for session auto-compaction (Loop engineering §5-⑤).
//
// Covers the two Phase A primitives:
//   1. rewriteSessionMessages — atomic in-place history replacement.
//   2. compactSessionHistory  — threshold-gated compaction with the
//      codex #1 remove_first_item drop-oldest retry-on-overflow guard.
//
// All session ops take an explicit `root` so tests run against a temp
// dir with no env/singleton coupling. The compact provider is stubbed
// so no LLM is called.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendMessage,
  createSession,
  loadSession,
  rewriteSessionMessages,
  type SerializedMessage,
} from '../src/session/index.js';
import { compactSessionHistory } from '../src/session/compact-session.js';
import { resetAutoCompactStateForTest } from '../src/compact/auto-state.js';
import type { CompactProvider } from '../src/compact/provider.js';
import type { ChatAutoCompactConfig } from '../src/user-config/chat.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'compact-session-'));
  resetAutoCompactStateForTest();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(count: number, contentPrefix = 'msg'): string {
  const meta = createSession({ source: 'cli' }, root);
  for (let i = 0; i < count; i++) {
    appendMessage(meta.id, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${contentPrefix}-${i} ${'x'.repeat(200)}`,
      ts: new Date().toISOString(),
    }, root);
  }
  return meta.id;
}

/** Provider whose summarize() replays a fixed script of return values;
 *  null models an overflow/timeout so the retry guard engages. */
function stubProvider(script: Array<string | null>): { provider: CompactProvider; calls: () => number } {
  let i = 0;
  const provider: CompactProvider = {
    async summarize() {
      const v = script[Math.min(i, script.length - 1)] ?? null;
      i++;
      return v === null ? null : { summary: v, modelUsed: 'stub', sourceMessageCount: 1 };
    },
    getContextWindow() { return 32_000; },
    getAutoCompactThreshold() { return 16_000; },
  };
  return { provider, calls: () => i };
}

const CONFIG = (over: Partial<ChatAutoCompactConfig> = {}): ChatAutoCompactConfig => ({
  enabled: true,
  triggerRatio: 0,       // fire whenever there's any history
  preserveLastN: 2,
  partial: true,
  ...over,
});

describe('rewriteSessionMessages', () => {
  test('replaces history atomically and updates messageCount', () => {
    const id = seed(4);
    expect(loadSession(id, root)!.messages).toHaveLength(4);

    const replacement: SerializedMessage[] = [
      { role: 'system', content: 'summary', ts: new Date().toISOString() },
      { role: 'user', content: 'tail', ts: new Date().toISOString() },
    ];
    const meta = rewriteSessionMessages(id, replacement, root);

    const after = loadSession(id, root)!;
    expect(after.messages).toHaveLength(2);
    expect(after.messages[0]!.role).toBe('system');
    expect(after.messages[0]!.content).toBe('summary');
    expect(meta.messageCount).toBe(2);
    expect(after.meta.messageCount).toBe(2);
  });

  test('empty replacement yields an empty session', () => {
    const id = seed(3);
    rewriteSessionMessages(id, [], root);
    expect(loadSession(id, root)!.messages).toHaveLength(0);
  });

  test('throws for unknown session', () => {
    expect(() => rewriteSessionMessages('nope', [], root)).toThrow(/session not found/);
  });
});

describe('compactSessionHistory', () => {
  test('skips below threshold', async () => {
    const id = seed(6);
    const { provider, calls } = stubProvider(['S']);
    const r = await compactSessionHistory(id, {
      modelId: 'test-model',
      config: CONFIG({ triggerRatio: 1.5 }), // impossible ratio → skip
      provider,
      root,
    });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('under-threshold');
    expect(calls()).toBe(0);
    expect(loadSession(id, root)!.messages).toHaveLength(6); // untouched
  });

  test('skips when disabled', async () => {
    const id = seed(6);
    const { provider } = stubProvider(['S']);
    const r = await compactSessionHistory(id, {
      config: CONFIG({ enabled: false }),
      provider,
      root,
    });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('disabled');
  });

  // force — the external `elanous session compact --force` trigger bypasses the
  // token-ratio gate and compacts unconditionally (runs Layer3 summarize).
  test('force bypasses the token-ratio gate below threshold', async () => {
    const id = seed(6);
    const { provider, calls } = stubProvider(['FORCED-SUMMARY']);
    const r = await compactSessionHistory(id, {
      modelId: 'test-model',
      config: CONFIG({ triggerRatio: 1.5 }),  // impossible → auto would skip
      provider,
      force: true,
      root,
    });
    expect(r.fired).toBe(true);            // forced despite under-threshold
    expect(calls()).toBeGreaterThan(0);    // Layer3 summarizer ran
    const after = loadSession(id, root)!;
    expect(after.messages.length).toBeLessThan(6);
    expect(after.messages[0]!.content).toContain('FORCED-SUMMARY');
  });

  test('force is a no-op when auto would skip and force is not set', async () => {
    const id = seed(6);
    const { provider } = stubProvider(['S']);
    const r = await compactSessionHistory(id, {
      config: CONFIG({ triggerRatio: 1.5 }),
      provider,
      root,   // force omitted → gated
    });
    expect(r.fired).toBe(false);
    expect(loadSession(id, root)!.messages).toHaveLength(6);
  });

  test('fires and rewrites history to [summary, …tail]', async () => {
    const id = seed(6);
    const { provider } = stubProvider(['COMPACTED']);
    const r = await compactSessionHistory(id, {
      modelId: 'test-model',
      config: CONFIG(),
      provider,
      root,
    });
    expect(r.fired).toBe(true);
    expect(r.layer3Applied).toBe(true);
    expect(r.after).toBeLessThan(r.before);
    expect(r.overflowRetries).toBe(0);

    const after = loadSession(id, root)!.messages;
    expect(after[0]!.role).toBe('system');
    expect(after[0]!.content).toContain('COMPACTED');
    // preserveLastN=2 tail preserved verbatim.
    expect(after[after.length - 1]!.content).toContain('msg-5');
  });

  test('codex #1 — drop-oldest retry when summarizer overflows', async () => {
    const id = seed(8);
    // First two summarize calls "overflow" (null); the third succeeds.
    const { provider, calls } = stubProvider([null, null, 'RECOVERED']);
    const r = await compactSessionHistory(id, {
      modelId: 'test-model',
      config: CONFIG(),
      provider,
      maxOverflowRetries: 5,
      root,
    });
    expect(r.fired).toBe(true);
    expect(r.overflowRetries).toBe(2);
    expect(calls()).toBe(3);
    expect(loadSession(id, root)!.messages[0]!.content).toContain('RECOVERED');
  });

  test('gives up cleanly after maxOverflowRetries without mutating history', async () => {
    const id = seed(8);
    const { provider } = stubProvider([null]); // always overflow
    const r = await compactSessionHistory(id, {
      modelId: 'test-model',
      config: CONFIG(),
      provider,
      maxOverflowRetries: 2,
      root,
    });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('no-op');
    expect(r.overflowRetries).toBe(2);
    expect(loadSession(id, root)!.messages).toHaveLength(8); // untouched
  });

  test('session-not-found is a safe no-op', async () => {
    const r = await compactSessionHistory('ghost', { config: CONFIG(), root });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('session-not-found');
  });
});
