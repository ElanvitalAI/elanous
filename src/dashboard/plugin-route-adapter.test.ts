import { expect, test } from 'bun:test';
import { runGoalLoop } from '../core-turn/run-goal-loop.js';
import type { CoreTurnContext } from '../core-turn/types.js';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardGraphRouteDispatcher, createDashboardPluginRouteAdapter, createDashboardTuiConfirmContext, dispatchVerifiedDashboardGraph, graphFilesForAssets, requestDashboardGraphConfirmation, resolveDashboardVerifiedOwner } from './plugin-route-adapter.js';
import { buildSessionRuntimeToolSpecs } from '../session-runtime/index.js';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } from '../graph-runner/capabilities.js';
import { runGraph } from '../graph-runner/runner.js';
import { InlineChoiceBroker } from '../tui/inline-choice.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { ptyAvailable, startPty, unregisterPty } from '../pty-shell/registry.js';

function adapter(calls: Array<{ name: string; args: Record<string, unknown> }> = []) {
  return createDashboardPluginRouteAdapter({
    pluginRoot: join(import.meta.dir, '..', '..', 'plugins'),
    dispatchCore: async (name, args) => { calls.push({ name, args }); return { tool: name, args }; },
  });
}

function briefingOwnerMapping(briefing: (Record<string, unknown> & { owner?: unknown }) | undefined) {
  return typeof briefing?.owner === 'string' && briefing.owner.trim()
    ? { status: 'present' as const, value: briefing.owner }
    : { status: 'missing' as const, source: 'briefing receipt omits owner; verified owner is only at the receipt root' };
}

test('briefing owner mapping follows the actual payload in both directions', () => {
  expect(briefingOwnerMapping({ id: 'brief-no-owner' })).toEqual({ status: 'missing',
    source: 'briefing receipt omits owner; verified owner is only at the receipt root' });
  expect(briefingOwnerMapping({ id: 'brief-with-owner', owner: 'member-from-fake-nexus' })).toEqual({ status: 'present',
    value: 'member-from-fake-nexus' });
});

test('classic and ACP-next adapters expose the same plugin route specs with identity metadata', () => {
  const routeAdapter = adapter();
  const classic = routeAdapter.classicHostTools([]);
  const next = routeAdapter.nextHostTools([]);

  expect(classic).toEqual(next);
  expect(classic.map(({ name }) => name)).toEqual(expect.arrayContaining(['ObserveLogs', 'ObserveOpsStatus', 'ReleaseStatus', 'ReleaseGraphStart', 'app_deploy', 'scrap_add', 'brief_today', 'suggest_list', 'suggest_accept']));
  expect(classic.find(({ name }) => name === 'ObserveLogs')).toMatchObject({
    pluginId: 'elanous-observe', route: { sideEffects: 'read-only', requiresConfirm: false },
  });
  expect(classic.find(({ name }) => name === 'ReleaseGraphStart')).toMatchObject({
    pluginId: 'elanous-release', route: { sideEffects: 'irreversible', risk: 'high', requiresConfirm: true },
  });
  expect(classic.find(({ name }) => name === 'app_deploy')).toMatchObject({
    pluginId: 'elanous-app-deploy', route: { sideEffects: 'external', risk: 'high', requiresConfirm: true },
  });
  expect(classic.find(({ name }) => name === 'suggest_accept')).toMatchObject({
    pluginId: 'absorb', route: { sideEffects: 'external', risk: 'high', requiresConfirm: true },
    handlerRef: './graph:absorb-build',
  });
  expect(classic.find(({ name }) => name === 'suggest_accept')?.allowedGraphIds).toContain('absorb-build');
  const absorbSpecs = buildSessionRuntimeToolSpecs({ userText: '제안 적용해줘', hostTools: classic });
  const absorbSpec = absorbSpecs.find(({ name }) => name === 'suggest_accept');
  expect(absorbSpec?.handlerRef).toBe('./graph:absorb-build');
  expect(absorbSpec?.allowedGraphIds).toContain('absorb-build');
});

