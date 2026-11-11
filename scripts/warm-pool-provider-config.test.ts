import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log.js';
import { LogStore, StoreSink } from '../src/mss/logging/log-store.js';
import { assembleWarmPoolProviderConfig, fetchMachinePoolDeclarationsFromNexus, requireAuthoritativeMachinePoolSource, runWarmPoolProviderConfig, selectSingleWarmPoolCandidate } from './warm-pool-provider-config.js';
import { assertResourceLedgerUrl } from './resource-ledger-url.js';
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

test('provider config accepts private ClusterIP/node host probes and rejects public destinations', () => {
  const privateConfig = { ...config, pod: { ...config.pod, warmPool: { ...config.pod.warmPool, hostProbeUrl: 'http://10.43.195.1:10001/health' } } };
  expect(assembleWarmPoolProviderConfig({ config: privateConfig, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) }, machinePools: [declaration] }).poolTemplates[0]?.spec.hostProbeUrl)
    .toBe('http://10.43.195.1:10001/health');
  const publicConfig = { ...config, pod: { ...config.pod, warmPool: { ...config.pod.warmPool, hostProbeUrl: 'http://example.com:10001/health' } } };
  expect(() => assembleWarmPoolProviderConfig({ config: publicConfig, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) }, machinePools: [declaration] })).toThrow();
});

test('provider config uses machine-pool member count and digest for its purpose', () => {
  const assembled = assembleWarmPoolProviderConfig({ config, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) }, machinePools: [declaration] });
  expect(assembled.poolTemplates).toHaveLength(1);
  expect(assembled.poolTemplates[0]).toMatchObject({ host: 'gcp1', slotCount: 2, spec: { key: { imageDigest: digest } } });
});

test('provider config preserves an explicit Pod kind for phase targets', () => {
  const typed = { ...config, pod: { ...config.pod, warmPool: { ...config.pod.warmPool,
    templates: [{ ...config.pod.warmPool.templates[0]!, kind: 'implementation' }] } } };
  const assembled = assembleWarmPoolProviderConfig({ config: typed, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) }, machinePools: [declaration] });
  expect(assembled.poolTemplates[0]?.kind).toBe('implementation');
  expect(selectSingleWarmPoolCandidate(assembled, 'gcp1/standard').candidates[0]?.kind).toBe('implementation');
  const duplicateKinds = { ...config, pod: { ...config.pod, warmPool: { ...config.pod.warmPool,
    templates: [
      { ...config.pod.warmPool.templates[0]!, kind: 'gate' },
      { ...config.pod.warmPool.templates[0]!, kind: 'implementation' },
    ] } } };
  const split = assembleWarmPoolProviderConfig({ config: duplicateKinds, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) }, machinePools: [declaration] });
  expect(split.poolTemplates.map(row => [row.kind, row.slotCount])).toEqual([['gate', 1], ['implementation', 1]]);
  expect(() => selectSingleWarmPoolCandidate(split, 'gcp1/standard')).toThrow('kind required');
  expect(selectSingleWarmPoolCandidate(split, 'gcp1/standard/implementation').candidates[0]?.kind).toBe('implementation');
});

test('provider config strictly converts the single phaseSchedule from ISO UTC timestamps to milliseconds', () => {
  const phaseSchedule = { steadyTargets: { gate: 1, implementation: 3 }, measuredPrepareDurationMs: 300_000,
    windows: [{ phase: 'gate', startAt: '2026-11-10T06:00:00Z', endAt: '2026-11-10T07:00:00Z',
      targets: { gate: 2, implementation: 1 }, cutSha: 'c'.repeat(40), lockHash: 'b'.repeat(64), imageDigest: digest }] };
  const scheduledConfig = { ...config, pod: { ...config.pod, warmPool: { ...config.pod.warmPool, phaseSchedule } } };
  const assembled = assembleWarmPoolProviderConfig({ config: scheduledConfig, controlUrl: 'https://control.example:8413',
    memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) }, machinePools: [declaration] });
  expect(assembled.phaseSchedule).toEqual({ steadyTargets: { gate: 1, implementation: 3 }, measuredPrepareDurationMs: 300_000,
    windows: [{ phase: 'gate', startAtMs: Date.parse('2026-11-10T06:00:00Z'), endAtMs: Date.parse('2026-11-10T07:00:00Z'),
      targets: { gate: 2, implementation: 1 }, cutSha: 'c'.repeat(40), lockHash: 'b'.repeat(64), imageDigest: digest }] });
});

