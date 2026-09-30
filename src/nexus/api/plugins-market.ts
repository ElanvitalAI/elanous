import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug } from '../../debug/log.js';
import { OFFICIAL_INDEX_KEYS } from '../../market/official-keys.js';
import { verifyIndex, type MarketplaceIndex } from '../../market/signed-index.js';
import { installPlugin, listInstalledPlugins, removePlugin, type InstallEvent } from '../../plugins/install/plugin-install.js';
import { updateMarket, type MarketFetchOptions } from '../../plugins/install/market-fetch.js';
import { userConfigPath } from '../../user-config.js';
import { jsonResponse } from './json-response.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';

export type MarketSignature = 'ok' | 'missing' | 'unknown-key' | 'malformed' | 'stale';
export interface MarketPlugin {
  name: string;
  version: string;
  description?: string;
  category?: string;
  capabilities: string[];
  connectors: Array<{ id: string; kind: string; userConfig: Array<{ key: string; label: string; secret: boolean }> }>;
  graphs?: string[];
  pricing: MarketplaceIndex['plugins'][number]['ai.elanous']['pricing'];
  sha256: string;
}
export interface MarketIndexResponse {
  markets: Array<{ name: string; signature: MarketSignature; detail?: string; plugins: MarketPlugin[] }>;
}

function projectPlugins(index: unknown, market: string): MarketPlugin[] {
  if (!index || typeof index !== 'object') return [];
  const value = index as Partial<MarketplaceIndex>;
  if (value.name !== market || !Array.isArray(value.plugins)) return [];
  return value.plugins.flatMap((plugin): MarketPlugin[] => {
    if (!plugin || typeof plugin.name !== 'string' || typeof plugin.version !== 'string' ||
      typeof plugin.artifact?.sha256 !== 'string' || !plugin['ai.elanous'] ||
      !Array.isArray(plugin['ai.elanous'].capabilities) || !Array.isArray(plugin['ai.elanous'].connectors) ||
      !plugin['ai.elanous'].pricing || typeof plugin['ai.elanous'].pricing.model !== 'string') return [];
    const ai = plugin['ai.elanous'];
    return [{
      name: plugin.name, version: plugin.version,
      ...(typeof plugin.description === 'string' ? { description: plugin.description } : {}),
      ...(typeof plugin.category === 'string' ? { category: plugin.category } : {}),
      capabilities: ai.capabilities.filter((item): item is string => typeof item === 'string'),
      connectors: ai.connectors.flatMap(connector => {
        if (!connector || typeof connector.id !== 'string' || typeof connector.kind !== 'string' || !Array.isArray(connector.userConfig)) return [];
        return [{ id: connector.id, kind: connector.kind, userConfig: connector.userConfig.flatMap(field =>
          field && typeof field.key === 'string' && typeof field.label === 'string' && typeof field.secret === 'boolean'
            ? [{ key: field.key, label: field.label, secret: field.secret }] : []) }];
      }),
      ...(Array.isArray(ai.graphs) ? { graphs: ai.graphs.filter((item): item is string => typeof item === 'string') } : {}),
      pricing: {
        model: ai.pricing.model,
        ...(typeof ai.pricing.amount === 'number' ? { amount: ai.pricing.amount } : {}),
        ...(typeof ai.pricing.currency === 'string' ? { currency: ai.pricing.currency } : {}),
        ...(typeof ai.pricing.period === 'string' ? { period: ai.pricing.period } : {}),
      },
      sha256: plugin.artifact.sha256,
    }];
  });
}

export function readMarketIndex(root = elanousStateRoot(), trustedKeys: ReadonlyArray<{ keyId: string; publicKey: string }> = []): MarketIndexResponse {
  const base = join(root, 'markets');
  const markets: MarketIndexResponse['markets'] = [];
  if (existsSync(base)) for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    const indexPath = [join(dir, 'marketplace.json'), join(dir, '.agents', 'plugins', 'marketplace.json')].find(existsSync);
    if (!indexPath) {
      markets.push({ name: entry.name, signature: 'malformed', detail: '마켓 인덱스를 찾지 못했습니다.', plugins: [] });
      continue;
    }
    let signature: MarketSignature = 'missing';
    let detail: string | undefined;
    let index: unknown;
    try {
      const bytes = readFileSync(indexPath);
      const signaturePath = join(dirname(indexPath), 'index.sig');
      if (existsSync(signaturePath)) {
        const checked = verifyIndex({ marketplaceBytes: bytes, signatureText: readFileSync(signaturePath, 'utf8'), trustedKeys: [...OFFICIAL_INDEX_KEYS, ...trustedKeys] });
        if (checked.ok) { signature = 'ok'; index = checked.index; }
        else {
          signature = checked.reason === 'unknown-key' ? 'unknown-key' : checked.reason === 'malformed' ? 'malformed' : 'stale';
          detail = checked.detail;
        }
      }
      if (!index) index = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      signature = 'malformed';
      detail = 'marketplace.json or index.sig could not be read';
    }
    const plugins = projectPlugins(index, entry.name);
    if (!index || !Array.isArray((index as MarketplaceIndex).plugins) || (index as MarketplaceIndex).name !== entry.name) {
      signature = 'malformed';
      detail = 'marketplace.json: invalid market index';
    }
    markets.push({ name: entry.name, signature, ...(detail ? { detail: '마켓 인덱스를 확인하지 못했습니다.' } : {}), plugins });
  }
  markets.sort((a, b) => a.name.localeCompare(b.name));
  debug.log('nexus.plugins-market', 'index', { markets: markets.length, ok: markets.filter(m => m.signature === 'ok').length, notOk: markets.filter(m => m.signature !== 'ok').length });
  return { markets };
}

