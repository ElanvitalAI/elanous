// 클라우드 CLI 경로 한 곳.
// gcloud 순서는 role-cli 의 gcloudSearchPaths() 를 그대로 따른다(복제 금지).
// 나머지(aws·az·wrangler)는 알려진 설치 경로 → PATH.

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { gcloudSearchPaths } from '../cli/role-cli.js';

export type CliBinName = 'gcloud' | 'aws' | 'az' | 'wrangler';

export interface CliBinDeps {
  /** 후보 경로가 실행 파일로 있나. 없으면 existsSync. */
  exists?: (path: string) => boolean;
  /** PATH. 없으면 process.env.PATH. gcloud 는 gcloudSearchPaths() 가 이미 PATH 를 담는다. */
  pathEnv?: string;
  home?: string;
  /** 시험이 후보 나열을 바꾼다. 없으면 모듈 훅 → 기본 표. */
  candidates?: (name: CliBinName) => readonly string[];
}

const KNOWN_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '~/.local/bin'] as const;

type SearchFn = (name: CliBinName, deps: CliBinDeps) => readonly string[];
let searchOverride: SearchFn | null = null;

/** 시험 전용 — 후보 나열을 바꾼다(`null` = 되돌림). 진짜 CLI 가 깔린 기계에서 가짜 경로만 보게. */
export function _setCliBinSearchForTesting(fn: SearchFn | null): void {
  searchOverride = fn;
}

function expandHome(dir: string, home: string): string {
  if (dir === '~') return home;
  if (dir.startsWith('~/')) return join(home, dir.slice(2));
  return dir;
}

function fileExists(path: string, exists: (path: string) => boolean): boolean {
  try { return exists(path); } catch { return false; }
}

/** 이름별 후보. gcloud 는 gcloudSearchPaths() 순서 그대로. */
export function cliBinCandidates(name: CliBinName, deps: CliBinDeps = {}): readonly string[] {
  if (deps.candidates) return deps.candidates(name);
  if (searchOverride) return searchOverride(name, deps);
  if (name === 'gcloud') return gcloudSearchPaths();
  const home = deps.home ?? process.env.HOME ?? '';
  const dirs = KNOWN_BIN_DIRS.map((dir) => expandHome(dir, home));
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? '';
  const fromPath = pathEnv.split(delimiter).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...dirs, ...fromPath]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(join(dir, name));
  }
  return out;
}

/** 첫 실행 파일. 없으면 null. */
export function resolveCliBin(name: CliBinName, deps: CliBinDeps = {}): string | null {
  const exists = deps.exists ?? existsSync;
  for (const path of cliBinCandidates(name, deps)) {
    if (fileExists(path, exists)) return path;
  }
  return null;
}
