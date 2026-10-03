import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resolveRoleLlm, ROLE_MODEL_DEFAULTS, getUserConfig, clearLaunchRoleLlmOverrides, setUserConfigOverlay } from '../user-config.js';
import { loadLlmPolicy } from '../policy/llm-policy.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { judge } from './judge-layer.js';
import { categorizeDecomposition } from '../intake-plane/categorize.js';
import { buildRealIntakeCallables } from '../intake-plane/runtime-callables.js';
import { classifyIntakeFrontRoute } from '../intake-plane/front-route-classifier.js';
import { createMissionRouter } from './mission-router.js';
import { submitIntent } from '../intent-gate/gate.js';
import { TaskStore } from '../task-orchestrator/store.js';
import type { EnrichedDecomposition } from '../intake-plane/enrich.js';

// Deterministic runs carry no ambient LLM credentials — pin a provider only when config left it on «auto».
beforeAll(() => setUserConfigOverlay((c) => (c.llm.provider === 'auto' ? { ...c, llm: { ...c.llm, provider: 'openai-codex' } } : c)));
afterAll(() => setUserConfigOverlay(null));


test('explicit classify role model reaches the fake LLM and emits call observation', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = await judge({
      site: 'test.role', prompt: 'classify',
      resolveRoleProvider: (role) => {
        expect(role).toBe('classify');
        return { provider: { name: 'fake' }, model: 'pinned-small' };
      },
      streamLLM: async (_messages, _chunk, opts) => {
        expect(opts).toMatchObject({ provider: { name: 'fake' }, model: 'pinned-small', usageRole: 'classify' });
        return '{"category":"research"}';
      },
      schema: (value) => value && typeof value === 'object' && (value as { category?: string }).category === 'research' ? 'research' : null,
    });
    expect(result.ok && result.value).toBe('research');
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'test.role', provider: 'fake', model: 'pinned-small', ok: true, ms: expect.any(Number) }));
  } finally { log.mockRestore(); }
});

test('provider resolver without model omits model from the stream options', async () => {
  let received: unknown;
  const result = await judge({ site: 'test.provider-default', prompt: 'classify',
    resolveRoleProvider: () => ({ provider: { name: 'fake' } }),
    streamLLM: async (_messages, _chunk, opts) => { received = opts; return 'ok'; },
  });
  expect(result.ok).toBe(true);
  expect(received).toMatchObject({ provider: { name: 'fake' }, usageRole: 'classify' });
  expect(received).not.toHaveProperty('model');
});

test('front-route classifier preserves provider-default model omission', async () => {
  let received: unknown;
  const decision = await classifyIntakeFrontRoute('ambiguous input', {
    resolveRoleProvider: () => ({ provider: { name: 'fake' } }),
    streamLLM: async (_messages, _chunk, opts) => {
      received = opts;
      return '{"track":"graph","confidence":0.8,"reason":"classified"}';
    },
  });
  expect(decision.track).toBe('graph');
  expect(received).not.toHaveProperty('model');
});

