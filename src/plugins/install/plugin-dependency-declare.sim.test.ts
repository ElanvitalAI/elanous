import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIndexKeyPair, signIndex } from '../../market/signed-index.js';
import { addMarket } from './market-fetch.js';
import { installPlugin, listInstalledPlugins, removePlugin, resolvePluginSource } from './plugin-install.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fakeSignedMarket(declarations: Record<string, unknown[]>, variants: Record<string, Record<string, unknown[]>> = {},
  packRequirements: Record<string, string[]> = {}, runtimeRequirements: Record<string, unknown[]> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-dependency-market-'));
  roots.push(root);
  const archiveBytes = new Map<string, Buffer>();
  const packages = [
    ...Object.entries(declarations).map(([name, plugins]) => ({ name, version: '1.0.0', plugins })),
    ...Object.entries(variants).flatMap(([name, byVersion]) => Object.entries(byVersion).map(([version, plugins]) => ({ name, version, plugins }))),
  ];
  const entries = packages.map(({ name, version, plugins }) => {
    const source = join(root, `${name}-${version}`);
    mkdirSync(source);
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: name, version, main: './plugin.ts',
      dependencies: { plugins, runtime: runtimeRequirements[name] ?? [] }, requires: { knowledgePacks: packRequirements[name] ?? [] } }));
    if (runtimeRequirements[name]?.length) {
      mkdirSync(join(source, 'runtime'));
      writeFileSync(join(source, 'runtime', 'pyproject.toml'), '[project]\nname="fake-renderer"\nversion="1.0.0"\nrequires-python=">=3.11"\n');
    }
    writeFileSync(join(source, 'plugin.ts'), 'export default {}');
    const artifactKey = version === '1.0.0' ? `${name}.tgz` : `${name}-${version}.tgz`;
    const archive = join(root, artifactKey);
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    const bytes = readFileSync(archive);
    archiveBytes.set(artifactKey, bytes);
    return { name, version, source: { source: 'local' },
      artifact: { key: artifactKey, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
      'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } };
  });
  const knowledgePacks = [...new Set(Object.values(packRequirements).flat())].map(name => {
    const source = join(root, `pack-${name}`);
    mkdirSync(source);
    writeFileSync(join(source, 'README.md'), `pack ${name}\n`);
    const key = `${name}.tgz`;
    const archive = join(root, key);
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    const bytes = readFileSync(archive);
    archiveBytes.set(key, bytes);
    return { name, version: '1.0.0', visibility: 'public' as const,
      artifact: { key, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length } };
  });
  const index = Buffer.from(JSON.stringify({ name: 'dependency-market', interface: { displayName: 'Dependency fixture' },
    sequence: 1, plugins: entries, knowledgePacks }));
  const keys = generateIndexKeyPair();
  const signature = signIndex(index, keys.privateKeyPem, keys.keyId);
  const configPath = join(root, 'config.json');
  addMarket('dependency-market', 'https://example.org/dependency/', { configPath });
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/marketplace.json')) return new Response(index);
    if (url.endsWith('/index.sig')) return new Response(signature);
    const key = url.split('/').at(-1)!;
    const bytes = archiveBytes.get(key);
    if (!bytes) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(bytes));
  }) as typeof fetch;
  const installRoot = join(root, 'installed');
  const opts = { root: installRoot, configPath, fetcher,
    trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }], yes: true };
  return { installRoot, opts, requests, sourceRoot: root, index, signature, archiveBytes };
}

