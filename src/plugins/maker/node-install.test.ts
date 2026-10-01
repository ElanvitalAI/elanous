import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getNodeKindRegistration, listNodeKinds, unregisterPluginNodeKind } from '../../graph-kinds/registry.js';
import { installPlugin } from '../install/plugin-install.js';
import { addAndInstallNode } from './node-install.js';
import type { AddNodeResult } from './node-maker.js';

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'node-install-')); dirs.push(dir); return dir; };
afterEach(() => {
  const kind = getNodeKindRegistration('workflow', 'sample-plugin:send-digest');
  if (kind) unregisterPluginNodeKind('workflow', kind.kind, 'sample-plugin', kind);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const added = (dir: string, status: AddNodeResult['status'] = 'added'): AddNodeResult => ({
  status, dir, kind: 'send-digest', node: join(dir, 'nodes', 'send-digest.yaml'),
  errors: status === 'failed' ? ['invalid node'] : [], timings: { write: 3, validate: 4 },
  ...(status === 'added' ? { version: '1.2.4' } : {}),
});
const installed = (dir: string) => {
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.2.4',
    contributes: { nodes: ['./nodes/send-digest.yaml'] } }));
  writeFileSync(join(dir, 'nodes', 'send-digest.yaml'), 'kind: send-digest\ngraph: workflow\n');
  return { name: 'sample-plugin', version: '1.2.4', market: 'local', path: dir, sha256: null };
};

test('failed node creation preserves its errors and never installs or syncs', async () => {
  const dir = fixture();
  const calls: string[] = [];
  const result = await addAndInstallNode({ dir, request: 'send digest', deps: {
    addNode: async opts => { calls.push(`add:${opts.request}`); return added(dir, 'failed'); },
    installPlugin: async () => { calls.push('install'); return installed(dir); },
    sync: () => { calls.push('sync'); },
    listNodeKinds: () => { calls.push('list'); return []; },
  } });
  expect(calls).toEqual(['add:send digest']);
  expect(result).toMatchObject({ status: 'failed', errors: ['invalid node'],
    timings: { write: 3, validate: 4, install: 0, sync: 0 } });
});

test('successful creation installs once, syncs before checking the exact workflow kind', async () => {
  const dir = fixture();
  const calls: string[] = [];
  const result = await addAndInstallNode({ dir, request: 'send digest', kind: 'send-digest', deps: {
    addNode: async opts => { calls.push(`add:${opts.kind}`); return added(dir); },
    installPlugin: async (spec, opts) => { calls.push(`install:${spec}:${opts?.yes ?? false}`); return installed(dir); },
    sync: plugin => { calls.push(`sync:${plugin.path}`); },
    listNodeKinds: graph => { calls.push(`list:${graph}`); return [{
      graph: 'workflow', kind: 'sample-plugin:send-digest', plugin: 'sample-plugin', core: false, description: '',
    }]; },
  } });
  expect(calls).toEqual(['add:send-digest', `install:${dir}:false`, `sync:${dir}`, 'list:workflow']);
  expect(result).toMatchObject({ status: 'installed', kind: 'send-digest', plugin: 'sample-plugin',
    installedPath: dir, version: '1.2.4', errors: [], timings: { write: 3, validate: 4,
      install: expect.any(Number), sync: expect.any(Number) } });
});

test('a different plugin or kind does not count as the installed node', async () => {
  const dir = fixture();
  for (const entry of [
    { kind: 'other-plugin:send-digest', plugin: 'other-plugin' },
    { kind: 'sample-plugin:other-node', plugin: 'sample-plugin' },
  ]) {
    const result = await addAndInstallNode({ dir, request: 'send digest', deps: {
      addNode: async () => added(dir), installPlugin: async () => installed(dir), sync: () => {},
      listNodeKinds: () => [{ graph: 'workflow', core: false, description: '', ...entry }],
    } });
    expect(result.status).toBe('failed');
    expect(result.errors).toEqual(['node kind not registered: sample-plugin:send-digest']);
    expect(result.plugin).toBe('sample-plugin');
  }
});

test('sync failure prevents registry verification and reports the error', async () => {
  const dir = fixture();
  const calls: string[] = [];
  const result = await addAndInstallNode({ dir, request: 'send digest', deps: {
    addNode: async () => added(dir),
    installPlugin: async () => installed(dir),
    sync: () => { calls.push('sync'); throw new Error('sync denied'); },
    listNodeKinds: () => { calls.push('list'); return []; },
  } });
  expect(calls).toEqual(['sync']);
  expect(result).toMatchObject({ status: 'failed', errors: ['sync denied'], plugin: 'sample-plugin' });
});

test('install failure prevents sync and returns the creation result with an install error', async () => {
  const dir = fixture();
  let synced = false;
  const result = await addAndInstallNode({ dir, request: 'send digest', deps: {
    addNode: async () => added(dir), installPlugin: async () => { throw new Error('install denied'); },
    sync: () => { synced = true; },
  } });
  expect(synced).toBe(false);
  expect(result).toMatchObject({ status: 'failed', errors: ['install denied'], timings: { sync: 0 } });
});

