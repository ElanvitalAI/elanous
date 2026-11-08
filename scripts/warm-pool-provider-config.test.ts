import { expect, test } from 'bun:test';
import { assembleWarmPoolProviderConfig, fetchMachinePoolDeclarationsFromNexus, requireAuthoritativeMachinePoolSource, runWarmPoolProviderConfig } from './warm-pool-provider-config.js';
import type { MachinePoolDeclaration } from '../src/resource-ledger/machine-pool-inventory.js';

const digest = 'sha256:' + 'a'.repeat(64);
const declaration: MachinePoolDeclaration = { purpose: 'gate', fanoutGroupId: 'gate-v1',
  members: [{ host: 'gcp1', count: 2, digest, role: 'both' }],
  fanoutGroup: { shard: { kind: 'gate', input: 'gate-shard', result: 'gate-result', fingerprint: 'runtime-env' } },
  fingerprint: { runtime: 'bun-test', environment: 'linux', skillPacks: [] }, cleanup: { procedure: 'clean-v1', verify: 'verify-v1' } };
const config = { pod: { warmPoolProfile: 'gate', warmPool: { namespace: 'test', imageRepository: 'registry.example/elanous',
  imageDigest: digest, baseImageDigest: 'sha256:' + 'f'.repeat(64), lockHash: 'b'.repeat(64), architecture: 'amd64', hostProbeUrl: 'http://host.orb.internal:10001/health',
  prodProbeUrl: 'http://core.elanous-prod:10002/', sourceUrl: 'https://github.com/ElanvitalAI/elanous.git',
  templates: [{ host: 'gcp1', tier: 'standard', nodeName: 'gcp1-node' }] } },
  harness: { imageCommit: 'c'.repeat(40), podPool: 'gcp1-context' } };

test('provider config uses machine-pool member count and digest for its purpose', () => {
  const assembled = assembleWarmPoolProviderConfig({ config, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) }, machinePools: [declaration] });
  expect(assembled.poolTemplates).toHaveLength(1);
  expect(assembled.poolTemplates[0]).toMatchObject({ host: 'gcp1', slotCount: 2, spec: { key: { imageDigest: digest } } });
});

test('provider config rejects pool members without a matching host or immutable digest', () => {
  expect(() => assembleWarmPoolProviderConfig({ config, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) },
    machinePools: [{ ...declaration, members: [{ ...declaration.members[0]!, host: 'aws1' }] }] })).toThrow('missing gate member');
  expect(() => assembleWarmPoolProviderConfig({ config, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) },
    machinePools: [{ ...declaration, members: [{ ...declaration.members[0]!, digest: 'sha256:' + 'f'.repeat(64) }] }] })).toThrow('digest mismatch');
  expect(() => assembleWarmPoolProviderConfig({ config, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) },
    machinePools: [{ ...declaration, members: [{ ...declaration.members[0]!, role: 'assigner' }] }] })).toThrow('cannot execute');
});

test('provider config keeps architecture matching exact unless an explicit supported allowlist is set', () => {
  const input = { config, controlUrl: 'https://control.example:8413', memberToken: 'd'.repeat(64),
    machineTokens: { gcp1: 'e'.repeat(64) }, machinePools: [declaration] };
  expect(assembleWarmPoolProviderConfig(input).allowedArchitectures).toBeUndefined();
  const multiArch = { ...config, pod: { ...config.pod, warmPool: {
    ...config.pod.warmPool, allowedArchitectures: ['amd64', 'arm64'],
  } } };
  expect(assembleWarmPoolProviderConfig({ ...input, config: multiArch }).allowedArchitectures).toEqual(['amd64', 'arm64']);
  const invalid = { ...multiArch, pod: { ...multiArch.pod, warmPool: {
    ...multiArch.pod.warmPool, allowedArchitectures: ['amd64', 'armv7'],
  } } };
  expect(() => assembleWarmPoolProviderConfig({ ...input, config: invalid }))
    .toThrow('pod.warmPool.allowedArchitectures must be a unique list of amd64 and/or arm64');
});


test('provider fetches declarations from the Nexus resource-ledger API', async () => {
  let authorization = '';
  const pools = await fetchMachinePoolDeclarationsFromNexus('https://nexus.example:8413/v1/ops/resources/ledger', 'test-token',
    (async (_input, init) => { authorization = String(init?.headers && (init.headers as Record<string, string>).authorization); return new Response(JSON.stringify({ pools: [declaration] }), { status: 200 }); }) as typeof fetch);
  expect(authorization).toBe('Bearer test-token');
  expect(pools).toEqual([declaration]);
});

test('provider merges purpose pool fragments for a host without consumer-order precedence', () => {
  const second = { ...declaration, fanoutGroupId: 'gate-map-v2', members: [{ ...declaration.members[0]!, count: 3 }] };
  const assembled = assembleWarmPoolProviderConfig({ config, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) }, machinePools: [declaration, second] });
  expect(assembled.poolTemplates[0]).toMatchObject({ slotCount: 5 });
});

test('provider config requires an authoritative pool declaration source', () => {
  expect(() => requireAuthoritativeMachinePoolSource()).toThrow('--resource-ledger-url is required');
  expect(() => requireAuthoritativeMachinePoolSource(undefined, '/tmp/machine-pools.yaml'))
    .toThrow('--resource-ledger-url is required');
  expect(() => requireAuthoritativeMachinePoolSource('https://nexus.example:8413', '/tmp/machine-pools.yaml')).not.toThrow();
});

test('provider divides one host declaration across tier templates exactly once', () => {
  const twoTemplates = { pod: { ...config.pod, warmPool: { ...config.pod.warmPool, templates: [
    { host: 'gcp1', tier: 'standard', nodeName: 'gcp1-node' },
    { host: 'gcp1', tier: 'lite', nodeName: 'gcp1-node' },
  ] } }, harness: config.harness };
  const assembled = assembleWarmPoolProviderConfig({ config: twoTemplates, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) },
    machinePools: [{ ...declaration, members: [{ ...declaration.members[0]!, count: 5 }] }] });
  expect(assembled.poolTemplates.map(row => row.slotCount)).toEqual([3, 2]);
});

test('provider CLI refuses template-only config without an authoritative Nexus URL', async () => {
  await expect(runWarmPoolProviderConfig(['--config', '/tmp/config.json',
    '--control-url', 'https://control.example:8413', '--member-token-file', '/tmp/member.token',
    '--machine-token', 'gcp1=/tmp/gcp1.token']))
    .rejects.toThrow('--resource-ledger-url is required');
});
