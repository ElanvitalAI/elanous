import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installPlugin, listInstalledPlugins } from '../../plugins/install/plugin-install.js';
import * as debugModule from '../../debug/log.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIndexKeyPair, signIndex } from '../../market/signed-index.js';
import { handlePluginsGet, handlePluginsIndexGet, handlePluginsInstall, handlePluginsMarketRefresh, handlePluginsRemove, handlePluginWizardList, handlePluginWizardSave, readMarketIndex, safeDetail } from './plugins-market.js';
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
  expect(JSON.stringify(result)).not.toContain('marketplace.json');
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
  expect(readMarketIndex(root).markets).toEqual([{ name: 'empty', signature: 'malformed', detail: '마켓 인덱스를 찾지 못했습니다.', plugins: [] }]);
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

test('installed endpoint returns recorded ISO installation times only; removed paths do not break listing', async () => {
  const makeSource = (id: string) => {
    const packageDir = join(root, id);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', main: './plugin.ts', capabilities: [], contributes: {} }));
    writeFileSync(join(packageDir, 'plugin.ts'), 'export default {}');
    return packageDir;
  };
  const removed = await installPlugin(makeSource('removed-plugin'), { root, yes: true });
  await installPlugin(makeSource('remaining-plugin'), { root, yes: true });
  await installPlugin(makeSource('legacy-plugin'), { root, yes: true });
  const ledgerPath = join(root, 'plugins', 'installed.json');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Array<{ name: string; installedAt?: string }>;
  expect(ledger.find(entry => entry.name === 'remaining-plugin')?.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const recordedTime = '2001-02-03T04:05:06.789Z';
  writeFileSync(ledgerPath, JSON.stringify(ledger.map(entry => entry.name === 'legacy-plugin' ? { ...entry, installedAt: undefined } : entry.name === 'remaining-plugin' ? { ...entry, installedAt: recordedTime } : entry)));
  const recordedRemaining = (JSON.parse(readFileSync(ledgerPath, 'utf8')) as typeof ledger).find(entry => entry.name === 'remaining-plugin');
  expect(recordedRemaining?.installedAt).toBe(recordedTime);
  expect(await handlePluginsGet(owner('/v1/plugins'), auth, root).json()).toEqual(listInstalledPlugins(root));
  rmSync(removed.path, { recursive: true, force: true });
  const response = await handlePluginsGet(owner('/v1/plugins'), auth, root).json() as ReturnType<typeof listInstalledPlugins>;
  const inventory = listInstalledPlugins(root);
  expect(response).toEqual(inventory);
  expect(response).toHaveLength(2);
  const remaining = response.find(plugin => plugin.name === 'remaining-plugin');
  expect(remaining?.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(remaining?.installedAt).toBe(recordedRemaining?.installedAt);
  expect(remaining?.installedAt).toBe(inventory.find(plugin => plugin.name === 'remaining-plugin')?.installedAt);
  const legacy = response.find(plugin => plugin.name === 'legacy-plugin');
  expect(legacy).toBeDefined();
  expect(legacy).not.toHaveProperty('installedAt');
});

test('install refuses capabilities outside explicit acceptance and streams a final failed line without secrets', async () => {
  const source = join(root, 'consent-source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'consent-plugin', name: 'consent-plugin', version: '1.0.0', main: './plugin.ts', capabilities: [{ kind: 'network' }, { kind: 'filesystem' }], contributes: {} }));
  writeFileSync(join(source, 'plugin.ts'), 'export default {}');
  const archive = join(root, 'consent.tgz');
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  const bytes = readFileSync(archive);
  const market = sample('consent-market');
  market.plugins[0]!.name = 'consent-plugin';
  market.plugins[0]!.version = '1.0.0';
  market.plugins[0]!.artifact = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, key: 'consent.tgz' };
  const pair = generateIndexKeyPair();
  const signature = signIndex(Buffer.from(JSON.stringify(market)), pair.privateKeyPem, pair.keyId);
  writeMarket('consent-market', market, signature);
  writeFileSync(join(root, 'markets', 'consent-market', 'consent.tgz'), bytes);
  const configPath = join(root, 'install-config.json');
  writeFileSync(configPath, JSON.stringify({ market: { trustedKeys: [{ keyId: pair.keyId, publicKey: pair.publicKey }] } }));
  const request = (acceptedCapabilities: string[]) => new Request('http://localhost/v1/plugins/install', { method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ spec: 'consent-plugin@consent-market', acceptedCapabilities }) });
  const logs: unknown[] = [];
  const spy = spyOn(debugModule.debug, 'log').mockImplementation((...args) => { logs.push(args); });
  try {
    expect((await handlePluginsInstall(new Request('http://localhost/v1/plugins/install', { method: 'POST', headers: { authorization: 'Bearer wrong', 'sec-fetch-site': 'cross-site' }, body: '{}' }), auth, root, configPath)).status).toBe(401);
    const refused = await handlePluginsInstall(request([]), auth, root, configPath);
    expect(refused.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await refused.text();
    expect(JSON.parse(text.trim().split('\n').at(-1)!)).toEqual({ event: 'failed', reason: 'consent-denied', detail: 'plugin capabilities require consent' });
    expect(listInstalledPlugins(root).some(plugin => plugin.name === 'consent-plugin')).toBe(false);
    expect(text).not.toContain('DO_NOT_EXPOSE');
    expect(text).not.toContain(pair.publicKey);
    expect(text).not.toContain(signature);
    const partial = await handlePluginsInstall(request(['network']), auth, root, configPath);
    expect(JSON.parse((await partial.text()).trim().split('\n').at(-1)!)).toEqual({ event: 'failed', reason: 'consent-denied', detail: 'plugin capabilities require consent' });
    expect(listInstalledPlugins(root).some(plugin => plugin.name === 'consent-plugin')).toBe(false);
    const accepted = await handlePluginsInstall(request(['network', 'filesystem']), auth, root, configPath);
    expect(JSON.parse((await accepted.text()).trim().split('\n').at(-1)!)).toEqual({ event: 'done' });
    expect(listInstalledPlugins(root).some(plugin => plugin.name === 'consent-plugin')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('DO_NOT_EXPOSE');
    expect(JSON.stringify(logs)).not.toContain(pair.publicKey);
    expect(JSON.stringify(logs)).not.toContain(signature);
  } finally { spy.mockRestore(); }
});

test('refresh and remove enforce owner authentication before mutation', async () => {
  const post = new Request('http://localhost/v1/plugins/markets/elanous/refresh', { method: 'POST', headers: { authorization: 'Bearer wrong', 'sec-fetch-site': 'cross-site' } });
  expect((await handlePluginsMarketRefresh(post, 'elanous', auth, { root })).status).toBe(401);
  const pair = generateIndexKeyPair();
  const index = sample('elanous');
  const bytes = Buffer.from(JSON.stringify(index));
  const signature = signIndex(bytes, pair.privateKeyPem, pair.keyId);
  const fetcher = async (url: string | URL | Request) => new Response(String(url).endsWith('index.sig') ? signature : bytes);
  const refreshLogs: unknown[] = [];
  const logSpy = spyOn(debugModule.debug, 'log').mockImplementation((...args) => { refreshLogs.push(args); });
  try {
    const refreshed = await handlePluginsMarketRefresh(new Request(post.url, { method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } }), 'elanous', auth,
      { root, fetcher: fetcher as typeof fetch, trustedKeys: [{ keyId: pair.keyId, publicKey: pair.publicKey }] });
    expect((await refreshed.json() as { ok: boolean; plugins: unknown[] }).plugins).toHaveLength(1);
    expect(JSON.stringify(refreshLogs)).not.toContain(pair.publicKey);
    expect(JSON.stringify(refreshLogs)).not.toContain(signature);
    const failed = await handlePluginsMarketRefresh(new Request(post.url, { method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } }), 'elanous', auth,
      { root, fetcher: (async (_url: string | URL | Request) => { throw new Error('SECRET_PRIVATE_VALUE'); }) as unknown as typeof fetch });
    expect(await failed.json()).toEqual({ ok: false, reason: 'io' });
    expect(JSON.stringify(refreshLogs)).not.toContain('SECRET_PRIVATE_VALUE');
  } finally { logSpy.mockRestore(); }
  const del = new Request('http://localhost/v1/plugins/remaining-plugin', { method: 'DELETE', headers: { authorization: 'Bearer wrong', 'sec-fetch-site': 'cross-site' } });
  expect(handlePluginsRemove(del, 'remaining-plugin', auth, root).status).toBe(401);
  expect(await handlePluginsRemove(new Request(del.url, { method: 'DELETE', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } }), 'remaining-plugin', auth, root).json()).toEqual({ removed: 1 });
});

