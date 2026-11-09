import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parsePluginManifest, type PluginManifest } from '../plugins/core/manifest.js';
import { parseGraphTemplateYaml, type GraphTemplateSpec } from '../self-implement/graph-yaml.js';

export interface GraphManifestDeclaration {
  graphId: string;
  purpose: string;
  allow: { recipes: string[]; skills: string[]; domainPacks: string[]; maxSideEffects?: 'none' | 'write' | 'spawn' };
  policy?: Record<string, unknown>;
  hitl: string[];
  observe?: { categories: string[] };
  [key: string]: unknown;
}

const EDGE_KEYS = new Set(['from', 'to', 'on', 'map', 'branches', 'join', 'warning_branches', 'fallback', 'observed', 'when']);
const POLICY_TYPES = new Set(['string', 'enum', 'enum[]', 'int', 'number', 'boolean', 'glob[]', 'versions', 'accept-item[]', 'ref']);

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim().length > 0)) {
    throw new Error(`${label} must be a string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value as string[];
}

function policyDefaultMatches(type: string, value: unknown, definition: Record<string, unknown>): boolean {
  const choices = Array.isArray(definition.values) ? definition.values : definition.bounds;
  switch (type) {
    case 'string': case 'ref': return typeof value === 'string';
    case 'enum': return typeof value === 'string' && Array.isArray(choices) && choices.includes(value);
    case 'enum[]': return Array.isArray(value) && value.every(item => typeof item === 'string') &&
      Array.isArray(choices) && value.every(item => choices.includes(item));
    case 'int': case 'versions':
      return typeof value === 'number' && Number.isSafeInteger(value) &&
        (!Array.isArray(definition.bounds) || (typeof definition.bounds[0] === 'number' && typeof definition.bounds[1] === 'number' &&
          value >= definition.bounds[0] && value <= definition.bounds[1]));
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) &&
        (!Array.isArray(definition.bounds) || (typeof definition.bounds[0] === 'number' && typeof definition.bounds[1] === 'number' &&
          value >= definition.bounds[0] && value <= definition.bounds[1]));
    case 'boolean': return typeof value === 'boolean';
    case 'glob[]': return Array.isArray(value) && value.every(item => typeof item === 'string');
    case 'accept-item[]': return Array.isArray(value) && value.every(item => item !== null && typeof item === 'object' && !Array.isArray(item));
    default: return false;
  }
}

function validatePolicy(policyValue: unknown, graphId: string): Record<string, unknown> {
  const policy = policyValue === undefined ? {} : record(policyValue, `graphManifests.${graphId}.policy`);
  for (const [key, value] of Object.entries(policy)) {
    const definition = record(value, `graphManifests.${graphId}.policy.${key}`);
    const type = definition.type;
    if (typeof type !== 'string' || !POLICY_TYPES.has(type)) throw new Error(`graphManifests.${graphId}.policy.${key}.type is unsupported`);
    if (!Object.hasOwn(definition, 'default') || !policyDefaultMatches(type, definition.default, definition)) {
      throw new Error(`graphManifests.${graphId}.policy.${key}.default does not match ${type}`);
    }
    if (definition.bounds !== undefined && !Array.isArray(definition.bounds) &&
      (definition.bounds === null || typeof definition.bounds !== 'object')) {
      throw new Error(`graphManifests.${graphId}.policy.${key}.bounds must be an array or object`);
    }
  }
  return policy;
}

function collectPolicyReferences(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$policy\.([A-Za-z0-9_.-]+)/g)) out.add(match[1]!);
  } else if (Array.isArray(value)) {
    for (const item of value) collectPolicyReferences(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPolicyReferences(item, out);
  }
}

function validateEdgeVocabulary(rawGraph: unknown, graphId: string): void {
  const document = record(rawGraph, `graph ${graphId}`);
  if (!Array.isArray(document.edges)) throw new Error(`graph ${graphId}.edges must be an array`);
  for (const [index, rawEdge] of document.edges.entries()) {
    const edge = record(rawEdge, `graph ${graphId}.edges[${index}]`);
    for (const key of Object.keys(edge)) {
      if (!EDGE_KEYS.has(key)) throw new Error(`graph ${graphId}.edges[${index}] uses unsupported edge vocabulary: ${key}`);
    }
  }
}

/** Use the same check for initial nodes and nodes appended while a run is active. */
export function assertGraphManifestRecipeAllowed(manifest: GraphManifestDeclaration, recipe: string, recipeIds: ReadonlySet<string> = new Set()): void {
  if (recipe === 'none' || recipe.startsWith('approval:')) return;
  if (manifest.allow.recipes.includes(recipe)) return;
  if (recipe.startsWith('cmd:') && manifest.allow.recipes.includes(recipe.slice(4))) return;
  if (recipe.startsWith('cmd:') && manifest.allow.recipes.includes('cmd:*@./recipes.yaml') && recipeIds.has(recipe.slice(4))) return;
  throw new Error(`graph.manifest-denied: recipe ${recipe}`);
}

/** Validate the graph that will execute, not only the file used to discover its manifest. */
export function assertGraphManifestTemplate(manifest: GraphManifestDeclaration, template: GraphTemplateSpec): void {
  if (template.graphId !== manifest.graphId) throw new Error(`graph.manifest-denied: graph_id ${template.graphId}`);
  const hitlNodes = template.nodes.filter(node => node.kind === 'hitl').map(node => node.nodeId);
  if (hitlNodes.length !== manifest.hitl.length || hitlNodes.some(node => !manifest.hitl.includes(node))) {
    throw new Error(`graphManifests.${manifest.graphId}.hitl differs from executable graph hitl nodes`);
  }
}

function graphRecipeIds(root: string, file: string): Set<string> {
  const recipeFile = graphFile(root, relative(root, join(dirname(file), 'recipes.yaml')));
  const recipes = parseYaml(readFileSync(recipeFile, 'utf8')) as unknown;
  if (!recipes || typeof recipes !== 'object' || Array.isArray(recipes)) throw new Error(`invalid recipes for ${file}`);
  return new Set(Object.keys(recipes));
}

export interface LoadedGraphPlugin {
  plugin: PluginManifest;
  graphs: Record<string, { file: string; template: GraphTemplateSpec; manifest: GraphManifestDeclaration }>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Resolve a graph asset inside its plugin root, including symlink targets. */
function graphFile(root: string, asset: string): string {
  if (isAbsolute(asset)) throw new Error(`graph asset escapes plugin root: ${asset}`);
  const candidate = resolve(root, asset);
  const lexical = relative(root, candidate);
  if (lexical === '..' || lexical.startsWith('../') || isAbsolute(lexical)) {
    throw new Error(`graph asset escapes plugin root: ${asset}`);
  }
  const file = realpathSync(candidate);
  const actual = relative(realpathSync(root), file);
  if (actual === '..' || actual.startsWith('../') || isAbsolute(actual)) {
    throw new Error(`graph asset escapes plugin root through symlink: ${asset}`);
  }
  return file;
}

/** Load any declared graph plugin; graph IDs come from YAML, not filenames or a release-only registry. */
export function loadGraphPluginFromDir(pluginDir: string): LoadedGraphPlugin {
  const root = realpathSync(pluginDir);
  const manifestPath = graphFile(root, 'plugin.json');
  const raw = record(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
  const plugin = parsePluginManifest(raw, { fallbackId: typeof raw.name === 'string' ? raw.name : undefined });
  const extension = record(record(raw.extensions, 'extensions')['ai.elanous'], 'extensions["ai.elanous"]');
  const declarations = record(extension.graphManifests, 'extensions["ai.elanous"].graphManifests');
  const assets = plugin.contributes.graphs ?? [];
  if (assets.length === 0) throw new Error(`graph plugin declares no graphs: ${manifestPath}`);
  const graphs: LoadedGraphPlugin['graphs'] = Object.create(null) as LoadedGraphPlugin['graphs'];
  for (const asset of assets) {
    const file = graphFile(root, asset);
    const source = readFileSync(file, 'utf8');
    const rawGraph = parseYaml(source) as unknown;
    const parsed = parseGraphTemplateYaml(source, file);
    if (!parsed.template || parsed.errors.length > 0) {
      throw new Error(`invalid graph ${file}: ${parsed.errors.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`);
    }
    const id = parsed.template.graphId;
    if (graphs[id]) throw new Error(`duplicate graph_id '${id}' in ${manifestPath}`);
    const declaration = record(declarations[id], `graphManifests.${id}`);
    if (typeof declaration.purpose !== 'string' || !declaration.purpose.trim()) {
      throw new Error(`graphManifests.${id}.purpose must be a nonempty string`);
    }
    const allow = record(declaration.allow, `graphManifests.${id}.allow`);
    const recipes = stringList(allow.recipes, `graphManifests.${id}.allow.recipes`);
    const skills = stringList(allow.skills ?? [], `graphManifests.${id}.allow.skills`);
    const domainPacks = stringList(allow.domainPacks ?? [], `graphManifests.${id}.allow.domainPacks`);
    const maxSideEffects = allow.maxSideEffects;
    if (maxSideEffects !== undefined && !['none', 'write', 'spawn'].includes(String(maxSideEffects))) {
      throw new Error(`graphManifests.${id}.allow.maxSideEffects is unsupported`);
    }
    const hitl = stringList(declaration.hitl, `graphManifests.${id}.hitl`);
    const policy = validatePolicy(declaration.policy, id);
    const observe = declaration.observe === undefined ? undefined : record(declaration.observe, `graphManifests.${id}.observe`);
    const categories = observe === undefined ? undefined : stringList(observe.categories, `graphManifests.${id}.observe.categories`);
    const graphManifest: GraphManifestDeclaration = {
      ...declaration,
      graphId: id,
      purpose: declaration.purpose,
      allow: { recipes, skills, domainPacks, ...(maxSideEffects ? { maxSideEffects: maxSideEffects as 'none' | 'write' | 'spawn' } : {}) },
      policy,
      hitl,
      ...(categories ? { observe: { categories } } : {}),
    };
    validateEdgeVocabulary(rawGraph, id);
    const policyRefs = new Set<string>();
    collectPolicyReferences(rawGraph, policyRefs);
    for (const reference of policyRefs) {
      if (!Object.hasOwn(policy, reference)) throw new Error(`graph ${id} references undeclared policy key: ${reference}`);
    }
    const hitlNodes = parsed.template.nodes.filter(node => node.kind === 'hitl').map(node => node.nodeId);
    if (new Set(hitl).size !== hitl.length ||
      hitlNodes.length !== hitl.length || hitlNodes.some(node => !hitl.includes(node))) {
      throw new Error(`graphManifests.${id}.hitl differs from graph hitl nodes`);
    }
    const recipeIds = recipes.includes('cmd:*@./recipes.yaml') ? graphRecipeIds(root, file) : new Set<string>();
    for (const node of parsed.template.nodes) assertGraphManifestRecipeAllowed(graphManifest, node.recipe, recipeIds);
    graphs[id] = { file, template: parsed.template, manifest: graphManifest };
  }
  for (const id of Object.keys(declarations)) {
    if (!graphs[id]) throw new Error(`graphManifests.${id} has no declared graph asset`);
  }
  return { plugin, graphs };
}

/** Existing graphs without a graph manifest remain valid during the 0.3.8 transition. */
export function loadGraphManifestForFile(graphPath: string, graphId: string): GraphManifestDeclaration | undefined {
  const file = realpathSync(graphPath);
  let root = dirname(file);
  while (true) {
    const path = join(root, 'plugin.json');
    if (existsSync(path)) {
      const raw = record(JSON.parse(readFileSync(path, 'utf8')), path);
      const extensionsValue = raw.extensions;
      // The nearest plugin.json establishes ownership. A legacy/null declaration
      // stays on the transition path and must not inherit an ancestor plugin's policy.
      if (extensionsValue === undefined || extensionsValue === null) return undefined;
      const extensions = record(extensionsValue, 'extensions');
      const extensionValue = extensions['ai.elanous'];
      if (extensionValue === undefined || extensionValue === null) return undefined;
      const extension = record(extensionValue, 'extensions["ai.elanous"]');
      const declarations = extension.graphManifests;
      if (declarations === undefined || declarations === null) return undefined;
      const loaded = loadGraphPluginFromDir(root);
      const declared = Object.values(loaded.graphs).find(graph => graph.file === file);
      if (!declared) throw new Error(`graph.manifest-denied: undeclared graph asset ${file}`);
      if (declared.template.graphId !== graphId) throw new Error(`graph.manifest-denied: graph_id ${graphId}`);
      return declared.manifest;
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return undefined;
}
