import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIndexKeyPair, signIndex } from '../../market/signed-index.js';
import { addMarket } from './market-fetch.js';
import { installPlugin, listInstalledPlugins } from './plugin-install.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(requires: string[] = ['facts-pack'], visibility: 'public' | 'internal' = 'public') {
  const root = mkdtempSync(join(tmpdir(), 'plugin-requires-'));
  dirs.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.2.3', main: './plugin.ts', requires: { knowledgePacks: requires } }));
  writeFileSync(join(source, 'plugin.ts'), 'export default {}');
  const pack = join(root, 'pack');
  mkdirSync(pack);
  writeFileSync(join(pack, 'facts.txt'), 'verified facts');
  const pluginArchive = join(root, 'plugin.tgz');
  const packArchive = join(root, 'pack.tgz');
  execFileSync('tar', ['-czf', pluginArchive, '-C', source, '.']);
  execFileSync('tar', ['-czf', packArchive, '-C', pack, '.']);
  const pluginBytes = readFileSync(pluginArchive);
  const packBytes = readFileSync(packArchive);
  const artifact = (key: string, bytes: Buffer) => ({ key, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  const packEntry = { name: 'facts-pack', version: '2.0.0', visibility,
    ...(visibility === 'internal' ? { enterpriseId: 'tenant-a' } : {}), artifact: artifact('pack.tgz', packBytes) };
  const index = { name: 'test-market', interface: { displayName: 'Test' }, sequence: 1,
    plugins: [{ name: 'sample-plugin', version: '1.2.3', source: { source: 'local' }, artifact: artifact('plugin.tgz', pluginBytes),
      'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } }], knowledgePacks: [packEntry] };
  const keys = generateIndexKeyPair();
  const configPath = join(root, 'config.json');
  addMarket('test-market', 'https://example.org/market/', { configPath });
  if (visibility === 'internal') {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.market.internalMarkets = [{ name: 'test-market', url: 'https://example.org/market/',
      enterpriseIds: ['tenant-a'], trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] }];
    writeFileSync(configPath, JSON.stringify(config));
  }
  const indexBytes = Buffer.from(JSON.stringify(index));
  const signature = signIndex(indexBytes, keys.privateKeyPem, keys.keyId);
  const requests: string[] = [];
  let tamperPack = false;
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/marketplace.json')) return new Response(indexBytes);
    if (url.endsWith('/index.sig')) return new Response(signature);
    if (url.endsWith('/plugin.tgz')) return new Response(pluginBytes);
    if (url.endsWith('/pack.tgz')) return new Response(tamperPack ? Buffer.concat([packBytes, Buffer.from('bad')]) : packBytes);
    throw new Error(`unexpected URL: ${url}`);
  }) as typeof fetch;
  const opts = { root: join(root, 'installed'), configPath, fetcher, trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }], yes: true };
  return { root, source, opts, requests, indexBytes, signature, pluginBytes, packBytes, tamper: () => { tamperPack = true; } };
}

test('declared knowledge pack requires install verified pack alongside signed plugin, preserving the installed plugin result', async () => {
  const { root, opts, requests } = setup();
  const result = await installPlugin('sample-plugin@test-market', opts);
  expect(result).toMatchObject({ name: 'sample-plugin', version: '1.2.3', market: 'test-market' });
  expect(existsSync(join(result.path, 'plugin.ts'))).toBe(true);
  expect(readFileSync(join(opts.root, 'knowledge-packs', 'test-market', 'facts-pack', '2.0.0', 'facts.txt'), 'utf8')).toBe('verified facts');
  expect(listInstalledPlugins(opts.root)).toEqual([result]);
  expect(requests).toContain('https://example.org/market/pack.tgz');
  const standalone = setup([]);
  await installPlugin('sample-plugin@test-market', standalone.opts);
  expect(standalone.requests).not.toContain('https://example.org/market/pack.tgz');
  expect(existsSync(join(standalone.opts.root, 'knowledge-packs'))).toBe(false);
});

