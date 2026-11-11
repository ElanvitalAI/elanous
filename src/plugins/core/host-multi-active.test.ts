import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost, type HostHooks } from './host.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hooks: HostHooks = {
  log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {},
};

function fixture(configs: Array<{ id: string; multi?: boolean; deny?: string[] }>): PluginHost {
  const userDir = mkdtempSync(join(tmpdir(), 'elanous-multi-active-'));
  dirs.push(userDir);
  for (const { id, multi, deny } of configs) {
    const dir = join(userDir, id);
    mkdirSync(dir);
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
      id, name: id, version: '1.0.0', main: './plugin.ts',
      allowMultiActive: multi,
      activePeerCompat: deny ? { deny } : undefined,
    }));
    writeFileSync(join(dir, 'plugin.ts'), `export default {
      name: '${id}', version: '1.0.0', description: '', panes: {},
      initialState: () => ({ owner: '${id}' }),
      llmTools: [{ name: '${id}Tool', description: '', parameters: { type: 'object' },
        handler: async (_args, ctx) => ({ name: ctx.pluginName, owner: ctx.state.owner }) }],
    };`);
  }
  return new PluginHost(hooks, null, { userDir });
}

test('opted-in plugins coexist and keep their own tool contexts through focus changes', async () => {
  const host = fixture([{ id: 'alpha', multi: true }, { id: 'beta', multi: true }]);
  await host.discover();
  await host.activate('alpha');
  await host.activate('beta');
  expect(host.activePlugins().map(plugin => plugin.name)).toEqual(['alpha', 'beta']);
  expect(host.active()?.name).toBe('beta');
  expect(await host.dispatchTool('alphaTool', {})).toEqual({ ok: true, result: { name: 'alpha', owner: 'alpha' } });
  expect(await host.dispatchTool('betaTool', {})).toEqual({ ok: true, result: { name: 'beta', owner: 'beta' } });
  await host.deactivate('beta');
  expect(host.active()?.name).toBe('alpha');
  expect(await host.dispatchTool('betaTool', {})).toMatchObject({ ok: false });
  await host.deactivateAll();
  expect(host.activePlugins()).toEqual([]);
});

test('legacy single-active activation replaces the current plugin', async () => {
  const host = fixture([{ id: 'alpha' }, { id: 'beta', multi: true }]);
  await host.discover();
  await host.activate('alpha');
  await host.activate('beta');
  expect(host.activePlugins().map(plugin => plugin.name)).toEqual(['beta']);
  await host.deactivateAll();
});

test('peer denial leaves the current plugin running', async () => {
  const host = fixture([{ id: 'alpha', multi: true, deny: ['beta'] }, { id: 'beta', multi: true }]);
  await host.discover();
  await host.activate('alpha');
  await expect(host.activate('beta')).rejects.toThrow('deny-lists');
  expect(host.activePlugins().map(plugin => plugin.name)).toEqual(['alpha']);
  await host.deactivateAll();
});

test('multi-active plugins cannot claim the same pane key-routing slot', async () => {
  const host = fixture([{ id: 'alpha', multi: true }, { id: 'beta', multi: true }]);
  await host.discover();
  const alpha = host.list().find(entry => entry.manifest.id === 'alpha')!;
  const beta = host.list().find(entry => entry.manifest.id === 'beta')!;
  alpha.plugin.panes = { skills: {} as any };
  beta.plugin.panes = { skills: {} as any };

  await host.activate('alpha');
  await expect(host.activate('beta')).rejects.toThrow('pane slot "skills" is already owned by "alpha"');
  expect(host.activePlugins().map(plugin => plugin.name)).toEqual(['alpha']);
  await host.deactivateAll();
});

test('a failed peer activation does not lose the original tool surface', async () => {
  const host = fixture([{ id: 'alpha', multi: true }, { id: 'beta', multi: true }]);
  await host.discover();
  await host.activate('alpha');
  const beta = host.list().find(entry => entry.manifest.id === 'beta')!;
  beta.plugin.llmTools = [{
    name: 'alphaTool', description: '', parameters: { type: 'object' }, handler: async () => 'collision',
  }];
  await expect(host.activate('beta')).rejects.toThrow('already belongs to an active plugin');
  expect(host.activePlugins().map(plugin => plugin.name)).toEqual(['alpha']);
  expect(await host.dispatchTool('alphaTool', {})).toEqual({ ok: true, result: { name: 'alpha', owner: 'alpha' } });
  await host.deactivateAll();
});

test('a delayed teardown cleans only its owner when another plugin activates', async () => {
  const host = fixture([
    { id: 'alpha', multi: true }, { id: 'beta', multi: true }, { id: 'gamma', multi: true },
  ]);
  await host.discover();
  await host.activate('alpha');
  await host.activate('beta');
  let release!: () => void;
  host.activePlugins()[0]!.plugin.onDeactivate = async () => new Promise<void>(resolve => { release = resolve; });
  const removing = host.deactivate('alpha');
  await Promise.resolve();
  let activatedGamma = false;
  const activatingGamma = host.activate('gamma').then(() => { activatedGamma = true; });
  await Promise.resolve();
  expect(activatedGamma).toBe(false);
  release();
  await Promise.all([removing, activatingGamma]);
  expect(host.activePlugins().map(plugin => plugin.name)).toEqual(['beta', 'gamma']);
  expect(host.active()?.name).toBe('gamma');
  expect(await host.dispatchTool('betaTool', {})).toEqual({ ok: true, result: { name: 'beta', owner: 'beta' } });
  await host.deactivateAll();
});

