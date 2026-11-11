import { expect, test } from 'bun:test';
import { buildReplTools } from '../repl/index.js';
import { buildCliAgentTools } from '../cli/agent-cli.js';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';
import { takeHydratedTools } from '../skills/tools/tool-search-spec.js';

test('next TUI REPL ToolSearch hydrates and dispatches an installed plugin tool', async () => {
  const repl = buildReplTools();
  const appDeploy = repl.specs.find((spec) => spec.name === 'app_deploy');
  expect(appDeploy?.pluginId).toBe('elanous-app-deploy');
  const turn = applyDeferredTools([{ role: 'user', content: '앱을 배포해줘' }], repl.specs, {
    userText: '앱을 배포해줘',
  });
  expect(turn.tools.map((spec) => spec.name)).toContain('ToolSearch');

  const search = await repl.dispatch('ToolSearch', { query: 'route:배포해줘' });
  const hydrated = takeHydratedTools(search as Parameters<typeof takeHydratedTools>[0]);
  expect(hydrated.map((spec) => spec.name)).toContain('app_deploy');

  // Invalid input exits before simulation/publish side effects, while proving
  // the hydrated plugin name reaches the same REPL dispatcher.
  const dispatched = await repl.dispatch('app_deploy', { appId: 'not-registered', requestText: '' });
  expect(dispatched).toMatchObject({ kind: 'site-deploy', status: 'failed' });
});

test('next TUI REPL exposes declared plugin graph routes through ToolSearch and fails closed without owner context', async () => {
  const repl = buildReplTools();
  const search = await repl.dispatch('ToolSearch', { query: 'route:제안 적용해줘' });
  const hydrated = takeHydratedTools(search as Parameters<typeof takeHydratedTools>[0]);
  expect(hydrated).toEqual([expect.objectContaining({
    name: 'suggest_accept', pluginId: 'absorb',
    route: expect.objectContaining({ requiresConfirm: true, risk: 'high' }),
  })]);
  // The interactive REPL has no verified-owner injection by design. Its graph route must stop
  // at the adapter boundary; the authorized child CLI path below covers successful execution.
  await expect(repl.dispatch('suggest_accept', { suggestionId: 'demo' }))
    .resolves.toMatchObject({ error: expect.stringContaining('verified owner') });
});

test('next TUI child CLI hydrates and dispatches an approved plugin graph route from the same catalog', async () => {
  const calls: string[] = [];
  const child = buildCliAgentTools(undefined, undefined, process.cwd(), {
    verifiedOwner: { id: 'member-next' },
    requestConfirmation: async () => true,
    dispatchGraph: async (pluginId, graphId, _graphFile, _args, context) => {
      calls.push(`${pluginId}:${graphId}:${context?.verifiedOwner?.id}`);
      return { status: 'done' };
    },
  });
  const turn = applyDeferredTools([{ role: 'user', content: '제안 적용해줘' }], child.specs, {
    userText: '제안 적용해줘',
  });
  expect(turn.tools.map((spec) => spec.name)).toContain('ToolSearch');
  expect(turn.tools.map((spec) => spec.name)).not.toContain('suggest_accept');
  const search = await child.dispatch('ToolSearch', { query: 'route:제안 적용해줘' });
  const hydrated = takeHydratedTools(search as Parameters<typeof takeHydratedTools>[0]);
  expect(hydrated.map((spec) => spec.name)).toEqual(['suggest_accept']);
  await expect(child.dispatch('suggest_accept', { suggestionId: 'demo' })).resolves.toEqual({ status: 'done' });
  expect(calls).toEqual(['absorb:absorb-build:member-next']);
});
