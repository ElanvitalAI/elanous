import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { parsePluginManifest } from '../plugins/core/manifest.js';
import { runRegisteredAppSimulation } from '../nexus/apps/app-simulation-runner.js';
import type { AppSimulationResult } from '../nexus/apps/app-simulation.js';
import { requestConfirmation } from '../hitl/confirm.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { resolveAppDeploymentOwner } from '../nexus/apps/app-deployment-owner.js';
import type { AppLifecycleEventInput } from '../nexus/apps/app-lifecycle-ledger.js';
import { verifiedAppDeploymentUrl } from '../nexus/apps/app-publish.js';

export type AppDeployOutput = {
  kind: 'site-deploy';
  status: 'simulated' | 'published' | 'rejected' | 'failed';
  publicUrl?: string;
  simulationReceipt?: string;
  error?: string;
};

export interface AppDeployPublishHook {
  publish(input: { appId: 'lecture-scrap'; ownerUserId: string; simulationReceipt: string; owner: NonNullable<ToolRuntimeContext['appDeploymentOwner']> }): Promise<{ publicUrl: string }>;
  verifyPublicUrl(publicUrl: string): Promise<boolean>;
}

export interface AppDeployUpgradeInput {
  readonly appId: string;
  /** Existing application source target; the hook must edit only an isolated copy. */
  readonly target: string;
  readonly requestText: string;
  readonly ownerUserId: string;
}

export interface AppDeployUpgradeWorkspace {
  readonly sourceRoot: string;
  readonly previousVersion: string;
  readonly publicUrl: string;
  readonly cleanup: () => void | Promise<void>;
}

/** Transaction boundary installed by the Nexus app owner; fake app worlds inject the same operations. */
export interface AppDeployUpgradeHook {
  prepare(input: AppDeployUpgradeInput): Promise<AppDeployUpgradeWorkspace>;
  applyChange(input: AppDeployUpgradeInput & { readonly sourceRoot: string }): Promise<void>;
  simulate(input: AppDeployUpgradeInput & { readonly sourceRoot: string }): Promise<AppSimulationResult>;
  publish(input: AppDeployUpgradeInput & {
    readonly sourceRoot: string;
    readonly previousVersion: string;
    readonly publicUrl: string;
    readonly simulationReceipt: string;
  }): Promise<{ publicUrl: string; version: string; fingerprint?: string }>;
  verifyPublicUrl(publicUrl: string): Promise<boolean>;
  rollback(input: AppDeployUpgradeInput & {
    readonly publicUrl: string;
    readonly previousVersion: string;
    readonly failedVersion?: string;
  }): Promise<void>;
  recordLifecycle(input: AppLifecycleEventInput): Promise<void> | void;
}

let publishHook: AppDeployPublishHook | undefined;
let upgradeHook: AppDeployUpgradeHook | undefined;

/** Installed by the Nexus app lifecycle owner; absent until its public-root publish seam lands. */
export function setAppDeployPublishHook(hook: AppDeployPublishHook | undefined): void {
  publishHook = hook;
}

/** Installed by the app lifecycle owner; an upgrade never falls back to mutating the live source tree. */
export function setAppDeployUpgradeHook(hook: AppDeployUpgradeHook | undefined): void {
  upgradeHook = hook;
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
  const hook = deps.hook ?? context?.appDeployPublishHook ?? publishHook;
  if (!hook) return { kind: 'site-deploy', status: 'simulated', simulationReceipt: receiptId };
  const memberOwner = context?.appDeploymentOwner;
  if (context?.requestOrigin === 'external-agent' || context?.appDeploymentSession !== 'nexus-owner'
    || !context?.verifiedOwner?.id || !memberOwner || context.verifiedOwner.id !== memberOwner.memberId
    || memberOwner.appSlug !== 'lecture-scrap'
    || !context?.confirmChannels?.length) {
    return { kind: 'site-deploy', status: 'rejected', simulationReceipt: receiptId, error: 'verified owner and originating confirmation channel are required' };
  }
  let ownerUserId: string;
  try {
    ownerUserId = (deps.resolveOwner ?? (() => resolveAppDeploymentOwner('member', undefined, memberOwner)))();
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
    const published = await hook.publish({ appId: 'lecture-scrap', ownerUserId, simulationReceipt: receiptId, owner: memberOwner });
    const publicUrl = verifiedAppDeploymentUrl('lecture-scrap', ownerUserId, published.publicUrl);
    if (!await hook.verifyPublicUrl(publicUrl)) throw new Error('public app URL did not open');
    return { kind: 'site-deploy', status: 'published', publicUrl, simulationReceipt: receiptId };
  } catch (error) {
    return { kind: 'site-deploy', status: 'failed', simulationReceipt: receiptId, error: error instanceof Error ? error.message : String(error) };
  }
}

function validUpgradePublicUrl(value: string, appId: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && new RegExp(`^${appId}--[a-z0-9-]+\\.elanous\\.app$`).test(url.hostname)
      && !url.username && !url.password && !url.port && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash;
  } catch { return false; }
}

