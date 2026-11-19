// APP-BUILD-TOOLS-IN-DAEMON-TURN — the daemon chat turn reaches app_build through the same route bridge and
// approval/authority path as the Next TUI. Every graph executor here is a fake: no real build, no deploy.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserConfig } from '../../user-config/types.js';
import type { ConfirmChannel } from '../../hitl/confirm.js';
import { debug } from '../../debug/log.js';
import { createChildPluginRoutes, type ChildPluginRuntimeOptions } from '../../cli/child-plugin-runtime.js';
import { APP_BUILD_DECLINED_CODE } from '../../plugins/core/app-build-decline-guard.js';
import { toolSurface } from './index.js';
import {
  APP_BUILD_DECLINE_GUARD_TTL_MS, appBuildDeclineGuardCount, refuseBypassAfterAppBuildDecline, resetDaemonPluginRoutesForTest,
} from './plugin-routes.js';
import { DaemonSessionHistory } from '../daemon-runtime.js';
import { ToolSafetyError, type DaemonToolDispatchCtx } from './types.js';

const financeOff = { finance: { enabled: false } } as unknown as UserConfig;
const LINE = '콘서트 티케팅 시스템 만들어 배포해줘';
const SLOT = 'tix';

interface GraphCall { graphId: string; ownerId?: string; appSlug?: unknown }

function fakeGraph(calls: GraphCall[]): NonNullable<ChildPluginRuntimeOptions['dispatchGraph']> {
  return async (_pluginId, graphId, _graphFile, args, context) => {
    calls.push({ graphId, ownerId: context?.verifiedOwner?.id, appSlug: args.appSlug });
    // The contract's terminal graph result: done with an explicit public URL publishes.
    return { graphId, status: 'done', publicUrl: 'https://tix--m1.elanous.app/' };
  };
}

/** Daemon surface whose bridge is the production one with only the graph executor faked. */
function daemonChat(calls: GraphCall[], pluginRoot?: string, clock?: () => number) {
  resetDaemonPluginRoutesForTest((options) => createChildPluginRoutes({
    ...options, dispatchGraph: fakeGraph(calls), ...(pluginRoot ? { pluginRoot } : {}),
  }), clock);
  return toolSurface('chat', financeOff);
}

/** The Next TUI REPL wiring with no approver answering: decision «unavailable». */
function tuiRoutes(calls: GraphCall[], owner: { id: string; appSlug?: string } | undefined) {
  return createChildPluginRoutes({
    dispatchGraph: fakeGraph(calls),
    resolveVerifiedOwner: async () => owner,
    requestConfirmation: async () => false,
    requestDecision: async () => ({ approved: false, reason: 'unavailable' }),
  });
}

const channel = (answer: boolean): ConfirmChannel => ({
  name: 'pwa',
  request: async () => { await Promise.resolve(); return answer; },
  cancel: () => {},
});

function ctx(overrides: Partial<DaemonToolDispatchCtx> = {}, memberId = 'm1', slot = SLOT): DaemonToolDispatchCtx {
  return {
    cwd: '.', signal: new AbortController().signal, sessionId: `s-${memberId}`,
    verifiedOwner: { id: memberId },
    appDeploymentOwner: { appSlug: slot, memberId, userSlug: 'u', plan: 'pro', entitlements: {} },
    ...overrides,
  } as DaemonToolDispatchCtx;
}

afterEach(() => resetDaemonPluginRoutesForTest());

