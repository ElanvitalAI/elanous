// ── Wave 4 · CompactProvider ──

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDefaultCompactProvider,
  resolveSummarizerModel,
  runCompactPipeline,
  COMPACT_UNKNOWN_MODEL_CONTEXT_WINDOW,
  type CompactProvider,
} from '../src/compact';
import type { LLMMessage } from '../src/llm';
import { BUILTIN_CATALOG } from '../src/intelligence-map/model-catalog';

function archDir(): string {
  return mkdtempSync(join(tmpdir(), 'compact-prov-'));
}

describe('Wave 4 · resolveSummarizerModel', () => {
  test('explicit override wins', () => {
    expect(resolveSummarizerModel('claude-opus-4-7', 'haiku-override')).toBe('haiku-override');
  });

  // SELF-summarize always (codex-faithful: ref/codex compacts on the session's
  // own model, never a downshift). No summarizerModelHint / family downshift —
  // opus summarizes with opus, terra with terra. Always provider-compatible.
  test('self-summarize with the active model', () => {
    expect(resolveSummarizerModel('claude-opus-4-7')).toBe('claude-opus-4-7');  // NOT haiku
    expect(resolveSummarizerModel('gpt-5.6-terra')).toBe('gpt-5.6-terra');      // codex → self, never gpt-4o-mini
    expect(resolveSummarizerModel('gpt-4o')).toBe('gpt-4o');
    expect(resolveSummarizerModel('grok-4.5')).toBe('grok-4.5');
    expect(resolveSummarizerModel('phantom-not-in-catalog')).toBe('phantom-not-in-catalog');
  });
});

describe('Wave 4 · getDefaultCompactProvider', () => {
  test('exposes contract methods', () => {
    const p = getDefaultCompactProvider();
    expect(typeof p.summarize).toBe('function');
    expect(typeof p.getContextWindow).toBe('function');
    expect(typeof p.getAutoCompactThreshold).toBe('function');
  });

  // ⛔ 옛 판은 모델 «이름»을 얼렸다(`claude-opus-4-7` · `claude-sonnet-4-6`).
  //    카탈로그가 나아가자 그 이름이 사라졌고 미지 폴백 32_000 이 돌아와 빨개졌다
  //    — 「기능이 깨졌다」가 아니라 ***「자가 늙었다」***다(🅕 30차 §5e 전수 분류).
  //    ⇒ 이름 대신 «카탈로그 자체»를 대서, 이름이 또 바뀌어도 계약만 문다.
  test('getContextWindow reads catalog entries', () => {
    const p = getDefaultCompactProvider();
    expect(BUILTIN_CATALOG.models.length).toBeGreaterThan(0);   // ⛔ 모집단 0이면 아래는 «공허참»
    for (const entry of BUILTIN_CATALOG.models) {
      expect(p.getContextWindow(entry.id)).toBe(entry.contextWindow);
    }
    // 미지 모델 = 폴백. ⛔ 카탈로그에 «없는» 이름이어야 의미가 있다.
    expect(BUILTIN_CATALOG.models.some((m) => m.id === 'phantom')).toBe(false);
    expect(p.getContextWindow('phantom')).toBe(COMPACT_UNKNOWN_MODEL_CONTEXT_WINDOW);
  });

  test('getAutoCompactThreshold = 50% of (ctx − reserved) by default', () => {
    const p = getDefaultCompactProvider();
    // ⛔ 여기도 이름을 얼리지 않는다 — 「(ctx − reserved) 의 50%」라는 «관계»를 문다.
    for (const entry of BUILTIN_CATALOG.models) {
      const reserved = entry.reservedOutputTokens ?? 0;
      expect(p.getAutoCompactThreshold(entry.id))
        .toBe(Math.max(1, Math.floor((entry.contextWindow - reserved) * 0.5)));
    }
    // unknown: 32K · 50% = 16K
    // ⛔ 여기도 매직 넘버를 다시 적지 않는다 — 폴백엔 reserved 가 «없으므로» ctx 의 50% 다.
    expect(p.getAutoCompactThreshold('phantom'))
      .toBe(Math.max(1, Math.floor(COMPACT_UNKNOWN_MODEL_CONTEXT_WINDOW * 0.5)));
  });

  test('summarize returns null when there are no source messages', async () => {
    const p = getDefaultCompactProvider();
    const result = await p.summarize({
      messages: [
        { role: 'user', content: 'recent-1' },
        { role: 'assistant', content: 'recent-2' },
      ],
      preserveLastN: 4,
    });
    expect(result).toBeNull();
  });
});

