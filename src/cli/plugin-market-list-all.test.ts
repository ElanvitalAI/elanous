import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIndexKeyPair, signIndex } from '../market/signed-index.js';
import { ELANOUS_MARKET_URL } from '../plugins/install/market-fetch.js';
import { simCli } from '../ux-sim/in-process-cli.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('plugin market list --all exposes the complete signed catalog on an empty installation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-market-cli-'));
  dirs.push(root);
  const keys = generateIndexKeyPair();
  const plugins = ['alpha', 'beta', 'gamma'].map(name => ({ name, version: '1.0.0', source: { source: 'local' },
    artifact: { sha256: 'a'.repeat(64), bytes: 1, key: `${name}.tgz` },
    'ai.elanous': { capabilities: [], connectors: [], pricing: { model: 'free' } } }));
  const index = Buffer.from(JSON.stringify({ name: 'elanous', interface: { displayName: 'Elanous' }, sequence: 1, plugins }));
  const signature = signIndex(index, keys.privateKeyPem, keys.keyId);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ market: { trustedKeys: [{ keyId: keys.keyId, publicKey: keys.publicKey }] } }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.startsWith(ELANOUS_MARKET_URL)) throw new Error('unexpected market URL');
    return new Response(url.endsWith('index.sig') ? signature : index);
  }) as typeof fetch;
  try {
    const result = await simCli(['plugin', 'market', 'list', '--all', '--json'], {
      allowPaths: [['plugin', 'market', 'list']], stateRoot: root,
    });
    expect(result.exitCode).toBe(0);
    const listed = JSON.parse(result.stdout) as Array<{ market: string; plugin: { name: string } }>;
    expect(listed.map(entry => entry.plugin.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(listed.every(entry => entry.market === 'elanous')).toBe(true);
    expect(listed).toHaveLength(plugins.length);
  } finally { globalThis.fetch = previousFetch; }
});