test('provider config rejects unknown fields, non-UTC timestamps, overlap, and invalid measured readiness', () => {
  const phaseSchedule = { steadyTargets: { gate: 1 }, windows: [{ phase: 'gate', startAt: '2026-11-10T06:00:00Z',
    endAt: '2026-11-10T07:00:00Z', targets: { gate: 1 }, cutSha: 'c'.repeat(40), lockHash: 'b'.repeat(64), imageDigest: digest }] };
  const assembleWith = (schedule: unknown) => assembleWarmPoolProviderConfig({
    config: { ...config, pod: { ...config.pod, warmPool: { ...config.pod.warmPool, phaseSchedule: schedule } } },
    controlUrl: 'https://control.example:8413', memberToken: 'd'.repeat(64), machineTokens: { gcp1: 'e'.repeat(64) }, machinePools: [declaration],
  });
  expect(() => assembleWith({ ...phaseSchedule, surprise: true })).toThrow('phaseSchedule.surprise is not supported');
  expect(() => assembleWith({ ...phaseSchedule, windows: [{ ...phaseSchedule.windows[0]!, startAt: '2026-11-10T06:00:00' }] }))
    .toThrow('must be an ISO-8601 UTC timestamp');
  expect(() => assembleWith({ ...phaseSchedule, windows: [phaseSchedule.windows[0]!, {
    phase: "publish", startAt: "2026-11-10T06:30:00Z", endAt: "2026-11-10T07:30:00Z", targets: { gate: 1 },
  }] })).toThrow('invalid or overlapping warm Pod phase window');
  expect(() => assembleWith({ ...phaseSchedule, measuredPrepareDurationMs: -1 }))
    .toThrow('measuredPrepareDurationMs must be a non-negative integer');
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
  const pools = await fetchMachinePoolDeclarationsFromNexus('https://nexus.example:8413/v1/resource-ledger/pools', 'test-token',
    (async (_input, init) => {
      authorization = String(init?.headers && (init.headers as Record<string, string>).authorization);
      expect(init?.redirect).toBe('error');
      return new Response(JSON.stringify({ pools: [declaration] }), { status: 200 });
    }) as typeof fetch);
  expect(authorization).toBe('Bearer test-token');
  expect(pools).toEqual([declaration]);
});

test('machine bearer URLs require the resource-ledger route and TLS outside loopback or tailnet', async () => {
  for (const url of [
    'http://127.0.0.1:8413/v1/resource-ledger/pools',
    'https://nexus.example:8413/v1/resource-ledger/pools',
  ]) expect(() => assertResourceLedgerUrl(url)).not.toThrow();
  const currentTailnetAddresses = ['100.64.0.1'];
  let statusReads = 0;
  const readTailnetAddresses = () => { statusReads++; return currentTailnetAddresses; };
  const tailnetUrl = 'http://100.64.0.1:8413/v1/resource-ledger/pools';
  assertResourceLedgerUrl(tailnetUrl, { readTailnetAddresses });
  currentTailnetAddresses.length = 0; // peer was removed or status lookup failed
  expect(() => assertResourceLedgerUrl(tailnetUrl, { readTailnetAddresses }))
    .toThrow('must use HTTPS outside loopback or tailnet');
  expect(statusReads).toBe(2);
  for (const url of [
    'http://nexus.example:8413/v1/resource-ledger/pools',
    'http://nexus.localhost:8413/v1/resource-ledger/pools',
    'http://100.64.0.1:8413/v1/resource-ledger/pools',
    'http://nexus.tailnet.ts.net:8413/v1/resource-ledger/pools',
    'https://nexus.example:8413/v1/ops/resources/ledger',
    'https://machine-token@example.test/v1/resource-ledger/pools',
    'https://nexus.example:8413/v1/resource-ledger/pools?redirect=https://attacker.test',
    'https://nexus.example:8413/v1/resource-ledger/pools?',
    'https://nexus.example:8413/v1/resource-ledger/pools#',
    'https://@nexus.example:8413/v1/resource-ledger/pools',
    'https://:@nexus.example:8413/v1/resource-ledger/pools',
  ]) expect(() => assertResourceLedgerUrl(url, { readTailnetAddresses: () => [] })).toThrow();

  let fetched = false;
  await expect(fetchMachinePoolDeclarationsFromNexus('http://nexus.example:8413/v1/resource-ledger/pools', 'secret-token',
    Object.assign(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      fetched = true;
      return new Response(JSON.stringify({ pools: [declaration] }));
    }, { preconnect: fetch.preconnect })))
    .rejects.toThrow('must use HTTPS outside loopback or tailnet');
  expect(fetched).toBe(false);

  for (const suffix of ['?', '#']) {
    await expect(fetchMachinePoolDeclarationsFromNexus(
      `https://nexus.example:8413/v1/resource-ledger/pools${suffix}`, 'secret-token',
      Object.assign(async () => {
        fetched = true;
        return new Response(JSON.stringify({ pools: [declaration] }));
      }, { preconnect: fetch.preconnect }) as typeof fetch,
    )).rejects.toThrow('cannot contain credentials, query, or fragment');
    expect(fetched).toBe(false);
  }
  for (const userinfo of ['@', ':@']) {
    await expect(fetchMachinePoolDeclarationsFromNexus(
      `https://${userinfo}nexus.example:8413/v1/resource-ledger/pools`, 'secret-token',
      Object.assign(async () => {
        fetched = true;
        return new Response(JSON.stringify({ pools: [declaration] }));
      }, { preconnect: fetch.preconnect }) as typeof fetch,
    )).rejects.toThrow('cannot contain credentials, query, or fragment');
    expect(fetched).toBe(false);
  }
});

