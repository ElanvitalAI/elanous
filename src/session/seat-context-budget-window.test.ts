// SEAT-CONTEXT-BUDGET-WINDOW — harness ablation 11-26: a ~25k fixed prefix vs the flat 24k input cap left the
// OP seat with only the current CEO line (ablation B 0/5; previous turn restored 5/5).
// Sim + synthetic events, seeds 3: huge prefix + 30 turns · mail flood · compaction mid-turn · /new ·
// small-window model. Expected values are independent literals (not product constants).

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage, LLMProvider } from '../llm.js';
import { debug } from '../debug/log.js';
import { estimateMessagesTokens } from '../tokens.js';
import * as actualUserIntent from '../user-intent/index.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import type { CompactProvider } from '../compact/provider.js';
import { appendMessage, createSession, type SerializedMessage } from './index.js';
import { runTurn } from './chat.js';
import { isHumanSourceRow, resolveTurnInputCap, shouldCompactForWindow, trimKeepingRecentHumans } from './turn-budget.js';

const SEEDS = [11, 26, 507];
const PREFIX_CHARS = 100_000; // ≈25k tokens (ASCII /4) — the OP fixed prefix measured by the ablation

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

type Row = LLMMessage & { human?: boolean };

/** Synthetic seat session: anchor, then `turns` CEO/assistant pairs with `mailEvery` mail notices in between. */
function simWire(seed: number, turns: number, opts: { mailFlood?: number; summary?: boolean } = {}): Row[] {
  const r = rng(seed);
  const wire: Row[] = [{ role: 'system', content: 'P'.repeat(PREFIX_CHARS) }];
  if (opts.summary) wire.push({ role: 'system', content: `summary ${'s'.repeat(2_000)}` });
  wire.push({ role: 'user', content: `anchor ${seed}`, human: true });
  wire.push({ role: 'assistant', content: 'anchor ack' });
  for (let t = 1; t <= turns; t++) {
    for (let m = 0; m < (opts.mailFlood ?? 0); m++) {
      wire.push({ role: 'user', content: `[seat-mail #${seed}-${t}-${m}] ${'x'.repeat(800 + Math.floor(r() * 2_000))}` });
      wire.push({ role: 'assistant', content: `mail ack ${'a'.repeat(400)}` });
    }
    wire.push({ role: 'user', content: `CEO-${t} ${'c'.repeat(200 + Math.floor(r() * 600))}`, human: true });
    wire.push({ role: 'assistant', content: `REPLY-${t} ${'r'.repeat(1_000 + Math.floor(r() * 3_000))}` });
  }
  wire.push({ role: 'system', content: `volatile ${'v'.repeat(4_000)}`, cacheVolatile: true });
  wire.push({ role: 'user', content: 'CEO-NOW', human: true });
  return wire;
}

function run(wire: Row[], window: number | null) {
  const prefix = estimateMessagesTokens(wire.filter((m, i) => m.role === 'system' && (i === 0 || m.cacheVolatile)));
  const cap = resolveTurnInputCap({ window, prefixTokens: prefix, outputTokens: 8_000 });
  const res = trimKeepingRecentHumans(wire, cap.cap, estimateMessagesTokens, i => wire[i]!.human === true);
  const texts = res.kept.map(m => String(m.content));
  return { cap, res, texts, prefix };
}