describe('daemon chat turn — app_build approval path is the TUI one', () => {
  test('no approval channel: refused exactly like the TUI with no approver, and the graph never runs', async () => {
    const daemonCalls: GraphCall[] = [];
    const tuiCalls: GraphCall[] = [];
    const daemon = await daemonChat(daemonCalls).dispatch('app_build', { ask: LINE }, ctx());
    const tui = await tuiRoutes(tuiCalls, { id: 'm1', appSlug: SLOT }).dispatchPluginTool('app_build', { ask: LINE });
    // The TUI probe still speaks the raw envelope, the daemon answers with the server card —
    // preserve the equality that matters: the same gate decision on both sides.
    expect((daemon as { code?: string }).code).toBe(APP_BUILD_DECLINED_CODE);
    expect((tui as { code?: string }).code).toBe(APP_BUILD_DECLINED_CODE);
    expect(daemon).toMatchObject({
      kind: 'app-build', status: 'rejected', code: APP_BUILD_DECLINED_CODE, buildComplete: false,
    });
    expect((daemon as { publicUrl?: string }).publicUrl).toBeUndefined();
    expect(daemonCalls).toEqual([]);
    expect(tuiCalls).toEqual([]);
  });

  test('no verified owner: same needs_connection refusal as the TUI, before any confirmation', async () => {
    const daemonCalls: GraphCall[] = [];
    let asked = 0;
    const counting: ConfirmChannel = { name: 'pwa', request: async () => { asked += 1; return true; }, cancel: () => {} };
    const daemon = await daemonChat(daemonCalls).dispatch('app_build', { ask: LINE },
      ctx({ verifiedOwner: undefined, surfaceHitlChannels: [counting] }));
    const tui = await tuiRoutes([], undefined).dispatchPluginTool('app_build', { ask: LINE });
    // Same gate decision as the TUI probe (raw envelope) — the daemon answers with the server card.
    expect((daemon as { code?: string }).code).toBe('VERIFIED_OWNER_REQUIRED');
    expect((tui as { code?: string }).code).toBe('VERIFIED_OWNER_REQUIRED');
    expect(daemon).toMatchObject({
      kind: 'app-build', status: 'needs_connection', code: 'VERIFIED_OWNER_REQUIRED',
      needsConnection: true, buildComplete: false,
    });
    expect(asked).toBe(0);
    expect(daemonCalls).toEqual([]);
  });

  test('an external-agent turn carries no owner authority', async () => {
    const calls: GraphCall[] = [];
    const result = await daemonChat(calls).dispatch('app_build', { ask: LINE },
      ctx({ requestOrigin: 'external-agent', surfaceHitlChannels: [channel(true)] } as Partial<DaemonToolDispatchCtx>));
    // Measured: an external-agent origin is refused before any owner gate — no gate code on the card.
    // The invariant is «refused, never run» with no started/published forgery.
    expect(result).toMatchObject({
      kind: 'app-build', status: 'rejected', buildComplete: false,
      error: expect.stringContaining('external-agent'),
    });
    expect((result as { code?: string }).code).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('the chat answers no: declined result, graph not run; answers yes: graph runs once for that owner', async () => {
    const calls: GraphCall[] = [];
    const surface = daemonChat(calls);
    const declined = await surface.dispatch('app_build', { ask: LINE }, ctx({ surfaceHitlChannels: [channel(false)] }));
    expect((declined as { code?: string }).code).toBe(APP_BUILD_DECLINED_CODE);
    expect(calls).toEqual([]);
    const approved = await surface.dispatch('app_build', { ask: LINE }, ctx({ surfaceHitlChannels: [channel(true)] }));
    // Published only behind a confirmed run with an explicit public URL.
    expect(approved).toMatchObject({
      kind: 'app-build', status: 'published', buildComplete: true, publicUrl: 'https://tix--m1.elanous.app/',
    });
    expect(calls).toEqual([{ graphId: 'app-build', ownerId: 'm1', appSlug: SLOT }]);
  });

  test('concurrent turns each keep their own owner and slot', async () => {
    const calls: GraphCall[] = [];
    const surface = daemonChat(calls);
    await Promise.all([
      surface.dispatch('app_build', { ask: LINE }, ctx({ surfaceHitlChannels: [channel(true)] }, 'm1', 'tix')),
      surface.dispatch('app_build', { ask: LINE }, ctx({ surfaceHitlChannels: [channel(true)] }, 'm2', 'shop')),
    ]);
    expect([...calls].sort((a, b) => String(a.ownerId).localeCompare(String(b.ownerId)))).toEqual([
      { graphId: 'app-build', ownerId: 'm1', appSlug: 'tix' },
      { graphId: 'app-build', ownerId: 'm2', appSlug: 'shop' },
    ]);
  });

  test('after a declined app_build, a bypass deploy in that session is refused (TUI decline guard)', async () => {
    const surface = daemonChat([]);
    await surface.dispatch('app_build', { ask: LINE }, ctx({ surfaceHitlChannels: [channel(false)] }));
    const bypass = { command: 'tailscale serve 3000' };
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, ctx())).toMatchObject({ code: 'APP_BUILD_DECLINED_BYPASS_REFUSED' });
    expect(await surface.dispatch('Bash', bypass, ctx())).toMatchObject({ code: 'APP_BUILD_DECLINED_BYPASS_REFUSED' });
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, ctx({}, 'm2'))).toBeNull();
  });
});

