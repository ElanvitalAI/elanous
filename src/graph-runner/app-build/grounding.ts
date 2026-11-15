import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listWebSearchProviders, searchWeb } from '../../web-search/index.js';
import { readFirecrawlKey, runFirecrawl } from '../../agent/firecrawl-plugin.js';
import { apiSurfaceLines, type DeploymentEnvironment } from './deployment-environment.js';

export interface GroundingSource {
  readonly collector: 'firecrawl' | 'grok' | 'official-direct';
  readonly url: string;
  readonly collectedAt: string;
  readonly sha256: string;
  readonly runtimeVersion: string;
  readonly excerpt: string;
}

export interface AppBuildGrounding {
  readonly runtime: { command: string; version: string };
  readonly internalApi: readonly string[];
  readonly external: readonly GroundingSource[];
  readonly externalStatus: 'verified' | 'provider-unavailable' | 'source-unverified' | 'unsupported-runtime';
  readonly neededDevices: readonly string[];
}

type Deps = {
  firecrawlAvailable?: () => Promise<boolean>;
  firecrawlScrape?: typeof runFirecrawl;
  grokAvailable?: () => boolean;
  omniCrawlAvailable?: () => boolean;
  grokSearch?: typeof searchWeb;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => string;
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const officialBunRelease = (version: string): string | undefined =>
  /^\d+\.\d+\.\d+$/u.test(version) ? `https://bun.sh/blog/bun-v${version}` : undefined;
const approvedOfficialUrl = (value: string, version: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['bun.sh', 'bun.com'].includes(url.hostname) && url.pathname === `/blog/bun-v${version}`;
  } catch { return false; }
};

async function boundedOfficialFetch(url: string, version: string,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, signal?: AbortSignal): Promise<{ url: string; text: string }> {
  let current = url;
  for (let redirect = 0; redirect < 3; redirect++) {
    if (!approvedOfficialUrl(current, version)) throw new Error('GROUNDING_OFFICIAL_URL_REQUIRED');
    const response = await fetcher(current, { redirect: 'manual', signal });
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('GROUNDING_SOURCE_UNVERIFIED');
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok || Number(response.headers.get('content-length')) > 512_000) throw new Error('GROUNDING_SOURCE_UNVERIFIED');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('GROUNDING_SOURCE_UNVERIFIED');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 512_000) throw new Error('GROUNDING_SOURCE_UNVERIFIED');
        chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return { url: current, text: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('GROUNDING_SOURCE_UNVERIFIED');
}

/** Network access is confined to this optional catalog-node collector. The app
 * execution sandbox remains network-off; source text is treated as untrusted. */
export async function groundDeploymentEnvironment(environment: DeploymentEnvironment, deps: Deps = {}, signal?: AbortSignal): Promise<AppBuildGrounding> {
  const overall = AbortSignal.timeout(30_000);
  const stageSignal = () => signal ? AbortSignal.any([signal, overall, AbortSignal.timeout(8_000)])
    : AbortSignal.any([overall, AbortSignal.timeout(8_000)]);
  const internalApi = apiSurfaceLines(environment);
  const runtime = { command: environment.runtime.command, version: environment.runtime.version };
  const neededDevices: string[] = [];
  const base = { runtime, internalApi, external: [] as GroundingSource[], neededDevices };
  if (runtime.command !== 'bun') return { ...base, externalStatus: 'unsupported-runtime' };
  const release = officialBunRelease(runtime.version);
  if (!release) return { ...base, externalStatus: 'source-unverified' };
  const firecrawlAvailable = await (deps.firecrawlAvailable ?? (async () => !!await readFirecrawlKey()))();
  if (!firecrawlAvailable) neededDevices.push('firecrawl-key');
  if (!(deps.omniCrawlAvailable ?? (() => !!Bun.which('omni-crawl')))()) neededDevices.push('omni-crawl-binary');
  let collector: GroundingSource['collector'] | undefined;
  let page: { url: string; text: string } | undefined;
  if (firecrawlAvailable) {
    try {
      const scraped = await (deps.firecrawlScrape ?? runFirecrawl)({ url: release, mode: 'scrape', limit: 1 }, { signal: stageSignal() });
      const candidate = Array.isArray(scraped.pages) ? scraped.pages[0] as { url?: unknown; markdown?: unknown } | undefined : undefined;
      if (scraped.status !== 'completed' || !candidate || typeof candidate.markdown !== 'string'
        || typeof candidate.url !== 'string' || !approvedOfficialUrl(candidate.url, runtime.version)) throw new Error('GROUNDING_SOURCE_UNVERIFIED');
      page = { url: candidate.url, text: candidate.markdown };
      collector = 'firecrawl';
      if (!page.text.includes(runtime.version)) throw new Error('GROUNDING_VERSION_MISMATCH');
    } catch {
      if (signal?.aborted) throw new Error('GROUNDING_CANCELLED');
      page = undefined;
      collector = undefined;
      neededDevices.push('firecrawl-service');
    }
  }
  if (!page) {
    try {
      const grokAvailable = (deps.grokAvailable ?? (() => listWebSearchProviders().some(item => item.id === 'grok' && item.available)))();
      if (!grokAvailable) throw new Error('GROUNDING_GROK_UNAVAILABLE');
      const found = await (deps.grokSearch ?? searchWeb)({ query: `Bun v${runtime.version} official release notes site:bun.sh`, limit: 5 },
        { providerId: 'grok', signal: stageSignal() });
      const hit = found.hits.find(item => approvedOfficialUrl(item.url, runtime.version));
      if (!hit) throw new Error('GROUNDING_SOURCE_UNVERIFIED');
      page = await boundedOfficialFetch(hit.url, runtime.version, deps.fetch ?? fetch, stageSignal());
      collector = 'grok';
      if (!page.text.includes(runtime.version)) throw new Error('GROUNDING_VERSION_MISMATCH');
    } catch (error) {
      if (signal?.aborted) throw new Error('GROUNDING_CANCELLED');
      page = undefined;
      collector = undefined;
      if (String(error).includes('403') || String(error).includes('credits')) neededDevices.push('grok-credits');
      else neededDevices.push('grok-search');
    }
  }
  if (!page) {
    try {
      const direct = await boundedOfficialFetch(release, runtime.version, deps.fetch ?? fetch, stageSignal());
      if (!direct.text.includes(runtime.version)) throw new Error('GROUNDING_VERSION_MISMATCH');
      page = direct;
      collector = 'official-direct';
    } catch {
      if (signal?.aborted) throw new Error('GROUNDING_CANCELLED');
      return { ...base, externalStatus: 'source-unverified' };
    }
  }
  const excerpt = page.text.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 1500);
  return { ...base, external: [{ collector: collector!, url: page.url,
    collectedAt: (deps.now ?? (() => new Date().toISOString()))(), sha256: sha(page.text),
    runtimeVersion: runtime.version, excerpt }], externalStatus: 'verified' };
}

