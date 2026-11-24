import { createHash } from 'node:crypto';
import type { InProcessHandlerContext, InProcessHandlerResult } from './in-process-registry.js';

/** Closed, domain-neutral vocabulary from SYNTHESIS-two-layer-graph-v2 §3b. */
export const CAPABILITY_NAMES = Object.freeze([
  'store', 'extract', 'stt', 'ocr', 'market-data', 'notify', 'app-publish', 'cloud-resource', 'llm-judge',
] as const);

export type GraphCapabilityName = typeof CAPABILITY_NAMES[number];
export type GraphContractId = `${string}.${string}@${number}`;
export type GraphContractSchema = Readonly<Record<string, unknown>>;
export type GraphPreconditionFillSource = 'host' | 'manifest' | 'prior' | 'ask_user';
export interface GraphCapabilityPostPredicate {
  readonly path: string;
  readonly equals?: string | number | boolean | null;
  readonly exists?: boolean;
}
export interface GraphCapabilityPostCondition {
  readonly when: GraphCapabilityPostPredicate;
  readonly require?: GraphCapabilityPostPredicate;
  /** A matching provider result may continue only to nodes outside this set. */
  readonly forbidNext?: readonly string[];
}

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
  /** Input keys inspected before this provider is invoked. */
  readonly requires?: readonly string[];
  /** Per-key authority for missing data, never a grant to synthesize owner or approval. */
  readonly fill?: Readonly<Record<string, readonly GraphPreconditionFillSource[]>>;
  /** A declared effectful provider stops fallback after invocation. */
  readonly post?: readonly GraphCapabilityPostCondition[];
  /** Typed failure codes this provider owns; dispatch surfaces them instead of contract-exhausted. */
  readonly preserveFailureCodes?: readonly string[];
  readonly invoke: GraphCapabilityProvider;
}

export interface GraphCapabilityRegistry {
  readonly contracts: Readonly<Record<string, GraphCapabilityContract>>;
  readonly providers: readonly GraphCapabilityProviderDeclaration[];
}

export interface GraphContractDispatchHooks {
  readonly prepare?: (provider: GraphCapabilityProviderDeclaration, context: InProcessHandlerContext,
    schema: GraphContractSchema) => Promise<{ readonly ok: true; readonly context: InProcessHandlerContext }
      | { readonly ok: false; readonly missing: readonly string[]; readonly reason: string }>;
  readonly deadlineAtMs?: number;
  readonly signal?: AbortSignal;
  /** Persist an effect intent before the selected provider can execute. */
  readonly beforeInvoke?: (provider: GraphCapabilityProviderDeclaration) => void | Promise<void>;
}

