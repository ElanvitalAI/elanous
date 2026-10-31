import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalCatalogPayload,
  readVerifiedCatalogCache,
  refreshServerCatalog,
  verifyCatalogDocument,
  type SignedCatalogPayload,
} from './catalog-server.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { reloadCatalog } from './loader.js';
import { debug } from '../debug/log.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'signed-catalog-'));
  roots.push(value);
  return value;
}

function document(catalogVersion: number, generatedAt = new Date().toISOString()) {
  const payload: SignedCatalogPayload = {
    catalogVersion,
    generatedAt,
    providers: [{ id: 'openai', displayName: 'OpenAI' } as never],
    models: [{ id: `gpt-test-${catalogVersion}`, provider: 'openai', displayName: 'Test' } as never],
  };
  return { ...payload, signature: sign(null, Buffer.from(canonicalCatalogPayload(payload)), privateKey).toString('base64') };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('signed server catalog', () => {
  it('accepts an Ed25519 signature and rejects payload tampering', () => {
    const signed = document(2);
    expect(verifyCatalogDocument(signed, publicKeyPem)?.catalogVersion).toBe(2);
    expect(verifyCatalogDocument({ ...signed, catalogVersion: 3 }, publicKeyPem)).toBeNull();
  });

  it('writes a verified response atomically and reads it as fresh cache', async () => {
    const cachePath = join(root(), 'catalog', 'cache.json');
    const signed = document(4);
    const result = await refreshServerCatalog({
      cachePath, publicKeyPem, timeoutMs: 50,
      fetchImpl: (async () => new Response(JSON.stringify(signed), { status: 200 })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: true, payload: { catalogVersion: 4 } });
    expect(readVerifiedCatalogCache({ cachePath, publicKeyPem })?.payload.catalogVersion).toBe(4);
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).signature).toBe(signed.signature);
  });

  it('rejects invalid signatures and catalog version rollback without replacing last good cache', async () => {
    const cachePath = join(root(), 'catalog', 'cache.json');
    const current = document(5);
    await refreshServerCatalog({ cachePath, publicKeyPem, fetchImpl: (async () => new Response(JSON.stringify(current))) as unknown as typeof fetch });
    const rollback = await refreshServerCatalog({
      cachePath, publicKeyPem,
      fetchImpl: (async () => new Response(JSON.stringify(document(4)))) as unknown as typeof fetch,
    });
    expect(rollback).toEqual({ ok: false, reason: 'version-rejected' });
    const invalid = await refreshServerCatalog({
      cachePath, publicKeyPem,
      fetchImpl: (async () => new Response(JSON.stringify({ ...current, signature: 'invalid' }))) as unknown as typeof fetch,
    });
    expect(invalid).toEqual({ ok: false, reason: 'signature-rejected' });
    expect(readVerifiedCatalogCache({ cachePath, publicKeyPem })?.payload.catalogVersion).toBe(5);
  });

  it('rejects a signed rollback below the bundled catalog version on a cold install', async () => {
    const cachePath = join(root(), 'cache.json');
    const result = await refreshServerCatalog({
      cachePath, publicKeyPem,
      fetchImpl: (async () => new Response(JSON.stringify(document(1)))) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: 'version-rejected' });
    expect(existsSync(cachePath)).toBe(false);
  });

  it('survives an unavailable server and enforces the refresh timeout', async () => {
    const cachePath = join(root(), 'catalog', 'cache.json');
    const result = await refreshServerCatalog({
      cachePath, publicKeyPem, timeoutMs: 5,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: 'fetch-failed' });
    expect(readVerifiedCatalogCache({ cachePath, publicKeyPem })).toBeNull();
  });

  it('omits stale when no verified server cache exists', () => {
    const config = root();
    const saved = new Map(['NODE_ENV', 'ELANOUS_CATALOG_SERVER_CACHE'].map((key) => [key, process.env[key]]));
    const savedOverride = getElanousConfigDirOverride();
    const logs = spyOn(debug, 'log').mockImplementation(() => {});
    process.env.NODE_ENV = 'test';
    delete process.env.ELANOUS_CATALOG_SERVER_CACHE;
    setElanousConfigDir(config);
    try {
      reloadCatalog();
      const source = logs.mock.calls.find(([category, event]) => category === 'registry.catalog' && event === 'catalog.source');
      expect(source?.[2]).toMatchObject({ source: 'merged', layers: ['package'] });
      expect(source?.[2]).not.toHaveProperty('stale');
    } finally {
      logs.mockRestore();
      resetElanousConfigDir();
      if (savedOverride) setElanousConfigDir(savedOverride);
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      reloadCatalog();
    }
  });

  it('marks a verified cache older than 24 hours as stale', () => {
    const cachePath = join(root(), 'cache.json');
    const now = Date.now();
    writeFileSync(cachePath, JSON.stringify(document(11, new Date(now - 25 * 60 * 60 * 1000).toISOString())));
    const logs = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(readVerifiedCatalogCache({ cachePath, publicKeyPem, now })).toMatchObject({ stale: true, payload: { catalogVersion: 11 } });
      expect(logs.mock.calls.some(([category, event, data]) => category === 'registry.catalog'
        && event === 'catalog.stale' && (data as { stale?: unknown } | undefined)?.stale === true)).toBe(true);
    } finally { logs.mockRestore(); }
  });

  it('merges package < signed server < user overlay < live discovery without overwriting pinned models', () => {
    const base = root();
    const builtin = join(base, 'builtin');
    const config = join(base, 'config');
    const cachePath = join(base, 'server-cache.json');
    const keyPath = join(base, 'server-public.pem');
    const discoveryPath = join(base, 'discovery.json');
    mkdirSync(join(builtin, 'providers'), { recursive: true });
    mkdirSync(join(builtin, 'models', 'openai'), { recursive: true });
    mkdirSync(join(config, 'catalog', 'providers'), { recursive: true });
    mkdirSync(join(config, 'catalog', 'models', 'openai'), { recursive: true });
    writeFileSync(join(builtin, 'providers', 'openai.yaml'), 'id: openai\ndisplayName: Package provider\nbuiltIn: true\ncatalogFromDiscovery: true\n');
    writeFileSync(join(builtin, 'models', 'openai', 'shared.yaml'), 'id: openai/shared\nprovider: openai\ndisplayName: Package model\n');
    writeFileSync(join(builtin, 'models', 'openai', 'server-only.yaml'), 'id: openai/server-only\nprovider: openai\ndisplayName: Package version\n');
    writeFileSync(join(config, 'catalog', 'providers', 'openai.yaml'), 'id: openai\ndisplayName: User provider\n');
    writeFileSync(join(config, 'catalog', 'models', 'openai', 'shared.yaml'), 'id: openai/shared\nprovider: openai\ndisplayName: User model\n');
    writeFileSync(keyPath, publicKeyPem);
    const signed = document(8);
    signed.providers = [{ id: 'openai', displayName: 'Server provider', builtIn: true, catalogFromDiscovery: true } as never];
    signed.models = [
      { id: 'openai/shared', provider: 'openai', displayName: 'Server model' } as never,
      { id: 'openai/server-only', provider: 'openai', displayName: 'Server model' } as never,
    ];
    // Re-sign the altered catalog payload.
    const payload = { catalogVersion: signed.catalogVersion, generatedAt: signed.generatedAt, providers: signed.providers, models: signed.models } as SignedCatalogPayload;
    signed.signature = sign(null, Buffer.from(canonicalCatalogPayload(payload)), privateKey).toString('base64');
    writeFileSync(cachePath, JSON.stringify(signed));
    writeFileSync(discoveryPath, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), sources: [], models: [
      { id: 'live-only', provider: 'openai', partial: { displayName: 'Live model' }, discoveryMeta: { source: 'auto-openai-api', lastSeen: new Date().toISOString(), autoFilled: true } },
    ] }));

    const saved = new Map(['NODE_ENV', 'ELANOUS_BUILTIN_CATALOG_DIR', 'ELANOUS_CATALOG_SERVER_CACHE', 'ELANOUS_CATALOG_PUBLIC_KEY_FILE', 'ELANOUS_CATALOG_DISCOVERY_SNAPSHOT'].map((key) => [key, process.env[key]]));
    const savedOverride = getElanousConfigDirOverride();
    process.env.NODE_ENV = 'test';
    process.env.ELANOUS_BUILTIN_CATALOG_DIR = builtin;
    process.env.ELANOUS_CATALOG_SERVER_CACHE = cachePath;
    process.env.ELANOUS_CATALOG_PUBLIC_KEY_FILE = keyPath;
    process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = discoveryPath;
    setElanousConfigDir(config);
    try {
      const catalog = reloadCatalog();
      expect(catalog.providers.get('openai')?.displayName).toBe('User provider');
      expect(catalog.models.get('openai/shared')?.displayName).toBe('User model');
      expect(catalog.models.get('openai/server-only')?.displayName).toBe('Server model');
      expect(catalog.models.get('openai/live-only')?.displayName).toBe('Live model');
    } finally {
      resetElanousConfigDir();
      if (savedOverride) setElanousConfigDir(savedOverride);
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      reloadCatalog();
    }
  });
});
