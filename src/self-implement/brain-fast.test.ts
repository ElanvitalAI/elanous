import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { clearLaunchRoleLlmOverrides, getUserConfig, setLaunchRoleLlmOverrides, setUserConfigOverlay } from '../user-config.js';
import { createSelfImplementControlBrain } from './seams.js';
import { decideInterventionStep } from './intervention-step.js';
import { runHeadlessGoalLoopPty } from './headless-elanous-driver.js';
import { getProviderForConfig, streamLLM, type LLMProvider } from '../llm.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveTokens } from '../oauth/store.js';

const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logs.length = 0;
  logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    logs.push({ category, event, data: data ?? {} });
  }) as typeof debug.log);
});

afterEach(() => {
  logSpy.mockRestore();
  setUserConfigOverlay(null);
  clearLaunchRoleLlmOverrides();
});

const observation = {
  screen: 'working', state: 'working' as const, step: 0, changed: true, sameScreenMs: 0,
  intervention: decideInterventionStep({ screen: 'working', previous: null, stopAfterSameScreens: 2, descriptor: { controlStance: 'owned' } }),
};

test('classify without an explicit role chooses the active Codex budget model once and passes it to the brain', async () => {
  setUserConfigOverlay((config) => ({ ...config, roleLlm: undefined, llm: { ...config.llm, provider: 'openai-codex' } }));
  const calls: string[] = [];
  const brain = createSelfImplementControlBrain({ goal: 'feature', stream: async (_messages, _cb, opts) => {
    calls.push(opts?.model ?? '');
    return '{"action":"wait"}';
  } });
  await brain.decide(observation);
  await brain.decide({ ...observation, step: 1 });
  expect(lookupLlmTierSpec('openai-codex', 'budget')).toMatchObject({ model: 'gpt-6-luna', reasoningLevel: 'off' });
  expect(calls).toEqual(['gpt-6-luna', 'gpt-6-luna']);
  expect(logs.filter(({ category, event }) => category === 'self-implement' && event === 'brain.model').map(({ data }) => data))
    .toEqual([{ provider: 'openai-codex', model: 'gpt-6-luna', source: 'tier-budget' }]);
});

test('caller model is preserved ahead of classify role and budget defaults', async () => {
  setUserConfigOverlay((config) => ({ ...config, roleLlm: { classify: { provider: 'anthropic', model: 'configured-model' } }, llm: { ...config.llm, provider: 'openai-codex' } }));
  const calls: string[] = [];
  const brain = createSelfImplementControlBrain({ goal: 'feature', model: 'gpt-6-sol',
    stream: async (_messages, _cb, opts) => { calls.push(opts?.model ?? ''); return '{"action":"wait"}'; } });
  await brain.decide(observation);
  expect(calls).toEqual(['gpt-6-sol']);
  expect(logs.filter(({ event }) => event === 'brain.model').map(({ data }) => data))
    .toEqual([{ provider: 'openai-codex', model: 'gpt-6-sol', source: 'caller' }]);
});

test('explicit caller provider conflicting with classify provider is rejected before a request', async () => {
  setUserConfigOverlay((config) => ({ ...config, roleLlm: { classify: { provider: 'anthropic', model: 'configured-model' } }, llm: { ...config.llm, provider: 'openai-codex' } }));
  let requested = false;
  expect(() => createSelfImplementControlBrain({ goal: 'feature', provider: 'openai-codex',
    stream: async () => { requested = true; return '{"action":"wait"}'; } }))
    .toThrow('brain provider conflict: caller=openai-codex, classify=anthropic');
  expect(requested).toBe(false);
  expect(logs.filter(({ event }) => event === 'brain.model')).toHaveLength(0);
  const brain = createSelfImplementControlBrain({ goal: 'feature', provider: 'anthropic',
    stream: async (_messages, _cb, opts) => { expect(opts?.model).toBe('configured-model'); return '{"action":"wait"}'; } });
  await brain.decide(observation);
  expect(logs.filter(({ event }) => event === 'brain.model').map(({ data }) => data))
    .toEqual([{ provider: 'anthropic', model: 'configured-model', source: 'config-role' }]);
  setLaunchRoleLlmOverrides({ classify: { provider: 'grok', model: 'flag-model' } });
  expect(() => createSelfImplementControlBrain({ goal: 'feature', provider: 'anthropic' }))
    .toThrow('brain provider conflict: caller=anthropic, classify=grok');
});

