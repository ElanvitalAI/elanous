import { expect, test } from 'bun:test';
import { createAcpConfirmChannel } from '../acp/acp-surface-channels.js';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';
import { routeToolSearch } from '../skills/tools/tool-search-route.js';
import { takeHydratedTools } from '../skills/tools/tool-search-spec.js';
import { buildSharedAppTools } from './shared-app-tools.js';
import { appDeployPluginSpec, runAppDeploy } from './app-deploy-plugin.js';
import type { AppSimulationResult } from '../nexus/apps/app-simulation.js';
import { createFakeAppDeployPublishHook, createFakeAppHost } from '../ux-sim/fake-app-host.js';

const args = { appId: 'lecture-scrap', requestText: '강의 노트·스크랩 앱 만들어 배포해 줘' };
const passed: AppSimulationResult = {
  runId: 'run-1', events: [], receipts: [{ id: 'receipt-1', appId: 'lecture-scrap', runId: 'run-1', outcome: 'passed', summary: 'PASS' }],
};

test('TUI and PWA share one manifest route and hydrate app_deploy on a Korean request', () => {
  const shared = buildSharedAppTools();
  const spec = shared.specs.find(tool => tool.name === 'app_deploy');
  expect(spec).toEqual(appDeployPluginSpec());
  expect(spec?.route).toMatchObject({ risk: 'high', sideEffects: 'external', requiresConfirm: true });
  const turn = applyDeferredTools([{ role: 'user', content: args.requestText }], shared.specs, { userText: args.requestText });
  expect(turn.stats.deferredNames).toContain('app_deploy');
  const search = routeToolSearch({ query: `route:${args.requestText}` }, shared.specs, { surface: 'pwa' });
  expect(takeHydratedTools(search).map(tool => tool.name)).toContain('app_deploy');
});

test('simulation returns a structured card and never invents a public URL without a publish hook', async () => {
  expect(await runAppDeploy(args, undefined, { simulate: async () => passed })).toEqual({
    kind: 'site-deploy', status: 'simulated', simulationReceipt: 'receipt-1',
  });
  expect(await runAppDeploy({ ...args, appId: 'other' }, undefined, { simulate: async () => passed })).toMatchObject({
    kind: 'site-deploy', status: 'failed',
  });
});

test('failed simulation stops before any confirmation or public publish', async () => {
  let publishes = 0;
  const failed: AppSimulationResult = { ...passed, receipts: [{ ...passed.receipts[0]!, outcome: 'failed' }] };
  const result = await runAppDeploy(args, { surface: 'tui', verifiedOwner: { id: 'alice' }, appDeploymentSession: 'nexus-owner', confirmChannels: [] }, {
    simulate: async () => failed,
    hook: { publish: async () => { publishes++; return { publicUrl: 'https://lecture-scrap--alice.elanous.app/' }; }, verifyPublicUrl: async () => true },
    resolveOwner: () => 'alice',
  });
  expect(result.status).toBe('failed');
  expect(publishes).toBe(0);
});

test('a member session cannot promote a verified principal into the Nexus deployment owner', async () => {
  let publishes = 0;
  let ownerResolutions = 0;
  const result = await runAppDeploy(args, {
    surface: 'tui', verifiedOwner: { id: 'member-1' }, appDeploymentSession: 'member',
    confirmChannels: [{ name: 'test', request: async () => true, cancel: () => undefined }],
  }, {
    simulate: async () => passed,
    resolveOwner: () => { ownerResolutions++; return 'alice'; },
    hook: { publish: async () => { publishes++; return { publicUrl: 'https://lecture-scrap--alice.elanous.app/' }; }, verifyPublicUrl: async () => true },
  });
  expect(result.status).toBe('rejected');
  expect(ownerResolutions).toBe(0);
  expect(publishes).toBe(0);
});

test('a verified owner for another app cannot publish lecture-scrap', async () => {
  let publishes = 0;
  const result = await runAppDeploy(args, {
    surface: 'tui', verifiedOwner: { id: 'member-1' }, appDeploymentSession: 'nexus-owner',
    appDeploymentOwner: { appSlug: 'other-app', memberId: 'member-1', userSlug: 'alice', plan: 'free', entitlements: {} },
    confirmChannels: [{ name: 'test', request: async () => true, cancel: () => undefined }],
  }, {
    simulate: async () => passed,
    hook: { publish: async () => { publishes++; return { publicUrl: 'https://lecture-scrap--alice.elanous.app/' }; }, verifyPublicUrl: async () => true },
  });
  expect(result.status).toBe('rejected');
  expect(publishes).toBe(0);
});

