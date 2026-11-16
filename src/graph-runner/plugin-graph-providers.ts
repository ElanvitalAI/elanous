import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDefaultMarketDataRegistry } from './capability-providers/market-data/registry.js';
import type { GraphCapabilityRegistry } from './capabilities.js';
import { APP_BUILD_SUPERVISOR_CONTRACT, registerAppBuildSupervisorProvider } from './capability-providers/app-build-supervisor.js';
import { guardS2RetirementProviders, S2_GRAPH_IDENTITY } from './app-build/s2-declaration-rules.js';

/** This extension is available only to the manifest-declared S2 graph. */
export function withS2SupervisorProvider(pluginId: string | undefined, relativeGraph: string,
  registry: GraphCapabilityRegistry): GraphCapabilityRegistry {
  if (pluginId !== S2_GRAPH_IDENTITY.pluginId || relativeGraph !== S2_GRAPH_IDENTITY.relativeGraph) return registry;
  if (Object.hasOwn(registry.contracts, APP_BUILD_SUPERVISOR_CONTRACT)) {
    if (!registry.providers.some(provider => provider.provides.includes(APP_BUILD_SUPERVISOR_CONTRACT)))
      throw new Error('S2 supervisor contract has no provider');
  }
  const withSupervisor = Object.hasOwn(registry.contracts, APP_BUILD_SUPERVISOR_CONTRACT)
    ? registry : registerAppBuildSupervisorProvider(registry);
  return guardS2RetirementProviders(withSupervisor, context => context.readGraphRetirement?.());
}

/** One manifest-declared production provider loader shared by graph CLI and TUI. */
export async function defaultCapabilityRegistryForGraph(file: string, graphRoot?: string): Promise<GraphCapabilityRegistry> {
  const graphPath = resolve(file);
  const graphDir = dirname(graphPath);
  const pluginRoot = existsSync(join(graphDir, 'plugin.json')) ? graphDir : resolve(graphDir, '..');
  const manifestPath = join(pluginRoot, 'plugin.json');
  if (!existsSync(manifestPath)) return createDefaultMarketDataRegistry();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id?: string; extensions?: { 'ai.elanous'?: {
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
  const registry = declaration.withGraphRoot ? factory(graphRoot) : declaration.withPluginRoot ? factory(pluginRoot) : factory();
  return withS2SupervisorProvider(manifest.id, relativeGraph, registry as GraphCapabilityRegistry);
}