export interface GraphContractDispatchResult extends InProcessHandlerResult {
  /** Internal runner barrier; never supplied by graph input or emitted as a provider result. */
  readonly hardBarrier?: true;
  readonly effectStatus?: 'unknown';
  readonly postForbidNext?: readonly string[];
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

/** One validator for both registration paths: code registration and vocabulary review. */
function validateGraphCapabilityContract(contract: GraphCapabilityContract): void {
  if (!CONTRACT_ID.test(contract.id)) throw new Error(`invalid graph capability contract id: ${contract.id}`);
  if (!contract.input || typeof contract.input !== 'object' || Array.isArray(contract.input))
    throw new Error(`invalid input schema for ${contract.id}`);
  if (!contract.output || typeof contract.output !== 'object' || Array.isArray(contract.output))
    throw new Error(`invalid output schema for ${contract.id}`);
  if (contract.guarantees?.maxLatencyMs !== undefined && (!Number.isFinite(contract.guarantees.maxLatencyMs) || contract.guarantees.maxLatencyMs < 0))
    throw new Error(`invalid maxLatencyMs guarantee: ${contract.id}`);
  if (contract.guarantees?.maxFreshnessMs !== undefined && (!Number.isFinite(contract.guarantees.maxFreshnessMs) || contract.guarantees.maxFreshnessMs < 0))
    throw new Error(`invalid maxFreshnessMs guarantee: ${contract.id}`);
}

export function registerGraphCapabilityContract(
  registry: GraphCapabilityRegistry,
  contract: GraphCapabilityContract,
): GraphCapabilityRegistry {
  validateGraphCapabilityContract(contract);
  if (Object.hasOwn(registry.contracts, contract.id)) throw new Error(`duplicate graph capability contract: ${contract.id}`);
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
  const key = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
  if (provider.requires && (new Set(provider.requires).size !== provider.requires.length
    || provider.requires.some(item => !key.test(item) || ['constructor', 'prototype', '__proto__'].includes(item))))
    throw new Error(`invalid provider requires: ${provider.id}`);
  if (provider.fill && Object.entries(provider.fill).some(([item, sources]) =>
    !provider.requires?.includes(item) || !Array.isArray(sources) || sources.length === 0
    || new Set(sources).size !== sources.length
    || sources.some(source => !['host', 'manifest', 'prior', 'ask_user'].includes(source))
    || ['action', 'approvalId', 'approvalUrl', 'approvalConfirmed', 'requirePassingReceipt', 'receipt',
      'deploymentId'].includes(item)
    || ['owner', 'ownerId', 'memberId', 'requireOwner', 'appSlug'].includes(item)
      && (sources.length !== 1 || sources[0] !== 'host')))
    throw new Error(`invalid provider fill: ${provider.id}`);
  if (provider.preserveFailureCodes && (provider.preserveFailureCodes.length === 0 || provider.preserveFailureCodes.length > 8
    || provider.preserveFailureCodes.some(code => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(code))))
    throw new Error(`invalid provider preserveFailureCodes: ${provider.id}`);
  const safePath = /^(?:outcome|result(?:\.[A-Za-z][A-Za-z0-9_]{0,63}){0,3}|evidence(?:\.[A-Za-z][A-Za-z0-9_]{0,63}){0,3})$/u;
  const validPredicate = (predicate: GraphCapabilityPostPredicate): boolean =>
    !!predicate && safePath.test(predicate.path) && !predicate.path.split('.').some(part =>
      ['__proto__', 'prototype', 'constructor'].includes(part))
    && (Object.hasOwn(predicate, 'exists') !== Object.hasOwn(predicate, 'equals'))
    && (predicate.exists === undefined || typeof predicate.exists === 'boolean')
    && (predicate.equals === undefined || predicate.equals === null || typeof predicate.equals === 'string'
      || typeof predicate.equals === 'boolean' || typeof predicate.equals === 'number' && Number.isFinite(predicate.equals));
  if (provider.post && (provider.post.length === 0 || provider.post.length > 16 || provider.post.some(rule =>
    !rule || !validPredicate(rule.when)
    || rule.require !== undefined && !validPredicate(rule.require)
    || (!rule.require && !rule.forbidNext?.length)
    || rule.forbidNext !== undefined && (!Array.isArray(rule.forbidNext) || rule.forbidNext.length === 0
      || rule.forbidNext.length > 16
      || new Set(rule.forbidNext).size !== rule.forbidNext.length
      || rule.forbidNext.some(nodeId => !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(nodeId))))))
    throw new Error(`invalid provider post: ${provider.id}`);
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

/**
 * Dynamic capability vocabulary lifecycle (GRAPH-VOCAB-DYNAMIC): a real contract is
 * registered as a proposal, judged by a named reviewer, and the approved contracts are
 * materialized into the dispatch registry and pinned as one content-addressed edition.
 * The pinned edition lives in a review-owned catalog ABOVE the graph plugin root; the
 * manifest loader rejects nodes naming anything but an approved entry of that edition.
 */
export type GraphCapabilityReviewStatus = 'proposed' | 'approved' | 'rejected';

export interface GraphCapabilityVocabularyEntry {
  readonly id: GraphContractId;
  readonly status: GraphCapabilityReviewStatus;
  /** The registered contract; the edition digest pins its schemas too. */
  readonly contract: GraphCapabilityContract;
  /** Reviewer seat that produced an approved/rejected verdict; proposals carry none. */
  readonly reviewer?: string;
  readonly note?: string;
}

export interface GraphCapabilityVocabulary {
  readonly entries: readonly GraphCapabilityVocabularyEntry[];
}

/** A frozen, content-addressed edition of the vocabulary (`판 고정`). */
export interface GraphCapabilityVocabularyPin {
  readonly entries: readonly GraphCapabilityVocabularyEntry[];
  readonly digest: string;
}

export const emptyGraphCapabilityVocabulary = (): GraphCapabilityVocabulary => ({ entries: [] });

function contractName(id: string): string {
  return id.slice(0, id.lastIndexOf('@'));
}

function contractVersion(id: string): number {
  return Number(id.slice(id.lastIndexOf('@') + 1));
}

/** Register a real contract as a proposal; verdicts come only from review. */
export function proposeGraphCapability(
  vocabulary: GraphCapabilityVocabulary,
  contract: GraphCapabilityContract,
): GraphCapabilityVocabulary {
  validateGraphCapabilityContract(contract);
  const id = contract.id;
  const same = vocabulary.entries.find((entry) => entry.id === id);
  if (same) {
    if (same.status === 'approved') throw new Error(`graph capability contract ${id} is pinned in the approved vocabulary; propose the next version`);
    if (same.status === 'proposed') throw new Error(`duplicate graph capability proposal: ${id}`);
    throw new Error(`graph capability contract ${id} was rejected; propose the next version`);
  }
  const versions = vocabulary.entries
    .filter((entry) => contractName(entry.id) === contractName(id))
    .map((entry) => contractVersion(entry.id));
  const next = (versions.length ? Math.max(...versions) : 0) + 1;
  if (contractVersion(id) !== next) {
    throw new Error(`graph capability proposal ${id} skips versions: the next version for ${contractName(id)} is ${next}`);
  }
  return { entries: [...vocabulary.entries, { id, status: 'proposed', contract }] };
}

/** Judge one proposal; approved and rejected verdicts are terminal for that version. */
export function reviewGraphCapability(
  vocabulary: GraphCapabilityVocabulary,
  id: GraphContractId,
  review: { verdict: 'approved' | 'rejected'; reviewer: string; note?: string },
): GraphCapabilityVocabulary {
  if (!review.reviewer.trim()) throw new Error(`capability review for ${id} requires a reviewer`);
  const entry = vocabulary.entries.find((item) => item.id === id);
  if (!entry) throw new Error(`unknown graph capability proposal: ${id}`);
  if (entry.status !== 'proposed') throw new Error(`only proposed capability vocabulary can be reviewed: ${id} is ${entry.status}`);
  return {
    entries: vocabulary.entries.map((item) => item.id === id
      ? { ...item, status: review.verdict, reviewer: review.reviewer, ...(review.note ? { note: review.note } : {}) }
      : item),
  };
}

/** Only approved entries of the reviewed vocabulary may back graph nodes. */
export function approvedGraphCapabilityIds(vocabulary: GraphCapabilityVocabulary): readonly GraphContractId[] {
  return vocabulary.entries.filter((entry) => entry.status === 'approved').map((entry) => entry.id).sort();
}

/**
 * Materialize the reviewed vocabulary into the real dispatch registry: approved
 * contracts become dispatchable, proposed and rejected contracts never enter, so
 * provider declarations for them fail closed as unknown contracts.
 */
export function graphCapabilityRegistryFromVocabulary(vocabulary: GraphCapabilityVocabulary): GraphCapabilityRegistry {
  const contracts: Record<string, GraphCapabilityContract> = {};
  for (const entry of vocabulary.entries) {
    if (entry.status === 'approved') contracts[entry.id] = entry.contract;
  }
  return { contracts, providers: [] };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Deterministic edition identity: canonical content only — no time, no insertion order. */
export function graphCapabilityVocabularyDigest(entries: readonly GraphCapabilityVocabularyEntry[]): string {
  const canonical = entries
    .map((entry) => [entry.id, entry.status, entry.reviewer ?? null, entry.note ?? null, stableJson(entry.contract)])
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Deep copy and deep freeze vocabulary entries, nested contract schemas included, so a pinned edition never aliases its source. */
export function freezeGraphCapabilityVocabularyEntries(
  entries: readonly GraphCapabilityVocabularyEntry[],
): readonly GraphCapabilityVocabularyEntry[] {
  return deepFreeze(structuredClone([...entries])
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

/** Freeze the current vocabulary as one pinned edition for the review-owned catalog. */
export function pinGraphCapabilityVocabulary(vocabulary: GraphCapabilityVocabulary): GraphCapabilityVocabularyPin {
  const entries = freezeGraphCapabilityVocabularyEntries(vocabulary.entries);
  return Object.freeze({ entries, digest: graphCapabilityVocabularyDigest(entries) });
}

const VOCABULARY_ENTRY_KEYS = new Set(['id', 'status', 'contract', 'reviewer', 'note']);

/** Strict parser for the review-owned vocabulary catalog; unknown shapes fail closed. */
export function parseGraphCapabilityVocabularyEntries(
  value: unknown,
  label: string,
): readonly GraphCapabilityVocabularyEntry[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const entries = value.map((raw, index): GraphCapabilityVocabularyEntry => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label}[${index}] must be an object`);
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!VOCABULARY_ENTRY_KEYS.has(key)) throw new Error(`${label}[${index}] uses unsupported key: ${key}`);
    }
    if (typeof entry.id !== 'string' || !CONTRACT_ID.test(entry.id))
      throw new Error(`${label}[${index}].id must be a <namespace>.<contract>@<positive version> id`);
    if (entry.status !== 'proposed' && entry.status !== 'approved' && entry.status !== 'rejected')
      throw new Error(`${label}[${index}].status must be proposed, approved, or rejected`);
    if (entry.status === 'proposed' && entry.reviewer !== undefined)
      throw new Error(`${label}[${index}] proposes ${entry.id} with a reviewer; proposals are unjudged`);
    if (entry.status !== 'proposed' && (typeof entry.reviewer !== 'string' || !entry.reviewer.trim()))
      throw new Error(`${label}[${index}] records ${entry.status} ${entry.id} without a reviewer`);
    if (entry.note !== undefined && (typeof entry.note !== 'string' || !entry.note.trim()))
      throw new Error(`${label}[${index}].note must be a nonempty string`);
    if (!entry.contract || typeof entry.contract !== 'object' || Array.isArray(entry.contract))
      throw new Error(`${label}[${index}] must register the real contract for ${entry.id}`);
    const rawContract = entry.contract as Record<string, unknown>;
    if (rawContract.id !== entry.id)
      throw new Error(`${label}[${index}] registers contract ${String(rawContract.id)} under entry id ${entry.id}`);
    const contract: GraphCapabilityContract = {
      id: entry.id as GraphContractId,
      input: rawContract.input as GraphContractSchema,
      output: rawContract.output as GraphContractSchema,
      ...(rawContract.guarantees !== undefined ? { guarantees: rawContract.guarantees as GraphCapabilityContract['guarantees'] } : {}),
    };
    try {
      validateGraphCapabilityContract(contract);
    } catch (error) {
      throw new Error(`${label}[${index}] registers an invalid contract: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      id: entry.id as GraphContractId,
      status: entry.status,
      contract,
      ...(typeof entry.reviewer === 'string' ? { reviewer: entry.reviewer } : {}),
      ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
    };
  });
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must not contain duplicate contract ids`);
  return entries;
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

function postPath(result: InProcessHandlerResult, path: string): { readonly found: boolean; readonly value?: unknown } {
  let current: unknown = result;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || !Object.hasOwn(current, key)) return { found: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

function postPredicateMatches(result: InProcessHandlerResult, predicate: GraphCapabilityPostPredicate): boolean {
  const found = postPath(result, predicate.path);
  return predicate.exists !== undefined ? found.found === predicate.exists
    : found.found && Object.is(found.value, predicate.equals);
}

export function violatedGraphPostcondition(provider: GraphCapabilityProviderDeclaration,
  result: InProcessHandlerResult): GraphCapabilityPostCondition | undefined {
  return provider.post?.find(rule => postPredicateMatches(result, rule.when)
    && rule.require && !postPredicateMatches(result, rule.require));
}

export function forbiddenGraphPostNextNodes(provider: GraphCapabilityProviderDeclaration,
  result: InProcessHandlerResult): readonly string[] {
  return [...new Set(provider.post?.filter(rule => postPredicateMatches(result, rule.when))
    .flatMap(rule => rule.forbidNext ?? []) ?? [])];
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

/** Serialize supported write values with explicit runtime type and array-slot tags. */
function serializeWriteValue(value: unknown): string | undefined {
  const ancestors = new WeakSet<object>();
  const normalize = (current: unknown): unknown | undefined => {
    if (current === null) return ['null'];
    if (current === undefined) return ['undefined'];
    if (typeof current === 'string') return ['string', current];
    if (typeof current === 'boolean') return ['boolean', current];
    if (typeof current === 'number') {
      const normalized = Number.isNaN(current) ? 'NaN'
        : current === Number.POSITIVE_INFINITY ? '+Infinity'
          : current === Number.NEGATIVE_INFINITY ? '-Infinity'
            : Object.is(current, -0) ? '-0' : String(current);
      return ['number', normalized];
    }
    if (typeof current !== 'object') return undefined;
    if (ancestors.has(current)) return undefined;
    ancestors.add(current);
    try {
      if (current instanceof Date) {
        if (Object.getPrototypeOf(current) !== Date.prototype || Reflect.ownKeys(current).length !== 0
          || Number.isNaN(Date.prototype.getTime.call(current))) return undefined;
        return ['date', Date.prototype.toISOString.call(current)];
      }
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) return undefined;
        const length = current.length;
        const slots: unknown[] = [];
        for (const key of Reflect.ownKeys(current)) {
          if (key === 'length') continue;
          if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) return undefined;
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
        }
        for (let index = 0; index < length; index++) {
          if (!Object.hasOwn(current, index)) { slots.push(['hole']); continue; }
          const normalized = normalize(current[index]);
          if (normalized === undefined) return undefined;
          slots.push(['slot', normalized]);
        }
        return ['array', slots];
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const entries: unknown[] = [];
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== 'string')) return undefined;
      for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
        const normalized = normalize(descriptor.value);
        if (normalized === undefined) return undefined;
        entries.push([key, normalized]);
      }
      return [prototype === null ? 'null-prototype-object' : 'object', entries];
    } catch {
      return undefined;
    } finally {
      ancestors.delete(current);
    }
  };
  const normalized = normalize(value);
  return normalized === undefined ? undefined : JSON.stringify(normalized);
}

function validatedContractInput(contractId: string, schema: GraphContractSchema, input: unknown):
  { readonly ok: true; readonly input: unknown } | { readonly ok: false; readonly result: InProcessHandlerResult } {
  if (!graphContractValueMatches(schema, input)) return { ok: false,
    result: { ok: false, outcome: 'failed', error: 'contract-violation', evidence: { contractId, side: 'input' } } };
  if (contractId !== 'store.write@1') return { ok: true, input };
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || !Object.hasOwn(input, '__validatedWrite')) return { ok: false,
    result: { ok: false, outcome: 'failed', error: 'store write is missing its validated payload' } };
  const { __validatedWrite: expected, ...actual } = input as Record<string, unknown>;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const fields = ['op', 'collection', 'owner', 'key', 'value', 'ownerScoped', 'status'] as const;
  const actualFields = Object.keys(actual).sort();
  const expectedFields = isRecord(expected) ? Object.keys(expected).sort() : [];
  if (!isRecord(expected) || actualFields.length !== expectedFields.length
    || actualFields.some((field, index) => field !== expectedFields[index])
    || actualFields.some(field => !fields.includes(field as typeof fields[number]))
    || ['op', 'collection', 'owner', 'value', 'ownerScoped'].some(field => !Object.hasOwn(actual, field))
    || actualFields.some(field => !Object.hasOwn(expected, field) || !Object.hasOwn(actual, field)
      || serializeWriteValue(expected[field]) === undefined
      || serializeWriteValue(expected[field]) !== serializeWriteValue(actual[field]))) return { ok: false,
    result: { ok: false, outcome: 'failed', error: 'store write input differs from its validated payload' } };
  return { ok: true, input: actual };
}

async function awaitDispatchBoundary<T>(work: Promise<T>, deadlineAtMs?: number, signal?: AbortSignal):
  Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  if (signal?.aborted || deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) return { ok: false };
  if (deadlineAtMs === undefined && !signal) return { ok: true, value: await work };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const expired = new Promise<{ readonly ok: false }>(resolve => {
      abort = () => resolve({ ok: false });
      signal?.addEventListener('abort', abort, { once: true });
      if (deadlineAtMs !== undefined) timer = setTimeout(abort, Math.max(0, deadlineAtMs - Date.now()));
    });
    return await Promise.race([work.then(value => ({ ok: true as const, value })), expired]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** Match by contract, then tier and declared latency; absent matches fail closed. */
export async function dispatchGraphContract(
  contractId: string,
  context: InProcessHandlerContext,
  registry: GraphCapabilityRegistry | undefined,
  hooks?: GraphContractDispatchHooks,
): Promise<GraphContractDispatchResult> {
  const contract = registry?.contracts[contractId];
  if (!contract) return { ok: false, outcome: 'failed', error: 'unprovided' };
  const contractInput = context.nodeInput === undefined ? context.input : context.nodeInput;
  if (!hooks?.prepare) {
    const checked = validatedContractInput(contractId, contract.input, contractInput);
    if (!checked.ok) return checked.result;
  }
  const tierOrder = { free: 0, byok: 1, paid: 2 } as const;
  const candidates = [...(registry?.providers ?? [])]
    .filter((item) => item.provides.includes(contractId as GraphContractId)
      && (contract.guarantees?.maxLatencyMs === undefined || item.latency === undefined || item.latency <= contract.guarantees.maxLatencyMs)
      && (contract.guarantees?.maxFreshnessMs === undefined || (item.guarantees?.freshnessMs !== undefined && item.guarantees.freshnessMs <= contract.guarantees.maxFreshnessMs))
      && (contract.guarantees?.sourceAttribution !== true || item.guarantees?.sourceAttribution === true))
    .sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]
      || (a.latency ?? Number.POSITIVE_INFINITY) - (b.latency ?? Number.POSITIVE_INFINITY));
  if (!candidates.length) return { ok: false, outcome: 'failed', error: 'unprovided' };
  const maxLatencyMs = contract.guarantees?.maxLatencyMs;
  let invocationSpentMs = 0;
  const attempts: Array<{ provider: string; reason: string }> = [];
  let anyAvailable = false;
  let preservedFailure: string | undefined;
  for (const provider of candidates) {
    if (hooks?.signal?.aborted || hooks?.deadlineAtMs !== undefined && hooks.deadlineAtMs <= Date.now())
      return { ok: false, outcome: 'failed', error: 'precondition-deadline', hardBarrier: true };
    if (!providerAvailable(provider, context)) continue;
    let available = true;
    try {
      if (provider.available) {
        const checked = await awaitDispatchBoundary(Promise.resolve(provider.available()), hooks?.deadlineAtMs, hooks?.signal);
        if (!checked.ok) return { ok: false, outcome: 'failed', error: 'precondition-deadline', hardBarrier: true };
        available = checked.value;
      }
    } catch {
      if (provider.requires?.length || provider.post?.length)
        return { ok: false, outcome: 'failed', error: 'precondition-availability-failed', hardBarrier: true };
      available = false;
    }
    if (!available) continue;
    let prepared = context;
    if (hooks?.prepare) {
      const checked = await awaitDispatchBoundary(Promise.resolve().then(() => hooks.prepare!(provider, context, contract.input)),
        hooks.deadlineAtMs, hooks.signal).catch(() => undefined);
      if (!checked) return { ok: false, outcome: 'failed', error: 'precondition-check-failed', hardBarrier: true };
      if (!checked.ok) return { ok: false, outcome: 'failed', error: 'precondition-deadline', hardBarrier: true };
      if (!checked.value.ok) return { ok: false, outcome: 'failed',
        error: `${checked.value.reason}: ${checked.value.missing.join(', ')}`, hardBarrier: true };
      prepared = checked.value.context;
    } else if (provider.requires?.length) {
      const request = prepared.nodeInput === undefined ? prepared.input : prepared.nodeInput;
      const row = request && typeof request === 'object' && !Array.isArray(request)
        ? request as Record<string, unknown> : {};
      const missing = provider.requires.filter(key => !Object.hasOwn(row, key)
        || row[key] === undefined || row[key] === null || typeof row[key] === 'string' && !(row[key] as string).trim());
      if (missing.length) return { ok: false, outcome: 'failed', error: `precondition-missing: ${missing.join(', ')}`,
        hardBarrier: true };
    }
    anyAvailable = true;
    const input = prepared.nodeInput === undefined ? prepared.input : prepared.nodeInput;
    const validated = validatedContractInput(contractId, contract.input, input);
    if (!validated.ok) return { ...validated.result, hardBarrier: provider.requires?.length ? true : undefined };
    const providerContext = prepared.nodeInput === undefined ? { ...prepared, input: validated.input }
      : { ...prepared, graphInput: prepared.input, input: validated.input, nodeInput: validated.input };
    let result: InProcessHandlerResult;
    const remainingContractMs = maxLatencyMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, maxLatencyMs - invocationSpentMs);
    if (remainingContractMs === 0) return { ok: false, outcome: 'failed', error: 'latency-exceeded',
      evidence: { contractId, attempts } };
    if (provider.post?.length && hooks?.beforeInvoke) {
      const intent = await awaitDispatchBoundary(Promise.resolve().then(() => hooks.beforeInvoke!(provider)),
        hooks.deadlineAtMs, hooks.signal).catch(() => undefined);
      if (!intent?.ok) return { ok: false, outcome: 'failed', error: 'precondition-intent-failed', hardBarrier: true };
    }
    const effectiveDeadline = Math.min(Number.isFinite(remainingContractMs) ? Date.now() + remainingContractMs : Number.POSITIVE_INFINITY,
      hooks?.deadlineAtMs ?? Number.POSITIVE_INFINITY);
    const remainingMs = Number.isFinite(effectiveDeadline) ? Math.max(0, effectiveDeadline - Date.now()) : undefined;
    if (remainingMs === 0 || hooks?.signal?.aborted) return { ok: false, outcome: 'failed',
      error: 'precondition-deadline', hardBarrier: true };
    const controller = remainingMs === undefined && !hooks?.signal ? undefined : new AbortController();
    const onParentAbort = () => controller?.abort();
    hooks?.signal?.addEventListener('abort', onParentAbort, { once: true });
    if (hooks?.signal?.aborted) controller?.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let stop: (() => void) | undefined;
    const invocationStartedAt = Date.now();
    try {
      const aborted = controller
        ? new Promise<InProcessHandlerResult>((resolve) => {
            let stopped = false;
            stop = () => {
              if (stopped) return;
              stopped = true;
              timedOut = true;
              resolve({ ok: false, outcome: 'failed', error: 'latency-exceeded', evidence: { contractId, provider: provider.id, maxLatencyMs } });
              controller.abort();
            };
            controller.signal.addEventListener('abort', stop, { once: true });
            if (controller.signal.aborted) stop();
            if (remainingMs !== undefined) timer = setTimeout(stop, remainingMs);
          }) : undefined;
      const invocation = Promise.resolve().then(() => {
        if (controller?.signal.aborted) return { ok: false, outcome: 'failed', error: 'latency-exceeded' };
        return provider.invoke(controller ? { ...providerContext, signal: controller.signal } : providerContext);
      });
      result = aborted ? await Promise.race([invocation, aborted]) : await invocation;
    } catch {
      if (provider.post) return { ok: false, outcome: 'unknown', error: 'effect-unknown: provider-error',
        hardBarrier: true, effectStatus: 'unknown' };
      attempts.push({ provider: provider.id, reason: 'provider-error' });
      continue;
    } finally {
      invocationSpentMs += Math.max(0, Date.now() - invocationStartedAt);
      if (timer) clearTimeout(timer);
      if (controller && stop) controller.signal.removeEventListener('abort', stop);
      hooks?.signal?.removeEventListener('abort', onParentAbort);
    }
    if (timedOut || maxLatencyMs !== undefined && invocationSpentMs > maxLatencyMs) return provider.post
      ? { ok: false, outcome: 'unknown', error: 'effect-unknown: latency-exceeded', hardBarrier: true, effectStatus: 'unknown' }
      : { ok: false, outcome: 'failed', error: 'latency-exceeded', evidence: { contractId, provider: provider.id, maxLatencyMs, attempts } };
    let validResult = false;
    try { validResult = !!result && typeof result.ok === 'boolean'
      && typeof result.outcome === 'string' && !!result.outcome.trim(); }
    catch { validResult = false; }
    if (!validResult)
      return provider.post ? { ok: false, outcome: 'unknown', error: 'effect-unknown: invalid-result',
        hardBarrier: true, effectStatus: 'unknown' }
        : { ok: false, outcome: 'failed', error: 'contract-violation', evidence: { contractId, provider: provider.id, side: 'result' } };
    if (!result.ok) {
      if (provider.post) return { ok: false, outcome: 'unknown', error: 'effect-unknown: provider-failed',
        hardBarrier: true, effectStatus: 'unknown' };
      attempts.push({ provider: provider.id, reason: result.error || 'provider-failed' });
      // A provider-owned typed code (e.g. a resume instruction) must reach the node record unmasked.
      const code = typeof result.error === 'string' ? /^([A-Z][A-Z0-9_]{2,63})(?::|$)/u.exec(result.error)?.[1] : undefined;
      if (!preservedFailure && code && provider.preserveFailureCodes?.includes(code)) preservedFailure = result.error;
      continue;
    }
    let outputValid = false;
    try {
      const evidence = result.evidence;
      const freshnessValid = contract.guarantees?.maxFreshnessMs === undefined
        || (typeof evidence?.freshnessMs === 'number' && evidence.freshnessMs <= contract.guarantees.maxFreshnessMs);
      const sourceValid = contract.guarantees?.sourceAttribution !== true
        || (typeof evidence?.source === 'string' && evidence.source.trim().length > 0);
      outputValid = result.result !== undefined && graphContractValueMatches(contract.output, result.result)
        && freshnessValid && sourceValid;
    } catch { outputValid = false; }
    if (!outputValid)
      return provider.post ? { ok: false, outcome: 'unknown', error: 'effect-unknown: contract-violation',
        hardBarrier: true, effectStatus: 'unknown' }
        : { ok: false, outcome: 'failed', error: 'contract-violation', evidence: { contractId, provider: provider.id, side: 'output' } };
    let postViolation: GraphCapabilityPostCondition | undefined;
    try { postViolation = violatedGraphPostcondition(provider, result); }
    catch { return { ok: false, outcome: 'unknown', error: 'effect-unknown: postcondition-check-failed',
      hardBarrier: true, effectStatus: 'unknown' }; }
    if (postViolation) return { ok: false, outcome: 'unknown',
      error: `postcondition-violation: ${postViolation.require?.path ?? 'unknown'}`,
      hardBarrier: true, effectStatus: 'unknown' };
    const postForbidNext = forbiddenGraphPostNextNodes(provider, result);
    if (postForbidNext.length && !hooks?.prepare) return { ok: false, outcome: 'unknown',
      error: 'effect-unknown: postcondition-route-unverified', hardBarrier: true, effectStatus: 'unknown' };
    return postForbidNext.length ? { ...result, postForbidNext } : result;
  }
  return { ok: false, outcome: 'failed', error: preservedFailure ?? (anyAvailable ? 'contract-exhausted' : 'unprovided'),
    evidence: { contractId, attempts } };
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
