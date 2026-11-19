// WEBCHAT-APP-BUILD-PLUGIN-BRIDGE 실행 슬라이스(OP #96590) 시험 — app-deploy-plugin.test.ts 형제 구조.
// 계약: (1) 게이트 원문 그대로(needs_connection · external-agent · ask · 슬롯), (2) published 는 확인된
// 실행 결과의 publicUrl 로만, (3) app_build_plan 은 계획만, (4) 실행기 없음은 started 위조 없이 fail-closed.
import { expect, test } from 'bun:test';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';
import { buildSharedAppTools } from './shared-app-tools.js';
import { APP_BUILD_PLUGIN_ID, appBuildPluginSpecs, runAppBuild } from './app-build-plugin.js';
import { appBuildDeclinedFailure } from '../plugins/core/app-build-decline-guard.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';

const shared = buildSharedAppTools();
const OWNER: NonNullable<ToolRuntimeContext['verifiedOwner']> = { id: 'member-1', appSlug: 'yongpyong-ski' };
const ASK = '용평 스키 강습 예약 앱 만들어줘';

test('shared app tools carry both app_build tools with their manifest routes', () => {
  expect(shared.specs.map((spec) => spec.name)).toContain('app_build');
  expect(shared.specs.map((spec) => spec.name)).toContain('app_build_plan');
  const build = shared.specs.find((spec) => spec.name === 'app_build');
  const plan = shared.specs.find((spec) => spec.name === 'app_build_plan');
  expect(build?.pluginId).toBe(APP_BUILD_PLUGIN_ID);
  expect(build?.route).toMatchObject({ requiresConfirm: true, risk: 'high' });
  expect(plan?.route).toMatchObject({ requiresConfirm: false });
  expect(appBuildPluginSpecs().map((spec) => spec.name).sort()).toEqual(['app_build', 'app_build_plan']);
});

test('a one-line app request pins app_build in the deferred turn pool', () => {
  const userText = `이거 해줘: ${ASK}`;
  const applied = applyDeferredTools([{ role: 'user', content: userText }], shared.specs, { userText }) as unknown as { turn?: { stats?: { deferredNames?: string[] } }; stats?: { deferredNames?: string[] } };
  const stats = applied.turn?.stats ?? applied.stats;
  expect(stats?.deferredNames).toContain('app_build');
});

test('app_build without a member connection surfaces the explicit needs_connection gate', async () => {
  const calls: unknown[] = [];
  const out = await runAppBuild('app_build', { ask: ASK }, { surface: 'tui' }, {
    dispatchGraph: async (...call) => { calls.push(call); return { status: 'done' }; },
  });
  expect(out).toMatchObject({ kind: 'app-build', tool: 'app_build', status: 'needs_connection',
    needsConnection: true, code: 'VERIFIED_OWNER_REQUIRED', buildComplete: false });
  expect(out.error).toContain('needs_connection');
  expect(out.publicUrl).toBeUndefined();
  expect(calls.length).toBe(0); // 게이트에서 실행기에 닿지 않는다
});

test('app_build_plan also requires a verified owner', async () => {
  const out = await runAppBuild('app_build_plan', { ask: ASK }, { surface: 'tui' }, {
    dispatchGraph: async () => ({ status: 'done' }),
  });
  expect(out).toMatchObject({ status: 'needs_connection', code: 'VERIFIED_OWNER_REQUIRED', buildComplete: false });
});

test('an external-agent origin is refused before anything runs', async () => {
  const calls: unknown[] = [];
  const out = await runAppBuild('app_build', { ask: ASK },
    { surface: 'tui', requestOrigin: 'external-agent', verifiedOwner: OWNER,
      appBuildRouteDispatch: async (...call) => { calls.push(call); return { ok: true }; } });
  expect(out).toMatchObject({ status: 'rejected', buildComplete: false });
  expect(out.error).toContain('external-agent');
  expect(calls.length).toBe(0);
});

test('a missing ask is rejected before anything runs', async () => {
  const out = await runAppBuild('app_build', {}, { surface: 'tui', verifiedOwner: OWNER }, {
    dispatchGraph: async () => ({ status: 'done' }),
  });
  expect(out).toMatchObject({ status: 'rejected', code: 'APP_BUILD_ASK_REQUIRED', buildComplete: false });
});

test('a member without an app slot stays needs_connection (slot from server receipt only)', async () => {
  const out = await runAppBuild('app_build', { ask: ASK }, { surface: 'tui', verifiedOwner: { id: 'member-2' } }, {
    dispatchGraph: async () => ({ status: 'done' }),
  });
  expect(out).toMatchObject({ status: 'needs_connection', code: 'MEMBER_APP_SLOT_REQUIRED', buildComplete: false });
});

test('a confirmed member app build publishes the graph public URL', async () => {
  let seen: Record<string, unknown> | undefined;
  const out = await runAppBuild('app_build', { ask: ASK },
    { surface: 'tui', verifiedOwner: OWNER, confirmChannels: [] }, {
      requestConfirmation: async () => true,
      dispatchGraph: async (_pluginId, _graphId, _graphFile, graphArgs) => {
        seen = graphArgs;
        return { graphId: 'app-build', runId: 'run-9', status: 'done',
          publicUrl: 'https://yongpyong-ski--member-1.elanous.app/' };
      },
    });
  expect(out).toMatchObject({ status: 'published', publicUrl: 'https://yongpyong-ski--member-1.elanous.app/',
    buildComplete: true, graphId: 'app-build' });
  expect(seen?.ask).toContain(ASK); // 한 줄 그대로 + 호스트 주석
  expect(seen?.appSlug).toBe('yongpyong-ski'); // 슬롯은 서버 검증 문맥에서만
});

