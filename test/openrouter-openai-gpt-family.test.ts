// OR-FAMILY-GPT6 — `openrouter/openai/<gpt|o-series>` ids whose bare id is 'gpt' on the direct
// path (gpt-6-*, gpt-4*, o-series) join 'gpt'. Before this they fell to 'other' and got none of the
// gpt prompt pieces (the dispatcher now mixes `openrouter/openai/gpt-6-luna` into low/mid cells).
// ⛔ bare gpt-5* is 'codex' on the direct path, and 'codex' also switches llm.ts tool-loop
// behaviour — so `openrouter/openai/gpt-5*` deliberately stays 'other' (pinned in ①).
//
// Two halves:
//   ① UNCHANGED — every id outside `openrouter/openai/` keeps the exact fingerprint it had on
//      origin/main c25df7b58e (measured there, before this change, with this same function).
//      If a later PR changes addon/discipline TEXT on purpose, re-measure the shared constants
//      below by printing `await fingerprint(id)` on that PR's base — ① guards the family split,
//      not the wording.
//   ② CHANGED — each `openrouter/openai/` gpt id has the SAME prompt pieces as its direct twin:
//      family · skills addon · llm.ts discipline · first transmitted turn · chat variant ·
//      universal-preamble family addendum · tool-hint cap. The idle policy is compared per real
//      provider (openrouter vs openai). The OpenRouter request body (reasoning/verbosity) is out
//      of scope here (TC OR-IMPL-EFFORT).
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  resolveToolDiscipline,
  selectIntentClassificationMessages,
  streamLLMWithTools,
  usesLongReasoningIdle,
} from '../src/llm';
import type { LLMMessage, LLMProvider } from '../src/llm';
import { getModelFamily, getModelPromptAddon } from '../src/models/prompts';
import { resolveBuiltinChatVariant } from '../src/prompt-library/registry';
import { buildUniversalPreamble } from '../src/prompt-library/universal-preamble';
import { evaluateGate, resetGateCache } from '../src/tool-hints/gate';
import type { SignalSnapshot } from '../src/tool-hints/signals';
import type { NativeToolCatalogEntry } from '../src/native-tool-catalog';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  return sha(JSON.stringify({ transmitted, intent: selectIntentClassificationMessages(transmitted) }));
}

/** Provider that actually serves the id: gateway ids go through openrouter, direct gpt ids through openai. */
const servingProvider = (model: string): string => (model.toLowerCase().startsWith('openrouter/') ? 'openrouter' : 'openai');

async function fingerprint(model: string) {
  const family = getModelFamily(model);
  const discipline = resolveToolDiscipline(family);
  return {
    family,
    addon: sha(getModelPromptAddon(model)),
    discipline: discipline === null ? null : sha(discipline),
    chatVariant: sha(resolveBuiltinChatVariant(model)),
    longIdle: usesLongReasoningIdle(family, servingProvider(model)),
    firstTurn: await firstTurnSha(model),
  };
}

// Empty cwd so the project anchor is constant; only the family addendum can differ.
const PREAMBLE_CWD = mkdtempSync(join(tmpdir(), 'or-family-gpt6-'));
afterAll(() => {
  rmSync(PREAMBLE_CWD, { recursive: true, force: true });
  resetGateCache(); // the gate cache is process-global — leave it empty for later files
});
const preambleSha = (model: string): string => sha(JSON.stringify(
  buildUniversalPreamble({ cwd: PREAMBLE_CWD, modelFamily: getModelFamily(model) }),
));

/** Tools the tool-hint gate keeps for this id's family (gpt/codex are capped at 8). */
function toolHintKept(model: string): number {
  const family = getModelFamily(model);
  const catalog: NativeToolCatalogEntry[] = Array.from({ length: 12 }, (_, i) => ({
    id: `tool_${String(i).padStart(2, '0')}`, kind: 'other', aliases: [], displayName: `t${i}`,
    description: 'd', promptSummary: 'd', host: ['all'], safety: ['process'], supportsParallel: false, defaultEnabled: true,
  }));
  const signals: SignalSnapshot = {
    hasPython: false, hasNodeProject: false, hasGitRemote: false, intentResearch: false, intentDiagram: false,
    recentNetworkError: false, intentBrowse: false, intentViz: false, intentCapture: false, intentOpsFleet: false,
    intentOpsUi: false, intentCoding: false, paidKeyGrok: false, paidCliFirecrawl: false, hasActivePtyModal: false,
    backgroundedPtyCount: 0, hasSessionAttention: false, modelFamily: family, fingerprint: `or-family-gpt6-${family}`,
  };
  resetGateCache();
  return evaluateGate(catalog, [], signals).filtered.length;
}