function passedUpgradeReceipt(simulation: AppSimulationResult, appId: string): string | undefined {
  const receipt = simulation.receipts.find(item => item.appId === appId && item.outcome === 'passed');
  if (!receipt || simulation.receipts.some(item => item.appId === appId && item.outcome === 'failed')) return undefined;
  return receipt.id;
}

function isolatedSourcePaths(target: string, sourceRoot: string): boolean {
  try {
    const live = realpathSync(target);
    const staged = realpathSync(sourceRoot);
    const contains = (parent: string, candidate: string) => {
      const rel = relative(parent, candidate);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    return !contains(live, staged) && !contains(staged, live);
  } catch { return false; }
}

/** Existing-app feature upgrade: isolated source → change → simulation → same-origin publish → rollback on any failed commit. */
export async function runAppDeployUpgrade(
  input: AppDeployUpgradeInput,
): Promise<AppDeployOutput> {
  if (typeof input.appId !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.appId)
    || typeof input.target !== 'string' || !input.target.trim() || input.target.length > 2_048
    || typeof input.requestText !== 'string' || !input.requestText.trim() || input.requestText.length > 10_000
    || typeof input.ownerUserId !== 'string' || !input.ownerUserId.trim() || input.ownerUserId.length > 256) {
    return { kind: 'site-deploy', status: 'failed', error: 'invalid app upgrade input' };
  }
  const hook = upgradeHook;
  if (!hook) return { kind: 'site-deploy', status: 'failed', error: 'app upgrade runtime unavailable' };

  let workspace: AppDeployUpgradeWorkspace | undefined;
  let receiptId: string | undefined;
  let attemptedVersion: string | undefined;
  let publishAttempted = false;
  let rollbackFailed = false;
  let failureReason: 'simulation-failed' | 'operation-failed' = 'operation-failed';
  try {
    workspace = await hook.prepare(input);
    if (!workspace.sourceRoot || !isolatedSourcePaths(input.target, workspace.sourceRoot) || !workspace.previousVersion
      || !validUpgradePublicUrl(workspace.publicUrl, input.appId)) throw new Error('invalid app upgrade workspace');

    await hook.applyChange({ ...input, sourceRoot: workspace.sourceRoot });
    failureReason = 'simulation-failed';
    const simulation = await hook.simulate({ ...input, sourceRoot: workspace.sourceRoot });
    receiptId = passedUpgradeReceipt(simulation, input.appId);
    if (!receiptId) throw new Error('app upgrade simulation did not pass');

    failureReason = 'operation-failed';
    publishAttempted = true;
    const published = await hook.publish({ ...input, sourceRoot: workspace.sourceRoot,
      previousVersion: workspace.previousVersion, publicUrl: workspace.publicUrl, simulationReceipt: receiptId });
    attemptedVersion = published.version;
    if (!attemptedVersion || attemptedVersion === workspace.previousVersion) throw new Error('app upgrade must publish a new version');
    if (published.publicUrl !== workspace.publicUrl) throw new Error('app upgrade must preserve the existing public URL');
    if (!validUpgradePublicUrl(published.publicUrl, input.appId)) throw new Error('app upgrade public URL is invalid');
    if (!await hook.verifyPublicUrl(workspace.publicUrl)) throw new Error('upgraded app public verification failed');

    await hook.recordLifecycle({ appId: input.appId, action: 'upgrade', environment: 'live', actor: 'user',
      outcome: 'succeeded', appVersion: attemptedVersion, ...(published.fingerprint ? { appFingerprint: published.fingerprint } : {}),
      receiptId, runId: simulation.runId });
    return { kind: 'site-deploy', status: 'published', publicUrl: workspace.publicUrl, simulationReceipt: receiptId };
  } catch (error) {
    if (publishAttempted && workspace) {
      try {
        await hook.rollback({ ...input, publicUrl: workspace.publicUrl, previousVersion: workspace.previousVersion,
          ...(attemptedVersion ? { failedVersion: attemptedVersion } : {}) });
        await hook.recordLifecycle({ appId: input.appId, action: 'rolled-back', environment: 'live', actor: 'system',
          outcome: 'succeeded', appVersion: workspace.previousVersion });
      } catch {
        rollbackFailed = true;
        try { await hook.recordLifecycle({ appId: input.appId, action: 'rolled-back', environment: 'live', actor: 'system',
          outcome: 'failed', ...(attemptedVersion ? { appVersion: attemptedVersion } : {}), reasonCode: 'operation-failed' }); }
        catch { /* preserve the failed-upgrade result when audit storage is unavailable */ }
      }
    }
    if (workspace) {
      try { await hook.recordLifecycle({ appId: input.appId, action: 'upgrade', environment: 'live', actor: 'user',
        outcome: 'failed', ...(receiptId ? { receiptId } : {}), ...(attemptedVersion ? { appVersion: attemptedVersion } : {}),
        reasonCode: failureReason }); } catch { /* keep the external failure result stable */ }
    }
    return { kind: 'site-deploy', status: 'failed', ...(receiptId ? { simulationReceipt: receiptId } : {}),
      error: rollbackFailed ? 'app upgrade failed and rollback failed; operator recovery is required'
        : error instanceof Error ? error.message : String(error) };
  } finally {
    if (workspace) { try { await workspace.cleanup(); } catch { /* isolated workspace cleanup is best effort */ } }
  }
}
