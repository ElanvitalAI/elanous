import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIndexKeyPair, signIndex } from '../../market/signed-index.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug } from '../../debug/log.js';
import { installPlugin, listInstalledPlugins, pluginInstallPath, removePlugin, resolvePluginSource, withLedgerLock, type InstallEvent } from './plugin-install.js';
import { loadPluginManifestFromDir } from '../core/manifest.js';
import { addMarket } from './market-fetch.js';
import { composeMissionGraph, composePluginMission } from '../../graph-wizard/mission-compose.js';
import { createClassicSidetabMissionPairSessionRegistry } from '../../dashboard/classic-sidetab-mission.js';
import { startClassicSidetabMissionPair } from '../../dashboard/classic-sidetab-mission-pair.js';
import { getNodeKind, registerNodeKind, unregisterPluginNodeKind, getNodeKindRegistration } from '../../graph-kinds/registry.js';
import { handTask, selectTaskComposition } from '../../task-agent/task-hand.js';

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

  test('research drafts cannot be installed until the explicit draft marker is removed', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    const manifestPath = join(pkg, 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.extensions = { 'ai.elanous': { researchDraft: true } };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(installPlugin(pkg, { root, yes: true })).rejects.toMatchObject({
      reason: 'io', message: expect.stringContaining('research draft only'),
    });
    expect(listInstalledPlugins(root)).toEqual([]);
    delete manifest.extensions['ai.elanous'].researchDraft;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect((await installPlugin(pkg, { root, yes: true })).name).toBe('sample-plugin');
  });

  test('imported JSON knowledge secret fails installation with a dangerous scan and no secret output', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    const secret = 'superlongprivatevalue123456';
    mkdirSync(join(pkg, 'knowledge'));
    writeFileSync(join(pkg, 'knowledge', 'private.json'), JSON.stringify({ apiKey: secret }));
    const events: InstallEvent[] = [];
    let failure: unknown;
    try { await installPlugin(pkg, { root, yes: true, onEvent: event => events.push(event) }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ reason: 'scan' });
    expect(events.find(event => event.event === 'verify')).toMatchObject({ event: 'verify', scan: 'dangerous' });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(String(failure)).not.toContain(secret);
    expect(listInstalledPlugins(root)).toEqual([]);
  });

  test('installed bytes are compared to the staged security digest before ledger commit', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'));
    const secret = 'SECRET=superlongprivatevalue123456';
    await expect(installPlugin(pkg, { root, yes: true, onEvent: event => {
      if (event.event === 'registered') {
        const stageRoot = join(root, 'plugins', '.staging');
        const stage = readdirSync(stageRoot)[0]!;
        writeFileSync(join(stageRoot, stage, 'package', 'plugin.ts'), `// ${secret}\nexport default {};`);
      }
    } })).rejects.toMatchObject({ reason: 'scan', message: 'plugin package integrity changed during installation' });
    expect(listInstalledPlugins(root)).toEqual([]);
    expect(existsSync(join(root, 'plugins', 'local', 'sample-plugin', '1.2.3'))).toBe(false);
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

// [wiring] installPlugin hands the PluginManifest normalized by loadPluginManifestFromDir
// into the install path via pluginInstallPath. These tests pin that regression: with a
// manifest present and with the manifest-absent fallback, the destination must carry
// manifest.id and manifest.version — never an undefined segment.
describe('plugin installation — normalized manifest wiring ([wiring] installPlugin → pluginInstallPath)', () => {
  test('manifest present: destination embeds the normalized manifest id and version', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'source'), 'manifest-plugin', '2.4.6');
    const manifest = loadPluginManifestFromDir(pkg, { id: 'manifest-plugin' }).manifest;
    const installed = await installPlugin(pkg, { root, yes: true });
    expect(installed.path).toBe(pluginInstallPath(root, 'local', manifest));
    expect(installed.path).toBe(join(root, 'plugins', 'local', 'manifest-plugin', '2.4.6'));
    expect(installed.path).not.toContain('undefined');
    expect(existsSync(installed.path)).toBe(true);
  });

  test('manifest absent: loadPluginManifestFromDir fallback still defines id and version for the install path', async () => {
    const root = fixture();
    const pkg = join(root, 'no-manifest');
    mkdirSync(join(pkg, 'skills', 'orphan-skill'), { recursive: true });
    writeFileSync(join(pkg, 'skills', 'orphan-skill', 'SKILL.md'), '---\nname: orphan-skill\n---\n');
    writeFileSync(join(pkg, 'plugin.ts'), 'export default {}');
    const manifest = loadPluginManifestFromDir(pkg, { id: 'no-manifest' }).manifest;
    expect(manifest.id).toBe('no-manifest');
    expect(manifest.version).toBe('0.0.0');
    const installed = await installPlugin(pkg, { root, yes: true });
    expect(installed.path).toBe(pluginInstallPath(root, 'local', manifest));
    expect(installed.path).toBe(join(root, 'plugins', 'local', 'no-manifest', '0.0.0'));
    expect(installed.path).not.toContain('undefined');
    expect(existsSync(installed.path)).toBe(true);
  });

  test('market install: pluginInstallPath receives source.market with the normalized manifest identity', async () => {
    const root = fixture();
    const market = join(root, 'markets', 'wiring-market');
    mkdirSync(market, { recursive: true });
    packageAt(join(market, 'source'), 'wiring-plugin', '3.1.4');
    writeFileSync(join(market, 'marketplace.json'), JSON.stringify({ name: 'wiring-market', plugins: [
      { name: 'wiring-plugin', version: '3.1.4', source: { source: 'local', path: 'source' } },
    ] }));
    const manifest = loadPluginManifestFromDir(join(market, 'source'), { id: 'wiring-plugin' }).manifest;
    const installed = await installPlugin('wiring-plugin@wiring-market', { root, allowUnsigned: true, yes: true });
    expect(installed.path).toBe(pluginInstallPath(root, 'wiring-market', manifest));
    expect(installed.path).toBe(join(root, 'plugins', 'wiring-market', 'wiring-plugin', '3.1.4'));
    expect(installed.path).not.toContain('undefined');
  });

});