function configuredTrustedKeys(path = userConfigPath()): Array<{ keyId: string; publicKey: string }> {
  try {
    const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
    const market = (config as Record<string, unknown>).market;
    if (!market || typeof market !== 'object' || Array.isArray(market)) return [];
    const keys = (market as Record<string, unknown>).trustedKeys;
    if (!Array.isArray(keys)) return [];
    return keys.filter((key): key is { keyId: string; publicKey: string } =>
      key !== null && typeof key === 'object' && !Array.isArray(key) &&
      typeof key.keyId === 'string' && typeof key.publicKey === 'string');
  } catch { return []; }
}

export function handlePluginsIndexGet(req: Request, opts: MetaApiOpts, root?: string, configPath?: string): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  return jsonResponse(readMarketIndex(root, configuredTrustedKeys(configPath)));
}

export function handlePluginsGet(req: Request, opts: MetaApiOpts, root?: string): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  return jsonResponse(listInstalledPlugins(root));
}

const MARKET_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MARKET_SPEC = /^[a-z0-9][a-z0-9-]{1,39}@[a-z0-9][a-z0-9-]{1,39}$/;

/** 실패 원인 한 줄 — 사용자가 «왜» 를 볼 수 있게(2026-09-29 실물: «설치 중 오류가 발생했습니다» 만 보여 아티팩트 누락을 못 봤다). 홈 경로는 `~` 로 · 200자 · 한 줄. */
export function safeDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  if (!message) return undefined;
  return message.replace(/\/(?:Users|home)\/[^/\s]+/g, '~').replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
}

function safeReason(error: unknown): string {
  const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : undefined;
  return typeof reason === 'string' && ['signature', 'scan', 'consent-denied', 'credentials', 'conflict', 'io'].includes(reason)
    ? reason : 'io';
}

export async function handlePluginsMarketRefresh(req: Request, name: string, opts: MetaApiOpts, fetchOptions: MarketFetchOptions = {}): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!MARKET_NAME.test(name)) return jsonResponse({ ok: false, reason: 'invalid-market' }, 400);
  try {
    const result = await updateMarket(name, fetchOptions);
    const plugins = projectPlugins(result.index, name);
    debug.log('nexus.plugins-market', 'refresh', { name, ok: true, count: plugins.length });
    return jsonResponse({ ok: true, plugins });
  } catch (error) {
    const reason = safeReason(error);
    debug.log('nexus.plugins-market', 'refresh', { name, ok: false, reason });
    return jsonResponse({ ok: false, reason });
  }
}

export async function handlePluginsInstall(req: Request, opts: MetaApiOpts, root?: string, configPath?: string): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'bad_request' }, 400); }
  const input = body as { spec?: unknown; acceptedCapabilities?: unknown } | null;
  if (!input || typeof input.spec !== 'string' || !MARKET_SPEC.test(input.spec) ||
    !Array.isArray(input.acceptedCapabilities) || !input.acceptedCapabilities.every(cap => typeof cap === 'string')) {
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  const spec = input.spec;
  const accepted = new Set(input.acceptedCapabilities as string[]);
  const trustedKeys = configuredTrustedKeys(configPath);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (value: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      const onEvent = (event: InstallEvent) => {
        if (event.event === 'consent') send({ event: 'consent', capabilities: event.capabilities, required: event.required });
        else if (event.event === 'credentials') send({ event: 'credentials', required: event.connectors.some(c => c.fields.length > 0) });
        else send({ event: event.event });
      };
      try {
        await installPlugin(spec, {
          ...(root ? { root } : {}), trustedKeys: [...OFFICIAL_INDEX_KEYS, ...trustedKeys],
          onEvent, consent: capabilities => capabilities.every(cap => accepted.has(cap)),
        });
        debug.log('nexus.plugins-market', 'install', { spec, ok: true });
      } catch (error) {
        const reason = safeReason(error);
        const detail = safeDetail(error);
        debug.log('nexus.plugins-market', 'install', { spec, ok: false, reason, ...(detail ? { detail } : {}) });
        send({ event: 'failed', reason, ...(detail ? { detail } : {}) });
      } finally { controller.close(); }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
}

export function handlePluginsRemove(req: Request, name: string, opts: MetaApiOpts, root?: string): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!MARKET_NAME.test(name)) return jsonResponse({ error: 'bad_request' }, 400);
  try {
    const removed = removePlugin(name, root);
    debug.log('nexus.plugins-market', 'remove', { name, removed });
    return jsonResponse({ removed });
  } catch (error) {
    const reason = safeReason(error);
    debug.log('nexus.plugins-market', 'remove', { name, reason });
    return jsonResponse({ error: reason }, 500);
  }
}
