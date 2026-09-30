import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIndexKeyPair, signIndex } from '../../market/signed-index.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { installPlugin, listInstalledPlugins, removePlugin, resolvePluginSource, withLedgerLock } from './plugin-install.js';
import { addMarket } from './market-fetch.js';
import { getNodeKind, registerNodeKind, unregisterPluginNodeKind, getNodeKindRegistration } from '../../graph-kinds/registry.js';

const dirs: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'elanous-plugin-install-test-')); dirs.push(root); return root; };
const packageAt = (path: string, id = 'sample-plugin', version = '1.2.3') => {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'plugin.json'), JSON.stringify({ id, name: id, version, main: './plugin.ts',
    capabilities: ['fs:workdir'], contributes: { graphs: ['graphs/run.yaml'], vocab: ['vocab/node.yaml'], skills: ['run'], connectors: [{ id: 'key', userConfig: [{ key: 'token', secret: true }] }] } }));
  writeFileSync(join(path, 'plugin.ts'), 'export default {}');
  mkdirSync(join(path, 'graphs'));
  mkdirSync(join(path, 'vocab'));
  writeFileSync(join(path, 'graphs', 'run.yaml'), 'name: run\n');
  writeFileSync(join(path, 'vocab', 'node.yaml'), 'kind: node\n');
  return path;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('plugin installation', () => {
  test('local paths install atomically with manifest identity, consent, list and remove', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    const events: string[] = [];
    const installed = await installPlugin(pkg, { root, yes: true, onEvent: e => events.push(e.event) });
    expect(installed).toMatchObject({ name: 'sample-plugin', version: '1.2.3', market: 'local', sha256: null });
    expect(existsSync(join(installed.path, 'plugin.ts'))).toBe(true);
    expect(events).toEqual(['resolve', 'verify', 'consent', 'credentials', 'registered', 'done']);
    expect(listInstalledPlugins(root)).toEqual([installed]);
    expect(removePlugin('sample-plugin', root)).toBe(1);
    expect(listInstalledPlugins(root)).toEqual([]);
  });

  test('registered nodes come from valid staged node definitions, not vocab; timestamp survives ledger writes and legacy rows stay undated', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    mkdirSync(join(pkg, 'nodes'));
    writeFileSync(join(pkg, 'plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.2.3', main: './plugin.ts',
      contributes: { vocab: ['vocab/node.yaml'], nodes: ['./nodes/first.yaml', './nodes/broken.yaml', './nodes/second.yaml'] } }));
    const node = (kind: string) => `kind: ${kind}\ngraph: workflow\ninputs:\n  type: object\nrun:\n  bash: echo ok\n`;
    writeFileSync(join(pkg, 'nodes', 'first.yaml'), node('first'));
    writeFileSync(join(pkg, 'nodes', 'broken.yaml'), 'kind: [invalid\n');
    writeFileSync(join(pkg, 'nodes', 'second.yaml'), node('second'));
    const registered: Array<Extract<import('./plugin-install.js').InstallEvent, { event: 'registered' }>> = [];
    const installed = await installPlugin(pkg, { root, onEvent: event => {
      if (event.event === 'registered') registered.push(event);
    } });
    expect(registered).toEqual([{ event: 'registered', kinds: ['vocab/node.yaml'],
      nodes: ['sample-plugin:first', 'sample-plugin:second'], nodeErrors: 1, graphs: [], skills: [] }]);
    expect(getNodeKind('workflow', 'sample-plugin:first')).toBeUndefined();
    expect(installed.installedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const ledger = join(root, 'plugins', 'installed.json');
    expect(JSON.parse(readFileSync(ledger, 'utf8'))).toEqual([
      { name: 'sample-plugin', version: '1.2.3', market: 'local', sha256: null, installedAt: installed.installedAt },
    ]);
    expect(listInstalledPlugins(root)).toEqual([installed]);
    const legacy = { name: 'sample-plugin', version: '1.2.3', market: 'local', sha256: null };
    writeFileSync(ledger, JSON.stringify([legacy]));
    expect(listInstalledPlugins(root)).toEqual([{ name: installed.name, version: installed.version, market: installed.market,
      path: installed.path, sha256: installed.sha256 }]);
    const newer = await installPlugin(packageAt(join(root, 'new-source'), 'new-plugin'), { root, yes: true });
    expect(JSON.parse(readFileSync(ledger, 'utf8'))).toEqual([
      { name: 'new-plugin', version: '1.2.3', market: 'local', sha256: null, installedAt: newer.installedAt }, legacy,
    ]);
    expect(listInstalledPlugins(root).find(item => item.name === 'sample-plugin')?.installedAt).toBeUndefined();
  });

  test('pre-registered kinds do not hide valid nodes from another version or market', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    mkdirSync(join(pkg, 'nodes'));
    writeFileSync(join(pkg, 'nodes', 'action.yaml'), 'kind: action\ngraph: workflow\ninputs:\n  type: object\nrun:\n  bash: echo new\n');
    const manifest = (version: string) => ({ id: 'sample-plugin', version, main: './plugin.ts', contributes: { nodes: ['./nodes/action.yaml'] } });
    writeFileSync(join(pkg, 'plugin.json'), JSON.stringify(manifest('1.2.3')));
    const existing = { graph: 'workflow' as const, kind: 'sample-plugin:action', plugin: 'sample-plugin', core: false,
      description: 'previous installation', schema: { type: 'object' }, run: { bash: 'echo previous' } };
    expect(registerNodeKind(existing)).toEqual({ ok: true });
    const original = getNodeKindRegistration('workflow', existing.kind);
    try {
      const registrations: string[][] = [];
      const record = (event: import('./plugin-install.js').InstallEvent) => {
        if (event.event === 'registered') {
          expect(event.nodeErrors).toBe(0);
          registrations.push(event.nodes);
        }
      };
      await installPlugin(pkg, { root, onEvent: record });
      writeFileSync(join(pkg, 'plugin.json'), JSON.stringify(manifest('1.2.4')));
      await installPlugin(pkg, { root, onEvent: record });
      const market = join(root, 'markets', 'other-market');
      mkdirSync(market, { recursive: true });
      packageAt(join(market, 'source'), 'sample-plugin', '1.2.4');
      writeFileSync(join(market, 'source', 'plugin.json'), JSON.stringify(manifest('1.2.4')));
      mkdirSync(join(market, 'source', 'nodes'));
      writeFileSync(join(market, 'source', 'nodes', 'action.yaml'), 'kind: action\ngraph: workflow\ninputs:\n  type: object\nrun:\n  bash: echo market\n');
      writeFileSync(join(market, 'marketplace.json'), JSON.stringify({ name: 'other-market', plugins: [
        { name: 'sample-plugin', version: '1.2.4', source: { source: 'local', path: 'source' } },
      ] }));
      await installPlugin('sample-plugin@other-market', { root, allowUnsigned: true, onEvent: record });
      expect(registrations).toEqual([['sample-plugin:action'], ['sample-plugin:action'], ['sample-plugin:action']]);
      expect(getNodeKindRegistration('workflow', existing.kind)).toBe(original);
    } finally {
      if (original) unregisterPluginNodeKind('workflow', existing.kind, 'sample-plugin', original);
    }
  });

  test('elanous-hwp pack reports its to-md and from-md nodes at install', async () => {
    const root = fixture();
    const pkg = join(import.meta.dir, '..', '..', '..', 'packs', 'elanous-hwp');
    const nodes: string[][] = [];
    await installPlugin(pkg, { root, yes: true, onEvent: event => {
      if (event.event === 'registered') nodes.push(event.nodes);
    } });
    expect(nodes).toEqual([['elanous-hwp:to-md', 'elanous-hwp:from-md']]);
    expect(listInstalledPlugins(root)[0]?.installedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  test('job-coach-style manifest without a skills list registers three discovered skills', async () => {
    const root = fixture();
    const pkg = join(root, 'job-coach');
    mkdirSync(join(pkg, '.codex-plugin'), { recursive: true });
    writeFileSync(join(pkg, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'job-coach', version: '0.1.0', skills: './skills/' }));
    writeFileSync(join(pkg, 'plugin.ts'), 'export default {}');
    for (const name of ['interview-to-profile', 'career-report', 'run-report']) {
      mkdirSync(join(pkg, 'skills', name), { recursive: true });
      writeFileSync(join(pkg, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n`);
    }
    mkdirSync(join(pkg, 'skills', 'not-a-skill'));
    mkdirSync(join(pkg, 'skills', '_private'), { recursive: true });
    writeFileSync(join(pkg, 'skills', '_private', 'SKILL.md'), 'private');
    const registrations: string[][] = [];
    const installed = await installPlugin(pkg, { root, onEvent: event => {
      if (event.event === 'registered') registrations.push(event.skills);
    } });
    expect(registrations).toEqual([['career-report', 'interview-to-profile', 'run-report']]);
    expect(existsSync(join(installed.path, 'skills', 'run-report', 'SKILL.md'))).toBe(true);

    writeFileSync(join(pkg, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'job-coach', version: '0.1.1', contributes: { skills: [] } }));
    const explicit: string[][] = [];
    await installPlugin(pkg, { root, onEvent: event => {
      if (event.event === 'registered') explicit.push(event.skills);
    } });
    expect(explicit).toEqual([[]]);
  });

  test('denied consent, duplicate name and symlink never install an artifact', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    await expect(installPlugin(pkg, { root })).rejects.toMatchObject({ reason: 'consent-denied' });
    expect(listInstalledPlugins(root)).toEqual([]);
    await installPlugin(pkg, { root, yes: true });
    await expect(installPlugin(pkg, { root, yes: true })).rejects.toMatchObject({ reason: 'conflict' });
    const other = packageAt(join(root, 'unsafe'), 'unsafe-plugin');
    symlinkSync(join(root, 'source'), join(other, 'link'));
    await expect(installPlugin(other, { root, yes: true })).rejects.toMatchObject({ reason: 'scan' });
    expect(listInstalledPlugins(root)).toHaveLength(1);
  });

  test('manifest main must exist and unsafe manifest paths never reach installation', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    rmSync(join(pkg, 'plugin.ts'));
    await expect(installPlugin(pkg, { root, yes: true })).rejects.toMatchObject({ reason: 'io' });
    writeFileSync(join(pkg, 'plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.2.3', main: '../outside.ts' }));
    await expect(installPlugin(pkg, { root, yes: true })).rejects.toMatchObject({ reason: 'io' });
    expect(listInstalledPlugins(root)).toEqual([]);
  });

  test('a skills-only pack that declares no main installs (official elanous-basics shape)', async () => {
    const root = fixture();
    const pkg = join(root, 'skills-only');
    mkdirSync(join(pkg, 'skills', 'grill-me'), { recursive: true });
    writeFileSync(join(pkg, 'skills', 'grill-me', 'SKILL.md'), '---\nname: grill-me\n---\n');
    writeFileSync(join(pkg, 'plugin.json'), JSON.stringify({ name: 'skills-only', version: '0.1.0',
      extensions: { 'ai.elanous': { bundle: ['skills/grill-me'], capabilities: [], connectors: [], pricing: { model: 'free' } } } }));
    const installed = await installPlugin(pkg, { root, yes: true });
    expect(installed.name).toBe('skills-only');
    expect(listInstalledPlugins(root).map(row => row.name)).toEqual(['skills-only']);
  });

  test('signed local market checks injected verifier and artifact hash before copy', async () => {
    const root = fixture();
    const market = join(root, 'markets', 'test-market');
    const pkg = packageAt(join(root, 'source'));
    mkdirSync(market, { recursive: true });
    const archive = join(market, 'sample.tgz');
    execFileSync('tar', ['-czf', archive, '-C', pkg, '.']);
    const bytes = readFileSync(archive);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const index = { name: 'test-market', interface: { displayName: 'Test' }, sequence: 1,
      plugins: [{ name: 'sample-plugin', version: '1.2.3', source: { source: 'local', path: 'source' },
        artifact: { sha256: hash, bytes: bytes.length, key: 'sample.tgz' },
        'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } }] };
    const indexBytes = Buffer.from(JSON.stringify(index));
    const keys = generateIndexKeyPair();
    writeFileSync(join(market, 'marketplace.json'), indexBytes);
    writeFileSync(join(market, 'index.sig'), signIndex(indexBytes, keys.privateKeyPem, keys.keyId));
    const installRoot = join(root, 'installed');
    let verifies = 0; let hashes = 0;
    const { verifyIndex } = await import('../../market/signed-index.js');
    const opts = { root: installRoot, marketDir: join(root, 'markets'), trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }], yes: true,
      verifySignature: ((input: Parameters<typeof verifyIndex>[0]) => { verifies++; return verifyIndex(input); }) as typeof verifyIndex,
      hashArtifact: (data: Uint8Array) => { hashes++; return createHash('sha256').update(data).digest('hex'); } };
    const result = await installPlugin('sample-plugin@test-market', opts);
    expect(result.sha256).toBe(hash);
    expect(verifies).toBe(1);
    expect(hashes).toBe(1);
    expect(existsSync(join(result.path, 'plugin.ts'))).toBe(true);
    expect(listInstalledPlugins(installRoot)).toEqual([result]);
    // The synchronous resolver keeps the same offline contract for `<name>@<market>`.
    const direct = join(root, 'direct');
    expect(resolvePluginSource('sample-plugin@test-market', direct, opts)).toMatchObject({ market: 'test-market', sha256: hash, signature: 'ok', expectedName: 'sample-plugin' });
    expect(existsSync(join(direct, 'plugin.ts'))).toBe(true);
    expect(JSON.parse(readFileSync(join(installRoot, 'plugins', 'installed.json'), 'utf8'))).toEqual([
      { name: 'sample-plugin', version: '1.2.3', market: 'test-market', sha256: hash, installedAt: result.installedAt },
    ]);
    writeFileSync(archive, Buffer.concat([bytes, Buffer.from('changed')]));
    await expect(installPlugin('sample-plugin@test-market', { ...opts, root: join(root, 'tampered') })).rejects.toMatchObject({ reason: 'scan' });
    expect(listInstalledPlugins(join(root, 'tampered'))).toEqual([]);
    writeFileSync(archive, bytes);
    writeFileSync(join(market, 'marketplace.json'), Buffer.concat([indexBytes, Buffer.from(' ')]));
    await expect(installPlugin('sample-plugin@test-market', { ...opts, root: join(root, 'bad-signature') })).rejects.toMatchObject({ reason: 'signature' });
  });

  test('omitted root resolves install, list, remove and market index in the isolated instance', async () => {
    const original = process.env.ELANOUS_STATE_DIR;
    const isolated = fixture();
    process.env.ELANOUS_STATE_DIR = isolated;
    try {
      expect(elanousStateRoot()).toBe(isolated);
      const source = packageAt(join(fixture(), 'source'));
      const local = await installPlugin(source, { yes: true });
      expect(local.path).toBe(join(isolated, 'plugins', 'local', 'sample-plugin', '1.2.3'));
      expect(listInstalledPlugins()).toEqual([local]);
      expect(removePlugin('sample-plugin')).toBe(1);
      expect(listInstalledPlugins()).toEqual([]);

      const market = join(isolated, 'markets', 'test-market');
      packageAt(join(market, 'source'));
      writeFileSync(join(market, 'marketplace.json'), JSON.stringify({ name: 'test-market', plugins: [
        { name: 'sample-plugin', version: '1.2.3', source: { source: 'local', path: 'source' } },
      ] }));
      const installed = await installPlugin('sample-plugin@test-market', { allowUnsigned: true, yes: true });
      expect(installed.path).toBe(join(isolated, 'plugins', 'test-market', 'sample-plugin', '1.2.3'));
      expect(listInstalledPlugins()).toEqual([installed]);
      expect(removePlugin('sample-plugin')).toBe(1);
      expect(listInstalledPlugins()).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = original;
    }
  });

  test('explicit root and marketDir override the isolated defaults independently', async () => {
    const original = process.env.ELANOUS_STATE_DIR;
    const isolated = fixture();
    const root = fixture();
    const marketDir = join(fixture(), 'markets');
    process.env.ELANOUS_STATE_DIR = isolated;
    try {
      const market = join(marketDir, 'test-market');
      packageAt(join(market, 'source'));
      writeFileSync(join(market, 'marketplace.json'), JSON.stringify({ name: 'test-market', plugins: [
        { name: 'sample-plugin', version: '1.2.3', source: { source: 'local', path: 'source' } },
      ] }));
      const installed = await installPlugin('sample-plugin@test-market', { root, marketDir, allowUnsigned: true, yes: true });
      expect(installed.path).toBe(join(root, 'plugins', 'test-market', 'sample-plugin', '1.2.3'));
      expect(listInstalledPlugins(root)).toEqual([installed]);
      expect(listInstalledPlugins()).toEqual([]);
      expect(removePlugin('sample-plugin', root)).toBe(1);
    } finally {
      if (original === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = original;
    }
  });

  test('missing signature needs explicit allowUnsigned and mismatched manifest name is rejected', async () => {
    const root = fixture();
    const market = join(root, 'markets', 'test-market');
    packageAt(join(market, 'source'), 'different-name');
    writeFileSync(join(market, 'marketplace.json'), JSON.stringify({ name: 'test-market', plugins: [{ name: 'sample-plugin', version: '1.2.3', source: { source: 'local', path: 'source' } }] }));
    await expect(installPlugin('sample-plugin@test-market', { root })).rejects.toMatchObject({ reason: 'signature' });
    await expect(installPlugin('sample-plugin@test-market', { root, allowUnsigned: true, yes: true })).rejects.toMatchObject({ reason: 'conflict' });
    expect(listInstalledPlugins(root)).toEqual([]);
  });
});

describe('plugin installation — 🅢 must-fix follow-up (09-29)', () => {
  test('a pack with no main and nothing to install is still rejected', async () => {
    const root = fixture();
    const pkg = join(root, 'empty-pack');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'plugin.json'), JSON.stringify({ name: 'empty-pack', version: '0.1.0' }));
    await expect(installPlugin(pkg, { root, yes: true })).rejects.toMatchObject({ reason: 'io' });
    mkdirSync(join(pkg, 'skills', 'nothing-here'), { recursive: true });
    await expect(installPlugin(pkg, { root, yes: true })).rejects.toMatchObject({ reason: 'io' });
    expect(listInstalledPlugins(root)).toEqual([]);
  });

  test('git ref and subdirectory resolve to the pinned commit, not latest HEAD', async () => {
    const root = fixture();
    const repo = join(root, 'repo.git');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'test@example.org');
    git('config', 'user.name', 'Test');
    packageAt(join(repo, 'plugins', 'sample-plugin'));
    git('add', '.'); git('commit', '-qm', 'first');
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'plugins', 'sample-plugin', 'plugin.json'), '{bad');
    git('add', '.'); git('commit', '-qm', 'second');
    const installed = await installPlugin(`${repo}#${sha}:plugins/sample-plugin`, { root: join(root, 'installed'), yes: true });
    expect(installed.name).toBe('sample-plugin');
    expect(JSON.parse(readFileSync(join(installed.path, 'plugin.json'), 'utf8')).version).toBe('1.2.3');
    await expect(installPlugin(`${repo}#${sha}:../escape`, { root: join(root, 'other'), yes: true })).rejects.toMatchObject({ reason: 'io' });
    await expect(installPlugin(`${repo}:plugins/sample-plugin`, { root: join(root, 'unpinned'), yes: true })).rejects.toMatchObject({ reason: 'io' });
  });

  test('signed remote market installs the named artifact using fetcher, cached index and refresh', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    const archive = join(root, 'sample.tgz');
    execFileSync('tar', ['-czf', archive, '-C', pkg, '.']);
    const artifact = readFileSync(archive);
    const hash = createHash('sha256').update(artifact).digest('hex');
    const keys = generateIndexKeyPair();
    const configPath = join(root, 'config.json');
    addMarket('test-market', 'https://example.org/market/', { configPath });
    const indexBytes = Buffer.from(JSON.stringify({ name: 'test-market', interface: { displayName: 'Test' }, sequence: 1,
      plugins: [{ name: 'sample-plugin', version: '1.2.3', source: { source: 'local', path: 'ignored' },
        artifact: { sha256: hash, bytes: artifact.length, key: 'archives/sample.tgz' },
        'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } }] }));
    const signature = signIndex(indexBytes, keys.privateKeyPem, keys.keyId);
    const requests: string[] = [];
    let payload = artifact;
    let artifactInit: RequestInit | undefined;
    let landedAt: string | undefined;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/marketplace.json')) return new Response(indexBytes);
      if (url.endsWith('/index.sig')) return new Response(signature);
      if (url.endsWith('/archives/sample.tgz')) {
        artifactInit = init;
        const response = new Response(payload);
        if (landedAt) Object.defineProperty(response, 'url', { value: landedAt });
        return response;
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;
    const opts = { root, configPath, fetcher, trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }], yes: true };
    const installed = await installPlugin('sample-plugin@test-market', opts);
    expect(installed).toMatchObject({ market: 'test-market', name: 'sample-plugin', sha256: hash });
    expect(existsSync(join(installed.path, 'plugin.ts'))).toBe(true);
    expect(requests).toEqual(['https://example.org/market/marketplace.json', 'https://example.org/market/index.sig', 'https://example.org/market/archives/sample.tgz']);
    expect(artifactInit?.redirect).toBe('error');
    // The signed index is fetched the same way — a moved index installs nothing.
    const movedIndex = (async (input: string | URL | Request) => {
      const response = new Response(String(input).endsWith('/index.sig') ? signature : indexBytes);
      Object.defineProperty(response, 'url', { value: 'https://elsewhere.example/marketplace.json' });
      return response;
    }) as typeof fetch;
    await expect(installPlugin('sample-plugin@test-market', { ...opts, fetcher: movedIndex, root: join(root, 'moved-index'), marketDir: join(root, 'moved-markets') })).rejects.toMatchObject({ reason: 'io', message: expect.stringContaining('redirected') });
    expect(listInstalledPlugins(join(root, 'moved-index'))).toEqual([]);
    landedAt = 'https://elsewhere.example/sample.tgz';
    await expect(installPlugin('sample-plugin@test-market', { ...opts, root: join(root, 'redirected'), marketDir: join(root, 'markets') })).rejects.toMatchObject({ reason: 'io', message: 'artifact fetch was redirected' });
    expect(listInstalledPlugins(join(root, 'redirected'))).toEqual([]);
    landedAt = undefined;
    requests.length = 0;
    await expect(installPlugin('absent-plugin@test-market', { ...opts, root: join(root, 'missing'), marketDir: join(root, 'markets') })).rejects.toMatchObject({ reason: 'io', message: expect.stringContaining('plugin not found') });
    expect(requests).toEqual([]);
    payload = Buffer.concat([artifact, Buffer.from('tampered')]);
    await expect(installPlugin('sample-plugin@test-market', { ...opts, root: join(root, 'second'), marketDir: join(root, 'markets') })).rejects.toMatchObject({ reason: 'scan' });
    expect(requests).toEqual(['https://example.org/market/archives/sample.tgz']);
    expect(listInstalledPlugins(join(root, 'second'))).toEqual([]);
    requests.length = 0;
    payload = Buffer.from(artifact);
    payload[0] = payload[0]! ^ 1;
    await expect(installPlugin('sample-plugin@test-market', { ...opts, root: join(root, 'wrong-hash'), marketDir: join(root, 'markets') })).rejects.toMatchObject({ reason: 'scan' });
    expect(listInstalledPlugins(join(root, 'wrong-hash'))).toEqual([]);
    requests.length = 0;
    payload = artifact;
    await installPlugin('sample-plugin@test-market', { ...opts, root: join(root, 'third'), marketDir: join(root, 'markets'), refresh: true });
    expect(requests).toEqual(['https://example.org/market/marketplace.json', 'https://example.org/market/index.sig', 'https://example.org/market/archives/sample.tgz']);
  });

  // `archives/../x.tgz` resolves under the market path, so only a check on the key as written catches it.
  test.each(['../escape.tgz', 'archives/../escape.tgz', './escape.tgz', '%2e%2e/escape.tgz', 'a%2fb.tgz', '/abs.tgz'])('signed market rejects an unsafe artifact key before fetching it (%s)', async (key) => {
    const root = fixture();
    const keys = generateIndexKeyPair();
    const configPath = join(root, 'config.json');
    addMarket('test-market', 'https://example.org/market/', { configPath });
    const indexBytes = Buffer.from(JSON.stringify({ name: 'test-market', interface: { displayName: 'Test' }, sequence: 1,
      plugins: [{ name: 'sample-plugin', version: '1.2.3', source: { source: 'local' },
        artifact: { sha256: 'a'.repeat(64), bytes: 1, key },
        'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } }] }));
    const requests: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(String(input).endsWith('/index.sig') ? signIndex(indexBytes, keys.privateKeyPem, keys.keyId) : indexBytes);
    }) as typeof fetch;
    await expect(installPlugin('sample-plugin@test-market', { root, configPath, fetcher, trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }], yes: true })).rejects.toMatchObject({ reason: 'io', message: 'unsafe artifact key' });
    expect(requests).toEqual(['https://example.org/market/marketplace.json', 'https://example.org/market/index.sig']);
    expect(listInstalledPlugins(root)).toEqual([]);
  });

  test('signed market rejects tampered fetched artifact before extraction', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    const archive = join(root, 'sample.tgz');
    execFileSync('tar', ['-czf', archive, '-C', pkg, '.']);
    const bytes = readFileSync(archive);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const index = { name: 'test-market', interface: { displayName: 'Test' }, sequence: 1,
      plugins: [{ name: 'sample-plugin', version: '1.2.3', source: { source: 'local', path: 'source' },
        artifact: { sha256: hash, bytes: bytes.length, key: 'sample.tgz' },
        'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } }] };
    const indexBytes = Buffer.from(JSON.stringify(index));
    const keys = generateIndexKeyPair();
    const configPath = join(root, 'config.json');
    addMarket('test-market', 'https://example.org/market/', { configPath });
    const signature = signIndex(indexBytes, keys.privateKeyPem, keys.keyId);
    let payload = bytes;
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(url.endsWith('/marketplace.json') ? indexBytes : url.endsWith('/index.sig') ? signature : payload);
    }) as typeof fetch;
    const installRoot = join(root, 'installed');
    let verifies = 0; let hashes = 0;
    const { verifyIndex } = await import('../../market/signed-index.js');
    const opts = { root: installRoot, configPath, fetcher, trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }], yes: true,
      verifySignature: ((input: Parameters<typeof verifyIndex>[0]) => { verifies++; return verifyIndex(input); }) as typeof verifyIndex,
      hashArtifact: (data: Uint8Array) => { hashes++; return createHash('sha256').update(data).digest('hex'); } };
    const result = await installPlugin('sample-plugin@test-market', opts);
    expect(result.sha256).toBe(hash);
    expect(verifies).toBe(1);
    expect(hashes).toBe(1);
    expect(existsSync(join(result.path, 'plugin.ts'))).toBe(true);
    expect(listInstalledPlugins(installRoot)).toEqual([result]);
    expect(JSON.parse(readFileSync(join(installRoot, 'plugins', 'installed.json'), 'utf8'))).toEqual([
      { name: 'sample-plugin', version: '1.2.3', market: 'test-market', sha256: hash, installedAt: result.installedAt },
    ]);
    payload = Buffer.concat([bytes, Buffer.from('changed')]);
    await expect(installPlugin('sample-plugin@test-market', { ...opts, root: join(root, 'tampered'), marketDir: join(installRoot, 'markets') })).rejects.toMatchObject({ reason: 'scan' });
    expect(listInstalledPlugins(join(root, 'tampered'))).toEqual([]);
    payload = bytes;
    const badFetcher = (async (input: string | URL | Request) => new Response(String(input).endsWith('/marketplace.json') ? Buffer.concat([indexBytes, Buffer.from(' ')]) : String(input).endsWith('/index.sig') ? signature : payload)) as typeof fetch;
    await expect(installPlugin('sample-plugin@test-market', { ...opts, root: join(root, 'bad-signature'), fetcher: badFetcher })).rejects.toMatchObject({ reason: 'signature' });
  });

  test('omitted root resolves local install, list and remove in the isolated instance', async () => {
    const original = process.env.ELANOUS_STATE_DIR;
    const isolated = fixture();
    process.env.ELANOUS_STATE_DIR = isolated;
    try {
      expect(elanousStateRoot()).toBe(isolated);
      const source = packageAt(join(fixture(), 'source'));
      const local = await installPlugin(source, { yes: true });
      expect(local.path).toBe(join(isolated, 'plugins', 'local', 'sample-plugin', '1.2.3'));
      expect(listInstalledPlugins()).toEqual([local]);
      expect(removePlugin('sample-plugin')).toBe(1);
      expect(listInstalledPlugins()).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = original;
    }
  });

  test('failed ledger writes restore installed directories for both install and remove', async () => {
    const root = fixture();
    const prior = await installPlugin(packageAt(join(root, 'prior'), 'prior-plugin'), { root, yes: true });
    const ledger = join(root, 'plugins', 'installed.json');
    rmSync(ledger);
    mkdirSync(ledger);
    expect(() => removePlugin('prior-plugin', root)).toThrow();
    expect(existsSync(join(prior.path, 'plugin.ts'))).toBe(true);
    await expect(installPlugin(packageAt(join(root, 'next'), 'next-plugin'), { root, yes: true })).rejects.toMatchObject({ reason: 'io' });
    expect(existsSync(join(root, 'plugins', 'local', 'next-plugin', '1.2.3'))).toBe(false);
    rmSync(ledger, { recursive: true });
    expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['prior-plugin']);
  });

  test('independent processes serialize installs and removal against the same ledger', async () => {
    const root = fixture();
    const prior = packageAt(join(root, 'prior'), 'prior-plugin');
    await installPlugin(prior, { root, yes: true });
    const count = 12;
    const sources = Array.from({ length: count }, (_, i) => packageAt(join(root, `source-${i}`), `plugin-${i}`));
    const ready = join(root, 'ready');
    const release = join(root, 'release');
    mkdirSync(ready);
    const script = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { installPlugin, removePlugin } from ${JSON.stringify(new URL('./plugin-install.ts', import.meta.url).href)};
      const { root, ready, release, source, id } = JSON.parse(process.env.PLUGIN_WORKER!);
      writeFileSync(join(ready, String(id)), 'ready');
      while (!existsSync(release)) await Bun.sleep(5);
      if (source) await installPlugin(source, { root, yes: true });
      else removePlugin('prior-plugin', root);
    `;
    const workers = [...sources, null].map((source, id) => Bun.spawn([process.execPath, '-e', script], {
      cwd: process.cwd(), env: { ...process.env, PLUGIN_WORKER: JSON.stringify({ root, ready, release, source, id }) },
      stdout: 'pipe', stderr: 'pipe',
    }));
    try {
      const deadline = Date.now() + 30_000;
      while (Array.from({ length: workers.length }, (_, id) => existsSync(join(ready, String(id)))).some(value => !value)) {
        if (Date.now() > deadline) throw new Error('plugin workers did not reach the barrier');
        await Bun.sleep(10);
      }
      const lock = join(root, 'plugins', '.installed.lock');
      const fd = openSync(lock, 'a');
      const flock = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
        { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock;
      try {
        expect(flock(fd, 2 | 4)).toBe(0);
        writeFileSync(release, 'go');
        await Bun.sleep(150);
        expect(JSON.parse(readFileSync(join(root, 'plugins', 'installed.json'), 'utf8')).map((item: { name: string }) => item.name)).toEqual(['prior-plugin']);
        expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['prior-plugin']);
      } finally {
        closeSync(fd);
      }
      const results = await Promise.all(workers.map(async worker => ({
        code: await worker.exited, stderr: await new Response(worker.stderr).text(),
      })));
      expect(results).toEqual(results.map(() => ({ code: 0, stderr: '' })));
      const expected = sources.map((_, i) => `plugin-${i}`).sort();
      const installed = listInstalledPlugins(root);
      expect(installed.map(item => item.name).sort()).toEqual(expected);
      const ledger = JSON.parse(readFileSync(join(root, 'plugins', 'installed.json'), 'utf8')) as Array<{ name: string }>;
      expect(ledger.map(item => item.name).sort()).toEqual(expected);
      expect(installed.every(item => existsSync(join(item.path, 'plugin.ts')))).toBe(true);
      expect(existsSync(join(root, 'plugins', 'local', 'prior-plugin', '1.2.3'))).toBe(false);
    } finally {
      for (const worker of workers) worker.kill();
    }
  }, 60_000);

  test('killing the lock holder releases the ledger for other processes to install and remove', async () => {
    const root = fixture();
    await installPlugin(packageAt(join(root, 'prior'), 'prior-plugin'), { root, yes: true });
    const next = packageAt(join(root, 'next'), 'next-plugin');
    const lock = join(root, 'plugins', '.installed.lock');
    const acquired = join(root, 'lock-acquired');
    const holder = Bun.spawn([process.execPath, '-e', `
      import { openSync, writeFileSync } from 'node:fs';
      import { dlopen, FFIType } from 'bun:ffi';
      const flock = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
        { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock;
      const fd = openSync(process.env.LOCK_PATH!, 'a');
      if (flock(fd, 2) !== 0) process.exit(1);
      writeFileSync(process.env.ACQUIRED_PATH!, 'acquired');
      await new Promise(() => {});
    `], { env: { ...process.env, LOCK_PATH: lock, ACQUIRED_PATH: acquired }, stdout: 'pipe', stderr: 'pipe' });
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(acquired)) {
        if (Date.now() > deadline) throw new Error('holder never acquired lock');
        await Bun.sleep(10);
      }
      holder.kill('SIGKILL');
      expect(await holder.exited).not.toBe(0);
      expect(existsSync(lock)).toBe(true);
      const worker = `
        import { installPlugin, removePlugin } from ${JSON.stringify(new URL('./plugin-install.ts', import.meta.url).href)};
        const { root, source } = JSON.parse(process.env.PLUGIN_WORKER!);
        if (source) await installPlugin(source, { root, yes: true });
        else removePlugin('prior-plugin', root);
      `;
      const results = await Promise.all([next, null].map(async source => {
        const processWorker = Bun.spawn([process.execPath, '-e', worker], {
          env: { ...process.env, PLUGIN_WORKER: JSON.stringify({ root, source }) }, stdout: 'pipe', stderr: 'pipe',
        });
        return { code: await processWorker.exited, stderr: await new Response(processWorker.stderr).text() };
      }));
      expect(results).toEqual([{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
      expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['next-plugin']);
      expect(JSON.parse(readFileSync(join(root, 'plugins', 'installed.json'), 'utf8')).map((item: { name: string }) => item.name)).toEqual(['next-plugin']);
    } finally {
      holder.kill('SIGKILL');
      await holder.exited;
    }
  }, 30_000);

});

describe('plugin installation — 🅢 must-fix follow-up (09-29)', () => {
  test('a listener that throws on «done» does not turn a committed install into a failure', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    const installed = await installPlugin(pkg, { root, yes: true, onEvent: (e) => { if (e.event === 'done') throw new Error('listener broke'); } });
    expect(installed).toMatchObject({ name: 'sample-plugin', version: '1.2.3' });
    expect(listInstalledPlugins(root)).toEqual([installed]);
  });

  test('without flock (Windows), a lock left by a dead process is taken over', () => {
    const root = fixture();
    const dir = join(root, 'plugins', '.installed.lock.d');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), '2147483646');
    expect(withLedgerLock(root, () => 'ran', null)).toBe('ran');
    expect(existsSync(dir)).toBe(false);
  });

  test('without flock, a lock held by a live process is not taken over', () => {
    const root = fixture();
    const dir = join(root, 'plugins', '.installed.lock.d');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), String(process.pid));
    const started = Date.now();
    expect(() => withLedgerLock(root, () => 'ran', null)).toThrow(/timed out/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
  }, 20_000);
});