test('another signed plugin reuses only an intact verified pack, including after a failed ledger commit', async () => {
  const { root, opts, requests, indexBytes } = setup();
  const first = await installPlugin('sample-plugin@test-market', opts);
  const pack = join(opts.root, 'knowledge-packs', 'test-market', 'facts-pack', '2.0.0');
  const second = join(root, 'second-plugin');
  mkdirSync(second);
  writeFileSync(join(second, 'plugin.json'), JSON.stringify({ id: 'second-plugin', version: '1.0.0', main: './plugin.ts', requires: { knowledgePacks: ['facts-pack'] } }));
  writeFileSync(join(second, 'plugin.ts'), 'export default {}');
  const secondArchive = join(root, 'second.tgz');
  execFileSync('tar', ['-czf', secondArchive, '-C', second, '.']);
  const secondBytes = readFileSync(secondArchive);
  // Sign an index that contains two independently installable plugins sharing the same pack.
  const keys = generateIndexKeyPair();
  const configPath = join(root, 'shared-config.json');
  addMarket('test-market', 'https://example.org/market/', { configPath });
  const signed = JSON.parse(indexBytes.toString());
  signed.plugins.push({ name: 'second-plugin', version: '1.0.0', source: { source: 'local' },
    artifact: { key: 'second.tgz', sha256: createHash('sha256').update(secondBytes).digest('hex'), bytes: secondBytes.length },
    'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } });
  const signedBytes = Buffer.from(JSON.stringify(signed));
  const signature = signIndex(signedBytes, keys.privateKeyPem, keys.keyId);
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/marketplace.json')) return new Response(signedBytes);
    if (url.endsWith('/index.sig')) return new Response(signature);
    if (url.endsWith('/second.tgz')) return new Response(secondBytes);
    if (url.endsWith('/pack.tgz')) return new Response((await (opts.fetcher as typeof fetch)(url)).body);
    throw new Error(`unexpected URL: ${url}`);
  }) as typeof fetch;
  const shared = { ...opts, configPath, fetcher, trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] };
  const original = readFileSync(join(pack, 'facts.txt'));
  const installed = await installPlugin('second-plugin@test-market', shared);
  expect(installed.name).toBe('second-plugin');
  expect(listInstalledPlugins(opts.root)).toEqual([first, installed]);
  expect(readFileSync(join(pack, 'facts.txt'))).toEqual(original);
  expect(requests).toContain('https://example.org/market/pack.tgz');

  const third = join(root, 'third-plugin');
  mkdirSync(third);
  writeFileSync(join(third, 'plugin.json'), JSON.stringify({ id: 'third-plugin', version: '1.0.0', main: './plugin.ts', requires: { knowledgePacks: ['facts-pack'] } }));
  writeFileSync(join(third, 'plugin.ts'), 'export default {}');
  const thirdArchive = join(root, 'third.tgz');
  execFileSync('tar', ['-czf', thirdArchive, '-C', third, '.']);
  const thirdBytes = readFileSync(thirdArchive);
  signed.plugins.push({ name: 'third-plugin', version: '1.0.0', source: { source: 'local' },
    artifact: { key: 'third.tgz', sha256: createHash('sha256').update(thirdBytes).digest('hex'), bytes: thirdBytes.length },
    'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } });
  const updatedBytes = Buffer.from(JSON.stringify(signed));
  const updatedSignature = signIndex(updatedBytes, keys.privateKeyPem, keys.keyId);
  let tamperPack = true;
  const thirdFetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/marketplace.json')) return new Response(updatedBytes);
    if (url.endsWith('/index.sig')) return new Response(updatedSignature);
    if (url.endsWith('/third.tgz')) return new Response(thirdBytes);
    if (url.endsWith('/pack.tgz') && tamperPack) return new Response(Buffer.concat([readFileSync(join(root, 'pack.tgz')), Buffer.from('bad')]));
    return fetcher(input);
  }) as typeof fetch;
  await expect(installPlugin('third-plugin@test-market', { ...shared, fetcher: thirdFetcher, refresh: true })).rejects.toMatchObject({ reason: 'scan' });
  expect(readFileSync(join(pack, 'facts.txt'))).toEqual(original);
  tamperPack = false;
  const ledger = join(opts.root, 'plugins', 'installed.json');
  rmSync(ledger);
  mkdirSync(ledger);
  await expect(installPlugin('third-plugin@test-market', { ...shared, fetcher: thirdFetcher, refresh: true })).rejects.toMatchObject({ reason: 'io' });
  expect(readFileSync(join(pack, 'facts.txt'))).toEqual(original);
  expect(existsSync(join(opts.root, 'plugins', 'test-market', 'third-plugin', '1.0.0'))).toBe(false);
});

