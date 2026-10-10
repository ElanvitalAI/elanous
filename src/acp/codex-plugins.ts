// PLAN-codex-app-server-hermes-parity §5 Phase H2·1 (2026-05-16) —
// query codex app-server's `plugin/list` RPC and project the response
// into the minimal shape the BackendPickerChip sub-chips need. Mirror
// of Hermes hermes_cli/codex_runtime_plugin_migration.py:450
// (`_query_codex_plugins`) ported to TS.
//
// Response shape (codex 0.130.0):
//   { marketplaces: [{ name, plugins: [{ name, installed, availability, enabled }] }] }
// Filter:
//   installed === true && (availability === 'AVAILABLE' || availability missing)
// Output:
//   [{ name, marketplace, enabled }]
//
// Results are cached per client with a 5-minute TTL. Codex
// installations don't churn quickly and a BackendPickerChip re-render
// should not trigger a fresh RPC roundtrip every time.

import { spawnCodexAppServer, type CodexAppServerClient } from './codex-app-server-client.js';

export interface CodexPlugin {
  /** Plugin slug as reported by codex (e.g. "gmail", "google-calendar"). */
  name: string;
  /** Marketplace identifier (e.g. "openai-curated"). */
  marketplace: string;
  /** Whether codex has the plugin enabled. Defaults to true for installed
   *  plugins per Hermes parity. */
  enabled: boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  plugins: ReadonlyArray<CodexPlugin>;
}

const cache = new WeakMap<CodexAppServerClient, CacheEntry>();

export interface FetchCodexPluginsOpts {
  /** Override the clock for testing. Default `Date.now`. */
  now?: () => number;
  /** Skip the cache and force a fresh RPC. Default false. */
  noCache?: boolean;
}

/** Uncached inventory probe: distinguish no session / RPC failure from an empty installed list. */
export async function readCodexPluginsObservation(client: CodexAppServerClient | null | undefined): Promise<
  { status: 'ok'; plugins: ReadonlyArray<CodexPlugin> } | { status: 'unknown'; plugins: readonly [] }
> {
  if (!client) return { status: 'unknown', plugins: [] };
  try {
    const response = await client.request<Record<string, never>, unknown>('plugin/list', {});
    if (!isWellFormedPluginList(response)) return { status: 'unknown', plugins: [] };
    return { status: 'ok', plugins: parseCodexPluginsResponse(response) };
  } catch { return { status: 'unknown', plugins: [] }; }
}

/** Every marketplace and plugin row must have the shape the projector reads; a damaged or changed
 *  RPC response is unknown, never a confirmed empty install list. */
function isWellFormedPluginList(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const marketplaces = (response as { marketplaces?: unknown }).marketplaces;
  if (!Array.isArray(marketplaces)) return false;
  return marketplaces.every(market => !!market && typeof market === 'object'
    && typeof (market as { name?: unknown }).name === 'string' && (market as { name: string }).name.length > 0
    && Array.isArray((market as { plugins?: unknown }).plugins)
    && ((market as { plugins: unknown[] }).plugins).every(plugin => !!plugin && typeof plugin === 'object'
      && typeof (plugin as { name?: unknown }).name === 'string' && (plugin as { name: string }).name.length > 0));
}

export type CodexPluginObservation = Awaited<ReturnType<typeof readCodexPluginsObservation>>;

/** Isolated read-only RPC probe; always closes its own app-server process. */
export async function readCodexPluginsFromAppServer(
  spawn: typeof spawnCodexAppServer = spawnCodexAppServer,
): Promise<CodexPluginObservation> {
  let server: ReturnType<typeof spawnCodexAppServer>;
  try { server = spawn({ requestTimeoutMs: 5000 }); }
  catch { return { status: 'unknown', plugins: [] }; }
  try {
    await server.client.request('initialize', {
      clientInfo: { name: 'elanous', version: '0.x' }, capabilities: { experimentalApi: true },
    });
    return await readCodexPluginsObservation(server.client);
  } catch { return { status: 'unknown', plugins: [] }; }
  finally {
    try { await server.client.close(); }
    finally { server.child.kill(); }
  }
}

/** Query codex `plugin/list` and project the response into the
 *  BackendPickerChip-ready shape. Cached per client for 5 min.
 *  Returns [] for no client or RPC failure (stale cache when available). */
export async function fetchCodexPlugins(
  client: CodexAppServerClient | null | undefined,
  opts: FetchCodexPluginsOpts = {},
): Promise<ReadonlyArray<CodexPlugin>> {
  if (!client) return [];
  const now = opts.now ?? Date.now;
  const t = now();
  if (!opts.noCache) {
    const cached = cache.get(client);
    if (cached && cached.expiresAt > t) return cached.plugins;
  }
  let resp: unknown;
  try {
    resp = await client.request<Record<string, never>, unknown>('plugin/list', {});
  } catch {
    const cached = cache.get(client);
    return cached?.plugins ?? [];
  }
  const plugins = parseCodexPluginsResponse(resp);
  cache.set(client, { expiresAt: t + CACHE_TTL_MS, plugins });
  return plugins;
}

/** Pure projector — exported for unit tests so we can assert the
 *  filter logic without touching the RPC client. */
export function parseCodexPluginsResponse(
  resp: unknown,
): ReadonlyArray<CodexPlugin> {
  if (!resp || typeof resp !== 'object') return [];
  const marketplaces = (resp as { marketplaces?: unknown }).marketplaces;
  if (!Array.isArray(marketplaces)) return [];
  const seen = new Set<string>();
  const out: CodexPlugin[] = [];
  for (const m of marketplaces) {
    if (!m || typeof m !== 'object') continue;
    const market = m as Record<string, unknown>;
    const marketName =
      typeof market.name === 'string' && market.name.length > 0
        ? market.name
        : 'openai-curated';
    const plugins = market.plugins;
    if (!Array.isArray(plugins)) continue;
    for (const raw of plugins) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      if (p.installed !== true) continue;
      const availabilityRaw =
        typeof p.availability === 'string' ? p.availability : '';
      const availability = availabilityRaw.toUpperCase();
      if (availability.length > 0 && availability !== 'AVAILABLE') continue;
      const name = typeof p.name === 'string' ? p.name : '';
      if (name.length === 0) continue;
      const key = `${name}@${marketName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        marketplace: marketName,
        enabled: p.enabled !== false,
      });
    }
  }
  return out;
}

/** Test helper — drop the cache entry for a specific client. */
export function clearCodexPluginsCache(client: CodexAppServerClient): void {
  cache.delete(client);
}
