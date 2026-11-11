import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchMachinePoolDeclarationsFromNexus } from '../../scripts/warm-pool-provider-config.js';
import { issueMemberToken, revokeMemberToken } from '../control-plane/member-tokens.js';
import { getElanousConfigDirOverride, setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { routeRequest } from '../nexus/api/http-server.js';
import { resourceLedgerPath, declareResourcePool } from '../resource-ledger/resource-ledger.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';

const publicAddress = '203.0.113.42';
const ledgerUrl = 'https://nexus.example.test/v1/resource-ledger/pools';
const tokenPath = (root: string) => join(root, 'control', 'member-tokens.json');
let simulationTail: Promise<void> = Promise.resolve();

/**
 * Run the production provider fetcher and Nexus route as a tailnet-free VM.
 * Only the HTTPS transport boundary is in-process; no cloud provider or public network is contacted.
 */
export function runPublicAuthProviderCloudVmSimulation() {
  const previous = simulationTail;
  let release!: () => void;
  simulationTail = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(runPublicAuthProviderCloudVmSimulationInternal).finally(release);
}

async function runPublicAuthProviderCloudVmSimulationInternal() {
  const previousConfigDir = getElanousConfigDirOverride();
  const root = mkdtempSync(join(tmpdir(), 'public-auth-provider-cloud-vm-sim-'));
  const requests: Array<{ host: string; path: string; protocol: string; status: number }> = [];
  try {
    setElanousConfigDir(root);
    const vmFleet = createFakeCloudVm();
    const vm = vmFleet.createFromImage({ id: 'cloud-host-a', imageDigest: `sha256:${'a'.repeat(64)}`, hourlyCost: 0.1 });
    const hostAToken = issueMemberToken('cloud-host-a', root);
    const expiredToken = issueMemberToken('cloud-host-expired', root);
    const revokedToken = issueMemberToken('cloud-host-revoked', root);
    const hostBToken = issueMemberToken('cloud-host-b', root);
    const pools = [
      { purpose: 'gate' as const, fanoutGroupId: 'pool-a', members: [{ host: 'cloud-host-a', count: 1, digest: `sha256:${'b'.repeat(64)}`, role: 'both' as const }],
        fanoutGroup: { shard: { kind: 'gate', input: 'pool-a-input', result: 'pool-a-result', fingerprint: 'pool-a-fingerprint' } },
        fingerprint: { runtime: 'bun-test', environment: 'public-cloud-vm', skillPacks: [] },
        cleanup: { procedure: 'remove simulated pool-a host', verify: 'pool-a host absent' } },
      { purpose: 'gate' as const, fanoutGroupId: 'pool-b', members: [{ host: 'cloud-host-b', count: 1, digest: `sha256:${'c'.repeat(64)}`, role: 'both' as const }],
        fanoutGroup: { shard: { kind: 'gate', input: 'pool-b-input', result: 'pool-b-result', fingerprint: 'pool-b-fingerprint' } },
        fingerprint: { runtime: 'bun-test', environment: 'public-cloud-vm', skillPacks: [] },
        cleanup: { procedure: 'remove simulated pool-b host', verify: 'pool-b host absent' } },
    ];
    const ledger = resourceLedgerPath(root);
    for (const pool of pools) declareResourcePool(pool, new Date('2026-11-10T00:00:00.000Z'), ledger);
    const tokenStore = JSON.parse(readFileSync(tokenPath(root), 'utf8')) as Record<string, { sha256: string; issuedAt: string; expiresAt: string }>;
    tokenStore['cloud-host-expired']!.expiresAt = '2000-01-01T00:00:00.000Z';
    writeFileSync(tokenPath(root), JSON.stringify(tokenStore), { mode: 0o600 });
    revokeMemberToken('cloud-host-revoked', root);

    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const eventBus = new NexusEventBus();
    state.bus = eventBus;
    const opts = { state, eventBus, registry: new TabRegistry(state) };
    const nexus = { requestIP: () => ({ address: publicAddress }) };
    const devProxyRef = { get: () => undefined };
    const vmFetch: typeof fetch = async (input, init) => {
      const request = new Request(String(input), init);
      const response = await routeRequest(request, opts as never, nexus as never, null, devProxyRef as never);
      if (!response) throw new Error(`Nexus did not handle ${new URL(request.url).pathname}`);
      requests.push({ host: new URL(request.url).hostname, path: new URL(request.url).pathname,
        protocol: new URL(request.url).protocol, status: response.status });
      return response;
    };
    const allowed = await fetchMachinePoolDeclarationsFromNexus(ledgerUrl, hostAToken, vmFetch);
    const statusFor = async (token: string, url = ledgerUrl) => {
      try { await fetchMachinePoolDeclarationsFromNexus(url, token, vmFetch); return 200; }
      catch (error) {
        const match = /HTTP (\d+)/.exec(error instanceof Error ? error.message : '');
        return match ? Number(match[1]) : 0;
      }
    };
    const expiredStatus = await statusFor(expiredToken);
    const revokedStatus = await statusFor(revokedToken);
    const publicHttpStatus = await (async () => {
      const response = await routeRequest(new Request('http://nexus.example.test/v1/resource-ledger/pools', {
        headers: { authorization: `Bearer ${hostAToken}` },
      }), opts as never, nexus as never, null, devProxyRef as never);
      return response?.status ?? 0;
    })();
    let plainHttpFetches = 0;
    const plainHttpRejectedBeforeFetch = await fetchMachinePoolDeclarationsFromNexus(
      'http://nexus.example.test/v1/resource-ledger/pools', hostAToken,
      (async () => { plainHttpFetches += 1; return Response.json({ pools: [] }); }) as typeof fetch,
    ).then(() => false, () => true);
    const otherHost = await fetchMachinePoolDeclarationsFromNexus(ledgerUrl, hostBToken, vmFetch);
    return {
      vm: { id: vm.id, state: vm.state, imageDigest: vm.imageDigest, publicAddress, tailnet: false },
      allowedPools: allowed,
      otherHostPools: otherHost,
      expiredStatus,
      revokedStatus,
      publicHttpStatus,
      plainHttpRejectedBeforeFetch,
      plainHttpFetches,
      requests,
    };
  } finally {
    if (previousConfigDir) setElanousConfigDir(previousConfigDir);
    else resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
}
