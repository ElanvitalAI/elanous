import { afterAll, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLauncherLeaseBoot, runNexus } from './index.js';
import { setTestStateRoot } from './paths.js';

const root = mkdtempSync(join(tmpdir(), 'nexus-lease-boot-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const original = {
  port: process.env.ELANOUS_TEST_COORDINATOR_LEASE_PORT,
  id: process.env.ELANOUS_TEST_COORDINATOR_LEASE_ID,
};
afterEach(() => {
  if (original.port === undefined) delete process.env.ELANOUS_TEST_COORDINATOR_LEASE_PORT;
  else process.env.ELANOUS_TEST_COORDINATOR_LEASE_PORT = original.port;
  if (original.id === undefined) delete process.env.ELANOUS_TEST_COORDINATOR_LEASE_ID;
  else process.env.ELANOUS_TEST_COORDINATOR_LEASE_ID = original.id;
  setTestStateRoot(null);
});

test('leased child refuses a mismatched HTTP port before acquiring a Nexus lock', async () => {
  setTestStateRoot(root);
  process.env.ELANOUS_TEST_COORDINATOR_LEASE_PORT = '31450';
  process.env.ELANOUS_TEST_COORDINATOR_LEASE_ID = 'lease-1';
  await expect(runNexus({ detachForTesting: true, httpStartPort: 31451 }))
    .rejects.toThrow('coordinator port lease boot mismatch');
  expect(existsSync(join(root, 'nexus', '.lock'))).toBe(false);
});

// 포트 비교 «자체»를 문다: 리스너가 켜져 있고(skipHttpServer:false) 인스턴스·ID·대역이 모두 맞는 상태에서 «포트만» 다르게 한다.
const leasedEnv = { ELANOUS_TEST_COORDINATOR_LEASE_PORT: '31450', ELANOUS_TEST_COORDINATOR_LEASE_ID: 'lease-1' } as NodeJS.ProcessEnv;
const listening = { detachForTesting: true, skipHttpServer: false } as const;

test('boot check refuses when only the HTTP port differs from the lease', () => {
  expect(() => checkLauncherLeaseBoot({ ...listening, httpStartPort: 31451 }, leasedEnv, () => 'test'))
    .toThrow('coordinator port lease boot mismatch');
  expect(() => checkLauncherLeaseBoot({ ...listening }, leasedEnv, () => 'test'))
    .toThrow('coordinator port lease boot mismatch');
});

test('control: the same conditions with a matching port pass the boot check', () => {
  expect(checkLauncherLeaseBoot({ ...listening, httpStartPort: 31450 }, leasedEnv, () => 'test')).toBe(31450);
  expect(checkLauncherLeaseBoot({ ...listening, httpStartPort: 31451 }, {}, () => 'test')).toBeUndefined();
});

test('boot check still refuses the other mismatches with a matching port', () => {
  expect(() => checkLauncherLeaseBoot({ ...listening, httpStartPort: 31450 }, leasedEnv, () => 'prod'))
    .toThrow('coordinator port lease boot mismatch');
  expect(() => checkLauncherLeaseBoot({ detachForTesting: true, httpStartPort: 31450 }, leasedEnv, () => 'test'))
    .toThrow('coordinator port lease boot mismatch');
  expect(() => checkLauncherLeaseBoot({ ...listening, httpStartPort: 31450 }, { ELANOUS_TEST_COORDINATOR_LEASE_PORT: '31450' }, () => 'test'))
    .toThrow('missing coordinator lease id');
});

test('leased child refuses a boot without an HTTP listener or lease identity', async () => {
  setTestStateRoot(root);
  process.env.ELANOUS_TEST_COORDINATOR_LEASE_PORT = '31450';
  process.env.ELANOUS_TEST_COORDINATOR_LEASE_ID = 'lease-1';
  await expect(runNexus({ detachForTesting: true, httpStartPort: 31450, skipHttpServer: true }))
    .rejects.toThrow('coordinator port lease boot mismatch');
  await expect(runNexus({ detachForTesting: true, httpStartPort: 31450 }))
    .rejects.toThrow('coordinator port lease boot mismatch');
  delete process.env.ELANOUS_TEST_COORDINATOR_LEASE_ID;
  await expect(runNexus({ detachForTesting: true, httpStartPort: 31450 }))
    .rejects.toThrow('missing coordinator lease id');
});
