import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginRouteAdapter } from '../plugins/core/route-adapter.js';
import { buildReplTools } from './index.js';
import { takeHydratedTools, CAPABILITY_SEARCH_NAME } from '../skills/tools/tool-search-spec.js';
const roots: string[] = [];
const validHost = { surface: 'tui' as const, verifiedOwner: { id: 'synthetic-host-owner' },
  fileArtifactAuthority: { ownerId: 'synthetic-host-owner', runId: 'synthetic-host-run', approved: true as const } };
const builtinPlugins = fileURLToPath(new URL('../../plugins/', import.meta.url));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('actual provider search terms discover a callable general app creator', async () => {
  const route = createPluginRouteAdapter({ pluginRoot: builtinPlugins, dispatchCore: async () => null, getDispatchContext: () => validHost });
  const tools = buildReplTools({ pluginRuntime: { hostTools: route.hostTools([]),
    dispatchPluginTool: async (name, args) => await route.dispatch(name, args) ?? { ok: false, error: 'unknown tool' } } });
  for (const query of ['web application deployment', 'database create populate']) {
    const hydrated = takeHydratedTools(await tools.dispatch(CAPABILITY_SEARCH_NAME, { query }));
    expect(hydrated.map(tool => tool.name)).toContain('app_create');
  }
  const root = mkdtempSync(join(tmpdir(), 'app-create-dispatch-')); roots.push(root);
  const appRoot = join(root, 'app');
  const result = await tools.dispatch('app_create', { root: appRoot, metadata: { runtime: { startCommand: ['bun', 'run', 'start'], port: 31582, healthPath: '/health' } },
    files: [{ path: 'ARCHITECTURE.md', content: '# Application architecture' }, { path: 'index.html', content: '<main>Generic application</main>' }] });
  expect(JSON.stringify(result)).toContain('source-artifact@1');
  expect(readFileSync(join(appRoot, 'index.html'), 'utf8')).toContain('Generic application');
});


test('file creation cannot omit or override host approval and fails closed without context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-create-approval-')); roots.push(root);
  const target = join(root, 'must-not-exist');
  const args = { root: target, files: [{ path: 'index.html', content: 'synthetic' }], metadata: {} };
  const pluginRoot = fileURLToPath(new URL('../../plugins/', import.meta.url));
  const host = createPluginRouteAdapter({ pluginRoot, dispatchCore: async () => null,
    getDispatchContext: () => ({ ...validHost, requireApproval: true }) });
  for (const context of [{ surface: 'tui' as const }, { surface: 'tui' as const, requireApproval: false }]) {
    const denied = await host.dispatch('app_create', args, false, context);
    expect(denied).toEqual({ ok: false, error: 'file artifact creation requires approval in this context' });
    expect(existsSync(target)).toBe(false);
  }
  const absent = createPluginRouteAdapter({ pluginRoot, dispatchCore: async () => null });
  expect(await absent.dispatch('app_create', args)).toEqual({ ok: false, error: 'file artifact creation context required: app_create writes only inside a member app_build run (eln member connect).' });
  expect(existsSync(target)).toBe(false);
  const failed = createPluginRouteAdapter({ pluginRoot, dispatchCore: async () => null,
    getDispatchContext: () => { throw new Error('synthetic context failure'); } });
  expect(await failed.dispatch('app_create', args)).toEqual({ ok: false, error: 'file artifact creation context unavailable' });
  expect(existsSync(target)).toBe(false);
});


test('undefined host context cannot be replaced by caller approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-create-missing-host-')); roots.push(root);
  const target = join(root, 'must-not-exist');
  const adapter = createPluginRouteAdapter({
    pluginRoot: fileURLToPath(new URL('../../plugins/', import.meta.url)),
    dispatchCore: async () => null,
    getDispatchContext: () => undefined as unknown as Partial<import('../tool-runtime/types.js').ToolRuntimeContext>,
  });
  const result = await adapter.dispatch('app_create', {
    root: target, files: [{ path: 'index.html', content: 'synthetic' }], metadata: {},
  }, true, { surface: 'tui', requireApproval: false });
  expect(result).toEqual({ ok: false, error: 'file artifact creation context required: app_create writes only inside a member app_build run (eln member connect).' });
  expect(existsSync(target)).toBe(false);
});


test('host owner run and explicit approval are all mandatory before any write', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'app-create-host-matrix-')); roots.push(parent);
  const target = join(parent, 'must-not-exist');
  const grant = validHost.fileArtifactAuthority;
  const invalid: unknown[] = [undefined, null, {},
    { ...validHost, verifiedOwner: undefined }, { ...validHost, verifiedOwner: {} },
    { ...validHost, verifiedOwner: { id: '' } }, { ...validHost, verifiedOwner: { id: 7 } },
    { ...validHost, fileArtifactAuthority: undefined },
    { ...validHost, fileArtifactAuthority: { runId: grant.runId, approved: true } },
    { ...validHost, fileArtifactAuthority: { ownerId: grant.ownerId, approved: true } },
    { ...validHost, fileArtifactAuthority: { ownerId: grant.ownerId, runId: grant.runId } },
    { ...validHost, fileArtifactAuthority: { ...grant, ownerId: '' } },
    { ...validHost, fileArtifactAuthority: { ...grant, ownerId: 'foreign-owner' } },
    { ...validHost, fileArtifactAuthority: { ...grant, runId: ' ' } },
    { ...validHost, fileArtifactAuthority: { ...grant, runId: false } },
    { ...validHost, fileArtifactAuthority: { ...grant, approved: false } },
    { ...validHost, fileArtifactAuthority: { ...grant, approved: 'true' } },
  ];
  for (const host of invalid) {
    const adapter = createPluginRouteAdapter({ pluginRoot: builtinPlugins, dispatchCore: async () => null,
      getDispatchContext: () => host as Partial<import('../tool-runtime/types.js').ToolRuntimeContext> });
    const result = await adapter.dispatch('app_create', {
      root: target, files: [{ path: 'index.html', content: 'synthetic' }], metadata: {},
    }, true, validHost);
    expect(result).toEqual({ ok: false, error: 'file artifact creation context required: app_create writes only inside a member app_build run (eln member connect).' });
    expect(existsSync(target)).toBe(false);
  }
});
