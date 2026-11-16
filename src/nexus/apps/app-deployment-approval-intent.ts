import type { TuiMemberSession } from '../../tui/member-session-contract.js';

const ORIGIN = 'https://api.elanous.ai';
const PATH = '/v1/members/deployment-approvals';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEPLOYMENT = /^dyn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEAD = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const RUN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/u;
function refuse(): never { throw new Error('DEPLOYMENT_APPROVAL_REFUSED'); }

export interface DeploymentApprovalIntentBinding {
  readonly memberId: string; readonly appSlug: string; readonly runId: string;
  readonly deploymentId: string; readonly sourceHead: string; readonly artifactDigest: string;
  readonly relayKeyId: string; readonly expiresAt: string;
}
export interface PendingDeploymentApproval {
  readonly approvalId: string; readonly approvalUrl: string; readonly pendingExpiresAt: string;
}
export interface DeploymentApprovalProvider {
  start(binding: DeploymentApprovalIntentBinding, signal?: AbortSignal): Promise<PendingDeploymentApproval>;
  poll(binding: DeploymentApprovalIntentBinding, pending: PendingDeploymentApproval,
    signal?: AbortSignal): Promise<{ status: 'pending' } | { status: 'approved'; expiresAt: string }>;
}

/** Native APS only. The browser confirms independently; this adapter never calls approve. */
export function createAppDeploymentApprovalProvider(options: {
  getSession: () => TuiMemberSession | undefined; fetcher?: typeof fetch; now?: () => number;
}): DeploymentApprovalProvider {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const sessionFor = (appSlug: string) => {
    const session = options.getSession();
    if (session?.nexusUrl !== ORIGIN || session.appSlug !== appSlug
      || !/^aps_[A-Za-z0-9_-]+$/u.test(session.sessionToken)) refuse();
    return session;
  };
  const checked = (binding: DeploymentApprovalIntentBinding) => {
    if (!binding.memberId || !SLUG.test(binding.appSlug) || !RUN.test(binding.runId)
      || !DEPLOYMENT.test(binding.deploymentId) || !HEAD.test(binding.sourceHead)
      || !DIGEST.test(binding.artifactDigest) || !UUID.test(binding.relayKeyId)
      || !Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) <= now()) refuse();
  };
  const read = async (response: Response, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const reader = response.body?.getReader(); if (!reader) refuse();
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) {
      if (signal.aborted) refuse();
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const aborted = () => { signal.removeEventListener('abort', aborted); reject(new Error('approval response expired')); };
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) { aborted(); return; }
        reader.read().then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
          error => { signal.removeEventListener('abort', aborted); reject(error); });
      });
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) { void reader.cancel(); refuse(); }
      chunks.push(part.value);
    } } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { try { reader.releaseLock(); } catch { /* cancelled read */ } }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
    return value as Record<string, unknown>;
  };
  const signalFor = (parent?: AbortSignal) => parent
    ? AbortSignal.any([parent, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000);
  return {
    async start(binding, signal) {
      checked(binding);
      const session = sessionFor(binding.appSlug);
      const deadline = signalFor(signal);
      const response = await fetcher(ORIGIN + PATH + '/intents', {
        method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: deadline,
        headers: { authorization: 'Bearer ' + session.sessionToken,
          'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appSlug: binding.appSlug, runId: binding.runId,
          deploymentId: binding.deploymentId, sourceHead: binding.sourceHead,
          artifactDigest: binding.artifactDigest, relayKeyId: binding.relayKeyId,
          expiresAt: binding.expiresAt }),
      });
      if (response.status !== 201) { await response.body?.cancel(); refuse(); }
      const row = await read(response, deadline);
      if (typeof row.approvalId !== 'string' || !UUID.test(row.approvalId)
        || row.approvalUrl !== ORIGIN + PATH + '/' + row.approvalId
        || typeof row.pendingExpiresAt !== 'string'
        || !Number.isFinite(Date.parse(row.pendingExpiresAt))
        || Date.parse(row.pendingExpiresAt) <= now()
        || Date.parse(row.pendingExpiresAt) > now() + 5 * 60_000) refuse();
      return { approvalId: row.approvalId, approvalUrl: row.approvalUrl as string,
        pendingExpiresAt: row.pendingExpiresAt };
    },
    async poll(binding, pending, signal) {
      checked(binding);
      if (!UUID.test(pending.approvalId) || pending.approvalUrl !== ORIGIN + PATH + '/' + pending.approvalId
        || !Number.isFinite(Date.parse(pending.pendingExpiresAt))
        || Date.parse(pending.pendingExpiresAt) <= now()) refuse();
      const session = sessionFor(binding.appSlug);
      const deadline = signalFor(signal);
      const response = await fetcher(ORIGIN + PATH + '/intents/' + pending.approvalId + '/poll', {
        method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: deadline,
        headers: { authorization: 'Bearer ' + session.sessionToken, accept: 'application/json' },
      });
      if (response.status === 403 || response.status === 410) { await response.body?.cancel(); refuse(); }
      if (response.status !== 202 && response.status !== 200) { await response.body?.cancel(); refuse(); }
      const row = await read(response, deadline);
      if (response.status === 202) {
        if (row.status !== 'pending' || row.pendingExpiresAt !== pending.pendingExpiresAt) refuse();
        return { status: 'pending' };
      }
      if (row.approvalId !== pending.approvalId || row.memberId !== binding.memberId
        || row.appSlug !== binding.appSlug || row.runId !== binding.runId
        || row.deploymentId !== binding.deploymentId || row.sourceHead !== binding.sourceHead
        || row.artifactDigest !== binding.artifactDigest || row.relayKeyId !== binding.relayKeyId
        || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))
        || Date.parse(row.expiresAt) <= now()
        || Date.parse(row.expiresAt) > Date.parse(binding.expiresAt)) refuse();
      return { status: 'approved', expiresAt: row.expiresAt };
    },
  };
}
