import { Command } from 'commander';
import { expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCatalogCommands } from './catalog-cli.js';
import { signCatalogPayload } from '../registry/catalog-server.js';

test('eln catalog refresh rebuilds the catalog only after verified cache refresh', async () => {
  const output: string[] = [];
  let reloads = 0;
  const program = new Command();
  registerCatalogCommands(program, {
    refresh: async () => ({ ok: true, payload: { catalogVersion: 9, generatedAt: '2026-10-30T00:00:00.000Z', providers: [], models: [] } }),
    reload: () => { reloads++; return {} as never; },
    write: (line) => output.push(line),
  });
  await program.parseAsync(['node', 'test', 'catalog', 'refresh', '--json']);
  expect(reloads).toBe(1);
  expect(JSON.parse(output[0]!)).toEqual({ outcome: 'updated', catalogVersion: 9 });
});

test('eln catalog refresh keeps the current catalog on failure and returns a nonzero status', async () => {
  const output: string[] = [];
  let reloads = 0;
  let exitCode = 0;
  const program = new Command();
  registerCatalogCommands(program, {
    refresh: async () => ({ ok: false, reason: 'signature-rejected' }),
    reload: () => { reloads++; return {} as never; },
    write: (line) => output.push(line),
    setExitCode: (code) => { exitCode = code; },
  });
  await program.parseAsync(['node', 'test', 'catalog', 'refresh', '--json']);
  expect(reloads).toBe(0);
  expect(exitCode).toBe(1);
  expect(JSON.parse(output[0]!)).toEqual({ outcome: 'failed', reason: 'signature-rejected' });
});

test('eln catalog refresh default path fetches, verifies and caches a signed local response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-cli-refresh-'));
  const keyPath = join(root, 'public.pem');
  const cachePath = join(root, 'cache.json');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, publicKey.export({ format: 'pem', type: 'spki' }));
  const payload = { catalogVersion: 9, generatedAt: new Date().toISOString(), providers: [], models: [] };
  const signed = signCatalogPayload(payload, privateKey);
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(signed));
  });
  const envKeys = ['ELANOUS_CATALOG_PUBLIC_KEY_FILE', 'ELANOUS_CATALOG_SERVER_CACHE'];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local server did not bind a TCP port');
  process.env.ELANOUS_CATALOG_PUBLIC_KEY_FILE = keyPath;
  process.env.ELANOUS_CATALOG_SERVER_CACHE = cachePath;
  try {
    const output: string[] = [];
    let reloads = 0;
    const program = new Command();
    registerCatalogCommands(program, { reload: () => { reloads++; return {} as never; }, write: (line) => output.push(line) });
    await program.parseAsync(['node', 'test', 'catalog', 'refresh', '--url', `http://127.0.0.1:${address.port}/catalog.json`, '--json']);
    expect(reloads).toBe(1);
    expect(JSON.parse(output[0]!)).toEqual({ outcome: 'updated', catalogVersion: 9 });
    expect(JSON.parse(await Bun.file(cachePath).text()).catalogVersion).toBe(9);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