describe('resolveTurnInputCap', () => {
  test('cap sits on top of the prefix (272k window · 25k prefix)', () => {
    const c = resolveTurnInputCap({ window: 272_000, prefixTokens: 25_000, outputTokens: 8_000 });
    expect(c.historyAllowance).toBe(48_000);
    expect(c.cap).toBe(73_000);
  });
  test('small window: the floor is clamped to the real window (prefix + history + output ≤ window)', () => {
    const c = resolveTurnInputCap({ window: 32_000, prefixTokens: 25_000, outputTokens: 4_000 });
    expect(c.historyAllowance).toBe(3_000);
    expect(c.cap).toBe(28_000);
  });
  test('no room at all: allowance 0, cap = prefix (the trim then reports overBudget)', () => {
    const c = resolveTurnInputCap({ window: 32_000, prefixTokens: 26_000, outputTokens: 8_000 });
    expect(c.historyAllowance).toBe(0);
    expect(c.cap).toBe(26_000);
  });
  test('roomy window keeps the floor', () => {
    const c = resolveTurnInputCap({ window: 64_000, prefixTokens: 40_000, outputTokens: 8_000 });
    expect(c.historyAllowance).toBe(8_000);
    expect(c.cap).toBe(48_000);
  });
  test('legacy rows without `from`: plain user rows are human, tool results are not', () => {
    expect(isHumanSourceRow({ role: 'user' })).toBe(true);
    expect(isHumanSourceRow({ role: 'user', toolResult: 'x' })).toBe(false);
    expect(isHumanSourceRow({ role: 'user', toolCallId: 'c1' })).toBe(false);
    expect(isHumanSourceRow({ role: 'user', from: { kind: 'seat' } })).toBe(false);
    expect(isHumanSourceRow({ role: 'user', from: { kind: 'human' } })).toBe(true);
    expect(isHumanSourceRow({ role: 'assistant' })).toBe(false);
  });
  test('unknown window = 24k history on top of the prefix', () => {
    expect(resolveTurnInputCap({ window: null, prefixTokens: 25_000 }).cap).toBe(49_000);
  });
  test('window trigger: record ≥ 50% of history share or input ≥ 85% of cap', () => {
    const c = resolveTurnInputCap({ window: 272_000, prefixTokens: 25_000, outputTokens: 8_000 });
    expect(shouldCompactForWindow(23_999, 30_000, c)).toBe(false);
    expect(shouldCompactForWindow(24_000, 30_000, c)).toBe(true);
    expect(shouldCompactForWindow(1_000, 62_050, c)).toBe(true);
  });
});

describe('sim · seeds × scenarios', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed} · huge prefix + 30 turns: last 6 CEO turns and their replies stay`, () => {
      const { res, texts, cap } = run(simWire(seed, 30), 272_000);
      for (let t = 25; t <= 30; t++) {
        expect(texts.some(x => x.startsWith(`CEO-${t} `))).toBe(true);
        expect(texts.some(x => x.startsWith(`REPLY-${t} `))).toBe(true);
      }
      expect(texts).toContain('CEO-NOW');
      expect(texts).toContain(`anchor ${seed}`);
      expect(res.keptHumanTurns).toBeGreaterThanOrEqual(7);
      expect(res.used).toBeLessThanOrEqual(cap.cap);
      expect(res.used).toBeLessThanOrEqual(80_000); // cost envelope: 25k prefix + ≤ 48k history + slack
    });

    test(`seed ${seed} · mail flood: notices go first, CEO lines survive`, () => {
      const { texts, res } = run(simWire(seed, 30, { mailFlood: 6 }), 272_000);
      for (let t = 25; t <= 30; t++) expect(texts.some(x => x.startsWith(`CEO-${t} `))).toBe(true);
      expect(res.dropped).toBeGreaterThan(0);
      expect(texts.some(x => x.startsWith(`[seat-mail #${seed}-1-`))).toBe(false); // oldest notices go first
      expect(res.used).toBeLessThanOrEqual(73_000 + 1_000);
    });

    test(`seed ${seed} · compaction mid-turn (summary row): summary + recent humans kept`, () => {
      const { texts } = run(simWire(seed, 30, { summary: true }), 272_000);
      expect(texts.some(x => x.startsWith('summary '))).toBe(true);
      for (let t = 25; t <= 30; t++) expect(texts.some(x => x.startsWith(`CEO-${t} `))).toBe(true);
    });

    test(`seed ${seed} · /new: empty history, nothing dropped`, () => {
      const wire: Row[] = [{ role: 'system', content: 'P'.repeat(PREFIX_CHARS) }, { role: 'user', content: 'CEO-NOW', human: true }];
      const { res } = run(wire, 272_000);
      expect(res.dropped).toBe(0);
      expect(res.keptHumanTurns).toBe(1);
    });

    test(`seed ${seed} · small-window model (32k) with a 26k prefix + 8k output: no room → overBudget, humans kept`, () => {
      const { texts, res, cap } = run(simWire(seed, 30), 32_000);
      expect(cap.historyAllowance).toBe(0);
      expect(res.overBudget).toBe(true);
      for (let t = 26; t <= 30; t++) expect(texts.some(x => x.startsWith(`CEO-${t} `))).toBe(true);
      expect(texts).toContain('CEO-NOW');
    });
  }

  test('no unbounded growth: 300 turns cost the same as 30', () => {
    const a = run(simWire(26, 30), 272_000).res.used;
    const b = run(simWire(26, 300), 272_000).res.used;
    expect(a).toBeLessThanOrEqual(75_000);
    expect(b).toBeLessThanOrEqual(75_000);
  });
});

