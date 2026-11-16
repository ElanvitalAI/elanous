import { registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityProvider, type GraphCapabilityRegistry } from '../capabilities.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { nexusRuntimePath } from '../../nexus/paths.js';
import { readLocalAppBuildIssuer } from '../../nexus/apps/app-build-local-bridge.js';
import { codeRevision } from '../../version/code-revision.js';
import { setTimeout as pause } from 'node:timers/promises';
import type { InProcessHandlerContext } from '../in-process-registry.js';
import { createSourceBuildRegistry } from './source-build.js';

export type ApprovalAction = 'approval-start' | 'approval-poll';
export type ApprovalTransport = (action: ApprovalAction, appSlug: string, runId: string,
  ownerId: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;
export type PresentApprovalUrl = (ownerId: string, approvalUrl: string,
  pendingExpiresAt: string, signal?: AbortSignal) => Promise<void>;
export type TrustedApprovalWindow = (context: InProcessHandlerContext) =>
  { signal: AbortSignal; deadlineAtMs: number };
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/u;
const URL_PREFIX = 'https://api.elanous.ai/v1/members/deployment-approvals/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function refuse(): never { throw new Error('APP_BUILD_PUBLISH_APPROVAL_REFUSED'); }
async function bounded<T>(signal: AbortSignal, invoke: () => Promise<T>): Promise<T> {
  if (signal.aborted) refuse();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('owner approval deadline'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) refuse();
      return invoke();
    }), aborted]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

/** Local bearer remains in host config; the bridge rechecks a fresh owner APS. */
export function createAppBuildPublishApprovalTransport(options: {
  configDir?: string; runtimePath?: string; sourceHead?: string; fetcher?: typeof fetch;
} = {}): ApprovalTransport {
  const configDir = options.configDir ?? getElanousConfigDir();
  const runtimePath = options.runtimePath ?? nexusRuntimePath();
  const sourceHead = options.sourceHead ?? codeRevision();
  const fetcher = options.fetcher ?? fetch;
  return async (action, appSlug, runId, ownerId, signal) => {
    if (!SLUG.test(appSlug) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(runId)
      || !ownerId || typeof sourceHead !== 'string' || !/^[a-f0-9]{40}$/u.test(sourceHead)) refuse();
    const local = readLocalAppBuildIssuer(configDir, runtimePath);
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000);
    const response = await fetcher(local.origin + '/v1/apps/' + appSlug + '/dynamic-deployment-local', {
      method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      signal: deadline,
      headers: { authorization: 'Bearer ' + local.token, 'content-type': 'application/json',
        'x-elanous-app-build-owner': ownerId, 'x-elanous-app-build-head': sourceHead },
      body: JSON.stringify({ action, runId }),
    });
    if (response.status !== 200) { await response.body?.cancel(); refuse(); }
    const reader = response.body?.getReader(); if (!reader) refuse();
    const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) {
      if (deadline.aborted) refuse();
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const aborted = () => { deadline.removeEventListener('abort', aborted); reject(new Error('approval bridge expired')); };
        deadline.addEventListener('abort', aborted, { once: true });
        if (deadline.aborted) { aborted(); return; }
        reader.read().then(value => { deadline.removeEventListener('abort', aborted); resolve(value); },
          error => { deadline.removeEventListener('abort', aborted); reject(error); });
      });
      if (part.done) break;
      length += part.value.byteLength; if (length > 4096) { void reader.cancel(); refuse(); }
      chunks.push(part.value);
    } } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { try { reader.releaseLock(); } catch { /* cancelled read */ } }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
    return value as Record<string, unknown>;
  };
}

