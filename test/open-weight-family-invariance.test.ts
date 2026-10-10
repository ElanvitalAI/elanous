// OR-FAMILY-DISCIPLINE invariance — the new 'open-weight' family must not move a single byte
// for any id outside it. Expected values below were measured on origin/main b9c25abcfc
// (before the family existed) with this same fingerprint function; if one of them moves,
// a codex · claude · grok · gpt · gemini · local · other path changed.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { resolveToolDiscipline, selectIntentClassificationMessages, streamLLMWithTools } from '../src/llm';
import type { LLMMessage, LLMProvider } from '../src/llm';
import { getModelFamily, getModelPromptAddon } from '../src/models/prompts';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

async function firstTurnSha(model: string): Promise<string> {
  const captured: LLMMessage[][] = [];
  const provider: LLMProvider = {
    name: 'capturing',
    defaultModel: 'd',
    available: () => true,
    async *streamChat(messages) {
      captured.push(messages.map(message => ({ ...message })));
      yield { type: 'text', delta: 'done' } as const;
    },
    async *chat() {},
  };
  await streamLLMWithTools(
    [{ role: 'system', content: 'caller system' }, { role: 'user', content: 'go' }],
    { onText() {}, dispatchTool: async () => 'ok' },
    { provider, tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }], maxTurns: 2, model },
  );
  const transmitted = captured[0] ?? [];
  return sha(JSON.stringify({
    transmitted,
    intent: selectIntentClassificationMessages(transmitted),
  }));
}

async function fingerprint(model: string) {
  const family = getModelFamily(model);
  const discipline = resolveToolDiscipline(family);
  return {
    family,
    addon: sha(getModelPromptAddon(model)),
    discipline: discipline === null ? null : sha(discipline),
    firstTurn: await firstTurnSha(model),
  };
}

// One representative id per pre-existing family, plus ids that sit next to the new family
// (OpenRouter non-open-weight vendors, bare vendor ids that LM Studio also uses, native ids).
const IDS = [
  'claude-opus-4-8', 'openrouter/anthropic/claude-opus-4-8',
  'gpt-5.6-terra', 'gpt-5.4-mini', 'codex-mini-latest',
  'gpt-4.1', 'o3-mini',
  'grok-4.6', 'openrouter/x-ai/grok-4.6',
  'gemini-3-pro',
  'local:gemma-4-26b-a4b-it', 'local:qwen',
  'qwen3.8-27b-mlx', 'qwen3.6-flash', 'kimi-k2.6', 'glm-4.5-air',
  'lmstudio-community/gemma-4-26b-a4b-it', 'qwen/qwen3-coder-30b',
  'moonshotai/kimi-k3', 'z-ai/glm-5.3', 'openrouter/acme/model',
] as const;

const EXPECTED: Record<(typeof IDS)[number], Awaited<ReturnType<typeof fingerprint>>> = {
  'claude-opus-4-8': {
    family: 'claude', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'openrouter/anthropic/claude-opus-4-8': {
    family: 'claude', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'gpt-5.6-terra': {
    family: 'codex', discipline: 'b8623476f31f08d5e1269d7ad5edb4f922c0d820a9cfaccbe41f9756d7151d97',
    addon: 'fb553a1ac45cdf93055abf248bb7ca25442af7f5a3af249b8130363729de8500',
    firstTurn: 'c04fb52dfc902dd0d1d717cae28bf5b90a87ddd54fb120f11784677d5942ee54',
  },
  'gpt-5.4-mini': {
    family: 'codex', discipline: 'b8623476f31f08d5e1269d7ad5edb4f922c0d820a9cfaccbe41f9756d7151d97',
    addon: 'fb553a1ac45cdf93055abf248bb7ca25442af7f5a3af249b8130363729de8500',
    firstTurn: 'c04fb52dfc902dd0d1d717cae28bf5b90a87ddd54fb120f11784677d5942ee54',
  },
  'codex-mini-latest': {
    family: 'codex', discipline: 'b8623476f31f08d5e1269d7ad5edb4f922c0d820a9cfaccbe41f9756d7151d97',
    addon: 'fb553a1ac45cdf93055abf248bb7ca25442af7f5a3af249b8130363729de8500',
    firstTurn: 'c04fb52dfc902dd0d1d717cae28bf5b90a87ddd54fb120f11784677d5942ee54',
  },
  'gpt-4.1': {
    family: 'gpt', discipline: null,
    addon: '9e31146d530121080d0c6e9cdfd40b16721a15803fc86b713a9dd14cca371be2',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'o3-mini': {
    family: 'gpt', discipline: null,
    addon: '9e31146d530121080d0c6e9cdfd40b16721a15803fc86b713a9dd14cca371be2',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'grok-4.6': {
    family: 'grok', discipline: '49ada854d200fe9355c03f4726a0bc7efb853f9d30d6454f72a7bd15f891ab20',
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '3a5d0f0fcbb0c71febf9e7cac424b3fa9d7f2c0dd3f823b7f32ed93a175853e6',
  },
  'openrouter/x-ai/grok-4.6': {
    family: 'grok', discipline: '49ada854d200fe9355c03f4726a0bc7efb853f9d30d6454f72a7bd15f891ab20',
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '3a5d0f0fcbb0c71febf9e7cac424b3fa9d7f2c0dd3f823b7f32ed93a175853e6',
  },
  'gemini-3-pro': {
    family: 'gemini', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'local:gemma-4-26b-a4b-it': {
    family: 'local', discipline: 'ed7225aed6582944edb7c1f5c61568142b1072122396914d028b7deb00303601',
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '6a51d6fe755f860ab4398db0e7b220f0b0d220b33fa188e9e8b2bad233df68b5',
  },
  'local:qwen': {
    family: 'local', discipline: 'ed7225aed6582944edb7c1f5c61568142b1072122396914d028b7deb00303601',
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '6a51d6fe755f860ab4398db0e7b220f0b0d220b33fa188e9e8b2bad233df68b5',
  },
  'qwen3.8-27b-mlx': {
    family: 'other', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'qwen3.6-flash': {
    family: 'other', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'kimi-k2.6': {
    family: 'other', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'glm-4.5-air': {
    family: 'other', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'lmstudio-community/gemma-4-26b-a4b-it': {
    family: 'other', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'qwen/qwen3-coder-30b': {
    family: 'other', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'moonshotai/kimi-k3': {
    family: 'other', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'z-ai/glm-5.3': {
    family: 'other', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
  'openrouter/acme/model': {
    family: 'other', discipline: null,
    addon: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    firstTurn: '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2',
  },
};

describe('open-weight family — every other id is byte-identical to main', () => {
  for (const id of IDS) {
    test(id, async () => {
      expect(await fingerprint(id)).toEqual(EXPECTED[id]);
    });
  }
});