test('role policy accepts an explicit classify provider and model', () => {
  mkdirSync(join(process.cwd(), '.elanous-test'), { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), '.elanous-test', 'judge-policy-'));
  try {
    mkdirSync(join(dir, 'policy'));
    writeFileSync(join(dir, 'policy', 'llm.yaml'), 'version: 1\nroles:\n  classify:\n    provider: gemini\n    model: tiny-pinned\n');
    const loaded = loadLlmPolicy({ configDir: dir, legacyConfig: {} });
    expect(loaded.valid).toBe(true);
    expect(loaded.policy.roles.classify).toEqual({ provider: 'gemini', model: 'tiny-pinned' });
    expect(resolveRoleLlm('classify', { config: { ...getUserConfig(), roleLlm: loaded.policy.roles } })).toMatchObject({
      provider: 'gemini', model: 'tiny-pinned', source: 'config-role',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('configured classify role is selected for the actual fake judge call', async () => {
  const cfg = { ...getUserConfig(), roleLlm: { classify: { provider: 'gemini' as const, model: 'pinned-small' } } };
  const calls: Array<{ provider: string; model: string }> = [];
  const result = await judge({ site: 'test.config-role', prompt: 'classify', config: cfg,
    call: async ({ provider, model }) => { calls.push({ provider, model }); return { text: 'ok' }; },
  });
  expect(result.ok).toBe(true);
  expect(calls).toEqual([{ provider: 'gemini', model: 'pinned-small' }]);
});

test('stream-only judge resolves the complete registered provider, not a name placeholder', async () => {
  const { PROVIDERS } = await import('../llm.js');
  const cfg = { ...getUserConfig(), roleLlm: { classify: { provider: 'gemini' as const, model: 'pinned-small' } } };
  let received: unknown;
  const decision = await judge({ site: 'test.stream-only', prompt: 'classify', config: cfg,
    streamLLM: async (_messages, _chunk, opts) => { received = opts?.provider; return 'ok'; },
  });
  expect(decision.ok).toBe(true);
  expect(received).toBe(PROVIDERS.gemini);
});

test('without classify override the active provider budget tier is selected', async () => {
  const resolved = resolveRoleLlm('classify');
  const seen: Array<{ provider: string; model: string }> = [];
  const result = await judge({ site: 'test.default', prompt: 'classify',
    call: async ({ provider, model }) => { seen.push({ provider, model }); return { text: 'ok' }; },
  });
  expect(result.ok).toBe(true);
  expect(seen).toEqual([{ provider: resolved.provider, model: resolved.model }]);
  expect(ROLE_MODEL_DEFAULTS.classify.tier).toBe('budget');
  expect(resolveRoleLlm('classify', {
    config: { ...getUserConfig(), roleLlm: undefined, roleModels: undefined, roleModelTiers: undefined },
    overrides: {},
  }).model).toBe(process.env[ROLE_MODEL_DEFAULTS.classify.environment]?.trim() || lookupLlmTierSpec(resolved.provider, 'budget').model);
});

test('real intake adapter uses judge-selected model only for categorize, not generation', async () => {
  const calls: Array<{ model?: string; provider?: string }> = [];
  const role = resolveRoleLlm('classify');
  const callables = buildRealIntakeCallables({
    model: 'generation-model', provider: 'gemini',
    resolveProvider: () => ({ name: 'gemini' }),
    providers: { gemini: { name: 'gemini' }, [role.provider]: { name: role.provider } },
    synthFromIntent: async () => ({ ok: false }),
    streamLLM: async (_messages, _chunk, opts) => {
      calls.push({ model: opts?.model, provider: opts?.provider?.name });
      return '{"categorizations":[{"key":"m-1/t-1","category":"research","workflowEligible":true,"confidence":"high"}]}';
    },
  });
  const decomposition = { missions: [{ id: 'm-1', title: 'Test', tasks: [{ id: 't-1', title: 'Classify', intent: 'classify', context: { enrichments: [] } }] }] } as unknown as EnrichedDecomposition;
  const result = await categorizeDecomposition(decomposition, { callable: callables.categorize });
  expect(result.categorizations['m-1/t-1']?.category).toBe('research');
  expect(result.usage?.modelId).toBe(role.model);
  expect(calls[0]).toEqual({ provider: role.provider, model: role.model });
  await callables.decompose({ prompt: 'generate' });
  expect(calls[1]).toEqual({ provider: 'gemini', model: 'generation-model' });
});

test('front-route classifier traverses judge and keeps its rule fallback', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const deps = {
    resolveRoleProvider: () => ({ provider: { name: 'fake' }, model: 'small' }),
    streamLLM: async () => '{"track":"graph","confidence":0.8,"reason":"classified"}',
  };
  try {
    expect(await classifyIntakeFrontRoute('ambiguous input', deps)).toMatchObject({ track: 'graph', decidedBy: 'classifier' });
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'intake.front-route', model: 'small', ok: true }));
    expect(await classifyIntakeFrontRoute('ambiguous input', { ...deps, streamLLM: async () => '{"track":"bad"}' }))
      .toMatchObject({ track: 'ask-human', decidedBy: 'classifier' });
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'intake.front-route', ok: false }));
  } finally { log.mockRestore(); }
});