test('provider CLI rejects public HTTP before it reads any token or writes config', async () => {
  await expect(runWarmPoolProviderConfig([
    '--config', '/missing/config.json', '--control-url', 'https://control.example:8413',
    '--member-token-file', '/missing/member.token', '--machine-token', 'aws1=/missing/aws1.token',
    '--resource-ledger-url', 'http://nexus.example:8413/v1/resource-ledger/pools',
    '--output', '/missing/provider.json',
  ])).rejects.toThrow('must use HTTPS outside loopback or tailnet');
});

test('provider rejects an HTTP redirect without forwarding the machine bearer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-ledger-redirect-rejected-'));
  const configPath = join(dir, 'config.json');
  const memberTokenPath = join(dir, 'member.token');
  const machineTokenPath = join(dir, 'gcp1.token');
  const outputPath = join(dir, 'provider.json');
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(memberTokenPath, `${'d'.repeat(64)}\n`, { mode: 0o600 });
  writeFileSync(machineTokenPath, `${'e'.repeat(64)}\n`, { mode: 0o600 });
  let redirectedRequests = 0;
  let initialRequests = 0;
  let redirectTarget = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request): Response {
    if (new URL(request.url).pathname === '/v1/resource-ledger/pools') initialRequests++;
    if (new URL(request.url).pathname === '/redirect-target') redirectedRequests++;
    return Response.redirect(redirectTarget, 302);
  } });
  redirectTarget = `http://127.0.0.1:${server.port}/redirect-target`;
  try {
    await expect(runWarmPoolProviderConfig([
      '--config', configPath,
      '--control-url', 'https://control.example:8413',
      '--member-token-file', memberTokenPath,
      '--machine-token', `gcp1=${machineTokenPath}`,
      '--resource-ledger-url', `http://127.0.0.1:${server.port}/v1/resource-ledger/pools`,
      '--output', outputPath,
    ])).rejects.toThrow('Nexus resource-ledger request failed: network error');
    expect(initialRequests).toBe(1);
    expect(redirectedRequests).toBe(0);
    expect(existsSync(outputPath)).toBe(false);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A public HTTPS address is the second route for cloud VMs without tailnet.
// The same machine-scoped bearer contract must work for every warm-pool host set.
test('provider assembles five tailnet and public-auth host combinations from Nexus declarations', async () => {
  const hosts = ['gcp1', 'gcp2', 'aws1', 'aws2', 'aws3'] as const;
  const combinations = [
    ['gcp1'], ['aws1'], ['gcp1', 'aws1'], ['aws1', 'gcp2', 'aws3'], [...hosts],
  ] as const;
  const tokenByHost = Object.fromEntries(hosts.map((host, index) => [host, String(index + 1).repeat(64)]));
  const routes = [
    { url: 'http://100.64.0.10:8413/v1/resource-ledger/pools', readTailnetAddresses: () => ['100.64.0.10'] },
    { url: 'https://nexus.example:8413/v1/resource-ledger/pools', readTailnetAddresses: () => [] },
  ];

  for (const route of routes) for (const selected of combinations) {
    const { url } = route;
    const pool: MachinePoolDeclaration = { ...declaration, members: selected.map((host, index) => ({
      host, count: index + 1, digest, role: 'executor' as const,
    })) };
    const requestedTokens: string[] = [];
    const fetcher: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(String(input)).toBe(url);
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      expect(authorization?.startsWith('Bearer ')).toBe(true);
      const presented = authorization!.slice('Bearer '.length);
      requestedTokens.push(presented);
      return new Response(JSON.stringify({ pools: [pool] }), { status: 200 });
    }, { preconnect: fetch.preconnect,
      resourceLedgerUrlValidationForTest: { readTailnetAddresses: route.readTailnetAddresses } });
    const declarations = await Promise.all(selected.map(host =>
      fetchMachinePoolDeclarationsFromNexus(url, tokenByHost[host]!, fetcher)));
    expect(requestedTokens).toEqual(selected.map(host => tokenByHost[host]));
    const templates = selected.map(host => ({ host, tier: 'standard', nodeName: `${host}-node` }));
    const assembled = assembleWarmPoolProviderConfig({
      config: { ...config, pod: { ...config.pod, warmPool: { ...config.pod.warmPool, templates } } },
      controlUrl: 'https://control.example:8413', memberToken: 'd'.repeat(64),
      machineTokens: Object.fromEntries(selected.map(host => [host, tokenByHost[host]])),
      machinePools: declarations[0],
    });
    expect(assembled.poolTemplates.map(row => [row.host, row.slotCount]))
      .toEqual(selected.map((host, index) => [host, index + 1]));
  }
});

