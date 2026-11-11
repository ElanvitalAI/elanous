import { setSessionTierOverride } from '../../model-tier/session-override.js';
import type { ModelTier } from '../../model-tier/types.js';

export type NextTuiModelChoice = 'fast' | 'normal' | 'deep';

const CHOICES: Readonly<Record<string, { choice: NextTuiModelChoice; tier: ModelTier; label: string }>> = {
  fast: { choice: 'fast', tier: 'budget', label: '빠름' },
  빠름: { choice: 'fast', tier: 'budget', label: '빠름' },
  normal: { choice: 'normal', tier: 'balanced', label: '보통' },
  보통: { choice: 'normal', tier: 'balanced', label: '보통' },
  deep: { choice: 'deep', tier: 'best', label: '깊음' },
  깊음: { choice: 'deep', tier: 'best', label: '깊음' },
};

export type NextTuiModelCommand =
  | { readonly kind: 'tier'; readonly choice: NextTuiModelChoice; readonly tier: ModelTier; readonly label: string }
  | { readonly kind: 'provider'; readonly providerCommand: string }
  | { readonly kind: 'invalid'; readonly message: string };

const MODEL_USAGE = '사용법: /model <fast|normal|deep> (빠름|보통|깊음) · /provider 별칭';

/** Parse /model and its /provider alias; retain the older /provider subcommands. */
export function parseNextTuiModelCommand(input: string): NextTuiModelCommand {
  const normalized = input.trim().replace(/\s+/g, ' ');
  const separator = normalized.indexOf(' ');
  const command = separator < 0 ? normalized : normalized.slice(0, separator);
  const args = separator < 0 ? '' : normalized.slice(separator + 1).trim();
  const normalizedChoice = args.toLowerCase();
  const selected = args
    ? (Object.hasOwn(CHOICES, normalizedChoice) ? CHOICES[normalizedChoice] : undefined)
      ?? (Object.hasOwn(CHOICES, args) ? CHOICES[args] : undefined)
    : undefined;

  if (selected) {
    return { kind: 'tier', choice: selected.choice, tier: selected.tier, label: selected.label };
  }
  if (command === '/provider' && (!args || /^(models|refresh|use)(\s|$)/.test(args))) {
    return { kind: 'provider', providerCommand: args };
  }
  return { kind: 'invalid', message: MODEL_USAGE };
}

/** Persist the person's tier choice for this session; the shared turn resolver applies it. */
export function applyNextTuiModelTier(sessionId: string, tier: ModelTier, choice: NextTuiModelChoice): void {
  setSessionTierOverride(sessionId, {
    llm: tier,
    rationale: `next TUI /model ${choice}`,
  });
}