test('graph asset allowlist permanently rejects an id declared three times', () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'graph-asset-duplicates-'));
  try {
    const assets = ['one.yaml', 'two.yaml', 'three.yaml', 'unique.yaml'];
    for (const [index, asset] of assets.entries()) {
      writeFileSync(join(pluginRoot, asset), `graph:\n  id: ${index < 3 ? 'duplicate' : 'unique'}\n`);
    }
    const allowed = graphFilesForAssets(pluginRoot, assets);
    expect([...allowed.keys()]).toEqual(['unique']);
    expect(allowed.has('duplicate')).toBe(false);
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test('a malformed plugin and dangling entry do not hide healthy plugin routes', () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'plugin-route-isolation-'));
  try {
    cpSync(join(import.meta.dir, '../../plugins/absorb'), join(pluginRoot, 'absorb'), { recursive: true });
    mkdirSync(join(pluginRoot, 'broken'));
    writeFileSync(join(pluginRoot, 'broken', 'plugin.yaml'), 'id: [broken\n');
    symlinkSync(join(pluginRoot, 'missing-target'), join(pluginRoot, 'dangling-plugin'), 'dir');
    const routeAdapter = createDashboardPluginRouteAdapter({ pluginRoot, dispatchCore: async () => undefined });
    expect(routeAdapter.classicHostTools([]).map(tool => tool.name)).toContain('suggest_accept');
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test('graph route confirmation fails closed on N and dispatches the declared graph only after y', async () => {
  const pluginRoot = join(import.meta.dir, '..', '..', 'plugins');
  const calls: Array<{ pluginId: string; graphId: string; graphFile: string; args: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  const make = (answer: boolean) => createDashboardPluginRouteAdapter({
    pluginRoot,
    dispatchCore: async () => undefined,
    requestConfirmation: async (prompt) => { prompts.push(prompt); return answer; },
    dispatchGraph: async (pluginId, graphId, graphFile, args) => {
      calls.push({ pluginId, graphId, graphFile, args });
      return { status: 'done', graphId };
    },
  });
  const input = { suggestionId: 'suggestion-demo' };
  await expect(make(false).dispatch('suggest_accept', input)).resolves.toMatchObject({ ok: false });
  expect(calls).toEqual([]);

  await expect(make(true).dispatch('suggest_accept', input)).resolves.toEqual({
    ok: true, result: { status: 'done', graphId: 'absorb-build' },
  });
  expect(calls).toEqual([{
    pluginId: 'absorb', graphId: 'absorb-build', graphFile: join(pluginRoot, 'absorb', 'graph', 'absorb-build.yaml'), args: input,
  }]);
  expect(prompts).toContain('이 제안을 격리된 앱 복사본에 적용하고 시뮬레이션을 시작할까요? (y/N)');
});

test('classic graph route dispatch invokes the declared Graph v2 file with a verified owner and fake capability', async () => {
  const pluginRoot = join(import.meta.dir, '..', '..', 'plugins');
  const stateRoot = mkdtempSync(join(tmpdir(), 'classic-graph-route-rungraph-'));
  let registry = emptyGraphCapabilityRegistry();
  registry = registerGraphCapabilityContract(registry, {
    id: 'store.read@1', input: { type: 'object' }, output: { type: 'object' },
  });
  registry = registerGraphCapabilityProviderDeclaration(registry, {
    id: 'fake-store-reader', provides: ['store.read@1'], tier: 'free',
    invoke: () => ({ ok: true, outcome: 'done', result: { items: [{ id: 'kaist-suggestion', owner: 'member-kaist' }] }, evidence: { owner: 'member-kaist' } }),
  });
  const routeAdapter = createDashboardPluginRouteAdapter({
    pluginRoot,
    dispatchCore: async () => undefined,
    dispatchGraph: async (_pluginId, _graphId, graphFile, args, context) => runGraph(graphFile, {
      input: { ...args, context: { memberId: context?.verifiedOwner?.id } },
      quiet: true,
      deps: { root: join(stateRoot, 'graph-state'), capabilityProviders: registry },
    }),
  });
  try {
    const result = await routeAdapter.dispatch('suggest_list', {}, false, {
      surface: 'tui', verifiedOwner: { id: 'member-kaist' },
    });
    expect(result).toMatchObject({ ok: true, result: { graphId: 'absorb-suggest-list', status: 'done' } });
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('classic graph route waits for inline y and empty Enter keeps default N', async () => {
  const pluginRoot = join(import.meta.dir, '..', '..', 'plugins');
  const lines: string[] = [];
  const broker = new InlineChoiceBroker({ appendLines: (next) => lines.push(...next) });
  const calls: string[] = [];
  const routeAdapter = createDashboardPluginRouteAdapter({
    pluginRoot,
    dispatchCore: async () => undefined,
    requestConfirmation: (prompt) => requestDashboardGraphConfirmation(broker, prompt),
    dispatchGraph: async (_pluginId, graphId) => { calls.push(graphId); return { ok: true, graphId }; },
  });

  const denied = routeAdapter.dispatch('suggest_accept', { suggestionId: 'suggestion-demo' });
  expect(broker.activeId).toMatch(/^plugin-route-confirm-/);
  expect(broker.handleInput('')).toBe(true);
  await expect(denied).resolves.toMatchObject({ ok: false });
  expect(calls).toEqual([]);

  const accepted = routeAdapter.dispatch('suggest_accept', { suggestionId: 'suggestion-demo' });
  expect(broker.handleInput('y')).toBe(true);
  await expect(accepted).resolves.toMatchObject({ ok: true, result: { graphId: 'absorb-build' } });
  expect(calls).toEqual(['absorb-build']);
  expect(lines.some((line) => line.includes('y/n') || line.includes('y/N'))).toBe(true);
});

test('classic PTY routes a fake-member KAIST acceptance through y, runGraph simulation, and one receipt', async () => {
  const paths = {
    adapter: join(import.meta.dir, 'plugin-route-adapter.js'),
    dashboard: join(import.meta.dir, 'index.js'),
    inline: join(import.meta.dir, '..', 'tui', 'inline-choice.js'),
    plugins: join(import.meta.dir, '..', '..', 'plugins'),
    memberWorld: join(import.meta.dir, '..', 'ux-sim', 'fake-member-oidc-world.js'),
    graphSimulation: join(import.meta.dir, '..', 'ux-sim', 'absorb-v2-runGraph-sim.js'),
  };
  const script = `
    const { createDashboardPluginRouteBridge, buildClassicDashboardTuiTurnTools } = await import(${JSON.stringify(paths.dashboard)});
    const { requestDashboardGraphConfirmation } = await import(${JSON.stringify(paths.adapter)});
    const { InlineChoiceBroker } = await import(${JSON.stringify(paths.inline)});
    const { FAKE_MEMBER_OIDC_REDIRECT_URI, createFakeMemberOidcWorld } = await import(${JSON.stringify(paths.memberWorld)});
    const { runAbsorbGraphSimulation } = await import(${JSON.stringify(paths.graphSimulation)});
    const { dispatchVerifiedDashboardGraph } = await import(${JSON.stringify(paths.adapter)});
    const world = createFakeMemberOidcWorld({ now: () => Date.parse('2026-11-14T01:00:00.000Z'), identity: () => ({
      sub: 'fake-kaist-pty-owner', email: 'kaist-pty-owner@example.test', emailVerified: true, name: 'KAIST PTY Owner',
    }) });
    world.memberStore.provisionEventCode({ code: 'KAIST-PTY', maxUses: 1 }); // Source: #95987 asks for one verified fake member session in the TUI world.
    const start = await world.membersApi.handle(new Request('https://members.example.test/v1/members', {
      method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, eventCode: 'KAIST-PTY' }),
    }), '203.0.113.41');
    const startBody = await start.json();
    const stateCookie = start.headers.get('set-cookie').split(';', 1)[0];
    const authorization = world.googleWorld.authorize(startBody.authorizationUrl);
    const callback = await world.membersApi.handle(new Request(
      FAKE_MEMBER_OIDC_REDIRECT_URI + '?code=' + authorization.code + '&state=' + authorization.state,
      { headers: { cookie: stateCookie } },
    ));
    const memberCookie = callback.headers.get('set-cookie').split(';', 1)[0];
    const profile = await world.membersApi.handle(new Request('https://members.example.test/v1/members', {
      headers: { cookie: memberCookie, origin: 'https://app.example.test' },
    }));
    const member = (await profile.json()).member;
    const sessionToken = decodeURIComponent(memberCookie.split('=', 2)[1]);
    if (world.memberStore.memberForSession(sessionToken)?.id !== member.id) throw new Error('fake member session did not verify');
    const broker = new InlineChoiceBroker({ appendLines: next => { for (const line of next) process.stdout.write(line + '\\r\\n'); } });
    let routeFinished = false;
    let finishExit;
    const exitAfterReceipt = new Promise(resolve => { finishExit = resolve; });
    let typed = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      for (const char of chunk) {
        if (char === '\\r' || char === '\\n') {
          const value = typed.trim(); typed = '';
          if (routeFinished && value === 'q') finishExit();
          else if (!routeFinished) broker.handleInput(value);
        } else typed += char;
      }
    });
    const routeBridge = createDashboardPluginRouteBridge({
      pluginRoot: ${JSON.stringify(paths.plugins)},
      dispatchCore: async () => undefined,
      dispatchPlugin: async () => ({ ok: false, error: 'unexpected plugin handler path' }),
      requestConfirmation: prompt => requestDashboardGraphConfirmation(broker, prompt),
      getTuiDispatchContext: () => ({ surface: 'tui', verifiedOwner: { id: member.id } }),
      dispatchGraph: async (_pluginId, graphId, graphFile, _args, context) => {
        if (graphId !== 'absorb-build' || !graphFile.endsWith('/absorb-build.yaml')) throw new Error('unexpected graph route target');
        if (context?.verifiedOwner?.id !== member.id) throw new Error('verified fake member was not forwarded');
        const simulation = await runAbsorbGraphSimulation({ confirmation: 'y', memberId: context.verifiedOwner.id, buildGraphFile: graphFile,
          dispatchGraph: (file, runOptions) => dispatchVerifiedDashboardGraph(file, runOptions.input as Record<string, unknown>, context, runOptions) });
        return { graphId, graphFile, memberId: context.verifiedOwner.id, simulation };
      },
    });
    const classicTools = buildClassicDashboardTuiTurnTools(routeBridge, { userText: '제안 수락', hostTools: [] });
    if (!classicTools.some(tool => tool.name === 'suggest_accept')) throw new Error('classic dashboard catalog did not expose suggest_accept');
    process.stdout.write('KAIST_CLASSIC_PTY:READY\\r\\n');
    const dispatched = await routeBridge.dispatch('suggest_accept', { suggestionId: 'suggestion-2026-11-09-1' });
    if (!dispatched || dispatched.ok !== true) throw new Error('graph route did not dispatch: ' + JSON.stringify(dispatched).slice(0, 600));
    const receipt = dispatched.result;
    const sim = receipt.simulation;
    process.stdout.write('KAIST_RECEIPT pass=' + String(sim.ok) + '\\r\\n');
    process.stdout.write('owner=' + receipt.memberId + '\\r\\n');
    process.stdout.write('graph=' + receipt.graphId + ' build=' + sim.builds.accepted.status
      + ' isolation=' + String(sim.memberIsolation) + ' extracts=' + sim.extractionKinds.length + '\\r\\n');
    process.stdout.write('board=separate-followup\\r\\n');
    routeFinished = true;
    await exitAfterReceipt;
    world.close();
    process.exit(0);
  `;
  const evidence = await mockSeatPtySequence({
    runId: 'kaist-classic-graph-route-confirm',
    executable: process.execPath, args: ['-e', script],
    ready: { label: 'classic graph route prompt', until: 'KAIST_CLASSIC_PTY:READY' },
    steps: [{ label: 'fake owner confirms graph route', text: 'y', until: 'board=separate-followup' }],
    quitKeys: 'q\r',
  });
  expect(evidence.exitCode).toBe(0);
  expect(evidence.frames.at(-1)?.screen).toContain('KAIST_RECEIPT pass=true');
  expect(evidence.frames.at(-1)?.screen).toContain('owner=');
  expect(evidence.frames.at(-1)?.screen).toContain('graph=absorb-build');
  expect(evidence.frames.at(-1)?.screen).toContain('isolation=true');
  expect(evidence.frames.at(-1)?.screen).toContain('board=separate-followup');
  // Source: #95983 AWS1 combined route/graph run completed in 12.23s; 120s includes PTY and fake OIDC startup headroom.
}, { timeout: 120_000 });

test('classic and ACP-next TUI catalogs preload the matching release and observe routes', () => {
  const routeAdapter = adapter();
  const adapters = [
    ['classic', routeAdapter.classicHostTools],
    ['ACP-next', routeAdapter.nextHostTools],
  ] as const;

  for (const [, adaptHostTools] of adapters) {
    for (const [query, expected] of [
      ['발행 어디까지?', 'ReleaseStatus'],
      ['로그 보여줘', 'ObserveLogs'],
    ]) {
      const specs = buildSessionRuntimeToolSpecs({ userText: query, hostTools: adaptHostTools([]) });
      const turn = applyDeferredTools([{ role: 'user', content: query }], specs, { userText: query });
      expect(specs.map((tool) => tool.name)).toContain(expected);
      expect(turn.tools.map((tool) => tool.name)).toContain('ToolSearch');
    }
  }
});

test('route-only native handlers reach existing core tools and preserve their arguments', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const routeAdapter = adapter(calls);
  for (const [routeName, coreName] of [
    ['ObserveLogs', 'logs_query'],
    ['ObserveOpsStatus', 'ops_status'],
    ['ReleaseStatus', 'release_status'],
  ]) {
    const args = { request: routeName };
    await expect(routeAdapter.dispatch(routeName, args)).resolves.toEqual({
      ok: true,
      result: { tool: coreName, args },
    });
  }
  expect(calls.map(({ name }) => name)).toEqual(['logs_query', 'ops_status', 'release_status']);
});

test('a colliding host tool wins in both catalog exposure and dispatch', async () => {
  const calls: string[] = [];
  const routeAdapter = adapter();
  const hostTool = {
    name: 'ObserveLogs', description: 'host-owned route name', parameters: {},
    handler: async () => { calls.push('host'); return 'host result'; },
  };

  expect(routeAdapter.classicHostTools([hostTool]).filter(({ name }) => name === 'ObserveLogs')).toEqual([hostTool]);
  await expect(routeAdapter.dispatch('ObserveLogs', {})).resolves.toBeNull();
  expect(calls).toEqual([]);
});

test('a PluginHost copy of the same built-in route yields to the verified TUI route wrapper', async () => {
  const routeAdapter = createDashboardPluginRouteAdapter({
    pluginRoot: join(import.meta.dir, '..', '..', 'plugins'),
    dispatchCore: async () => undefined,
    requestConfirmation: async () => true,
    getTuiDispatchContext: () => ({ surface: 'tui', verifiedOwner: { id: 'member-verified' } }),
    dispatchGraph: async (_pluginId, graphId, _graphFile, _args, context) => ({ graphId, owner: context?.verifiedOwner?.id }),
  });
  const routeTool = routeAdapter.classicHostTools([]).find((tool) => tool.name === 'suggest_accept')!;
  const pluginHostCopy = { ...routeTool, handler: async () => ({ stale: true }) };
  const merged = routeAdapter.classicHostTools([pluginHostCopy]);

  expect(merged.filter((tool) => tool.name === 'suggest_accept')).toEqual([routeTool]);
  await expect(routeTool.handler({ suggestionId: 'suggestion-1' }, {} as never)).resolves.toEqual({
    graphId: 'absorb-build', owner: 'member-verified',
  });
});

test('dashboard graph dispatcher resumes HITL only after explicit y and records n as rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-graph-hitl-dispatch-'));
  try {
    const graphFile = join(dir, 'approval.yaml');
    const root = join(dir, 'state');
    writeFileSync(graphFile, `graph_id: dashboard-confirm-seam\nversion: 1\nentry_node: approve\nterminal_nodes: [done, failed]\n` +
      `nodes:\n  - { node_id: approve, kind: hitl, recipe: 'hitl:approval', max_visits: 1, input: { approval: 'Publish {{input.request}}?' } }\n` +
      `  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\n` +
      `edges:\n  - { from: approve, on: outcome, map: { approved: done, rejected: failed } }\n`);
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'dashboard-confirm-seam', version: '1.0.0',
      extensions: { 'ai.elanous': { graphs: ['./approval.yaml'], graphManifests: { 'dashboard-confirm-seam': {
        purpose: 'Exercise classic TUI graph approval', allow: { recipes: [] }, hitl: ['approve'],
      } } } } }));

    for (const answer of [true, false]) {
      const prompts: string[] = [];
      const dispatch = createDashboardGraphRouteDispatcher({ deps: { root } }, async (prompt) => {
        prompts.push(prompt);
        return answer;
      });
      const result = await dispatch('absorb', 'dashboard-confirm-seam', graphFile, { request: 'fake member build' },
        { surface: 'tui', verifiedOwner: { id: 'member-fake' } }) as { status: string; path: string[] };
      expect(prompts).toHaveLength(1);
      expect(result.status).toBe(answer ? 'done' : 'failed');
      expect(result.path).toEqual(['approve', answer ? 'done' : 'failed']);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ReleaseGraphStart stays disabled even when a caller marks the request confirmed', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const routeAdapter = adapter(calls);

  await expect(routeAdapter.dispatch('ReleaseGraphStart', {}, true)).resolves.toMatchObject({ ok: false });
  expect(calls).toEqual([]);
});