test('signed market prepares declared uv extras and Chromium before recording a plugin, and fails closed on preparation error', async () => {
  const runtime = [{ kind: 'uv-python', project: 'runtime', extras: ['render'], browser: 'chromium' }];
  const ready = fakeSignedMarket({ 'root-plugin': [] }, {}, {}, { 'root-plugin': runtime });
  const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  await installPlugin('root-plugin@dependency-market', { ...ready.opts,
    consent: async capabilities => capabilities.includes('runtime:uv-python'),
    runRuntimeCommand: (command: string, args: readonly string[], cwd: string) => {
      commands.push({ command, args, cwd });
      return { status: 0 };
    },
  });
  expect(commands.map(({ command, args }) => [command, ...args])).toEqual([
    ['uv', 'sync', '--extra', 'render'],
    ['uv', 'run', '--extra', 'render', 'python', '-m', 'playwright', 'install', 'chromium'],
  ]);
  expect(commands.every(({ cwd }) => cwd.endsWith('/root-plugin/1.0.0/runtime'))).toBe(true);
  expect(listInstalledPlugins(ready.installRoot).map(item => item.name)).toEqual(['root-plugin']);

  const failed = fakeSignedMarket({ 'root-plugin': [] }, {}, {}, { 'root-plugin': runtime });
  await expect(installPlugin('root-plugin@dependency-market', { ...failed.opts,
    consent: async capabilities => capabilities.includes('runtime:uv-python'),
    runRuntimeCommand: () => ({ status: 1, stderr: 'private machine detail' }),
  })).rejects.toThrow('runtime preparation failed');
  expect(listInstalledPlugins(failed.installRoot)).toEqual([]);
  expect(existsSync(join(failed.installRoot, 'plugins', 'dependency-market', 'root-plugin', '1.0.0'))).toBe(false);
  const denied = fakeSignedMarket({ 'root-plugin': [] }, {}, {}, { 'root-plugin': runtime });
  await expect(installPlugin('root-plugin@dependency-market', { ...denied.opts,
    runRuntimeCommand: () => { throw new Error('must not run'); },
  })).rejects.toThrow('explicit approval');
  expect(listInstalledPlugins(denied.installRoot)).toEqual([]);
});

test('bundled local plugin installs its required sibling before the root and blocks removing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-local-dependency-'));
  roots.push(root);
  const sources = join(root, 'sources');
  const installedRoot = join(root, 'installed');
  for (const [name, dependencies] of [
    ['base-plugin', []], ['root-plugin', ['base-plugin@^1.0.0']],
  ] as const) {
    const source = join(sources, name);
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: name, version: '1.0.0', main: './plugin.ts',
      dependencies: { plugins: dependencies } }));
    writeFileSync(join(source, 'plugin.ts'), 'export default {}');
    mkdirSync(join(source, 'sim'));
    writeFileSync(join(source, 'sim', 'runtime-data.txt'), 'retained for local plugins');
  }
  await installPlugin(join(sources, 'root-plugin'), { root: installedRoot, yes: true });
  const installed = listInstalledPlugins(installedRoot);
  expect(installed.map(item => item.name)).toEqual(['base-plugin', 'root-plugin']);
  expect(readFileSync(join(installedRoot, 'plugins', 'local', 'root-plugin', '1.0.0', 'sim', 'runtime-data.txt'), 'utf8'))
    .toBe('retained for local plugins');
  expect(new Set(installed.map(item => item.installBundleId)).size).toBe(1);
  expect(() => removePlugin('base-plugin', installedRoot)).toThrow('required by installed plugin');
});

test('GCP architecture bundle declares and prepares its PDF renderer before the demo plugin is installed', async () => {
  const state = mkdtempSync(join(tmpdir(), 'plugin-demo-architecture-'));
  roots.push(state);
  const commands: Array<{ args: readonly string[]; cwd: string }> = [];
  await installPlugin(join(import.meta.dir, '../../../plugins/gcp-architect-expand'), { root: state, yes: true,
    runRuntimeCommand: (_command, args, cwd) => { commands.push({ args, cwd }); return { status: 0 }; },
  });
  expect(listInstalledPlugins(state).map(item => item.name)).toEqual(['architecture-deliverables', 'gcp-architect-expand']);
  expect(existsSync(join(state, 'plugins', 'local', 'gcp-architect-expand', '0.1.0', 'sim'))).toBe(false);
  expect(commands.map(({ args }) => args)).toEqual([
    ['sync', '--extra', 'python-engines'],
    ['run', '--extra', 'python-engines', 'python', '-m', 'playwright', 'install', 'chromium'],
  ]);
  expect(commands.every(({ cwd }) => cwd.endsWith('/skills/diagram-master/references'))).toBe(true);
});

test('signed market installs a required dependency graph as one recorded bundle and blocks removing its base', async () => {
  const fixture = fakeSignedMarket({
    'base-plugin': [],
    'middle-plugin': ['base-plugin@^1.0.0'],
    'root-plugin': ['middle-plugin@^1.0.0', { id: 'missing-optional', version: '^1.0.0', optional: true }],
  });
  const root = await installPlugin('root-plugin@dependency-market', fixture.opts);
  const installed = listInstalledPlugins(fixture.installRoot);
  expect(installed.map(item => item.name)).toEqual(['base-plugin', 'middle-plugin', 'root-plugin']);
  // Source: fakeSignedMarket fixture has one root and two required installed dependencies.
  expect(new Set(installed.map(item => item.installBundleId)).size).toBe(1);
  expect(root.installBundleId).toBeTruthy();
  expect(fixture.requests.some(url => url.endsWith('/base-plugin.tgz'))).toBe(true);
  expect(fixture.requests.some(url => url.endsWith('/missing-optional.tgz'))).toBe(false);
  expect(() => removePlugin('base-plugin', fixture.installRoot)).toThrow('required by installed plugin');
  expect(listInstalledPlugins(fixture.installRoot)).toEqual(installed);
});

