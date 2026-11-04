import type { ElanousPlugin, PluginContext } from '../../src/plugins/core/types.js';
import type { CloudBurstCommandRuntime } from './runtime-types.js';
import type { CloudBurstRequest, CloudBurstResult } from './service.js';
import { createMockCloudBurstRuntime } from './mock-runtime.js';

export const CLOUD_BURST_COMMAND = 'cloud-burst';

const credentialFlag = /^--[a-z0-9_-]*(?:access[-_]?key|api[-_]?key|bearer|client[-_]?secret|credential|password|private[-_]?key|secret|token)[a-z0-9_-]*(?:=|$)/i;
const requestOptions = new Set(['--request-id', '--account-ref', '--image-digest', '--ttl-minutes']);
const reportOptions = new Set(['--request-id']);

function hasCredentialArgument(args: readonly string[]): boolean {
  return args.some((arg, index) => credentialFlag.test(arg) || credentialFlag.test(args[index - 1] ?? ''));
}

function parseOptions(args: readonly string[], allowed: ReadonlySet<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith('--')) throw new Error('cloud-burst: invalid or incomplete option');
    if (options.has(key)) throw new Error(`cloud-burst: duplicate option ${key}`);
    options.set(key, value);
  }
  return options;
}

function parseRequest(args: readonly string[]): CloudBurstRequest {
  const options = parseOptions(args, requestOptions);
  const requestId = options.get('--request-id') ?? '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(requestId)) throw new Error('cloud-burst: request-id must be 1-64 safe identifier characters');
  const imageDigest = options.get('--image-digest') ?? '';
  if (!imageDigest) throw new Error('cloud-burst: image-digest is required');
  const ttlRaw = options.get('--ttl-minutes');
  if (!ttlRaw) throw new Error('cloud-burst: --ttl-minutes is required');
  const ttlMinutes = Number(ttlRaw);
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > Number.MAX_SAFE_INTEGER / 60_000) {
    throw new Error('cloud-burst: ttl-minutes must be positive and finite');
  }
  const accountRef = options.get('--account-ref');
  if (accountRef !== undefined && !/^[A-Za-z0-9._:/-]{1,128}$/.test(accountRef)) {
    throw new Error('cloud-burst: account-ref must be an opaque profile reference, not a credential');
  }
  return { requestId, ...(accountRef ? { accountRef } : {}), imageDigest, ttlMs: ttlMinutes * 60_000 };
}

function parseRequestId(args: readonly string[]): string {
  const id = parseOptions(args, reportOptions).get('--request-id') ?? '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error('cloud-burst: report requires a safe --request-id');
  return id;
}

function renderResult(result: CloudBurstResult): string {
  if (result.source === 'local') return `Cloud Burst local: ${result.resourceId}; expiresAt=${result.expiresAt}; estimatedCost=0`;
  return result.startReport;
}

export function createCloudBurstPlugin(liveRuntime?: CloudBurstCommandRuntime): ElanousPlugin<Record<string, never>> {
  const mockRuntime = createMockCloudBurstRuntime();
  return {
    name: 'cloud-burst',
    version: '0.1.0',
    description: 'Local-first, single-cloud burst orchestration with an explicit mock route.',
    initialState: () => ({}),
    panes: {},
    slashCommands: [{
      name: CLOUD_BURST_COMMAND,
      description: 'Simulate a local-first cloud burst or request live capacity through a connected provider adapter.',
      async handler(args: string[], ctx: PluginContext) {
        if (hasCredentialArgument(args)) {
          ctx.log('[cloud-burst] Do not pass credential values as command arguments; connect through the user-owned provider credential flow.');
          return;
        }
        const mock = args[0] === 'mock';
        const command = mock ? args[1] : args[0];
        const runtime = mock ? mockRuntime : liveRuntime;
        if (!runtime) {
          ctx.log('[cloud-burst] Live provider adapter is not connected. `/cloud-burst mock ...` runs only the deterministic local simulation.');
          return;
        }
        try {
          if (command === 'request') {
            const input = parseRequest(args.slice(mock ? 2 : 1));
            if (mock && input.accountRef) throw new Error('cloud-burst: mock mode does not accept account references');
            ctx.log(renderResult(await runtime.request(input)));
            return;
          }
          if (command === 'report') {
            const requestId = parseRequestId(args.slice(mock ? 2 : 1));
            ctx.log(await runtime.report(requestId));
            return;
          }
          ctx.log('usage: /cloud-burst mock request --request-id ID --image-digest sha256:… --ttl-minutes N | /cloud-burst mock report --request-id ID');
        }
        catch (error) {
          ctx.log(error instanceof Error ? error.message : 'cloud-burst: request failed');
        }
      },
    }],
  };
}

export default createCloudBurstPlugin();
