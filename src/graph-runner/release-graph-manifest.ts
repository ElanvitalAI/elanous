import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface ReleaseGraphManifest {
  name: string;
  version: string;
  identity: string;
  purpose: string;
  inputs: readonly string[];
  graph: string;
  graphSources: readonly string[];
  nodeIds: readonly string[];
  recipes: readonly string[];
  skills: readonly string[];
  domainPacks: readonly string[];
  domainPackRules: readonly string[];
  hitlNodes: readonly string[];
  policies: Readonly<Record<string, { type: 'string' | 'integer' | 'boolean' | 'string-list'; default: unknown; allowed?: readonly unknown[]; allowedValues?: readonly string[]; minimum?: number; maximum?: number }>>;
  edgeVocabulary: readonly string[];
  observations: readonly string[];
  terminalStates: readonly string[];
  schema: { graphId: string; requiredGraphFields: readonly string[]; nodeKinds: readonly string[]; edgeTriggers: readonly string[]; terminalStates: readonly string[]; recipePrefixes: readonly string[] };
}

export function loadReleaseGraphManifest(path: string): ReleaseGraphManifest {
  const plugin = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string; extensions?: { 'ai.elanous'?: Record<string, unknown> } };
  const extension = plugin.extensions?.['ai.elanous'];
  if (!plugin.name || !plugin.version || !extension) throw new Error('release graph plugin manifest requires name, version and ai.elanous extension');
  if (typeof extension.identity !== 'string' || !extension.identity.trim()) throw new Error('release graph plugin manifest requires ai.elanous identity');
  const declarations = extension.graphManifests as Record<string, Record<string, unknown>> | undefined;
  const declaration = declarations?.['release-loop'];
  const allow = declaration?.allow as Record<string, unknown> | undefined;
  if (!declaration || typeof declaration.purpose !== 'string' || !allow)
    throw new Error('release graph requires graphManifests.release-loop declaration');
  const base = resolve(path, '..');
  const resolveEntry = (entry: unknown, field: string): string => {
    if (typeof entry !== 'string' || isAbsolute(entry)) throw new Error(`${field} must be a relative manifest path`);
    return resolve(base, entry);
  };
  const strings = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) throw new Error(`${field} must be a string list`);
    return value;
  };
  const graphEntries = strings(extension.graphs, 'graphs');
  const graphEntry = graphEntries[0];
  if (typeof graphEntry !== 'string') throw new Error('release graph manifest requires one graph template');
  const schemaPath = resolveEntry(extension.graphSchema, 'graphSchema');
  const policies = Object.fromEntries(Object.entries(declaration.policy as Record<string, { type: string; default: unknown; bounds?: number[]; values?: string[] }> ?? {}).map(([key, policy]) => {
    const type = policy.type === 'int' ? 'integer' : policy.type === 'enum[]' ? 'string-list' : policy.type;
    const [minimum, maximum] = policy.bounds ?? [];
    return [key, { type, default: policy.default, ...(policy.values ? { allowedValues: policy.values } : {}),
      ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) }];
  })) as ReleaseGraphManifest['policies'];
  const edgePath = resolveEntry(extension.edgeVocabulary, 'edgeVocabulary');
  const graph = parseYaml(readFileSync(resolveEntry(graphEntry, 'graph'), 'utf8')) as { graph_id?: string; nodes?: Array<{ node_id?: string; recipe?: string; kind?: string }>;
    loop?: { trigger?: { events?: unknown } } };
  const schema = parseYaml(readFileSync(schemaPath, 'utf8')) as Partial<ReleaseGraphManifest['schema']> & { apiVersion?: string };
  const edgeDoc = parseYaml(readFileSync(edgePath, 'utf8')) as { edges?: Record<string, unknown> };
  const recipes = strings(allow.recipes, 'graphManifests.release-loop.allow.recipes');
  const skills = strings(allow.skills, 'graphManifests.release-loop.allow.skills');
  const domainPacks = strings(allow.domainPacks, 'graphManifests.release-loop.allow.domainPacks');
  const domainPackFiles = strings(extension.domainPackFiles, 'domainPackFiles').map((entry) => resolveEntry(entry, 'domainPackFiles'));
  const domainPackRules: string[] = [];
  for (const domainPackPath of domainPackFiles) {
    const pack = parseYaml(readFileSync(domainPackPath, 'utf8')) as { apiVersion?: string; id?: string; numericAssertions?: Array<{ id?: string; rule?: string }> };
    if (pack.apiVersion !== 'elanous.dev/domain-pack/v1' || !pack.id || !domainPacks.includes(pack.id)
      || !Array.isArray(pack.numericAssertions) || pack.numericAssertions.some(({ id, rule }) => !id || !rule?.trim()))
      throw new Error(`invalid or undeclared release graph domain pack: ${domainPackPath}`);
    domainPackRules.push(...pack.numericAssertions.map(({ id }) => `${pack.id}:${id}`));
  }
  if (new Set(domainPackRules).size !== domainPackRules.length) throw new Error('release graph domain pack rule ids must be unique');
  const hitlNodes = strings(declaration.hitl, 'graphManifests.release-loop.hitl');
  const observe = declaration.observe as { categories?: unknown } | undefined;
  const observations = strings(observe?.categories, 'graphManifests.release-loop.observe.categories');
  const inputs = strings(extension.inputs, 'inputs');
  if (typeof declaration.purpose !== 'string' || !declaration.purpose.trim())
    throw new Error('release graph manifest requires purpose');
  const graphInputs = graph.loop?.trigger?.events;
  if (!Array.isArray(graphInputs) || JSON.stringify([...inputs].sort()) !== JSON.stringify([...graphInputs].sort()))
    throw new Error('release graph manifest inputs must match graph trigger events');
  const terminal = declaration.terminal as Record<string, unknown> | undefined;
  const terminalStates = Object.keys(terminal ?? {});
  const edgeVocabulary = Object.keys(edgeDoc.edges ?? {});
  const schemaLists = ['requiredGraphFields', 'nodeKinds', 'edgeTriggers', 'terminalStates', 'recipePrefixes'] as const;
  if (schema.apiVersion !== 'elanous.dev/release-graph-schema/v1' || typeof schema.graphId !== 'string'
    || schemaLists.some((key) => !Array.isArray(schema[key]) || schema[key]!.some((value) => typeof value !== 'string' || !value)))
    throw new Error('release graph schema declaration is invalid');
  const graphRecord = graph as typeof graph & Record<string, unknown>;
  for (const field of schema.requiredGraphFields!) if (!Object.hasOwn(graphRecord, field)) throw new Error(`graph schema requires field: ${field}`);
  if (!graph.graph_id || graph.graph_id !== schema.graphId || !Array.isArray(graph.nodes)
    || typeof graphRecord.entry_node !== 'string' || !Array.isArray(graphRecord.terminal_nodes)) throw new Error('graph template identity or nodes do not match schema');
  const nodeIds = new Set<string>();
  const recipeIds = new Set(recipes);
  for (const node of graph.nodes) {
    if (!node.node_id || nodeIds.has(node.node_id)) throw new Error(`graph schema requires unique node ids: ${node.node_id ?? 'missing'}`);
    nodeIds.add(node.node_id);
    if (!node.kind || !schema.nodeKinds!.includes(node.kind)) throw new Error(`graph schema rejects node kind: ${node.kind ?? 'missing'}`);
    const recipe = node.recipe ?? 'none';
    if (recipe !== 'none') {
      const separator = recipe.indexOf(':');
      const prefix = separator < 0 ? '' : recipe.slice(0, separator);
      const recipeId = separator < 0 ? '' : recipe.slice(separator + 1);
      if (!schema.recipePrefixes!.includes(prefix) || !recipeId || !recipeIds.has(recipeId)) throw new Error(`undeclared recipe: ${recipe}`);
    }
    if (node.kind === 'hitl' && !hitlNodes.includes(node.node_id ?? '')) throw new Error(`undeclared HITL node: ${node.node_id}`);
  }
  if (!nodeIds.has(graphRecord.entry_node as string)) throw new Error(`graph schema rejects entry node: ${String(graphRecord.entry_node)}`);
  for (const node of hitlNodes) if (!nodeIds.has(node)) throw new Error(`HITL node is absent from graph template: ${node}`);
  const graphEdges = graphRecord.edges;
  if (!Array.isArray(graphEdges)) throw new Error('graph schema requires edges');
  for (const edge of graphEdges as Array<{ from?: string; on?: string; to?: string; map?: Record<string, string> }>) {
    if (!edge.from || !nodeIds.has(edge.from) || (edge.to && !nodeIds.has(edge.to))) throw new Error(`graph schema rejects edge endpoint: ${edge.from ?? 'missing'}`);
    if (edge.on && !schema.edgeTriggers!.includes(edge.on)) throw new Error(`graph schema rejects edge trigger: ${edge.on}`);
    for (const target of Object.values(edge.map ?? {})) if (!nodeIds.has(target)) throw new Error(`graph schema rejects edge target: ${target}`);
  }
  const templateTerminals = graphRecord.terminal_nodes as unknown[];
  if (templateTerminals.some((nodeId) => typeof nodeId !== 'string' || !nodeIds.has(nodeId))
    || JSON.stringify([...schema.terminalStates!].sort()) !== JSON.stringify([...terminalStates].sort())
    || JSON.stringify([...schema.terminalStates!].sort()) !== JSON.stringify(templateTerminals.slice().sort()))
    throw new Error('graph schema, manifest and template terminal states must match');
  for (const [index, source] of graphEntries.slice(1).map((entry, index) => [index + 1, readFileSync(resolveEntry(entry, 'graphs'), 'utf8')] as const)) {
    const alternate = parseYaml(source) as Record<string, unknown>;
    if (alternate.graph_id !== schema.graphId || !Array.isArray(alternate.nodes) || !Array.isArray(alternate.edges)
      || !Array.isArray(alternate.terminal_nodes) || !alternate.terminal_nodes.every((nodeId) => templateTerminals.includes(nodeId)))
      throw new Error(`declared release graph variant ${index} does not match graph schema identity`);
    const alternateIds = new Set<string>();
    for (const candidate of alternate.nodes as Array<{ node_id?: string; kind?: string; recipe?: string }>) {
      if (!candidate.node_id || alternateIds.has(candidate.node_id) || !candidate.kind || !schema.nodeKinds!.includes(candidate.kind))
        throw new Error(`declared release graph variant ${index} has invalid node`);
      alternateIds.add(candidate.node_id);
      const recipe = candidate.recipe ?? 'none';
      const recipeId = recipe.includes(':') ? recipe.slice(recipe.indexOf(':') + 1) : '';
      if (recipe !== 'none' && !recipeIds.has(recipeId)) throw new Error(`declared release graph variant ${index} uses undeclared recipe: ${recipe}`);
      if (candidate.kind === 'hitl' && !hitlNodes.includes(candidate.node_id)) throw new Error(`declared release graph variant ${index} has undeclared HITL node: ${candidate.node_id}`);
    }
    if (!alternateIds.has(String(alternate.entry_node)) || JSON.stringify([...alternate.terminal_nodes].sort()) !== JSON.stringify([...templateTerminals].sort()))
      throw new Error(`declared release graph variant ${index} has incompatible entry or terminal nodes`);
    for (const edge of alternate.edges as Array<{ from?: string; on?: string; to?: string; map?: Record<string, string> }>) {
      if (!edge.from || !alternateIds.has(edge.from) || (edge.to && !alternateIds.has(edge.to))
        || (edge.on && !schema.edgeTriggers!.includes(edge.on))
        || Object.values(edge.map ?? {}).some((target) => !alternateIds.has(target)))
        throw new Error(`declared release graph variant ${index} has an invalid edge`);
    }
  }
  for (const [key, policy] of Object.entries(policies)) {
    if (!['string', 'integer', 'boolean', 'string-list'].includes(policy.type)) throw new Error(`invalid policy type: ${key}`);
    if (policy.type === 'integer' && (!Number.isInteger(policy.default) || (policy.minimum !== undefined && Number(policy.default) < policy.minimum)
      || (policy.maximum !== undefined && Number(policy.default) > policy.maximum))) throw new Error(`invalid policy default: ${key}`);
    if (policy.type === 'string-list' && (!Array.isArray(policy.default) || policy.default.some((item) => typeof item !== 'string')
      || new Set(policy.default).size !== policy.default.length || policy.default.some((item) => policy.allowedValues && !policy.allowedValues.includes(item))))
      throw new Error(`invalid policy default: ${key}`);
    if (policy.allowed && !policy.allowed.includes(policy.default)) throw new Error(`policy default is outside allowlist: ${key}`);
  }
  const graphSources = graphEntries.map((entry) => readFileSync(resolveEntry(entry, 'graphs'), 'utf8'));
  return { name: plugin.name, version: plugin.version, identity: extension.identity, purpose: declaration.purpose, inputs,
    graph: graph.graph_id, graphSources, nodeIds: [...nodeIds], recipes, skills, domainPacks, domainPackRules, hitlNodes,
    policies, edgeVocabulary, observations, terminalStates, schema: schema as ReleaseGraphManifest['schema'] };
}

