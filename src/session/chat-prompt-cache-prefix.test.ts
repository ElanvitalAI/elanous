// O4 OP-LONG-SESSION-COMPACT — prompt-cache prefix stability across turns + per-call cache ledger.
//
// Fake provider (no live call). Each turn gets a DIFFERENT memory recall and self-log recall (with
// timestamps). The request prefix (system prompt + replayed history) must stay byte-identical from
// one turn to the next; only the single `cacheVolatile` system message right before the latest user
// message may change. Checked on the serialized requests, not on a filtered view. The provider's cache usage must land in the llm.usage row with the session id.

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messagesToResponsesInput, type LLMMessage, type LLMOpts, type LLMProvider } from '../llm.js';
import { debug } from '../debug/log.js';
import * as actualMemory from '../memory.js';
import * as actualSurfaceEvents from '../domains/surface-events.js';
import * as actualUserIntent from '../user-intent/index.js';
import { createSession } from './index.js';

let recallTurn = 0;
const spies = [
  spyOn(actualMemory, 'buildMemoryInjection').mockImplementation(() => ({ block: `## memory\nrecall for turn ${recallTurn}`, tokens: 8, injectedIds: [] })),
  spyOn(actualMemory, 'buildMemoryInjectionLLM').mockImplementation(async () => ({ block: `## memory\nrecall for turn ${recallTurn}`, tokens: 8, injectedIds: [] })),
  spyOn(actualSurfaceEvents, 'openSurfaceEventsDb').mockImplementation(() => ({ close() {} } as never)),
  spyOn(actualSurfaceEvents, 'recallEvents').mockImplementation(() => [
    { ts: `2026-11-17T0${recallTurn}:00:00.000Z`, surface: 'tui', summary: `activity ${recallTurn}` } as never,
  ]),
  spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never)),
];

const { runTurn, withTurnVolatileContext } = await import('./chat.js');

const STABLE_SYSTEM = 'O4 stable system prompt';
const CACHE_READ = 1_500;
const UNCACHED = 120;
let root = '';
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'o4-compact-cache-prefix-'));
  for (const key of ['HOME', 'ELANOUS_SESSION_ROOT']) savedEnv[key] = process.env[key];
  process.env.HOME = root;
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Request N with its volatile message and its latest user message stripped (the shared prefix). */
const sharedPrefixOf = (messages: LLMMessage[]): LLMMessage[] => {
  const v = messages.findIndex(message => message.cacheVolatile === true);
  return v < 0 ? messages.slice(0, -1) : messages.slice(0, v);
};
/** A JSON array serialization minus its closing bracket — a byte prefix of any longer array that starts the same. */
const openArray = (value: unknown[]): string => JSON.stringify(value).slice(0, -1);

describe('O4 prompt-cache prefix', () => {
  test('withTurnVolatileContext puts one cacheVolatile system message immediately before the latest user message', () => {
    const wire = withTurnVolatileContext([
      { role: 'system', content: STABLE_SYSTEM },
      { role: 'user', content: 'now' },
    ], ['a', '', 'b']);
    expect(wire).toEqual([
      { role: 'system', content: STABLE_SYSTEM },
      { role: 'system', content: 'a\n\nb', cacheVolatile: true },
      { role: 'user', content: 'now' },
    ]);
    expect(withTurnVolatileContext([{ role: 'user', content: 'x' }], [])).toEqual([{ role: 'user', content: 'x' }]);
  });

  test('per-turn recall never rewrites the system prompt or history, and cache tokens reach the ledger', async () => {
    const calls: Array<{ messages: LLMMessage[]; opts: LLMOpts }> = [];
    const provider: LLMProvider = {
      name: 'o4-prefix-provider',
      defaultModel: 'o4-prefix-model',
      available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(messages, opts = {}) {
        calls.push({ messages: structuredClone(messages), opts });
        yield { type: 'text', delta: `answer ${calls.length}` } as const;
        yield { type: 'usage', usage: { inputTokens: UNCACHED, cacheReadInputTokens: CACHE_READ, outputTokens: 3 } } as const;
      },
    };
    const userConfig = {
      chat: {},
      llm: { provider: provider.name, model: provider.defaultModel, goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: true } },
    } as never;
    const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'cli' });
    const log = spyOn(debug, 'log');
    try {
      for (recallTurn = 1; recallTurn <= 3; recallTurn++) {
        await runTurn({ userConfig, sessionId: session.id, userText: `turn ${recallTurn}: keep going`, systemPrompt: STABLE_SYSTEM, provider });
      }
      expect(calls).toHaveLength(3);
      for (const [index, call] of calls.entries()) {
        // (a) V sits directly before the latest user message in every request.
        expect(call.messages[0]).toEqual({ role: 'system', content: STABLE_SYSTEM });
        const volatile = call.messages.filter(message => message.cacheVolatile === true);
        expect(volatile).toHaveLength(1);
        expect(call.messages.at(-2)).toBe(volatile[0]!);
        expect(String(volatile[0]!.content)).toContain(`recall for turn ${index + 1}`);
        expect(call.messages.at(-1)).toMatchObject({ role: 'user', content: `turn ${index + 1}: keep going` });
      }
      // (b) Request N with V and U_n stripped is a byte prefix of request N+1 — on the serialized
      // provider input and on the Codex Responses wire.
      for (let index = 1; index < calls.length; index++) {
        const shared = sharedPrefixOf(calls[index - 1]!.messages);
        const next = calls[index]!.messages;
        expect(JSON.stringify(next).startsWith(openArray(shared))).toBe(true);
        // Codex: serialize request N itself and cut at the item that carries V (a developer item).
        const previousWire = messagesToResponsesInput(calls[index - 1]!.messages, { stablePrefix: true });
        const nextWire = messagesToResponsesInput(next, { stablePrefix: true });
        const previousInput = previousWire.input as unknown[];
        const vAt = previousInput.findIndex(item => JSON.stringify(item).includes(`recall for turn ${index}`));
        expect(vAt).not.toBe(-1);
        expect(nextWire.instructions).toBe(previousWire.instructions);
        expect(JSON.stringify(nextWire.input).startsWith(openArray(previousInput.slice(0, vAt)))).toBe(true);
      }
      // Session-derived cache affinity and the per-call cache ledger.
      expect(calls.every(call => call.opts.sessionId === session.id)).toBe(true);
      const usageRows = log.mock.calls.filter(call => call[0] === 'llm.usage' && call[1] === 'llm-usage')
        .map(call => call[2] as Record<string, unknown>);
      expect(usageRows).toHaveLength(3);
      for (const row of usageRows) {
        expect(row).toMatchObject({ sessionId: session.id, cacheReadInputTokens: CACHE_READ, inputTokens: UNCACHED });
      }
    } finally {
      log.mockRestore();
    }
  });
});
