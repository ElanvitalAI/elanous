import { expect, test } from 'bun:test';
import { createVerifiedAppSiteDeployPublisher } from './app-site-deploy.js';

test('verified agent publisher uses the deploy pipeline and rejects an owner mismatch', async () => {
  const stages: string[] = [];
  const owner = { appSlug: 'lecture-scrap', memberId: 'member-7', userSlug: 'kaist-demo', plan: 'free', entitlements: {} };
  const hook = createVerifiedAppSiteDeployPublisher({
    configuredPublicUserId: 'kaist-demo', resolveOwner: async () => null,
    createFromTemplate: async () => { stages.push('create'); return { appRoot: '/sim/app' }; },
    build: async () => { stages.push('build'); return { appRoot: '/sim/out', verifyText: 'receipt-marker' }; },
    publish: async () => { stages.push('publish'); },
    verify: async () => { stages.push('verify'); return { status: 200, body: 'receipt-marker' }; },
  });
  await expect(hook.publish({ appId: 'lecture-scrap', ownerUserId: 'someone-else', owner, simulationReceipt: 'sim-1' })).rejects.toThrow('owner mismatch');
  expect(stages).toEqual([]);
  expect(await hook.publish({ appId: 'lecture-scrap', ownerUserId: 'kaist-demo', owner, simulationReceipt: 'sim-1' }))
    .toEqual({ publicUrl: 'https://lecture-scrap--kaist-demo.elanous.app' });
  expect(stages).toEqual(['create', 'build', 'publish', 'verify']);
});
