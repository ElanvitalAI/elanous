import { afterEach, beforeEach, expect, test } from 'bun:test';
import { streamLLM, streamLLMWithTools, type LLMProvider } from '../llm.js';

// TEST-FAKE-LLM-RESPECT-INJECTED — the gate pod baseline `ELANOUS_TEST_FAKE_LLM=1` replaces only the default provider
// resolution. A provider the caller injects owns its turn whether the switch is on or off; the isolated live-TUI stage
// (`ELANOUS_TEST_FAKE_LLM_AS_PROVIDER=1`) still fences it. Expectations are literals (rule 11).
const KEYS = ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_TEST_FAKE_LLM_AS_PROVIDER', 'ELANOUS_TEST_FAKE_LLM_RESPONSE',
  'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE'] as const;
let prior: Record<string, string | undefined> = {};
beforeEach(() => {
  prior = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of KEYS) {
    const value = prior[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function injectedProvider(): LLMProvider & { calls: number } {
  const provider = {
    name: 'injected-fixture', defaultModel: 'injected-fixture-model', calls: 0, available: () => true,
    async *chat() { provider.calls++; yield 'injected reply'; },
    async *streamChat() { provider.calls++; yield { type: 'text' as const, delta: 'injected reply' }; },
  };
  return provider;
}

async function viaStreamLLM(opts: { provider?: LLMProvider }): Promise<string> {
  return streamLLM([{ role: 'user', content: 'question' }], () => {}, opts);
}

async function viaStreamLLMWithTools(opts: { provider?: LLMProvider }): Promise<string> {
  return streamLLMWithTools([{ role: 'user', content: 'question' }], { onText: () => {}, dispatchTool: async () => ({}) }, opts);
}

for (const [label, run] of [['streamLLM', viaStreamLLM], ['streamLLMWithTools', viaStreamLLMWithTools]] as const) {
  test(`${label}: flag on + injected provider → injected provider answers`, async () => {
    process.env.ELANOUS_TEST_FAKE_LLM = '1';
    const provider = injectedProvider();
    expect(await run({ provider })).toBe('injected reply');
    expect(provider.calls).toBe(1);
  });

  test(`${label}: flag on + no injection → fake provider answers`, async () => {
    process.env.ELANOUS_TEST_FAKE_LLM = '1';
    process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = 'fake reply';
    expect(await run({})).toBe('fake reply');
  });

  test(`${label}: flag off + injected provider → injected provider answers`, async () => {
    const provider = injectedProvider();
    expect(await run({ provider })).toBe('injected reply');
    expect(provider.calls).toBe(1);
  });

  test(`${label}: live-TUI stage (flag on + AS_PROVIDER) still fences the injected provider`, async () => {
    process.env.ELANOUS_TEST_FAKE_LLM = '1';
    process.env.ELANOUS_TEST_FAKE_LLM_AS_PROVIDER = '1';
    process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = 'fake reply';
    const provider = injectedProvider();
    expect(await run({ provider })).toBe('fake reply');
    expect(provider.calls).toBe(0);
  });
}
