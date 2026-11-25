// 검색 출처(sources) 단일 해석기 — 경로를 코드에 박지 않는다. 설정과 환경 변수에서만 온다.
//
// 모델: 출처 = 객체 { id, type: "repo" | "ref", path, label?, include?, exclude?, enabled? } 의 배열.
//   type 마다 여러 개(예: repo 둘 · ref 여럿). 검색 범위(scope) = repo | ref | both | custom(직접 경로 · 출처 id).
//
// 우선순위:  env ELANOUS_SOURCES(JSON 배열)  ⊕  env 지름길 ELANOUS_DOCS_ROOTS / ELANOUS_REF_ROOTS(':' 구분)
//          > config knowledge.sources  ⊕  옛 키 knowledge.docsRoots(→repo) / knowledge.refRoots(→ref · 한 번 이전 안내)
//          > 없음(오늘과 같다 — cwd 트리만 · 한 번 알린다)
// 쓰는 곳: Grep/Glob 낡은-cwd 폴백(stale-cwd) · docs search CLI · DocsSearch 도구 · 캡슐 검색 묶음 · ref 그라운딩.
// 인용: 결과 경로는 `repo:<id>/<relpath>` · `ref:<id>/<relpath>` · `custom:<id>/<relpath>` 로 적는다.

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { configuredLatestRepoRoots } from './docs-roots.js';
import { getUserConfig } from '../user-config/reader.js';
import { debug } from '../debug/log.js';

export const SEARCH_SOURCE_TYPES = ['repo', 'ref'] as const;
export type SearchSourceType = (typeof SEARCH_SOURCE_TYPES)[number];
export const SEARCH_SCOPES = ['repo', 'ref', 'both', 'custom'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
export type SearchRootSource = 'env' | 'config' | 'none';

export interface SearchSourceConfig {
  id: string;
  type: SearchSourceType;
  path: string;
  label?: string;
  include?: string[];
  exclude?: string[];
  enabled?: boolean;
}

/** 해석된 출처 — custom 경로는 type 'custom'. */
export interface ResolvedSearchSource {
  id: string;
  type: SearchSourceType | 'custom';
  path: string;
  label?: string;
  include?: string[];
  exclude?: string[];
}

export interface LoadedSearchSources {
  sources: SearchSourceConfig[];
  origin: SearchRootSource;
  /** 옛 키(docsRoots/refRoots)에서 온 것이 있었다. */
  legacy: boolean;
  /** 형식이 틀려 버린 항목 사유. */
  invalid: string[];
}

export interface SearchSourcesOpts {
  env?: NodeJS.ProcessEnv;
  /** 사용자 설정 raw. 생략하면 getUserConfig().raw. */
  configRaw?: unknown;
  exists?: (path: string) => boolean;
}

export const SEARCH_ROOTS_UNCONFIGURED_NOTE =
  'no search sources configured (knowledge.sources or ELANOUS_SOURCES / ELANOUS_DOCS_ROOTS / ELANOUS_REF_ROOTS) — searching the cwd tree only';
export const SEARCH_SOURCES_LEGACY_NOTE =
  'knowledge.docsRoots / knowledge.refRoots are deprecated — move them to knowledge.sources [{ id, type: "repo"|"ref", path }]';

export function expandHomePath(path: string): string {
  const p = path.trim();
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim());
}

function envPathList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(':').map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** 이름 없는 경로 → 출처 객체(id = 마지막 디렉터리 이름 · 겹치면 -2, -3). */
function pathsToSources(paths: readonly string[], type: SearchSourceType, taken: Set<string>): SearchSourceConfig[] {
  return paths.map((path) => {
    const base = basename(expandHomePath(path)) || type;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    taken.add(id);
    return { id, type, path };
  });
}