test('publishing stays behind the confirmation — a declined build never runs', async () => {
  const calls: unknown[] = [];
  const out = await runAppBuild('app_build', { ask: ASK },
    { surface: 'tui', verifiedOwner: OWNER, confirmChannels: [] }, {
      requestConfirmation: async () => false,
      dispatchGraph: async (...call) => { calls.push(call); return { status: 'done', publicUrl: 'https://x/' }; },
    });
  expect(out).toMatchObject({ status: 'rejected', code: 'APP_BUILD_DECLINED', buildComplete: false });
  expect(out.publicUrl).toBeUndefined();
  expect(calls.length).toBe(0);
});

test('app_build_plan asks no confirmation, plans, and never publishes', async () => {
  const confirmations: unknown[] = [];
  const out = await runAppBuild('app_build_plan', { ask: ASK },
    { surface: 'tui', verifiedOwner: OWNER, confirmChannels: [] }, {
      requestConfirmation: async (opts) => { confirmations.push(opts); return true; },
      dispatchGraph: async () => ({ graphId: 'app-build-plan', runId: 'run-p', status: 'done',
        publicUrl: 'https://never-published.example/' }),
    });
  expect(out).toMatchObject({ status: 'planned', buildComplete: false, graphId: 'app-build-plan' });
  expect(out.publicUrl).toBeUndefined(); // 계획은 공개를 위조하지 않는다
  expect(confirmations.length).toBe(0); // requiresConfirm:false
});

test('a done build without a public URL is never published', async () => {
  const out = await runAppBuild('app_build', { ask: ASK },
    { surface: 'tui', verifiedOwner: OWNER, confirmChannels: [] }, {
      requestConfirmation: async () => true,
      dispatchGraph: async () => ({ status: 'done' }),
    });
  expect(out).toMatchObject({ status: 'failed', buildComplete: false });
  expect(out.error).toContain('without a public URL');
});

test('an approval hold surfaces as awaiting-approval, not a silent start', async () => {
  const out = await runAppBuild('app_build', { ask: ASK },
    { surface: 'tui', verifiedOwner: OWNER, confirmChannels: [] }, {
      requestConfirmation: async () => true,
      dispatchGraph: async () => ({ status: 'awaiting-approval',
        pending: { nodeId: 'review-publish', message: '게시 승인을 진행할까요?' }, approvalHold: 'unavailable' }),
    });
  expect(out).toMatchObject({ status: 'awaiting-approval', approvalHold: 'unavailable', buildComplete: false });
});

test('the server route delegate is the preferred execution machine', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const out = await runAppBuild('app_build', { ask: ASK }, { surface: 'tui', verifiedOwner: OWNER,
    appBuildRouteDispatch: async (name, args) => {
      calls.push([name, args]);
      return { ok: true, result: { graphId: 'app-build', runId: 'run-7', status: 'done',
        publicUrl: 'https://yongpyong-ski--member-1.elanous.app/' } };
    } });
  expect(out).toMatchObject({ status: 'published', publicUrl: 'https://yongpyong-ski--member-1.elanous.app/',
    buildComplete: true });
  expect(calls.length).toBe(1);
  expect(calls[0]![0]).toBe('app_build'); // 위임은 route adapter 로 — 확인·게이트는 그 안에서
  expect(calls[0]![1].ask).toBe(ASK); // 원문 인자가 위임된다(autofill 은 adapter 가 수행)
});

test('the route delegate decline and needs_connection cards translate verbatim', async () => {
  const declined = await runAppBuild('app_build', { ask: ASK }, { surface: 'tui', verifiedOwner: OWNER,
    appBuildRouteDispatch: async () => appBuildDeclinedFailure('app_build', 'declined') });
  expect(declined).toMatchObject({ status: 'rejected', code: 'APP_BUILD_DECLINED', buildComplete: false });
  const gate = await runAppBuild('app_build', { ask: ASK }, { surface: 'tui',
    appBuildRouteDispatch: async () => ({ ok: false,
      error: 'needs_connection: verified member connection required before app_build (eln member connect)',
      code: 'VERIFIED_OWNER_REQUIRED' }) });
  expect(gate).toMatchObject({ status: 'needs_connection', needsConnection: true,
    code: 'VERIFIED_OWNER_REQUIRED', buildComplete: false });
});

test('a member slot restored from the server receipt reaches the graph', async () => {
  let seen: Record<string, unknown> | undefined;
  const out = await runAppBuild('app_build', { ask: ASK }, { surface: 'tui', verifiedOwner: { id: 'member-2' },
    appDeploymentOwner: { appSlug: 'yongpyong-ski', memberId: 'member-2', userSlug: 'user',
      plan: 'free', entitlements: {} } }, {
    requestConfirmation: async () => true,
    dispatchGraph: async (_pluginId, _graphId, _graphFile, graphArgs) => {
      seen = graphArgs;
      return { status: 'done', publicUrl: 'https://yongpyong-ski--member-2.elanous.app/' };
    },
  });
  expect(out).toMatchObject({ status: 'published', publicUrl: 'https://yongpyong-ski--member-2.elanous.app/',
    buildComplete: true });
  expect(seen?.appSlug).toBe('yongpyong-ski'); // verifiedOwnerOf 와 같은 영수증 일치 규칙
});

test('without any executor the bridge fails closed instead of pretending a start', async () => {
  const out = await runAppBuild('app_build', { ask: ASK },
    { surface: 'tui', verifiedOwner: OWNER, confirmChannels: [] });
  expect(out).toMatchObject({ status: 'failed', buildComplete: false });
  expect(out.error).toContain('graph route executor is not configured');
  expect('started' in out).toBe(false); // started 상태는 이제 존재하지 않는다
});