test('wizard route stores, lists and regenerates drafts without installing; owner-only', async () => {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const bus = new NexusEventBus();
  state.bus = bus;
  const opts = { state, registry: new TabRegistry(state), eventBus: bus, metaApi: auth, pluginStateRoot: root };
  const route = (req: Request) => routeRequest(req, opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  const path = '/v1/plugins/wizard';
  const ledgerPath = join(root, 'plugins', 'installed.json');
  const ledgerBefore = readFileSync(ledgerPath, 'utf8');
  const draft = { description: 'Weather summary', skill: { description: 'Weather summary', instructions: 'Summarize forecasts.' } };
  const post = (token: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'sec-fetch-site': 'cross-site' }, body: JSON.stringify(body) });
  expect((await route(owner(path, 'wrong')))?.status).toBe(401);
  expect((await route(post('wrong', { name: 'weather-research', draft })))?.status).toBe(401);
  expect((await route(post('owner-secret', { name: '../escape', draft })))?.status).toBe(400);
  expect((await route(post('owner-secret', { name: 'weather-research', draft })))?.status).toBe(200);
  expect((await route(post('owner-secret', { name: 'weather-research', draft })))?.status).toBe(422);
  const hostile = await route(post('owner-secret', { name: 'hostile-draft', draft: { ...draft,
    connectors: [{ id: 'weather', credentials: [{ name: 'API_KEY', value: 'PRIVATE_VALUE' }] }] } }));
  expect(hostile?.status).toBe(422);
  expect(JSON.stringify(await hostile?.json())).not.toContain('PRIVATE_VALUE');
  expect(existsSync(join(root, 'plugins-local', 'hostile-draft'))).toBe(false);
  const listed = await (await route(owner(path)))?.json() as { plugins: Array<{ name: string; draft: typeof draft }> };
  expect(listed.plugins[0]?.draft.skill?.instructions).toBe('Summarize forecasts.');
  expect(listed.plugins.some(plugin => plugin.name === 'hostile-draft')).toBe(false);
  expect((await route(post('owner-secret', { name: 'weather-research', draft: { ...draft, description: 'Tomorrow weather' }, regenerate: true })))?.status).toBe(200);
  expect((await handlePluginWizardList(owner(path), auth, root).json() as { plugins: Array<{ description: string }> }).plugins[0]?.description).toBe('Tomorrow weather');
  expect((await handlePluginWizardSave(post('wrong', { name: 'weather-research', draft }), auth, root)).status).toBe(401);
  expect(await handlePluginsGet(owner('/v1/plugins'), auth, root).json()).toEqual(listInstalledPlugins(root));
  expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore);
});