test('an existing pack with changed contents, extra entries or a symlink cannot satisfy a second plugin', async () => {
  const fixture = setup();
  await installPlugin('sample-plugin@test-market', fixture.opts);
  const pack = join(fixture.opts.root, 'knowledge-packs', 'test-market', 'facts-pack', '2.0.0');
  const source = join(fixture.root, 'second');
  mkdirSync(source);
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'second-plugin', version: '1.0.0', main: './plugin.ts', requires: { knowledgePacks: ['facts-pack'] } }));
  writeFileSync(join(source, 'plugin.ts'), 'export default {}');
  const archive = join(fixture.root, 'second.tgz');
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  const bytes = readFileSync(archive);
  const keys = generateIndexKeyPair();
  const index = JSON.parse(fixture.indexBytes.toString());
  index.plugins.push({ name: 'second-plugin', version: '1.0.0', source: { source: 'local' },
    artifact: { key: 'second.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
    'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } });
  const market = join(fixture.root, 'offline-market', 'test-market');
  mkdirSync(market, { recursive: true });
  writeFileSync(join(market, 'marketplace.json'), JSON.stringify(index));
  writeFileSync(join(market, 'index.sig'), signIndex(readFileSync(join(market, 'marketplace.json')), keys.privateKeyPem, keys.keyId));
  writeFileSync(join(market, 'pack.tgz'), fixture.packBytes);
  writeFileSync(join(market, 'second.tgz'), bytes);
  const opts = { root: fixture.opts.root, marketDir: join(fixture.root, 'offline-market'), trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }], yes: true };
  for (const change of [
    () => writeFileSync(join(pack, 'facts.txt'), 'altered'),
    () => { writeFileSync(join(pack, 'facts.txt'), 'verified facts'); writeFileSync(join(pack, 'extra.txt'), 'extra'); },
    () => { rmSync(join(pack, 'extra.txt')); rmSync(join(pack, 'facts.txt')); symlinkSync(join(fixture.root, 'pack', 'facts.txt'), join(pack, 'facts.txt')); },
  ]) {
    change();
    await expect(installPlugin('second-plugin@test-market', opts)).rejects.toMatchObject({ reason: 'conflict' });
    expect(existsSync(join(opts.root, 'plugins', 'test-market', 'second-plugin', '1.0.0'))).toBe(false);
    expect(listInstalledPlugins(opts.root)).toHaveLength(1);
  }
});

test('a linked installation root or staging parent is rejected before unpacking', async () => {
  const rootLink = setup();
  const outside = join(rootLink.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, rootLink.opts.root);
  await expect(installPlugin('sample-plugin@test-market', rootLink.opts)).rejects.toMatchObject({ reason: 'io', message: expect.stringContaining('unsafe installation parent') });
  expect(existsSync(join(outside, 'plugins'))).toBe(false);

  const stagingLink = setup();
  mkdirSync(join(stagingLink.opts.root, 'plugins'), { recursive: true });
  symlinkSync(outside, join(stagingLink.opts.root, 'plugins', '.staging'));
  await expect(installPlugin('sample-plugin@test-market', stagingLink.opts)).rejects.toMatchObject({ reason: 'io', message: expect.stringContaining('unsafe installation parent') });
  expect(existsSync(join(outside, 'plugins'))).toBe(false);
});