describe('daemon chat turn — decline guard lifetime and keys', () => {
  const bypass = { command: 'tailscale serve 3000' };
  const REFUSED = { code: 'APP_BUILD_DECLINED_BYPASS_REFUSED' };

  test('an armed guard expires after the TTL (fake clock)', async () => {
    let clock = 1_000;
    const surface = daemonChat([], undefined, () => clock);
    await surface.dispatch('app_build', { ask: LINE }, ctx({ surfaceHitlChannels: [channel(false)] }));
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, ctx())).toMatchObject(REFUSED);
    clock += APP_BUILD_DECLINE_GUARD_TTL_MS - 1;
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, ctx())).toMatchObject(REFUSED);
    clock += 1;
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, ctx())).toBeNull();
    expect(appBuildDeclineGuardCount()).toBe(0);
  });

  test('expired guards of other sessions are swept when a new one is armed', async () => {
    let clock = 1_000;
    const surface = daemonChat([], undefined, () => clock);
    await surface.dispatch('app_build', { ask: LINE }, ctx({ surfaceHitlChannels: [channel(false)] }, 'm1'));
    clock += APP_BUILD_DECLINE_GUARD_TTL_MS;
    await surface.dispatch('app_build', { ask: LINE }, ctx({ surfaceHitlChannels: [channel(false)] }, 'm2'));
    expect(appBuildDeclineGuardCount()).toBe(1);
  });

  test('session end (the daemon session store forgets it) drops that session\'s guard', async () => {
    const surface = daemonChat([]);
    await surface.dispatch('app_build', { ask: LINE }, ctx({ surfaceHitlChannels: [channel(false)] }));
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, ctx())).toMatchObject(REFUSED);
    new DaemonSessionHistory().forget('s-m1');
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, ctx())).toBeNull();
    expect(appBuildDeclineGuardCount()).toBe(0);
  });

  test('without a sessionId the guard is keyed by verified owner: one member\'s refusal never blocks another', async () => {
    const surface = daemonChat([]);
    const noSession = (memberId: string) => ctx({ sessionId: undefined }, memberId);
    await surface.dispatch('app_build', { ask: LINE },
      ctx({ sessionId: undefined, surfaceHitlChannels: [channel(false)] }, 'm1'));
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, noSession('m1'))).toMatchObject(REFUSED);
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, noSession('m2'))).toBeNull();
    // With neither a session nor an owner there is no key, so nothing is shared.
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, ctx({ sessionId: undefined, verifiedOwner: undefined }))).toBeNull();
  });

  test('a denied route tool is not dispatchable on the member surface', async () => {
    const surface = daemonChat([]);
    for (const denied of ['app_create', 'scrap_add', 'brief_today', 'gcp_architect_expand']) {
      await expect(surface.dispatch(denied, {}, ctx())).rejects.toThrow(ToolSafetyError);
    }
  });
});

describe('daemon chat turn — hold is not refusal, and the turn signal reaches the graph', () => {
  const bypass = { command: 'tailscale serve 3000' };

  test('no channel (unavailable) still refuses app_build but does not arm the decline guard', async () => {
    const surface = daemonChat([]);
    const result = await surface.dispatch('app_build', { ask: LINE }, ctx());
    expect((result as { code?: string }).code).toBe(APP_BUILD_DECLINED_CODE);
    expect(appBuildDeclineGuardCount()).toBe(0);
    expect(refuseBypassAfterAppBuildDecline('Bash', bypass, ctx())).toBeNull();
  });

  test('a cancelled web-chat turn ends the approval wait as turn-cancelled: no graph run, no guard', async () => {
    const calls: GraphCall[] = [];
    const surface = daemonChat(calls);
    const turn = new AbortController();
    // The channel only answers once the turn is cancelled (and then «no»): the cancel must win.
    const pending: ConfirmChannel = {
      name: 'pwa',
      request: () => new Promise((resolve) => turn.signal.addEventListener('abort', () => resolve(false), { once: true })),
      cancel: () => {},
    };
    const dispatched = surface.dispatch('app_build', { ask: LINE },
      ctx({ signal: turn.signal, surfaceHitlChannels: [pending] }));
    await Promise.resolve();
    turn.abort();
    const result = await dispatched;
    expect((result as { code?: string }).code).toBe(APP_BUILD_DECLINED_CODE);
    expect(calls).toEqual([]);
    expect(appBuildDeclineGuardCount()).toBe(0);
  });

  test('the turn signal is the graph dispatch signal', async () => {
    const turn = new AbortController();
    let seen: AbortSignal | undefined;
    resetDaemonPluginRoutesForTest((options) => createChildPluginRoutes({
      ...options,
      dispatchGraph: async (_pluginId, graphId, _graphFile, _args, context) => {
        seen = context?.signal;
        return { graphId, status: 'completed' };
      },
    }));
    await toolSurface('chat', financeOff).dispatch('app_build', { ask: LINE },
      ctx({ signal: turn.signal, surfaceHitlChannels: [channel(true)] }));
    expect(seen).toBe(turn.signal);
  });
});

describe('daemon chat turn — route registry failures', () => {
  test('a registry read failure keeps the rest of the surface and recovers on the next assembly', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      resetDaemonPluginRoutesForTest(() => { throw new Error('manifest unreadable'); });
      const names = toolSurface('chat', financeOff).specs.map((spec) => spec.name);
      expect(names).toContain('app_deploy');
      // Shared-catalog decision: a registry read failure cannot unexpose app_build (fail-closed lives in dispatch).
      expect(names).toContain('app_build');
      expect(log.mock.calls.some(([category, event]) =>
        category === 'capability.resolve' && event === 'daemon-plugin-routes-unavailable')).toBe(true);
      resetDaemonPluginRoutesForTest();
      expect(toolSurface('chat', financeOff).specs.map((spec) => spec.name)).toContain('app_build');
    } finally {
      log.mockRestore();
    }
  });

  test('a host without the app-build plugin still exposes the shared app_build name and fails the dispatch closed', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tc-dat-plugins-'));
    const calls: GraphCall[] = [];
    try {
      const surface = daemonChat(calls, empty);
      // Shared-catalog decision: the name stays exposed even with no plugin registered under pluginRoot.
      expect(surface.specs.map((spec) => spec.name)).toContain('app_build');
      const result = await surface.dispatch('app_build', { ask: LINE }, ctx());
      expect(result).toMatchObject({
        kind: 'app-build', status: 'failed', buildComplete: false, error: 'unknown tool "app_build"',
      });
      expect(calls).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