test('HTTP dispatcher connects authenticated GET and write routes', async () => {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const bus = new NexusEventBus();
  state.bus = bus;
  const opts = { state, registry: new TabRegistry(state), eventBus: bus, metaApi: auth, pluginStateRoot: root };
  const route = (req: Request) => routeRequest(req, opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  expect((await route(owner('/v1/plugins/index', 'wrong')))?.status).toBe(401);
  expect((await route(owner('/v1/plugins', 'wrong')))?.status).toBe(401);
  expect((await route(owner('/v1/plugins/index')))?.status).toBe(200);
  expect((await route(owner('/v1/plugins')))?.status).toBe(200);
  for (const [method, path] of [['POST', '/v1/plugins/install'], ['POST', '/v1/plugins/markets/elanous/refresh'], ['DELETE', '/v1/plugins/example-plugin']]) {
    expect((await route(new Request(`http://localhost${path}`, { method, headers: { authorization: 'Bearer wrong', 'sec-fetch-site': 'cross-site' } })))?.status).toBe(401);
  }
  expect((await route(new Request('http://localhost/v1/plugins/install', { method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' }, body: '{}' })))?.status).toBe(400);
  expect(await (await route(new Request('http://localhost/v1/plugins/example-plugin', { method: 'DELETE', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } })))?.json()).toEqual({ removed: 0 });
  expect((await route(new Request('http://localhost/v1/plugins', { method: 'POST', headers: { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } })))?.status).toBe(405);
});

test('safeDetail hides home paths, keeps one line, caps length', () => {
  expect(safeDetail(new Error('artifact unavailable: /Users/someone/.elanous/markets/elanous/x.tgz\nmore'))).toBe('artifact unavailable: ~/.elanous/markets/elanous/x.tgz more');
  expect(safeDetail(new Error('x'.repeat(500)))?.length).toBe(200);
  expect(safeDetail(undefined)).toBeUndefined();
});
