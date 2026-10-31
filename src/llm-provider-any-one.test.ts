import { afterEach, expect, spyOn, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { getProviderForConfig } from './llm.js';
import { normalizeFallbackChain } from './oauth/fallback-chain.js';
import { providerNamesFromFallbackChain } from './session-runtime/retry-policy.js';
import { resolveChildLlmPreference } from './self-implement/child-llm-preference.js';
import { harnessLaunchBudgetDecision } from './execution-loop/launch-gate.js';
import { runFirstRun } from './onboarding/first-run.js';
import type { UserConfig } from './user-config.js';

const originalFetch = globalThis.fetch;
const originalZaiKey = process.env.ZAI_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalZaiKey === undefined) delete process.env.ZAI_API_KEY;
  else process.env.ZAI_API_KEY = originalZaiKey;
});

async function withOpenAICompatibleServer(run: (requests: Array<{ path: string; model?: string }>) => Promise<void>): Promise<void> {
  const requests: Array<{ path: string; model?: string }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string };
        requests.push({ path: req.url ?? '', ...(body.model ? { model: body.model } : {}) });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      } catch {
        res.writeHead(400).end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake server did not bind');
  const realFetch = originalFetch;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
    const originalUrl = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return realFetch(`http://127.0.0.1:${address.port}${originalUrl.pathname}${originalUrl.search}`, init);
  }) as typeof fetch);
  try { await run(requests); }
  finally {
    fetchSpy.mockRestore();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('OpenRouter-only and GLM-only defaults stay on their configured provider against a fake OpenAI-compatible server', async () => {
  await withOpenAICompatibleServer(async (requests) => {
    const cases = [
      { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', apiKey: 'test-openrouter-key', expectedPath: '/api/v1/chat/completions', expectedWireModel: 'z-ai/glm-5.3' },
      { provider: 'glm', model: 'glm-5.3', expectedPath: '/api/coding/paas/v4/chat/completions', expectedWireModel: 'glm-5.3' },
    ] as const;
    process.env.ZAI_API_KEY = 'test-zai-key';
    for (const entry of cases) {
      const chain = normalizeFallbackChain(undefined, entry.provider).chain;
      expect(chain).toEqual([entry.provider === 'glm' ? 'zai' : 'openrouter']);
      expect(providerNamesFromFallbackChain(chain)).toEqual([entry.provider]);
      const llm = { provider: entry.provider, model: entry.model, ...('apiKey' in entry ? { apiKey: entry.apiKey } : {}) };
      const config = { llm, tools: { selfImplement: {} }, onboarding: { ready: false } } as unknown as UserConfig;
      const firstRun = await runFirstRun({ config, path: '/tmp/llm-provider-any-one-test.json', isTTY: false,
        detectProviders: async () => [], print: () => {}, saveConfig: () => {} });
      expect(firstRun).toMatchObject({ outcome: 'ready', provider: entry.provider, inputs: 0 });

      const childPreference = resolveChildLlmPreference(config);
      expect(childPreference.chain).toEqual([{ provider: entry.provider === 'glm' ? 'glm' : 'openrouter' }]);
      const launch = harnessLaunchBudgetDecision({
        preference: childPreference, codexCandidates: [], grokUsedPercent: undefined, maxUsedPercent: {},
      });
      expect(launch.decision).toMatchObject({ action: 'proceed', provider: childPreference.chain[0]!.provider });

      const provider = getProviderForConfig(config);
      for await (const _event of provider.streamChat!([{ role: 'user', content: 'provider smoke request' }])) { /* consume fake response */ }
      expect(requests.at(-1)).toEqual({ path: entry.expectedPath, model: entry.expectedWireModel });
    }
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => !/codex|grok/i.test(request.path + request.model))).toBe(true);
  });
});