test('ACP y/N asks once after PASS, defaults to N, and publishes only after y', async () => {
  for (const answer of ['N', 'y']) {
    let publishes = 0;
    let question: any;
    const channel = createAcpConfirmChannel('owner-session', async (_sessionId, payload) => {
      question = payload.request.questions[0];
      return { answers: { confirm: answer } };
    });
    const result = await runAppDeploy(args, {
      surface: 'tui', verifiedOwner: { id: 'member-1' }, appDeploymentSession: 'nexus-owner', sessionId: 'owner-session',
      appDeploymentOwner: { appSlug: 'lecture-scrap', memberId: 'member-1', userSlug: 'alice', plan: 'free', entitlements: {} }, confirmChannels: [channel],
    }, {
      simulate: async () => passed,
      hook: {
        publish: async () => { publishes++; return { publicUrl: 'https://lecture-scrap--alice.elanous.app/' }; },
        verifyPublicUrl: async () => true,
      },
      resolveOwner: () => 'alice',
    });
    expect(question).toMatchObject({ id: 'confirm', header: '배포', recommendedIndex: 1, includeOther: false });
    expect(question.options.map((option: { label: string }) => option.label)).toEqual(['y', 'N']);
    expect(result.status).toBe(answer === 'y' ? 'published' : 'rejected');
    expect(publishes).toBe(answer === 'y' ? 1 : 0);
    expect(result.publicUrl).toBe(answer === 'y' ? 'https://lecture-scrap--alice.elanous.app/' : undefined);
  }
});

test('TUI and PWA publish through the fake app host only for the verified owner and PASS receipt', async () => {
  for (const surface of ['tui', 'pwa'] as const) {
    const host = createFakeAppHost([{ slug: 'lecture-scrap', versions: [
      { id: 'old', files: { 'index.html': '<main>old</main>' } },
    ], current: 'old' }]);
    const hook = createFakeAppDeployPublishHook({ host, ownerUserId: 'alice', receiptId: 'receipt-1',
      version: { id: 'new', files: { 'index.html': '<main>deployed</main>' } } });
    const context = { surface, verifiedOwner: { id: 'member-1' }, appDeploymentSession: 'nexus-owner' as const,
      appDeploymentOwner: { appSlug: 'lecture-scrap', memberId: 'member-1', userSlug: 'alice', plan: 'free', entitlements: {} },
      confirmChannels: [{ name: 'fake-confirm', request: async () => true, cancel: () => undefined }] };
    const result = await runAppDeploy(args, context, { simulate: async () => passed, hook });
    expect(result).toMatchObject({ status: 'published', simulationReceipt: 'receipt-1',
      publicUrl: 'https://lecture-scrap--alice.elanous.app/' });
    expect(host.fetch('lecture-scrap.app.sim.invalid', '/')).toMatchObject({ status: 200, body: '<main>deployed</main>' });
  }
});

test('a publish hook cannot report another owner origin as this owner deployment', async () => {
  const result = await runAppDeploy(args, {
    surface: 'pwa', verifiedOwner: { id: 'member-1' }, appDeploymentSession: 'nexus-owner',
    appDeploymentOwner: { appSlug: 'lecture-scrap', memberId: 'member-1', userSlug: 'alice', plan: 'free', entitlements: {} },
    confirmChannels: [{ name: 'fake-confirm', request: async () => true, cancel: () => undefined }],
  }, { simulate: async () => passed, hook: {
    publish: async () => ({ publicUrl: 'https://lecture-scrap--bob.elanous.app/' }),
    verifyPublicUrl: async () => true,
  } });
  expect(result).toMatchObject({ status: 'failed', error: 'public app URL is invalid' });
  expect(result.publicUrl).toBeUndefined();
});

test('registered app simulation uses the requested app id rather than a lecture constant', async () => {
  let observed = '';
  const result = await runAppDeploy({ appId: 'custom-generated-app', requestText: 'simulate my app' }, undefined, {
    simulate: async appId => {
      observed = appId;
      return { ...passed, receipts: passed.receipts.map(receipt => ({ ...receipt, appId })) };
    },
  });
  expect(observed).toBe('custom-generated-app');
  expect(result.status).toBe('simulated');
});
