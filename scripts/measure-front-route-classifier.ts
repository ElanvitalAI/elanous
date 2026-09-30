import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolveRoleProviderFn } from '../src/intake-plane/runtime-callables.js';
import type { LLMProvider } from '../src/llm.js';
import { formatFrontRouteReport, loadFrontRouteCorpus, measureFrontRoute } from './lib/front-route-measurement.js';

interface RunnerOptions { providers: string[]; runs: number; json: boolean }

export function parseFrontRouteArgs(args: readonly string[]): RunnerOptions {
  const options: RunnerOptions = { providers: [], runs: 1, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--provider') {
      const value = args[++i];
      if (!value || value.startsWith('--') || !/^[\w-]+(?:\/\S+)?$/.test(value)) throw new Error('--provider requires <name>[/<model>]');
      options.providers.push(value);
    } else if (arg === '--runs') {
      const value = args[++i];
      if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--runs requires a positive integer');
      options.runs = Number(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function frontRouteProviders(specs: readonly string[], registry: Record<string, LLMProvider>): { label: string; resolve: ResolveRoleProviderFn }[] {
  return specs.map((label) => {
    const slash = label.indexOf('/');
    const name = slash < 0 ? label : label.slice(0, slash);
    const model = slash < 0 ? undefined : label.slice(slash + 1);
    const provider = registry[name];
    if (!provider) throw new Error(`Unknown provider: ${name}`);
    const selectedModel = model ?? provider.defaultModel;
    const resolveRole: ResolveRoleProviderFn = (_role) => ({ provider: provider as unknown as ReturnType<ResolveRoleProviderFn>['provider'], ...(typeof selectedModel === 'string' ? { model: selectedModel } : {}) });
    return { label, resolve: resolveRole };
  });
}

export async function main(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options = parseFrontRouteArgs(args);
  if (!env.CORPUS_PATH?.trim()) throw new Error('CORPUS_PATH is required (path to front-route corpus JSON)');
  const corpus = loadFrontRouteCorpus(readFileSync(resolve(process.cwd(), env.CORPUS_PATH), 'utf8'));
  const { PROVIDERS } = await import('../src/llm.js');
  let selected = options.providers;
  if (!selected.length) {
    const { resolveRoleLlm } = await import('../src/user-config.js');
    const { provider, model } = resolveRoleLlm('classify');
    selected = [model ? `${provider}/${model}` : provider];
  }
  const providers = frontRouteProviders(selected, PROVIDERS);
  const result = await measureFrontRoute(corpus.items, { providers, runs: options.runs });
  console.log(options.json ? JSON.stringify(result, null, 2) : formatFrontRouteReport(result));
}

if (import.meta.main) await main();