type Fp = Awaited<ReturnType<typeof fingerprint>>;

// Shared sha values (measured on origin/main c25df7b58e).
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const GPT_ADDON = '9e31146d530121080d0c6e9cdfd40b16721a15803fc86b713a9dd14cca371be2';
const CODEX_ADDON = 'fb553a1ac45cdf93055abf248bb7ca25442af7f5a3af249b8130363729de8500';
const CODEX_DISCIPLINE = 'b8623476f31f08d5e1269d7ad5edb4f922c0d820a9cfaccbe41f9756d7151d97';
const GROK_DISCIPLINE = '49ada854d200fe9355c03f4726a0bc7efb853f9d30d6454f72a7bd15f891ab20';
const PLAIN_TURN = '847b7010258182a01a4397318734230e382b2f34e4d11c87a46ccafdf4e1ede2';
const CODEX_TURN = 'c04fb52dfc902dd0d1d717cae28bf5b90a87ddd54fb120f11784677d5942ee54';
const GROK_TURN = '3a5d0f0fcbb0c71febf9e7cac424b3fa9d7f2c0dd3f823b7f32ed93a175853e6';
const OW_DISCIPLINE = '59031199c0281b7691f51446ab10d0b9890fe1b54538faad8c6b1c633e446e42';
const OW_TURN = '67c529da960add918d7acbd1f7615ce2e6d6783951062388e1a0541e2777dd5a';
const GPT_VARIANT = 'b4f6ad80c0ff6f754885731dfac362632fcad657246a01e6121a3a52e1f5d182';
const CLAUDE_VARIANT = '35db6bb6bf5931f8bc9a0580aec77187ebaf96b9a32616280faedd3fbba7b04c';
const CODEX_VARIANT = 'eb32cd567fa95301f945c1b24258144be0c520f7e5c75130a504deef5f6c7098';
const GROK_VARIANT = 'cdcebad06cd76f97ce6acb7dd9fd1acab43b19a35926a32860fa79badca0cb8c';

const gpt: Fp = { family: 'gpt', addon: GPT_ADDON, discipline: null, chatVariant: GPT_VARIANT, longIdle: false, firstTurn: PLAIN_TURN };
const openWeight: Fp = { family: 'open-weight', addon: EMPTY, discipline: OW_DISCIPLINE, chatVariant: GPT_VARIANT, longIdle: false, firstTurn: OW_TURN };
const other: Fp = { family: 'other', addon: EMPTY, discipline: null, chatVariant: GPT_VARIANT, longIdle: false, firstTurn: PLAIN_TURN };
const codex: Fp = { family: 'codex', addon: CODEX_ADDON, discipline: CODEX_DISCIPLINE, chatVariant: CODEX_VARIANT, longIdle: true, firstTurn: CODEX_TURN };

