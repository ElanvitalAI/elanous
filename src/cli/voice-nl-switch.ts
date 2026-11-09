// M3-3 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 3) —
// `elanous voice nl-switch <text>` CLI.
//
// Dogfood entry for the chat NL switch detector before the full chat
// surface integration lands. Detect-only by default — pass `--apply
// --session <id>` to install a session-scoped override that the
// resolver respects until TTL expiry (default 8h).
//
// `--model <id>` is required when the user wants the LLM path; without
// it the command short-circuits with a usage hint (heuristic-only NL
// detection isn't meaningful here — keyword phrases like "회의" alone
// don't reliably distinguish apply-preset vs none).

import {
  createLocalLlmPresetRunner,
  detectTierIntentFromChat,
  getPreset,
  planNlTierSwitch,
  resolveLlmTier,
  resolveSttTier,
  resolveTtsTier,
  setSessionTierOverride,
  type CurrentTierSlots,
  type LlmRunner,
  type NlTierApplyPlan,
  type NlTierDetection,
} from '../model-tier/index.js';
import { getUserConfig } from '../user-config.js';
import type { UserConfig } from '../user-config/types.js';

export interface RunVoiceNlSwitchOpts {
  text: string;
  /** Required for the LLM path. */
  model?: string;
  endpoint?: string;
  /** When true · install the session override after detection. */
  apply?: boolean;
  /** Session id required when `apply=true`. */
  sessionId?: string;
  /** Inject a runner — primary test seam. */
  runner?: LlmRunner;
  /** Inject the active user-config — test seam. */
  cfg?: UserConfig;
  timeoutMs?: number;
}

export interface VoiceNlSwitchResult {
  detection: NlTierDetection;
  plan: NlTierApplyPlan;
  output: string[];
  exitCode: number;
  applied: boolean;
}

function resolveSlots(cfg: UserConfig): CurrentTierSlots {
  return {
    stt: resolveSttTier(cfg.modelTier).tier,
    llm: resolveLlmTier(cfg.modelTier, cfg.llm?.provider ?? 'claude').tier,
    tts: resolveTtsTier(cfg.modelTier).tier,
  };
}

export async function runVoiceNlSwitchCommand(
  opts: RunVoiceNlSwitchOpts,
): Promise<VoiceNlSwitchResult> {
  const text = opts.text.trim();
  const detectionEmpty: NlTierDetection = {
    intent: 'none', rationale: '', source: 'fallback',
  };
  if (text.length === 0) {
    return {
      detection: detectionEmpty,
      plan: { isNoop: true, apply: {}, detection: detectionEmpty, confirmMessage: '' },
      output: ['Usage: elanous voice nl-switch <text...> --model <id> [--apply --session <id>]'],
      exitCode: 2,
      applied: false,
    };
  }
  if (opts.apply && !opts.sessionId) {
    return {
      detection: detectionEmpty,
      plan: { isNoop: true, apply: {}, detection: detectionEmpty, confirmMessage: '' },
      output: ['⚠ --apply requires --session <id>'],
      exitCode: 2,
      applied: false,
    };
  }
  const runner = opts.runner
    ?? (opts.model
      ? createLocalLlmPresetRunner({
          model: opts.model,
          ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        })
      : null);
  if (!runner) {
    return {
      detection: detectionEmpty,
      plan: { isNoop: true, apply: {}, detection: detectionEmpty, confirmMessage: '' },
      output: [
        '⚠ NL switch requires --model <id> (LM Studio / OpenAI-compatible host)',
        '  Hint: elanous voice nl-switch --model gemma-4-e4b "이번 회의는 의료 용어 많아"',
      ],
      exitCode: 2,
      applied: false,
    };
  }
  const cfg = opts.cfg ?? getUserConfig();
  const detection = await detectTierIntentFromChat(text, runner, {
    ...(typeof opts.timeoutMs === 'number' ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const plan = planNlTierSwitch(detection, resolveSlots(cfg));

  const output: string[] = [];
  output.push(`Intent: ${detection.intent} (${detection.source})`);
  if (detection.preset) {
    const spec = getPreset(detection.preset);
    output.push(`Preset: ${spec.icon} ${spec.label}`);
  }
  if (detection.tierDelta !== undefined) {
    output.push(`tierDelta: ${detection.tierDelta > 0 ? '+' : ''}${detection.tierDelta}`);
  }
  if (detection.rationale) output.push(`Rationale: ${detection.rationale}`);
  output.push('');
  output.push(plan.confirmMessage);

  let applied = false;
  if (opts.apply && opts.sessionId && !plan.isNoop) {
    setSessionTierOverride(opts.sessionId, {
      ...plan.apply,
      ...(plan.monthlyUsdCap !== undefined ? { monthlyUsdCap: plan.monthlyUsdCap } : {}),
      rationale: detection.rationale || 'NL tier switch',
    });
    applied = true;
    output.push('');
    output.push(`✓ Override installed for session ${opts.sessionId}.`);
    output.push('  (Auto-reverts in 8h or after `elanous voice nl-switch --clear`.)');
  } else if (opts.apply && plan.isNoop) {
    output.push('');
    output.push('(plan is no-op · override not installed)');
  }

  return { detection, plan, output, exitCode: 0, applied };
}