test('provider CLI merges distinct machine-scoped declarations from all five host reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-ledger-public-auth-five-host-cli-'));
  const hosts = ['gcp1', 'gcp2', 'aws1', 'aws2', 'aws3'] as const;
  const tokenByHost = Object.fromEntries(hosts.map((host, index) => [host, String(index + 1).repeat(64)]));
  const hostByToken = new Map(Object.entries(tokenByHost).map(([host, token]) => [token, host]));
  const poolsByHost = Object.fromEntries(hosts.map((host, index) => [host, {
    ...declaration, fanoutGroupId: `gate-${host}`, members: [{ host, count: index + 1, digest, role: 'both' as const }],
  }]));
  const configPath = join(dir, 'config.json');
  const memberTokenPath = join(dir, 'member.token');
  const outputPath = join(dir, 'provider.json');
  writeFileSync(configPath, JSON.stringify({ ...config, pod: { ...config.pod, warmPool: {
    ...config.pod.warmPool, templates: hosts.map(host => ({ host, tier: 'standard', nodeName: `${host}-node` })),
  } } }));
  writeFileSync(memberTokenPath, `${'f'.repeat(64)}\n`, { mode: 0o600 });
  const tokenPaths = new Map<string, string>();
  for (const host of hosts) {
    const path = join(dir, `${host}.token`);
    writeFileSync(path, `${tokenByHost[host]}\n`, { mode: 0o600 });
    tokenPaths.set(host, path);
  }
  const requestedHosts: string[] = [];
  const fetcher = (async (input, init) => {
    expect(String(input)).toBe('https://nexus.example:8413/v1/resource-ledger/pools');
    expect(init?.redirect).toBe('error');
    const offered = (init?.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /, '');
    const host = offered ? hostByToken.get(offered) : undefined;
    if (!host) return Response.json({ error: 'unauthorized' }, { status: 401 });
    requestedHosts.push(host);
    return Response.json({ pools: [poolsByHost[host]] });
  }) as typeof fetch;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = fetcher;
    await runWarmPoolProviderConfig([
      '--config', configPath,
      '--control-url', 'https://control.example:8413',
      '--member-token-file', memberTokenPath,
      ...hosts.flatMap(host => ['--machine-token', `${host}=${tokenPaths.get(host)!}`]),
      '--resource-ledger-url', 'https://nexus.example:8413/v1/resource-ledger/pools',
      '--output', outputPath,
    ]);
    expect(requestedHosts.sort()).toEqual([...hosts].sort());
    const written = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      poolTemplates: Array<{ host: string; slotCount: number }>;
      machinePools: MachinePoolDeclaration[];
    };
    expect(written.poolTemplates.map(row => [row.host, row.slotCount]))
      .toEqual(hosts.map((host, index) => [host, index + 1]));
    expect(written.machinePools.map(pool => pool.members[0]?.host).sort()).toEqual([...hosts].sort());
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider refuses a public ledger response that is not scoped to the requesting host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-ledger-public-auth-host-scope-'));
  const configPath = join(dir, 'config.json');
  const memberTokenPath = join(dir, 'member.token');
  const machineTokenPath = join(dir, 'aws1.token');
  const outputPath = join(dir, 'provider.json');
  writeFileSync(configPath, JSON.stringify({ ...config, pod: { ...config.pod, warmPool: {
    ...config.pod.warmPool, templates: [{ host: 'aws1', tier: 'standard', nodeName: 'aws1-node' }],
  } } }));
  writeFileSync(memberTokenPath, `${'d'.repeat(64)}\n`, { mode: 0o600 });
  writeFileSync(machineTokenPath, `${'e'.repeat(64)}\n`, { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ pools: [declaration] })) as typeof fetch;
    await expect(runWarmPoolProviderConfig([
      '--config', configPath,
      '--control-url', 'https://control.example:8413',
      '--member-token-file', memberTokenPath,
      '--machine-token', `aws1=${machineTokenPath}`,
      '--resource-ledger-url', 'https://nexus.example:8413/v1/resource-ledger/pools',
      '--output', outputPath,
    ])).rejects.toThrow('Nexus resource-ledger response invalid');
    expect(existsSync(outputPath)).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('public-auth ledger fetch fails closed on missing, rejected, or expired machine credentials', async () => {
  const url = 'https://nexus.example:8413/v1/resource-ledger/pools';
  const authorized = 'a'.repeat(64);
  const expired = 'b'.repeat(64);
  const fetcher = (async (_input, init) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (authorization === `Bearer ${authorized}`)
      return new Response(JSON.stringify({ pools: [declaration] }), { status: 200 });
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }) as typeof fetch;
  for (const credential of ['', 'wrong-token', expired]) {
    await expect(fetchMachinePoolDeclarationsFromNexus(url, credential, fetcher))
      .rejects.toThrow('Nexus resource-ledger request failed: HTTP 401');
  }
  // One stale VM credential must abort the entire multi-host read, even when another host succeeds.
  await expect(Promise.all([
    fetchMachinePoolDeclarationsFromNexus(url, authorized, fetcher),
    fetchMachinePoolDeclarationsFromNexus(url, expired, fetcher),
  ])).rejects.toThrow('Nexus resource-ledger request failed: HTTP 401');
});

