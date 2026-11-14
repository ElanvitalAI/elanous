import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

type Dict = Record<string, unknown>;

function record(value: unknown, label: string): Dict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Dict;
}

function strings(value: unknown, label: string, defaultValue: string[] = []): string[] {
  const list = value === undefined ? defaultValue : value;
  if (!Array.isArray(list) || !list.every(item => typeof item === 'string' && item.trim())) {
    throw new Error(`${label} must be a string array`);
  }
  if (new Set(list).size !== list.length) throw new Error(`${label} must not contain duplicates`);
  return list as string[];
}

function graphPath(root: string, asset: string): string {
  if (!asset || asset.includes('\0') || isAbsolute(asset) || asset.split(/[\\/]/).includes('..')) {
    throw new Error(`unsafe graph asset: ${asset}`);
  }
  const path = resolve(root, asset);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`unsafe graph asset: ${asset}`);
  if (!existsSync(path)) throw new Error(`graph asset not found: ${asset}`);
  const actual = realpathSync(path);
  const rel = relative(realpathSync(root), actual);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`graph asset escapes plugin root: ${asset}`);
  return actual;
}

/** Compile a declarative plugin.yaml and its graph headers into the committed Agent Plugins JSON manifest. */
export function compilePluginYaml(pluginDir: string): string {
  const root = realpathSync(pluginDir);
  const yamlPath = join(root, 'plugin.yaml');
  const source = readFileSync(yamlPath, 'utf8');
  const raw = record(parseYaml(source), 'plugin.yaml');
  if (raw.apiVersion !== 'elanous.dev/plugin/v2') throw new Error('plugin.yaml apiVersion must be elanous.dev/plugin/v2');
  const allowedKeys = new Set(['apiVersion', 'id', 'name', 'version', 'description', 'graphs', 'graphProviders', 'capabilities', 'ext',
    'trust', 'contributes', 'skills', 'packs', 'sims', 'handlers', 'dependencies', 'httpGet']);
  const unknownKeys = Object.keys(raw).filter(key => !allowedKeys.has(key));
  if (unknownKeys.length) throw new Error(`plugin.yaml has unsupported keys: ${unknownKeys.join(', ')}`);
  const id = raw.id;
  const name = raw.name;
  const version = raw.version;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) throw new Error('plugin.yaml id is invalid');
  if (typeof name !== 'string' || !name.trim()) throw new Error('plugin.yaml name must be nonempty');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('plugin.yaml version is invalid');
  const graphAssets = strings(raw.graphs, 'plugin.yaml graphs');
  const httpGet = raw.httpGet === undefined ? undefined : record(raw.httpGet, 'plugin.yaml httpGet');
  if (httpGet && (typeof httpGet.path !== 'string' || !httpGet.path.startsWith('/v1/')
    || /[?#\\]/.test(httpGet.path) || typeof httpGet.handler !== 'string'
    || !Object.hasOwn(record(raw.handlers, 'plugin.yaml handlers'), httpGet.handler))) {
    throw new Error('plugin.yaml httpGet requires a /v1/ path and a declared handler');
  }
  if (!graphAssets.length && !httpGet) throw new Error('plugin.yaml must declare at least one graph');
  const graphProviders = raw.graphProviders === undefined ? {} : record(raw.graphProviders, 'plugin.yaml graphProviders');
  for (const [graphAsset, value] of Object.entries(graphProviders)) {
    const normalizedGraphAsset = graphAsset.replace(/^\.\//, '');
    if (!graphAssets.some(asset => asset.replace(/^\.\//, '') === normalizedGraphAsset))
      throw new Error(`plugin.yaml graphProviders references an undeclared graph: ${graphAsset}`);
    const provider = record(value, `plugin.yaml graphProviders.${graphAsset}`);
    if (typeof provider.module !== 'string' || typeof provider.factory !== 'string'
      || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(provider.factory))
      throw new Error(`plugin.yaml graphProviders.${graphAsset} requires module and factory`);
    const moduleParts = provider.module.split('/');
    if (!provider.module.startsWith('src/graph-runner/') || !provider.module.endsWith('.ts')
      || moduleParts.some(part => !part || part === '.' || part === '..'))
      throw new Error(`plugin.yaml graphProviders.${graphAsset}.module must be a shared graph-runner TypeScript module`);
  }
  const contributes = raw.contributes === undefined ? {} : record(raw.contributes, 'plugin.yaml contributes');
  const skills = raw.skills === undefined ? [] : raw.skills;
  if (!Array.isArray(skills)) throw new Error('plugin.yaml skills must be an array');
  for (const [idx, value] of skills.entries()) {
    const skill = record(value, `plugin.yaml skills[${idx}]`);
    if (typeof skill.id !== 'string' || !skill.id.trim() || typeof skill.path !== 'string') {
      throw new Error(`plugin.yaml skills[${idx}] requires id and path`);
    }
    graphPath(root, skill.path);
  }
  if (contributes.skills !== undefined) {
    if (!Array.isArray(contributes.skills)) throw new Error('plugin.yaml contributes.skills must be an array');
    for (const [idx, value] of contributes.skills.entries()) {
      if (typeof value === 'string') continue;
      const skill = record(value, `plugin.yaml contributes.skills[${idx}]`);
      if (skill.path === undefined) continue;
      if (typeof skill.path !== 'string') throw new Error(`plugin.yaml contributes.skills[${idx}].path must be a string`);
      graphPath(root, skill.path);
    }
  }
  const packs = raw.packs === undefined ? [] : raw.packs;
  if (!Array.isArray(packs)) throw new Error('plugin.yaml packs must be an array');
  for (const [idx, value] of packs.entries()) {
    const pack = record(value, `plugin.yaml packs[${idx}]`);
    if (typeof pack.id !== 'string' || !pack.id.trim() || typeof pack.path !== 'string') {
      throw new Error(`plugin.yaml packs[${idx}] requires id and path`);
    }
    graphPath(root, pack.path);
  }
  const sims = strings(raw.sims, 'plugin.yaml sims');
  for (const sim of sims) graphPath(root, sim);
  const handlers = raw.handlers === undefined ? {} : record(raw.handlers, 'plugin.yaml handlers');
  for (const [id, value] of Object.entries(handlers)) {
    const handler = record(value, `plugin.yaml handlers.${id}`);
    if (typeof handler.module !== 'string') throw new Error(`plugin.yaml handlers.${id}.module is required`);
    graphPath(root, handler.module);
  }
  if (raw.trust !== undefined && !['builtin', 'official', 'community', 'local'].includes(String(raw.trust))) {
    throw new Error('plugin.yaml trust must be builtin | official | community | local');
  }

  const graphManifests: Dict = Object.create(null) as Dict;
  for (const asset of graphAssets) {
    const file = graphPath(root, asset);
    const graph = record(parseYaml(readFileSync(file, 'utf8')), asset);
    if (graph.apiVersion !== 'elanous.dev/graph/v2') throw new Error(`${asset} apiVersion must be elanous.dev/graph/v2`);
    const header = record(graph.graph, `${asset} graph`);
    const graphId = header.id;
    const purpose = header.purpose;
    if (typeof graphId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(graphId)) throw new Error(`${asset} graph.id is invalid`);
    if (typeof purpose !== 'string' || !purpose.trim()) throw new Error(`${asset} graph.purpose must be nonempty`);
    if (Object.hasOwn(graphManifests, graphId)) throw new Error(`duplicate graph id: ${graphId}`);
    const allow = record(graph.allow ?? {}, `${asset} allow`);
    const policy = record(graph.policy ?? {}, `${asset} policy`);
    const observe = graph.observe === undefined ? undefined : record(graph.observe, `${asset} observe`);
    const hitl = strings(policy.hitl, `${asset} policy.hitl`);
    const manifestPolicy = Object.fromEntries(Object.entries(policy).filter(([key]) =>
      !['hitl', 'disclaimers', 'forbid_recipes'].includes(key)));
    graphManifests[graphId] = {
      purpose,
      allow: {
        recipes: strings(allow.recipes, `${asset} allow.recipes`),
        skills: strings(allow.skills, `${asset} allow.skills`),
        domainPacks: strings(graph.packs, `${asset} packs`),
      },
      ...(Object.keys(manifestPolicy).length ? { policy: manifestPolicy } : {}),
      hitl,
      ...(observe ? { observe: { categories: strings(observe.categories, `${asset} observe.categories`) } } : {}),
    };
  }

  const manifest = {
    $schema: 'https://antigravity.google/schemas/v1/plugin.json',
    id,
    name,
    version,
    ...(raw.dependencies === undefined ? {} : { dependencies: record(raw.dependencies, 'plugin.yaml dependencies') }),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(Object.keys(contributes).length || skills.length ? { contributes: {
      ...contributes, ...(skills.length ? { skills } : {}),
    } } : {}),
    extensions: { 'ai.elanous': {
      graphs: graphAssets,
      ...(Object.keys(graphProviders).length ? { graphProviders } : {}),
      graphManifests,
      capabilities: strings(raw.capabilities, 'plugin.yaml capabilities'),
      ...(raw.trust === undefined ? {} : { authoredTrust: raw.trust }),
      ...(packs.length ? { packs } : {}),
      ...(sims.length ? { sims } : {}),
      ...(Object.keys(handlers).length ? { handlers } : {}),
      ...(httpGet ? { httpGet } : {}),
      ...(raw.ext === undefined ? {} : { ext: record(raw.ext, 'plugin.yaml ext') }),
    } },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Read both authoring and generated forms; stale or hand-edited JSON fails closed. */
export function readPluginYamlGeneratedManifest(pluginDir: string): Dict | undefined {
  const yamlPath = join(pluginDir, 'plugin.yaml');
  if (!existsSync(yamlPath)) return undefined;
  const expected = compilePluginYaml(pluginDir);
  const jsonPath = join(pluginDir, 'plugin.json');
  if (!existsSync(jsonPath)) throw new Error('plugin.yaml requires committed generated plugin.json');
  const committed = readFileSync(jsonPath, 'utf8');
  if (committed !== expected) throw new Error('plugin.json is stale; regenerate it from plugin.yaml');
  return JSON.parse(expected) as Dict;
}
