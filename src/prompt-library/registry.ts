import { readFileSync } from 'fs';
import { getModelFamily } from '../models/prompts.js';
import type { ChatSystemPromptConfig } from '../user-config/chat.js';
import { ANTHROPIC_CHAT_VARIANT } from './providers/anthropic.js';
import { CODEX_CHAT_VARIANT } from './providers/codex.js';
import { GEMINI_CHAT_VARIANT } from './providers/gemini.js';
import { GPT_CHAT_VARIANT } from './providers/gpt.js';
import { GROK_CHAT_VARIANT } from './providers/grok.js';
import { LOCAL_CHAT_VARIANT } from './providers/local.js';
import { isSolarPro4Model, solarOptimizationEnabled, SOLAR_CHAT_VARIANT } from './providers/solar.js';

export interface ResolveChatSystemPromptOpts {
  model?: string;
  config: ChatSystemPromptConfig;
}

export interface ResolvedChatSystemPrompt {
  text: string;
  source: 'builtin' | 'override';
  variant: string;
}

export function resolveBuiltinChatVariant(model?: string): string {
  if (solarOptimizationEnabled() && isSolarPro4Model(model)) return SOLAR_CHAT_VARIANT;
  switch (getModelFamily(model)) {
    case 'claude':
      return ANTHROPIC_CHAT_VARIANT;
    case 'codex':
      return CODEX_CHAT_VARIANT;
    case 'gpt':
      return GPT_CHAT_VARIANT;
    case 'gemini':
      return GEMINI_CHAT_VARIANT;
    case 'grok':
      return GROK_CHAT_VARIANT;
    case 'local':
      return LOCAL_CHAT_VARIANT;
    default:
      return GPT_CHAT_VARIANT;
  }
}

function resolveForcedBuiltinVariant(
  forced: ChatSystemPromptConfig['forceBuiltinVariant'],
): { text: string; variant: string } | null {
  switch (forced) {
    case 'claude':
      return { text: ANTHROPIC_CHAT_VARIANT, variant: 'claude' };
    case 'codex':
      return { text: CODEX_CHAT_VARIANT, variant: 'codex' };
    case 'gpt':
      return { text: GPT_CHAT_VARIANT, variant: 'gpt' };
    case 'local':
      return { text: LOCAL_CHAT_VARIANT, variant: 'local' };
    default:
      return null;
  }
}

export function resolveChatSystemPrompt(
  opts: ResolveChatSystemPromptOpts,
): ResolvedChatSystemPrompt {
  if (opts.config.overridePath) {
    const resolved: ResolvedChatSystemPrompt = {
      text: readFileSync(opts.config.overridePath, 'utf-8'),
      source: 'override',
      variant: 'override',
    };
    return resolved;
  }
  const forced = resolveForcedBuiltinVariant(opts.config.forceBuiltinVariant);
  if (forced) {
    const resolved = {
      text: forced.text,
      source: 'builtin',
      variant: forced.variant,
    } as const;
    return resolved;
  }
  const family = solarOptimizationEnabled() && isSolarPro4Model(opts.model) ? 'solar' : getModelFamily(opts.model);
  const resolved: ResolvedChatSystemPrompt = {
    text: resolveBuiltinChatVariant(opts.model),
    source: 'builtin',
    variant: family,
  };
  return resolved;
}