test('a linked ancestor above the installation root cannot redirect plugin and pack writes', async () => {
  const fixture = setup();
  const outside = join(fixture.root, 'outside');
  mkdirSync(outside);
  const linkedParent = join(fixture.root, 'linked-parent');
  symlinkSync(outside, linkedParent);
  const root = join(linkedParent, 'installed');
  await expect(installPlugin('sample-plugin@test-market', { ...fixture.opts, root })).rejects.toMatchObject({
    reason: 'io', message: expect.stringContaining('unsafe installation parent'),
  });
  expect(existsSync(join(outside, 'installed', 'plugins'))).toBe(false);
  expect(existsSync(join(outside, 'installed', 'knowledge-packs'))).toBe(false);
});

test('a linked knowledge-pack ancestor cannot redirect a new pack outside the installation root', async () => {
  const fixture = setup();
  const outside = join(fixture.root, 'outside');
  mkdirSync(outside);
  mkdirSync(join(fixture.opts.root, 'knowledge-packs'), { recursive: true });
  symlinkSync(outside, join(fixture.opts.root, 'knowledge-packs', 'test-market'));
  await expect(installPlugin('sample-plugin@test-market', fixture.opts)).rejects.toMatchObject({ reason: 'io', message: expect.stringContaining('unsafe installation parent') });
  expect(existsSync(join(outside, 'facts-pack'))).toBe(false);
  expect(listInstalledPlugins(fixture.opts.root)).toEqual([]);
});

test('a linked knowledge-pack ancestor cannot satisfy reuse even when outside contents match', async () => {
  const fixture = setup();
  const outside = join(fixture.root, 'outside');
  mkdirSync(join(outside, 'facts-pack', '2.0.0'), { recursive: true });
  writeFileSync(join(outside, 'facts-pack', '2.0.0', 'facts.txt'), 'verified facts');
  mkdirSync(join(fixture.opts.root, 'knowledge-packs', 'test-market'), { recursive: true });
  symlinkSync(join(outside, 'facts-pack'), join(fixture.opts.root, 'knowledge-packs', 'test-market', 'facts-pack'));
  await expect(installPlugin('sample-plugin@test-market', fixture.opts)).rejects.toMatchObject({ reason: 'io', message: expect.stringContaining('unsafe installation parent') });
  expect(readFileSync(join(outside, 'facts-pack', '2.0.0', 'facts.txt'), 'utf8')).toBe('verified facts');
  expect(listInstalledPlugins(fixture.opts.root)).toEqual([]);
});

test('a linked plugin destination parent cannot redirect the plugin move', async () => {
  const fixture = setup();
  const outside = join(fixture.root, 'outside');
  mkdirSync(outside);
  mkdirSync(join(fixture.opts.root, 'plugins'), { recursive: true });
  symlinkSync(outside, join(fixture.opts.root, 'plugins', 'test-market'));
  await expect(installPlugin('sample-plugin@test-market', fixture.opts)).rejects.toMatchObject({ reason: 'io', message: expect.stringContaining('unsafe installation parent') });
  expect(existsSync(join(outside, 'sample-plugin'))).toBe(false);
  expect(existsSync(join(fixture.opts.root, 'knowledge-packs'))).toBe(false);
});

test('missing or tampered required packs abort without installing either package', async () => {
  const missing = setup(['not-listed']);
  await expect(installPlugin('sample-plugin@test-market', missing.opts)).rejects.toMatchObject({ reason: 'io' });
  expect(listInstalledPlugins(missing.opts.root)).toEqual([]);
  const bad = setup();
  bad.tamper();
  await expect(installPlugin('sample-plugin@test-market', bad.opts)).rejects.toMatchObject({ reason: 'scan' });
  expect(listInstalledPlugins(bad.opts.root)).toEqual([]);
  expect(existsSync(join(bad.opts.root, 'knowledge-packs'))).toBe(false);
});

