import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createDashboardPluginRouteAdapter } from '../dashboard/plugin-route-adapter.js';
import { toolSurface } from '../boot/daemon-tools/index.js';

const prompt = '강의 노트·스크랩 앱 만들어 배포해 줘';
const args = { appId: 'lecture-scrap', requestText: prompt };

// Execute on node-b: network-zero world creation requires macOS sandbox-exec.
test.skipIf(process.platform !== 'darwin')('classic/next TUI and PWA chat execute the same registered app simulation before publishing', async () => {
  const adapter = createDashboardPluginRouteAdapter({
    pluginRoot: resolve(import.meta.dir, '../../plugins'),
    dispatchCore: async () => { throw new Error('app deploy must not call a release core tool'); },
  });
  expect(adapter.classicHostTools([]).some(tool => tool.name === 'app_deploy')).toBe(true);
  expect(adapter.nextHostTools([]).some(tool => tool.name === 'app_deploy')).toBe(true);
  const tui = await adapter.dispatch('app_deploy', args);
  expect(tui).toMatchObject({ ok: true, result: { kind: 'site-deploy', status: 'simulated' } });
  expect((tui as { result: { publicUrl?: string } }).result.publicUrl).toBeUndefined();

  const pwaSurface = toolSurface('chat');
  expect(pwaSurface.specs.some(tool => tool.name === 'app_deploy')).toBe(true);
  const pwa = await pwaSurface.dispatch('app_deploy', args, { cwd: process.cwd(), signal: new AbortController().signal });
  expect(pwa).toMatchObject({ kind: 'site-deploy', status: 'simulated' });
  expect((pwa as { publicUrl?: string }).publicUrl).toBeUndefined();
}, 300_000);
