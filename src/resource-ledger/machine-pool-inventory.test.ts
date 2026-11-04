import { expect, test } from 'bun:test';
import { machinePoolCapacity, parseMachinePoolDeclarations } from './machine-pool-inventory.js';

const digest = 'sha256:' + 'a'.repeat(64);
const declaration = { pools: [{ purpose: 'ta', fanoutGroupId: 'ta-map-reduce-v1',
  members: [{ host: 'gcp1', count: 2, digest, role: 'both' }, { host: 'aws1', count: 3, digest, role: 'executor' }],
  fanoutGroup: { shard: { kind: 'crawl', input: 'query-1', result: 'citations-v1', fingerprint: 'runtime-env-skill-v1' } },
  fingerprint: { runtime: 'bun-1', environment: 'node-linux-amd64', skillPacks: [{ name: 'research', version: '2.1.0' }] },
  cleanup: { procedure: 'worktree-env-credential-v1', verify: 'workspace-clean-and-secret-scan-v1' },
 }] };

test('machine pool declaration carries mesh, map-reduce, cleanup, fingerprint, and skill identity', () => {
  const pools = parseMachinePoolDeclarations(declaration);
  expect(pools[0]).toMatchObject({ purpose: 'ta', fanoutGroupId: 'ta-map-reduce-v1', fanoutGroup: { shard: { kind: 'crawl', input: 'query-1' } },
    members: [{ host: 'gcp1', count: 2, role: 'both' }, { host: 'aws1', count: 3, role: 'executor' }],
    cleanup: { procedure: 'worktree-env-credential-v1', verify: 'workspace-clean-and-secret-scan-v1' },
  fingerprint: { runtime: 'bun-1', environment: 'node-linux-amd64',

      skillPacks: [{ name: 'research', version: '2.1.0' }] } });
  expect(machinePoolCapacity(pools)).toEqual({ gcp1: { ta: 2 }, aws1: { ta: 3 } });
  expect(machinePoolCapacity(parseMachinePoolDeclarations({ pools: [{ ...declaration.pools[0], members: [{ ...declaration.pools[0].members[0], role: 'assigner' }] }] }))).toEqual({});
});

test('machine pool declaration rejects missing members, mutable digests, and duplicate hosts', () => {
  expect(() => parseMachinePoolDeclarations({ pools: [{ ...declaration.pools[0], members: [] }] })).toThrow('members');
  expect(() => parseMachinePoolDeclarations({ pools: [{ ...declaration.pools[0],
    members: [{ ...declaration.pools[0].members[0], digest: 'latest' }] }] })).toThrow('immutable sha256');
  expect(() => parseMachinePoolDeclarations({ pools: [{ ...declaration.pools[0],
    members: [declaration.pools[0].members[0], declaration.pools[0].members[0]] }] })).toThrow('host must be unique');
  const { skillPacks: _unknown, ...fingerprint } = declaration.pools[0].fingerprint;
  expect(() => parseMachinePoolDeclarations({ pools: [{ ...declaration.pools[0], fingerprint }] })).toThrow('skillPacks is required');
});