test('provider CLI leaves no config when one of two VM credentials gets 401', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-ledger-public-auth-sim-'));
  const valid = 'e'.repeat(64);
  const expired = 'f'.repeat(64);
  const configPath = join(dir, 'config.json');
  const validPath = join(dir, 'gcp1.token');
  const expiredPath = join(dir, 'aws1.token');
  const output = join(dir, 'provider.json');
  const server = Bun.serve({ port: 0, fetch(request) {
    const offered = request.headers.get('authorization');
    if (offered === `Bearer ${valid}`) return Response.json({ pools: [declaration] });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  } });
  try {
    writeFileSync(configPath, JSON.stringify({ ...config, pod: { ...config.pod, warmPool: {
      ...config.pod.warmPool, templates: [
        { host: 'gcp1', tier: 'standard', nodeName: 'gcp1-node' },
        { host: 'aws1', tier: 'standard', nodeName: 'aws1-node' },
      ],
    } } }));
    writeFileSync(validPath, valid);
    writeFileSync(expiredPath, expired);
    await expect(runWarmPoolProviderConfig([
      '--config', configPath, '--control-url', 'https://control.example:8413',
      '--member-token-file', validPath, '--machine-token', `gcp1=${validPath}`,
      '--machine-token', `aws1=${expiredPath}`, '--resource-ledger-url', `http://127.0.0.1:${server.port}/v1/resource-ledger/pools`,
      '--output', output,
    ])).rejects.toThrow('Nexus resource-ledger request failed: HTTP 401');
    expect(existsSync(output)).toBe(false);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resource-ledger read failures fail closed and emit observations without credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-pool-ledger-read-failures-'));
  const store = new LogStore(join(root, 'logs.db'), { instance: 'test:warm-pool-ledger-read-failures' });
  const sink = new StoreSink(store, 'test:warm-pool-ledger-read-failures', { installExitHandlers: false });
  const unregister = debug.registerSink(sink);
  const failures = [
    { status: 404, token: 'a'.repeat(64) },
    { status: 503, token: 'f'.repeat(64) },
    { status: 401, token: 'b'.repeat(64) },
    { status: 401, token: 'c'.repeat(64) }, // expired credential presented by the Nexus boundary
  ];
  try {
    for (const failure of failures) {
      const failureFetcher: typeof fetch = Object.assign(async (_input: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1]) => new Response('{}', { status: failure.status }), { preconnect: fetch.preconnect });
      await expect(fetchMachinePoolDeclarationsFromNexus('https://nexus.test/v1/resource-ledger/pools', failure.token,
        failureFetcher))
        .rejects.toThrow(`Nexus resource-ledger request failed: HTTP ${failure.status}`);
    }
    sink.flush();
    const rows = store.query({ categories: ['pod.warm.provider-config'], limit: 20 })
      .filter(row => row.event === 'resource-ledger-read-failed');
    expect(rows).toHaveLength(4);
    const observations = rows.map(row => JSON.parse(row.data ?? '{}'))
      .map(({ status, reason }) => ({ status, reason }))
      .sort((left, right) => left.status - right.status);
    expect(observations).toEqual([
      { status: 401, reason: 'unauthorized' },
      { status: 401, reason: 'unauthorized' },
      { status: 404, reason: 'not-found' },
      { status: 503, reason: 'http-error' },
    ]);
    const serialized = rows.map(row => row.data ?? '').join('\n');
    expect(serialized).not.toContain('a'.repeat(64));
    expect(serialized).not.toContain('b'.repeat(64));
    expect(serialized).not.toContain('c'.repeat(64));
    expect(serialized).not.toContain('f'.repeat(64));
  } finally {
    sink.flush();
    unregister();
    sink.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider CLI logs the requested host and writes no config when its ledger read fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-pool-provider-ledger-http-failure-'));
  const logStore = new LogStore(join(root, 'logs.db'), { instance: 'test:warm-pool-provider-ledger-http-failure' });
  const logSink = new StoreSink(logStore, 'test:warm-pool-provider-ledger-http-failure', { installExitHandlers: false });
  const unregisterLogSink = debug.registerSink(logSink);
  const configPath = join(root, 'config.json');
  const memberTokenPath = join(root, 'member.token');
  const machineTokenPath = join(root, 'aws1.token');
  const outputPath = join(root, 'warm-pod-provider.json');
  const memberToken = 'd'.repeat(64);
  const machineToken = 'e'.repeat(64);
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(memberTokenPath, `${memberToken}\n`, { mode: 0o600 });
  writeFileSync(machineTokenPath, `${machineToken}\n`, { mode: 0o600 });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Response('unauthorized', { status: 401 }) });
  try {
    await expect(runWarmPoolProviderConfig([
      '--config', configPath,
      '--control-url', 'https://control.example:8413',
      '--member-token-file', memberTokenPath,
      '--machine-token', `aws1=${machineTokenPath}`,
      '--resource-ledger-url', `http://127.0.0.1:${server.port}/v1/resource-ledger/pools`,
      '--output', outputPath,
    ])).rejects.toThrow('Nexus resource-ledger request failed: HTTP 401');
    expect(existsSync(outputPath)).toBe(false);
    logSink.flush();
    const warning = logStore.query({ categories: ['pod.warm.provider-config'], limit: 10 })
      .find(row => row.event === 'resource-ledger-read-failed');
    expect(JSON.parse(warning?.data ?? '{}')).toMatchObject({ host: 'aws1', status: 401, reason: 'unauthorized' });
    expect(warning?.data).not.toContain(memberToken);
    expect(warning?.data).not.toContain(machineToken);
  } finally {
    server.stop(true);
    logSink.flush();
    unregisterLogSink();
    logSink.close();
    logStore.close();
    rmSync(root, { recursive: true, force: true });
  }
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