test('a delayed teardown never restores a peer removed while it waited', async () => {
  const host = fixture([{ id: 'alpha', multi: true }, { id: 'beta', multi: true }]);
  await host.discover();
  await host.activate('alpha');
  await host.activate('beta');
  let release!: () => void;
  host.activePlugins()[0]!.plugin.onDeactivate = async () => new Promise<void>(resolve => { release = resolve; });
  const removingAlpha = host.deactivate('alpha');
  await Promise.resolve();
  let removedBeta = false;
  const removingBeta = host.deactivate('beta').then(() => { removedBeta = true; });
  await Promise.resolve();
  expect(removedBeta).toBe(false);
  release();
  await Promise.all([removingAlpha, removingBeta]);
  expect(host.activePlugins()).toEqual([]);
  expect(host.active()).toBeNull();
  expect(await host.dispatchTool('betaTool', {})).toMatchObject({ ok: false });
});

test('activation transitions serialize and each plugin receives its own context', async () => {
  const host = fixture([{ id: 'alpha', multi: true }, { id: 'beta', multi: true }]);
  await host.discover();
  const alpha = host.list().find(entry => entry.manifest.id === 'alpha')!;
  const beta = host.list().find(entry => entry.manifest.id === 'beta')!;
  let release!: () => void;
  let alphaEntered!: () => void;
  const alphaStarted = new Promise<void>(resolve => { alphaEntered = resolve; });
  const alphaGate = new Promise<void>(resolve => { release = resolve; });
  const contexts: Array<{ pluginName: string; owner: string }> = [];
  alpha!.plugin.onActivate = async ctx => {
    alphaEntered();
    contexts.push({ pluginName: ctx.pluginName, owner: (ctx.state as { owner: string }).owner });
    await alphaGate;
  };
  beta!.plugin.onActivate = async ctx => {
    contexts.push({ pluginName: ctx.pluginName, owner: (ctx.state as { owner: string }).owner });
  };

  const activatingAlpha = host.activate('alpha');
  await alphaStarted;
  let betaEntered = false;
  beta!.plugin.onActivate = async ctx => {
    betaEntered = true;
    contexts.push({ pluginName: ctx.pluginName, owner: (ctx.state as { owner: string }).owner });
  };
  const activatingBeta = host.activate('beta');
  await Promise.resolve();
  expect(betaEntered).toBe(false);
  release();
  await Promise.all([activatingAlpha, activatingBeta]);
  expect(contexts).toEqual([
    { pluginName: 'alpha', owner: 'alpha' },
    { pluginName: 'beta', owner: 'beta' },
  ]);
  expect(host.activePlugins().map(plugin => plugin.name)).toEqual(['alpha', 'beta']);
  await host.deactivateAll();
});

test('failed activation cleanup and a queued peer activation preserve the peer', async () => {
  const host = fixture([{ id: 'alpha', multi: true }, { id: 'beta', multi: true }]);
  await host.discover();
  const alpha = host.list().find(entry => entry.manifest.id === 'alpha')!;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  alpha!.plugin.onActivate = async () => {
    entered();
    await gate;
    throw new Error('activation failed after setup');
  };

  const failed = host.activate('alpha').then(() => null, error => error);
  await started;
  const activatingBeta = host.activate('beta');
  release();
  expect(await failed).toBeInstanceOf(Error);
  await activatingBeta;
  expect(host.activePlugins().map(plugin => plugin.name)).toEqual(['beta']);
  expect(await host.dispatchTool('betaTool', {})).toEqual({ ok: true, result: { name: 'beta', owner: 'beta' } });
  await host.deactivateAll();
});

test('reactivation requested during async teardown runs after teardown completes', async () => {
  const host = fixture([{ id: 'alpha', multi: true }]);
  await host.discover();
  await host.activate('alpha');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let deactivateCalls = 0;
  const alpha = host.active()!;
  alpha.plugin.onDeactivate = async () => {
    deactivateCalls++;
    entered();
    await gate;
  };

  const deactivating = host.deactivate('alpha');
  await started;
  let reactivated = false;
  const activating = host.activate('alpha').then(() => { reactivated = true; });
  await Promise.resolve();
  expect(reactivated).toBe(false);
  release();
  await Promise.all([deactivating, activating]);
  expect(deactivateCalls).toBe(1);
  expect(host.activePlugins().map(plugin => plugin.name)).toEqual(['alpha']);
  expect(await host.dispatchTool('alphaTool', {})).toEqual({ ok: true, result: { name: 'alpha', owner: 'alpha' } });
  await host.deactivateAll();
});