test('internal knowledge packs require enterprise authorization, and local standalone plugins remain installable', async () => {
  const internal = setup(['facts-pack'], 'internal');
  await expect(installPlugin('sample-plugin@test-market', internal.opts)).rejects.toMatchObject({ reason: 'io' });
  expect(listInstalledPlugins(internal.opts.root)).toEqual([]);
  expect(existsSync(join(internal.opts.root, 'knowledge-packs'))).toBe(false);
  const allowed = setup(['facts-pack'], 'internal');
  const permitted = await installPlugin('sample-plugin@test-market', { ...allowed.opts, enterpriseId: 'tenant-a' });
  expect(listInstalledPlugins(allowed.opts.root)).toEqual([permitted]);
  expect(readFileSync(join(allowed.opts.root, 'knowledge-packs', 'test-market', 'facts-pack', '2.0.0', 'facts.txt'), 'utf8')).toBe('verified facts');
  const denied = setup(['facts-pack'], 'internal');
  await expect(installPlugin('sample-plugin@test-market', { ...denied.opts, enterpriseId: 'tenant-b' })).rejects.toMatchObject({ reason: 'io' });
  expect(listInstalledPlugins(denied.opts.root)).toEqual([]);
  const local = setup([]);
  const installed = await installPlugin(local.source, { root: local.opts.root });
  expect(installed.market).toBe('local');
});

test('a standalone skills pack without a main still installs without knowledge-pack downloads', async () => {
  const fixture = setup([]);
  const skills = join(fixture.root, 'standalone', 'skills', 'demo');
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(fixture.root, 'standalone', 'plugin.json'), JSON.stringify({ id: 'standalone-pack', version: '1.0.0' }));
  writeFileSync(join(skills, 'SKILL.md'), '# demo');
  const installed = await installPlugin(join(fixture.root, 'standalone'), { root: fixture.opts.root });
  expect(installed).toMatchObject({ name: 'standalone-pack', market: 'local', version: '1.0.0' });
  expect(existsSync(join(installed.path, 'skills', 'demo', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(fixture.opts.root, 'knowledge-packs'))).toBe(false);
});

test('a changed signed index cannot provide a required pack', async () => {
  const fixture = setup();
  fixture.indexBytes[0] = fixture.indexBytes[0]! ^ 1;
  await expect(installPlugin('sample-plugin@test-market', fixture.opts)).rejects.toMatchObject({ reason: 'signature' });
  expect(listInstalledPlugins(fixture.opts.root)).toEqual([]);
  expect(existsSync(join(fixture.opts.root, 'knowledge-packs'))).toBe(false);
});

test('offline signed market installs the declared pack while an unsigned market cannot satisfy it', async () => {
  const fixture = setup();
  const marketDir = join(fixture.root, 'offline-markets');
  const market = join(marketDir, 'test-market');
  mkdirSync(market, { recursive: true });
  writeFileSync(join(market, 'marketplace.json'), fixture.indexBytes);
  writeFileSync(join(market, 'index.sig'), fixture.signature);
  writeFileSync(join(market, 'plugin.tgz'), fixture.pluginBytes);
  writeFileSync(join(market, 'pack.tgz'), fixture.packBytes);
  const opts = { root: fixture.opts.root, marketDir, trustedKeys: fixture.opts.trustedKeys, yes: true };
  const installed = await installPlugin('sample-plugin@test-market', opts);
  expect(existsSync(join(installed.path, 'plugin.ts'))).toBe(true);
  expect(readFileSync(join(opts.root, 'knowledge-packs', 'test-market', 'facts-pack', '2.0.0', 'facts.txt'), 'utf8')).toBe('verified facts');
  rmSync(join(market, 'index.sig'));
  await expect(installPlugin('sample-plugin@test-market', { ...opts, root: join(fixture.root, 'unsigned'), allowUnsigned: true })).rejects.toMatchObject({ reason: 'signature' });
  expect(listInstalledPlugins(join(fixture.root, 'unsigned'))).toEqual([]);
});

test('failed ledger commit rolls back both the plugin and its declared knowledge pack', async () => {
  const { opts } = setup();
  const ledger = join(opts.root, 'plugins', 'installed.json');
  mkdirSync(ledger, { recursive: true });
  await expect(installPlugin('sample-plugin@test-market', opts)).rejects.toMatchObject({ reason: 'io' });
  expect(listInstalledPlugins(opts.root)).toEqual([]);
  expect(existsSync(join(opts.root, 'knowledge-packs', 'test-market', 'facts-pack', '2.0.0'))).toBe(false);
  expect(existsSync(join(opts.root, 'plugins', 'test-market', 'sample-plugin', '1.2.3'))).toBe(false);
});