export function assertReleaseRecipeAllowed(manifest: ReleaseGraphManifest, recipe: string): void {
  if (!manifest.recipes.includes(recipe)) throw new Error(`release graph manifest rejects undeclared recipe: ${recipe}`);
}

/** A release run must execute one of the exact graph sources declared by its plugin manifest. */
export function assertReleaseGraphSourceAllowed(manifest: ReleaseGraphManifest, source: string, allowRunnerDerivedFanout = false): void {
  if (manifest.graphSources.includes(source)) return;
  if (allowRunnerDerivedFanout) {
    const candidate = parseYaml(source) as Record<string, unknown>;
    for (const templateSource of manifest.graphSources) {
      const template = parseYaml(templateSource) as Record<string, unknown>;
      const templateNodes = Array.isArray(template.nodes) ? template.nodes as Array<Record<string, unknown>> : [];
      const candidateNodes = Array.isArray(candidate.nodes) ? candidate.nodes as Array<Record<string, unknown>> : [];
      const templateNodeIds = new Set(templateNodes.map((node) => node.node_id));
      const withoutNeeds = (nodes: Array<Record<string, unknown>>) => nodes.map(({ needs: _needs, ...node }) => node);
      const done = Array.isArray(template.terminal_nodes) ? template.terminal_nodes.find((id) => id === 'done') : undefined;
      const failed = Array.isArray(template.terminal_nodes) ? template.terminal_nodes.find((id) => id === 'failed') : undefined;
      const expectedEdges = [{ from: candidate.entry_node, on: 'outcome', map: { ok: done, fail: failed, error: failed } }];
      const candidateTerminals = Array.isArray(candidate.terminal_nodes) ? [...candidate.terminal_nodes].sort() : [];
      const templateTerminals = Array.isArray(template.terminal_nodes) ? [...template.terminal_nodes].sort() : [];
      if (candidate.graph_id === template.graph_id && candidate.version === template.version
        && typeof candidate.entry_node === 'string' && templateNodeIds.has(candidate.entry_node)
        && candidateNodes.every((node) => !Object.hasOwn(node, 'needs'))
        && JSON.stringify(withoutNeeds(candidateNodes)) === JSON.stringify(withoutNeeds(templateNodes))
        && JSON.stringify(candidateTerminals) === JSON.stringify(templateTerminals)
        && JSON.stringify(candidate.edges) === JSON.stringify(expectedEdges)) return;
    }
  }
  throw new Error('release graph execution source is not bound to a declared template');
}

