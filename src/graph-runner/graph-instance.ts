import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseGraphTemplateYaml, type GraphNodeSpec, type GraphTemplateSpec } from '../self-implement/graph-yaml.js';

/** Static derive contract. The plugin loader can supply parsed JSON/YAML without importing the release runner. */
export interface ReleasePolicyDefinition {
  type: 'enum' | 'int' | 'boolean' | 'ref' | 'accept-item[]';
  default: unknown;
  bounds?: readonly (string | number)[];
  scope?: 'instance';
}
export interface ReleaseTemplateManifest {
  id: string;
  version: string;
  allow?: { recipes: readonly string[] };
  policy: Record<string, ReleasePolicyDefinition>;
  extensionPoints: Record<string, { after: string; before: string; failure: string }>;
}
export interface ReleaseTemplateOverlay {
  id: string;
  base: { id: string; version: string };
  policyDefaults?: Record<string, unknown>;
  /** Product-specific recipes admitted only for nodes added by this overlay. */
  recipes?: readonly string[];
  additions?: readonly { slot: string; nodes: readonly GraphNodeSpec[] }[];
  /** Parsed explicitly so a destructive JSON patch cannot be ignored by a lenient caller. */
  patch?: readonly { op: string; path: string; value?: unknown }[];
}
export interface ReleaseTemplatePin {
  id: string;
  version: string;
  manifestSha: string;
  graphSha: string;
  recipesSha: string;
  overlaySha: string;
}
export interface DerivedReleaseTemplate {
  graph: GraphTemplateSpec;
  policyDefaults: Record<string, unknown>;
  policy: ReleaseTemplateManifest['policy'];
  pin: ReleaseTemplatePin;
  overlayId: string;
  allowedRecipes: readonly string[];
}
export interface ReleasePolicyOverride {
  value: unknown;
  by: string;
  why: string;
  evidenceId: string;
  expiresAt?: string;
}
export interface ReleaseInstanceInput {
  version: string;
  runId: string;
  pin: ReleaseTemplatePin;
  inputs?: { cutSha?: string; commands?: Partial<Record<'cut' | 'gate' | 'triage' | 'publish' | 'npm-publish' | 'verify', readonly string[]>> };
  overrides?: Record<string, ReleasePolicyOverride>;
}

export interface BoundReleaseInstance {
  version: string;
  runId: string;
  pin: ReleaseTemplatePin;
  inputs: NonNullable<ReleaseInstanceInput['inputs']>;
  policy: Record<string, unknown>;
  route: { executor: 'local' | 'remote-hosts' | 'pod-pool'; destination: string; shards: number };
  events: readonly { event: 'graph.policy-override'; key: string; from: unknown; to: unknown; by: string; evidenceId: string }[];
}

export interface ReleaseInstanceDispatchRequest {
  graph: GraphTemplateSpec;
  instance: BoundReleaseInstance;
  ledgerPath: string;
  destination: string;
  shards: number;
}
export type ReleaseInstanceRouteHandler = (request: ReleaseInstanceDispatchRequest) => unknown | Promise<unknown>;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const validVersion = (value: string): boolean => /^\d+\.\d+\.\d+$/.test(value);
const compareVersion = (left: string, right: string): number => {
  if (!validVersion(left) || !validVersion(right)) throw new Error('invalid release version');
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

function validatePolicy(key: string, definition: ReleasePolicyDefinition, value: unknown, releaseVersion?: string): void {
  const type = definition.type;
  if (type === 'int') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`policy type mismatch: ${key}`);
    if (definition.bounds && (value < Number(definition.bounds[0]) || value > Number(definition.bounds[1]))) throw new Error(`policy bounds: ${key}`);
  } else if (type === 'enum') {
    if (typeof value !== 'string' || !definition.bounds?.includes(value)) throw new Error(`policy bounds: ${key}`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`policy type mismatch: ${key}`);
  } else if (type === 'ref') {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`policy type mismatch: ${key}`);
  } else if (type === 'accept-item[]') {
    if (!Array.isArray(value)) throw new Error(`policy type mismatch: ${key}`);
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`policy accept item invalid: ${key}`);
      const row = item as Record<string, unknown>;
      if (['id', 'rule', 'evidenceId', 'expiresAt'].some((field) => typeof row[field] !== 'string' || !(row[field] as string).trim())) {
        throw new Error(`policy accept item missing evidence or expiry: ${key}`);
      }
      if (releaseVersion && compareVersion(row.expiresAt as string, releaseVersion) <= 0) throw new Error(`policy accept item expired: ${key}`);
    }
  } else throw new Error(`unsupported policy type: ${key}`);
}