test('provider CLI uses a separate ledger credential and preserves host machine credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warm-pool-ledger-credential-split-'));
  const configPath = join(dir, 'config.json');
  const memberTokenPath = join(dir, 'member.token');
  const gcp1LedgerTokenPath = join(dir, 'gcp1-ledger.token');
  const aws1LedgerTokenPath = join(dir, 'aws1-ledger.token');
  const gcp1TokenPath = join(dir, 'gcp1.token');
  const aws1TokenPath = join(dir, 'aws1.token');
  const outputPath = join(dir, 'provider.json');
  const memberToken = 'd'.repeat(64);
  const gcp1LedgerToken = 'f'.repeat(64);
  const aws1LedgerToken = 'c'.repeat(64);
  const gcp1MachineToken = 'e'.repeat(64);
  const aws1MachineToken = 'a'.repeat(64);
  const aws1Declaration = { ...declaration, fanoutGroupId: 'gate-aws1',
    members: [{ host: 'aws1', count: 3, digest, role: 'both' as const }] };
  writeFileSync(configPath, JSON.stringify({ ...config, pod: { ...config.pod, warmPool: {
    ...config.pod.warmPool, templates: [
      { host: 'gcp1', tier: 'standard', nodeName: 'gcp1-node' },
      { host: 'aws1', tier: 'standard', nodeName: 'aws1-node' },
    ],
  } } }));
  writeFileSync(memberTokenPath, `${memberToken}\n`, { mode: 0o600 });
  writeFileSync(gcp1LedgerTokenPath, `${gcp1LedgerToken}\n`, { mode: 0o600 });
  writeFileSync(aws1LedgerTokenPath, `${aws1LedgerToken}\n`, { mode: 0o600 });
  writeFileSync(gcp1TokenPath, `${gcp1MachineToken}\n`, { mode: 0o600 });
  writeFileSync(aws1TokenPath, `${aws1MachineToken}\n`, { mode: 0o600 });
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests++;
    const authorization = request.headers.get('authorization');
    if (authorization === `Bearer ${gcp1LedgerToken}`) return Response.json({ pools: [declaration] });
    if (authorization === `Bearer ${aws1LedgerToken}`) return Response.json({ pools: [aws1Declaration] });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  } });
  try {
    await runWarmPoolProviderConfig([
      '--config', configPath,
      '--control-url', 'https://control.example:8413',
      '--member-token-file', memberTokenPath,
      '--ledger-token-file', `gcp1=${gcp1LedgerTokenPath}`,
      '--ledger-token-file', `aws1=${aws1LedgerTokenPath}`,
      '--machine-token', `gcp1=${gcp1TokenPath}`,
      '--machine-token', `aws1=${aws1TokenPath}`,
      '--resource-ledger-url', `http://127.0.0.1:${server.port}/v1/resource-ledger/pools`,
      '--output', outputPath,
    ]);
    expect(requests).toBe(2);
    const written = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      memberToken: string; machineTokens: Record<string, string>; poolTemplates: Array<{ host: string }>;
    };
    expect(written.memberToken).toBe(memberToken);
    expect(written.machineTokens).toEqual({ gcp1: gcp1MachineToken, aws1: aws1MachineToken });
    expect(written.poolTemplates.map(row => row.host).sort()).toEqual(['aws1', 'gcp1']);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider refuses a separate ledger credential response scoped to another host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warm-pool-ledger-credential-scope-'));
  const configPath = join(dir, 'config.json');
  const memberTokenPath = join(dir, 'member.token');
  const ledgerTokenPath = join(dir, 'aws1-ledger.token');
  const machineTokenPath = join(dir, 'aws1.token');
  const outputPath = join(dir, 'provider.json');
  writeFileSync(configPath, JSON.stringify({ ...config, pod: { ...config.pod, warmPool: {
    ...config.pod.warmPool, templates: [{ host: 'aws1', tier: 'standard', nodeName: 'aws1-node' }],
  } } }));
  writeFileSync(memberTokenPath, `${'d'.repeat(64)}\n`, { mode: 0o600 });
  writeFileSync(ledgerTokenPath, `${'c'.repeat(64)}\n`, { mode: 0o600 });
  writeFileSync(machineTokenPath, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ pools: [declaration] })) as typeof fetch;
    await expect(runWarmPoolProviderConfig([
      '--config', configPath,
      '--control-url', 'https://control.example:8413',
      '--member-token-file', memberTokenPath,
      '--ledger-token-file', `aws1=${ledgerTokenPath}`,
      '--machine-token', `aws1=${machineTokenPath}`,
      '--resource-ledger-url', 'https://nexus.example:8413/v1/resource-ledger/pools',
      '--output', outputPath,
    ])).rejects.toThrow('Nexus resource-ledger response invalid');
    expect(existsSync(outputPath)).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