test('budget brain routes through getProviderForConfig with reasoning off despite high configured effort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-fast-codex-'));
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const priorCodexHome = process.env.CODEX_HOME;
  const priorAccount = process.env.ELANOUS_CODEX_ACCOUNT;
  const fetchSpy = spyOn(globalThis, 'fetch');
  try {
    process.env.XDG_CONFIG_HOME = dir;
    process.env.ELANOUS_CODEX_ACCOUNT = 'brain-fast';
    process.env.CODEX_HOME = join(dir, 'codex');
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    saveTokens('openai-codex:brain-fast', { accessToken: 'test-token', refreshToken: 'test-refresh', expiresAt: Date.now() + 86_400_000 },
      { mirrorCodex: false, codexHome: process.env.CODEX_HOME });
    setUserConfigOverlay((config) => ({ ...config, roleLlm: undefined, llm: {
      ...config.llm, provider: 'openai-codex', model: 'gpt-6-sol',
      reasoningLevel: 'high', codexReasoning: { effort: 'high', summary: 'auto' },
    } }));
    const bodies: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation((async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: {"type":"response.output_text.delta","delta":"{\\"action\\":\\"wait\\"}"}\n\ndata: {"type":"response.completed","response":{"id":"test-response"}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch);
    const configuredProvider = getProviderForConfig(getUserConfig(), 'gpt-6-luna');
    for await (const _chunk of configuredProvider.streamChat!([{ role: 'user', content: 'baseline' }], { model: 'gpt-6-luna' })) { /* drain provider stream */ }
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'high' } });
    const brain = createSelfImplementControlBrain({ goal: 'feature' });
    await brain.decide(observation);
    expect(logs.filter(({ event }) => event === 'brain-error')).toEqual([]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.model).toBe('gpt-6-luna');
    expect(bodies[1]!.reasoning).toBeUndefined();
  } finally {
    fetchSpy.mockRestore();
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    if (priorAccount === undefined) delete process.env.ELANOUS_CODEX_ACCOUNT;
    else process.env.ELANOUS_CODEX_ACCOUNT = priorAccount;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classify explicit flag or config role wins over the budget tier', async () => {
  setUserConfigOverlay((config) => ({ ...config, roleLlm: { classify: { provider: 'anthropic', model: 'configured-model' } }, llm: { ...config.llm, provider: 'openai-codex' } }));
  const calls: string[] = [];
  const make = () => createSelfImplementControlBrain({ goal: 'feature', stream: async (_messages, _cb, opts) => {
    calls.push(opts?.model ?? '');
    return '{"action":"wait"}';
  } });
  await make().decide(observation);
  setLaunchRoleLlmOverrides({ classify: { provider: 'grok', model: 'flag-model' } });
  await make().decide(observation);
  expect(calls).toEqual(['configured-model', 'flag-model']);
  expect(logs.filter(({ event }) => event === 'brain.model').map(({ data }) => data))
    .toEqual([
      { provider: 'anthropic', model: 'configured-model', source: 'config-role' },
      { provider: 'grok', model: 'flag-model', source: 'flag' },
    ]);
});

function fakePty() {
  let alive = true;
  return {
    id: 'self_brain_fast', write: () => {}, renderScreen: async () => 'working', renderScreenPng: async () => null,
    snapshot: () => 'working', drainDelta: () => '', isAlive: () => alive,
    canWrite: () => true, exitCode: null, kill: () => { alive = false; },
  };
}

test('a 20-second brain answer succeeds by default, records duration, and does not report brain.fail', async () => {
  const pty = fakePty();
  const result = await runHeadlessGoalLoopPty({
    binRoot: '/tmp/repo', cwd: '/tmp/brain-fast', featurePrompt: 'feature',
    maxWaitSec: 1, maxHardWaitSec: 40, activityGraceSec: 0, pollMs: 1,
    ptyAvailable: () => true, spawn: (() => pty) as never,
    brain: { decide: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return { action: 'wait' };
    } },
  });
  expect(result.ok).toBe(true);
  expect(logs.filter(({ event }) => event === 'brain.fail')).toHaveLength(0);
  const suggestions = logs.filter(({ event }) => event === 'brain.suggestion');
  expect(suggestions.length).toBeGreaterThan(0);
  expect(suggestions[0]!.data.durationMs).toBeGreaterThanOrEqual(20_000);
}, 50_000);

test('concurrent 20-second brain answers remain below 5% suggestion timeouts', async () => {
  const loops = 20;
  const results = await Promise.all(Array.from({ length: loops }, (_, index) => runHeadlessGoalLoopPty({
    binRoot: '/tmp/repo', cwd: `/tmp/brain-fast-${index}`, featurePrompt: 'feature',
    maxWaitSec: 1, maxHardWaitSec: 40, activityGraceSec: 0, pollMs: 1,
    ptyAvailable: () => true, spawn: (() => fakePty()) as never,
    brain: { decide: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return { action: 'wait' };
    } },
  })));
  expect(results.every((result) => result.ok)).toBe(true);
  const failures = logs.filter(({ event, data }) => event === 'brain.fail' && data.error === 'brain suggestion timeout');
  const suggestions = logs.filter(({ event }) => event === 'brain.suggestion');
  expect(suggestions.length).toBeGreaterThanOrEqual(loops);
  expect(failures.length / (failures.length + suggestions.length)).toBeLessThan(0.05);
}, 50_000);

test('injected brainTimeoutMs still wins, logs a timed failure, and polling continues', async () => {
  const result = await runHeadlessGoalLoopPty({
    binRoot: '/tmp/repo', cwd: '/tmp/brain-fast', featurePrompt: 'feature',
    maxWaitSec: 1, maxHardWaitSec: 2, activityGraceSec: 0, pollMs: 1, brainTimeoutMs: 10,
    ptyAvailable: () => true, spawn: (() => fakePty()) as never,
    brain: { decide: () => new Promise(() => {}) },
  });
  expect(result.ok).toBe(true);
  expect(logs.filter(({ event }) => event === 'brain.fail')).toContainEqual(expect.objectContaining({
    data: expect.objectContaining({ error: 'brain suggestion timeout', durationMs: expect.any(Number) }),
  }));
});

test('streamLLM outcome carries a numeric duration and retains provider/status/kind', async () => {
  const provider: LLMProvider = {
    name: 'brain-test', defaultModel: 'test-model', available: () => true,
    chat: async function* () { yield 'answer'; },
  };
  expect(await streamLLM([{ role: 'user', content: 'hello' }], () => {}, { provider })).toBe('answer');
  expect(logs.filter(({ category, event }) => category === 'llm' && event === 'outcome').map(({ data }) => data))
    .toEqual([expect.objectContaining({ provider: 'brain-test', status: 'ok', kind: 'streamLLM', durationMs: expect.any(Number) })]);
});
