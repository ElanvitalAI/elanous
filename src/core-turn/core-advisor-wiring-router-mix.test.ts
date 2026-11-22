import { afterEach, expect, spyOn, test } from 'bun:test';
import { coreAdvisorForGoalLoop, streamLlmAdvisorClient } from './core-advisor-wiring.js';
import { PROVIDERS, type LLMProvider } from '../llm.js';
import { setUserConfigOverlay } from '../user-config.js';
import { WINDOW_SNAPSHOT_TTL_MS } from '../model-tier/window-account-selector.js';
import { LLM_TIER_MAP_BY_PROVIDER } from '../model-tier/llm-tier-map.js';
import type { AccountState } from '../model-tier/orchestration-core.js';
import { debug } from '../debug/log.js';

afterEach(() => setUserConfigOverlay(null));

test('actual streamLLM text path calls the provider selected for each advisor request', async () => {
  const oldRouter = PROVIDERS.openrouter;
  const oldCodex = PROVIDERS['openai-codex'];
  const called: string[] = [];
  const fake = (name: string): LLMProvider => ({
    name, defaultModel: 'fixture-model', available: () => true,
    async *chat() { called.push(name); yield 'fixture advice'; },
    async *streamChat() { called.push(name); yield { type: 'text', delta: 'fixture advice' }; },
  });
  PROVIDERS.openrouter = fake('openrouter');
  PROVIDERS['openai-codex'] = fake('openai-codex');
  try {
    const client = streamLlmAdvisorClient();
    for (const provider of ['openrouter', 'openai-codex'] as const) {
      const model = LLM_TIER_MAP_BY_PROVIDER[provider].best.model;
      const result = await client.advise({ runId: `fixture-${provider}`, moment: 'plan', provider, model,
        maxOutputTokens: 100, prompt: { objective: 'fixture objective', detail: '' } });
      expect(result.advice).toBe('fixture advice');
    }
    expect(called).toEqual(['openrouter', 'openai-codex']);
  } finally {
    if (oldRouter) PROVIDERS.openrouter = oldRouter;
    if (oldCodex) PROVIDERS['openai-codex'] = oldCodex;
  }
});

test('goal-loop advisor rereads mixed subscription state at each consultation', async () => {
  setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'openrouter' },
    harness: { ...config.harness, difficultyRouter: 'on', routerMix: 'on' } }));
  const oldRouter = PROVIDERS.openrouter;
  const oldCodex = PROVIDERS['openai-codex'];
  const called: string[] = [];
  const fake = (name: string): LLMProvider => ({
    name, defaultModel: 'fixture-model', available: () => true,
    async *chat() { called.push(name); yield 'fixture advice'; },
    async *streamChat() { called.push(name); yield { type: 'text', delta: 'fixture advice' }; },
  });
  PROVIDERS.openrouter = fake('openrouter');
  PROVIDERS['openai-codex'] = fake('openai-codex');
  const now = Date.now();
  const codex = (observedAtMs: number): AccountState => ({
    active: { provider: 'openai-codex', account: 'codex-a' }, selection: 'on', readAtMs: now, observedAtMs,
    candidates: [{ provider: 'openai-codex', account: 'codex-a', billing: 'subscription', window: { remaining: 0.8 } }],
  });
  const states: AccountState[] = [
    { active: { provider: 'openrouter', account: null }, candidates: [], selection: 'on', routerMix: { codex: undefined } },
    { active: { provider: 'openrouter', account: null }, candidates: [], selection: 'on', routerMix: { codex: codex(now - WINDOW_SNAPSHOT_TTL_MS - 1) } },
    { active: { provider: 'openrouter', account: null }, candidates: [], selection: 'on', routerMix: { codex: codex(now) } },
  ];
  let reads = 0;
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const advisor = coreAdvisorForGoalLoop({ userText: '대상 경로: src/security/access.ts\n위험 등급: L5',
      env: { ELANOUS_RUN_ID: `router-mix-fresh-${now}` }, readAccounts: () => states[reads++] })!;
    await advisor.plan('goal');
    advisor.noteToolResult('Bash', { ok: false, message: 'same failure' });
    const error = advisor.noteToolResult('Bash', { ok: false, message: 'same failure' });
    expect(error).toBeTruthy();
    await advisor.sameError('goal', [error!]);
    await advisor.beforeComplete('goal', 'evidence', { iteration: 1, maxIterations: 3 });
    expect(reads).toBe(3);
    const decisions = log.mock.calls.filter(([category, event]) => category === 'harness.route-decision' && event === 'decision')
      .map(([, , data]) => data as { provider: string; reason: string[] });
    expect(decisions.map((row) => row.provider)).toEqual(['openrouter', 'openrouter', 'openai-codex']);
    expect(decisions[1]!.reason).toContain('account:router-or-codex-mix:router:stale-snapshot');
    expect(called).toEqual(['openrouter', 'openrouter', 'openai-codex']);
  } finally {
    log.mockRestore();
    if (oldRouter) PROVIDERS.openrouter = oldRouter;
    if (oldCodex) PROVIDERS['openai-codex'] = oldCodex;
  }
});