test('mission router injected Tier 2 decision traverses judge; invalid response falls back to Tier 1', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const input = { text: 'the weather is lovely and the cat is sleeping near the windowsill' };
    const picks: Array<{ provider?: string; model?: string }> = [];
    const router = createMissionRouter({ localLLM: { classify: async ({ provider, model }) => {
      picks.push({ provider, model });
      return { mission: 'review', confidence: 0.8, model };
    } } });
    expect(await router.predict(input)).toMatchObject({ mission: 'review', tier: 2 });
    const role = resolveRoleLlm('classify');
    expect(picks).toEqual([{ provider: role.provider, model: role.model }]);
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'llm.mission-router', ok: true }));
    const invalid = createMissionRouter({ localLLM: { classify: async () => ({ mission: 'unknown' as 'review', confidence: 0.8 }) } });
    expect(await invalid.predict(input)).toMatchObject({ mission: 'quick', tier: 1 });
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'llm.mission-router', ok: false }));
    // A client that ignores the classify-role model (or doesn't report one) does not decide — Tier 1 stands.
    const ignoring = createMissionRouter({ localLLM: { classify: async () => ({ mission: 'review', confidence: 0.9, model: 'some-large-model' }) } });
    expect(await ignoring.predict(input)).toMatchObject({ mission: 'quick', tier: 1 });
    const silent = createMissionRouter({ localLLM: { classify: async () => ({ mission: 'review', confidence: 0.9 }) } });
    expect(await silent.predict(input)).toMatchObject({ mission: 'quick', tier: 1 });
  } finally { log.mockRestore(); }
});

test('with no overrides and no env pin, judge sends the independently computed budget-tier model', async () => {
  const env = ROLE_MODEL_DEFAULTS.classify.environment;
  const saved = process.env[env];
  delete process.env[env];
  clearLaunchRoleLlmOverrides();
  try {
    const provider = 'openai-codex';
    const config = { ...getUserConfig(), llm: { ...getUserConfig().llm, provider }, roleLlm: undefined, roleModels: undefined, roleModelTiers: undefined } as ReturnType<typeof getUserConfig>;
    const seen: string[] = [];
    const result = await judge({ site: 'test.budget-default', prompt: 'classify', config,
      call: async ({ model }) => { seen.push(model); return { text: 'ok' }; } });
    expect(result.ok).toBe(true);
    const budget = lookupLlmTierSpec(provider, 'budget').model;
    expect(seen).toEqual([budget]);
    // Guard against a larger-tier leak: the budget model is not the provider's better/best model.
    expect(budget).not.toBe(lookupLlmTierSpec(provider, 'better').model);
  } finally {
    if (saved === undefined) delete process.env[env]; else process.env[env] = saved;
  }
});

test('intent gate triage and domain use classify judge on production path', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const store = new TaskStore({ path: ':memory:' });
  const sites: string[] = [];
  const judgeDeps = {
    resolveRoleProvider: (role: string) => {
      expect(role).toBe('classify');
      return { provider: { name: 'fake' }, model: 'pinned-small' };
    },
    streamLLM: async (messages: Array<{ role: string; content: string }>, _chunk: (delta: string) => void, opts?: { model?: string; provider?: { name: string } }) => {
      expect(opts).toMatchObject({ model: 'pinned-small', provider: { name: 'fake' } });
      const prompt = messages[0]!.content;
      sites.push(prompt.includes('Autopilot DOMAIN router') ? 'domain' : 'triage');
      return prompt.includes('Autopilot DOMAIN router')
        ? '{"domain":"coding","rationale":"implementation"}'
        : '{"executionModel":"goal-loop","tier":"heavy","rationale":"broad scope"}';
    },
  };
  try {
    const result = await submitIntent({ text: '미션: 반도체 뉴스 정리', channel: 'tui', store,
      slugFn: async () => 'judge-goal', spawnPrepare: () => {}, judgeDeps });
    expect(result).toMatchObject({ route: 'mission', executionModel: 'goal-loop', tier: 'heavy' });
    expect(sites.sort()).toEqual(['domain', 'triage']);
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'intent.triage', ok: true }));
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'intent.domain', ok: true }));
  } finally { store.close(); log.mockRestore(); }
});

