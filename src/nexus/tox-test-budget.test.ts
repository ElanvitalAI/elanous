import { expect, test } from 'bun:test';
import { isolatedFakeToxBudget } from './tox-test-budget.js';

const fake = { ELANOUS_LLM_MODE: 'fake', ELANOUS_TEST_TOX_ZERO_SPEND: '1', ELANOUS_TEST_FAKE_LLM: '1',
  ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' };

test('isolated fake Nexus admits only zero-estimate TOX work and records the decision', async () => {
  const observed: boolean[] = [];
  const gate = isolatedFakeToxBudget('test', fake, allowed => observed.push(allowed));
  expect(gate).toBeDefined();
  expect(await gate!('intake', undefined)).toEqual({ canAfford: true, tripped: [] });
  expect(await gate!('intake', 0)).toEqual({ canAfford: true, tripped: [] });
  expect(await gate!('intake', 0.01)).toEqual({ canAfford: false, tripped: ['test-estimate-nonzero'] });
  expect(observed).toEqual([true, true, false]);
});

test('production and incomplete fake worlds keep the normal budget gate', () => {
  const observe = () => {};
  expect(isolatedFakeToxBudget('prod', fake, observe)).toBeUndefined();
  expect(isolatedFakeToxBudget('test', { ...fake, ELANOUS_LLM_MODE: 'real' }, observe)).toBeUndefined();
  expect(isolatedFakeToxBudget('test', { ...fake, ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '0' }, observe)).toBeUndefined();
  expect(isolatedFakeToxBudget('test', { ...fake, ELANOUS_TEST_TOX_ZERO_SPEND: '0' }, observe)).toBeUndefined();
});
