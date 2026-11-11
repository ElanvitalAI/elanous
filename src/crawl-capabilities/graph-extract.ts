import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGraph } from '../graph-runner/runner.js';
import { createCrawlGraphRegistry } from './graph-registry.js';
import { CRAWL_PROVIDERS, type CrawlProvider } from './contracts.js';
import type { ExtractedScrap, UrlScrap } from './scrap-extract.js';

const graphPath = fileURLToPath(new URL('../../graphs/apps/lecture-scrap-extract.yaml', import.meta.url));
export interface CrawlContractAttempt { provider: string; reason: string }
export class CrawlContractExhaustedError extends Error {
  readonly contractId = 'extract.structured@1';
  constructor(readonly attempts: readonly CrawlContractAttempt[]) {
    super(`crawl contract extract.structured@1 exhausted: ${attempts.map(item => `${item.provider}:${item.reason}`).join(', ') || 'no eligible provider'}`);
    this.name = 'CrawlContractExhaustedError';
  }
}

/** The KAIST app action enters ABSORB-1's `requires` node with the registered crawl adapters. */
export async function extractScrapViaGraph(scrap: UrlScrap, options: { providers?: readonly CrawlProvider[] } = {}): Promise<ExtractedScrap> {
  const url = new URL(scrap.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('scrap URL must use HTTP or HTTPS');
  const root = mkdtempSync(join(tmpdir(), 'kaist-scrap-extract-'));
  try {
    const state = await runGraph(graphPath, { input: { url: url.href }, quiet: true,
      deps: { root, capabilityProviders: createCrawlGraphRegistry(options.providers ?? CRAWL_PROVIDERS) } });
    const output = state.nodes.find(node => node.nodeId === 'extract')?.output;
    const parsed = typeof output === 'string' ? JSON.parse(output) as {
      result?: Partial<ExtractedScrap>; error?: string; evidence?: { contractId?: string; attempts?: CrawlContractAttempt[] };
    } : {};
    if ((parsed.error === 'contract-exhausted' && parsed.evidence?.contractId === 'extract.structured@1')
      || parsed.error === 'unprovided')
      throw new CrawlContractExhaustedError(parsed.evidence?.attempts ?? []);
    const result = parsed.result;
    if (state.status !== 'done' || !result || typeof result.url !== 'string' || typeof result.title !== 'string'
      || typeof result.excerpt !== 'string' || typeof result.content !== 'string' || typeof result.provider !== 'string'
      || !result.content.trim()) throw new Error('crawl contract extract.structured@1 failed');
    return result as ExtractedScrap;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