// 정본: seat-state/OP/DEMO-1104-THREE-SCENES.md «하나의 유기체 시나리오» 5막 ⊕ 씬 2 2:20 줄.
// mock 무대: 도구 없음 → 마켓 후보 부족 → 손 둘 mock 개발 → 비교 → 채택 → installPlugin 설치 → 같은 흐름 사용 → Done.
describe('smart plugin wizard — 도구 없음 → 마켓 → 손 둘 개발 → 채택 → 설치 → 사용 → Done', () => {
  test('classic sidetab result callback reaches wizard comparison, winner step, install, use and Done in a local mock run', async () => {
    const root = fixture();
    const workspace = join(root, 'workroom');
    mkdirSync(workspace, { recursive: true });
    const claude = packageAt(join(workspace, 'claude-scenario-plugin'), 'claude-scenario-plugin');
    const codex = packageAt(join(workspace, 'codex-scenario-plugin'), 'codex-scenario-plugin');
    const runId = 'DEMO1104-SELF-PLUGIN-mock-20261031T0543KST';
    const visibleResults = new Map<string, { ok: boolean; content: string }>();
    const registry = createClassicSidetabMissionPairSessionRegistry();
    let pairCompletion: { codex: { ok: boolean; content?: string }; claude: { ok: boolean; content?: string }; status: string } | undefined;
    const started = startClassicSidetabMissionPair({
      agent: 'claude', mission: 'Build the local scenario plugin.', parallelMission: 'Build the local scenario plugin.',
      spawnVisible: (agent) => ({ id: `${agent}-mock-pty`, cwd: workspace }),
      runVisible: async (agent, prompt) => {
        expect(prompt).toBe('Build the local scenario plugin.');
        const path = agent === 'claude' ? claude : codex;
        const result = { ok: true, content: `Implemented local candidate.\nPLUGIN_SPEC=${path}` };
        visibleResults.set(agent, result);
        return result;
      },
      registry,
      hasSession: () => true,
      killSession: () => {},
      enqueue: () => {},
      createId: (() => { let id = 0; return () => `mock-mission-${++id}`; })(),
      now: () => 100,
      onComplete: result => { pairCompletion = result; },
    });
    await started.completion;

    const wizardEvents: Array<{ ts: string; wizardId: string; step: string; text: string; detail?: unknown }> = [];
    const candidate = { name: 'market-scenario-plugin', version: '1.0.0', market: 'mock-market',
      path: join(root, 'market-candidate'), sha256: null };
    const result = await composePluginMission({ mission: 'scenario report', missing: 'scenario simulator', root, workspace, wizardId: runId }, {
      ask: async () => ({ scenario: 'default values only' }),
      searchMarket: async () => ({ candidates: [{ market: 'mock-market', name: candidate.name,
        version: candidate.version, spec: 'market-scenario-plugin@mock-market', score: 1 }], unavailable: [] }),
      install: async (spec, options) => spec === 'market-scenario-plugin@mock-market'
        ? candidate
        : installPlugin(spec, { ...options, root, yes: true }),
      trial: async request => request.origin === 'market'
        ? { ok: false, score: 1, detail: 'scenario defaults cannot be changed' }
        : { ok: true, score: request.maker === 'codex' ? 9 : 6, detail: `${request.maker} scenario fixture passed` },
      developPair: async ({ makers, goal, workspace: pairedWorkspace }) => {
        expect(goal).toContain('scenario simulator');
        expect(pairedWorkspace).toBe(workspace);
        expect(makers).toEqual(['claude', 'codex']);
        expect(pairCompletion).toMatchObject({ status: 'done', codex: { ok: true }, claude: { ok: true } });
        const spec = (maker: 'claude' | 'codex') => {
          const content = pairCompletion?.[maker].content ?? '';
          return { spec: content.split('PLUGIN_SPEC=')[1]!.trim() };
        };
        return { claude: spec('claude'), codex: spec('codex') };
      },
      onEvent: event => wizardEvents.push(event),
      notify: () => {},
    });

    expect(started.result.codex.interactionId).toBeTruthy();
    expect(visibleResults.size).toBe(2);
    expect(result).toMatchObject({ status: 'done', origin: 'maker', plugin: { name: 'codex-scenario-plugin' } });
    expect(result.trials.map(item => [item.origin, item.maker ?? '-', item.ok, item.score])).toEqual([
      ['market', '-', false, 1], ['maker', 'claude', true, 6], ['maker', 'codex', true, 9],
    ]);
    expect(listInstalledPlugins(root)).toEqual([result.plugin!]);
    const comparison = wizardEvents.find(event => event.step === 'validate');
    expect(comparison).toMatchObject({ wizardId: runId,
      detail: { winner: { maker: 'codex', spec: codex, score: 9 } } });
    expect(comparison && Date.parse(comparison.ts)).toBeGreaterThan(0);
    expect(wizardEvents.at(-1)).toMatchObject({ step: 'done', wizardId: runId, detail: { ok: true } });
    expect(result.report).toContain('Done · codex-scenario-plugin@1.2.3');
    expect(result.report).toContain(`작업실: ${workspace}`);
  });

  test('마켓 후보 부족 → Claude Code·Codex 동시 개발 → 시험 비교·채택 → plugin-install 설치 → 같은 흐름 사용 → Done 보고', async () => {
    const root = fixture();
    const workspace = join(root, 'session-workroom');
    mkdirSync(workspace, { recursive: true });
    const claude = packageAt(join(root, 'makers', 'claude', 'claude-plugin'), 'claude-plugin');
    const codex = packageAt(join(root, 'makers', 'codex', 'codex-plugin'), 'codex-plugin');
    const asked: string[][] = [];
    const makers: Array<{ maker: string; goal: string; workspace: string }> = [];
    const trials: string[] = [];
    const installed: string[] = [];
    const used: string[] = [];
    const reports: string[] = [];
    const steps: string[] = [];
    const result = await composePluginMission({
      mission: '월간 보고서를 PDF 로 발행', missing: 'pdf-export', root, workspace, wizardId: 'wiz-mock',
    }, {
      ask: async questions => { asked.push([...questions]); return { [questions[0]!]: '보고서를 PDF 로 내보낸다' }; },
      searchMarket: async () => ({ candidates: [], unavailable: ['elanous: 시험 무대에는 마켓 인덱스가 없다'] }),
      develop: async request => { makers.push(request); return { spec: request.maker === 'claude' ? claude : codex }; },
      trial: async request => {
        trials.push(`${request.origin}:${request.maker ?? '-'}`);
        return request.maker === 'claude'
          ? { ok: true, score: 6, detail: 'claude 시험 통과' }
          : { ok: true, score: 9, detail: 'codex 시험 통과' };
      },
      use: async (plugin, request) => {
        used.push(`${plugin.name}@${plugin.version}`);
        expect(request.missing).toBe('pdf-export');
        return { ok: true, detail: '보고서 발행에 사용' };
      },
      notify: report => { reports.push(report); },
      onEvent: event => { steps.push(event.step); if (event.step === 'install') installed.push(event.text); },
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]!.length).toBeGreaterThanOrEqual(1);
    expect(asked[0]!.length).toBeLessThanOrEqual(2);
    // Both side tabs get the same plugin goal in the same session workroom, at the same time.
    expect(makers.map(item => item.maker)).toEqual(['claude', 'codex']);
    expect(makers[0]!.goal).toBe(makers[1]!.goal);
    expect(makers[0]!.goal).toContain('pdf-export');
    expect(new Set(makers.map(item => item.workspace))).toEqual(new Set([workspace]));
    expect(trials).toEqual(['maker:claude', 'maker:codex']);
    expect(result.status).toBe('done');
    expect(result.origin).toBe('maker');
    expect(result.trials.map(item => [item.maker, item.score])).toEqual([['claude', 6], ['codex', 9]]);
    // The higher trial wins and is installed through plugin-install — nothing else is installed.
    expect(result.plugin).toMatchObject({ name: 'codex-plugin', version: '1.2.3', market: 'local' });
    expect(listInstalledPlugins(root)).toEqual([result.plugin!]);
    expect(existsSync(join(result.plugin!.path, 'plugin.ts'))).toBe(true);
    // The same installed plugin is used in the same flow, then Done is reported.
    expect(used).toEqual(['codex-plugin@1.2.3']);
    expect(steps).toEqual(['request', 'research', 'draft', 'validate', 'install', 'install', 'done']);
    expect(installed[0]).toContain('plugin-install 설치');
    expect(reports).toEqual([result.report]);
    expect(result.report).toContain('Done · codex-plugin@1.2.3');
    expect(result.report).toContain(`작업실: ${workspace}`);
  });

  test('CLI 가 없으면 개발 계약 전에 설치 계약을 부르고 설치된 CLI 로 개발한다', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'maker', 'cli-plugin'), 'cli-plugin');
    const installedClis: string[] = [];
    const result = await composePluginMission({ mission: '보고서 발행', missing: 'pdf-export', root, workspace: join(root, 'room') }, {
      makerCli: {},
      installMakerCli: async maker => { installedClis.push(maker); return `/opt/${maker}`; },
      searchMarket: async () => ({ candidates: [], unavailable: [] }),
      develop: async () => ({ spec: pkg }),
      trial: async () => ({ ok: true, score: 3, detail: '시험 통과' }),
      notify: () => {},
    });
    expect(installedClis).toEqual(['claude', 'codex']);
    expect(result.events.find(event => event.step === 'draft')?.detail)
      .toMatchObject({ cli: ['claude: 설치됨 /opt/claude', 'codex: 설치됨 /opt/codex'] });
    expect(result.status).toBe('done');
    expect(result.plugin?.name).toBe('cli-plugin');
  });

  test('마켓 후보가 시험을 통과하면 개발을 띄우지 않고 설치·사용한다', async () => {
    const root = fixture();
    const market = join(root, 'markets', 'test-market');
    mkdirSync(market, { recursive: true });
    packageAt(join(market, 'source'), 'market-plugin');
    writeFileSync(join(market, 'marketplace.json'), JSON.stringify({ name: 'test-market', sequence: 1,
      interface: { displayName: 'Test' },
      plugins: [{ name: 'market-plugin', version: '1.2.3', source: { source: 'local', path: 'source' } }] }));
    const queried: string[] = [];
    let developed = 0;
    const result = await composePluginMission({ mission: '보고서 발행', missing: 'pdf-export', root,
      workspace: join(root, 'room'), marketDir: join(root, 'markets'), allowUnsigned: true }, {
      searchMarket: async request => {
        queried.push(request.query);
        return { candidates: [{ market: 'test-market', name: 'market-plugin', version: '1.2.3',
          spec: 'market-plugin@test-market', score: 2 }], unavailable: [] };
      },
      develop: async () => { developed++; return { spec: join(root, 'unused') }; },
      notify: () => {},
    });
    expect(queried).toEqual(['pdf-export 보고서 발행']);
    expect(developed).toBe(0);
    expect(result.status).toBe('done');
    expect(result.origin).toBe('market');
    expect(result.plugin).toMatchObject({ name: 'market-plugin', version: '1.2.3', market: 'test-market' });
    expect(result.trials[0]).toMatchObject({ origin: 'market', spec: 'market-plugin@test-market', ok: true });
    expect(result.trials[0]!.score).toBeGreaterThan(0);
    expect(listInstalledPlugins(root)).toEqual([result.plugin!]);
  });

  test('마켓 후보가 plugin-install 검증을 통과하지 못하면 원장에 아무것도 남지 않는다', async () => {
    const root = fixture();
    const broken = packageAt(join(root, 'broken'), 'broken-plugin');
    rmSync(join(broken, 'plugin.ts'));
    const result = await composePluginMission({ mission: '보고서 발행', missing: 'pdf-export', root,
      workspace: join(root, 'room') }, {
      searchMarket: async () => ({ candidates: [{ market: 'local', name: 'broken-plugin', version: '1.2.3',
        spec: broken, score: 1 }], unavailable: [] }),
      notify: () => {},
    });
    expect(result.status).toBe('failed');
    expect(result.trials[0]).toMatchObject({ origin: 'market', ok: false });
    expect(result.reason).toContain('plugin main');
    expect(result.events.at(-1)).toMatchObject({ step: 'done', detail: { ok: false } });
    expect(listInstalledPlugins(root)).toEqual([]);
  });

  test('질문 어댑터 거부는 hand 흐름 밖으로 던지지 않고 failed 결과로 남긴다', async () => {
    const root = fixture();
    const result = await composePluginMission({ mission: '보고서 발행', missing: 'pdf-export', root,
      workspace: join(root, 'room') }, {
      ask: async () => { throw new Error('Telegram unavailable'); },
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('Telegram unavailable');
    expect(result.events.at(-1)).toMatchObject({ step: 'done', detail: { ok: false } });
  });

  test('trial 어댑터 거부는 후보 실패로 기록하고 마법사 실패로 수렴한다', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'market', 'plugin'), 'trial-plugin');
    const result = await composePluginMission({ mission: '보고서 발행', missing: 'pdf-export', root,
      workspace: join(root, 'room'), makers: [] }, {
      searchMarket: async () => ({ candidates: [{ market: 'local', name: 'trial-plugin', version: '1.2.3',
        spec: pkg, score: 1 }], unavailable: [] }),
      trial: async () => { throw new Error('trial host unavailable'); },
    });
    expect(result.status).toBe('failed');
    expect(result.trials).toContainEqual(expect.objectContaining({ ok: false, detail: expect.stringContaining('trial host unavailable') }));
    expect(result.events.at(-1)).toMatchObject({ step: 'done', detail: { ok: false } });
  });

  test('use 어댑터 거부는 Done으로 보고하지 않고 failed 결과로 남긴다', async () => {
    const root = fixture();
    const pkg = packageAt(join(root, 'market', 'plugin'), 'use-plugin');
    const result = await composePluginMission({ mission: '보고서 발행', missing: 'pdf-export', root,
      workspace: join(root, 'room') }, {
      searchMarket: async () => ({ candidates: [{ market: 'local', name: 'use-plugin', version: '1.2.3',
        spec: pkg, score: 1 }], unavailable: [] }),
      use: async () => { throw new Error('runtime unavailable'); },
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('runtime unavailable');
    expect(result.report).toContain('[스마트 플러그인 마법사] 실패');
    expect(result.report).not.toContain('[스마트 플러그인 마법사] Done');
    expect(result.events.at(-1)).toMatchObject({ step: 'done', detail: { ok: false } });
  });

  test('마법사는 질문 1~2개만 던진다', async () => {
    const root = fixture();
    await expect(composePluginMission({ mission: '보고서 발행', missing: 'pdf-export', root,
      workspace: join(root, 'room'), questions: ['a', 'b', 'c'] }, {})).rejects.toThrow('one or two questions');
  });

  test('composeMissionGraph 가 마법사 접합부를 지나 채택 플러그인을 기존 조합·검증 경로에 넣는다', async () => {
    const repo = join(import.meta.dir, '..', '..', '..');
    const standardYaml = readFileSync(join(repo, 'graphs/work/research-report.yaml'), 'utf8');
    const dir = fixture();
    const wizardRoot = fixture();
    const pkg = packageAt(join(wizardRoot, 'maker', 'wiring-plugin'), 'wiring-plugin');
    const prompts: string[] = [];
    const result = await composeMissionGraph({
      text: '보고서 작성 검증', completion: 'research-report', ledgerPath: join(dir, 'task-agent-actions.json'),
      cardId: 'ta-plugin-wizard', root: repo, standard: selectTaskComposition('research-report'),
      pluginWizard: { mission: '보고서 작성 검증', missing: 'pdf-export', root: wizardRoot,
        workspace: join(wizardRoot, 'room'), wizardId: 'wiz-wiring' },
    }, {
      callLLM: async prompt => {
        prompts.push(prompt);
        return `BASE: work-research-report-rehearsal\nSLUG: mission-report\nSUMMARY: 보고서 작성 검증\n\`\`\`yaml\n${standardYaml}\`\`\``;
      },
      pluginWizard: {
        searchMarket: async () => ({ candidates: [], unavailable: [] }),
        develop: async () => ({ spec: pkg }),
        trial: async () => ({ ok: true, score: 4, detail: '시험 통과' }),
        notify: () => {},
      },
    });
    expect(result.plugin?.status).toBe('done');
    expect(result.plugin?.plugin?.name).toBe('wiring-plugin');
    expect(result.reason).toContain('플러그인 채택 wiring-plugin@1.2.3');
    expect(prompts[0]).toContain('wiring-plugin');
    const recorded = JSON.parse(readFileSync(join(dir, 'ta-plugin-wizard.composition.json'), 'utf8'));
    expect(recorded.plugin).toMatchObject({ status: 'done', origin: 'maker', name: 'wiring-plugin' });
    expect(recorded.base).toBe('graphs/work/research-report.yaml');
    expect(listInstalledPlugins(wizardRoot).map(item => item.name)).toEqual(['wiring-plugin']);
  }, 30_000);

  test('production task-hand caller routes an explicit missing-tool signal through the wizard and records adoption', async () => {
    const taskRoot = fixture();
    const installRoot = fixture();
    const compositionRoot = join(taskRoot, 'compositions');
    const workGraphs = join(compositionRoot, 'graphs', 'work');
    mkdirSync(workGraphs, { recursive: true });
    const standardYaml = readFileSync(join(import.meta.dir, '../../..', 'graphs/work/research-report.yaml'), 'utf8');
    writeFileSync(join(workGraphs, 'research-report.yaml'), standardYaml);
    writeFileSync(join(workGraphs, 'csv-export.yaml'), standardYaml.replace('work-research-report', 'work-csv-export'));
    const pkg = packageAt(join(taskRoot, 'maker', 'task-plugin'), 'task-plugin', '0.1.0');
    const events: string[] = [];
    const off = debug.registerSink({ name: 'task-hand-plugin-wizard-test', emit: record => {
      if (record.category === 'graph.compose') {
        const reason = (record.data as { reason?: unknown } | undefined)?.reason;
        events.push(String(reason ?? ''));
      }
    } });
    try {
      const result = await handTask({
        id: 'ta-plugin-wizard-production-path', text: 'csv export monthly report',
        completion: 'research-report', statePath: join(taskRoot, 'task-state.json'), compositionRoot,
        pluginWizard: { missing: 'csv-export', root: installRoot, workspace: taskRoot },
        pluginWizardDeps: {
          ask: async questions => { expect(questions.length).toBeGreaterThanOrEqual(1); return { [questions[0]!]: '월간 보고서 CSV' }; },
          searchMarket: async () => ({ candidates: [], unavailable: [] }),
          develop: async () => ({ spec: pkg }),
          trial: async () => ({ ok: true, score: 5, detail: 'fixture plugin passed its trial' }),
          use: async plugin => ({ ok: true, detail: `${plugin.name} used for CSV export` }),
          notify: () => {},
        },
      });
      expect(result.mode).toBe('shadow');
      expect(listInstalledPlugins(installRoot).map(plugin => plugin.name)).toEqual(['task-plugin']);
      expect(events.some(reason => reason.includes('플러그인 채택 task-plugin@0.1.0'))).toBe(true);
    } finally { off(); }
  }, 30_000);
});