/** Add only at a named edge; the original nodes and exits cannot be removed or replaced. */
export function deriveReleaseTemplate(input: {
  manifest: ReleaseTemplateManifest;
  graph: GraphTemplateSpec;
  graphSource: string;
  recipesSource: string;
  overlay: ReleaseTemplateOverlay;
}): DerivedReleaseTemplate {
  const { manifest, overlay } = input;
  if (manifest.id !== overlay.base.id || manifest.version !== overlay.base.version || manifest.id !== input.graph.graphId) {
    throw new Error('derive base identity mismatch');
  }
  if (overlay.patch?.some((operation) => operation.op !== 'add')) throw new Error('derive is add-only');
  if (overlay.patch?.length) throw new Error('derive patch must use declared additions');
  const parsedGraph = parseGraphTemplateYaml(input.graphSource, 'release-template');
  if (parsedGraph.errors.length || !parsedGraph.template || JSON.stringify(parsedGraph.template) !== JSON.stringify(input.graph)) {
    throw new Error('graph source mismatch');
  }
  let recipeDefinitions: unknown;
  try { recipeDefinitions = parseYaml(input.recipesSource); } catch { throw new Error('recipe source invalid'); }
  if (!recipeDefinitions || typeof recipeDefinitions !== 'object' || Array.isArray(recipeDefinitions)) throw new Error('recipe source invalid');
  const policyDefaults: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(manifest.policy)) {
    validatePolicy(key, definition, definition.default);
    policyDefaults[key] = structuredClone(definition.default);
  }
  for (const [key, value] of Object.entries(overlay.policyDefaults ?? {})) {
    const definition = manifest.policy[key];
    if (!definition) throw new Error(`undeclared policy: ${key}`);
    if (definition.scope === 'instance') throw new Error(`instance-only policy: ${key}`);
    validatePolicy(key, definition, value);
    policyDefaults[key] = structuredClone(value);
  }
  const nodes = [...input.graph.nodes];
  const edges = [...input.graph.edges];
  const manifestRecipes = new Set(manifest.allow?.recipes ?? []);
  const overlayRecipes = new Set(overlay.recipes ?? []);
  const allowedRecipes = new Set([...manifestRecipes, ...overlayRecipes]);
  const recipes = recipeDefinitions as Record<string, Record<string, unknown>>;
  const validateRecipe = (recipe: string, declarations: ReadonlySet<string>): void => {
    if (recipe === 'none') return;
    const [kind, name] = recipe.split(':');
    const field = kind === 'cmd' ? 'command' : kind === 'approval' ? 'approval' : undefined;
    const definition = recipes[name ?? '']?.[field ?? ''];
    if (!field || !declarations.has(recipe) || typeof definition !== 'string' || !definition.trim()) {
      throw new Error(`recipe source missing executable definition: ${recipe}`);
    }
  };
  for (const node of input.graph.nodes) validateRecipe(node.recipe, manifestRecipes);
  const occupied = new Set(nodes.map((node) => node.nodeId));
  const usedSlots = new Set<string>();
  for (const addition of overlay.additions ?? []) {
    const slot = manifest.extensionPoints[addition.slot];
    if (!slot || usedSlots.has(addition.slot) || !addition.nodes.length) throw new Error(`undeclared or duplicate derive slot: ${addition.slot}`);
    usedSlots.add(addition.slot);
    const edgeIndex = edges.findIndex((edge) => edge.from === slot.after && edge.on === 'outcome' && edge.map?.ok === slot.before);
    if (edgeIndex < 0) throw new Error(`derive slot edge missing: ${addition.slot}`);
    if (!input.graph.terminalNodes.includes(slot.failure)) throw new Error(`derive failure terminal missing: ${addition.slot}`);
    for (const node of addition.nodes) {
      if (occupied.has(node.nodeId) || !node.contract || !node.recipe) throw new Error(`derive node identity or contract invalid: ${node.nodeId}`);
      if (!overlay.recipes?.includes(node.recipe)) throw new Error(`derive recipe not declared: ${node.recipe}`);
      validateRecipe(node.recipe, overlayRecipes);
      occupied.add(node.nodeId);
      nodes.push(node);
    }
    const prior = edges[edgeIndex]!;
    edges[edgeIndex] = { ...prior, map: { ...prior.map, ok: addition.nodes[0]!.nodeId } };
    const chain = [...addition.nodes.map((node) => node.nodeId), slot.before];
    for (let i = 0; i < addition.nodes.length; i += 1) {
      edges.push({ from: chain[i]!, on: 'outcome', map: { ok: chain[i + 1]!, fail: slot.failure, error: slot.failure } });
    }
  }
  return {
    graph: { ...input.graph, nodes, edges }, policyDefaults, policy: manifest.policy, overlayId: overlay.id,
    allowedRecipes: [...allowedRecipes],
    pin: { id: manifest.id, version: manifest.version, manifestSha: sha(JSON.stringify(manifest)), graphSha: sha(input.graphSource),
      recipesSha: sha(input.recipesSource), overlaySha: sha(JSON.stringify(overlay)) },
  };
}