export function bindReleaseGraphInstance(manifest: ReleaseGraphManifest, input: {
  runId: string; graphSha: string; policyOverrides?: Readonly<Record<string, unknown>>;
}): { readonly template: string; readonly runId: string; readonly graphSha: string; readonly policies: Readonly<Record<string, unknown>> } {
  if (!input.runId.trim() || !/^[a-f0-9]{40}$/i.test(input.graphSha)) throw new Error('release graph instance requires runId and pinned graph SHA');
  const policies: Record<string, unknown> = Object.fromEntries(Object.entries(manifest.policies).map(([key, value]) => [key, value.default]));
  for (const [key, value] of Object.entries(input.policyOverrides ?? {})) {
    const spec = manifest.policies[key];
    if (!spec) throw new Error(`release graph instance rejects undeclared policy: ${key}`);
    if (spec.type === 'integer' && (!Number.isInteger(value) || (spec.minimum !== undefined && Number(value) < spec.minimum)
      || (spec.maximum !== undefined && Number(value) > spec.maximum))) throw new Error(`invalid policy override: ${key}`);
    if (spec.type === 'string-list' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string')
      || new Set(value).size !== value.length || value.some((item) => spec.allowedValues && !spec.allowedValues.includes(item))))
      throw new Error(`invalid policy override: ${key}`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') throw new Error(`invalid policy override: ${key}`);
    if (spec.type === 'string' && typeof value !== 'string') throw new Error(`invalid policy override: ${key}`);
    if (spec.allowed && !spec.allowed.includes(value)) throw new Error(`policy override is outside allowlist: ${key}`);
    policies[key] = spec.type === 'string-list' ? [...value as string[]] : value;
  }
  return { template: `${manifest.name}@${manifest.version}`, runId: input.runId, graphSha: input.graphSha, policies };
}