test('capabilities require explicit consent and rejection prevents sync', async () => {
  const root = fixture();
  const dir = join(root, 'source');
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  writeFileSync(join(dir, 'plugin.ts'), 'export default {}');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.2.4',
    main: './plugin.ts', capabilities: ['network'], contributes: { nodes: ['./nodes/send-digest.yaml'] } }));
  writeFileSync(join(dir, 'nodes', 'send-digest.yaml'), 'kind: send-digest\ngraph: workflow\ninputs: { type: object }\nrun:\n  bash: echo ok\n');
  const calls: string[] = [];
  const make = (consent?: (capabilities: string[]) => boolean | Promise<boolean>) => addAndInstallNode({ dir, request: 'send digest', deps: {
    addNode: async () => added(dir),
    installPlugin: (spec, opts) => installPlugin(spec, { ...opts, root: join(root, 'state') }),
    ...(consent ? { consent } : {}),
  } });
  const withoutConsent = await make();
  expect(withoutConsent.status).toBe('failed');
  expect(withoutConsent.errors).toContain('plugin capabilities require consent');
  const denied = await make(capabilities => { calls.push(`declined:${capabilities.join(',')}`); return false; });
  expect(denied.status).toBe('failed');
  expect(denied.errors).toContain('plugin capabilities require consent');
  expect(listNodeKinds('workflow').some(entry => entry.kind === 'sample-plugin:send-digest')).toBe(false);
  expect(calls).toEqual(['declined:network']);
  const accepted = await make(capabilities => { calls.push(`accepted:${capabilities.join(',')}`); return true; });
  expect(accepted.status).toBe('installed');
  expect(accepted.errors).toEqual([]);
  expect(calls).toEqual(['declined:network', 'accepted:network']);
});

test('stale registry entry cannot confirm a new installed version without its node', async () => {
  const dir = fixture();
  const calls: string[] = [];
  const result = await addAndInstallNode({ dir, request: 'send digest', deps: {
    addNode: async () => added(dir),
    installPlugin: async () => {
      const plugin = installed(dir);
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.2.4', contributes: { nodes: [] } }));
      return plugin;
    },
    sync: () => { calls.push('sync'); },
    listNodeKinds: () => { calls.push('list'); return [{ graph: 'workflow', core: false, description: '',
      plugin: 'sample-plugin', kind: 'sample-plugin:send-digest' }]; },
  } });
  expect(result).toMatchObject({ status: 'failed', errors: ['installed node not found: sample-plugin:send-digest'] });
  expect(calls).toEqual([]);
});

test('a declared node with a different kind cannot be confirmed by a stale registry entry', async () => {
  const dir = fixture();
  const result = await addAndInstallNode({ dir, request: 'send digest', deps: {
    addNode: async () => added(dir),
    installPlugin: async () => {
      const plugin = installed(dir);
      writeFileSync(join(dir, 'nodes', 'send-digest.yaml'), 'kind: old-digest\ngraph: workflow\n');
      return plugin;
    },
    sync: () => {},
    listNodeKinds: () => [{ graph: 'workflow', core: false, description: '',
      plugin: 'sample-plugin', kind: 'sample-plugin:send-digest' }],
  } });
  expect(result).toMatchObject({ status: 'failed', errors: ['installed node not found: sample-plugin:send-digest'] });
});

test('real add, install and sync registers the installed workflow node', async () => {
  const root = fixture();
  const dir = join(root, 'source');
  mkdirSync(dir);
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.2.3', main: './plugin.ts' }));
  writeFileSync(join(dir, 'plugin.ts'), 'export default {}');
  const result = await addAndInstallNode({ dir, request: 'send digest', kind: 'send-digest', deps: {
    codex: async cwd => writeFileSync(join(cwd, 'nodes', 'send-digest.yaml'),
      'kind: send-digest\ngraph: workflow\ninputs: { type: object }\nrun:\n  bash: echo ok\n'),
    installPlugin: (spec, opts) => installPlugin(spec, { ...opts, root: join(root, 'state') }),
  } });
  expect(result).toMatchObject({ status: 'installed', plugin: 'sample-plugin', kind: 'send-digest', version: '1.2.4', errors: [] });
  expect(result.installedPath).toBe(join(root, 'state', 'plugins', 'local', 'sample-plugin', '1.2.4'));
  expect(listNodeKinds('workflow').some(entry => entry.plugin === 'sample-plugin' && entry.kind === 'sample-plugin:send-digest')).toBe(true);
  expect(readFileSync(join(result.installedPath!, 'plugin.json'), 'utf8')).toContain('send-digest.yaml');
});

test('--yes reaches the installer and the caller consent is used when it is not given', async () => {
  const dir = fixture();
  const seen: string[] = [];
  const deps = (consent: () => boolean) => ({
    addNode: async () => added(dir),
    installPlugin: async (_spec: string, opts?: { yes?: boolean; consent?: (c: string[]) => boolean | Promise<boolean> }) => {
      seen.push(`yes=${opts?.yes ?? 'unset'} consent=${await opts?.consent?.(['proc:bun'])}`);
      return installed(dir);
    },
    sync: () => {},
    listNodeKinds: () => [{ graph: 'workflow' as const, kind: 'sample-plugin:send-digest', plugin: 'sample-plugin', core: false, description: '' }],
    consent,
  });
  await addAndInstallNode({ dir, request: 'send digest', kind: 'send-digest', yes: true, deps: deps(() => false) });
  await addAndInstallNode({ dir, request: 'send digest', kind: 'send-digest', deps: deps(() => true) });
  expect(seen).toEqual(['yes=true consent=false', 'yes=unset consent=true']);
});