test('signed market rejects dependency cycles and incompatible ranges without leaving installations', async () => {
  const cycle = fakeSignedMarket({ 'root-plugin': ['base-plugin@^1.0.0'], 'base-plugin': ['root-plugin@^1.0.0'] });
  await expect(installPlugin('root-plugin@dependency-market', cycle.opts)).rejects.toThrow('dependency cycle');
  expect(listInstalledPlugins(cycle.installRoot)).toEqual([]);

  const conflict = fakeSignedMarket({ 'root-plugin': ['base-plugin@^2.0.0'], 'base-plugin': [] });
  await expect(installPlugin('root-plugin@dependency-market', conflict.opts)).rejects.toThrow('version conflict');
  expect(listInstalledPlugins(conflict.installRoot)).toEqual([]);
});

test('failed later dependency rolls back an earlier committed dependency', async () => {
  const fixture = fakeSignedMarket({
    'base-plugin': [],
    'root-plugin': ['base-plugin@^1.0.0', 'missing-plugin@^1.0.0'],
  });
  await expect(installPlugin('root-plugin@dependency-market', fixture.opts)).rejects.toThrow('required plugin not found');
  expect(fixture.requests.some(url => url.endsWith('/base-plugin.tgz'))).toBe(true);
  expect(listInstalledPlugins(fixture.installRoot)).toEqual([]);
});

test('failed bundle removes the knowledge pack committed with an earlier dependency', async () => {
  const fixture = fakeSignedMarket({
    'base-plugin': [],
    'root-plugin': ['base-plugin@^1.0.0', 'missing-plugin@^1.0.0'],
  }, {}, { 'base-plugin': ['base-pack'] });
  await expect(installPlugin('root-plugin@dependency-market', fixture.opts)).rejects.toThrow('required plugin not found');
  expect(fixture.requests.some(url => url.endsWith('/base-pack.tgz'))).toBe(true);
  expect(listInstalledPlugins(fixture.installRoot)).toEqual([]);
  expect(existsSync(join(fixture.installRoot, 'knowledge-packs', 'dependency-market', 'base-pack', '1.0.0'))).toBe(false);
});

test('market chooses the newest requested plugin and reconciles shared dependency ranges', async () => {
  const fixture = fakeSignedMarket({
    'base-plugin': [],
    'middle-plugin': ['base-plugin@1.0.0'],
    'root-plugin': ['base-plugin@^1.0.0', 'middle-plugin@^1.0.0'],
  }, { 'base-plugin': { '1.1.0': [] }, 'root-plugin': { '1.1.0': ['base-plugin@^1.0.0', 'middle-plugin@^1.0.0'] } });
  const root = await installPlugin('root-plugin@dependency-market', fixture.opts);
  expect(root.version).toBe('1.1.0');
  expect(listInstalledPlugins(fixture.installRoot).map(item => `${item.name}@${item.version}`))
    .toEqual(['base-plugin@1.0.0', 'middle-plugin@1.0.0', 'root-plugin@1.1.0']);
  expect(fixture.requests.some(url => url.endsWith('/base-plugin-1.1.0.tgz'))).toBe(true);
});

test('resolver backs off a newer candidate whose transitive dependency is unavailable', async () => {
  const fixture = fakeSignedMarket({
    'root-plugin': ['middle-plugin@^1.0.0'],
    'middle-plugin': [],
  }, { 'middle-plugin': { '1.1.0': ['absent-plugin@^1.0.0'] } });
  const root = await installPlugin('root-plugin@dependency-market', fixture.opts);
  expect(root.name).toBe('root-plugin');
  expect(fixture.requests.some(url => url.endsWith('/middle-plugin-1.1.0.tgz'))).toBe(true);
  expect(listInstalledPlugins(fixture.installRoot).map(item => `${item.name}@${item.version}`))
    .toEqual(['middle-plugin@1.0.0', 'root-plugin@1.0.0']);
});

