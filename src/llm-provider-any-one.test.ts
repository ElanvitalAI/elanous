import { afterEach, expect, spyOn, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProviderForConfig, resolveDefaultProviderAsync, streamLLM } from './llm.js';
import { normalizeFallbackChain } from './oauth/fallback-chain.js';
import { providerNamesFromFallbackChain } from './session-runtime/retry-policy.js';
import { resolveChildLlmPreference } from './self-implement/child-llm-preference.js';
import { harnessLaunchBudgetDecision } from './execution-loop/launch-gate.js';
import { runFirstRun } from './onboarding/first-run.js';
import { setUserConfigOverlay, type UserConfig } from './user-config.js';
import { podChildLlmArgs, podNamedChildProvider, podSelfImplementSpawn } from './task-orchestrator/surfaces/self-implement-pod.js';
import { runResearchQuestionLadder } from './auto-research/research-turn.js';
import { routeResearchOutput } from './research/output-router.js';
import { getUserConfig } from './user-config.js';
import { bootDashboardAcpSession } from './dashboard/acp-boot.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from './elanous-config-dir.js';

const originalFetch = globalThis.fetch;
const originalZaiKey = process.env.ZAI_API_KEY;

afterEach(() => {
  setUserConfigOverlay(null);
  globalThis.fetch = originalFetch;
  if (originalZaiKey === undefined) delete process.env.ZAI_API_KEY;
  else process.env.ZAI_API_KEY = originalZaiKey;
});

type CapturedRequest = { path: string; model?: string };

