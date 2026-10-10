import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIndexKeyPair, signIndex } from '../../market/signed-index.js';
import { OFFICIAL_INDEX_KEYS } from '../../market/official-keys.js';
import { addMarket, ELANOUS_MARKET_URL, ensureInternalMarketIndex, ensureMarketIndex, listMarkets, updateMarket } from './market-fetch.js';

const dirs: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'elanous-market-fetch-'));
  dirs.push(root);
  return { root, configPath: join(root, 'config.json') };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function signed(name: string, sequence: number) {
  const keys = generateIndexKeyPair();
  const bytes = Buffer.from(JSON.stringify({ name, interface: { displayName: name }, sequence, plugins: [] }));
  return { keys, bytes, signature: signIndex(bytes, keys.privateKeyPem, keys.keyId) };
}
function server(bytes: Uint8Array, signature: string) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(String(input).endsWith('/index.sig') ? signature : Buffer.from(bytes), { status: 200 });
  }) as typeof fetch;
  return { fetcher, requests };
}

describe('signed market fetch', () => {
  test('built-in Pages URL, user markets and trust coexist without losing unrelated configuration', () => {
    const opts = setup();
    writeFileSync(opts.configPath, JSON.stringify({ theme: 'dark', market: { trustedKeys: [{ keyId: 'abcdef01', publicKey: 'abc' }] } }));
    expect(listMarkets(opts)).toEqual([{ name: 'elanous', url: ELANOUS_MARKET_URL }]);
    expect(addMarket('community', 'https://example.org/plugins/', opts)).toEqual({ name: 'community', url: 'https://example.org/plugins/' });
    expect(listMarkets(opts)).toEqual([{ name: 'elanous', url: ELANOUS_MARKET_URL }, { name: 'community', url: 'https://example.org/plugins/' }]);
    expect(JSON.parse(readFileSync(opts.configPath, 'utf8'))).toMatchObject({ theme: 'dark', market: { trustedKeys: [{ keyId: 'abcdef01', publicKey: 'abc' }] } });
    expect(() => addMarket('community', 'https://example.org/', opts)).toThrow('already exists');
    expect(() => addMarket('elanous', 'https://example.org/', opts)).toThrow('invalid market name');
    expect(() => addMarket('unsafe', 'http://example.org/', opts)).toThrow('invalid market URL');
    expect(() => addMarket('unsafe', 'https://user:pass@example.org/', opts)).toThrow('invalid market URL');
  });

  test('normalizes a path-only URL into a directory for registration and loaded config', async () => {
    const opts = setup();
    expect(addMarket('community', 'https://example.org/plugins', opts).url).toBe('https://example.org/plugins/');
    const { keys, bytes, signature } = signed('community', 1);
    writeFileSync(opts.configPath, JSON.stringify({ market: { markets: [{ name: 'community', url: 'https://example.org/plugins' }], trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] } }));
    expect(listMarkets(opts)[1]?.url).toBe('https://example.org/plugins/');
    const { fetcher, requests } = server(bytes, signature);
    await ensureMarketIndex('community', { ...opts, fetcher });
    expect(requests).toEqual(['https://example.org/plugins/marketplace.json', 'https://example.org/plugins/index.sig']);
  });

  test('fetches both files, verifies with configured trust, then serves the verified cached index', async () => {
    const opts = setup();
    const { keys, bytes, signature } = signed('community', 4);
    writeFileSync(opts.configPath, JSON.stringify({ market: { markets: [{ name: 'community', url: 'https://example.org/plugins/' }], trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] } }));
    const { fetcher, requests } = server(bytes, signature);
    const result = await ensureMarketIndex('community', { ...opts, fetcher });
    expect(result).toMatchObject({ market: { name: 'community' }, directory: join(opts.root, 'markets', 'community'), signature: 'ok', keyId: keys.keyId, index: { sequence: 4 } });
    expect(requests).toEqual(['https://example.org/plugins/marketplace.json', 'https://example.org/plugins/index.sig']);
    expect(readFileSync(join(result.directory, 'marketplace.json'))).toEqual(bytes);
    expect(readFileSync(join(result.directory, 'index.sig'), 'utf8')).toBe(signature);
    expect((await ensureMarketIndex('community', { ...opts, fetcher: (async (_input: string | URL | Request) => { throw new Error('cache missed'); }) as unknown as typeof fetch })).index.sequence).toBe(4);
  });

  test('passes official trust as well as configured keys to the verifier for the built-in market', async () => {
    const opts = setup();
    const { keys, bytes, signature } = signed('elanous', 1);
    const { fetcher, requests } = server(bytes, signature);
    let sawOfficial = false;
    const { verifyIndex } = await import('../../market/signed-index.js');
    const result = await ensureMarketIndex('elanous', { ...opts, fetcher, trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }], verifySignature: input => {
      sawOfficial = OFFICIAL_INDEX_KEYS.every(key => input.trustedKeys.some(trusted => trusted.keyId === key.keyId && trusted.publicKey === key.publicKey));
      return verifyIndex(input);
    } });
    expect(sawOfficial).toBe(true);
    expect(result.signature).toBe('ok');
    expect(requests).toEqual([new URL('marketplace.json', ELANOUS_MARKET_URL).href, new URL('index.sig', ELANOUS_MARKET_URL).href]);
  });

  test('rejects untrusted and tampered indices without writing a cache, even when refreshing', async () => {
    const opts = setup();
    const first = signed('community', 5);
    writeFileSync(opts.configPath, JSON.stringify({ market: { markets: [{ name: 'community', url: 'https://example.org/' }], trustedKeys: [{ keyId: first.keys.keyId, publicKey: first.keys.publicKey }] } }));
    const unknown = signed('community', 5);
    await expect(ensureMarketIndex('community', { ...opts, fetcher: server(unknown.bytes, unknown.signature).fetcher })).rejects.toMatchObject({ reason: 'signature', message: expect.stringContaining('unknown-key') });
    await expect(ensureMarketIndex('community', { ...opts, fetcher: server(Buffer.from(first.bytes.toString() + ' '), first.signature).fetcher })).rejects.toMatchObject({ reason: 'signature', message: expect.stringContaining('bad-signature') });
    expect(existsSync(join(opts.root, 'markets', 'community', 'marketplace.json'))).toBe(false);
    const valid = await ensureMarketIndex('community', { ...opts, fetcher: server(first.bytes, first.signature).fetcher });
    expect(valid.index.sequence).toBe(5);
    const rollback = signed('community', 4);
    const other = server(rollback.bytes, rollback.signature);
    await expect(updateMarket('community', { ...opts, fetcher: other.fetcher, trustedKeys: [{ keyId: rollback.keys.keyId, publicKey: rollback.keys.publicKey }] })).rejects.toMatchObject({ reason: 'signature', message: expect.stringContaining('sequence-rollback') });
    expect(readFileSync(join(valid.directory, 'marketplace.json'))).toEqual(first.bytes);
  });

  test('serializes overlapping refreshes through cache read, verification and publication', async () => {
    const opts = setup();
    const lower = signed('community', 4);
    const higher = signed('community', 5);
    writeFileSync(opts.configPath, JSON.stringify({ market: { markets: [{ name: 'community', url: 'https://example.org/' }], trustedKeys: [lower.keys, higher.keys].map(({ keyId, publicKey }) => ({ keyId, publicKey })) } }));
    let releaseLower!: () => void;
    const held = new Promise<void>(resolve => { releaseLower = resolve; });
    let startedLower!: () => void;
    const started = new Promise<void>(resolve => { startedLower = resolve; });
    const lowerServer = server(lower.bytes, lower.signature);
    const higherServer = server(higher.bytes, higher.signature);
    const slowFetcher = (async (input: string | URL | Request) => {
      startedLower();
      await held;
      return lowerServer.fetcher(input);
    }) as typeof fetch;
    const first = updateMarket('community', { ...opts, fetcher: slowFetcher });
    await started;
    const second = updateMarket('community', { ...opts, fetcher: higherServer.fetcher });
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(higherServer.requests).toEqual([]);
    } finally {
      releaseLower();
    }
    expect((await first).index.sequence).toBe(4);
    expect((await second).index.sequence).toBe(5);
    const directory = join(opts.root, 'markets', 'community');
    expect(JSON.parse(readFileSync(join(directory, 'cache-state.json'), 'utf8')).lastSequence).toBe(5);
    expect(readFileSync(join(directory, 'marketplace.json'))).toEqual(higher.bytes);
    expect((await ensureMarketIndex('community', { ...opts, fetcher: (async () => { throw new Error('cache missed'); }) as unknown as typeof fetch })).index.sequence).toBe(5);
  });

  test('releases a market queue after a failed fetch', async () => {
    const opts = setup();
    const valid = signed('community', 1);
    writeFileSync(opts.configPath, JSON.stringify({ market: { markets: [{ name: 'community', url: 'https://example.org/' }], trustedKeys: [{ keyId: valid.keys.keyId, publicKey: valid.keys.publicKey }] } }));
    const failed = updateMarket('community', { ...opts, fetcher: (async () => new Response('', { status: 503 })) as unknown as typeof fetch });
    const recovered = updateMarket('community', { ...opts, fetcher: server(valid.bytes, valid.signature).fetcher });
    await expect(failed).rejects.toThrow('HTTP 503');
    expect((await recovered).index.sequence).toBe(1);
  });

  test('stops reading and cancels an oversized streaming index before consuming another chunk', async () => {
    const opts = setup();
    addMarket('community', 'https://example.org/', opts);
    let pulls = 0;
    let cancelled = false;
    const fetcher = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        else controller.enqueue(new Uint8Array([1]));
      },
      cancel() { cancelled = true; },
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(ensureMarketIndex('community', { ...opts, fetcher })).rejects.toThrow('market file too large: marketplace.json');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(3);
    expect(existsSync(join(opts.root, 'markets', 'community', 'marketplace.json'))).toBe(false);
  });

  test('recovers a cache pair interrupted between publishing the index and signature', async () => {
    const opts = setup();
    const first = signed('community', 2);
    const next = signed('community', 3);
    writeFileSync(opts.configPath, JSON.stringify({ market: { markets: [{ name: 'community', url: 'https://example.org/' }], trustedKeys: [first.keys, next.keys].map(({ keyId, publicKey }) => ({ keyId, publicKey })) } }));
    await ensureMarketIndex('community', { ...opts, fetcher: server(first.bytes, first.signature).fetcher });
    const directory = join(opts.root, 'markets', 'community');
    writeFileSync(join(directory, 'marketplace.json'), next.bytes);
    const { fetcher, requests } = server(next.bytes, next.signature);
    const recovered = await ensureMarketIndex('community', { ...opts, fetcher });
    expect(recovered.index.sequence).toBe(3);
    expect(requests).toHaveLength(2);
    expect(readFileSync(join(directory, 'index.sig'), 'utf8')).toBe(next.signature);
    expect((await ensureMarketIndex('community', { ...opts, fetcher: (async () => { throw new Error('cache missed'); }) as unknown as typeof fetch })).index.sequence).toBe(3);
    rmSync(join(directory, 'index.sig'));
    expect((await ensureMarketIndex('community', { ...opts, fetcher })).index.sequence).toBe(3);
  });

  test('preserves the last verified sequence while repairing a mismatched cache pair', async () => {
    const opts = setup();
    const first = signed('community', 5);
    const lower = signed('community', 4);
    writeFileSync(opts.configPath, JSON.stringify({ market: { markets: [{ name: 'community', url: 'https://example.org/' }], trustedKeys: [first.keys, lower.keys].map(({ keyId, publicKey }) => ({ keyId, publicKey })) } }));
    await ensureMarketIndex('community', { ...opts, fetcher: server(first.bytes, first.signature).fetcher });
    const directory = join(opts.root, 'markets', 'community');
    writeFileSync(join(directory, 'marketplace.json'), lower.bytes);
    const rollback = server(lower.bytes, lower.signature);
    await expect(ensureMarketIndex('community', { ...opts, fetcher: rollback.fetcher })).rejects.toMatchObject({ reason: 'signature', message: expect.stringContaining('sequence-rollback') });
    expect(rollback.requests).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(directory, 'cache-state.json'), 'utf8'))).toMatchObject({ url: 'https://example.org/', lastSequence: 5 });
    const recovered = await ensureMarketIndex('community', { ...opts, fetcher: server(first.bytes, first.signature).fetcher });
    expect(recovered.index.sequence).toBe(5);
    writeFileSync(join(directory, 'index.sig'), lower.signature);
    await expect(ensureMarketIndex('community', { ...opts, fetcher: rollback.fetcher })).rejects.toMatchObject({ reason: 'signature', message: expect.stringContaining('sequence-rollback') });
  });

  test('binds the cached index to the normalized configured URL', async () => {
    const opts = setup();
    const first = signed('community', 5);
    const second = signed('community', 1);
    const market = (url: string) => ({ market: { markets: [{ name: 'community', url }], trustedKeys: [first.keys, second.keys].map(({ keyId, publicKey }) => ({ keyId, publicKey })) } });
    writeFileSync(opts.configPath, JSON.stringify(market('https://old.example.org/plugins')));
    await ensureMarketIndex('community', { ...opts, fetcher: server(first.bytes, first.signature).fetcher });
    writeFileSync(opts.configPath, JSON.stringify(market('https://new.example.org/plugins')));
    const next = server(second.bytes, second.signature);
    const result = await ensureMarketIndex('community', { ...opts, fetcher: next.fetcher });
    expect(result.index.sequence).toBe(1);
    expect(result.market.url).toBe('https://new.example.org/plugins/');
    expect(next.requests).toEqual(['https://new.example.org/plugins/marketplace.json', 'https://new.example.org/plugins/index.sig']);
    expect(JSON.parse(readFileSync(join(result.directory, 'cache-state.json'), 'utf8'))).toMatchObject({ url: result.market.url, lastSequence: 1 });
    const cached = await ensureMarketIndex('community', { ...opts, fetcher: (async () => { throw new Error('unexpected request'); }) as unknown as typeof fetch });
    expect(cached.index.sequence).toBe(1);
  });

  test('recovers an orphan index left by interrupted cache publication', async () => {
    const opts = setup();
    const valid = signed('community', 3);
    writeFileSync(opts.configPath, JSON.stringify({ market: { markets: [{ name: 'community', url: 'https://example.org/' }], trustedKeys: [{ keyId: valid.keys.keyId, publicKey: valid.keys.publicKey }] } }));
    const directory = join(opts.root, 'markets', 'community');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'marketplace.json'), valid.bytes);
    const { fetcher, requests } = server(valid.bytes, valid.signature);
    expect((await ensureMarketIndex('community', { ...opts, fetcher })).index.sequence).toBe(3);
    expect(requests).toHaveLength(2);
    expect(readFileSync(join(directory, 'index.sig'), 'utf8')).toBe(valid.signature);
  });

  test('fails explicitly for missing configuration, HTTP failures and mismatched signed market names', async () => {
    const opts = setup();
    await expect(ensureMarketIndex('absent', opts)).rejects.toThrow('market not configured');
    addMarket('community', 'https://example.org/', opts);
    await expect(ensureMarketIndex('community', { ...opts, fetcher: (async (_input: string | URL | Request) => new Response('', { status: 404 })) as typeof fetch })).rejects.toThrow('HTTP 404');
    const other = signed('other', 1);
    await expect(ensureMarketIndex('community', { ...opts, fetcher: server(other.bytes, other.signature).fetcher, trustedKeys: [{ keyId: other.keys.keyId, publicKey: other.keys.publicKey }] })).rejects.toThrow('market index name mismatch');
  });

  test('fetches and caches signed internal packs and bundles only for a bound key and allowed tenant', async () => {
    const opts = setup();
    const keys = generateIndexKeyPair();
    const index = { name: 'private', interface: { displayName: 'Private' }, sequence: 1, plugins: [],
      knowledgePacks: [{ name: 'sales', version: '1.0.0', visibility: 'internal', enterpriseId: 'tenant-a', artifact: { sha256: 'a'.repeat(64), bytes: 1, key: 'sales.tgz' } }],
      loopBundles: [{ name: 'loop', version: '1.0.0', visibility: 'internal', enterpriseId: 'tenant-a', artifact: { sha256: 'b'.repeat(64), bytes: 1, key: 'loop.tgz' } }] };
    const bytes = Buffer.from(JSON.stringify(index));
    const signature = signIndex(bytes, keys.privateKeyPem, keys.keyId);
    writeFileSync(opts.configPath, JSON.stringify({ market: { internalMarkets: [{ name: 'private', url: 'https://private.example.org/catalog/', enterpriseIds: ['tenant-a'], trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] }] } }));
    const { fetcher, requests } = server(bytes, signature);
    const result = await ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher });
    expect(result.index).toMatchObject(index);
    expect(result.signature).toBe('ok');
    expect(requests).toEqual(['https://private.example.org/catalog/marketplace.json', 'https://private.example.org/catalog/index.sig']);
    expect(readFileSync(join(result.directory, 'marketplace.json'))).toEqual(bytes);
    const cached = await ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher: (async () => { throw new Error('cache missed'); }) as unknown as typeof fetch });
    expect(cached.index).toMatchObject(index);
    expect(listMarkets(opts)).toEqual([{ name: 'elanous', url: ELANOUS_MARKET_URL }]);
    await expect(ensureMarketIndex('private', { ...opts, fetcher })).rejects.toThrow('market not configured');
    await expect(ensureInternalMarketIndex('private', 'tenant-b', { ...opts, fetcher })).rejects.toThrow('enterprise not allowed');
    writeFileSync(opts.configPath, JSON.stringify({ market: { internalMarkets: [{ name: 'private', url: 'https://private.example.org/catalog/', enterpriseIds: ['tenant-b'], trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] }] } }));
    await expect(ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher })).rejects.toThrow('enterprise not allowed');
    expect(requests).toHaveLength(2);
  });

  test('rejects private rollback even after a bound signing key rotates', async () => {
    const opts = setup();
    const first = generateIndexKeyPair();
    const second = generateIndexKeyPair();
    const index = (sequence: number) => Buffer.from(JSON.stringify({ name: 'private', interface: { displayName: 'Private' }, sequence, plugins: [], knowledgePacks: [] }));
    const configure = (keys: typeof first) => writeFileSync(opts.configPath, JSON.stringify({ market: { internalMarkets: [
      { name: 'private', url: 'https://private.example.org/', enterpriseIds: ['tenant-a'], trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] },
    ] } }));
    configure(first);
    const old = index(9);
    const saved = await ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher: server(old, signIndex(old, first.privateKeyPem, first.keyId)).fetcher });
    configure(second);
    const next = index(1);
    const fetched = server(next, signIndex(next, second.privateKeyPem, second.keyId));
    await expect(ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher: fetched.fetcher })).rejects.toMatchObject({ reason: 'signature', message: expect.stringContaining('sequence-rollback') });
    expect(fetched.requests).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(saved.directory, 'cache-state.json'), 'utf8')).lastSequence).toBe(9);
  });

  test('rejects unsigned, globally trusted and cross-enterprise entries without publishing private cache', async () => {
    const opts = setup();
    const bound = generateIndexKeyPair();
    const global = generateIndexKeyPair();
    writeFileSync(opts.configPath, JSON.stringify({ market: { trustedKeys: [{ keyId: global.keyId, publicKey: global.publicKey }], internalMarkets: [
      { name: 'private', url: 'https://private.example.org/', enterpriseIds: ['tenant-a'], trustedKeys: [{ keyId: bound.keyId, publicKey: bound.publicKey }] },
    ] } }));
    const index = (enterpriseId: string, visibility = 'internal') => Buffer.from(JSON.stringify({ name: 'private', interface: { displayName: 'Private' }, sequence: 1, plugins: [],
      knowledgePacks: [{ name: 'sales', version: '1.0.0', visibility, ...(visibility === 'internal' ? { enterpriseId } : {}), artifact: { sha256: 'a'.repeat(64), bytes: 1, key: 'sales.tgz' } }] }));
    const alien = index('tenant-b');
    const forged = index('tenant-a');
    await expect(ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher: server(alien, signIndex(alien, bound.privateKeyPem, bound.keyId)).fetcher })).rejects.toThrow('outside enterprise allowlist');
    await expect(ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher: server(forged, signIndex(forged, global.privateKeyPem, global.keyId)).fetcher })).rejects.toMatchObject({ reason: 'signature', message: expect.stringContaining('unknown-key') });
    await expect(ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher: server(forged, '').fetcher })).rejects.toMatchObject({ reason: 'signature' });
    await expect(ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher: server(forged, '').fetcher,
      verifySignature: () => ({ ok: true, keyId: bound.keyId, sequence: 1, index: JSON.parse(forged.toString()) }),
    })).rejects.toMatchObject({ reason: 'signature' });
    const publicIndex = index('tenant-a', 'public');
    await expect(ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher: server(publicIndex, signIndex(publicIndex, bound.privateKeyPem, bound.keyId)).fetcher })).rejects.toThrow('outside enterprise allowlist');
    expect(existsSync(join(opts.root, 'markets', '.internal', 'private'))).toBe(false);
    expect(() => addMarket('unsafe', 'http://private.example.org/', opts)).toThrow('invalid market URL');
    writeFileSync(opts.configPath, JSON.stringify({ market: { internalMarkets: [{ name: 'private', url: 'http://private.example.org/', enterpriseIds: ['tenant-a'], trustedKeys: [{ keyId: bound.keyId, publicKey: bound.publicKey }] }] } }));
    await expect(ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher: server(forged, '').fetcher })).rejects.toThrow('invalid market URL');
    for (const change of [
      { enterpriseIds: [], trustedKeys: [{ keyId: bound.keyId, publicKey: bound.publicKey }] },
      { enterpriseIds: ['tenant-a'], trustedKeys: [] },
    ]) {
      writeFileSync(opts.configPath, JSON.stringify({ market: { internalMarkets: [{ name: 'private', url: 'https://private.example.org/', ...change }] } }));
      await expect(ensureInternalMarketIndex('private', 'tenant-a', { ...opts, fetcher: server(forged, '').fetcher })).rejects.toThrow('invalid internal market');
    }
  });

  // 🅢 R3 must-fix ① — the config may hold secrets: addMarket keeps its permission bits.
  test('addMarket keeps the config file permission (0600 stays 0600)', () => {
    const opts = setup();
    writeFileSync(opts.configPath, JSON.stringify({ secret: 'x' }), { mode: 0o600 });
    addMarket('community', 'https://example.org/plugins/', opts);
    expect(statSync(opts.configPath).mode & 0o777).toBe(0o600);
  });

  // 🅢 R3 must-fix ② — another process published a newer index while we were fetching: ours must not roll it back.
  test('a slower process cannot roll the cache back below a sequence published meanwhile', async () => {
    const opts = setup();
    const { keys, bytes, signature } = signed('community', 4);
    writeFileSync(opts.configPath, JSON.stringify({ market: { markets: [{ name: 'community', url: 'https://example.org/plugins/' }], trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] } }));
    const directory = join(opts.root, 'markets', 'community');
    const fetcher = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/index.sig')) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'cache-state.json'), JSON.stringify({ url: 'https://example.org/plugins/', lastSequence: 9, indexHash: 'a'.repeat(64), signatureHash: 'b'.repeat(64) }));
        return new Response(signature, { status: 200 });
      }
      return new Response(Buffer.from(bytes), { status: 200 });
    }) as typeof fetch;
    await expect(ensureMarketIndex('community', { ...opts, fetcher })).rejects.toThrow('rollback refused');
    expect(JSON.parse(readFileSync(join(directory, 'cache-state.json'), 'utf8')).lastSequence).toBe(9);
  });
});
