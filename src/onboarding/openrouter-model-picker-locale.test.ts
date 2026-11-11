import { expect, test } from 'bun:test';
import { promptOpenRouterModel } from './openrouter-model-picker.js';

test('English first-run OpenRouter model choice is readable without Korean prompts', async () => {
  const printed: string[] = [];
  const prompts: string[] = [];
  const pick = await promptOpenRouterModel(async (prompt) => {
    prompts.push(prompt);
    return '';
  }, (line) => printed.push(line), undefined, 'en');

  expect(pick.id).toBe('openai/gpt-5.3-codex');
  expect(printed[0]).toContain('Choose an OpenRouter model');
  expect(printed.at(-1)).toContain('Solar demo preset');
  expect(prompts[0]).toContain('Model number');
  expect([...printed, ...prompts].join('\n')).not.toMatch(/[가-힣]/);
});
