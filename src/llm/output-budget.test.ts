import { expect, test } from 'bun:test';
import { resolveModelContextWindow } from '../models/context-window.js';
import { resolveRequestMaxTokens } from './output-budget.js';

test('long-answer roles use catalog-aware budgets while explicit and classify caps survive', () => {
  expect(resolveRequestMaxTokens('gpt-6.1-terra', 'implement')).toBe(12_000);
  expect(resolveRequestMaxTokens('gpt-6.1-terra', 'classify')).toBe(2_048);
  expect(resolveRequestMaxTokens('openrouter/upstage/solar-pro4', 'planning')).toBe(12_288);
  expect(resolveRequestMaxTokens('openrouter/upstage/solar-pro4', 'classify')).toBe(2_048);
  expect(resolveRequestMaxTokens('openrouter/upstage/solar-pro4', 'planning', 700)).toBe(700);
  expect(resolveRequestMaxTokens('gpt-6.1-terra', 'planning', 700)).toBe(700);
  // Source: #36714 — the request budget uses one eighth of the model context as its safety ceiling.
  expect(resolveRequestMaxTokens('gpt-6.1-terra', 'implement')).toBeLessThanOrEqual(Math.floor(resolveModelContextWindow('gpt-6.1-terra')! / 8));
});
