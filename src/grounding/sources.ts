// Grounding source registry — pure config-object helpers.
//
// These functions update and return a config object. They do not write
// ~/.elanous. Discovery returns candidates only; it does not register them.
// sourceStatus reads local git refs only — never fetch or pull.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { debug } from '../debug/log.js';

export const GROUNDING_SOURCE_KINDS = ['local-repo', 'local-docs', 'web', 'dev-index', 'url'] as const;
export type GroundingSourceKind = (typeof GROUNDING_SOURCE_KINDS)[number];

export interface GroundingSourceBeforeUse {
  maxAgeHours: number;
}

export type GroundingSourceSync = 'manual' | 'daily' | { beforeUse: GroundingSourceBeforeUse };

export interface GroundingSource {
  id: string;
  kind: GroundingSourceKind;
  path?: string;
  url?: string;
  sync: GroundingSourceSync;
  tags?: string[];
  /** 로컬 전용 출처를 거울에 올릴지. upstream 이 있으면 이 칸과 무관하게 후보가 된다. */
  mirror?: boolean;
}

export interface GroundingSourcesConfig {
  grounding?: { sources?: GroundingSource[] };
}

export interface GroundingSourceInput {
  id?: string;
  kind?: GroundingSourceKind;
  path?: string;
  url?: string;
  sync?: GroundingSourceSync;
  tags?: string[];
  mirror?: boolean;
}

export interface GroundingSourceStatus {
  id: string;
  kind: GroundingSourceKind;
  branch?: string;
  lastCommitAt?: string;
  dirty?: boolean;
  behind?: number | 'unknown';
  measured: boolean;
}

export class GroundingSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroundingSourceError';
  }
}

const PATH_KINDS = new Set<GroundingSourceKind>(['local-repo', 'local-docs', 'dev-index']);

export interface GroundingConfig {
  sources: GroundingSource[];
}

/** Keep valid items. Skip invalid items with a warning. Never throws. */
export function parseGroundingSources(raw: unknown): GroundingConfig {
  if (raw === undefined) return { sources: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnSkip('grounding', '섹션이 객체가 아니다 — 버림');
    return { sources: [] };
  }
  const sources = (raw as Record<string, unknown>).sources;
  if (sources === undefined) return { sources: [] };
  if (!Array.isArray(sources)) {
    warnSkip('grounding.sources', '배열이 아니다 — 버림');
    return { sources: [] };
  }
  const kept: GroundingSource[] = [];
  for (const item of sources) {
    const parsed = parseGroundingSourceItem(item);
    if (parsed) kept.push(parsed);
  }
  return { sources: kept };
}

function parseGroundingSourceItem(raw: unknown): GroundingSource | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnSkip('grounding.sources[]', '객체가 아니다 — 건너뜀');
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id.trim()) {
    warnSkip('grounding.sources[]', 'id 가 없다 — 건너뜀');
    return undefined;
  }
  if (typeof v.kind !== 'string' || !(GROUNDING_SOURCE_KINDS as readonly string[]).includes(v.kind)) {
    warnSkip('grounding.sources[]', `kind 가 허용값이 아니다(${JSON.stringify(v.kind)}) — 건너뜀`);
    return undefined;
  }
  const sync = parseSync(v.sync);
  if (!sync) {
    warnSkip('grounding.sources[]', `sync 가 허용값이 아니다(${JSON.stringify(v.sync)}) — 건너뜀`);
    return undefined;
  }
  const path = typeof v.path === 'string' && v.path.trim() ? v.path.trim() : undefined;
  const url = typeof v.url === 'string' && v.url.trim() ? v.url.trim() : undefined;
  const tags = Array.isArray(v.tags)
    ? v.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : undefined;
  const mirror = v.mirror === true ? true : undefined;
  return {
    id: v.id.trim(),
    kind: v.kind as GroundingSourceKind,
    sync,
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(mirror ? { mirror } : {}),
  };
}

function parseSync(raw: unknown): GroundingSourceSync | undefined {
  if (raw === 'manual' || raw === 'daily') return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const beforeUse = (raw as Record<string, unknown>).beforeUse;
  if (!beforeUse || typeof beforeUse !== 'object' || Array.isArray(beforeUse)) return undefined;
  const hours = (beforeUse as Record<string, unknown>).maxAgeHours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return undefined;
  return { beforeUse: { maxAgeHours: hours } };
}

function warnSkip(section: string, detail: string): void {
  try { process.stderr.write(`[user-config] ${section} ${detail}\n`); } catch { /* stderr closed */ }
}

export function listGroundingSources(config: GroundingSourcesConfig): GroundingSource[] {
  const sources = config.grounding?.sources;
  return Array.isArray(sources) ? sources.map(cloneSource) : [];
}

export function addGroundingSource(
  config: GroundingSourcesConfig,
  input: GroundingSourceInput,
): GroundingSourcesConfig {
  const source = normalizeInput(input);
  const existing = listGroundingSources(config);
  if (existing.some((item) => item.id === source.id)) {
    throw new GroundingSourceError(`duplicate id: ${source.id}`);
  }
  if (PATH_KINDS.has(source.kind)) {
    if (!source.path) throw new GroundingSourceError(`missing path: ${source.id}`);
    if (!existsSync(source.path)) throw new GroundingSourceError(`missing path: ${source.path}`);
  }
  debug.log('grounding.sources', 'added', { id: source.id, kind: source.kind });
  return {
    ...config,
    grounding: { ...(config.grounding ?? {}), sources: [...existing, source] },
  };
}