test('intent gate invalid decisions fall back to heuristic triage and keyword domain', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const store = new TaskStore({ path: ':memory:' });
  try {
    const result = await submitIntent({ text: '미션: 반도체 뉴스 정리', channel: 'tui', store,
      slugFn: async () => 'judge-invalid', spawnPrepare: () => {},
      judgeDeps: {
        resolveRoleProvider: () => ({ provider: { name: 'fake' }, model: 'small' }),
        streamLLM: async () => '{"unexpected":true}',
      },
    });
    expect(result).toMatchObject({ route: 'mission', executionModel: 'task', tier: 'light' });
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'intent.triage', ok: false }));
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'intent.domain', ok: false }));
  } finally { store.close(); log.mockRestore(); }
});

test('fenced JSON is parsed and validated without leaking raw content into observations', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const decision = await judge({ site: 'test.fence', prompt: 'private',
      resolveRoleProvider: () => ({ provider: { name: 'fake' }, model: 'small' }),
      call: async () => ({ text: '```json\n{"kind":"ok"}\n```' }),
      schema: (value) => value && typeof value === 'object' && (value as { kind?: string }).kind === 'ok' ? 'ok' : null,
    });
    expect(decision.ok && decision.value).toBe('ok');
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'test.fence', ok: true }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  } finally { log.mockRestore(); }
});

test('schema mismatch and failed LLM call return undecided and log failed observations', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const schemaFail = await judge({ site: 'test.schema', prompt: 'classify',
      resolveRoleProvider: () => ({ provider: { name: 'fake' }, model: 'small' }),
      call: async () => ({ text: '{"category":"unexpected"}' }),
      schema: (v) => v && typeof v === 'object' && (v as { category?: string }).category === 'valid' ? 'valid' : null,
    });
    expect(schemaFail).toEqual({ ok: false, reason: 'schema', rawText: '{"category":"unexpected"}' });
    const callFail = await judge({ site: 'test.call', prompt: 'classify',
      resolveRoleProvider: () => ({ provider: { name: 'fake' }, model: 'small' }),
      call: async () => { throw new Error('private prompt'); },
    });
    expect(callFail).toEqual({ ok: false, reason: 'call', error: new Error('private prompt') });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private prompt');
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'test.schema', ok: false }));
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'test.call', ok: false }));
  } finally { log.mockRestore(); }
});

test('intake categorization traverses judge and falls back on invalid decisions', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const decomposition = { missions: [{ id: 'm-1', title: 'Test', tasks: [{ id: 't-1', title: 'Classify', intent: 'classify', context: { enrichments: [] } }] }] } as unknown as EnrichedDecomposition;
  try {
    const result = await categorizeDecomposition(decomposition, {
      callable: async ({ provider, model }) => {
        const role = resolveRoleLlm('classify');
        expect({ provider, model }).toEqual({ provider: role.provider, model: role.model });
        return { text: '{"categorizations":[{"key":"m-1/t-1","category":"research","workflowEligible":true,"confidence":"high"}]}' };
      },
    });
    expect(result.categorizations['m-1/t-1']?.category).toBe('research');
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'intake.categorize', ok: true }));
    const fallback = await categorizeDecomposition(decomposition, { callable: async () => ({ text: '{"wrong":true}' }) });
    expect(fallback).toMatchObject({ fallback: true, categorizations: { 'm-1/t-1': { category: 'cognitive' } } });
    expect(log).toHaveBeenCalledWith('llm.judge', 'call', expect.objectContaining({ site: 'intake.categorize', ok: false }));
    const failedCall = await categorizeDecomposition(decomposition, { callable: async () => { throw new Error('offline'); } });
    expect(failedCall).toMatchObject({ fallback: true, categorizations: { 'm-1/t-1': { category: 'cognitive' } } });
    await expect(categorizeDecomposition(decomposition, {
      callable: async () => { throw new Error('offline-private'); }, strict: true,
    })).rejects.toMatchObject({ code: 'LLM_CALL_FAILED', message: 'LLM_CALL_FAILED: offline-private' });
    await expect(categorizeDecomposition(decomposition, {
      callable: async () => ({ text: 'private-unparseable' }), strict: true,
    })).rejects.toMatchObject({ code: 'PARSE_FAILED', rawText: 'private-unparseable', message: 'PARSE_FAILED: no usable categorizations' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-unparseable');
    expect(JSON.stringify(log.mock.calls)).not.toContain('offline-private');
  } finally { log.mockRestore(); }
});
