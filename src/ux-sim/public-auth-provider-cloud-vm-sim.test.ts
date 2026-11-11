import { expect, test } from 'bun:test';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { runPublicAuthProviderCloudVmSimulation } from './public-auth-provider-cloud-vm-sim.js';

test('PUBLIC-AUTH-PROVIDER-CLOUD-VM-SIM: public HTTPS scopes declarations to a tailnet-free host and refuses bad credentials', async () => {
  const priorConfigDir = getElanousConfigDirOverride();
  const preservedConfigDir = '/tmp/public-auth-provider-cloud-vm-sim-test-config';
  setElanousConfigDir(preservedConfigDir);
  try {
  const [result, concurrent] = await Promise.all([
    runPublicAuthProviderCloudVmSimulation(),
    runPublicAuthProviderCloudVmSimulation(),
  ]);
  expect(result.vm).toMatchObject({ id: 'cloud-host-a', state: 'ready', tailnet: false });
  expect(concurrent.vm).toMatchObject({ id: 'cloud-host-a', state: 'ready', tailnet: false });
  expect(result.allowedPools.map(pool => pool.fanoutGroupId)).toEqual(['pool-a']);
  expect(concurrent.allowedPools.map(pool => pool.fanoutGroupId)).toEqual(['pool-a']);
  expect(result.otherHostPools.map(pool => pool.fanoutGroupId)).toEqual(['pool-b']);
  expect(result.expiredStatus).toBe(401);
  expect(result.revokedStatus).toBe(401);
  expect(result.publicHttpStatus).toBe(403);
  expect(result.plainHttpRejectedBeforeFetch).toBe(true);
  expect(result.plainHttpFetches).toBe(0);
  expect(result.requests.every(request => request.protocol === 'https:')).toBe(true);
  expect(result.requests.map(request => request.status)).toEqual([200, 401, 401, 200]);
  expect(result.requests.every(request => request.host === 'nexus.example.test' && Object.keys(request).length === 4)).toBe(true);
  expect(getElanousConfigDirOverride()).toBe(preservedConfigDir);
  } finally {
    if (priorConfigDir === undefined) resetElanousConfigDir();
    else setElanousConfigDir(priorConfigDir);
  }
});
