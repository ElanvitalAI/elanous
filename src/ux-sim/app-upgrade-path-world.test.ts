import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runAppDeployUpgrade, setAppDeployUpgradeHook } from '../agent/app-deploy-plugin.js';
import { createAppUpgradePathWorld } from './app-upgrade-path-world.js';

const worlds: ReturnType<typeof createAppUpgradePathWorld>[] = [];
afterEach(() => { setAppDeployUpgradeHook(undefined); for (const world of worlds.splice(0)) world.close(); });

function world(options: { readonly failVerification?: boolean } = {}) {
  const created = createAppUpgradePathWorld(options);
  worlds.push(created);
  return created;
}

describe('APP-UPGRADE-PATH', () => {
  test('copies v1 source, applies and simulates the feature, then publishes v2 at the same public URL', async () => {
    const sim = world();
    setAppDeployUpgradeHook(sim.hook);
    const input = { appId: 'lecture-scrap', target: sim.sourceRoot, requestText: 'add feature search', ownerUserId: 'member-demo' } as const;
    const result = await runAppDeployUpgrade(input);

    expect(result).toMatchObject({ kind: 'site-deploy', status: 'published',
      publicUrl: 'https://lecture-scrap--member-demo.elanous.app', simulationReceipt: 'upgrade-receipt-v2' });
    const live = sim.host.fetch('lecture-scrap.app.sim.invalid', '/');
    expect(live).toMatchObject({ status: 200, body: '<main>lecture notes v1</main>', headers: { 'x-app-version': 'v2' } });
    expect(sim.host.fetch('lecture-scrap.app.sim.invalid', '/src/feature.txt')).toMatchObject({ status: 200, body: 'add feature search\n' });
    expect(readFileSync(join(sim.sourceRoot, 'index.html'), 'utf8')).toBe('<main>lecture notes v1</main>');
    expect(readdirSync(sim.sourceRoot)).toEqual(['index.html']);
    expect(sim.source.records().map(record => record.kind)).toEqual(['source-snapshot-created', 'source-snapshot-restored']);
    expect(sim.lifecycleSnapshot()).toMatchObject({ status: 'live', currentVersion: 'v2', previousVersion: 'v1',
      latestEvent: { action: 'upgrade', outcome: 'succeeded', appVersion: 'v2' } });
  });

  test('rolls back to v1 and records the failed upgrade when public verification fails', async () => {
    const sim = world({ failVerification: true });
    setAppDeployUpgradeHook(sim.hook);
    const result = await runAppDeployUpgrade({ appId: 'lecture-scrap', target: sim.sourceRoot,
      requestText: 'add feature search', ownerUserId: 'member-demo' });

    expect(result).toMatchObject({ status: 'failed', error: 'upgraded app public verification failed' });
    expect(sim.host.fetch('lecture-scrap.app.sim.invalid', '/')).toMatchObject({ status: 200,
      body: '<main>lecture notes v1</main>', headers: { 'x-app-version': 'v1' } });
    expect(sim.lifecycleSnapshot()).toMatchObject({ status: 'live', currentVersion: 'v1',
      latestEvent: { action: 'upgrade', outcome: 'failed', reasonCode: 'operation-failed' } });
  });

  test('reports rollback failure and records that the failed version may still be live', async () => {
    const sim = world({ failVerification: true, failRollback: true });
    setAppDeployUpgradeHook(sim.hook);
    const result = await runAppDeployUpgrade({ appId: 'lecture-scrap', target: sim.sourceRoot,
      requestText: 'add feature search', ownerUserId: 'member-demo' });

    expect(result).toMatchObject({ status: 'failed', error: 'app upgrade failed and rollback failed; operator recovery is required' });
    expect(sim.host.fetch('lecture-scrap.app.sim.invalid', '/').headers['x-app-version']).toBe('v2');
    expect(sim.lifecycleEvents()).toContainEqual(expect.objectContaining({ action: 'rolled-back', outcome: 'failed',
      appVersion: 'v2', reasonCode: 'operation-failed' }));
  });

  test('rejects a workspace whose source is the live target and never publishes', async () => {
    const sim = world();
    setAppDeployUpgradeHook({
      ...sim.hook,
      async prepare(input) {
        return { sourceRoot: input.target, previousVersion: 'v1', publicUrl: 'https://lecture-scrap--member-demo.elanous.app', cleanup() {} };
      },
    });
    const result = await runAppDeployUpgrade({ appId: 'lecture-scrap', target: sim.sourceRoot,
      requestText: 'add feature search', ownerUserId: 'member-demo' });

    expect(result).toMatchObject({ status: 'failed', error: 'invalid app upgrade workspace' });
    expect(sim.host.fetch('lecture-scrap.app.sim.invalid', '/').headers['x-app-version']).toBe('v1');
  });

  test('rejects symlinked or nested live-source workspaces before editing', async () => {
    for (const shape of ['symlink', 'nested'] as const) {
      const sim = world();
      const unsafePath = join(sim.sourceRoot, shape === 'nested' ? 'nested-copy' : 'symlink-copy');
      if (shape === 'nested') mkdirSync(unsafePath);
      else symlinkSync(sim.sourceRoot, unsafePath, 'dir');
      setAppDeployUpgradeHook({
        ...sim.hook,
        async prepare() { return { sourceRoot: unsafePath, previousVersion: 'v1',
          publicUrl: 'https://lecture-scrap--member-demo.elanous.app', cleanup() {} }; },
      });
      const result = await runAppDeployUpgrade({ appId: 'lecture-scrap', target: sim.sourceRoot,
        requestText: 'add feature search', ownerUserId: 'member-demo' });
      expect(result).toMatchObject({ status: 'failed', error: 'invalid app upgrade workspace' });
      expect(readFileSync(join(sim.sourceRoot, 'index.html'), 'utf8')).toBe('<main>lecture notes v1</main>');
    }
  });
});
