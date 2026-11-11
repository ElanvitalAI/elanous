import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createAppLifecycleStore } from '../nexus/apps/app-db.js';
import { createAppLifecycleEvent, type AppLifecycleEvent, type AppLifecycleSnapshot } from '../nexus/apps/app-lifecycle-ledger.js';
import type { AppDeployUpgradeHook, AppDeployUpgradeInput } from '../agent/app-deploy-plugin.js';
import type { AppSimulationResult } from '../nexus/apps/app-simulation.js';
import { createFakeAppHost, type FakeAppHost } from './fake-app-host.js';
import { createFakeAppSourceWorld, type FakeAppSourceWorld } from './fake-app-source-world.js';

const APP_ID = 'lecture-scrap';
const OWNER_ID = 'member-demo';
const PUBLIC_URL = `https://${APP_ID}--${OWNER_ID}.elanous.app`;

export interface AppUpgradePathWorld {
  readonly hook: AppDeployUpgradeHook;
  readonly host: FakeAppHost;
  readonly source: FakeAppSourceWorld;
  readonly sourceRoot: string;
  lifecycleSnapshot(): AppLifecycleSnapshot | null;
  lifecycleEvents(): AppLifecycleEvent[];
  close(): void;
}

function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[relative(root, path).split('\\').join('/')] = readFileSync(path, 'utf8');
    }
  };
  visit(root);
  return files;
}

function fingerprint(files: Readonly<Record<string, string>>): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
}

/** Wires the production upgrade transaction through the existing fake source and app-host devices. */
export function createAppUpgradePathWorld(options: { readonly failVerification?: boolean; readonly failRollback?: boolean } = {}): AppUpgradePathWorld {
  const root = mkdtempSync(join(tmpdir(), 'app-upgrade-path-'));
  const sourceRoot = join(root, 'source');
  const restoreBase = join(root, 'restore-base');
  const isolatedRoot = join(root, 'isolated');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, 'index.html'), '<main>lecture notes v1</main>');
  const ledger = createAppLifecycleStore(join(root, 'lifecycle.sqlite'));
  const source = createFakeAppSourceWorld(join(root, 'source-world'));
  const host = createFakeAppHost([{ slug: APP_ID, current: 'v1', versions: [{ id: 'v1', files: {
    'index.html': '<main>lecture notes v1</main>',
  } }] }]);
  host.deploy(APP_ID, 'v1');
  ledger.ensureCreated(createAppLifecycleEvent({ appId: APP_ID, action: 'created', environment: 'live', actor: 'user', appVersion: 'v1' }, {
    id: () => 'upgrade-world-created', now: () => new Date('2026-11-09T00:00:00.000Z'),
  }));
  ledger.appendEvent(createAppLifecycleEvent({ appId: APP_ID, action: 'promoted', environment: 'live', actor: 'user', appVersion: 'v1' }, {
    id: () => 'upgrade-world-promoted', now: () => new Date('2026-11-09T00:00:01.000Z'),
  }));
  let nextLifecycleId = 0;
  const hook: AppDeployUpgradeHook = {
    async prepare(input) {
      if (resolve(input.target) !== resolve(sourceRoot)) throw new Error('upgrade target does not match app source');
      const snapshot = source.snapshot({ appSlug: input.appId, deploymentId: 'upgrade-v2', sourceRoot });
      cpSync(sourceRoot, restoreBase, { recursive: true, errorOnExist: true });
      const restored = source.restore({ appSlug: input.appId, deploymentId: 'upgrade-v2', sourceRoot: restoreBase, expectedFingerprint: snapshot.fingerprint });
      cpSync(restored.nextBuildInput.sourcePath, isolatedRoot, { recursive: true, errorOnExist: true });
      return { sourceRoot: isolatedRoot, previousVersion: 'v1', publicUrl: PUBLIC_URL,
        cleanup: () => { rmSync(isolatedRoot, { recursive: true, force: true }); rmSync(restoreBase, { recursive: true, force: true }); } };
    },
    async applyChange(input) {
      if (resolve(input.sourceRoot) !== resolve(isolatedRoot)) throw new Error('change target escaped isolated source');
      mkdirSync(dirname(join(isolatedRoot, 'src', 'feature.txt')), { recursive: true });
      writeFileSync(join(isolatedRoot, 'src', 'feature.txt'), `${input.requestText.trim()}\n`);
    },
    async simulate(input): Promise<AppSimulationResult> {
      if (resolve(input.sourceRoot) !== resolve(isolatedRoot) || readFileSync(join(sourceRoot, 'index.html'), 'utf8') !== '<main>lecture notes v1</main>') {
        throw new Error('upgrade simulation observed non-isolated source');
      }
      return { runId: 'upgrade-sim-v2', events: [{ kind: 'app.sim.step', appId: input.appId, runId: 'upgrade-sim-v2',
        ts: 1, data: { step: 'feature-build', message: 'isolated feature build passed', receiptId: 'upgrade-receipt-v2' } }],
      receipts: [{ id: 'upgrade-receipt-v2', appId: input.appId, runId: 'upgrade-sim-v2', outcome: 'passed', summary: 'v1 to v2 passed' }] };
    },
    async publish(input) {
      if (input.publicUrl !== PUBLIC_URL || input.previousVersion !== 'v1') throw new Error('upgrade must preserve the existing public address');
      const files = readTree(input.sourceRoot);
      if (!files['src/feature.txt']) throw new Error('feature change is missing');
      host.deployArtifact(APP_ID, { id: 'v2', files });
      return { publicUrl: PUBLIC_URL, version: 'v2', fingerprint: fingerprint(files) };
    },
    async verifyPublicUrl() {
      if (options.failVerification) return false;
      const response = host.fetch(`${APP_ID}.app.sim.invalid`, '/');
      return response.status === 200 && response.headers['x-app-version'] === 'v2' && response.body.includes('lecture notes v1');
    },
    async rollback() {
      if (options.failRollback) throw new Error('simulated rollback failure');
      host.rollback(APP_ID);
    },
    recordLifecycle(input) {
      ledger.appendEvent(createAppLifecycleEvent(input, { id: () => `upgrade-world-event-${++nextLifecycleId}` }));
    },
  };
  return { hook, host, source, sourceRoot, lifecycleSnapshot: () => ledger.snapshot(APP_ID), lifecycleEvents: () => ledger.events(APP_ID),
    close() { source.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); } };
}
