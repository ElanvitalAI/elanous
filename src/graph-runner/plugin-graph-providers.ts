import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDefaultMarketDataRegistry } from './capability-providers/market-data/registry.js';
import type { GraphCapabilityRegistry } from './capabilities.js';

/** One manifest-declared production provider loader shared by graph CLI and TUI. */
export async function defaultCapabilityRegistryForGraph(file: string, graphRoot?: string): Promise<GraphCapabilityRegistry> {
  const graphPath = resolve(file);
  const graphDir = dirname(graphPath);
  const pluginRoot = existsSync(join(graphDir, 'plugin.json')) ? graphDir : resolve(graphDir, '..');
  const manifestPath = join(pluginRoot, 'plugin.json');
  if (!existsSync(manifestPath)) return createDefaultMarketDataRegistry();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { extensions?: { 'ai.elanous'?: {
    graphs?: string[]; graphProviders?: Record<string, { module: string; factory: string; withPluginRoot?: boolean; withGraphRoot?: boolean }> } } };
  const extension = manifest.extensions?.['ai.elanous'];
  const relativeGraph = relative(pluginRoot, graphPath).split(sep).join('/').replace(/^\.\//, '');
  const declaredGraphs = (extension?.graphs ?? []).map(graph => graph.replace(/^\.\//, ''));
  if (!declaredGraphs.includes(relativeGraph)) return createDefaultMarketDataRegistry();
  const declaration = extension?.graphProviders?.[relativeGraph] ?? extension?.graphProviders?.[`./${relativeGraph}`];
  if (!declaration) return createDefaultMarketDataRegistry();
  const modulePath = realpathSync(resolve(import.meta.dir, '../..', declaration.module));
  const providerRoot = realpathSync(resolve(import.meta.dir, '.'));
  if (!modulePath.startsWith(providerRoot + '/')) throw new Error('plugin graph provider must use the shared graph runner');
  const module = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
  const factory = module[declaration.factory];
  if (typeof factory !== 'function') throw new Error(`plugin graph provider factory missing: ${declaration.factory}`);
  return declaration.withGraphRoot ? factory(graphRoot) : declaration.withPluginRoot ? factory(pluginRoot) : factory();
}
