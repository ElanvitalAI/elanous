import { registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration, type GraphCapabilityRegistry } from '../capabilities.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { readTuiMemberSession, tuiMemberSessionPath, type TuiMemberSession } from '../../tui/member-session-contract.js';
import type { GeneratedPublishRequest } from '../../nexus/apps/generated-app-publish.js';

export interface AppPublishTransport {
  (appSlug: string, request: GeneratedPublishRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
function row(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Private SDK session is host configuration, never a graph argument or serialized secret. */
export function createAppPublishTransport(
  getSession: () => TuiMemberSession | undefined = () => readTuiMemberSession(
    tuiMemberSessionPath(getElanousConfigDir(), process.env.ELANOUS_MEMBER_SESSION_FILE)),
  fetcher: typeof fetch = fetch,
): AppPublishTransport {
  return async (slug, request, signal) => {
    const session = getSession();
    if (!session) throw new Error('member app session unavailable');
    const endpoint = new URL('/v1/apps/' + encodeURIComponent(slug) + '/generated-deployment', session.nexusUrl);
    const response = await fetcher(endpoint, {
      method: 'POST', credentials: 'omit', redirect: 'manual',
      headers: { authorization: 'Bearer ' + session.sessionToken, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('member app operation refused');
    const value = row(await response.json());
    if (!['simulated', 'published', 'undone'].includes(String(value.status))) throw new Error('invalid app operation receipt');
    return value;
  };
}
export function registerAppPublishProvider(registry: GraphCapabilityRegistry,
  transport: AppPublishTransport = createAppPublishTransport()): GraphCapabilityRegistry {
  let result = registry;
  for (const id of ['app.publish@1', 'app-publish.action@1'] as const) result = registerGraphCapabilityContract(result, {
    id, input: { type: 'object', required: ['action'], properties: { action: { type: 'string' }, artifact: { type: 'object' } } },
    output: { type: 'object', properties: { status: { type: 'string' }, resultUrl: { type: 'string' } } },
  });
  return registerGraphCapabilityProviderDeclaration(result, {
    id: 'nexus-member-app-publish', provides: ['app.publish@1', 'app-publish.action@1'], tier: 'free',
    async invoke(context) {
      const owner = context.verifiedOwnerId;
      const graphOwner = row(row(context.graphInput ?? context.input).context).memberId;
      const input = row(context.nodeInput ?? context.input);
      const artifact = row(input.artifact);
      const action = input.action;
      const slug = row(artifact.manifest).slug ?? input.appSlug;
      if (!owner || graphOwner !== owner || input.requireOwner !== owner
        || typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)
        || !['simulate', 'publish', 'undo'].includes(String(action))
        || action !== 'undo' && (artifact.ownerId !== owner || artifact.runId !== context.runId)
        || action === 'publish' && (!input.requirePassingReceipt || typeof input.receipt !== 'string')) {
        return { ok: false, outcome: 'failed', error: 'verified member app artifact required' };
      }
      try {
        const request: GeneratedPublishRequest = {
          action: action as GeneratedPublishRequest['action'],
          runId: action === 'undo' ? String(input.deploymentRunId ?? '') : context.runId,
          ...(action !== 'undo' ? { artifact } : {}),
          ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
          ...(input.deploymentId !== undefined ? { deploymentId: input.deploymentId } : {}),
        };
        const value = await transport(slug, request, context.signal);
        return { ok: true, outcome: 'done', result: value, evidence: {
          ...(value.receipt ? { receipt: value.receipt } : {}),
          ...(value.deploymentId ? { deploymentId: value.deploymentId } : {}),
          runId: request.runId, scope: value.scope,
        } };
      } catch { return { ok: false, outcome: 'failed', error: 'member app publication unavailable or refused' }; }
    },
  });
}