function fakeKubectl(conditions: string[], logs: string) {
  const calls: Array<{ args: string; input?: string }> = [];
  let polls = 0;
  const k = (args: string[], input?: string) => {
    calls.push({ args: args.join(' '), ...(input ? { input } : {}) });
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.includes('secret')) return { status: 0, stdout: 'ZAI_API_KEY\n', stderr: '' };
    if (args.some((arg) => arg.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: conditions[Math.min(polls++, conditions.length - 1)] ?? '', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: logs, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { k, calls };
}

async function withOpenAICompatibleServer(
  run: (requests: CapturedRequest[], attempts: Array<{ host: string; model?: string }>) => Promise<void>,
  respond: (messages: string) => string = () => 'Mock OpenRouter answer',
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const attempts: Array<{ host: string; model?: string }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string; messages?: unknown };
        requests.push({ path: req.url ?? '', ...(body.model ? { model: body.model } : {}) });
        const content = respond(JSON.stringify(body.messages ?? []));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
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
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { model?: string } : undefined;
    attempts.push({ host: originalUrl.hostname, ...(body?.model ? { model: body.model } : {}) });
    return realFetch(`http://127.0.0.1:${address.port}${originalUrl.pathname}${originalUrl.search}`, init);
  }) as typeof fetch);
  try { await run(requests, attempts); }
  finally {
    fetchSpy.mockRestore();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function sendConfiguredDashboardTurn(userText: string): Promise<string> {
  const boot = await bootDashboardAcpSession({
    getCwd: () => process.cwd(),
    getChatHistory: () => [],
    getPreamble: () => [],
    getTools: () => [],
    getActiveModel: () => null,
    dispatchTool: async () => ({ error: 'unexpected tool dispatch' }),
    pushTurnToolHistory: () => {},
  });
  const chunks: string[] = [];
  try {
    await boot.session.send({ userText, onText: (chunk) => chunks.push(chunk), onToolResult: () => {} });
    return chunks.join('');
  } finally {
    await boot.session.close();
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

test('OpenRouter-only host fallback does not send Codex/Grok into the launch budget gate', () => {
  const chain = normalizeFallbackChain(undefined, 'openrouter').chain;
  expect(chain).toEqual(['openrouter']);
  const judged = harnessLaunchBudgetDecision({
    preference: { mode: 'auto', chain: chain.map((provider) => ({ provider })),
      budgetGate: { minHeadroomPercent: 0, onShortfall: 'stop' },
      source: { mode: 'inferred', chain: 'fallbackChain' } },
    codexCandidates: [{ name: 'team', usedPercent: 100 }],
    grokUsedPercent: 100,
    maxUsedPercent: { 'openai-codex': 95, grok: 80 },
  } as unknown as Parameters<typeof harnessLaunchBudgetDecision>[0]);
  expect(judged.decision).toMatchObject({ action: 'proceed', provider: 'openrouter' });
});

test('source wiring: both self-orchestrate launch checks pass the configured provider', async () => {
  // This narrow source assertion protects the two private CLI callsites; behavior
  // of the normalized provider chain and launch budget is exercised above.
  const source = await Bun.file(new URL('./index.ts', import.meta.url)).text();
  const wiredChecks = source.match(/normalizeFallbackChain\(launchPolicy\.llm\?\.fallbackChain,\s*launchPolicy\.llm\?\.provider\)/g) ?? [];
  expect(wiredChecks).toHaveLength(2);
});

test('OpenRouter-only TUI, research, and mock Pod child keep the configured provider', async () => {
  const envKeys = [
    'ELANOUS_LLM_PROVIDER', 'ELANOUS_LLM_MODEL', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY',
    'ZAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY',
  ] as const;
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of envKeys) delete process.env[key];
    const model = 'openrouter/z-ai/glm-5.3';
    setUserConfigOverlay((base) => ({
      ...base,
      llm: { ...base.llm, provider: 'openrouter', model, apiKey: 'test-openrouter-key', fallbackChain: undefined },
    }));

    const config = {
      llm: { provider: 'openrouter', model, apiKey: 'test-openrouter-key' },
      tools: { selfImplement: {} },
    } as unknown as UserConfig;
    const researchQuestions = Array.from({ length: 6 }, (_, index) => ({
      id: `q${index + 1}`,
      level: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6,
      prompt: `Research axis ${index + 1}`,
      searchTerms: [`research axis ${index + 1}`],
      sectionId: 'findings',
    }));
    const preparation = JSON.stringify({
      outputContract: {
        deliverable: 'A concise mock research report',
        format: 'text',
        sections: [{ id: 'findings', title: 'Findings', purpose: 'Summarize supported findings' }],
        completionCriteria: ['Every finding has two independent sources'],
      },
      questions: researchQuestions,
    });

    await withOpenAICompatibleServer(async (requests, attempts) => {
      const provider = await resolveDefaultProviderAsync();
      expect(provider.name).toBe('openrouter');

      // The actual dashboard ACP turn routes through the configured provider.
      await expect(sendConfiguredDashboardTurn('Say hello in one sentence.')).resolves.toContain('Mock OpenRouter answer');

      // Research generation inherits that configured provider; all search evidence is mocked.
      const research = await runResearchQuestionLadder('Explain a mock research topic.', {
        initialProvider: provider,
        allowOutputSkill: false,
        routeOutput: (input) => routeResearchOutput({ ...input, skills: [] }),
        invokeAxes: async (axes) => ({
          plan: [],
          axes: axes.map((axis) => ({ questionId: axis.id, evidence: ['example.org', 'example.net'].map((host) => ({
            questionId: axis.id,
            sourceKind: 'web-search:mock',
            source: `https://${host}/${axis.id}`,
            content: `Mock evidence for ${axis.id} from ${host}`,
            outcome: 'complete' as const,
            truncated: false,
          })) })),
        }),
      });
      expect(research.ok).toBe(true);
      expect(research.ladder.evidence).toHaveLength(12);

      // The mock goal uses the actual child preference and Pod argument builder.
      const childPreference = resolveChildLlmPreference(config);
      expect(childPreference.chain).toEqual([{ provider: 'openrouter' }]);
      expect(podNamedChildProvider('openrouter', {
        grokSubscription: false, grokApiKey: false, openrouterKey: true,
      }, model)).toEqual({ provider: 'openrouter' });
      expect(podChildLlmArgs({ provider: 'openrouter', childModel: model, childProviderExplicit: false }))
        .toEqual(['--child-llm-provider', 'openrouter', '--child-llm-model', model]);
      const mockPod = fakeKubectl(['Complete'], '');
      const podResult = await podSelfImplementSpawn({
        kubectl: mockPod.k as never,
        // The injected kubectl path must never inspect docker tags or read git HEAD.
        imageCommit: null,
        budgetSnapshot: () => undefined,
        sleep: async () => {},
        credentials: () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_mock' }),
        provider: childPreference.chain[0]!.provider as 'openrouter',
        childModel: model,
        childProviderExplicit: false,
        openrouterGhToken: () => 'gho_mock',
        env: { OPENROUTER_API_KEY: 'test-openrouter-key' },
        readKeyCache: () => undefined,
        fallbackConfig: () => getUserConfig(),
        authorConfig: () => getUserConfig(),
      })({ feature: 'mock implementation goal', spaceId: 'llm-provider-any-one-openrouter' }).done;
      expect(podResult.exitCode).toBe(0);
      const podManifests = mockPod.calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!));
      expect(podManifests).toHaveLength(2);
      const secret = podManifests.find((manifest) => manifest.kind === 'Secret');
      const job = podManifests.find((manifest) => manifest.kind === 'Job');
      expect(secret?.stringData['env-OPENROUTER_API_KEY']).toBe('test-openrouter-key');
      expect(job?.spec.template.spec.containers[0].args[0]).toContain("'--child-llm-provider' 'openrouter'");
      expect(job?.spec.template.spec.containers[0].args[0]).toContain(`'--child-llm-model' '${model}'`);
      expect(job?.spec.template.spec.containers[0].args[0]).toContain('ELANOUS_POD_FALLBACK_CHAIN source=default steps=openrouter');
      await expect(streamLLM([{ role: 'user', content: 'Mock harness implementation goal.' }], () => {}, {
        initialProvider: provider,
        usageSite: 'llm-provider-any-one-mock-child',
      })).resolves.toBe('Mock OpenRouter answer');

      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(requests.every((request) => request.path === '/api/v1/chat/completions' && request.model === 'z-ai/glm-5.3')).toBe(true);
      expect(attempts.length).toBeGreaterThanOrEqual(3);
      expect(attempts.every((attempt) => attempt.host === 'openrouter.ai' && attempt.model === 'z-ai/glm-5.3')).toBe(true);
      expect(requests.every((request) => !/codex|grok/i.test(request.path + request.model))).toBe(true);
    }, (messages) => messages.includes('outputContract') && messages.includes('questions')
      ? preparation : 'Mock OpenRouter answer');
  } finally {
    setUserConfigOverlay(null);
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 20_000);

test('GLM-only configured default reaches a fresh mock Pod Job as GLM', async () => {
  const envKeys = ['HOME', 'ELANOUS_CONFIG_DIR', 'ELANOUS_STATE_DIR', 'ELANOUS_STATE_DIR_SOURCE', 'ELANOUS_SESSION_ROOT', 'XDG_CONFIG_HOME',
    'ELANOUS_LLM_PROVIDER', 'ELANOUS_LLM_MODEL', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY',
    'ZAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'] as const;
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const savedConfigDir = getElanousConfigDirOverride();
  const isolatedHome = mkdtempSync(join(tmpdir(), 'llm-provider-any-one-glm-'));
  try {
    process.env.HOME = isolatedHome;
    process.env.ELANOUS_CONFIG_DIR = isolatedHome;
    process.env.ELANOUS_STATE_DIR = isolatedHome;
    process.env.ELANOUS_STATE_DIR_SOURCE = 'test';
    process.env.ELANOUS_SESSION_ROOT = isolatedHome;
    process.env.XDG_CONFIG_HOME = join(isolatedHome, 'xdg');
    setElanousConfigDir(isolatedHome);
    for (const key of envKeys.slice(6)) delete process.env[key];
    process.env.ZAI_API_KEY = 'test-zai-key';
    const model = 'glm-5.3';
    setUserConfigOverlay((base) => ({
      ...base,
      llm: { ...base.llm, provider: 'glm', model, apiKey: 'test-zai-key', fallbackChain: undefined,
        zaiCodingPlan: { overage: 'stop', maxConcurrent: 3 } },
    }));
    const config = { llm: { provider: 'glm', model, apiKey: 'test-zai-key', fallbackChain: undefined,
      zaiCodingPlan: { overage: 'stop', maxConcurrent: 3 } }, tools: { selfImplement: {} } } as unknown as UserConfig;

    await withOpenAICompatibleServer(async (requests, attempts) => {
      const provider = await resolveDefaultProviderAsync();
      expect(provider.name).toBe('glm');
      await expect(sendConfiguredDashboardTurn('Say hello in one sentence.')).resolves.toContain('Mock OpenRouter answer');
      expect(requests).toEqual([{ path: '/api/coding/paas/v4/chat/completions', model }]);
      expect(attempts).toEqual([{ host: 'api.z.ai', model }]);

      const childPreference = resolveChildLlmPreference(config);
      expect(childPreference.chain).toEqual([{ provider: 'glm' }]);
      const mockPod = fakeKubectl(['Complete'], '');
      const podResult = await podSelfImplementSpawn({
        kubectl: mockPod.k as never,
        imageCommit: null,
        budgetSnapshot: () => undefined,
        sleep: async () => {},
        credentials: () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_mock' }),
        openrouterGhToken: () => 'gho_mock',
        provider: childPreference.chain[0]!.provider as 'glm',
        childModel: model,
        childProviderExplicit: true,
        env: {},
        readKeyCache: () => undefined,
        fallbackConfig: () => config,
        authorConfig: () => config,
        zaiSettings: () => ({ overage: 'stop', maxConcurrent: 3 }),
      })({ feature: 'mock GLM-only implementation goal', spaceId: 'llm-provider-any-one-glm' }).done;
      expect(podResult.exitCode).toBe(0);
      const job = mockPod.calls.filter((call) => call.args.endsWith('apply -f -'))
        .map((call) => JSON.parse(call.input!)).find((manifest) => manifest.kind === 'Job');
      expect(job?.spec.template.spec.containers[0].args[0]).toContain("'--child-llm-provider' 'glm'");
      expect(JSON.stringify(job)).toContain('ZAI_API_KEY');
      expect(JSON.stringify(job)).not.toContain('test-zai-key');
      expect(mockPod.calls.some((call) => call.args.includes('elanous-zai-coding-plan'))).toBe(true);
    });
  } finally {
    setUserConfigOverlay(null);
    if (savedConfigDir === undefined) resetElanousConfigDir();
    else setElanousConfigDir(savedConfigDir);
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}, 20_000);
