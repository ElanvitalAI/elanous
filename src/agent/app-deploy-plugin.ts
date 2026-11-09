import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { parsePluginManifest } from '../plugins/core/manifest.js';
import { runRegisteredAppSimulation } from '../nexus/apps/app-simulation-runner.js';
import type { AppSimulationResult } from '../nexus/apps/app-simulation.js';
import { requestConfirmation } from '../hitl/confirm.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { resolveAppDeploymentOwner } from '../nexus/apps/app-deployment-owner.js';

export type AppDeployOutput = {
  kind: 'site-deploy';
  status: 'simulated' | 'published' | 'rejected' | 'failed';
  publicUrl?: string;
  simulationReceipt?: string;
  error?: string;
};

export interface AppDeployPublishHook {
  publish(input: { appId: 'lecture-scrap'; ownerUserId: string; simulationReceipt: string }): Promise<{ publicUrl: string }>;
  verifyPublicUrl(publicUrl: string): Promise<boolean>;
}

let publishHook: AppDeployPublishHook | undefined;

/** Installed by the Nexus app lifecycle owner; absent until its public-root publish seam lands. */
export function setAppDeployPublishHook(hook: AppDeployPublishHook | undefined): void {
  publishHook = hook;
}

const manifestPath = resolve(import.meta.dir, '../../plugins/elanous-app-deploy/plugin.json');

export function appDeployPluginSpec(): LLMToolSpec {
  const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const tool = manifest.contributes.aiTools?.find(item => item.name === 'app_deploy');
  if (!tool?.route) throw new Error('app deploy plugin route is missing');
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: 'object', properties: {} },
    pluginId: manifest.id,
    route: tool.route,
  };
}

export async function runAppDeploy(
  args: Record<string, unknown>,
  context?: ToolRuntimeContext,
  deps: { simulate?: (appId: string) => Promise<AppSimulationResult>; hook?: AppDeployPublishHook; resolveOwner?: () => string } = {},
): Promise<AppDeployOutput> {
  if (args.appId !== 'lecture-scrap' || typeof args.requestText !== 'string' || !args.requestText.trim()) {
    return { kind: 'site-deploy', status: 'failed', error: 'registered lecture-scrap appId and requestText are required' };
  }
  let receiptId: string;
  try {
    const simulation = await (deps.simulate ?? runRegisteredAppSimulation)('lecture-scrap');
    const receipt = simulation.receipts.find(item => item.appId === 'lecture-scrap' && item.outcome === 'passed');
    if (!receipt || simulation.receipts.some(item => item.appId === 'lecture-scrap' && item.outcome === 'failed')) {
      return { kind: 'site-deploy', status: 'failed', error: 'app simulation did not pass' };
    }
    receiptId = receipt.id;
  } catch (error) {
    return { kind: 'site-deploy', status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  const hook = deps.hook ?? publishHook;
  if (!hook) return { kind: 'site-deploy', status: 'simulated', simulationReceipt: receiptId };
  if (context?.requestOrigin === 'external-agent' || context?.appDeploymentSession !== 'nexus-owner'
    || !context?.verifiedOwner?.id || !context?.confirmChannels?.length) {
    return { kind: 'site-deploy', status: 'rejected', simulationReceipt: receiptId, error: 'verified owner and originating confirmation channel are required' };
  }
  let ownerUserId: string;
  try {
    ownerUserId = (deps.resolveOwner ?? (() => resolveAppDeploymentOwner(context.appDeploymentSession!)))();
  } catch (error) {
    return { kind: 'site-deploy', status: 'rejected', simulationReceipt: receiptId, error: error instanceof Error ? error.message : String(error) };
  }
  const confirmation = await requestConfirmation({
    prompt: '강의 노트·스크랩 앱을 공개 배포할까요?',
    detail: `시뮬레이션 PASS · 영수증 ${receiptId}`,
    yesLabel: 'y', noLabel: 'N', header: '배포',
    channels: context.confirmChannels, onTimeout: () => false,
    requestId: `app-deploy-${receiptId}`,
  });
  if (!confirmation.answer) return { kind: 'site-deploy', status: 'rejected', simulationReceipt: receiptId };
  try {
    const published = await hook.publish({ appId: 'lecture-scrap', ownerUserId, simulationReceipt: receiptId });
    const url = new URL(published.publicUrl);
    if (url.protocol !== 'https:' || !/^lecture-scrap--[a-z0-9-]+\.elanous\.app$/.test(url.hostname)
      || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('public app URL is invalid');
    }
    if (!await hook.verifyPublicUrl(url.toString())) throw new Error('public app URL did not open');
    return { kind: 'site-deploy', status: 'published', publicUrl: url.toString(), simulationReceipt: receiptId };
  } catch (error) {
    return { kind: 'site-deploy', status: 'failed', simulationReceipt: receiptId, error: error instanceof Error ? error.message : String(error) };
  }
}
