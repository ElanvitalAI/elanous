// M1-5 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// `elanous setup` step: Voice & AI behavior.
//
// Per the PLAN §4a.2 zero-config-first principle, the default path
// here is "Smart defaults active" — the user picks one option and
// elanous runs Balanced tier for every surface with no further setup.
// Power users may instead opt into a preset (Phase 2 placeholder
// today · the wizard accepts the input but Phase 1 ignores it) or
// per-surface customize (sets `modelTier.voice.stt` directly).
//
// An optional monthly USD cap landed in the same step so users who
// want a "stop notifying me past $X" guardrail can dial it in without
// digging into config files.

import { WizardBackError, type WizardIO } from '../onboarding.js';
import { showStepOr, chooseFrom, type ChoiceOption } from './io-extended.js';

// Inlined back-helpers — `buildBackOption` / `isBackPicked` / the
// sentinel value live as private internals of `../onboarding.ts`. We
// duplicate the 3-line shape here instead of extracting them so this
// step stays additive and doesn't widen onboarding.ts's public API.
const VOICE_AI_WIZARD_BACK = Symbol('voice-ai.wizard.back');
type WizardBackValue = typeof VOICE_AI_WIZARD_BACK;

function buildBackOption<T>(): ChoiceOption<T | WizardBackValue> {
  return {
    key: 'b',
    label: '← Back to previous step',
    value: VOICE_AI_WIZARD_BACK as T | WizardBackValue,
  };
}
function isBackPicked(v: unknown): v is WizardBackValue {
  return v === VOICE_AI_WIZARD_BACK;
}
import {
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  type BudgetUserConfig,
  type ModelTier,
  type ModelTierUserConfig,
} from '../model-tier/types.js';

export interface VoiceAIAnswer {
  /** When the user picked Smart defaults this is undefined — the rest
   *  of the wizard leaves `cfg.modelTier` absent so resolvers fall
   *  through to the zero-config Balanced default. */
  modelTier?: ModelTierUserConfig;
  /** Optional monthly USD cap. Undefined → no cap (passive notify-only). */
  budget?: BudgetUserConfig;
}

type Mode = 'smart' | 'preset' | 'custom';

interface ModeOption {
  key: string;
  label: string;
  value: Mode | WizardBackValue;
  description: string;
}

/** Mode picker — phrased so a casual user instantly grasps "Smart
 *  defaults" wins by default. */
function modeOptions(allowBack: boolean): ModeOption[] {
  const opts: ModeOption[] = [
    {
      key: '1',
      label: 'Smart defaults (recommended)',
      value: 'smart',
      description: 'Casual · elanous picks Balanced tier · ~$2/mo · no setup needed beyond this',
    },
    {
      key: '2',
      label: 'Pick a preset (Phase 2)',
      value: 'preset',
      description: 'Common use cases · "Meeting notes" · "Medical dictation" · "Sleep mode" (will land later)',
    },
    {
      key: '3',
      label: 'Customize per surface',
      value: 'custom',
      description: 'Power · choose STT tier (Budget/Balanced/Better/Best/Loaded) · optional budget cap',
    },
  ];
  if (allowBack) opts.push(buildBackOption<Mode>() as ModeOption);
  return opts;
}

function tierOptions(allowBack: boolean): ChoiceOption<ModelTier | WizardBackValue>[] {
  const opts: ChoiceOption<ModelTier | WizardBackValue>[] = MODEL_TIERS.map((tier, i) => ({
    key: String(i + 1),
    label: MODEL_TIER_LABELS[tier],
    value: tier,
    description: tierHint(tier),
  }));
  if (allowBack) opts.push(buildBackOption<ModelTier>());
  return opts;
}

function tierHint(tier: ModelTier): string {
  switch (tier) {
    case 'budget': return 'Offline (local whisper.cpp · WIP) · $0/min · install binary first';
    case 'balanced': return 'Default · streaming · $0.003/min · gpt-4o-mini-transcribe';
    case 'better': return 'Higher accuracy · streaming · $0.006/min · gpt-4o-transcribe';
    case 'best': return 'Best accuracy · domain adaptation · $0.017/min · gpt-realtime-whisper';
    case 'loaded': return 'Loaded · logprobs + timestamps · ~$0.025/min · gpt-realtime-whisper';
  }
}

async function askMonthlyCapUsd(io: WizardIO): Promise<number | undefined> {
  io.print('');
  io.print('  Monthly budget cap (USD) — skip with blank to leave unset (no cap).');
  io.print('  When set, elanous notifies you at 80% and can auto-fallback to a');
  io.print('  cheaper tier for the rest of the month.');
  const raw = await io.ask('  Cap [blank = no cap]: ');
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    io.print(`  (warn: ignored — "${trimmed}" isn't a non-negative number)`);
    return undefined;
  }
  return n;
}

/** Run the Voice & AI step. `index` / `total` come from the runOnboarding
 *  loop so the showStep header stays in sync with the rest of the wizard. */
export async function askVoiceAI(
  io: WizardIO,
  _current: { modelTier?: ModelTierUserConfig; budget?: BudgetUserConfig } = {},
  stepOpts: { allowBack?: boolean; index?: number; total?: number } = {},
): Promise<VoiceAIAnswer> {
  showStepOr(io, {
    index: stepOpts.index ?? 6,
    total: stepOpts.total ?? 7,
    title: 'Voice & AI behavior',
    excerpt: 'How should elanous pick speech-to-text and AI models? Smart defaults are the\nrecommended path — you can customize anytime from PWA settings or `elanous voice status`.',
    severity: 'optional',
    skipBehavior: 'Pressing Enter keeps Smart defaults (Balanced tier · ~$2/mo).',
  });
  io.print('│  Friction-free model selection (PLAN 2026-05-12). Casual users');
  io.print('│  pick "Smart defaults" and never touch settings again. Power users');
  io.print('│  can dial per-surface tiers or set a monthly budget cap.');
  io.print('└───');

  const mode = await chooseFrom(io, '  Mode', modeOptions(stepOpts.allowBack === true), {
    defaultIndex: 0,
  });
  if (isBackPicked(mode)) throw new WizardBackError();

  if (mode === 'smart') {
    io.print('  → Smart defaults active · Balanced tier on every surface.');
    return {};
  }

  if (mode === 'preset') {
    // Phase 2 catalog isn't shipped yet; the wizard records the intent
    // by keeping the user on Smart defaults but tagging profile='power'
    // so the auto-suggest hint in PWA opens the preset card directly.
    io.print('  (Preset catalog ships in Phase 2 · for now Smart defaults stay active.)');
    io.print('  elanous has noted your preference — preset hints will appear when ready.');
    return {
      modelTier: { profile: 'power' },
    };
  }

  // Customize per surface.
  io.print('');
  io.print('  Speech-to-text accuracy tier (controls cost & quality):');
  const tier = await chooseFrom(io, '  Tier', tierOptions(stepOpts.allowBack === true), {
    defaultIndex: 1, // Balanced
  });
  if (isBackPicked(tier)) throw new WizardBackError();

  const cap = await askMonthlyCapUsd(io);

  const answer: VoiceAIAnswer = {
    modelTier: {
      profile: 'custom',
      voice: { stt: tier as ModelTier },
    },
  };
  if (cap !== undefined) answer.budget = { monthlyUsdCap: cap };
  io.print(`  → Customized · STT tier = ${MODEL_TIER_LABELS[tier as ModelTier]}${cap !== undefined ? ` · cap $${cap}/mo` : ''}.`);
  return answer;
}
