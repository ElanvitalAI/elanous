import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groundDeploymentEnvironment, groundingPrompt, readGroundingReceipt,
  validateAppBuildGrounding, writeGroundingReceipt } from './grounding.js';
import type { DeploymentEnvironment } from './deployment-environment.js';

const environment: DeploymentEnvironment = {
  runtime: { command: 'bun', version: '1.4.2', platform: 'darwin' },
  builtinModules: ['bun:sqlite'], testModules: ['bun:test'], storageModules: ['bun:sqlite'],
  apiSurfaces: [{ module: 'bun:sqlite', exports: ['Database'], classes: [{ name: 'Database', methods: ['exec', 'query'] }] }],
  nodeModulesPresent: false, installedPackages: [], packageInstallAvailable: false, network: 'off',
  writableArtifactRoot: true, writableTempRoot: true, portBindingAvailable: false,
  sandbox: 'darwin-private-netoff-envempty',
};

test('catalog grounding collects only an exact-version official release source and preserves its hash', async () => {
  const body = '<title>Bun v1.4.2</title><p>bun:sqlite Database API</p>';
  const result = await groundDeploymentEnvironment(environment, {
    firecrawlAvailable: async () => false, grokAvailable: () => true,
    grokSearch: async () => ({ hits: [{ url: 'https://bun.sh/blog/bun-v1.4.2', title: 'Bun v1.4.2', snippet: '' }],
      providerName: 'grok', durationMs: 1 }),
    fetch: async () => new Response(body), now: () => '2026-11-15T12:00:00.000Z',
  });
  expect(result.externalStatus).toBe('verified');
  expect(result.external[0]?.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  expect(result.external[0]?.url).toBe('https://bun.sh/blog/bun-v1.4.2');
  expect(validateAppBuildGrounding(result, environment)).toBe(true);
  expect(groundingPrompt(result)).toContain('Database.prototype methods: exec, query');
});

test('missing provider, wrong version, or off-domain redirect never becomes verified grounding', async () => {
  const unavailable = await groundDeploymentEnvironment(environment, { firecrawlAvailable: async () => false,
    omniCrawlAvailable: () => false, grokAvailable: () => false, fetch: async () => { throw new Error('offline'); } });
  expect(unavailable.externalStatus).toBe('source-unverified');
  expect(unavailable.neededDevices).toContain('firecrawl-key');
  expect(unavailable.neededDevices).toContain('omni-crawl-binary');
  const mismatch = await groundDeploymentEnvironment(environment, {
    firecrawlAvailable: async () => false, grokAvailable: () => true,
    grokSearch: async () => ({ hits: [{ url: 'https://bun.sh/blog/bun-v1.4.2', title: 'old', snippet: '' }],
      providerName: 'grok', durationMs: 1 }),
    fetch: async () => new Response('Bun v1.4.4'),
  });
  expect(mismatch.externalStatus).toBe('source-unverified');
  const redirected = await groundDeploymentEnvironment(environment, {
    firecrawlAvailable: async () => false, grokAvailable: () => true,
    grokSearch: async () => ({ hits: [{ url: 'https://bun.sh/blog/bun-v1.4.2', title: 'old', snippet: '' }],
      providerName: 'grok', durationMs: 1 }),
    fetch: async () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/steal' } }),
  });
  expect(redirected.externalStatus).toBe('source-unverified');
  expect(redirected.external).toEqual([]);
});

test('approved official-domain HTTPS fallback records missing utilities and exact source bytes', async () => {
  const body = '<title>Bun v1.4.2</title><p>release notes</p>';
  const result = await groundDeploymentEnvironment(environment, { firecrawlAvailable: async () => false,
    omniCrawlAvailable: () => false, grokAvailable: () => true,
    grokSearch: async () => { throw new Error('403 credits exhausted'); },
    fetch: async () => new Response(body), now: () => '2026-11-15T12:00:00.000Z' });
  expect(result.externalStatus).toBe('verified');
  expect(result.external[0]?.collector).toBe('official-direct');
  expect(result.external[0]?.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  expect(result.neededDevices).toEqual(['firecrawl-key', 'omni-crawl-binary', 'grok-credits']);
});

test('failed Firecrawl tries Grok before direct and gives each provider a fresh signal', async () => {
  const calls: string[] = [];
  let firecrawlSignal: AbortSignal | undefined;
  let grokSignal: AbortSignal | undefined;
  const result = await groundDeploymentEnvironment(environment, {
    firecrawlAvailable: async () => true, omniCrawlAvailable: () => true,
    firecrawlScrape: async (_input, options) => {
      calls.push('firecrawl'); firecrawlSignal = options?.signal;
      throw new Error('Firecrawl unavailable');
    },
    grokAvailable: () => true,
    grokSearch: async (_input, options) => {
      calls.push('grok'); grokSignal = options?.signal;
      return { hits: [{ url: 'https://bun.sh/blog/bun-v1.4.2', title: 'Bun v1.4.2', snippet: '' }],
        providerName: 'grok', durationMs: 1 };
    },
    fetch: async () => { calls.push('official-fetch'); return new Response('Bun v1.4.2'); },
  });
  expect(calls).toEqual(['firecrawl', 'grok', 'official-fetch']);
  expect(firecrawlSignal).not.toBe(grokSignal);
  expect(result.external[0]?.collector).toBe('grok');
  expect(result.neededDevices).toContain('firecrawl-service');
});

test('private grounding receipt rejects missing, changed, and foreign run bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-grounding-'));
  try {
    const value = await groundDeploymentEnvironment(environment, { firecrawlAvailable: async () => false,
      grokAvailable: () => false, fetch: async () => new Response('Bun v1.4.2') });
    const receipt = writeGroundingReceipt(root, 'run-1', value);
    expect(readGroundingReceipt(root, 'run-1', receipt)).toEqual(value);
    const renewedValue = { ...value,
      external: value.external.map(source => ({ ...source, collectedAt: '2099-01-01T00:00:00Z' })) };
    const retry = writeGroundingReceipt(root, 'run-1', renewedValue);
    expect(retry.sha256).not.toBe(receipt.sha256);
    expect(readGroundingReceipt(root, 'run-1', retry)).toEqual(renewedValue);
    expect(() => readGroundingReceipt(root, 'run-1', receipt)).toThrow('BUILD_GROUNDING_RECEIPT_INVALID');
    expect(() => readGroundingReceipt(root, 'run-2', receipt)).toThrow('BUILD_GROUNDING_RECEIPT_INVALID');
    writeFileSync(receipt.path, readFileSync(receipt.path, 'utf8').replace('official-direct', 'grok'));
    expect(() => readGroundingReceipt(root, 'run-1', receipt)).toThrow('BUILD_GROUNDING_RECEIPT_INVALID');
    rmSync(receipt.path);
    expect(() => readGroundingReceipt(root, 'run-1', receipt)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retry never re-seals changed existing receipt bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-grounding-'));
  try {
    const value = await groundDeploymentEnvironment(environment, { firecrawlAvailable: async () => false,
      grokAvailable: () => false, fetch: async () => new Response('Bun v1.4.2') });
    const first = writeGroundingReceipt(root, 'run-1', value);
    const forged = { ...value, external: value.external.map(source => ({ ...source, collector: 'grok' as const })) };
    writeFileSync(first.path, JSON.stringify(forged, null, 2) + '\n');
    const renewed = writeGroundingReceipt(root, 'run-1', value);
    expect(renewed.sha256).toBe(first.sha256);
    expect(readGroundingReceipt(root, 'run-1', renewed)).toEqual(value);
    expect(readFileSync(first.path, 'utf8')).not.toContain('"collector": "grok"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