test('resolver retries an older root when the newest root has an unsatisfiable required graph', async () => {
  const fixture = fakeSignedMarket({
    'root-plugin': ['base-plugin@^1.0.0'],
    'base-plugin': [],
  }, { 'root-plugin': { '1.1.0': ['absent-plugin@^1.0.0'] } });
  const root = await installPlugin('root-plugin@dependency-market', fixture.opts);
  expect(root.version).toBe('1.0.0');
  expect(fixture.requests.some(url => url.endsWith('/root-plugin-1.1.0.tgz'))).toBe(true);
  expect(listInstalledPlugins(fixture.installRoot).map(item => `${item.name}@${item.version}`))
    .toEqual(['base-plugin@1.0.0', 'root-plugin@1.0.0']);
});

test('a repeated root request reports already installed instead of adding an older version', async () => {
  const fixture = fakeSignedMarket({ 'root-plugin': [] }, { 'root-plugin': { '1.1.0': [] } });
  await installPlugin('root-plugin@dependency-market', fixture.opts);
  await expect(installPlugin('root-plugin@dependency-market', fixture.opts)).rejects.toThrow('plugin already installed: root-plugin@1.1.0');
  expect(listInstalledPlugins(fixture.installRoot).map(item => `${item.name}@${item.version}`)).toEqual(['root-plugin@1.1.0']);
});

test('reselection drops constraints introduced only by the rejected transitive version', async () => {
  const fixture = fakeSignedMarket({
    'root-plugin': ['middle-plugin@^1.0.0', 'other-plugin@^1.0.0'],
    'middle-plugin': ['base-plugin@^1.0.0'],
    'other-plugin': ['base-plugin@1.0.0'],
    'base-plugin': [],
  }, { 'middle-plugin': { '1.1.0': ['base-plugin@^2.0.0'] }, 'base-plugin': { '2.0.0': [] } });
  await installPlugin('root-plugin@dependency-market', fixture.opts);
  expect(listInstalledPlugins(fixture.installRoot).map(item => `${item.name}@${item.version}`))
    .toEqual(['base-plugin@1.0.0', 'middle-plugin@1.0.0', 'other-plugin@1.0.0', 'root-plugin@1.0.0']);
});

test('backtracking keeps a version eligible in a different candidate combination', async () => {
  const fixture = fakeSignedMarket({
    'root-plugin': ['a-plugin@^1.0.0', 'b-plugin@^1.0.0'],
    'a-plugin': ['x-plugin@2.0.0'],
    'b-plugin': ['x-plugin@2.0.0'],
    'x-plugin': [],
  }, {
    'b-plugin': { '1.1.0': ['x-plugin@1.0.0'] },
    'x-plugin': { '2.0.0': [] },
  });
  await installPlugin('root-plugin@dependency-market', fixture.opts);
  expect(listInstalledPlugins(fixture.installRoot).map(item => `${item.name}@${item.version}`))
    .toEqual(['a-plugin@1.0.0', 'b-plugin@1.0.0', 'root-plugin@1.0.0', 'x-plugin@2.0.0']);
});

test('an unpinned request installs the highest prerelease when the market has no stable release', async () => {
  const fixture = fakeSignedMarket({}, { 'root-plugin': { '1.0.0-beta.1': [], '1.0.0-beta.2': [] } });
  const root = await installPlugin('root-plugin@dependency-market', fixture.opts);
  expect(root.version).toBe('1.0.0-beta.2');
  const offlineMarkets = join(fixture.sourceRoot, 'offline-markets');
  const market = join(offlineMarkets, 'dependency-market');
  mkdirSync(market, { recursive: true });
  writeFileSync(join(market, 'marketplace.json'), fixture.index);
  writeFileSync(join(market, 'index.sig'), fixture.signature);
  for (const [key, bytes] of fixture.archiveBytes) writeFileSync(join(market, key), bytes);
  const offline = resolvePluginSource('root-plugin@dependency-market', join(fixture.sourceRoot, 'offline-package'),
    { ...fixture.opts, marketDir: offlineMarkets });
  expect(offline.expectedVersion).toBe('1.0.0-beta.2');
});