/** Bind one release run; neither its values nor ARG additions are written back to the template. */
export function bindReleaseInstance(derived: DerivedReleaseTemplate, input: ReleaseInstanceInput): BoundReleaseInstance {
  if (!validVersion(input.version) || !/^run-[A-Za-z0-9_-]{4,64}$/.test(input.runId)) throw new Error('invalid release instance identity');
  if (input.inputs?.cutSha && !/^[a-f0-9]{40}$/i.test(input.inputs.cutSha)) throw new Error('invalid cut sha');
  for (const [step, command] of Object.entries(input.inputs?.commands ?? {})) {
    if (!['cut', 'gate', 'triage', 'publish', 'npm-publish', 'verify'].includes(step) || !Array.isArray(command) || !command.length
      || command.some((arg) => typeof arg !== 'string' || !arg.trim())) throw new Error(`invalid release command: ${step}`);
  }
  if (JSON.stringify(input.pin) !== JSON.stringify(derived.pin)) throw new Error('template pin mismatch');
  const policy = structuredClone(derived.policyDefaults);
  const events: Array<{ event: 'graph.policy-override'; key: string; from: unknown; to: unknown; by: string; evidenceId: string }> = [];
  for (const [key, override] of Object.entries(input.overrides ?? {})) {
    const definition = derived.policy[key];
    if (!definition) throw new Error(`undeclared policy: ${key}`);
    if (!override || !override.by?.trim() || !override.why?.trim() || !override.evidenceId?.trim()) throw new Error(`policy override evidence missing: ${key}`);
    if (override.expiresAt && compareVersion(override.expiresAt, input.version) <= 0) throw new Error(`policy override expired: ${key}`);
    validatePolicy(key, definition, override.value, input.version);
    events.push({ event: 'graph.policy-override', key, from: policy[key], to: override.value, by: override.by, evidenceId: override.evidenceId });
    policy[key] = structuredClone(override.value);
  }
  const executor = policy.executor;
  const shards = policy.shards;
  if (!['local', 'remote-hosts', 'pod-pool'].includes(String(executor)) || typeof shards !== 'number') throw new Error('release executor policy missing');
  const destination = executor === 'remote-hosts' ? policy['fanout.hosts'] : executor === 'pod-pool' ? policy['pod.pool'] : 'local';
  if (typeof destination !== 'string' || !destination.trim() || (executor !== 'local' && destination === 'none')) {
    throw new Error('release executor destination missing');
  }
  return { version: input.version, runId: input.runId, pin: { ...derived.pin }, inputs: structuredClone(input.inputs ?? {}), policy, events,
    route: { executor: executor as BoundReleaseInstance['route']['executor'], destination, shards } };
}

/** Persist the binding and every override decision in this version's instance ledger. */
export function recordGraphInstance(instance: BoundReleaseInstance, root: string): string {
  const dir = join(root, 'release', instance.version);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `graph-instance-${instance.runId}.jsonl`);
  const rows = [
    { event: 'graph.instance-bound', runId: instance.runId, version: instance.version, pin: instance.pin,
      inputs: instance.inputs, policy: instance.policy, route: instance.route },
    ...instance.events.map((event) => ({ ...event, runId: instance.runId, version: instance.version })),
  ];
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { flag: 'wx' });
  return path;
}

/** Select the actual executor route; runtime-specific dispatch remains behind the injected port boundary. */
export async function dispatchReleaseInstance(input: {
  derived: DerivedReleaseTemplate;
  instance: BoundReleaseInstance;
  root: string;
  executors: Record<BoundReleaseInstance['route']['executor'], ReleaseInstanceRouteHandler>;
}): Promise<{ ledgerPath: string; result: unknown }> {
  if (JSON.stringify(input.instance.pin) !== JSON.stringify(input.derived.pin)) throw new Error('template pin mismatch');
  const handler = input.executors[input.instance.route.executor];
  if (typeof handler !== 'function') throw new Error(`release executor unavailable: ${input.instance.route.executor}`);
  const ledgerPath = recordGraphInstance(input.instance, input.root);
  const result = await handler({ graph: input.derived.graph, instance: input.instance, ledgerPath,
    destination: input.instance.route.destination, shards: input.instance.route.shards });
  return { ledgerPath, result };
}