/** The URL goes only to a trusted owner UI callback, never graph output/evidence. */
export function createAppBuildPublishApprovalProvider(options: {
  transport: ApprovalTransport; presentApprovalUrl?: PresentApprovalUrl;
  trustedWindow?: TrustedApprovalWindow;
  pollIntervalMsForTesting?: number;
}): GraphCapabilityProvider {
  const pollMs = options.pollIntervalMsForTesting ?? 1_000;
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60_000) refuse();
  return async context => {
    const input = context.nodeInput ?? context.input;
    const row = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown> : {};
    const ownerId = context.verifiedOwnerId;
    const original = context.graphInput ?? context.input;
    const graphContext = original && typeof original === 'object' && !Array.isArray(original)
      ? (original as Record<string, unknown>).context : undefined;
    const graphOwner = graphContext && typeof graphContext === 'object'
      ? (graphContext as Record<string, unknown>).memberId : undefined;
    const appSlug = row.appSlug;
    const action = row.action;
    let window: ReturnType<TrustedApprovalWindow> | undefined;
    try { window = options.trustedWindow?.(context); } catch { /* fail closed below */ }
    if (!ownerId || graphOwner !== ownerId || row.requireOwner !== ownerId
      || typeof appSlug !== 'string' || !SLUG.test(appSlug)
      || action !== 'start' && action !== 'poll'
      || Object.hasOwn(row, 'approvalId') || Object.hasOwn(row, 'approvalUrl')
      || !context.signal || context.signal.aborted || !window
      || !(window.signal instanceof AbortSignal) || window.signal !== context.signal
      || !Number.isSafeInteger(window.deadlineAtMs) || window.deadlineAtMs <= Date.now())
      return { ok: false, outcome: 'failed', error: 'verified owner approval required' };
    try {
      const hostSignal = AbortSignal.any([window.signal,
        AbortSignal.timeout(Math.max(1, window.deadlineAtMs - Date.now()))]);
      let value = await bounded(hostSignal, () => options.transport(action === 'start'
        ? 'approval-start' : 'approval-poll', appSlug, context.runId, ownerId, hostSignal));
      if (action === 'poll' && value.status === 'approval-approved')
        return { ok: true, outcome: 'done', result: { status: 'approved' } };
      if (value.status !== 'approval-pending' || typeof value.approvalUrl !== 'string'
        || !value.approvalUrl.startsWith(URL_PREFIX) || !UUID.test(value.approvalUrl.slice(URL_PREFIX.length))
        || typeof value.pendingExpiresAt !== 'string'
        || !Number.isFinite(Date.parse(value.pendingExpiresAt))
        || Date.parse(value.pendingExpiresAt) <= Date.now()
        || Date.parse(value.pendingExpiresAt) > Date.now() + 5 * 60_000
        || !options.presentApprovalUrl) refuse();
      const approvalUrl = value.approvalUrl;
      const pendingExpiresAt = value.pendingExpiresAt;
      const pendingDeadline = AbortSignal.timeout(Math.max(1, Date.parse(pendingExpiresAt) - Date.now()));
      const signal = AbortSignal.any([hostSignal, pendingDeadline]);
      await bounded(signal, () => options.presentApprovalUrl!(ownerId, approvalUrl, pendingExpiresAt, signal));
      while (!signal.aborted && Date.now() < Date.parse(pendingExpiresAt)) {
        await pause(pollMs, undefined, { signal });
        value = await bounded(signal, () => options.transport('approval-poll', appSlug, context.runId,
          ownerId, signal));
        if (signal.aborted) refuse();
        if (value.status === 'approval-approved')
          return { ok: true, outcome: 'done', result: { status: 'approved' } };
        if (value.status !== 'approval-pending' || value.approvalUrl !== approvalUrl
          || value.pendingExpiresAt !== pendingExpiresAt) refuse();
      }
      refuse();
    } catch { return { ok: false, outcome: 'failed', error: 'owner approval unavailable or refused' }; }
  };
}

export function registerAppBuildPublishApprovalProvider(registry: GraphCapabilityRegistry,
  options: { transport?: ApprovalTransport; presentApprovalUrl?: PresentApprovalUrl;
    trustedWindow?: TrustedApprovalWindow; pollIntervalMsForTesting?: number } = {}): GraphCapabilityRegistry {
  const withContract = registerGraphCapabilityContract(registry, { id: 'app-build.publish-approval@1',
    input: { type: 'object', required: ['action', 'appSlug', 'requireOwner'], properties: {
      action: { type: 'string', enum: ['start', 'poll'] }, appSlug: { type: 'string' }, requireOwner: { type: 'string' },
    } }, output: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } });
  return registerGraphCapabilityProviderDeclaration(withContract, { id: 'app-build-owner-publish-approval',
    provides: ['app-build.publish-approval@1'], tier: 'free',
    invoke: createAppBuildPublishApprovalProvider({ transport: options.transport
      ?? createAppBuildPublishApprovalTransport(), presentApprovalUrl: options.presentApprovalUrl,
      trustedWindow: options.trustedWindow,
      pollIntervalMsForTesting: options.pollIntervalMsForTesting }) });
}

/** Manifest factory for the ordinary app-build graph. The TUI binds the trusted
 * owner presenter and deadline before running it; this default refuses approval. */
export function createSourceBuildWithApprovalRegistry(): GraphCapabilityRegistry {
  return registerAppBuildPublishApprovalProvider(createSourceBuildRegistry());
}