export function removeGroundingSource(
  config: GroundingSourcesConfig,
  id: string,
): GroundingSourcesConfig {
  const existing = listGroundingSources(config);
  const hit = existing.find((item) => item.id === id);
  if (!hit) throw new GroundingSourceError(`unknown id: ${id}`);
  debug.log('grounding.sources', 'removed', { id: hit.id, kind: hit.kind });
  return {
    ...config,
    grounding: { ...(config.grounding ?? {}), sources: existing.filter((item) => item.id !== id) },
  };
}

/** Candidates only. Does not register them into config. */
export function discoverReferenceSources(home: string): GroundingSource[] {
  const repos = listChildDirs(join(home, 'source', 'ref'))
    .filter((dir) => isGitRepo(dir))
    .map((dir) => candidate(dir, 'local-repo'));
  const docs = listChildDirs(join(home, 'docs', 'ref'))
    .map((dir) => candidate(dir, 'local-docs'));
  return [...repos, ...docs];
}

export function sourceStatus(source: GroundingSource): GroundingSourceStatus {
  if (source.kind !== 'local-repo' || !source.path) {
    const status: GroundingSourceStatus = { id: source.id, kind: source.kind, measured: false };
    debug.log('grounding.sources', 'status', { id: source.id, behind: 'unknown', dirty: false });
    return status;
  }
  const measured = measureLocalRepo(source.path);
  if (!measured) {
    const status: GroundingSourceStatus = {
      id: source.id,
      kind: source.kind,
      behind: 'unknown',
      dirty: false,
      measured: false,
    };
    debug.log('grounding.sources', 'status', { id: source.id, behind: 'unknown', dirty: false });
    return status;
  }
  const status: GroundingSourceStatus = {
    id: source.id,
    kind: source.kind,
    branch: measured.branch,
    lastCommitAt: measured.lastCommitAt,
    dirty: measured.dirty,
    behind: measured.behind,
    measured: true,
  };
  debug.log('grounding.sources', 'status', {
    id: source.id,
    behind: measured.behind,
    dirty: measured.dirty,
  });
  return status;
}

function candidate(dir: string, kind: 'local-repo' | 'local-docs'): GroundingSource {
  return { id: basename(dir), kind, path: dir, sync: 'manual' };
}

function listChildDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((name) => join(root, name))
    .filter((dir) => {
      try { return statSync(dir).isDirectory(); } catch { return false; }
    })
    .sort();
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

function normalizeInput(input: GroundingSourceInput): GroundingSource {
  const path = input.path?.trim() || undefined;
  const url = input.url?.trim() || undefined;
  const kind = input.kind ?? inferKind(path, url);
  const id = (input.id?.trim() || defaultId(path, url));
  if (!id) throw new GroundingSourceError('missing id');
  if (!GROUNDING_SOURCE_KINDS.includes(kind)) throw new GroundingSourceError(`unknown kind: ${String(kind)}`);
  const source: GroundingSource = {
    id,
    kind,
    sync: input.sync ?? 'manual',
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
    ...(input.mirror === true ? { mirror: true } : {}),
  };
  return source;
}

function inferKind(path: string | undefined, url: string | undefined): GroundingSourceKind {
  if (url && !path) return 'url';
  if (path && isGitRepo(path)) return 'local-repo';
  if (path) return 'local-docs';
  return 'url';
}

function defaultId(path: string | undefined, url: string | undefined): string {
  if (path) return basename(path);
  if (url) {
    try { return new URL(url).hostname || url; } catch { return url; }
  }
  return '';
}

function cloneSource(source: GroundingSource): GroundingSource {
  return {
    ...source,
    ...(source.sync && typeof source.sync === 'object'
      ? { sync: { beforeUse: { maxAgeHours: source.sync.beforeUse.maxAgeHours } } }
      : {}),
    ...(source.tags ? { tags: [...source.tags] } : {}),
    ...(source.mirror === true ? { mirror: true } : {}),
  };
}

interface MeasuredRepo {
  branch?: string;
  lastCommitAt?: string;
  dirty: boolean;
  behind: number | 'unknown';
}

function measureLocalRepo(repoPath: string): MeasuredRepo | undefined {
  if (!existsSync(repoPath)) return undefined;
  const branch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const committedAt = git(repoPath, ['log', '-1', '--format=%cI']);
  const porcelain = git(repoPath, ['status', '--porcelain']);
  if (branch === undefined && committedAt === undefined && porcelain === undefined) return undefined;
  const dirty = (porcelain ?? '').trim().length > 0;
  return {
    ...(branch?.trim() ? { branch: branch.trim() } : {}),
    ...(committedAt?.trim() ? { lastCommitAt: committedAt.trim() } : {}),
    dirty,
    behind: commitsBehind(repoPath, branch?.trim()),
  };
}

/** Local refs only. `git rev-list` does not contact a remote. */
function commitsBehind(repoPath: string, branch: string | undefined): number | 'unknown' {
  if (!branch || branch === 'HEAD') return 'unknown';
  const upstream = git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!upstream?.trim()) return 'unknown';
  const count = git(repoPath, ['rev-list', '--count', `HEAD..${upstream.trim()}`]);
  if (count === undefined) return 'unknown';
  const n = Number(count.trim());
  return Number.isFinite(n) ? n : 'unknown';
}

function git(repoPath: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return undefined;
  return result.stdout ?? '';
}