describe('Wave 4 · pipeline Layer 3 integration', () => {
  test('Layer 3 skipped when no provider supplied', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
    ];
    const r = await runCompactPipeline(messages, {
      policy: { archiveDir: archDir() },
    });
    expect(r.diagnostics.layer3SummaryApplied).toBe(0);
  });

  test('Layer 3 fires + replaces pre-tail slice with summary system msg', async () => {
    const fakeProvider: CompactProvider = {
      summarize: async () => ({
        summary: 'mock summary text',
        modelUsed: 'mock-haiku',
        sourceMessageCount: 4,
      }),
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };

    const messages: LLMMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      messages.push({
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `msg ${i}`,
      });
    }
    const r = await runCompactPipeline(messages, {
      policy: { archiveDir: archDir(), preserveLastN: 4 },
      provider: fakeProvider,
      activeModelId: 'claude-opus-4-7',
    });
    expect(r.diagnostics.layer3SummaryApplied).toBe(1);
    expect(r.diagnostics.layer3SummaryModel).toBe('mock-haiku');
    expect(r.diagnostics.layer3SummaryChars).toBe('mock summary text'.length);
    // 1 summary system message + COMPACT P0 structurally preserved slice users (3) + last 4 turns
    expect(r.messages).toHaveLength(8);
    expect(r.messages[0]?.role).toBe('system');
    expect(r.messages[0]?.content).toContain('mock summary text');
    // ★ COMPACT P0 (OP #123867) — slice users (msg 1/3/5) survive verbatim right after the summary.
    expect(r.messages[1]?.role).toBe('user');
    expect(r.messages[1]?.content).toBe('msg 1');
    expect(r.messages[2]?.role).toBe('user');
    expect(r.messages[2]?.content).toBe('msg 3');
    expect(r.messages[3]?.role).toBe('user');
    expect(r.messages[3]?.content).toBe('msg 5');
    // Tail preserved verbatim
    expect(r.messages[7]?.content).toBe('msg 10');
  });

  test('Layer 3 returning null leaves Layer 1+2 result intact', async () => {
    const failingProvider: CompactProvider = {
      summarize: async () => null,
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    const messages: LLMMessage[] = [];
    for (let i = 1; i <= 6; i++) {
      messages.push({ role: i % 2 === 1 ? 'user' : 'assistant', content: `m${i}` });
    }
    const r = await runCompactPipeline(messages, {
      policy: { archiveDir: archDir(), preserveLastN: 2 },
      provider: failingProvider,
    });
    expect(r.diagnostics.layer3SummaryApplied).toBe(0);
    expect(r.messages).toHaveLength(6);
  });

  test('hint forwarded to provider.summarize', async () => {
    let capturedHint: string | undefined;
    const captureProvider: CompactProvider = {
      summarize: async (args) => {
        capturedHint = args.hint;
        return { summary: 'x', sourceMessageCount: 1 };
      },
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    await runCompactPipeline(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: 'd' },
      ],
      {
        policy: { archiveDir: archDir(), preserveLastN: 1 },
        provider: captureProvider,
        summaryHint: 'preserve scratchpad references',
      },
    );
    expect(capturedHint).toBe('preserve scratchpad references');
  });

  test('preserveFirst pins the anchor (first user msg) verbatim — not summarized', async () => {
    // ★ 핵심 앵커 보존 — 첫 user 메시지(페이즈 프롬프트/WM/premise)는 요약으로 뭉개지 않고 원문 유지.
    let capturedTranscriptCount = -1;
    const fakeProvider: CompactProvider = {
      summarize: async (args) => {
        capturedTranscriptCount = args.preserveFirst ?? 0;
        return { summary: 'MID SUMMARY', modelUsed: 'mock', sourceMessageCount: 2 };
      },
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    const messages: LLMMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      messages.push({ role: i % 2 === 1 ? 'user' : 'assistant', content: `PHASE-PROMPT-ANCHOR msg ${i}` });
    }
    const r = await runCompactPipeline(messages, {
      policy: { archiveDir: archDir(), preserveLastN: 4, preserveFirst: 1 },
      provider: fakeProvider,
    });
    expect(r.diagnostics.layer3SummaryApplied).toBe(1);
    // Anchor (msg 1) kept verbatim as the FIRST message; summary follows.
    expect(r.messages[0]?.role).toBe('user');
    expect(r.messages[0]?.content).toBe('PHASE-PROMPT-ANCHOR msg 1');
    expect(r.messages[1]?.role).toBe('system');
    expect(r.messages[1]?.content).toContain('MID SUMMARY');
    // Tail preserved verbatim.
    expect(r.messages[r.messages.length - 1]?.content).toBe('PHASE-PROMPT-ANCHOR msg 10');
    // Provider was told to exclude the anchor from its summary transcript.
    expect(capturedTranscriptCount).toBe(1);
  });

  test('preserveFirst=0 (default) leaves anchor in the summary slice — no pin (backwards-compat)', async () => {
    const fakeProvider: CompactProvider = {
      summarize: async () => ({ summary: 'S', modelUsed: 'mock', sourceMessageCount: 6 }),
      getContextWindow: () => 200_000,
      getAutoCompactThreshold: () => 100_000,
    };
    const messages: LLMMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      messages.push({ role: i % 2 === 1 ? 'user' : 'assistant', content: `msg ${i}` });
    }
    const r = await runCompactPipeline(messages, {
      policy: { archiveDir: archDir(), preserveLastN: 4 }, // preserveFirst defaults to 0
      provider: fakeProvider,
    });
    // First message is the summary (anchor NOT pinned) — original behavior.
    expect(r.messages[0]?.role).toBe('system');
    // ★ COMPACT P0 (OP #123867) — 8 = 1 summary + 3 preserved slice users + 4 tail.
    expect(r.messages).toHaveLength(8);
    const userTexts = r.messages
      .filter(m => m.role === 'user')
      .map(m => (typeof m.content === 'string' ? m.content : ''));
    expect(userTexts).toContain('msg 1');
    expect(userTexts).toContain('msg 3');
    expect(userTexts).toContain('msg 5');
    expect(userTexts).toHaveLength(5); // 3 preserved slice users + 2 tail users (msg 7, msg 9)
  });
});
