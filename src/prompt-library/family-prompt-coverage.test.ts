import { describe, it, expect } from 'bun:test';
import { getModelFamily } from '../models/prompts.js';
import { GPT_CHAT_VARIANT } from './providers/gpt.js';
import { resolveBuiltinChatVariant } from './registry.js';
import { buildUniversalPreamble, resetUniversalPreambleCache } from './universal-preamble.js';

// Keep probes in the test: these assertions exercise public classification and
// prompt-building APIs directly, without a coverage helper that only called them.
const PROBE = {
  claude: 'claude-opus-4',
  codex: 'gpt-5-codex',
  gpt: 'gpt-4o',
  grok: 'grok-4.7',
  gemini: 'gemini-3-pro',
  local: 'local:qwen',
  'open-weight': 'openrouter/z-ai/glm-5.3',
} as const;
const FAMILIES = Object.keys(PROBE) as Array<keyof typeof PROBE>;
const BASELINE: Record<keyof typeof PROBE, { chat: boolean; addendum: boolean }> = {
  claude: { chat: true, addendum: true },
  codex: { chat: true, addendum: true },
  gpt: { chat: true, addendum: true },
  gemini: { chat: true, addendum: true },
  grok: { chat: true, addendum: true },
  local: { chat: true, addendum: false },
  'open-weight': { chat: false, addendum: false },
};
const PROBE_CWD = '/nonexistent-family-coverage-probe';

function preambleText(modelFamily?: string): string {
  resetUniversalPreambleCache();
  return buildUniversalPreamble({
    cwd: PROBE_CWD,
    enabledTools: [],
    ...(modelFamily ? { modelFamily: modelFamily as ReturnType<typeof getModelFamily> } : {}),
  }).map(message => String(message.content)).join('\n');
}

describe('family prompt coverage — public behavior regression', () => {
  it('probe ids classify into all seven expected model families', () => {
    for (const family of FAMILIES) expect(getModelFamily(PROBE[family])).toBe(family);
  });

  it('preserves the measured dedicated chat variant and family addendum baseline', () => {
    const baselinePreamble = preambleText();
    for (const family of FAMILIES) {
      const modelId = PROBE[family];
      const hasDedicatedChatVariant = family === 'gpt' || resolveBuiltinChatVariant(modelId) !== GPT_CHAT_VARIANT;
      const hasFamilyAddendum = preambleText(family) !== baselinePreamble;
      expect(hasDedicatedChatVariant).toBe(BASELINE[family].chat);
      expect(hasFamilyAddendum).toBe(BASELINE[family].addendum);
    }
  });

  it('keeps open-weight as the measured family missing both prompt layers', () => {
    const missingChat = FAMILIES.filter(family =>
      family !== 'gpt' && resolveBuiltinChatVariant(PROBE[family]) === GPT_CHAT_VARIANT,
    ).sort();
    const baselinePreamble = preambleText();
    const missingAddendum = FAMILIES.filter(family =>
      preambleText(family) === baselinePreamble,
    ).sort();
    expect(missingChat).toEqual(['open-weight']);
    expect(missingAddendum).toEqual(['local', 'open-weight']);
    expect(missingChat.filter(family => missingAddendum.includes(family))).toEqual(['open-weight']);
  });
});