test('route dispatch returns null for names outside the native route catalog', async () => {
  await expect(adapter().dispatch('NoSuchPluginTool', {})).resolves.toBeNull();
});

test('TUI deployment falls back to a human-only native confirm when the ACP peer is absent', async () => {
  let approval: unknown;
  const routeAdapter = createDashboardPluginRouteAdapter({
    pluginRoot: join(import.meta.dir, '..', '..', 'plugins'),
    dispatchCore: async () => undefined,
    getTuiDispatchContext: () => createDashboardTuiConfirmContext(undefined, null, async (request) => {
      approval = request;
      return false;
    }),
    dispatchAppDeploy: async (_args, maybeContext) => {
      const context = maybeContext!;
      expect(context.surface).toBe('tui');
      expect(context.verifiedOwner).toBeUndefined();
      const result = await context.confirmChannels?.[0]?.request({
        prompt: '강의 노트·스크랩 앱을 공개 배포할까요?',
        header: '배포',
        detail: '시뮬레이션 PASS',
        yesLabel: 'y',
        noLabel: 'N',
      });
      return { result };
    },
  });
  const deploy = routeAdapter.classicHostTools([]).find((tool) => tool.name === 'app_deploy');
  expect(deploy).toBeDefined();
  await expect(deploy!.handler({ appId: 'lecture-scrap', requestText: 'publish', confirm: true }, {} as never)).resolves.toEqual({ result: false });
  expect(approval).toEqual({
    title: '배포',
    prompt: '강의 노트·스크랩 앱을 공개 배포할까요?',
    detail: '시뮬레이션 PASS',
    yesLabel: 'y',
    noLabel: 'N',
    defaultNo: true,
  });
});

