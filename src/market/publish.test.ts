import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { publishMarket } from './publish';
import { generateIndexKeyPair, verifyIndex } from './signed-index';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function fixture(fn: (root: string) => void, local = false): void {
  const root = mkdtempSync(join(local ? import.meta.dir : tmpdir(), 'market-publish-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function archiveNames(archive: Uint8Array): string[] {
  const tar = gunzipSync(archive);
  const names: string[] = [];
  const field = (part: Buffer) => part.toString().replace(/\0.*$/, '');
  for (let offset = 0; tar.subarray(offset, offset + 512).some(byte => byte !== 0);) {
    const h = tar.subarray(offset, offset + 512);
    const prefix = field(h.subarray(345, 500));
    const name = field(h.subarray(0, 100));
    names.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(parseInt(field(h.subarray(124, 136)).trim(), 8) / 512) * 512;
  }
  return names;
}

function treeNames(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? treeNames(join(dir, entry.name), path) : [path];
  }).sort();
}

function setBundle(root: string, name: string, bundle: Array<string | { from: string; as: string }>, graphs?: string[]): void {
  const path = join(root, 'plugins', name, 'plugin.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.extensions['ai.elanous'].bundle = bundle;
  if (graphs) manifest.extensions['ai.elanous'].graphs = graphs;
  writeFileSync(path, JSON.stringify(manifest));
}

function plugin(root: string, name: string, pricing?: { model: string }): void {
  const dir = join(root, 'plugins', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: `${name} description`,
    extensions: { 'ai.elanous': { capabilities: [], connectors: [], category: 'Tools', ...(pricing ? { pricing } : {}) } } }));
  writeFileSync(join(dir, 'payload'), 'v1');
}

