import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMOpts, LLMProvider } from '../llm.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { clearSessionTierOverride, setSessionTierOverride } from '../model-tier/session-override.js';
import { createSession } from './index.js';
import { runTurn } from './chat.js';

let previousRoot: string | undefined;
let root: string;
const sessions: string[] = [];

beforeEach(() => {
  previousRoot = process.env.ELANOUS_SESSION_ROOT;
  root = mkdtempSync(join(tmpdir(), 'elanous-chat-turn-tier-'));
  process.env.ELANOUS_SESSION_ROOT = root;
});

afterEach(() => {
  for (const session of sessions.splice(0)) clearSessionTierOverride(session);
  if (previousRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
  else process.env.ELANOUS_SESSION_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('runTurn explicit model tier', () => {
  async function turn(modelTier?: object, llmOpts?: LLMOpts, sessionTier?: 'best') {
    const seen: LLMOpts[] = [];
    const provider: LLMProvider = {
      name: 'openai-codex', defaultModel: 'original-default', available: () => true,
      async *chat(_messages, opts) { seen.push(opts ?? {}); yield 'ok'; },
      async *streamChat(_messages, opts) { seen.push(opts ?? {}); yield { type: 'text', delta: 'ok' } as const; },
    };
    const cfg = { llm: { provider: 'openai-codex', model: 'original-default' }, modelTier } as never;
    const session = createSession({ source: 'cli', provider: provider.name, model: provider.defaultModel });
    sessions.push(session.id);
    if (sessionTier) setSessionTierOverride(session.id, { llm: sessionTier, rationale: 'user choice' });
    const result = await runTurn({
      userConfig: cfg, sessionId: session.id, userText: 'hello', provider,
      skipMemoryInjection: true, llmOpts,
    });
    return { seen, result, llmOpts };
  }

  test('session tier reaches the provider and result', async () => {
    const { seen, result } = await turn({ llm: 'budget' }, undefined, 'best');
    const model = lookupLlmTierSpec('openai-codex', 'best').model;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe(model);
    expect(result.model).toBe(model);
  });

  test('the tier reasoning effort reaches the provider; a caller effort wins', async () => {
    const better = await turn({ llm: 'better' });
    expect(better.seen[0]?.reasoningEffort).toBe('medium');
    const best = await turn(undefined, undefined, 'best');
    expect(best.seen[0]?.reasoningEffort).toBe('high');
    const callerEffort = await turn({ llm: 'best' }, { reasoningEffort: 'low' });
    expect(callerEffort.seen[0]?.reasoningEffort).toBe('low');
  });

  test('config tier reaches the provider unless the caller pins a model', async () => {
    const tier = await turn({ llm: 'budget' });
    expect(tier.seen[0]?.model).toBe(lookupLlmTierSpec('openai-codex', 'budget').model);
    expect(tier.result.model).toBe(lookupLlmTierSpec('openai-codex', 'budget').model);

    const pin: LLMOpts = { model: 'pinned-model', temperature: 0.2 };
    const pinned = await turn({ llm: 'budget' }, pin, 'best');
    expect(pinned.seen[0]).toEqual(pin);
    expect(pinned.result.model).toBe('pinned-model');
    expect(pinned.llmOpts).toEqual(pin);
  });

  test('implicit tier leaves provider opts and default model untouched', async () => {
    const { seen, result } = await turn({ preset: 'a-preset' });
    expect(seen).toEqual([{}]);
    expect(result.model).toBe('original-default');
  });
});
