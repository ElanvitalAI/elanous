import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug } from '../../debug/log.js';
import { OFFICIAL_INDEX_KEYS } from '../../market/official-keys.js';
import { verifyIndex, type MarketplaceIndex } from '../../market/signed-index.js';
import { listInstalledPlugins } from '../../plugins/install/plugin-install.js';
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
      markets.push({ name: entry.name, signature: 'malformed', detail: 'marketplace.json: not found', plugins: [] });
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
    markets.push({ name: entry.name, signature, ...(detail ? { detail } : {}), plugins });
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