// ── runTurn integration: the request as sent keeps the CEO history under a 25k prefix ─────────────
let root = '';
const saved: Record<string, string | undefined> = {};
const intentSpy = spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never));
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'seat-ctx-window-'));
  for (const k of ['HOME', 'ELANOUS_SESSION_ROOT']) saved[k] = process.env[k];
  process.env.HOME = root;
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
});
afterAll(() => {
  intentSpy.mockRestore();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
  resetAutoCompactStateForTest();
});

describe('runTurn · 25k prefix', () => {
  test('previous CEO turns reach the provider; session.trim is logged', async () => {
    const requests: LLMMessage[][] = [];
    const provider: LLMProvider = {
      name: 'seat-ctx', defaultModel: 'gpt-5.4', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(messages) { requests.push(structuredClone(messages)); yield { type: 'text', delta: 'ok' }; },
    };
    const summarizer: CompactProvider = {
      async summarize(args) { return { summary: 'fake summary', modelUsed: 'fake', sourceMessageCount: args.messages.length }; },
      getContextWindow: () => 272_000,
      getAutoCompactThreshold: () => 0.85,
    };
    const session = createSession({ source: 'cli', provider: provider.name, model: provider.defaultModel });
    for (let t = 1; t <= 3; t++) {
      appendMessage(session.id, { role: 'user', content: `판정국도 재편 ${t}`, ts: new Date().toISOString(), from: { kind: 'human' } } as SerializedMessage);
      appendMessage(session.id, { role: 'assistant', content: `답 ${t}`, ts: new Date().toISOString() } as SerializedMessage);
    }
    const log = spyOn(debug, 'log');
    try {
      await runTurn({
        userConfig: { chat: { autoCompact: { enabled: false } }, llm: { provider: provider.name, model: provider.defaultModel, memoryJudge: { enabled: false, crossRecall: false } } } as never,
        sessionId: session.id, userText: 'claude op 에 이내용 물어봐주세요', systemPrompt: 'P'.repeat(PREFIX_CHARS),
        skipMemoryInjection: true, provider, compactProvider: summarizer, from: { kind: 'human' },
      } as never);
    } finally { log.mockRestore(); }
    const sent = requests[0]!.map(m => String(m.content));
    expect(sent).toContain('판정국도 재편 3');
    expect(sent).toContain('답 3');
    expect(sent).toContain('판정국도 재편 1');
    expect(JSON.stringify(requests[0]!.at(-1)!.content)).toContain('claude op 에 이내용 물어봐주세요'); // CEO-UTTERANCE-TAGGED-LAST envelope (#40206)
  });
});
describe('over budget without a compaction', () => {
  test('explicit maxTokens below the protected rows: turn stops, no request is sent', async () => {
    const requests: LLMMessage[][] = [];
    const provider: LLMProvider = {
      name: 'seat-ctx-ob', defaultModel: 'gpt-5.4', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(messages) { requests.push(structuredClone(messages)); yield { type: 'text', delta: 'ok' }; },
    };
    const session = createSession({ source: 'cli', provider: provider.name, model: provider.defaultModel });
    appendMessage(session.id, { role: 'user', content: 'legacy human line', ts: new Date().toISOString() } as SerializedMessage);
    let err = '';
    try {
      await runTurn({
        userConfig: { chat: { autoCompact: { enabled: false } }, llm: { provider: provider.name, model: provider.defaultModel, memoryJudge: { enabled: false, crossRecall: false } } } as never,
        sessionId: session.id, userText: 'now', systemPrompt: 'P'.repeat(40_000), maxTokens: 1_000,
        skipMemoryInjection: true, provider, from: { kind: 'human' },
      } as never);
    } catch (e) { err = String(e); }
    expect(err).toContain('문맥 예산 초과');
    expect(requests.length).toBe(0);
  });
});
