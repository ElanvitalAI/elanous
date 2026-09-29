import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { installPlugin, listInstalledPlugins } from '../../plugins/install/plugin-install.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIndexKeyPair, signIndex } from '../../market/signed-index.js';
import { handlePluginsGet, handlePluginsIndexGet, readMarketIndex } from './plugins-market.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';

const root = mkdtempSync(join(tmpdir(), 'plugins-market-api-'));
afterEach(() => rmSync(join(root, 'markets'), { recursive: true, force: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const auth = { bearerToken: 'owner-secret', noAuth: false };
const owner = (path: string, token = 'owner-secret') => new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}`, 'sec-fetch-site': 'cross-site' } });
const sample = (name: string) => ({ name, interface: { displayName: name }, sequence: 1, plugins: [{
  name: 'sample-plugin', version: '1.0.0', source: { source: 'local' }, artifact: { sha256: 'a'.repeat(64), bytes: 1, key: 'sample.tgz' },
  'ai.elanous': { capabilities: ['network'], connectors: [{ id: 'service', kind: 'api', userConfig: [{ key: 'token', label: 'API token', secret: true, value: 'DO_NOT_EXPOSE' }] }],
    graphs: ['demo'], pricing: { model: 'free' } },
}] });
function writeMarket(name: string, index: ReturnType<typeof sample>, signature?: string, nested = false) {
  const dir = join(root, 'markets', name, ...(nested ? ['.agents', 'plugins'] : []));
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(index));
  writeFileSync(join(dir, 'marketplace.json'), bytes);
  if (signature) writeFileSync(join(dir, 'index.sig'), signature);
  return bytes;
}

test('temporary state separates ok and missing and projects credential names only', () => {
  const pair = generateIndexKeyPair();
  const bytes = Buffer.from(JSON.stringify(sample('signed')));
  writeMarket('signed', sample('signed'), signIndex(bytes, pair.privateKeyPem, pair.keyId));
  writeMarket('unsigned', sample('unsigned'), undefined, true);
  const result = readMarketIndex(root, [{ keyId: pair.keyId, publicKey: pair.publicKey }]);
  expect(result.markets.map(m => [m.name, m.signature])).toEqual([['signed', 'ok'], ['unsigned', 'missing']]);
  expect(result.markets[0]?.plugins[0]).toMatchObject({ capabilities: ['network'], graphs: ['demo'], sha256: 'a'.repeat(64),
    connectors: [{ id: 'service', kind: 'api', userConfig: [{ key: 'token', label: 'API token', secret: true }] }] });
  expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
  expect(JSON.stringify(result)).not.toContain(pair.publicKey);
  expect(JSON.stringify(result)).not.toContain('index.sig');
});

test('owner index handler reads configured trust keys without exposing them', async () => {
  const pair = generateIndexKeyPair();
  const bytes = Buffer.from(JSON.stringify(sample('configured')));
  writeMarket('configured', sample('configured'), signIndex(bytes, pair.privateKeyPem, pair.keyId));
  writeMarket('unsigned', sample('unsigned'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ market: { trustedKeys: [{ keyId: pair.keyId, publicKey: pair.publicKey }] } }));
  const response = await handlePluginsIndexGet(owner('/v1/plugins/index'), auth, root, configPath).text();
  expect(JSON.parse(response).markets.map((market: { name: string; signature: string }) => [market.name, market.signature]))
    .toEqual([['configured', 'ok'], ['unsigned', 'missing']]);
  expect(response).not.toContain(pair.publicKey);
  expect(response).not.toContain('DO_NOT_EXPOSE');
});

test('unknown key, broken signature, malformed JSON are visible without leaking signature', () => {
  const pair = generateIndexKeyPair();
  const bytes = Buffer.from(JSON.stringify(sample('untrusted')));
  writeMarket('untrusted', sample('untrusted'), signIndex(bytes, pair.privateKeyPem, pair.keyId));
  writeMarket('broken', sample('broken'), 'invalid-json');
  const tamperedBytes = Buffer.from(JSON.stringify(sample('tampered')));
  writeMarket('tampered', sample('tampered'), signIndex(tamperedBytes, pair.privateKeyPem, pair.keyId));
  writeFileSync(join(root, 'markets', 'tampered', 'marketplace.json'), JSON.stringify({ ...sample('tampered'), sequence: 2 }));
  writeMarket('invalid', sample('invalid'));
  writeFileSync(join(root, 'markets', 'invalid', 'marketplace.json'), '{');
  const markets = readMarketIndex(root, [{ keyId: pair.keyId, publicKey: pair.publicKey }]).markets;
  expect(markets.map(m => [m.name, m.signature])).toEqual([['broken', 'malformed'], ['invalid', 'malformed'], ['tampered', 'stale'], ['untrusted', 'ok']]);
  expect(readMarketIndex(root).markets.find(m => m.name === 'untrusted')?.signature).toBe('unknown-key');
  expect(markets[2]?.plugins).toHaveLength(1);
  expect(JSON.stringify(markets)).not.toContain('invalid-json');
});

test('a market directory with no index remains visible as malformed', () => {
  mkdirSync(join(root, 'markets', 'empty'), { recursive: true });
  expect(readMarketIndex(root).markets).toEqual([{ name: 'empty', signature: 'malformed', detail: 'marketplace.json: not found', plugins: [] }]);
});

test('the index response carries no local filesystem path (browser must not learn the state root)', () => {
  mkdirSync(join(root, 'markets', 'empty'), { recursive: true });
  expect(JSON.stringify(readMarketIndex(root))).not.toContain(root);
});

test('both handlers require owner; installed list is returned directly', async () => {
  expect(handlePluginsIndexGet(owner('/v1/plugins/index', 'wrong'), auth, root).status).toBe(401);
  expect(handlePluginsGet(owner('/v1/plugins', 'wrong'), auth, root).status).toBe(401);
  expect((await handlePluginsIndexGet(owner('/v1/plugins/index'), auth, root).json() as { markets: unknown[] }).markets).toEqual([]);
  expect(await handlePluginsGet(owner('/v1/plugins'), auth, root).json()).toEqual([]);
});

test('installed endpoint returns only installer inventory without inventing installation timestamps; removed paths do not break listing', async () => {
  const makeSource = (id: string) => {
    const packageDir = join(root, id);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', main: './plugin.ts', capabilities: [], contributes: {} }));
    writeFileSync(join(packageDir, 'plugin.ts'), 'export default {}');
    return packageDir;
  };
  const removed = await installPlugin(makeSource('removed-plugin'), { root, yes: true });
  await installPlugin(makeSource('remaining-plugin'), { root, yes: true });
  expect(await handlePluginsGet(owner('/v1/plugins'), auth, root).json()).toEqual(listInstalledPlugins(root));
  rmSync(removed.path, { recursive: true, force: true });
  const response = await handlePluginsGet(owner('/v1/plugins'), auth, root).json();
  expect(response).toEqual(listInstalledPlugins(root));
  expect(response).toHaveLength(1);
  expect(JSON.stringify(response)).not.toContain('installedAt');
});

test('HTTP dispatcher connects only authenticated GET routes', async () => {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const bus = new NexusEventBus();
  state.bus = bus;
  const opts = { state, registry: new TabRegistry(state), eventBus: bus, metaApi: auth };
  const route = (req: Request) => routeRequest(req, opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  expect((await route(owner('/v1/plugins/index', 'wrong')))?.status).toBe(401);
  expect((await route(owner('/v1/plugins', 'wrong')))?.status).toBe(401);
  expect((await route(owner('/v1/plugins/index')))?.status).toBe(200);
  expect((await route(owner('/v1/plugins')))?.status).toBe(200);
  expect((await route(new Request('http://localhost/v1/plugins', { method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } })))?.status).toBe(405);
});