/** 객체 하나 검사 — 틀리면 사유 문자열. */
function normalizeSourceObject(raw: unknown, index: number): SearchSourceConfig | string {
  if (!raw || typeof raw !== 'object') return `sources[${index}]: not an object`;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id.trim()) return `sources[${index}]: id is required`;
  if (o.type !== 'repo' && o.type !== 'ref') return `sources[${index}] (${o.id}): type must be repo or ref`;
  if (typeof o.path !== 'string' || !o.path.trim()) return `sources[${index}] (${o.id}): path is required`;
  return {
    id: o.id.trim(), type: o.type, path: o.path.trim(),
    ...(typeof o.label === 'string' ? { label: o.label } : {}),
    ...(stringList(o.include) ? { include: stringList(o.include)! } : {}),
    ...(stringList(o.exclude) ? { exclude: stringList(o.exclude)! } : {}),
    ...(typeof o.enabled === 'boolean' ? { enabled: o.enabled } : {}),
  };
}

function normalizeObjects(list: unknown, invalid: string[]): SearchSourceConfig[] {
  if (!Array.isArray(list)) return [];
  const out: SearchSourceConfig[] = [];
  list.forEach((raw, i) => {
    const r = normalizeSourceObject(raw, i);
    if (typeof r === 'string') invalid.push(r);
    else if (out.some((s) => s.id === r.id)) invalid.push(`sources[${i}] (${r.id}): duplicate id`);
    else out.push(r);
  });
  return out;
}

function readConfigRaw(): unknown {
  try { return getUserConfig().raw; } catch { return undefined; }
}

let legacyNoted = false;
let unconfiguredNoted = false;

/** 출처 목록 적재 — env > config > none. 꺼진 것(enabled:false)도 목록에는 남긴다. */
export function loadSearchSources(opts: SearchSourcesOpts = {}): LoadedSearchSources {
  const env = opts.env ?? process.env;
  const invalid: string[] = [];
  // ① env
  const envJson = env.ELANOUS_SOURCES?.trim();
  const envDocs = envPathList(env.ELANOUS_DOCS_ROOTS);
  const envRef = envPathList(env.ELANOUS_REF_ROOTS);
  if (envJson || envDocs || envRef) {
    let objects: SearchSourceConfig[] = [];
    if (envJson) {
      try { objects = normalizeObjects(JSON.parse(envJson), invalid); } catch { invalid.push('ELANOUS_SOURCES: not valid JSON'); }
    }
    const taken = new Set(objects.map((s) => s.id));
    const sources = [...objects, ...pathsToSources(envDocs ?? [], 'repo', taken), ...pathsToSources(envRef ?? [], 'ref', taken)];
    return { sources, origin: 'env', legacy: false, invalid };
  }
  // ② config
  const raw = 'configRaw' in opts ? opts.configRaw : readConfigRaw();
  const knowledge = raw && typeof raw === 'object' ? (raw as { knowledge?: unknown }).knowledge as Record<string, unknown> | undefined : undefined;
  if (knowledge && typeof knowledge === 'object') {
    const objects = normalizeObjects(knowledge.sources, invalid);
    const oldDocs = stringList(knowledge.docsRoots);
    const oldRef = stringList(knowledge.refRoots);
    const legacy = oldDocs !== undefined || oldRef !== undefined;
    if (Array.isArray(knowledge.sources) || legacy) {
      const taken = new Set(objects.map((s) => s.id));
      const sources = [...objects, ...pathsToSources(oldDocs ?? [], 'repo', taken), ...pathsToSources(oldRef ?? [], 'ref', taken)];
      if (legacy && !legacyNoted && opts.env === undefined) {
        legacyNoted = true;
        debug.log('tools.search', 'sources-legacy-keys', { hint: SEARCH_SOURCES_LEGACY_NOTE }, { level: 'warn' });
      }
      return { sources, origin: 'config', legacy, invalid };
    }
  }
  // ③ none
  if (!unconfiguredNoted && opts.env === undefined) {
    unconfiguredNoted = true;
    debug.log('tools.search', 'roots-unconfigured', { hint: SEARCH_ROOTS_UNCONFIGURED_NOTE });
  }
  return { sources: [], origin: 'none', legacy: false, invalid };
}

export interface ResolveSearchSourcesOpts extends SearchSourcesOpts {
  scope?: SearchScope;
  /** custom: 직접 경로(실존 검사 · 읽기 전용). */
  paths?: readonly string[];
  /** custom: 설정 출처 id. */
  sourceIds?: readonly string[];
}

export class SearchSourceError extends Error {}

