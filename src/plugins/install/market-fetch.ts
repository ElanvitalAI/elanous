import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { withFileLockSync } from '../../storage/file-lock.js';
import { dirname, join, resolve } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { userConfigPath } from '../../user-config.js';
import { OFFICIAL_INDEX_KEYS } from '../../market/official-keys.js';
import { verifyIndex, type MarketplaceIndex } from '../../market/signed-index.js';

// Official marketplace (🅞 #21756 · GitHub Pages of ElanvitalAI/elanous-plugins). 🩸 09-29: this was `elanous.pages.dev`,
// which does not resolve — every `<name>@elanous` install would have failed. Measured: marketplace.json ⊕ index.sig = 200.
export const ELANOUS_MARKET_URL = 'https://elanvitalai.github.io/elanous-plugins/';
const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;

export interface MarketConfig { name: string; url: string }
export interface MarketFetchOptions {
  root?: string;
  marketDir?: string;
  configPath?: string;
  fetcher?: typeof fetch;
  verifySignature?: typeof verifyIndex;
  trustedKeys?: ReadonlyArray<{ keyId: string; publicKey: string }>;
  refresh?: boolean;
}
export interface MarketIndex {
  market: MarketConfig;
  index: MarketplaceIndex;
  directory: string;
  signature: 'ok';
  keyId: string;
}
export class MarketFetchError extends Error {
  constructor(public readonly reason: 'io' | 'signature', message: string) {
    super(message);
    this.name = 'MarketFetchError';
  }
}

function configPath(opts: MarketFetchOptions): string { return opts.configPath ?? userConfigPath(); }
function config(opts: MarketFetchOptions): Record<string, unknown> {
  const path = configPath(opts);
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* reported below */ }
  throw new MarketFetchError('io', 'invalid user market configuration');
}
function marketSettings(value: Record<string, unknown>): Record<string, unknown> {
  const settings = value.market;
  if (settings === undefined) return {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new MarketFetchError('io', 'invalid market configuration');
  return settings as Record<string, unknown>;
}
function marketUrl(value: unknown): string {
  if (typeof value !== 'string') throw new MarketFetchError('io', 'invalid market URL: expected HTTPS URL');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname) throw new Error('unsafe URL');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch { throw new MarketFetchError('io', 'invalid market URL: expected HTTPS URL without credentials, query or fragment'); }
}
function configuredMarkets(settings: Record<string, unknown>): MarketConfig[] {
  const entries = settings.markets;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new MarketFetchError('io', 'invalid market configuration: markets must be an array');
  const names = new Set(['elanous']);
  return entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new MarketFetchError('io', 'invalid market configuration: expected name and url');
    const { name, url } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME.test(name) || names.has(name)) throw new MarketFetchError('io', `invalid or duplicate market name: ${String(name)}`);
    names.add(name);
    return { name, url: marketUrl(url) };
  });
}
function trust(settings: Record<string, unknown>, opts: MarketFetchOptions): ReadonlyArray<{ keyId: string; publicKey: string }> {
  const additional = settings.trustedKeys;
  if (additional !== undefined && (!Array.isArray(additional) || !additional.every(key => key && typeof key.keyId === 'string' && typeof key.publicKey === 'string'))) {
    throw new MarketFetchError('io', 'invalid trusted keys configuration');
  }
  // A configured key cannot replace an official key with the same identifier.
  const keys = new Map(OFFICIAL_INDEX_KEYS.map(key => [key.keyId, key]));
  for (const key of [...(additional ?? []), ...(opts.trustedKeys ?? [])] as Array<{ keyId: string; publicKey: string }>) {
    if (keys.has(key.keyId) && keys.get(key.keyId)?.publicKey !== key.publicKey) throw new MarketFetchError('io', `conflicting trusted key: ${key.keyId}`);
    keys.set(key.keyId, key);
  }
  return [...keys.values()];
}

export function listMarkets(opts: MarketFetchOptions = {}): MarketConfig[] {
  return [{ name: 'elanous', url: ELANOUS_MARKET_URL }, ...configuredMarkets(marketSettings(config(opts)))];
}

export function addMarket(name: string, url: string, opts: MarketFetchOptions = {}): MarketConfig {
  if (!NAME.test(name) || name === 'elanous') throw new MarketFetchError('io', `invalid market name: ${name}`);
  const market = { name, url: marketUrl(url) };
  const value = config(opts);
  const settings = marketSettings(value);
  if (configuredMarkets(settings).some(existing => existing.name === name)) throw new MarketFetchError('io', `market already exists: ${name}`);
  const path = configPath(opts);
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temp, JSON.stringify({ ...value, market: { ...settings, markets: [...configuredMarkets(settings), market] } }, null, 2));
    // Keep the original permission bits (a config holding secrets is often 0600); a new file starts private.
    chmodSync(temp, existsSync(path) ? statSync(path).mode & 0o777 : 0o600);
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
  return market;
}

function location(name: string, opts: MarketFetchOptions): string {
  return join(resolve(opts.marketDir ?? join(opts.root ?? elanousStateRoot(), 'markets')), name);
}

interface CacheState { url: string; lastSequence: number; indexHash: string; signatureHash: string }

