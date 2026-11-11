import { expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import profile from '../../docs/profiles/solar-only-demo.json';
import { getUserConfig, MODEL_ROLES, setUserConfigOverlay, type RoleLlmConfig } from '../user-config.js';
import * as llm from '../llm.js';
import { defaultJudge } from '../autopilot/mission-feasibility-negotiate.js';
import { createLLMGrowthProposer } from '../graph-runner/graph-grow-llm.js';
import type { GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { judge } from './judge-layer.js';
const SOLAR_MINI4 = 'openrouter/upstage/solar-mini4';
const SOLAR_PRO4 = 'openrouter/upstage/solar-pro4';

test('Solar demo profile pins every execution role to an exact OpenRouter Solar ID', () => {
  expect(Object.keys(profile.roleLlm).sort()).toEqual([...MODEL_ROLES].sort());
  for (const role of MODEL_ROLES) {
    const entry = profile.roleLlm[role as keyof typeof profile.roleLlm];
    expect(entry.provider).toBe('openrouter');
    expect([SOLAR_MINI4, SOLAR_PRO4]).toContain(entry.model);
  }
  expect(profile.roleLlm.classify.model).toBe(SOLAR_MINI4);
  expect(profile.roleLlm.planning.model).toBe(SOLAR_PRO4);
});

test('production classify judge honors the profile role and passes it to the fake wire', async () => {
  const config = { ...getUserConfig(), roleLlm: profile.roleLlm as RoleLlmConfig };
  const calls: Array<{ model?: string; role?: string; provider?: string }> = [];
  const roleLogs: Array<{ event: string; data: unknown }> = [];
  const expectedModel = profile.roleLlm.classify.model;
  const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'harness.role-llm') roleLogs.push({ event, data });
  });
  try {
    const result = await judge({
      site: 'solar-profile-classify-test',
      prompt: 'Classify this simulated Solar profile request.',
      config,
      streamLLM: async (_messages, onChunk, options = {}) => {
        calls.push({ model: options.model, role: options.usageRole, provider: options.provider?.name });
        onChunk('{"ok":true}');
        return '{"ok":true}';
      },
    });

    expect(result).toMatchObject({ ok: true, provider: 'openrouter', model: expectedModel });
    expect(calls).toEqual([{ model: expectedModel, role: 'classify', provider: 'openrouter' }]);
    expect(roleLogs.map(entry => entry.data)).toContainEqual(expect.objectContaining({
      role: 'classify', provider: 'openrouter', model: expectedModel, source: 'config-role',
    }));
  } finally {
    logSpy.mockRestore();
  }
});

test('production planning feasibility judge honors the profile role and fake wire', async () => {
  const expectedModel = profile.roleLlm.planning.model;
  const oldNegotiate = process.env.ELANOUS_NEGOTIATE_MODEL;
  const oldDecompose = process.env.ELANOUS_DECOMPOSE_MODEL;
  const roleLogs: Array<{ event: string; data: unknown }> = [];
  const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'harness.role-llm') roleLogs.push({ event, data });
  });
  const wire = spyOn(llm, 'streamLLM').mockResolvedValue('simulated planning response');
  delete process.env.ELANOUS_NEGOTIATE_MODEL;
  delete process.env.ELANOUS_DECOMPOSE_MODEL;
  setUserConfigOverlay(config => ({ ...config, roleLlm: profile.roleLlm as RoleLlmConfig }));
  try {
    await defaultJudge('Simulate a feasible Solar-only plan.');
    expect(wire.mock.calls[0]?.[2]).toMatchObject({
      model: expectedModel, provider: llm.PROVIDERS.openrouter, usageRole: 'planning',
    });
    expect(roleLogs.map(entry => entry.data)).toContainEqual(expect.objectContaining({
      role: 'planning', provider: 'openrouter', model: expectedModel, source: 'config-role',
    }));
  } finally {
    wire.mockRestore();
    logSpy.mockRestore();
    setUserConfigOverlay(null);
    if (oldNegotiate === undefined) delete process.env.ELANOUS_NEGOTIATE_MODEL;
    else process.env.ELANOUS_NEGOTIATE_MODEL = oldNegotiate;
    if (oldDecompose === undefined) delete process.env.ELANOUS_DECOMPOSE_MODEL;
    else process.env.ELANOUS_DECOMPOSE_MODEL = oldDecompose;
  }
});

test('production graph-growth proposer honors the profile graph-grow role and fake wire', async () => {
  const expectedModel = profile.roleLlm['graph-grow'].model;
  const oneVisit = 1;
  const roleLogs: Array<{ event: string; data: unknown }> = [];
  const logSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'harness.role-llm') roleLogs.push({ event, data });
  });
  const answer = JSON.stringify({
    node: { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: oneVisit },
    returnTo: 'judge', reason: 'A research node can handle the unseen result.',
  });
  const wire = spyOn(llm, 'streamLLM').mockResolvedValue(answer);
  setUserConfigOverlay(config => ({ ...config, roleLlm: profile.roleLlm as RoleLlmConfig }));
  const graph: GraphTemplateSpec = {
    graphId: 'solar-role-sim', version: 1, entryNode: 'judge', terminalNodes: ['done'],
    nodes: [
      { nodeId: 'judge', kind: 'judge', recipe: 'cmd:judge', maxVisits: oneVisit },
      { nodeId: 'done', kind: 'gate', recipe: 'none', maxVisits: oneVisit },
    ],
    edges: [{ from: 'judge', on: 'outcome', map: { ok: 'done' } }],
  };
  try {
    const proposal = await createLLMGrowthProposer()({
      graph, nodeId: 'judge', outcome: 'needs-research', runId: 'solar-profile-test', output: 'simulated blocked output',
    });
    expect(proposal).toMatchObject({ node: { nodeId: 'research' }, returnTo: 'judge' });
    expect(wire.mock.calls[0]?.[2]).toMatchObject({
      model: expectedModel, provider: llm.PROVIDERS.openrouter, reasoningEffort: 'low',
    });
    expect(roleLogs.map(entry => entry.data)).toContainEqual(expect.objectContaining({
      role: 'graph-grow', provider: 'openrouter', model: expectedModel, source: 'config-role',
    }));
  } finally {
    wire.mockRestore();
    logSpy.mockRestore();
    setUserConfigOverlay(null);
  }
});
