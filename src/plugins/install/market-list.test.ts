import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIndexKeyPair, signIndex } from '../../market/signed-index.js';
import { ELANOUS_MARKET_URL } from './market-fetch.js';
import { listAvailableMarketPlugins } from './market-list.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function plugin(name: string) {
  return { name, version: '1.0.0', source: { source: 'local' },
    artifact: { sha256: 'a'.repeat(64), bytes: 1, key: `${name}.tgz` },
    'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } };
}

test('empty install lists every verified entry from every public market without truncation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-market-list-'));
  dirs.push(root);
  const key = generateIndexKeyPair();
  const communityUrl = 'https://example.org/community/';
  const data = new Map([
    [ELANOUS_MARKET_URL, { name: 'elanous', interface: { displayName: 'Elanous' }, sequence: 1,
      plugins: Array.from({ length: 55 }, (_, i) => plugin(`official-${i}`)) }],
    [communityUrl, { name: 'community', interface: { displayName: 'Community' }, sequence: 1,
      plugins: [plugin('community-one'), plugin('community-two')] }],
  ]);
  const payloads = new Map([...data].map(([url, index]) => {
    const bytes = Buffer.from(JSON.stringify(index));
    return [url, { bytes, signature: signIndex(bytes, key.privateKeyPem, key.keyId) }];
  }));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ market: { markets: [{ name: 'community', url: communityUrl }] } }));
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    const base = [...payloads.keys()].find(prefix => url.startsWith(prefix));
    if (!base) throw new Error(`unexpected URL: ${url}`);
    const payload = payloads.get(base)!;
    return new Response(url.endsWith('index.sig') ? payload.signature : payload.bytes);
  }) as typeof fetch;
  const listed = await listAvailableMarketPlugins({ root, marketDir: join(root, 'markets'), configPath,
    trustedKeys: [{ keyId: key.keyId, publicKey: key.publicKey }], fetcher });
  expect(listed).toHaveLength(57);
  expect(listed.filter(entry => entry.market === 'elanous')).toHaveLength(55);
  expect(listed.at(-1)?.plugin.name).toBe('community-two');
  expect(listed[0]?.plugin.name).toBe('official-0');
});
