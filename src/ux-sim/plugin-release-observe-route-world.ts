import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePluginManifest } from '../plugins/core/manifest.js';
import {
  buildToolRouteIndex,
  dispatchToolRoute,
  routeToolIntentWithFallback,
  type SafeToolRouteDecision,
} from '../tool-router/index.js';

export interface PluginReleaseObserveRouteSimulation {
  ok: boolean;
  scenarios: {
    primaryRoutes: {
      releaseStatus: SafeToolRouteDecision;
      observeLogs: SafeToolRouteDecision;
    };
    releaseStart: SafeToolRouteDecision & {
      confirmationRequired: boolean;
      handlerCallsBeforeConfirmation: number;
      handlerCallsAfterConfirmation: number;
      blockedBeforeConfirmation: boolean;
      dispatchedAfterConfirmation: boolean;
    };
    ordinaryHelp: SafeToolRouteDecision;
    disabledObservePlugin: SafeToolRouteDecision;
    routerFailure: SafeToolRouteDecision;
  };
}

/** Route and dispatch-gate simulation with an injected handler; it never invokes a plugin handler. */
export function runPluginReleaseObserveRouteSimulation(repoRoot = process.cwd()): PluginReleaseObserveRouteSimulation {
  const sources = ['elanous-release', 'elanous-observe'].map((pluginId) => {
    const path = join(repoRoot, 'plugins', pluginId, 'plugin.json');
    const manifest = parsePluginManifest(JSON.parse(readFileSync(path, 'utf8')));
    return { pluginId: manifest.id, tools: manifest.contributes.aiTools ?? [] };
  });
  const loadIndex = () => buildToolRouteIndex(sources);
  const allEnabledPluginIds = new Set(sources.map(({ pluginId }) => pluginId));
  const run = (query: string, enabledPluginIds: ReadonlySet<string> = allEnabledPluginIds) => routeToolIntentWithFallback(
    query,
    loadIndex,
    { enabledPluginIds },
  );

  const releaseStatus = run('0.3.8 발행 준비 어디까지 됐어?');
  const observeLogs = run('로그 보여줘');
  const startMatch = run('발행 시작해');
  let handlerCalls = 0;
  const blockedDispatch = startMatch.matches[0]
    ? dispatchToolRoute(startMatch.matches[0], false, () => { handlerCalls += 1; })
    : { status: 'confirmation-required' as const, confirmationRequired: true as const };
  const handlerCallsBeforeConfirmation = handlerCalls;
  const approvedDispatch = startMatch.matches[0]
    ? dispatchToolRoute(startMatch.matches[0], true, () => { handlerCalls += 1; })
    : { status: 'confirmation-required' as const, confirmationRequired: true as const };
  const handlerCallsAfterConfirmation = handlerCalls - handlerCallsBeforeConfirmation;
  const releaseStart = {
    ...startMatch,
    confirmationRequired: startMatch.matches[0]?.route.requiresConfirm === true,
    handlerCallsBeforeConfirmation,
    handlerCallsAfterConfirmation,
    blockedBeforeConfirmation: blockedDispatch.status === 'confirmation-required',
    dispatchedAfterConfirmation: approvedDispatch.status === 'dispatched',
  };
  const ordinaryHelp = run('show me how to bake a cake');
  const disabledObservePlugin = run('로그 보여줘', new Set(['elanous-release']));
  const routerFailure = routeToolIntentWithFallback(
    '로그 보여줘',
    () => { throw new Error('simulated index failure'); },
    { enabledPluginIds: new Set(['elanous-release']) },
  );
  const primaryRoutes = { releaseStatus, observeLogs };
  const scenarios = { primaryRoutes, releaseStart, ordinaryHelp, disabledObservePlugin, routerFailure };

  return {
    ok: releaseStatus.matches[0]?.name === 'ReleaseStatus'
      && observeLogs.matches[0]?.name === 'ObserveLogs'
      && releaseStart.matches[0]?.name === 'ReleaseGraphStart'
      && releaseStart.confirmationRequired
      && releaseStart.blockedBeforeConfirmation
      && releaseStart.handlerCallsBeforeConfirmation === 0
      && releaseStart.handlerCallsAfterConfirmation === 1
      && releaseStart.dispatchedAfterConfirmation
      && ordinaryHelp.miss
      && disabledObservePlugin.miss
      && routerFailure.mode === 'native-all'
      && routerFailure.fallbackReason === 'router-error'
      && routerFailure.enabledPluginIds?.join(',') === 'elanous-release',
    scenarios,
  };
}
