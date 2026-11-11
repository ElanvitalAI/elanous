import picks from '../../../catalog/models/openrouter/onboarding-picks.json';
import { parseMenuAnswer } from '../../onboarding/menu-answer.js';

export interface OpenRouterPick { id: string; label: string; family: string }
export const SOLAR_DEMO_PRESET_ID = 'solar-demo';

/** The Solar profile is one onboarding choice; its two models are assigned by role. */
export const OPENROUTER_ONBOARDING_CHOICES: readonly OpenRouterPick[] = picks.models
  .concat([{ id: SOLAR_DEMO_PRESET_ID, label: 'Solar 데모 프리셋 (Pro 4 / Mini 4)', family: 'Solar' }]);

export async function pickOpenRouterModel(ask: (prompt: string) => Promise<string>): Promise<OpenRouterPick> {
  const choices = OPENROUTER_ONBOARDING_CHOICES;
  for (;;) {
    const menu = choices.map((model, index) => `${index + 1} ${model.label}`).join(' · ');
    const parsed = parseMenuAnswer(await ask(`OpenRouter 모델 (${menu}; Enter=첫 모델): `), choices);
    if (parsed.kind === 'chosen') return parsed.provider;
    if (parsed.kind === 'cancel') return choices[0]!;
  }
}
