import type { InProcessHandlerContext, InProcessHandlerResult } from './in-process-registry.js';

/** Closed, domain-neutral vocabulary from SYNTHESIS-two-layer-graph-v2 §3b. */
export const CAPABILITY_NAMES = Object.freeze([
  'store', 'extract', 'stt', 'ocr', 'market-data', 'notify', 'app-publish', 'cloud-resource', 'llm-judge',
] as const);

export type GraphCapabilityName = typeof CAPABILITY_NAMES[number];
export type GraphContractId = `${string}.${string}@${number}`;
export type GraphContractSchema = Readonly<Record<string, unknown>>;

export interface GraphCapabilityContract {
  readonly id: GraphContractId;
  readonly input: GraphContractSchema;
  readonly output: GraphContractSchema;
  readonly guarantees?: {
    readonly maxLatencyMs?: number;
    readonly maxFreshnessMs?: number;
    readonly sourceAttribution?: boolean;
  };
}

export type GraphCapabilityProvider = (context: InProcessHandlerContext) =>
  InProcessHandlerResult | Promise<InProcessHandlerResult>;

export interface GraphCapabilityProviderDeclaration {
  readonly id: string;
  readonly provides: readonly GraphContractId[];
  readonly tier: 'free' | 'byok' | 'paid';
  /** Optional until a provider has a measured latency sample. */
  readonly latency?: number;
  /** Alternative credential variables; any one enables a provider. */
  readonly keyEnv?: readonly string[];
  /** Credential names are metadata; values stay in the secret store. */
  readonly secretRefs?: readonly string[];
  /** Called before selection so a missing owner credential can fall through. */
  readonly available?: () => boolean | Promise<boolean>;
  readonly conditions?: Readonly<Record<string, unknown>>;
  readonly guarantees?: { readonly freshnessMs?: number; readonly sourceAttribution?: boolean };
  readonly invoke: GraphCapabilityProvider;
}

export interface GraphCapabilityRegistry {
  readonly contracts: Readonly<Record<string, GraphCapabilityContract>>;
  readonly providers: readonly GraphCapabilityProviderDeclaration[];
}

/** Legacy name-based provider table remains for graphs authored before contract IDs. */
export type LegacyGraphCapabilityProviders = Partial<Record<GraphCapabilityName, GraphCapabilityProvider>>;
export type GraphCapabilityProviders = GraphCapabilityRegistry | LegacyGraphCapabilityProviders;

export const emptyGraphCapabilityRegistry = (): GraphCapabilityRegistry => ({ contracts: {}, providers: [] });

/** Shared event-store contract for graph nodes and injected Nexus routes. */
export const STORE_EVENTS_CONTRACT: GraphCapabilityContract = Object.freeze({
  id: 'store.events@1',
  input: {
    type: 'object', required: ['operation', 'memberId'], properties: {
      operation: { type: 'string', enum: ['append', 'query'] },
      memberId: { type: 'string' },
      event: { type: 'object' },
      type: { type: 'string' },
      since: { type: 'string' },
    },
  },
  output: { type: 'object' },
});

const CONTRACT_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+@[1-9]\d*$/;

export function registerGraphCapabilityContract(
  registry: GraphCapabilityRegistry,
  contract: GraphCapabilityContract,
): GraphCapabilityRegistry {
  if (!CONTRACT_ID.test(contract.id)) throw new Error(`invalid graph capability contract id: ${contract.id}`);
  if (Object.hasOwn(registry.contracts, contract.id)) throw new Error(`duplicate graph capability contract: ${contract.id}`);
  if (contract.guarantees?.maxLatencyMs !== undefined && (!Number.isFinite(contract.guarantees.maxLatencyMs) || contract.guarantees.maxLatencyMs < 0))
    throw new Error(`invalid maxLatencyMs guarantee: ${contract.id}`);
  if (contract.guarantees?.maxFreshnessMs !== undefined && (!Number.isFinite(contract.guarantees.maxFreshnessMs) || contract.guarantees.maxFreshnessMs < 0))
    throw new Error(`invalid maxFreshnessMs guarantee: ${contract.id}`);
  return { ...registry, contracts: { ...registry.contracts, [contract.id]: contract } };
}