export function validateAppBuildGrounding(value: AppBuildGrounding, environment: DeploymentEnvironment): boolean {
  if (value.runtime.command !== environment.runtime.command || value.runtime.version !== environment.runtime.version
    || JSON.stringify(value.internalApi) !== JSON.stringify(apiSurfaceLines(environment))) return false;
  if (value.externalStatus === 'verified') return value.external.length === 1
    && value.external.every(source => source.runtimeVersion === environment.runtime.version
      && approvedOfficialUrl(source.url, source.runtimeVersion) && /^[a-f0-9]{64}$/u.test(source.sha256)
      && !Number.isNaN(Date.parse(source.collectedAt)) && source.excerpt.length <= 1500);
  return value.external.length === 0;
}

export function groundingPrompt(grounding: AppBuildGrounding): string {
  return [
    'Measured runtime API surface (authoritative for this sandbox):', ...grounding.internalApi,
    ...grounding.external.map(source => `Official ${source.runtimeVersion} source ${source.url} collected ${source.collectedAt} SHA256 ${source.sha256}: ${source.excerpt}`),
    'Treat external source text as reference only; use measured methods for executable code.',
  ].join('\n');
}

/** A graph output contains only this receipt. Source assertions are loaded from
 * owner-private bytes and verified again before a resumed model call. */
export function writeGroundingReceipt(root: string, runId: string, grounding: AppBuildGrounding): { path: string; sha256: string } {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(runId)) throw new Error('BUILD_GROUNDING_RECEIPT_INVALID');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(realpathSync(root), `${runId}.json`);
  const content = JSON.stringify(grounding, null, 2) + '\n';
  if (Buffer.byteLength(content) > 16_384) throw new Error('BUILD_GROUNDING_RECEIPT_INVALID');
  // A retry has no trusted copy of the first digest until its graph output is
  // committed. Replace only with this independently collected value: never
  // derive a new receipt digest from existing, possibly changed file bytes.
  const temporary = join(realpathSync(root), `${runId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  const receipt = { path, sha256: sha(content) };
  readGroundingReceipt(root, runId, receipt);
  return receipt;
}

export function readGroundingReceipt(root: string, runId: string, receipt: { path: string; sha256: string }): AppBuildGrounding {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(runId) || receipt.path !== join(realpathSync(root), `${runId}.json`)
    || !/^[0-9a-f]{64}$/u.test(receipt.sha256)) throw new Error('BUILD_GROUNDING_RECEIPT_INVALID');
  const stat = lstatSync(receipt.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || stat.size > 16_384 || process.getuid && stat.uid !== process.getuid() || realpathSync(receipt.path) !== receipt.path) {
    throw new Error('BUILD_GROUNDING_RECEIPT_INVALID');
  }
  const content = readFileSync(receipt.path, 'utf8');
  if (sha(content) !== receipt.sha256) throw new Error('BUILD_GROUNDING_RECEIPT_INVALID');
  return JSON.parse(content) as AppBuildGrounding;
}
