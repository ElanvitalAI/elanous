import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface DashboardSource {
  path: string;
  text: string;
}

export interface DashboardMatch {
  path: string;
  line: number;
}

/** Reads every dashboard TypeScript source, including modules in subdirectories. */
export function readDashboardSources(dir = resolve(process.cwd(), 'src/dashboard')): DashboardSource[] {
  const files: DashboardSource[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push({ path: relative(process.cwd(), path), text: readFileSync(path, 'utf8') });
      }
    }
  }
  walk(dir);
  if (files.length === 0) throw new Error(`No dashboard TypeScript sources in ${dir}`);
  return files;
}

/** Keeps file boundaries intact, including for multiline patterns and occurrence counts. */
export function dashboardMatches(pattern: RegExp, sources: readonly DashboardSource[] = readDashboardSources()): DashboardMatch[] {
  const matches: DashboardMatch[] = [];
  for (const { path, text } of sources) {
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(regex)) {
      const line = text.slice(0, match.index).split('\n').length;
      matches.push({ path, line });
    }
  }
  return matches;
}

export function dashboardSourceText(sources: readonly DashboardSource[]): string {
  return sources.map(({ text }) => text).join('\n');
}

export function dashboardSourceLocations(sources: readonly DashboardSource[]): string {
  return sources.map(({ path, text }) => `${path}:1-${text.split('\n').length}`).join(', ');
}

// ── TUI 소스 묶음 (D4a-1 · RFC-tui-essential-diet-and-legacy-removal D4a) ─────────────────
// 시험·scripts 는 «파일 하나»(index.ts)를 글자로 읽지 않고 이 묶음을 읽는다 — 함수를
// src/dashboard/index.ts 에서 src/tui/** 로 옮겨도(D4b) 경로 때문에 깨지지 않게.
// ⭐ 진입 파일을 묶음 «맨 앞»에 둔다: `indexOf`/`slice` 가 지금처럼 index.ts 안의 첫 출현을
//    먼저 집고, 식별자가 옮겨 가면 옮겨 간 파일에서 집는다.

const REPO_ROOT = resolve(import.meta.dir, '../..');

/** TUI 진입 파일. 경로 문자열이 필요한 시험·scripts 는 이 상수만 쓴다(문자열을 다시 적지 않는다). */
export const TUI_ENTRY_PATH = 'src/dashboard/index.ts';

/** TUI 소스 묶음을 이루는 디렉토리(저장소 뿌리 기준). */
export const TUI_SOURCE_DIRS = ['src/dashboard', 'src/tui'] as const;

function walkTuiDir(root: string, directory: string, out: DashboardSource[]): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return; // 묶음 디렉토리가 아직 없으면(예: src/tui 신설 전) 건너뛴다.
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walkTuiDir(root, path, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push({ path: relative(root, path).split('\\').join('/'), text: readFileSync(path, 'utf8') });
    }
  }
}

const tuiSourcesCache = new Map<string, DashboardSource[]>();

/** TUI 소스 묶음(src/dashboard/** ⊕ src/tui/** · 시험 파일 제외)을 진입 파일 먼저 읽는다. */
export function readTuiSources(root = REPO_ROOT): DashboardSource[] {
  const cached = tuiSourcesCache.get(root);
  if (cached) return cached;
  const files: DashboardSource[] = [];
  for (const dir of TUI_SOURCE_DIRS) walkTuiDir(root, join(root, dir), files);
  files.sort((a, b) => Number(b.path === TUI_ENTRY_PATH) - Number(a.path === TUI_ENTRY_PATH));
  if (files.length === 0) throw new Error(`No TUI TypeScript sources under ${TUI_SOURCE_DIRS.join(', ')} in ${root}`);
  tuiSourcesCache.set(root, files);
  return files;
}

/** 묶음 전체 글자(파일 사이는 줄바꿈 하나). «어딘가에 있다/없다» 를 경로 무관하게 문다. */
export function tuiSourceText(root = REPO_ROOT): string {
  return dashboardSourceText(readTuiSources(root));
}

/**
 * 식별자(문자열·정규식)를 담은 묶음 안 «첫» 파일(진입 파일 먼저). 함수 몸통을 잘라 보거나
 * 한 파일 안의 순서를 무는 시험이 쓴다 — 식별자가 다른 파일로 옮겨 가도 그 파일을 집는다.
 */
export function tuiSourceFileWith(needle: string | RegExp, root = REPO_ROOT): DashboardSource {
  const hit = readTuiSources(root).find(({ text }) =>
    typeof needle === 'string' ? text.includes(needle) : new RegExp(needle.source, needle.flags.replace('g', '')).test(text));
  if (!hit) throw new Error(`TUI 소스 묶음(${TUI_SOURCE_DIRS.join(' ⊕ ')})에 ${String(needle)} 이 없다`);
  return hit;
}
