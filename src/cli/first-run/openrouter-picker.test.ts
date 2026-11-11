import { expect, test } from 'bun:test';
import { OPENROUTER_ONBOARDING_CHOICES, pickOpenRouterModel } from './openrouter-picker.js';

test('OpenRouter catalog menu includes Solar model and demo preset across six families', async () => {
  const families = new Set(OPENROUTER_ONBOARDING_CHOICES.map((model) => model.family));
  for (const family of ['Codex', 'Claude', 'Solar', 'GLM', 'Qwen', 'DeepSeek']) expect(families.has(family)).toBe(true);
  expect(OPENROUTER_ONBOARDING_CHOICES.filter((model) => model.family === 'Solar')).toHaveLength(3);
  expect(OPENROUTER_ONBOARDING_CHOICES.some((model) => model.id === 'upstage/solar-mini4')).toBe(true);
  const prompts: string[] = [];
  const answers = ['99', String(OPENROUTER_ONBOARDING_CHOICES.findIndex((model) => model.family === 'Solar') + 1)];
  const picked = await pickOpenRouterModel(async (prompt) => { prompts.push(prompt); return answers.shift() ?? ''; });
  expect(picked.id).toBe('upstage/solar-pro4');
  expect(prompts).toHaveLength(2);
});