export function registerGraphCapabilityProviderDeclaration(
  registry: GraphCapabilityRegistry,
  provider: GraphCapabilityProviderDeclaration,
): GraphCapabilityRegistry {
  if (!/^[a-z][a-z0-9-]*$/.test(provider.id)) throw new Error(`invalid graph capability provider id: ${provider.id}`);
  if (provider.latency !== undefined && (!Number.isFinite(provider.latency) || provider.latency < 0))
    throw new Error(`invalid provider latency: ${provider.id}`);
  if (registry.providers.some((item) => item.id === provider.id)) throw new Error(`duplicate graph capability provider: ${provider.id}`);
  for (const contract of provider.provides) {
    if (!Object.hasOwn(registry.contracts, contract)) throw new Error(`provider ${provider.id} declares unknown contract: ${contract}`);
  }
  return { ...registry, providers: [...registry.providers, provider] };
}

/** Return a new legacy provider table; use contract registrations for new graphs. */
export function registerGraphCapabilityProvider(
  providers: LegacyGraphCapabilityProviders,
  name: GraphCapabilityName,
  provider: GraphCapabilityProvider,
): LegacyGraphCapabilityProviders {
  return { ...providers, [name]: provider };
}

export function capabilityNameFromRecipe(recipe: string): GraphCapabilityName | undefined {
  if (!recipe.startsWith('cap:')) return undefined;
  const name = recipe.slice('cap:'.length);
  return (CAPABILITY_NAMES as readonly string[]).includes(name) ? name as GraphCapabilityName : undefined;
}

export function isCapabilityRecipe(recipe: string): boolean {
  return recipe.startsWith('cap:');
}

function schemaTypeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

/** Deliberately small JSON Schema subset for portable contracts: type, required, properties, items, enum. */
export function graphContractValueMatches(schema: GraphContractSchema, value: unknown): boolean {
  if (schema.type !== undefined && !schemaTypeMatches(schema.type, value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) return false;
  if (schema.type === 'object' || schema.properties !== undefined || schema.required !== undefined) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(object, key))) return false;
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      for (const [key, childSchema] of Object.entries(schema.properties)) {
        if (Object.hasOwn(object, key) && (!childSchema || typeof childSchema !== 'object' || Array.isArray(childSchema) ||
          !graphContractValueMatches(childSchema as GraphContractSchema, object[key]))) return false;
      }
    }
  }
  if (schema.type === 'array' || schema.items !== undefined) {
    if (!Array.isArray(value)) return false;
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items) &&
      !value.every((item) => graphContractValueMatches(schema.items as GraphContractSchema, item))) return false;
  }
  return true;
}

function providerAvailable(provider: GraphCapabilityProviderDeclaration, context: InProcessHandlerContext): boolean {
  if (provider.keyEnv?.length && !provider.keyEnv.some((name) => process.env[name]?.trim())) return false;
  if (provider.conditions && Object.keys(provider.conditions).length > 0) {
    const sharedInput = context.input && typeof context.input === 'object' && !Array.isArray(context.input)
      ? context.input as Record<string, unknown> : {};
    const nodeInput = context.nodeInput && typeof context.nodeInput === 'object' && !Array.isArray(context.nodeInput)
      ? context.nodeInput as Record<string, unknown> : {};
    const request = { ...sharedInput, ...nodeInput };
    if (Object.entries(provider.conditions).some(([key, expected]) => request[key] !== expected)) return false;
  }
  return true;
}

