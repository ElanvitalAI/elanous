import type { GraphCapabilityRegistry } from '../capabilities.js';
import {
  createAppBuildPublishApprovalProvider, createAppBuildPublishApprovalTransport,
  type ApprovalTransport,
} from '../capability-providers/app-build-publish-approval.js';

const CONTRACT = 'app-build.publish-approval@1';

/** Only a trusted terminal I/O failure after a verified pending response is retryable. */
export class ApprovalPresentationUnavailableError extends Error {}

/** Bind the ordinary graph's approval node to one authenticated local CLI window. */
export function withCliAppBuildApprovalProvider(registry: GraphCapabilityRegistry, options: {
  ownerId: string;
  runId: string;
  appSlug: string;
  signal: AbortSignal;
  presentUrl: (url: string, expiresAt: string) => Promise<void> | void;
  transport?: ApprovalTransport;
  now?: () => number;
  resumePendingExpiresAt?: string;
  pollIntervalMsForTesting?: number;
}): GraphCapabilityRegistry {
  if (!registry.contracts[CONTRACT] || registry.providers.filter(provider => provider.provides.includes(CONTRACT)).length !== 1
    || !options.ownerId || !options.runId || !options.appSlug || !(options.signal instanceof AbortSignal))
    throw new Error('app-build approval provider is not available');
  const now = options.now ?? Date.now;
  const resumeDeadline = options.resumePendingExpiresAt === undefined ? undefined
    : Date.parse(options.resumePendingExpiresAt);
  if (options.resumePendingExpiresAt !== undefined && (!Number.isFinite(resumeDeadline)
    || resumeDeadline! <= now())) throw new Error('pending owner approval expired');
  const transport = options.transport ?? createAppBuildPublishApprovalTransport();
  const invoke = async (context: Parameters<ReturnType<typeof createAppBuildPublishApprovalProvider>>[0]) => {
    const row = context.nodeInput && typeof context.nodeInput === 'object' && !Array.isArray(context.nodeInput)
      ? context.nodeInput as Record<string, unknown> : {};
    if (context.runId !== options.runId || row.appSlug !== options.appSlug || row.requireOwner !== options.ownerId)
      return { ok: false, outcome: 'failed' as const, error: 'owner approval binding changed' };
    let presentationRetryExpiry: string | undefined;
    const replacement = createAppBuildPublishApprovalProvider({
    transport: async (action, appSlug, runId, ownerId, signal) => {
      if (resumeDeadline === undefined) return transport(action, appSlug, runId, ownerId, signal);
      if (now() >= resumeDeadline || action === 'approval-start' && ownerId !== options.ownerId)
        throw new Error('pending owner approval expired or changed');
      const value = await transport('approval-poll', appSlug, runId, ownerId, signal);
      if (value.status === 'approval-pending' && value.pendingExpiresAt !== options.resumePendingExpiresAt)
        throw new Error('pending owner approval changed');
      return value;
    },
    presentApprovalUrl: async (owner, url, expiresAt, childSignal) => {
      if (owner !== options.ownerId || options.signal.aborted || childSignal?.aborted)
        throw new Error('approval owner changed');
      try { await options.presentUrl(url, expiresAt); }
      catch (error) {
        if (error instanceof ApprovalPresentationUnavailableError && !options.signal.aborted && !childSignal?.aborted
          && now() < Date.parse(expiresAt)) presentationRetryExpiry = expiresAt;
        throw error;
      }
    },
    trustedWindow: context => {
      if (context.verifiedOwnerId !== options.ownerId || options.signal.aborted
        || !(context.signal instanceof AbortSignal) || context.signal.aborted)
        throw new Error('approval owner or CLI window changed');
      return { signal: context.signal, deadlineAtMs: Math.min(now() + 4 * 60_000,
        resumeDeadline ?? Number.POSITIVE_INFINITY) };
    },
    pollIntervalMsForTesting: options.pollIntervalMsForTesting,
    });
    // Contract dispatch omits a child signal when this declaration has no preconditions.
    // Bind either form to the CLI parent so cancellation persists through the approval visit.
    const effectiveContext = { ...context,
      signal: context.signal ? AbortSignal.any([options.signal, context.signal]) : options.signal,
      ...(resumeDeadline === undefined ? {} : { nodeInput: { ...row, action: 'poll' } }) };
    const result = await replacement(effectiveContext);
    return presentationRetryExpiry && result.ok === false
      ? { ...result, error: `APP_BUILD_APPROVAL_PRESENTATION_RETRYABLE:${presentationRetryExpiry}` }
      : result;
  };
  return { ...registry, providers: registry.providers.map(provider => provider.provides.includes(CONTRACT)
    ? { ...provider, invoke } : provider) };
}