/** scope → 검색할 출처 목록. custom 은 paths ⊕ sourceIds(없으면 에러). */
export function resolveSearchSources(opts: ResolveSearchSourcesOpts = {}): ResolvedSearchSource[] {
  const scope = opts.scope ?? 'repo';
  if (!(SEARCH_SCOPES as readonly string[]).includes(scope)) throw new SearchSourceError(`scope must be one of ${SEARCH_SCOPES.join('|')}`);
  const exists = opts.exists ?? existsSync;
  const loaded = loadSearchSources(opts);
  const toResolved = (s: SearchSourceConfig): ResolvedSearchSource => ({
    id: s.id, type: s.type, path: expandHomePath(s.path),
    ...(s.label ? { label: s.label } : {}), ...(s.include ? { include: s.include } : {}), ...(s.exclude ? { exclude: s.exclude } : {}),
  });
  if (scope !== 'custom') {
    return loaded.sources
      .filter((s) => s.enabled !== false && (scope === 'both' || s.type === scope))
      .map(toResolved);
  }
  const out: ResolvedSearchSource[] = [];
  for (const id of opts.sourceIds ?? []) {
    const hit = loaded.sources.find((s) => s.id === id);
    if (!hit) throw new SearchSourceError(`unknown source id: ${id} (known: ${loaded.sources.map((s) => s.id).join(', ') || 'none'})`);
    out.push(toResolved(hit));
  }
  (opts.paths ?? []).forEach((p, i) => {
    const path = expandHomePath(p);
    if (!exists(path)) throw new SearchSourceError(`custom path does not exist: ${p}`);
    out.push({ id: `custom${i + 1}`, type: 'custom', path });
  });
  if (out.length === 0) throw new SearchSourceError('scope custom needs paths or source ids');
  return out;
}

/** `repo:<id>/<relpath>` 인용 — 가장 깊게 맞는 출처 기준. 어느 출처 밖이면 절대 경로 그대로. */
export function citeSourcePath(absPath: string, sources: readonly ResolvedSearchSource[]): string {
  const p = resolve(absPath);
  let best: ResolvedSearchSource | undefined;
  for (const s of sources) {
    const root = resolve(s.path);
    if ((p === root || p.startsWith(root + sep)) && (!best || root.length > resolve(best.path).length)) best = s;
  }
  if (!best) return absPath;
  const rel = relative(resolve(best.path), p);
  return `${best.type}:${best.id}/${rel}`;
}

// ── 옛 모양 호환(Grep/Glob 낡은-cwd · docs search CLI · ingest) ──

export interface SearchRoots {
  /** undefined = 설정 없음(자동 감지 · cwd). 배열이면 repo 출처 경로. */
  docsRoots: string[] | undefined;
  docsSource: SearchRootSource;
  refRoots: string[];
  refSource: SearchRootSource;
  /** repo 출처 중 git 체크아웃(낡은 cwd 대신 같이 찾을 최신 트리). */
  latestRepoRoots: string[];
}

export function resolveSearchRoots(opts: SearchSourcesOpts = {}): SearchRoots {
  const loaded = loadSearchSources(opts);
  const on = loaded.sources.filter((s) => s.enabled !== false);
  const repo = on.filter((s) => s.type === 'repo').map((s) => expandHomePath(s.path));
  const ref = on.filter((s) => s.type === 'ref').map((s) => expandHomePath(s.path));
  const configured = loaded.origin !== 'none';
  const docsRoots = configured && (repo.length > 0 || loaded.sources.every((s) => s.type !== 'ref')) ? repo : undefined;
  return {
    docsRoots,
    docsSource: docsRoots !== undefined ? loaded.origin : 'none',
    refRoots: ref,
    refSource: ref.length > 0 ? loaded.origin : 'none',
    latestRepoRoots: configuredLatestRepoRoots(docsRoots, opts.exists),
  };
}

/** 출처 하나의 상태(목록 CLI) — 실존 · 디렉터리 여부. */
export function sourceHealth(s: SearchSourceConfig, exists: (path: string) => boolean = existsSync): 'ok' | 'missing' | 'not-a-directory' {
  const path = expandHomePath(s.path);
  if (!exists(path)) return 'missing';
  try { return statSync(path).isDirectory() ? 'ok' : 'not-a-directory'; } catch { return 'missing'; }
}
