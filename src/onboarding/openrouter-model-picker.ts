import catalog from '../../catalog/models/openrouter/onboarding-picks.json';
import solarProfile from '../../docs/profiles/solar-only-demo.json';
import { MODEL_ROLES } from '../user-config.js';
import type { RoleLlmConfig } from '../user-config/types.js';
import type { OpenRouterPick } from '../cli/first-run/openrouter-picker.js';
import type { Locale } from '../expression/locale.js';

export const OPENROUTER_MODEL_PICKS = catalog.models.map((entry) => ({
  ...entry,
  model: `openrouter/${entry.id}`,
}));

export const SOLAR_DEMO_PRESET_ID = 'solar-demo';
export const SOLAR_DEMO_CHAT_MODEL = 'openrouter/upstage/solar-pro4';

/** The preset pins every role from the data profile; a normal model pick preserves explicit roles. */
export function solarDemoRoleDefaults(): RoleLlmConfig {
  return Object.fromEntries(MODEL_ROLES.map((role) => {
    const pick = solarProfile.roleLlm[role as keyof typeof solarProfile.roleLlm];
    if (!pick) throw new Error(`Solar demo profile missing role: ${role}`);
    return [role, { provider: 'openrouter', model: pick.model }];
  })) as RoleLlmConfig;
}

export function openRouterRoleDefaults(model: string): RoleLlmConfig {
  return Object.fromEntries(MODEL_ROLES.map((role) => [role, { provider: 'openrouter', model }])) as RoleLlmConfig;
}

export function updateOpenRouterRoleDefaults(
  existing: RoleLlmConfig | undefined,
  _previousModel: string | undefined,
  selectedModel: string,
): RoleLlmConfig {
  const defaults = openRouterRoleDefaults(selectedModel);
  const result: RoleLlmConfig = { ...existing };
  for (const role of MODEL_ROLES) {
    const current = existing?.[role];
    // An existing role may be an explicit choice even when its model matches
    // the previous global default. Config has no provenance for that choice.
    if (!current) {
      result[role] = defaults[role];
    }
  }
  return result;
}

export async function promptOpenRouterModel(
  ask: (prompt: string) => Promise<string>,
  print: (line: string) => void,
  current?: string,
  locale: Locale = 'ko',
): Promise<OpenRouterPick> {
  const english = locale === 'en';
  print(english ? 'Choose an OpenRouter model (your API key)' : 'OpenRouter 모델 선택 (사용자 API 키)');
  OPENROUTER_MODEL_PICKS.forEach((entry, index) =>
    print(`${index + 1} ${entry.label} · ${entry.family} · ${entry.model}`));
  print(english
    ? `${OPENROUTER_MODEL_PICKS.length + 1} Solar demo preset · Pro 4 for chat and major roles + Mini 4 for lighter roles`
    : `${OPENROUTER_MODEL_PICKS.length + 1} Solar 데모 프리셋 · Pro 4 채팅/중요 역할 + Mini 4 경량 역할`);
  const defaultIndex = Math.max(0, OPENROUTER_MODEL_PICKS.findIndex((entry) => entry.model === current));
  for (;;) {
    const answer = (await ask(english
      ? `Model number [${defaultIndex + 1}] (Enter=default): `
      : `모델 번호 [${defaultIndex + 1}] (Enter=기본값): `)).trim();
    if (!answer) {
      const pick = OPENROUTER_MODEL_PICKS[defaultIndex]!;
      return { id: pick.id, label: pick.label, family: pick.family };
    }
    if (/^[1-9][0-9]*$/.test(answer)) {
      if (Number(answer) === OPENROUTER_MODEL_PICKS.length + 1) {
        return { id: SOLAR_DEMO_PRESET_ID, label: english ? 'Solar demo preset' : 'Solar 데모 프리셋', family: 'Solar' };
      }
      const pick = OPENROUTER_MODEL_PICKS[Number(answer) - 1];
      if (pick) return { id: pick.id, label: pick.label, family: pick.family };
    }
    print(english ? 'Enter a number from the list.' : '목록의 번호를 입력하세요.');
  }
}