test('an explicit ACP rejection does not open a second native approval prompt', async () => {
  let nativePrompted = false;
  const context = createDashboardTuiConfirmContext('session-1', async (_sessionId, _request) => ({
    answers: { confirm: 'N' }, answeredBy: 'human', cancelled: true,
  }), async () => { nativePrompted = true; return true; });
  const answer = await context.confirmChannels?.[0]?.request({ prompt: 'publish?', header: '배포', yesLabel: 'y', noLabel: 'N' });
  expect(answer).toBe(false);
  expect(nativePrompted).toBe(false);
});

test('TUI deploy keeps confirmation on the originating ACP session when its peer answers', async () => {
  let routedSession = '';
  let payload: unknown;
  let nativePrompted = false;
  const context = createDashboardTuiConfirmContext('session-owner', async (sessionId, request) => {
    routedSession = sessionId;
    payload = request;
    return { answers: { confirm: 'y' }, answeredBy: 'human' };
  }, async () => { nativePrompted = true; return false; });
  const answer = await context.confirmChannels?.[0]?.request({
    prompt: '공개 배포할까요?', header: '배포', detail: '시뮬레이션 PASS', yesLabel: 'y', noLabel: 'N', requestId: 'receipt-1',
  });
  expect(answer).toBe(true);
  expect(routedSession).toBe('session-owner');
  expect(payload).toMatchObject({
    id: 'tui-deploy-receipt-1',
    request: { questions: [{ id: 'confirm', header: '배포', options: [{ label: 'y' }, { label: 'N' }], recommendedIndex: 1 }] },
  });
  expect(nativePrompted).toBe(false);
});
test.skipIf(!ptyAvailable())('classic dashboard PTY carries KAIST scenes 1–6 through ingest, brief, suggestion, board, and QR', async () => {
  const ticketScenario = process.env.CLASSIC_TICKET_SCENARIO === '1';
  const sourceText = ticketScenario ? '축제·콘서트 티켓 대란\n\n접속 폭주로 예매 실패' : 'KAIST 강의 자료에서 강의 노트 앱으로 이어 읽기';
  const suggestionAsk = ticketScenario ? '티켓 예매 서비스 · 동시 300명' : 'Add a lesson timer';
  const ingestUrl = ticketScenario ? 'https://news.example.test/ticket-rush' : 'https://example.test/article';
  const appId = ticketScenario ? 'ticketing-fake-app' : 'kaist-fake-app';
  const suggestionId = ticketScenario ? 'suggestion-kcb-ticket-1' : 'suggestion-2026-11-09-1';
  const boardCardId = ticketScenario ? 'kcb-ticket-board-1' : 'kaist-board-card-1';
  const sharedScrapId = ticketScenario ? 'scrap-kcb-article-1' : 'kaist-scrap-shared-text';
  const root = mkdtempSync(join(tmpdir(), ticketScenario ? 'classic-ticket-real-entry-' : 'classic-kaist-real-entry-'));
  const markerPath = join(root, 'graph-receipt.json');
  const sessionToken = 'aps_' + 'k'.repeat(40);
  let ownerRequests = 0;
  let modelRequests = 0;
  let lastToolResult = '';
  const nexus = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/v1/members/owner') return new Response('not found', { status: 404 });
    ownerRequests++;
    if (request.headers.get('authorization') !== `Bearer ${sessionToken}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
    return Response.json({ memberId: 'member-from-fake-nexus' });
  } });
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'classic-kaist-test' }] });
    if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
    modelRequests++;
    const body = await request.json() as { messages?: Array<{ role?: string; content?: unknown }> };
    if (modelRequests > 2) {
      const toolMessage = [...(body.messages ?? [])].reverse().find(message => message.role === 'tool');
      lastToolResult = typeof toolMessage?.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage?.content ?? '');
    }
    const headers = { 'content-type': 'text/event-stream' };
    const turn = Math.floor((modelRequests - 1) / 3);
    const phase = (modelRequests - 1) % 3;
    const actions = [
      { name: 'scrap_add', query: `route: 이 기사 스크랩해줘 ${ingestUrl}`, args: {
        kind: 'web', url: ingestUrl, ...(ticketScenario ? { text: sourceText } : {}),
      } },
      { name: 'brief_today', query: 'route: 오늘 브리핑', args: {} },
      { name: 'suggest_list', query: 'route: 제안 목록', args: {} },
      { name: 'suggest_accept', query: 'route: 이 제안 수락', args: { suggestionId } },
      { name: 'suggest_accept', query: 'route: 이 제안 수락', args: { suggestionId } },
    ] as const;
    const action = actions[turn];
    if (action && phase < 2) {
      const searchCall = phase === 0;
      const toolCall = { index: 0, id: `classic-kaist-${modelRequests}`, type: 'function', function: {
        name: searchCall ? 'ToolSearch' : action.name,
        arguments: JSON.stringify(searchCall ? { query: action.query } : action.args),
      } };
      const lines = [
        { choices: [{ delta: { tool_calls: [toolCall] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(lines, { headers });
    }
    const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) as {
      owner?: string; graph?: string; status?: string; boardCard?: { id?: string; owner?: string; state?: string; stateHistory?: string[]; resultUrl?: string };
      attachment?: { id?: string; sha256?: string }; scenes?: Record<string, { output?: Record<string, unknown> }>;
    } : {};
    const scenes = marker.scenes ?? {};
    const sceneLine = (number: number) => `ABSORB_SCENE_RECEIPT ${JSON.stringify(scenes[String(number)] ?? { scene: number, missing: true })}`;
    const content = turn === 0 ? sceneLine(1)
      : turn === 1 ? `${sceneLine(2)}\n${sceneLine(3)}`
        : turn === 2 ? sceneLine(4)
          : turn === 3 && marker.owner === 'member-from-fake-nexus' && marker.graph === 'absorb-build' && marker.status === 'done'
            && marker.boardCard?.owner === marker.owner && marker.boardCard.state === 'released'
            && marker.boardCard.stateHistory?.join(',') === 'building,testing,released' && marker.attachment?.sha256
            && marker.boardCard.resultUrl ? `${sceneLine(5)}\n${sceneLine(6)}`
            : turn === 4 && marker.status === 'testing' && !scenes['5']?.output?.acceptance
              ? 'ABSORB_REJECT_RECEIPT' : 'CLASSIC_KCB_1_6_RECEIPT_MISSING';
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers });
  } });
  const driver = `
    const { join } = await import('node:path');
    const { createHash } = await import('node:crypto');
    const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
    const { setElanousConfigDir } = await import(${JSON.stringify(join(import.meta.dir, '../elanous-config-dir.js'))});
    const { showDashboard } = await import(${JSON.stringify(join(import.meta.dir, 'index.js'))});
    const { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } = await import(${JSON.stringify(join(import.meta.dir, '../graph-runner/capabilities.js'))});
    const state = process.env.ELANOUS_STATE_DIR;
    setElanousConfigDir(state);
    writeFileSync(join(state, 'config.json'), JSON.stringify({ onboarding: { completed: true },
      llm: { provider: 'local', model: 'classic-kaist-test', baseUrl: ${JSON.stringify(`http://127.0.0.1:${model.port}/v1`)} },
      skillRouter: { llmFallback: false }, mcp: { enabled: false } }));
    const suggestionId = ${JSON.stringify(suggestionId)};
    const ownerId = 'member-from-fake-nexus';
    const marker = ${JSON.stringify(markerPath)};
    let providers = emptyGraphCapabilityRegistry();
    for (const id of ['store.read@1', 'store.write@1', 'store.events@1', 'extract.item@1', 'notify.channel@1', 'app-publish.action@1']) providers = registerGraphCapabilityContract(providers, {
      id, input: { type: 'object' }, output: { type: 'object' },
    });
    const scraps = ['x', 'youtube', 'voice', 'video', 'photo', 'text'].map((kind, index) => ({
      id: (${JSON.stringify(ticketScenario ? 'kcb-scrap-' : 'kaist-scrap-')}) + kind, owner: ownerId, status: 'new', kind, text: ${JSON.stringify(ticketScenario ? sourceText : 'KAIST')} + ' ' + kind + ' fixture', url: 'https://example.test/' + kind,
      mediaRef: 'fake://' + kind,
    }));
    const briefings = [];
    const suggestions = [];
    const channels = [];
    const receipts = [];
    let briefRunId;
    const recordGraphNode = (nodeId) => {
      const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {};
      const graphPath = [...(previous.graphPath ?? []), nodeId];
      writeFileSync(marker, JSON.stringify({ ...previous, graphPath }));
    };
    const store = ({ graphId, runId, nodeInput = {}, input = {}, graphInput, outputs = {} }) => {
      if (graphId === 'absorb-brief') briefRunId = runId;
      const context = (graphInput ?? input).context ?? {};
      const config = nodeInput;
      if (config.op === 'create' && config.collection === 'scraps') {
        const row = { ...(graphInput ?? input), id: ${JSON.stringify(sharedScrapId)}, owner: context.memberId, status: 'new' };
        scraps.push(row);
        recordRun(graphId, runId, { kind: row.kind, url: row.url, text: row.text },
          { scrapId: row.id, owner: row.owner, kind: row.kind, url: row.url, text: row.text });
        return { ok: true, outcome: 'done', result: row, evidence: { stored: row } };
      }
      if (config.op === 'list' && config.collection === 'scraps') {
        const items = scraps.filter(row => row.owner === context.memberId && row.status === 'new');
        return { ok: true, outcome: 'done', result: { items }, evidence: { items, owner: context.memberId } };
      }
      if (config.op === 'list' && config.collection === 'member-app-slots') {
        return { ok: true, outcome: 'done', result: { items: [{ id: ${JSON.stringify(appId)}, owner: context.memberId }] }, evidence: { owner: context.memberId } };
      }
      if (config.op === 'list' && config.collection === 'suggestions') {
        const items = suggestions.filter(row => row.owner === context.memberId);
        recordRun(graphId, runId, { owner: context.memberId }, { suggestionId: items[0]?.id, suggestionIds: items.map(row => row.id), sourceScrapIds: items[0]?.evidenceScrapIds ?? [], suggestion: items[0] }, 4);
        return { ok: true, outcome: 'done', result: { items }, evidence: { items, owner: context.memberId } };
      }
      if (config.op === 'get' && config.collection === 'suggestions') {
        recordGraphNode('lookup-suggestion');
        const id = (graphInput ?? input).suggestionId ?? config.id;
        const row = suggestions.find(item => item.id === id && item.owner === context.memberId);
        return row ? { ok: true, outcome: 'done', result: row, evidence: { suggestion: row, owner: context.memberId } }
          : { ok: false, outcome: 'failed', error: 'suggestion unavailable for verified member: id=' + String(id) + ' owner=' + String(context.memberId) + ' stored=' + JSON.stringify(suggestions.map(item => ({ id: item.id, owner: item.owner }))) };
      }
      if (config.op === 'upsert' && config.collection === 'briefings') {
        const briefing = outputs.brief?.evidence?.briefing;
        if (briefing) briefings.push({ ...briefing, owner: context.memberId });
        recordRun(graphId, runId, { owner: context.memberId, kstDay: context.kstDay }, { briefingId: briefing?.id, topics: briefing?.topics ?? [] }, 3);
        return { ok: true, outcome: 'done', result: { stored: true }, evidence: { briefing } };
      }
      if (config.op === 'create' && config.collection === 'suggestions') {
        const candidate = config.suggestion ?? outputs.suggest?.result?.items?.[0];
        const suggestion = candidate ? { ...candidate } : undefined;
        if (suggestion && suggestions.some(item => item.id === suggestion.id && item.owner === context.memberId))
          return { ok: false, outcome: 'failed', error: 'suggestion ID already exists for owner' };
        if (suggestion) suggestions.push({ ...suggestion, owner: context.memberId });
        recordRun(graphId, runId, { owner: context.memberId }, { suggestionId: suggestion?.id, sourceScrapIds: suggestion?.evidenceScrapIds ?? [] }, 4);
        return { ok: true, outcome: 'done', result: { stored: true }, evidence: { suggestion } };
      }
      return { ok: true, outcome: 'done', result: {}, evidence: {} };
    };
    const recordRun = (graphId, runId, input, output, explicitScene) => {
      const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {};
      const scene = explicitScene ?? (graphId === 'absorb-ingest' ? 1 : graphId === 'absorb-brief' ? 2 : graphId === 'absorb-suggest-list' ? 4 : 5);
      const entry = { runId, scene, input, output };
      const next = { ...previous, owner: ownerId, scenes: { ...(previous.scenes ?? {}), [String(scene)]: entry } };
      receipts.push(entry);
      writeFileSync(marker, JSON.stringify(next));
    };
    const extract = ({ graphId, runId, input, nodeInput = {}, graphInput, outputs = {} }) => {
      const context = (graphInput ?? input).context ?? {};
      const mapped = nodeInput.scrap;
      const rows = mapped ? [mapped] : outputs.collect?.result?.items ?? [];
      const items = rows.filter(row => row.owner === context.memberId).map(row => ({ ...row, title: row.kind + ' scrap', text: 'fake extraction: ' + row.kind }));
      if (!mapped) recordRun(graphId, runId, { owner: context.memberId, kinds: rows.map(row => row.kind) }, { extracted: items.length, kinds: items.map(row => row.kind) }, 2);
      return { ok: true, outcome: 'done', result: mapped ? items[0] : { items, text: items.map(row => row.text).join('\\n') }, evidence: { extractionKinds: items.map(row => row.kind), scrapIds: items.map(row => row.id) } };
    };
    const notify = ({ graphId, runId, input, graphInput, nodeInput = {}, outputs = {} }) => {
      const delivered = nodeInput.channels ?? nodeInput.with?.channels ?? [];
      channels.push(...delivered);
      const briefing = outputs.brief?.evidence?.briefing;
      recordRun(graphId, runId, { owner: ownerId, briefingId: briefing?.id }, { briefingId: briefing?.id, channels: delivered, briefing }, 3);
      return { ok: true, outcome: 'done', result: { delivered }, evidence: { delivered } };
    };
    const provider = (id, provides, invoke) => { providers = registerGraphCapabilityProviderDeclaration(providers, { id, provides, tier: 'free', invoke }); };
    const tracedStore = args => {
      try { return store(args); }
      catch (error) { return { ok: false, outcome: 'failed', error: error instanceof Error ? error.stack : String(error) }; }
    };
    provider('fake-absorb-store', ['store.read@1', 'store.write@1'], tracedStore);
    provider('fake-absorb-board-events', ['store.events@1'], ({ nodeInput }) => {
      const event = nodeInput?.event;
      if (nodeInput?.operation !== 'append' || event?.memberId !== ownerId) {
        return { ok: false, outcome: 'fail', error: 'board event is not member-owned' };
      }
      return { ok: true, outcome: 'ok', result: { appended: true, event }, evidence: { event } };
    });
    provider('fake-absorb-extract', ['extract.item@1'], extract);
    provider('fake-absorb-notify', ['notify.channel@1'], notify);
    providers = registerGraphCapabilityProviderDeclaration(providers, { id: 'fake-absorb-publish', provides: ['app-publish.action@1'], tier: 'free',
      invoke: ({ graphId, runId, input, graphInput, nodeInput, outputs }) => {
        const context = (graphInput ?? input).context;
        if (context.memberId !== ownerId) return { ok: false, outcome: 'failed', error: 'verified owner missing' };
        if (nodeInput.action === 'simulate') {
          recordGraphNode('simulate');
          const artifact = outputs.build.evidence.artifact;
          const suggestion = outputs['lookup-suggestion'].evidence.suggestion;
          if (suggestion.owner !== ownerId || outputs.build.evidence.owner !== ownerId) return { ok: false, outcome: 'failed', error: 'owner mismatch' };
          if (artifact.ask !== suggestion.ask) return { ok: false, outcome: 'failed', error: 'build ask did not match the looked-up suggestion' };
          const previous = JSON.parse(readFileSync(marker, 'utf8'));
          const receipt = { id: 'fake-pass-receipt', artifactId: artifact.id, owner: ownerId, status: 'passed', attachment: { id: artifact.id, kind: 'app-artifact' } };
          const attachment = { ...receipt.attachment, sha256: createHash('sha256').update(JSON.stringify(artifact.files)).digest('hex'), files: Object.keys(artifact.files) };
          const boardCard = { id: ${JSON.stringify(boardCardId)}, owner: ownerId, title: artifact.ask, state: 'testing', stateHistory: ['building', 'testing'] };
          const scene5 = { runId, scene: 5, input: { suggestionId: suggestion.id, confirmation: 'y' }, output: { boardCardId: boardCard.id, attachment } };
          const scene6 = { runId, scene: 6, input: { boardCardId: boardCard.id }, output: { resultUrl: ${JSON.stringify(`https://${appId}.app.sim.invalid/`)} } };
          writeFileSync(marker, JSON.stringify({ ...previous, status: 'testing', boardCard, receipt, attachment, scenes: { ...(previous.scenes ?? {}), '5': scene5, '6': scene6 } }));
          return { ok: true, outcome: 'done', result: { artifactId: artifact.id }, evidence: { receipt, isolated: true } };
        }
        if (nodeInput.action === 'publish') {
          recordGraphNode('publish');
          const previous = JSON.parse(readFileSync(marker, 'utf8'));
          if (previous.status !== 'testing' || previous.boardCard.state !== 'testing' || previous.receipt?.status !== 'passed') {
            return { ok: false, outcome: 'failed', error: 'publish ran before the passing simulation receipt was approved' };
          }
          const approval = outputs['approve-publish'];
          if (approval?.outcome !== 'approved') return { ok: false, outcome: 'failed', error: 'publish did not receive an approved graph decision' };
          const buildResult = outputs.build?.result;
          if (typeof buildResult?.service !== 'string' || !buildResult.capacityAssumption) {
            return { ok: false, outcome: 'failed', error: 'publish capability could not resolve the declared build bindings' };
          }
          if (nodeInput.service !== buildResult.service
            || JSON.stringify(nodeInput.capacityAssumption) !== JSON.stringify(buildResult.capacityAssumption)) {
            return { ok: false, outcome: 'failed', error: 'publish node did not receive the build service and capacity values: ' + JSON.stringify(nodeInput) };
          }
          const acceptance = { suggestionId: outputs['lookup-suggestion']?.evidence?.suggestion?.id,
            owner: ownerId, accepted: true, service: buildResult.service };
          const capacityAssumption = buildResult.capacityAssumption;
          const boardCard = { ...previous.boardCard, state: 'released', stateHistory: [...previous.boardCard.stateHistory, 'released'], resultUrl: ${JSON.stringify(`https://${appId}.app.sim.invalid/`)} };
          const scenes = { ...previous.scenes,
            '5': { ...previous.scenes?.['5'], output: { ...previous.scenes?.['5']?.output, acceptance, capacityAssumption } },
            '6': { ...previous.scenes?.['6'], output: { resultUrl: boardCard.resultUrl, boardCardId: boardCard.id } } };
          writeFileSync(marker, JSON.stringify({ ...previous, status: 'done', boardCard, scenes }));
          return { ok: true, outcome: 'done', result: { published: true, resultUrl: boardCard.resultUrl, boardCard, acceptance, capacityAssumption },
            evidence: { owner: ownerId, boardCard, attachment: previous.attachment, acceptance, capacityAssumption } };
        }
        return { ok: false, outcome: 'failed', error: 'unexpected app-publish action' };
      } });
    const graphRunOptions = { deps: { root: join(state, 'graph-runs'), capabilityProviders: providers,
      callLLM: async (prompt) => {
        const match = /Input:\\s*(\\{[\\s\\S]*\\})\\s*$/.exec(prompt);
        const input = match ? JSON.parse(match[1]) : {};
        const context = input.context ?? {};
        const prior = input.prior ?? {};
        if (prompt.includes('absorb/card')) {
          const items = prior.items ?? [];
          recordRun('absorb-brief', briefRunId, { owner: context.memberId, input: '오늘 브리핑', kinds: items.map(item => item.kind) },
            { extracted: items.length, kinds: items.map(item => item.kind), scrapIds: items.map(item => item.id) }, 2);
          const cards = items.map(item => ({ id: 'card-' + item.id, scrapId: item.id, title: item.title, points: [item.text], tags: [item.kind] }));
          return JSON.stringify({ outcome: 'done', result: { cards }, evidence: { cards, scrapIds: cards.map(card => card.scrapId) } });
        }
        if (prompt.includes('absorb/brief')) {
          const cards = prior.cards ?? [];
          const sourceScrapIds = cards.map(card => card.scrapId);
          const briefing = { id: ${JSON.stringify(ticketScenario ? 'brief-kcb-ticket-1' : 'brief-kaist-1')}, topics: [{
            summary: ${JSON.stringify(ticketScenario ? '기사의 접속 폭주·예매 실패에서 추론한 설계 쟁점(가정): 공정 대기열, 같은 좌석 중복 예매 0건, 결제 실패 복구' : 'KAIST lecture materials')},
            sourceScrapIds,
          }], scrapIds: sourceScrapIds };
          return JSON.stringify({ outcome: 'done', result: { briefing }, evidence: { briefing } });
        }
        if (prompt.includes('absorb/suggest')) {
          const sourceScrapIds = Array.isArray(prior.briefing?.scrapIds) ? prior.briefing.scrapIds : [];
          const suggestion = { id: suggestionId, owner: context.memberId, appId: ${JSON.stringify(appId)}, ask: ${JSON.stringify(suggestionAsk)}, evidenceScrapIds: sourceScrapIds };
          return JSON.stringify({ outcome: 'done', result: { items: [suggestion] }, evidence: { suggestions: [suggestion] } });
        }
        if (!prompt.includes('absorb/build') || input.ask !== ${JSON.stringify(suggestionAsk)}) throw new Error('unexpected absorb-build graph LLM prompt: ' + prompt.slice(0, 300));
        recordGraphNode('build');
        const isTicketRequest = input.ask.includes('티켓 예매 서비스');
        const service = isTicketRequest ? '티켓 예매 서비스' : 'lesson timer';
        const capacityAssumption = isTicketRequest
          ? { concurrentUsers: 300, rationale: '요청에 "동시 300명"이 명시됨.', source: 'user-input', userSpecified: true }
          : { concurrentUsers: 1, rationale: '요청에 부하 목표가 없어 격리 시뮬레이션용 임시 기준으로만 추정함.', source: 'model-estimate', userSpecified: false };
        const artifact = { id: 'artifact-' + (context.suggestionId ?? suggestionId), ask: input.ask, service, capacityAssumption, files: { '/index.html': '<main>fake</main>' } };
        const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {};
        writeFileSync(marker, JSON.stringify({ ...previous, owner: context.memberId, graph: 'absorb-build', status: 'building', boardCard: { id: ${JSON.stringify(boardCardId)}, owner: context.memberId, state: 'building', stateHistory: ['building'] }, attachment: { id: artifact.id, kind: 'app-artifact' } }));
        return JSON.stringify({ outcome: 'done', result: { artifact, service, capacityAssumption }, evidence: { artifact, owner: context.memberId, suggestionId: context.suggestionId, service, capacityAssumption } });
      } } };
    await showDashboard({ chatOnly: true, graphRunOptions,
      getNexusMemberSession: () => ({ nexusUrl: ${JSON.stringify(`http://127.0.0.1:${nexus.port}`)}, sessionToken: ${JSON.stringify(sessionToken)} }) });
  `;
  const state = join(root, 'state');
  const data = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(state, { recursive: true }); mkdirSync(data, { recursive: true }); mkdirSync(home, { recursive: true });
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_ENV: 'development',
    HOME: home, ELANOUS_STATE_DIR: state, ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_DATA_DIR: data,
    ELANOUS_SKIP_LOGIN_ENV: '1', TERM: 'xterm-256color', COLUMNS: '120', LINES: '32' };
  for (const key of ['ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR']) delete env[key];
  const credentialEnv = /(_API_KEY|_TOKEN|_AUTH|_SECRET)$|^(ANTHROPIC|OPENAI|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|CODEX|CLAUDE|AWS|BEDROCK|ELANOUS_CODEX)/i;
  for (const key of Object.keys(env)) if (credentialEnv.test(key)) delete env[key];
  // Keep the real built-in plugin directory resolvable from the repository cwd;
  // only HOME/state/data are isolated, so this exercises the production route catalog.
  const repoRoot = join(import.meta.dir, '../..');
  const pty = startPty({ cmd: process.execPath, args: ['-e', driver], workdir: repoRoot, cols: 120, rows: 32, env,
    unsetEnv: ['ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR'] });
  const screen = () => pty.renderScreen();
  let expectRejectedGraph = false;
  const waitFor = async (needle: string, label: string) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const text = await screen();
      if (text.includes(needle)) return text;
      const failedToolResult = (() => { try { return JSON.parse(lastToolResult) as { status?: string }; } catch { return {}; } })();
      if (!expectRejectedGraph && modelRequests > 2 && failedToolResult.status === 'failed') {
        const failedRun = (() => { try { return JSON.parse(lastToolResult) as { unitCalls?: Array<{ childRunId?: string }> }; } catch { return {}; } })();
        const childRunId = failedRun.unitCalls?.[0]?.childRunId;
        const childPath = childRunId ? join(state, 'graph-runs', 'graph-runs', 'verb-make', `${childRunId}.json`) : '';
        const childState = childPath && existsSync(childPath) ? readFileSync(childPath, 'utf8') : 'unavailable';
        throw new Error(`classic dashboard PTY route returned before confirmation/receipt; ownerRequests=${ownerRequests}; toolResult=${lastToolResult}; childState=${childState}; screen=${text.slice(-1800)}`);
      }
      await Bun.sleep(100);
    }
    throw new Error(`classic dashboard PTY timed out waiting for ${label}; ownerRequests=${ownerRequests}; modelRequests=${modelRequests}; toolResult=${lastToolResult}: ${(await screen()).slice(-1800)}`);
  };
  try {
    await waitFor('❯', 'classic dashboard prompt');
    pty.write('이 기사 스크랩해줘 ' + ingestUrl + (ticketScenario ? ' — 축제·콘서트 티켓 대란: 접속 폭주로 예매 실패' : '')); pty.write('\r');
    const ingestScreen = await waitFor('ABSORB_SCENE_RECEIPT', 'scene 1 fake scrape receipt');
    if (!existsSync(markerPath)) throw new Error(`classic PTY showed no ingest receipt file; modelRequests=${modelRequests}; toolResult=${lastToolResult}; screen=${ingestScreen}`);
    const ingestReceipt = JSON.parse(readFileSync(markerPath, 'utf8')).scenes?.['1'];
    expect(ingestReceipt).toMatchObject({ input: { kind: 'web', url: ingestUrl },
      output: { owner: 'member-from-fake-nexus', kind: 'web', url: ingestUrl } });
    if (ticketScenario) expect(ingestReceipt.output).toMatchObject({ scrapId: 'scrap-kcb-article-1', text: sourceText });
    expect(ingestScreen).toContain(ingestUrl);
    pty.write('오늘 브리핑'); pty.write('\r');
    const briefScreen = await waitFor('"scene":3', 'scene 2–3 brief and fanout receipts');
    expect(briefScreen).toContain('"scene":2');
    pty.write('제안 목록'); pty.write('\r');
    await waitFor('"scene":4', 'scene 4 suggestion receipt');
    pty.write(ticketScenario ? '이 제안 수락 — 티켓 예매 서비스 동시 300명' : '이 제안 수락'); pty.write('\r');
    await waitFor('이 제안을 격리된 앱 복사본에 적용하고 시뮬레이션을 시작할까요?', 'suggestion confirmation');
    pty.write('y'); pty.write('\r');
    await waitFor('N → rejected (default)', 'post-simulation publish approval');
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ status: 'testing',
      boardCard: { state: 'testing', stateHistory: ['building', 'testing'] } });
    pty.write('y'); pty.write('\r');
    const receiptScreen = await waitFor('"scene":6', 'scene 5–6 board, attachment, and QR receipts');
    expect(ownerRequests).toBeGreaterThan(0);
    expect(modelRequests).toBeGreaterThanOrEqual(3);
    const graphResult = JSON.parse(lastToolResult) as { status?: string; path?: string[]; nodes?: Array<{ nodeId: string; output?: unknown }> };
    expect(graphResult).toMatchObject({ status: 'done' });
    expect(graphResult.path).toEqual(['lookup-suggestion', 'board-building', 'build', 'simulate', 'board-testing', 'approve-publish', 'publish', 'board-deployed', 'done']);
    const graphNodeOutput = (nodeId: string) => {
      const output = graphResult.nodes?.find(node => node.nodeId === nodeId)?.output;
      return typeof output === 'string' ? JSON.parse(output) as Record<string, unknown> : output as Record<string, unknown> | undefined;
    };
    expect(graphNodeOutput('approve-publish')).toMatchObject({ outcome: 'approved' });
    expect(graphNodeOutput('publish')).toMatchObject({ result: {
      acceptance: { suggestionId, owner: 'member-from-fake-nexus', accepted: true, service: ticketScenario ? '티켓 예매 서비스' : 'lesson timer' },
    } });
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ owner: 'member-from-fake-nexus', graph: 'absorb-build', status: 'done' });
    const finalMarker = JSON.parse(readFileSync(markerPath, 'utf8'));
    finalMarker.graphPath = graphResult.path;
    expect(finalMarker.graphPath).toEqual(graphResult.path);
    finalMarker.scenes['6'].output.boardCard = finalMarker.boardCard;
    finalMarker.scenes['6'].output.attachment = finalMarker.attachment;
    writeFileSync(markerPath, JSON.stringify(finalMarker));
    expect(finalMarker).toMatchObject({
      boardCard: { id: boardCardId, owner: 'member-from-fake-nexus', state: 'released', stateHistory: ['building', 'testing', 'released'] },
      attachment: { id: 'artifact-' + suggestionId, kind: 'app-artifact' },
    });
    expect(finalMarker.attachment.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(finalMarker.scenes['1'].output.owner).toBe('member-from-fake-nexus');
    expect(finalMarker.scenes['1'].output).toMatchObject({ kind: 'web', url: ingestUrl });
    expect(finalMarker.scenes['2'].output.kinds).toEqual(expect.arrayContaining(['web', 'x', 'youtube', 'voice', 'video', 'photo', 'text']));
    expect(finalMarker.scenes['3'].output.channels).toEqual(['android', 'tui', 'telegram']);
    expect(finalMarker.scenes['4'].output.sourceScrapIds).toEqual(finalMarker.scenes['2'].output.scrapIds);
    expect(finalMarker.scenes['5'].output.attachment.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(finalMarker.scenes['5'].output.acceptance).toMatchObject({ suggestionId, owner: 'member-from-fake-nexus', accepted: true,
      service: ticketScenario ? '티켓 예매 서비스' : 'lesson timer' });
    expect(finalMarker.scenes['6'].output.resultUrl).toBe(`https://${appId}.app.sim.invalid/`);
    if (ticketScenario) {
      const suggestion = finalMarker.scenes['4'].output.suggestion;
      const briefing = finalMarker.scenes['3'].output.briefing;
      const ticketMapping = {
        sourceRunIds: { briefing: finalMarker.scenes['3'].runId, acceptance: finalMarker.scenes['5'].runId },
        briefingMapping: { id: briefing?.id, owner: briefingOwnerMapping(briefing), topics: briefing?.topics },
        acceptance: finalMarker.scenes['5'].output.acceptance,
        suggestion,
      };
      expect(Object.hasOwn(briefing ?? {}, 'owner')).toBe(false);
      expect(ticketMapping.briefingMapping.owner).toEqual(briefingOwnerMapping(briefing));
      expect(ticketMapping.acceptance).toMatchObject({ service: '티켓 예매 서비스' });
      expect(finalMarker.scenes['1'].output.scrapId).toBe('scrap-kcb-article-1');
      process.stdout.write(`KCB_TICKET_MAPPING ${JSON.stringify(ticketMapping)}\n`);
    }
    expect(receiptScreen).toContain('"scene":5');
    process.stdout.write(`${ticketScenario ? 'KCB_TICKET' : 'KAIST_KCB'}_RECEIPTS ${readFileSync(markerPath, 'utf8')}\n`);
    const sceneReceipts = (Object.values(finalMarker.scenes) as Array<{ scene: number }>).sort((left, right) => left.scene - right.scene);
    expect(sceneReceipts).toHaveLength(6);
    for (const receipt of sceneReceipts) {
      expect(receipt).toMatchObject({ runId: expect.any(String), input: expect.any(Object), output: expect.any(Object) });
      console.log(`${ticketScenario ? 'KCB_TICKET' : 'KAIST_KCB'}_RECEIPT ${JSON.stringify(receipt)}`);
    }
    pty.write(ticketScenario ? '이 제안 수락 — 티켓 예매 서비스 동시 300명' : '이 제안 수락'); pty.write('\r');
    await waitFor('이 제안을 격리된 앱 복사본에 적용하고 시뮬레이션을 시작할까요?', 'second acceptance start confirmation');
    pty.write('y'); pty.write('\r');
    await waitFor('N → rejected (default)', 'second run publish rejection');
    expectRejectedGraph = true;
    pty.write('N'); pty.write('\r');
    await waitFor('ABSORB_REJECT_RECEIPT', 'rejected graph receipt');
    const rejectedGraphResult = JSON.parse(lastToolResult) as { status?: string; path?: string[]; nodes?: Array<{ nodeId: string; output?: unknown }> };
    expect(rejectedGraphResult).toMatchObject({ status: 'failed' });
    expect(rejectedGraphResult.path).toEqual(['lookup-suggestion', 'board-building', 'build', 'simulate', 'board-testing', 'approve-publish', 'failed']);
    const rejectedApproval = rejectedGraphResult.nodes?.find(node => node.nodeId === 'approve-publish')?.output;
    expect(typeof rejectedApproval === 'string' ? JSON.parse(rejectedApproval) : rejectedApproval).toMatchObject({ outcome: 'rejected' });
    expect(rejectedGraphResult.nodes?.some(node => node.nodeId === 'publish')).toBe(false);
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).scenes['5'].output.acceptance).toBeUndefined();
    if (ticketScenario && process.env.DEMO_INT_TUI_RECEIPT_PATH) {
      writeFileSync(process.env.DEMO_INT_TUI_RECEIPT_PATH, JSON.stringify({ rehearsalId: 'DEMO-INT-TUI-LAP-1111-02',
        sourceReceipt: 'PWA-1/kcb-scene-1-1110/receipt.json',
        sourceReceiptProvenance: 'unverified fixture reference; this PTY did not read the PWA receipt',
        sourceScrapId: sharedScrapId,
        scenes: finalMarker.scenes, boardCard: finalMarker.boardCard,
        attachment: finalMarker.attachment }, null, 2) + '\n');
    }
  } finally {
    pty.kill(); unregisterPty(pty.id);
    nexus.stop(true);
    model.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 180_000 }); // Source: #95987 fake-member graph-route receipt; setup time is not a wall-clock pass criterion.