const UNCHANGED: Record<string, Fp> = {
  // direct gpt-6 (the twins of the changed ids)
  'gpt-6-sol': gpt,
  'gpt-6-luna': gpt,
  'gpt-6-astra': gpt,
  'gpt-4.1': gpt,
  'o3-mini': gpt,
  'gpt-5.4-mini': codex,
  'codex-mini-latest': codex,
  // anthropic — direct and via OpenRouter
  'claude-opus-4-8': { family: 'claude', addon: EMPTY, discipline: null, chatVariant: CLAUDE_VARIANT, longIdle: true, firstTurn: PLAIN_TURN },
  'openrouter/anthropic/claude-opus-4-8': { family: 'claude', addon: EMPTY, discipline: null, chatVariant: CLAUDE_VARIANT, longIdle: true, firstTurn: PLAIN_TURN },
  'openrouter/anthropic/claude-sonnet-4-6': { family: 'claude', addon: EMPTY, discipline: null, chatVariant: CLAUDE_VARIANT, longIdle: true, firstTurn: PLAIN_TURN },
  // grok
  'grok-4.6': { family: 'grok', addon: EMPTY, discipline: GROK_DISCIPLINE, chatVariant: GROK_VARIANT, longIdle: true, firstTurn: GROK_TURN },
  'openrouter/x-ai/grok-4.6': { family: 'grok', addon: EMPTY, discipline: GROK_DISCIPLINE, chatVariant: GROK_VARIANT, longIdle: true, firstTurn: GROK_TURN },
  // open-weight via OpenRouter
  'openrouter/z-ai/glm-5.3': openWeight,
  'openrouter/moonshotai/kimi-k3': openWeight,
  'openrouter/qwen/qwen3.8-max-0902': openWeight,
  // stays 'other': unknown OpenRouter vendors, and non-gpt ids under the openai vendor
  'openrouter/acme/model': other,
  'openrouter/openai/text-embedding-3-large': other,
  'openrouter/openai/dall-e-3': other,
  // bare vendor ids (LM Studio shape) are not gateway ids — must not move
  'openai/gpt-6-luna': other,
  // bare gpt-5* is 'codex' (tool-loop behaviour, not only prompt) — not taken over the gateway
  'openrouter/openai/gpt-5.4-mini': other,
  'openrouter/openai/gpt-5.6-terra': other,
  // already 'codex' on main via includes('codex')
  'openrouter/openai/gpt-5.1-codex': codex,
};

// changed id → its direct twin
const TWINS: Record<string, string> = {
  'openrouter/openai/gpt-6-luna': 'gpt-6-luna',
  'openrouter/openai/gpt-6-sol': 'gpt-6-sol',
  'openrouter/openai/gpt-6-astra': 'gpt-6-astra',
  'openrouter/openai/gpt-4.1': 'gpt-4.1',
  'openrouter/openai/o3-mini': 'o3-mini',
  'OpenRouter/OpenAI/GPT-6-Luna': 'gpt-6-luna',
  // decision: gpt-oss is already 'gpt' on the direct path (bare `gpt-oss-120b`), so it follows the same rule
  'openrouter/openai/gpt-oss-120b': 'gpt-oss-120b',
};

describe('OR-FAMILY-GPT6 ① — ids outside openrouter/openai/ are byte-identical to main', () => {
  for (const [id, expected] of Object.entries(UNCHANGED)) {
    test(id, async () => {
      expect(await fingerprint(id)).toEqual(expected);
    });
  }
});

describe('OR-FAMILY-GPT6 ② — openrouter/openai/ gpt ids get exactly their direct twin\'s fragments', () => {
  for (const [id, twin] of Object.entries(TWINS)) {
    test(`${id} ≡ ${twin}`, async () => {
      expect(await fingerprint(id)).toEqual(await fingerprint(twin));
      expect(preambleSha(id)).toBe(preambleSha(twin));
      expect(toolHintKept(id)).toBe(toolHintKept(twin));
    });
  }

  test('the dispatcher id is gpt family with the gpt hygiene addon (was other / empty on main)', async () => {
    const fp = await fingerprint('openrouter/openai/gpt-6-luna');
    expect(fp.family).toBe('gpt');
    expect(fp.addon).toBe(GPT_ADDON);
    expect(getModelPromptAddon('openrouter/openai/gpt-6-luna')).toContain('## Tool-call hygiene');
    // the gpt preamble addendum is really there (differs from the 'other' preamble main gave it)
    expect(preambleSha('openrouter/openai/gpt-6-luna')).not.toBe(preambleSha('openrouter/acme/model'));
    // and the tool-hint gate now caps it like direct gpt (12 → 8; 'other' keeps all 12)
    expect(toolHintKept('openrouter/openai/gpt-6-luna')).toBe(8);
    expect(toolHintKept('openrouter/acme/model')).toBe(12);
  });
});
