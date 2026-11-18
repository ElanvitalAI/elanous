/**
 * SIM-FAKE-LLM-REGISTRY — `test-fake-llm` is a known provider only in the test/sim universe
 * (provider wiring only). Expected values are independent literals.
 */
import { afterEach, expect, test } from 'bun:test';
import { finalizeProviderModelCompatibility, getProviderForConfig } from '../llm.js';
import type { UserConfig } from '../user-config/types.js';
import { resetTestFakeLlmScript } from './fake-llm.js';

const names = ['NODE_ENV', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE', 'ELANOUS_LLM_MODE'] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetTestFakeLlmScript();
});

function productionUniverse(): void {
  for (const name of names) delete process.env[name];
}

const autoConfig = { llm: { provider: 'auto' } } as unknown as UserConfig;

test('test universe (NODE_ENV=test): test-fake-llm is admitted by the compatibility gate and the config resolver', () => {
  productionUniverse();
  process.env.NODE_ENV = 'test';
  expect(finalizeProviderModelCompatibility({ provider: 'test-fake-llm' as never, model: 'grok-4', auth: 'none' }))
    .toEqual({ provider: 'test-fake-llm' as never, model: 'grok-4', auth: 'none' });
  expect(getProviderForConfig(autoConfig, 'grok-4').name).toBe('test-fake-llm');
});

test('sim universe (ELANOUS_SIM_UNIVERSE=1, ELANOUS_UX_SIM_RUN_ID, gate ELANOUS_TEST_FAKE_LLM=1) admits test-fake-llm', () => {
  for (const [name, value] of [['ELANOUS_SIM_UNIVERSE', '1'], ['ELANOUS_UX_SIM_RUN_ID', 'run-1118'], ['ELANOUS_TEST_FAKE_LLM', '1']] as const) {
    productionUniverse();
    process.env[name] = value;
    expect(finalizeProviderModelCompatibility({ provider: 'test-fake-llm' as never, model: 'm', auth: 'none' }).provider).toBe('test-fake-llm' as never);
  }
});

test('production universe: test-fake-llm stays an unknown provider (literal message)', () => {
  productionUniverse();
  expect(() => finalizeProviderModelCompatibility({ provider: 'test-fake-llm' as never, model: 'm', auth: 'none' }))
    .toThrow('Cannot establish provider-model compatibility: unknown provider "test-fake-llm" for model "m"');
  // `--fake-llm` is a mode, not a universe: the fake is chosen, but its name is still not registered in production.
  process.env.ELANOUS_LLM_MODE = 'fake';
  expect(() => getProviderForConfig(autoConfig, 'grok-4'))
    .toThrow('Cannot establish provider-model compatibility: unknown provider "test-fake-llm" for model "grok-4"');
});