test('optional integration never fails the required graph even when it is cyclic or broken', async () => {
  const cycle = fakeSignedMarket({ 'root-plugin': [{ id: 'root-plugin', version: '^1.0.0', optional: true }] });
  expect((await installPlugin('root-plugin@dependency-market', cycle.opts)).name).toBe('root-plugin');
  const broken = fakeSignedMarket({
    'base-plugin': [],
    'root-plugin': [{ id: 'base-plugin', version: '^1.0.0', optional: true }],
  });
  const base = await installPlugin('base-plugin@dependency-market', broken.opts);
  writeFileSync(join(base.path, 'plugin.json'), JSON.stringify({ id: 'base-plugin', version: '1.0.0', main: './plugin.ts',
    dependencies: { plugins: ['absent-plugin@^1.0.0'] } }));
  expect((await installPlugin('root-plugin@dependency-market', broken.opts)).name).toBe('root-plugin');
});

test('rollback preserves a dependency adopted by a concurrent completed installation', async () => {
  const fixture = fakeSignedMarket({
    'base-plugin': [],
    'root-plugin': ['base-plugin@^1.0.0', 'missing-plugin@^1.0.0'],
  }, {}, { 'base-plugin': ['base-pack'] });
  const source = join(fixture.installRoot, '..', 'independent-source');
  mkdirSync(source);
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'independent-plugin', version: '1.0.0',
    main: './plugin.ts', dependencies: { plugins: ['base-plugin@^1.0.0'] } }));
  writeFileSync(join(source, 'plugin.ts'), 'export default {}');
  let independent: Promise<unknown> | undefined;
  let baseCommitted = false;
  const fetcher = fixture.opts.fetcher;
  await expect(installPlugin('root-plugin@dependency-market', { ...fixture.opts, refresh: true,
    onEvent: event => {
      if (event.event === 'done' && event.plugin === 'base-plugin') {
        baseCommitted = true;
        independent = installPlugin(source, { root: fixture.installRoot, yes: true });
      }
    },
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      if (baseCommitted && String(input).endsWith('/marketplace.json') && independent) await independent;
      return fetcher(input, init);
    }) as typeof fetch,
  })).rejects.toThrow('required plugin not found');
  await independent;
  expect(listInstalledPlugins(fixture.installRoot).map(item => item.name)).toEqual(['base-plugin', 'independent-plugin']);
  expect(existsSync(join(fixture.installRoot, 'knowledge-packs', 'dependency-market', 'base-pack', '1.0.0'))).toBe(true);
  expect(listInstalledPlugins(fixture.installRoot).find(item => item.name === 'base-plugin')?.installBundleId).toBeUndefined();
});

test('rollback does not delete a same-version dependency independently reinstalled during the bundle', async () => {
  const fixture = fakeSignedMarket({
    'base-plugin': [],
    'root-plugin': ['base-plugin@^1.0.0', 'missing-plugin@^1.0.0'],
  }, {}, { 'base-plugin': ['base-pack'] });
  const offlineMarkets = join(fixture.sourceRoot, 'offline-markets');
  const offlineMarket = join(offlineMarkets, 'dependency-market');
  mkdirSync(offlineMarket, { recursive: true });
  writeFileSync(join(offlineMarket, 'marketplace.json'), fixture.index);
  writeFileSync(join(offlineMarket, 'index.sig'), fixture.signature);
  for (const [key, bytes] of fixture.archiveBytes) writeFileSync(join(offlineMarket, key), bytes);
  let replacement: Promise<unknown> | undefined;
  let replacementStarted = false;
  const fetcher = fixture.opts.fetcher;
  await expect(installPlugin('root-plugin@dependency-market', { ...fixture.opts, refresh: true,
    onEvent: event => {
      if (event.event !== 'done' || event.plugin !== 'base-plugin' || replacementStarted) return;
      replacementStarted = true;
      removePlugin('base-plugin', fixture.installRoot);
      replacement = installPlugin('base-plugin@dependency-market', { root: fixture.installRoot,
        marketDir: offlineMarkets, trustedKeys: fixture.opts.trustedKeys, yes: true });
    },
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      if (replacementStarted && String(input).endsWith('/marketplace.json') && replacement) await replacement;
      return fetcher(input, init);
    }) as typeof fetch,
  })).rejects.toThrow('required plugin not found');
  await replacement;
  expect(listInstalledPlugins(fixture.installRoot).map(item => `${item.name}@${item.version}`)).toEqual(['base-plugin@1.0.0']);
  expect(existsSync(join(fixture.installRoot, 'knowledge-packs', 'dependency-market', 'base-pack', '1.0.0'))).toBe(true);
});