function cacheState(path: string): CacheState | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new MarketFetchError('io', 'invalid market cache state'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MarketFetchError('io', 'invalid market cache state');
  const { url, lastSequence, indexHash, signatureHash } = value as Record<string, unknown>;
  if (typeof url !== 'string' || !Number.isSafeInteger(lastSequence) || (lastSequence as number) < 0
    || typeof indexHash !== 'string' || !/^[a-f0-9]{64}$/.test(indexHash)
    || typeof signatureHash !== 'string' || !/^[a-f0-9]{64}$/.test(signatureHash)) {
    throw new MarketFetchError('io', 'invalid market cache state');
  }
  return { url, lastSequence: lastSequence as number, indexHash, signatureHash };
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checked(bytes: Uint8Array, signatureText: string, name: string, keys: ReturnType<typeof trust>, opts: MarketFetchOptions, lastSequence?: number): { index: MarketplaceIndex; keyId: string } {
  const result = (opts.verifySignature ?? verifyIndex)({ marketplaceBytes: bytes, signatureText, trustedKeys: keys, lastSequence });
  if (!result.ok) throw new MarketFetchError('signature', `${result.reason}: ${result.detail}`);
  if (result.index.name !== name) throw new MarketFetchError('io', `market index name mismatch: ${name}`);
  return { index: result.index, keyId: result.keyId };
}

// Serialize cache reads, verification and publication for callers sharing a market directory.
const marketIndexQueues = new Map<string, Promise<void>>();

export function ensureMarketIndex(name: string, opts: MarketFetchOptions = {}): Promise<MarketIndex> {
  const directory = location(name, opts);
  const previous = marketIndexQueues.get(directory) ?? Promise.resolve();
  const result = previous.then(() => fetchMarketIndex(name, opts));
  const tail = result.then(() => {}, () => {});
  marketIndexQueues.set(directory, tail);
  void tail.then(() => {
    if (marketIndexQueues.get(directory) === tail) marketIndexQueues.delete(directory);
  });
  return result;
}

async function fetchMarketIndex(name: string, opts: MarketFetchOptions): Promise<MarketIndex> {
  const market = listMarkets(opts).find(entry => entry.name === name);
  if (!market) throw new MarketFetchError('io', `market not configured: ${name}`);
  const keys = trust(marketSettings(config(opts)), opts);
  const directory = location(name, opts);
  const indexFile = join(directory, 'marketplace.json');
  const sigFile = join(directory, 'index.sig');
  const stateFile = join(directory, 'cache-state.json');
  const state = cacheState(stateFile);
  // The URL is part of the cache identity, not just the market name.
  const lastSequence = state?.url === market.url ? state.lastSequence : undefined;
  let cached: ReturnType<typeof checked> | undefined;
  if (state?.url === market.url && existsSync(indexFile) && existsSync(sigFile)) {
    const indexBytes = readFileSync(indexFile);
    const signatureText = readFileSync(sigFile, 'utf8');
    if (digest(indexBytes) === state.indexHash && digest(signatureText) === state.signatureHash) {
      try {
        cached = checked(indexBytes, signatureText, name, keys, opts, lastSequence);
      } catch (error) {
        if (!(error instanceof MarketFetchError)) throw error;
      }
    }
    if (cached && !opts.refresh) return { market, directory, signature: 'ok', ...cached };
  }
  const fetcher = opts.fetcher ?? fetch;
  const load = async (file: string): Promise<Uint8Array> => {
    const url = new URL(file, market.url);
    let response: Response;
    try { response = await fetcher(url.href, { redirect: 'error' }); }
    catch { throw new MarketFetchError('io', `market fetch failed (${file}): network error`); }
    if (!response.ok) throw new MarketFetchError('io', `market fetch failed (${file}): HTTP ${response.status}`);
    if (response.redirected || (response.url && response.url !== url.href)) throw new MarketFetchError('io', `market fetch was redirected (${file})`);
    if (!response.body) throw new MarketFetchError('io', `market fetch failed (${file}): missing response body`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_INDEX_BYTES) throw new MarketFetchError('io', `market file too large: ${file}`);
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof MarketFetchError) throw error;
      throw new MarketFetchError('io', `market fetch failed (${file}): network error`);
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  };
  const bytes = await load('marketplace.json');
  const signature = new TextDecoder('utf-8', { fatal: true }).decode(await load('index.sig'));
  const verified = checked(bytes, signature, name, keys, opts, lastSequence);
  mkdirSync(directory, { recursive: true });
  // Cross-process: another CLI may have published a newer index since we read cache-state. Re-check the high-water
  // mark under a file lock right before publishing, so a slower process cannot roll the cache back (review R3).
  return withFileLockSync(join(directory, '.publish.lock'), () => {
  const current = cacheState(stateFile);
  if (current?.url === market.url && current.lastSequence !== undefined && current.lastSequence > verified.index.sequence) {
    throw new MarketFetchError('signature', `market index rollback refused: ${name} sequence ${verified.index.sequence} < ${current.lastSequence}`);
  }
  const staging = mkdtempSync(join(directory, '.index-'));
  try {
    const tempIndex = join(staging, 'marketplace.json');
    const tempSig = join(staging, 'index.sig');
    const tempState = join(staging, 'cache-state.json');
    writeFileSync(tempIndex, bytes);
    writeFileSync(tempSig, signature);
    writeFileSync(tempState, JSON.stringify({ url: market.url, lastSequence: verified.index.sequence, indexHash: digest(bytes), signatureHash: digest(signature) } satisfies CacheState));
    // Commit the verified high-water mark before replacing either cache file.
    // An interrupted publication then cannot roll back a previously verified index.
    renameSync(tempState, stateFile);
    renameSync(tempIndex, indexFile);
    renameSync(tempSig, sigFile);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { market, directory, signature: 'ok', ...verified } as MarketIndex;
  });
}

export async function updateMarket(name: string, opts: MarketFetchOptions = {}): Promise<MarketIndex> {
  return ensureMarketIndex(name, { ...opts, refresh: true });
}