describe('publishMarket', () => {
  test('rejects internal references in the packaged bundle, caps hits, and still publishes clean packs', () => fixture(root => {
    plugin(root, 'bad-plugin');
    plugin(root, 'good-plugin');
    writeFileSync(join(root, 'plugins', 'good-plugin', 'README.md'),
      'const C = { deep: "#1D2751", red: "#E95047" }; #243063\nhttps://github.com/ElanvitalAI/elanous/releases/tag/v0.2.5');
    writeFileSync(join(root, 'plugins', 'good-plugin', 'binary.dat'), Buffer.from('docs/marketing/\0PR #21849'));
    mkdirSync(join(root, 'bundle'));
    writeFileSync(join(root, 'bundle', 'script.json'),
      'docs/marketing (LAUNCH 초안) · PR #21849 · 컷 e24cb6e\n' + 'docs/brand/icon\n'.repeat(25));
    setBundle(root, 'bad-plugin', [{ from: 'bundle/script.json', as: 'script.json' }]);
    const outDir = join(root, 'out');
    const input = { pluginsDir: join(root, 'plugins'), bundleRoot: root, outDir,
      market: { name: 'elanous', displayName: 'Elanous' }, key: generateIndexKeyPair() };
    const result = publishMarket(input);
    expect(result.ok).toBe(false);
    expect(result.published.map(item => item.name)).toEqual(['good-plugin']);
    expect(result.skipped).toEqual([{ dir: 'bad-plugin', reason: 'internal-reference', hits: [
      { file: 'script.json', line: 1, marker: 'internal-doc-path' },
      { file: 'script.json', line: 1, marker: 'private-pr-number' },
      { file: 'script.json', line: 1, marker: 'cut-hash' },
      ...Array.from({ length: 17 }, (_, i) => ({ file: 'script.json', line: i + 2, marker: 'internal-doc-path' as const })),
    ] }]);
    expect(existsSync(join(outDir, 'bad-plugin'))).toBe(false);
    expect(existsSync(join(outDir, 'plugins', 'bad-plugin'))).toBe(false);
    const index = JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8'));
    expect(index.plugins.map((item: { name: string }) => item.name)).toEqual(['good-plugin']);
    const originalSha = result.published[0]!.sha256;
    rmSync(join(root, 'plugins', 'bad-plugin'), { recursive: true });
    const clean = publishMarket({ ...input, outDir: join(root, 'clean-out') });
    expect(clean.ok).toBe(true);
    expect(clean.published[0]!.sha256).toBe(originalSha);
  }));

  test('refuses Markdown links to internal document paths even when README contains a NUL byte', () => fixture(root => {
    plugin(root, 'linked-plugin');
    writeFileSync(join(root, 'plugins', 'linked-plugin', 'README.md'), '\0[문서](docs/marketing)');
    const outDir = join(root, 'out');
    const result = publishMarket({ pluginsDir: join(root, 'plugins'), outDir,
      market: { name: 'elanous', displayName: 'Elanous' }, key: generateIndexKeyPair() });
    expect(result.ok).toBe(false);
    expect(result.skipped).toEqual([{ dir: 'linked-plugin', reason: 'internal-reference', hits: [
      { file: 'README.md', line: 1, marker: 'internal-doc-path' },
    ] }]);
    expect(result.published).toEqual([]);
    expect(existsSync(join(outDir, 'linked-plugin'))).toBe(false);
  }));

  test('refuses internal references in a README that contains an invalid UTF-8 byte', () => fixture(root => {
    plugin(root, 'linked-plugin');
    writeFileSync(join(root, 'plugins', 'linked-plugin', 'README.md'), Buffer.concat([Buffer.from([0xff]), Buffer.from('[문서](docs/marketing)')]));
    const outDir = join(root, 'out');
    const result = publishMarket({ pluginsDir: join(root, 'plugins'), outDir,
      market: { name: 'elanous', displayName: 'Elanous' }, key: generateIndexKeyPair() });
    expect(result.ok).toBe(false);
    expect(result.skipped).toEqual([{ dir: 'linked-plugin', reason: 'internal-reference', hits: [
      { file: 'README.md', line: 1, marker: 'internal-doc-path' },
    ] }]);
    expect(result.published).toEqual([]);
    expect(existsSync(join(outDir, 'linked-plugin'))).toBe(false);
  }));

  test('CLI exits non-zero and shows hits in both human and JSON modes', () => fixture(root => {
    plugin(root, 'bad-plugin');
    plugin(root, 'good-plugin');
    writeFileSync(join(root, 'plugins', 'bad-plugin', 'README.md'), 'docs/marketing · PR #21849 · 컷 e24cb6e');
    const key = generateIndexKeyPair();
    const keyPath = join(root, 'key.pem');
    writeFileSync(keyPath, key.privateKeyPem);
    for (const json of [false, true]) {
      const result = spawnSync('bun', ['bin/elanous.mjs', '--test', 'market', 'publish',
        '--dir', join(root, 'plugins'), '--out', join(root, json ? 'json-out' : 'human-out'),
        '--key', keyPath, '--key-id', key.keyId, ...(json ? ['--json'] : [])],
      { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 60000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('bad-plugin/README.md:1: internal-doc-path');
      expect(result.stderr).toContain('bad-plugin/README.md:1: private-pr-number');
      expect(result.stderr).toContain('bad-plugin/README.md:1: cut-hash');
      if (json) expect(JSON.parse(result.stdout)).toMatchObject({ ok: false,
        published: [{ name: 'good-plugin' }], skipped: [{ dir: 'bad-plugin', reason: 'internal-reference' }] });
    }
  }, true));

  test('publishes free only, signs exact bytes, advances sequence and rejects immutable version changes', () => fixture(root => {
    plugin(root, 'free-plugin');
    plugin(root, 'paid-plugin', { model: 'one-time' });
    mkdirSync(join(root, 'plugins', 'missing'));
    const pair = generateIndexKeyPair();
    const input = { pluginsDir: join(root, 'plugins'), outDir: join(root, 'out'),
      market: { name: 'elanous', displayName: 'Elanous' }, key: pair, now: new Date('2026-10-01T00:00:00Z') };
    const first = publishMarket(input);
    expect(first.ok).toBe(true);
    expect(first.sequence).toBe(1);
    expect(first.published).toHaveLength(1);
    expect(first.published[0]?.name).toBe('free-plugin');
    expect(first.skipped).toEqual([{ dir: 'missing', reason: 'missing-plugin.json' },
      { dir: 'paid-plugin', reason: 'paid-not-allowed-in-M0' }]);
    const bytes = readFileSync(join(root, 'out', 'marketplace.json'));
    const index = JSON.parse(bytes.toString());
    expect(bytes.toString()).toBe(JSON.stringify(index, null, 2) + '\n');
    expect(index.plugins).toHaveLength(1);
    expect(index.plugins[0]).toMatchObject({ source: { source: 'local', path: './plugins/free-plugin' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Tools',
      'ai.elanous': { pricing: { model: 'free' } } });
    const artifact = index.plugins[0].artifact;
    const archive = readFileSync(join(root, 'out', artifact.key));
    expect(archive).toHaveLength(artifact.bytes);
    expect(createHash('sha256').update(archive).digest('hex')).toBe(artifact.sha256);
    expect(artifact.key).toBe(`free-plugin/1.0.0/${artifact.sha256}.tgz`);
    expect(verifyIndex({ marketplaceBytes: bytes, signatureText: readFileSync(join(root, 'out', 'index.sig'), 'utf8'),
      trustedKeys: [{ keyId: pair.keyId, publicKey: pair.publicKey }] })).toMatchObject({ ok: true, sequence: 1 });
    expect(publishMarket(input).sequence).toBe(2);
    expect(JSON.parse(readFileSync(join(root, 'out', 'marketplace.json'), 'utf8')).plugins[0].artifact.sha256).toBe(artifact.sha256);
    writeFileSync(join(root, 'plugins', 'free-plugin', 'payload'), 'v2');
    expect(() => publishMarket(input)).toThrow('version-immutable');
    expect(JSON.parse(readFileSync(join(root, 'out', 'marketplace.json'), 'utf8')).sequence).toBe(2);
  }));

  test('reuses the recorded archive when only gzip bytes differ and still rejects changed content', () => fixture(root => {
    plugin(root, 'free-plugin');
    const outDir = join(root, 'out');
    const input = { pluginsDir: join(root, 'plugins'), outDir,
      market: { name: 'elanous', displayName: 'Elanous' }, key: generateIndexKeyPair() };
    const first = publishMarket(input);
    const originalSha = first.published[0]!.sha256;
    const archiveDir = join(outDir, 'free-plugin', '1.0.0');
    const originalPath = join(archiveDir, `${originalSha}.tgz`);
    const tar = gunzipSync(readFileSync(originalPath));
    const oldArchive = gzipSync(tar, { level: 1 });
    const oldSha = createHash('sha256').update(oldArchive).digest('hex');
    expect(oldSha).not.toBe(originalSha);
    writeFileSync(join(archiveDir, `${oldSha}.tgz`), oldArchive);
    rmSync(originalPath);
    const historyPath = join(outDir, '.publication-history.json');
    const history = JSON.parse(readFileSync(historyPath, 'utf8'));
    history[0].sha256 = oldSha;
    writeFileSync(historyPath, JSON.stringify(history));
    const indexPath = join(outDir, 'marketplace.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.plugins[0].artifact = { sha256: oldSha, bytes: oldArchive.length,
      key: `free-plugin/1.0.0/${oldSha}.tgz` };
    writeFileSync(indexPath, JSON.stringify(index));

    const second = publishMarket(input);
    expect(second).toMatchObject({ ok: true, sequence: 2,
      published: [{ name: 'free-plugin', version: '1.0.0', sha256: oldSha }] });
    const reused = JSON.parse(readFileSync(indexPath, 'utf8')).plugins[0].artifact;
    expect(reused).toEqual(index.plugins[0].artifact);
    expect(createHash('sha256').update(readFileSync(join(outDir, reused.key))).digest('hex')).toBe(oldSha);
    expect(readFileSync(join(outDir, reused.key))).toEqual(oldArchive);
    expect(readdirSync(archiveDir)).toEqual([`${oldSha}.tgz`]);
    expect(JSON.parse(readFileSync(historyPath, 'utf8'))).toEqual(history);
    expect(readFileSync(join(outDir, 'plugins', 'free-plugin', 'payload'), 'utf8')).toBe('v1');
    expect(verifyIndex({ marketplaceBytes: readFileSync(indexPath),
      signatureText: readFileSync(join(outDir, 'index.sig'), 'utf8'),
      trustedKeys: [{ keyId: input.key.keyId, publicKey: input.key.publicKey }] }).ok).toBe(true);

    rmSync(join(outDir, reused.key));
    expect(() => publishMarket(input)).toThrow('version-immutable: free-plugin@1.0.0');
    writeFileSync(join(outDir, reused.key), oldArchive);
    writeFileSync(join(root, 'plugins', 'free-plugin', 'payload'), 'v2');
    expect(() => publishMarket(input)).toThrow('version-immutable: free-plugin@1.0.0');
    expect(JSON.parse(readFileSync(indexPath, 'utf8')).sequence).toBe(2);

    writeFileSync(join(root, 'plugins', 'free-plugin', 'payload'), 'v1');
    writeFileSync(join(outDir, reused.key), Buffer.from('not a gzip archive'));
    expect(() => publishMarket(input)).toThrow('version-immutable: free-plugin@1.0.0');
  }));

  test('normalizes fields connectors only in the signed index, retaining the packaged manifest and env', () => fixture(root => {
    plugin(root, 'free-plugin');
    const manifestPath = join(root, 'plugins', 'free-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const connectors = [{ id: 'credentials', fields: [
      { name: 'serviceKey', secret: true },
      { name: 'API_KEY', label: 'Custom key', secret: true, env: 'SERVICE_API_KEY' },
    ] }];
    manifest.extensions['ai.elanous'].connectors = connectors;
    const original = JSON.stringify(manifest);
    writeFileSync(manifestPath, original);
    const pair = generateIndexKeyPair();
    const outDir = join(root, 'out');
    const result = publishMarket({ pluginsDir: join(root, 'plugins'), outDir,
      market: { name: 'elanous', displayName: 'Elanous' }, key: pair });
    expect(result.published.map(item => item.name)).toEqual(['free-plugin']);
    const bytes = readFileSync(join(outDir, 'marketplace.json'));
    const entry = JSON.parse(bytes.toString()).plugins[0];
    expect(entry['ai.elanous'].connectors).toEqual([{ id: 'credentials', kind: 'credentials', userConfig: [
      { key: 'serviceKey', label: 'serviceKey', secret: true },
      { key: 'API_KEY', label: 'Custom key', secret: true, env: 'SERVICE_API_KEY' },
    ] }]);
    expect(verifyIndex({ marketplaceBytes: bytes, signatureText: readFileSync(join(outDir, 'index.sig'), 'utf8'),
      trustedKeys: [{ keyId: pair.keyId, publicKey: pair.publicKey }] }).ok).toBe(true);
    expect(readFileSync(manifestPath, 'utf8')).toBe(original);
    expect(readFileSync(join(outDir, 'plugins', 'free-plugin', 'plugin.json'), 'utf8')).toBe(original);
    const tar = gunzipSync(readFileSync(join(outDir, entry.artifact.key)));
    const size = parseInt(tar.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8);
    const firstName = tar.subarray(0, 100).toString().replace(/\0.*$/, '');
    const manifestOffset = firstName === 'plugin.json' ? 0 : 512 + Math.ceil(size / 512) * 512;
    expect(tar.subarray(manifestOffset, manifestOffset + 100).toString().replace(/\0.*$/, '')).toBe('plugin.json');
    const manifestSize = parseInt(tar.subarray(manifestOffset + 124, manifestOffset + 136).toString().replace(/\0.*$/, '').trim(), 8);
    expect(tar.subarray(manifestOffset + 512, manifestOffset + 512 + manifestSize).toString()).toBe(original);
  }));

  test('skips malformed connectors without publishing their archive', () => fixture(root => {
    plugin(root, 'invalid-plugin');
    const manifestPath = join(root, 'plugins', 'invalid-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.extensions['ai.elanous'].connectors = [{ fields: [{ name: 'key', secret: true }] }];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const outDir = join(root, 'out');
    const result = publishMarket({ pluginsDir: join(root, 'plugins'), outDir,
      market: { name: 'elanous', displayName: 'Elanous' }, key: generateIndexKeyPair() });
    expect(result.skipped).toContainEqual({ dir: 'invalid-plugin', reason: 'invalid-connectors' });
    expect(result.published).toEqual([]);
    expect(JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8')).plugins).toEqual([]);
    expect(existsSync(join(outDir, 'plugins', 'invalid-plugin'))).toBe(false);
  }));

  test('skips empty and whitespace-only credential keys in either connector shape', () => fixture(root => {
    plugin(root, 'free-plugin');
    for (const [name, connectors] of [
      ['empty-fields', [{ id: 'credentials', fields: [{ name: '', secret: true }] }]],
      ['blank-fields', [{ id: 'credentials', fields: [{ name: '   ', secret: true }] }]],
      ['empty-user-config', [{ id: 'credentials', kind: 'api-key', userConfig: [{ key: '', label: 'Key', secret: true }] }]],
      ['blank-user-config', [{ id: 'credentials', kind: 'api-key', userConfig: [{ key: ' \t ', label: 'Key', secret: true }] }]],
    ] as const) {
      plugin(root, name);
      const path = join(root, 'plugins', name, 'plugin.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.extensions['ai.elanous'].connectors = connectors;
      writeFileSync(path, JSON.stringify(manifest));
    }
    const outDir = join(root, 'out');
    const result = publishMarket({ pluginsDir: join(root, 'plugins'), outDir,
      market: { name: 'elanous', displayName: 'Elanous' }, key: generateIndexKeyPair() });
    expect(result.published.map(item => item.name)).toEqual(['free-plugin']);
    expect(result.skipped).toEqual(['blank-fields', 'blank-user-config', 'empty-fields', 'empty-user-config']
      .map(dir => ({ dir, reason: 'invalid-connectors' })));
    expect(JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8')).plugins.map((item: { name: string }) => item.name))
      .toEqual(['free-plugin']);
    for (const { dir } of result.skipped) expect(existsSync(join(outDir, 'plugins', dir))).toBe(false);
  }));

  test('refuses a changed name@version after an intervening index excluded the plugin', () => fixture(root => {
    plugin(root, 'free-plugin');
    const pair = generateIndexKeyPair();
    const outDir = join(root, 'out');
    const input = { pluginsDir: join(root, 'plugins'), outDir,
      market: { name: 'elanous', displayName: 'Elanous' }, key: pair };
    const first = publishMarket(input);
    expect(first.published).toHaveLength(1);
    rmSync(join(root, 'plugins', 'free-plugin'), { recursive: true });
    expect(publishMarket(input)).toMatchObject({ ok: true, sequence: 2, published: [] });
    expect(JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8')).plugins).toEqual([]);
    expect(JSON.parse(readFileSync(join(outDir, '.publication-history.json'), 'utf8')))
      .toEqual(first.published.map(({ name, version, sha256 }) => ({ name, version, sha256 })));
    plugin(root, 'free-plugin');
    writeFileSync(join(root, 'plugins', 'free-plugin', 'payload'), 'changed');
    expect(() => publishMarket(input)).toThrow('version-immutable');
    expect(JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8')).sequence).toBe(2);
    writeFileSync(join(root, 'plugins', 'free-plugin', 'payload'), 'v1');
    expect(publishMarket(input)).toMatchObject({ ok: true, sequence: 3,
      published: [{ name: 'free-plugin', version: '1.0.0', sha256: first.published[0]?.sha256, bundled: [] }] });
  }));

  test('missing publication history refuses a previously advanced index rather than silently forgetting versions', () => fixture(root => {
    plugin(root, 'free-plugin');
    const outDir = join(root, 'out');
    const input = { pluginsDir: join(root, 'plugins'), outDir,
      market: { name: 'elanous', displayName: 'Elanous' }, key: generateIndexKeyPair() };
    publishMarket(input);
    publishMarket(input);
    rmSync(join(outDir, '.publication-history.json'));
    expect(() => publishMarket(input)).toThrow('missing publication history');
    expect(JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8')).sequence).toBe(2);
  }));

  test('local source resolves inside the output root, including nested output and relative arguments', () => fixture(root => {
    plugin(root, 'free-plugin');
    const pair = generateIndexKeyPair();
    const pluginsDir = join(root, 'plugins');
    const outDir = join(root, 'exports', 'market');
    const input = { pluginsDir, outDir, market: { name: 'm', displayName: 'M' }, key: pair };
    publishMarket(input);
    const index = JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8'));
    expect(index.plugins[0].source).toEqual({ source: 'local', path: './plugins/free-plugin' });
    expect(resolve(outDir, index.plugins[0].source.path)).toBe(join(outDir, 'plugins', 'free-plugin'));
    expect(treeNames(join(outDir, 'plugins', 'free-plugin'))).toEqual(archiveNames(readFileSync(join(outDir, index.plugins[0].artifact.key))));

    const relativeOut = join(root, 'relative-out');
    publishMarket({ ...input, pluginsDir: relative(process.cwd(), pluginsDir), outDir: relative(process.cwd(), relativeOut) });
    const relativeIndex = JSON.parse(readFileSync(join(relativeOut, 'marketplace.json'), 'utf8'));
    expect(relativeIndex.plugins[0].source).toEqual({ source: 'local', path: './plugins/free-plugin' });
    expect(resolve(relativeOut, relativeIndex.plugins[0].source.path)).toBe(join(relativeOut, 'plugins', 'free-plugin'));
  }));

  test('git-subdir source and skipped paid archive absent', () => fixture(root => {
    plugin(root, 'free-plugin', { model: 'free' });
    plugin(root, 'paid-plugin', { model: 'subscription' });
    const pair = generateIndexKeyPair();
    const outDir = join(root, 'out');
    publishMarket({ pluginsDir: join(root, 'plugins'), outDir, market: { name: 'm', displayName: 'M' }, key: pair,
      source: { repoUrl: 'https://example.org/plugins.git', sha: 'a'.repeat(40), basePath: 'plugins' } });
    const index = JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8'));
    expect(index.plugins[0].source).toEqual({ source: 'git-subdir', url: 'https://example.org/plugins.git',
      path: 'plugins/free-plugin', sha: 'a'.repeat(40) });
    expect(existsSync(join(outDir, 'paid-plugin'))).toBe(false);
    expect(existsSync(join(outDir, 'plugins'))).toBe(false);
  }));

  test('keepExisting adds one new plugin and carries the other published entries over byte-identical', () => fixture(root => {
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(root, 'skills', name), { recursive: true });
      writeFileSync(join(root, 'skills', name, 'SKILL.md'), name);
    }
    plugin(root, 'bundled-one');
    plugin(root, 'bundled-two');
    plugin(root, 'plain-old');
    setBundle(root, 'bundled-one', ['skills/alpha']);
    setBundle(root, 'bundled-two', ['skills/beta']);
    const pair = generateIndexKeyPair();
    const outDir = join(root, 'out');
    const trustedKeys = [{ keyId: pair.keyId, publicKey: pair.publicKey }];
    const base = { bundleRoot: root, outDir, market: { name: 'elanous', displayName: 'Elanous' }, key: pair };
    const first = publishMarket({ ...base, pluginsDir: join(root, 'plugins') });
    expect(first.published.map(item => item.name)).toEqual(['bundled-one', 'bundled-two', 'plain-old']);
    expect(first.kept).toEqual([]);
    const before = JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8'));
    const archivesBefore = before.plugins.map((item: { artifact: { key: string } }) => readFileSync(join(outDir, item.artifact.key)));
    const unpackedBefore = before.plugins.map((item: { name: string }) => treeNames(join(outDir, 'plugins', item.name)));
    // The bundled sources drift, so republishing them would conflict; --keep-existing must not touch them.
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), 'alpha changed');
    const fresh = join(root, 'fresh');
    mkdirSync(join(fresh, 'new-pack'), { recursive: true });
    writeFileSync(join(fresh, 'new-pack', 'plugin.json'), JSON.stringify({ name: 'new-pack', version: '1.0.0',
      description: 'new', extensions: { 'ai.elanous': { capabilities: [], connectors: [] } } }));
    writeFileSync(join(fresh, 'new-pack', 'payload'), 'new');
    const second = publishMarket({ ...base, pluginsDir: fresh, keepExisting: true });
    expect(second).toMatchObject({ ok: true, sequence: 2, skipped: [] });
    expect(second.published.map(item => item.name)).toEqual(['new-pack']);
    expect(second.kept).toEqual(before.plugins.map((item: { name: string; version: string; artifact: { sha256: string } }) =>
      ({ name: item.name, version: item.version, sha256: item.artifact.sha256 })));
    const bytes = readFileSync(join(outDir, 'marketplace.json'));
    const after = JSON.parse(bytes.toString());
    expect(after.sequence).toBe(before.sequence + 1);
    expect(after.plugins.map((item: { name: string }) => item.name)).toEqual(['bundled-one', 'bundled-two', 'new-pack', 'plain-old']);
    for (const [i, old] of before.plugins.entries()) {
      const carried = after.plugins.find((item: { name: string }) => item.name === old.name);
      expect(JSON.stringify(carried)).toBe(JSON.stringify(old));
      expect(readFileSync(join(outDir, old.artifact.key)).equals(archivesBefore[i])).toBe(true);
      expect(treeNames(join(outDir, 'plugins', old.name))).toEqual(unpackedBefore[i]);
    }
    expect(verifyIndex({ marketplaceBytes: bytes, signatureText: readFileSync(join(outDir, 'index.sig'), 'utf8'), trustedKeys }))
      .toMatchObject({ ok: true, sequence: 2 });
    expect(readFileSync(join(outDir, '.agents', 'plugins', 'marketplace.json')).equals(bytes)).toBe(true);
    // Without the flag the index still describes only the folders under --dir.
    const third = publishMarket({ ...base, pluginsDir: fresh });
    expect(third.kept).toEqual([]);
    expect(JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8')).plugins.map((item: { name: string }) => item.name))
      .toEqual(['new-pack']);
  }));
  test('bundled skills are canonicalized, signed and unpacked identically for local Codex', () => fixture(root => {
    plugin(root, 'free-plugin');
    for (const [name, filename] of [['alpha', 'SKILL.md'], ['beta', 'skill.md']]) {
      const dir = join(root, 'skills', name!);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, filename!), name!);
      writeFileSync(join(dir, '.env.local'), 'secret');
    }
    setBundle(root, 'free-plugin', ['skills/alpha', 'skills/beta']);
    const pair = generateIndexKeyPair();
    const outDir = join(root, 'out');
    const input = { pluginsDir: join(root, 'plugins'), bundleRoot: root, outDir,
      market: { name: 'elanous', displayName: 'Elanous' }, key: pair };
    const result = publishMarket(input);
    expect(result.published[0]?.bundled).toEqual(['alpha', 'beta']);
    const bytes = readFileSync(join(outDir, 'marketplace.json'));
    expect(readFileSync(join(outDir, '.agents', 'plugins', 'marketplace.json'))).toEqual(bytes);
    const index = JSON.parse(bytes.toString());
    expect(index.plugins[0].source.path).toBe('./plugins/free-plugin');
    const names = archiveNames(readFileSync(join(outDir, index.plugins[0].artifact.key)));
    expect(names).toContain('skills/alpha/SKILL.md');
    expect(names).toContain('skills/beta/SKILL.md');
    expect(names).not.toContain('skills/beta/skill.md');
    // The source keeps its lowercase name (read real entries: macOS disks are case-insensitive).
    const beta = readdirSync(join(root, 'skills', 'beta'));
    expect(beta).toContain('skill.md');
    expect(beta).not.toContain('SKILL.md');
    expect(names.some(name => name.includes('.env'))).toBe(false);
    expect(treeNames(join(outDir, 'plugins', 'free-plugin'))).toEqual(names);
    expect(verifyIndex({ marketplaceBytes: bytes, signatureText: readFileSync(join(outDir, 'index.sig'), 'utf8'),
      trustedKeys: [{ keyId: pair.keyId, publicKey: pair.publicKey }] }).ok).toBe(true);
    const manifestPath = join(root, 'plugins', 'free-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = '2.0.0';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    rmSync(join(root, 'plugins', 'free-plugin', 'payload'));
    publishMarket(input);
    expect(treeNames(join(outDir, 'plugins', 'free-plugin'))).not.toContain('payload');
    expect(treeNames(join(outDir, 'plugins', 'free-plugin'))).toEqual(archiveNames(readFileSync(join(outDir,
      JSON.parse(readFileSync(join(outDir, 'marketplace.json'), 'utf8')).plugins[0].artifact.key))));
  }));

  test('rejects escaping and missing bundle paths without publishing them', () => fixture(root => {
    plugin(root, 'free-plugin');
    const outside = mkdtempSync(join(tmpdir(), 'market-outside-'));
    try {
      writeFileSync(join(outside, 'SKILL.md'), 'outside');
      symlinkSync(outside, join(root, 'escape'));
      const input = { pluginsDir: join(root, 'plugins'), bundleRoot: root, outDir: join(root, 'out'),
        market: { name: 'elanous', displayName: 'Elanous' }, key: generateIndexKeyPair() };
      for (const [bundle, reason] of [
        ['../outside', 'bundle-path-outside-root'], ['escape', 'bundle-path-outside-root'],
        ['missing', 'bundle-missing'],
      ]) {
        setBundle(root, 'free-plugin', [bundle!]);
        expect(publishMarket(input).skipped).toEqual([{ dir: 'free-plugin', reason }]);
      }
      const internal = join(root, 'skills', 'internal');
      mkdirSync(internal, { recursive: true });
      writeFileSync(join(internal, 'SKILL.md'), 'internal');
      symlinkSync(outside, join(internal, 'nested-escape'));
      setBundle(root, 'free-plugin', ['skills/internal']);
      expect(publishMarket(input).skipped).toEqual([{ dir: 'free-plugin', reason: 'bundle-path-outside-root' }]);
      const plain = join(root, 'plain');
      mkdirSync(plain);
      setBundle(root, 'free-plugin', ['plain']);
      expect(publishMarket(input).skipped).toEqual([{ dir: 'free-plugin', reason: 'bundle-not-a-skill' }]);
      setBundle(root, 'free-plugin', ['escape']);
      expect(publishMarket({ ...input, bundleRoot: undefined }).skipped)
        .toEqual([{ dir: 'free-plugin', reason: 'bundle-root-missing' }]);
      expect(JSON.parse(readFileSync(join(input.outDir, 'marketplace.json'), 'utf8')).plugins).toEqual([]);
      expect(existsSync(join(input.outDir, 'plugins', 'free-plugin'))).toBe(false);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  }));

  test('repository official packs publish basics after removing its internal references and refuse remaining unsafe packs', () => fixture(root => {
    const repo = join(import.meta.dir, '../..');
    const pair = generateIndexKeyPair();
    const result = publishMarket({ pluginsDir: join(repo, 'packs'), bundleRoot: repo, outDir: join(root, 'out'),
      market: { name: 'elanous', displayName: 'Elanous' }, key: pair });
    const byName = new Map(result.published.map(item => [item.name, item]));
    expect(result.ok).toBe(false);
    expect([...byName.keys()].sort()).toEqual(['elanous-basics', 'elanous-essentials', 'elanous-hwp', 'image-first-shorts', 'video-broll', 'video-explainer']);
    expect(byName.get('elanous-basics')?.bundled).toContain('google-workspace');
    expect(byName.get('elanous-hwp')?.bundled).toEqual([]);
    expect(JSON.parse(readFileSync(join(repo, 'packs', 'elanous-basics', '.codex-plugin', 'plugin.json'), 'utf8')).version).toBe('0.1.2');
    expect(byName.get('video-broll')?.bundled).toEqual(['motion-broll', 'graphs/broll-line.yaml']);
    expect(byName.get('video-explainer')?.bundled).toEqual(['explainer-video', 'graphs/explainer-line.yaml']);
    expect(result.skipped).toContainEqual({ dir: 'elanous-markets', reason: 'paid-not-allowed-in-M0' });
    expect(result.skipped).toContainEqual({ dir: 'elanous-media', reason: 'internal-reference', hits: [
      { file: 'skills/video-builder/SKILL.md', line: 30, marker: 'internal-doc-path' },
      { file: 'skills/video-builder/SKILL.md', line: 220, marker: 'internal-doc-path' },
    ] });
    expect(existsSync(join(root, 'out', 'elanous-basics'))).toBe(true);
    expect(existsSync(join(root, 'out', 'elanous-media'))).toBe(false);
    const index = JSON.parse(readFileSync(join(root, 'out', 'marketplace.json'), 'utf8'));
    expect(index.plugins.map((item: { name: string }) => item.name)).toEqual(result.published.map(item => item.name));
    const entry = (name: string) => index.plugins.find((item: { name: string }) => item.name === name);
    const broll = archiveNames(readFileSync(join(root, 'out', entry('video-broll').artifact.key)));
    expect(broll).toContain('graphs/broll-line.yaml');
    expect(broll).toContain('skills/motion-broll/SKILL.md');
    expect(readFileSync(join(root, 'out', 'plugins', 'video-broll', 'graphs', 'broll-line.yaml')))
      .toEqual(readFileSync(join(repo, 'graphs', 'video', 'broll-line.yaml')));
    const hwp = archiveNames(readFileSync(join(root, 'out', entry('elanous-hwp').artifact.key)));
    expect(hwp).toContain('skills/hwp-read/SKILL.md');
    expect(hwp).toContain('scripts/hwp.py');
    expect(hwp).toContain('nodes/to-md.yaml');
    expect(verifyIndex({ marketplaceBytes: readFileSync(join(root, 'out', 'marketplace.json')),
      signatureText: readFileSync(join(root, 'out', 'index.sig'), 'utf8'),
      trustedKeys: [{ keyId: pair.keyId, publicKey: pair.publicKey }] }).ok).toBe(true);
    expect(treeNames(join(root, 'out', 'plugins', 'elanous-hwp'))).toEqual(hwp);
    expect(byName.get('image-first-shorts')?.bundled).toEqual([]);
    const shorts = archiveNames(readFileSync(join(root, 'out', entry('image-first-shorts').artifact.key)));
    for (const name of ['LICENSE', 'SOURCE.md', 'graphs/image-first-shorts.yaml', 'graphs/recipes.yaml', 'graphs/run-step.ts', 'skills/image-first-shorts/SKILL.md']) {
      expect(shorts).toContain(name);
    }
    expect(existsSync(join(repo, 'packs', 'elanous-basics', 'skills'))).toBe(false);
    expect(existsSync(join(repo, 'packs', 'video-broll', 'graphs'))).toBe(false);
  }));

  test('invalid key failures do not disclose private key in error or debug output', () => fixture(root => {
    plugin(root, 'free-plugin');
    const privateKeyPem = 'PRIVATE-KEY-CANARY-DO-NOT-PRINT';
    const input = { pluginsDir: join(root, 'plugins'), outDir: join(root, 'out'),
      market: { name: 'elanous', displayName: 'Elanous' }, key: { keyId: '12345678', privateKeyPem } };
    expect(() => publishMarket(input)).toThrow('invalid signing key');
    try { publishMarket(input); } catch (error) {
      expect(String(error)).not.toContain(privateKeyPem);
    }
    expect(existsSync(join(root, 'out', 'marketplace.json'))).toBe(false);
  }));

  test('CLI publish and keygen produce signed files without printing private key', () => fixture(root => {
    plugin(root, 'free-plugin');
    const keys = join(root, 'keys');
    const cli = (...args: string[]) => spawnSync('bun', ['bin/elanous.mjs', '--test', 'market', ...args],
      { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 60000 });
    const generated = cli('keygen', '--out', keys);
    if (generated.status !== 0) throw new Error(`keygen failed: ${generated.stderr}`);
    const pem = readFileSync(join(keys, 'index-key.pem'), 'utf8');
    const pair = JSON.parse(readFileSync(join(keys, 'index-key.pub.json'), 'utf8'));
    expect((statSync(join(keys, 'index-key.pem')).mode & 0o777)).toBe(0o600);
    expect(generated.stdout + generated.stderr).not.toContain(pem.trim());
    const out = join(root, 'out');
    const result = cli('publish', '--dir', join(root, 'plugins'), '--out', out, '--key', join(keys, 'index-key.pem'),
      '--key-id', pair.keyId, '--json');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, sequence: 1, published: [{ name: 'free-plugin' }] });
    const localSource = JSON.parse(readFileSync(join(out, 'marketplace.json'), 'utf8')).plugins[0].source;
    expect(localSource).toEqual({ source: 'local', path: './plugins/free-plugin' });
    expect(resolve(out, localSource.path)).toBe(join(out, 'plugins', 'free-plugin'));
    expect(result.stdout + result.stderr).not.toContain(pem.trim());
    expect(verifyIndex({ marketplaceBytes: readFileSync(join(out, 'marketplace.json')),
      signatureText: readFileSync(join(out, 'index.sig'), 'utf8'), trustedKeys: [pair] }).ok).toBe(true);
    const gitOut = join(root, 'git-out');
    const gitResult = cli('publish', '--dir', join(root, 'plugins'), '--out', gitOut, '--key', join(keys, 'index-key.pem'),
      '--key-id', pair.keyId, '--source-repo', 'https://example.org/plugins.git', '--source-sha', 'a'.repeat(40),
      '--source-base', 'plugins', '--json');
    expect(gitResult.status).toBe(0);
    expect(JSON.parse(readFileSync(join(gitOut, 'marketplace.json'), 'utf8')).plugins[0].source)
      .toEqual({ source: 'git-subdir', url: 'https://example.org/plugins.git', sha: 'a'.repeat(40), path: 'plugins/free-plugin' });
    expect(gitResult.stdout + gitResult.stderr).not.toContain(pem.trim());
    const incomplete = cli('publish', '--dir', join(root, 'plugins'), '--out', join(root, 'incomplete'),
      '--key', join(keys, 'index-key.pem'), '--key-id', pair.keyId, '--source-repo', 'https://example.org/plugins.git');
    expect(incomplete.status).not.toBe(0);
    expect(existsSync(join(root, 'incomplete'))).toBe(false);
  }, true));

  test('a { from, as } bundle places a repository file at `as` and listed graphs must ship', () => fixture(root => {
    plugin(root, 'graph-plugin');
    mkdirSync(join(root, 'graphs', 'video'), { recursive: true });
    writeFileSync(join(root, 'graphs', 'video', 'line.yaml'), 'graph_id: line\n');
    setBundle(root, 'graph-plugin', [{ from: 'graphs/video/line.yaml', as: 'graphs/line.yaml' }], ['graphs/line.yaml']);
    const pair = generateIndexKeyPair();
    const input = { pluginsDir: join(root, 'plugins'), bundleRoot: root, outDir: join(root, 'out'),
      market: { name: 'elanous', displayName: 'Elanous' }, key: pair };
    const result = publishMarket(input);
    expect(result.published[0]?.bundled).toEqual(['graphs/line.yaml']);
    const index = JSON.parse(readFileSync(join(root, 'out', 'marketplace.json'), 'utf8'));
    expect(archiveNames(readFileSync(join(root, 'out', index.plugins[0].artifact.key)))).toEqual(['graphs/line.yaml', 'payload', 'plugin.json']);
    expect(readFileSync(join(root, 'out', 'plugins', 'graph-plugin', 'graphs', 'line.yaml'), 'utf8')).toBe('graph_id: line\n');

    plugin(root, 'missing-graph');
    setBundle(root, 'missing-graph', [], ['graphs/absent.yaml']);
    plugin(root, 'escaping-file');
    setBundle(root, 'escaping-file', [{ from: '../outside.yaml', as: 'graphs/x.yaml' }]);
    plugin(root, 'conflict');
    setBundle(root, 'conflict', [{ from: 'graphs/video/line.yaml', as: 'payload' }]);
    const second = publishMarket({ ...input, outDir: join(root, 'out2') });
    expect(second.skipped).toContainEqual({ dir: 'missing-graph', reason: 'graph-missing' });
    expect(second.skipped).toContainEqual({ dir: 'escaping-file', reason: 'bundle-path-outside-root' });
    expect(second.skipped).toContainEqual({ dir: 'conflict', reason: 'bundle-conflict' });
  }));

  test('third-party graphs that use recipes they do not ship are published with a warning; official packs are not flagged', () => fixture(root => {
    for (const [name, trust] of [['third-party', undefined], ['first-party', 'official']] as const) {
      plugin(root, name);
      const dir = join(root, 'plugins', name, 'graphs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'line.yaml'), 'nodes:\n  - { node_id: a, recipe: own-step }\n  - { node_id: b, recipe: broll-render }\n  - { node_id: c, kind: agent }\n');
      writeFileSync(join(dir, 'recipes.yaml'), 'own-step:\n  command: "true"\n');
      const path = join(root, 'plugins', name, 'plugin.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.extensions['ai.elanous'].graphs = ['graphs/line.yaml'];
      if (trust) manifest.extensions['ai.elanous'].trust = trust;
      writeFileSync(path, JSON.stringify(manifest));
    }
    const result = publishMarket({ pluginsDir: join(root, 'plugins'), outDir: join(root, 'out'),
      market: { name: 'elanous', displayName: 'Elanous' }, key: generateIndexKeyPair() });
    expect(result.published.map(item => item.name).sort()).toEqual(['first-party', 'third-party']);
    expect(result.warnings).toEqual([{ dir: 'third-party', graph: 'graphs/line.yaml', reason: 'third-party-core-recipe', recipes: ['broll-render'] }]);
  }));
});