/** Match by contract, then tier and declared latency; absent matches fail closed. */
export async function dispatchGraphContract(
  contractId: string,
  context: InProcessHandlerContext,
  registry: GraphCapabilityRegistry | undefined,
): Promise<InProcessHandlerResult> {
  const contract = registry?.contracts[contractId];
  if (!contract) return { ok: false, outcome: 'failed', error: 'unprovided' };
  const contractInput = context.nodeInput === undefined ? context.input : context.nodeInput;
  if (!graphContractValueMatches(contract.input, contractInput))
    return { ok: false, outcome: 'failed', error: 'contract-violation', evidence: { contractId, side: 'input' } };
  const providerContext = context.nodeInput === undefined ? context
    : { ...context, graphInput: context.input, input: context.nodeInput };
  const tierOrder = { free: 0, byok: 1, paid: 2 } as const;
  const candidates = [...(registry?.providers ?? [])]
    .filter((item) => item.provides.includes(contractId as GraphContractId) && providerAvailable(item, context)
      && (contract.guarantees?.maxLatencyMs === undefined || item.latency === undefined || item.latency <= contract.guarantees.maxLatencyMs)
      && (contract.guarantees?.maxFreshnessMs === undefined || (item.guarantees?.freshnessMs !== undefined && item.guarantees.freshnessMs <= contract.guarantees.maxFreshnessMs))
      && (contract.guarantees?.sourceAttribution !== true || item.guarantees?.sourceAttribution === true));
  const availability = await Promise.all(candidates.map(async (item) => {
    try { return item.available ? await item.available() : true; } catch { return false; }
  }));
  const providers = candidates.filter((_, index) => availability[index])
    .sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]
      || (a.latency ?? Number.POSITIVE_INFINITY) - (b.latency ?? Number.POSITIVE_INFINITY));
  if (!providers.length) return { ok: false, outcome: 'failed', error: 'unprovided' };
  const maxLatencyMs = contract.guarantees?.maxLatencyMs;
  const deadline = maxLatencyMs === undefined ? undefined : Date.now() + maxLatencyMs;
  const attempts: Array<{ provider: string; reason: string }> = [];
  for (const provider of providers) {
    let result: InProcessHandlerResult;
    const remainingMs = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
    if (remainingMs === 0) return { ok: false, outcome: 'failed', error: 'latency-exceeded', evidence: { contractId, provider: provider.id, maxLatencyMs, attempts } };
    const controller = remainingMs === undefined ? undefined : new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const invocation = Promise.resolve(provider.invoke(controller ? { ...providerContext, signal: controller.signal } : providerContext));
      result = controller && remainingMs !== undefined
        ? await Promise.race([
          invocation,
          new Promise<InProcessHandlerResult>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve({ ok: false, outcome: 'failed', error: 'latency-exceeded', evidence: { contractId, provider: provider.id, maxLatencyMs } });
              controller.abort();
            }, remainingMs);
          }),
        ]) : await invocation;
    } catch {
      attempts.push({ provider: provider.id, reason: 'provider-error' });
      continue;
    } finally { if (timer) clearTimeout(timer); }
    if (timedOut) return { ok: false, outcome: 'failed', error: 'latency-exceeded', evidence: { contractId, provider: provider.id, maxLatencyMs, attempts } };
    if (!result.ok) { attempts.push({ provider: provider.id, reason: result.error || 'provider-failed' }); continue; }
    const evidence = result.evidence;
    const freshnessValid = contract.guarantees?.maxFreshnessMs === undefined
      || (typeof evidence?.freshnessMs === 'number' && evidence.freshnessMs <= contract.guarantees.maxFreshnessMs);
    const sourceValid = contract.guarantees?.sourceAttribution !== true
      || (typeof evidence?.source === 'string' && evidence.source.trim().length > 0);
    if (result.result === undefined || !graphContractValueMatches(contract.output, result.result) || !freshnessValid || !sourceValid)
      return { ok: false, outcome: 'failed', error: 'contract-violation', evidence: { contractId, provider: provider.id, side: 'output' } };
    return result;
  }
  return { ok: false, outcome: 'failed', error: 'contract-exhausted', evidence: { contractId, attempts } };
}

/** Legacy name dispatch for existing graphs until their v2 declarations use `requires`. */
export async function dispatchGraphCapability(
  name: GraphCapabilityName,
  context: InProcessHandlerContext,
  providers: GraphCapabilityProviders | undefined,
): Promise<InProcessHandlerResult> {
  if (!providers || 'contracts' in providers) return { ok: false, outcome: 'failed', error: 'unprovided' };
  const provider = providers[name];
  if (!provider) return { ok: false, outcome: 'failed', error: 'unprovided' };
  return provider(context);
}
