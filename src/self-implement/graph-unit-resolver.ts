import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { parseGraphTemplateYaml, type GraphParseResult, type GraphTemplateSpec } from './graph-yaml.js';
import { flattenGraphUnits, type StaticGraphUnit } from './graph-unit-flatten.js';

export type ResolvedGraphUnit = StaticGraphUnit & {
  readonly hash: string;
  readonly source?: string;
  readonly definition?: 'standalone' | 'component';
};

export class UnitNotFoundError extends Error {
  constructor(call: string) {
    super(`unit not found: ${call}`);
    this.name = 'UnitNotFoundError';
  }
}

type UnitCandidate = (ResolvedGraphUnit & { readonly priority: 'standalone' | 'component' }) |
  { readonly path: string; readonly version: unknown; readonly error: string; readonly priority: 'standalone' | 'component' };
type UnitIndex = Map<string, UnitCandidate[]>;
type IndexCache = Map<string, UnitIndex>;

function looseTopLevelScalar(source: string, key: string): unknown {
  const match = source.match(new RegExp(`^${key}:\\s*(.*?)\\s*(?:#.*)?$`, 'm'));
  if (!match) return undefined;
  try { return (parseYaml(`value: ${match[1] ?? ''}`) as { value?: unknown }).value; }
  catch { return match[1]?.trim(); }
}

function indexUnits(dir: string): UnitIndex {
  const byId: UnitIndex = new Map();
  const yamlFiles = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return entry.isFile() && /\.ya?ml$/.test(entry.name) && entry.name !== 'recipes.yaml' && entry.name !== 'recipes.yml' ? [path] : [];
  });
  for (const path of yamlFiles(dir)) {
    const source = readFileSync(path, 'utf8');
    let header: unknown;
    try { header = parseYaml(source); }
    catch (error) {
      // A malformed YAML document can still explicitly declare a graph ID and
      // unit header. Keep that broken declaration visible to block fallback.
      const id = looseTopLevelScalar(source, 'graph_id');
      if (typeof id !== 'string') continue;
      const fileName = basename(path);
      const dedicated = fileName === `${id}.unit.yaml` || fileName === `${id}.unit.yml`;
      if (!dedicated && !/^unit\s*:/m.test(source)) continue;
      const candidates = byId.get(id) ?? [];
      candidates.push({
        path,
        version: looseTopLevelScalar(source, 'version'),
        error: `YAML parsing failed: ${error instanceof Error ? error.message : String(error)}`,
        priority: dedicated ? 'component' : 'standalone',
      });
      byId.set(id, candidates);
      continue;
    }
    if (!header || typeof header !== 'object' || Array.isArray(header)) continue;
    const document = header as Record<string, unknown>;
    const id = document.graph_id;
    if (typeof id !== 'string') continue;
    const version: unknown = document.version;
    const fileName = basename(path);
    const dedicated = fileName === `${id}.unit.yaml` || fileName === `${id}.unit.yml`;
    const profiles = document.profiles;
    const hasUnitProfile = profiles !== undefined && profiles !== null && typeof profiles === 'object' && !Array.isArray(profiles) &&
      Object.hasOwn(profiles, 'unit');
    const priority = dedicated || hasUnitProfile ? 'component' : 'standalone';
    let candidateSource = source;
    let profileError: string | undefined;
    if (profiles !== undefined) {
      if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles) || Object.keys(profiles).some((key) => key !== 'unit')) {
        profileError = 'profiles 는 unit 부품 정의만 포함할 수 있다';
      } else if (!Object.hasOwn(profiles, 'unit')) {
        profileError = 'profiles 에 unit 정의가 없다';
      } else {
        const profile = (profiles as Record<string, unknown>).unit;
        const supported = ['entry_node', 'terminal_nodes', 'nodes', 'edges', 'unit', 'max_parallel_nodes', 'allowance'];
        if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
            Object.keys(profile).some((key) => !supported.includes(key)) ||
            !Object.hasOwn(profile, 'nodes') || !Object.hasOwn(profile, 'edges')) {
          profileError = 'profiles.unit 은 nodes·edges 를 가진 부품 그래프 덮어쓰기여야 한다';
        } else {
          const merged = { ...document, ...(profile as Record<string, unknown>) };
          delete merged.profiles;
          candidateSource = stringifyYaml(merged);
        }
      }
    }
    const parsed: GraphParseResult = profileError
      ? { errors: [{ path, message: profileError }], warnings: [] }
      : parseGraphTemplateYaml(candidateSource, path);
    if (parsed.errors.length) {
      if (!Object.hasOwn(document, 'unit') && !dedicated && !hasUnitProfile) continue;
      const candidates = byId.get(id) ?? [];
      candidates.push({ path, version, priority, error: parsed.errors.map((issue) => issue.message).join('; ') || 'unit header missing' });
      byId.set(id, candidates);
      continue;
    }
    if (!parsed.template?.unit) {
      if (!dedicated && !hasUnitProfile) continue;
      const candidates = byId.get(id) ?? [];
      candidates.push({ path, version, priority, error: 'component graph unit contract missing' });
      byId.set(id, candidates);
      continue;
    }
    const candidates = byId.get(id) ?? [];
    candidates.push({ path, template: parsed.template, source: candidateSource, definition: priority,
      priority, hash: createHash('sha256').update(candidateSource).digest('hex') });
    byId.set(id, candidates);
  }
  return byId;
}

/** Resolve unit calls with the runner's existing precedence and version contract. */
export function resolveGraphUnit(call: string, callerPath: string, cache?: IndexCache): ResolvedGraphUnit {
  const [id, requested] = call.split('@');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const directories = [join(dirname(callerPath), 'units'), dirname(callerPath), join(repo, 'graphs', 'units'), join(getElanousConfigDir(), 'graphs', 'units')];
  for (const dir of directories) {
    if (!existsSync(dir)) continue;
    const byId = cache?.get(dir) ?? indexUnits(dir);
    if (cache && !cache.has(dir)) cache.set(dir, byId);
    const matches = (byId.get(id!) ?? []).filter((candidate) => {
      const version = 'template' in candidate ? candidate.template.version : candidate.version;
      if (!('template' in candidate) && (typeof version !== 'number' || !Number.isFinite(version))) return true;
      return requested === String(version) || requested === `^${version}`;
    });
    const bestPriority = matches.some((candidate) => candidate.priority === 'component') ? 'component' : 'standalone';
    const preferred = matches.filter((candidate) => candidate.priority === bestPriority);
    if (preferred.length > 1) throw new Error(`ambiguous unit: ${call}`);
    if (preferred.length) {
      const match = preferred[0]!;
      if (!('template' in match)) throw new Error(`invalid graph unit: ${call} at ${match.path}: ${match.error}`);
      return match;
    }
  }
  throw new UnitNotFoundError(call);
}

export function createGraphUnitResolver(): (call: string, callerPath: string) => ResolvedGraphUnit {
  const cache: IndexCache = new Map();
  return (call, callerPath) => resolveGraphUnit(call, callerPath, cache);
}

/** Shared server-side static view used by PWA, anatomy, and runner verification. */
export function flattenGraphTemplate(graph: GraphTemplateSpec, graphPath: string): GraphTemplateSpec {
  return flattenGraphUnits(graph, graphPath, createGraphUnitResolver());
}