test('production graph owner denial keeps a structured user-action code through the TUI tool wrapper', async () => {
  let graphEffects = 0;
  const routeAdapter = createDashboardPluginRouteAdapter({
    pluginRoot: join(import.meta.dir, '..', '..', 'plugins'),
    dispatchCore: async () => undefined,
    dispatchGraph: async (_pluginId, _graphId, file, args, context) => {
      graphEffects += 1;
      return dispatchVerifiedDashboardGraph(file, args, context);
    },
  });
  const scrap = routeAdapter.classicHostTools([]).find(tool => tool.name === 'scrap_add')!;
  const denial = await scrap.handler({ url: 'https://example.test/article' }, {} as never);
  expect(denial).toMatchObject({ code: 'VERIFIED_OWNER_REQUIRED', error: expect.stringContaining('verified owner') });
  expect(graphEffects).toBe(1);
  let turns = 0;
  let delegated = 0;
  const result = await runGoalLoop({
    sessionId: 'owner-block-product-seam',
    messages: [{ role: 'user', content: 'save this public article' }],
    tools: [],
    signal: new AbortController().signal,
    dispatchTool: async name => {
      if (name === 'Agent') delegated += 1;
      return {};
    },
  } as CoreTurnContext, {
    intentStallProvider: null,
    runTurn: async ctx => {
      turns += 1;
      const actualResult = await scrap.handler({ url: 'https://example.test/article' }, {} as never);
      ctx.callbacks?.onToolResult?.({ id: 'scrap-auth', name: 'scrap_add', result: actualResult });
      expect(ctx.signal.aborted).toBe(true);
      await ctx.dispatchTool('Agent', { prompt: 'investigate source owner lookup' });
      return { stopReason: 'aborted', finalText: '' };
    },
  });
  expect(result).toMatchObject({ iterations: 1, stopReason: 'no_progress', goalComplete: false });
  expect(result.finalText).toContain('회원 연결');
  expect(turns).toBe(1);
  expect(delegated).toBe(0);
});