export function selectAppendRecheckEdge(manifest: ReleaseGraphManifest, input: {
  radiusFiles: readonly string[]; dependencyLayerChanged?: boolean; verdictFilesChanged?: boolean; closureOpaque?: boolean;
  receiptCosts?: { partialMs: number; fullMs: number; source: 'simulation-same-ledger' | 'same-ledger-receipts' };
  policyOverrides?: Readonly<Record<string, unknown>>;
}): { edge: 'append-recheck' | 'full-recheck'; promoted: string[] } {
  const instance = bindReleaseGraphInstance(manifest, { runId: 'edge-policy-evaluation', graphSha: 'a'.repeat(40),
    policyOverrides: input.policyOverrides });
  const declared = instance.policies['gate.plan.promoteToFull'];
  const validConditions = new Set(['dep-layer', 'verdict-files', 'opaque-closure', 'cost-crossover']);
  if (!Array.isArray(declared) || declared.some((condition) => typeof condition !== 'string' || !validConditions.has(condition))
    || input.radiusFiles.some((file) => !file.trim())) throw new Error('append recheck requires declared structural promotion conditions and measured paths');
  if (input.dependencyLayerChanged === undefined || input.verdictFilesChanged === undefined || input.closureOpaque === undefined)
    return { edge: 'full-recheck', promoted: [] };
  const promoted = new Set<string>();
  if (input.dependencyLayerChanged) promoted.add('dep-layer');
  if (input.verdictFilesChanged) promoted.add('verdict-files');
  if (input.closureOpaque) promoted.add('opaque-closure');
  if (input.receiptCosts) {
    const { partialMs, fullMs, source } = input.receiptCosts;
    if (!['simulation-same-ledger', 'same-ledger-receipts'].includes(source) || !Number.isFinite(partialMs) || !Number.isFinite(fullMs) || partialMs < 0 || fullMs < 0)
      throw new Error('append receipt costs require non-negative simulated measurements from the same ledger fixture');
    if (partialMs >= fullMs) promoted.add('cost-crossover');
  }
  return { edge: declared.some((condition) => promoted.has(condition)) ? 'full-recheck' : 'append-recheck', promoted: [...promoted] };
}
