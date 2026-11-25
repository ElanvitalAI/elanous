// 기억(self_recall) 문서 수집 뿌리 — 고정 경로가 아니라 설정 또는 자동 감지.
// 해석 규칙은 이 파일 한 곳에만 있다.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type KnowledgeDocsRootSource = 'config' | 'tool-checkout' | 'workdir' | 'current-sections' | 'none';

interface KnowledgeDocsRoot {
  path: string;
  source: Exclude<KnowledgeDocsRootSource, 'none'>;
}

interface KnowledgeDocsRootsResult {
  roots: KnowledgeDocsRoot[];
  source: KnowledgeDocsRootSource;
}

interface ResolveKnowledgeDocsRootsOpts {
  /**
   * 설정 `knowledge.docsRoots`.
   * 배열이 주어지면(빈 배열 포함) 그 값만 쓰고 자동 감지를 섞지 않는다.
   * 생략(`undefined`)일 때만 자동 감지한다.
   */
  docsRoots?: readonly string[];
  /**
   * 도구 체크아웃 판정 기준 모듈.
   * 기본은 이 파일. `scripts/knowledge-ingest.ts` 는 자기 `import.meta.url` 을 넘긴다
   * (`import.meta.dir/../docs` = 패키지 뿌리의 docs).
   */
  toolModuleUrl?: string;
  /** `toolModuleUrl` 에서 docs 까지의 상대 세그먼트. 기본 `['..','docs']`. */
  toolDocsSegments?: readonly string[];
  /** 현재 작업 디렉터리. 기본은 process.cwd(). */
  cwd?: string;
  /**
   * 환경 변수 — 좌석 상태 뿌리(`ELANOUS_STATE_DIR`) 해석용. 기본 `process.env`.
   * 시험은 격리 값을 주입한다(src/memory.ts `seatHandoffStateRoot` 와 같은 규약).
   */
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  readPackageName?: (packageJsonPath: string) => string | undefined;
  gitRoot?: (cwd: string) => string | undefined;
}

const TOOL_PACKAGE_NAME = 'elanous';

function defaultReadPackageName(packageJsonPath: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
    return typeof raw.name === 'string' ? raw.name : undefined;
  } catch {
    return undefined;
  }
}

/** 실제 git 작업 트리 뿌리. `.git` 파일/디렉터리 존재만으로는 저장소로 보지 않는다. */
function defaultGitRoot(cwd: string): string | undefined {
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: resolve(cwd),
    encoding: 'utf8',
    timeout: 5000,
  });
  if (probe.status !== 0) return undefined;
  const top = probe.stdout.trim();
  return top.length > 0 ? top : undefined;
}

function dedupe(roots: KnowledgeDocsRoot[]): KnowledgeDocsRoot[] {
  const seen = new Set<string>();
  const out: KnowledgeDocsRoot[] = [];
  for (const root of roots) {
    const key = resolve(root.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: key, source: root.source });
  }
  return out;
}

/**
 * 좌석 상태 뿌리 — `ELANOUS_STATE_DIR` 이면 `<isol>/seat-state`, 아니면 `~/elanous-hq/seat-state`.
 * src/memory.ts `seatHandoffStateRoot` 와 같은 규약(격리 우선).
 */
export function defaultSeatStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const isolated = env.ELANOUS_STATE_DIR?.trim();
  return isolated ? join(isolated, 'seat-state') : join(homedir(), 'elanous-hq', 'seat-state');
}

/**
 * 설정 뿌리 정규화 — 사람은 `knowledge.docsRoots` 에 «저장소 뿌리»(예: `~/elanous-hq/latest`)를 적는다.
 * 순회기(`ingestDocsDir`)와 `docs/conductor` 판정은 «docs 디렉터리»를 기대하므로, 뿌리 바로 밑에
 * `conductor` 가 없고 `docs/` 가 있으면 `<root>/docs` 로 바꾼다. docs 디렉터리·파일 뿌리는 그대로다.
 * (11-25 실측: 저장소 뿌리를 적었더니 매 검색이 «no docs/conductor in the index roots» 를 냈다.)
 */
export function normalizeConfiguredDocsRoot(path: string, exists: (path: string) => boolean = existsSync): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  const root = resolve(expanded);
  if (exists(join(root, 'conductor'))) return root;
  const docs = join(root, 'docs');
  if (exists(docs)) return docs;
  return root;
}

/** 설정 뿌리를 «저장소 뿌리»로 — 낡은 cwd 트리 대신 같이 찾을 최신 체크아웃(Grep/Glob 힌트용). */
export function configuredLatestRepoRoots(docsRoots: readonly unknown[] | undefined, exists: (path: string) => boolean = existsSync): string[] {
  if (!Array.isArray(docsRoots)) return [];
  const out: string[] = [];
  for (const raw of docsRoots) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const docs = normalizeConfiguredDocsRoot(raw.trim(), exists);
    const repo = docs.endsWith('/docs') ? dirname(docs) : docs;
    if (exists(join(repo, '.git')) && !out.includes(repo)) out.push(repo);
  }
  return out;
}

/** 수집 뿌리 목록과 각 뿌리의 출처. 없으면 빈 목록 ⊕ source `none`. */
export function resolveKnowledgeDocsRoots(opts: ResolveKnowledgeDocsRootsOpts = {}): KnowledgeDocsRootsResult {
  // 배열이 있으면(빈 배열·공백만) 설정이 있는 것이다. 자동 감지로 넘어가지 않는다.
  if (opts.docsRoots !== undefined) {
    const configured = opts.docsRoots
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter((p) => p.length > 0);
    if (configured.length === 0) return { roots: [], source: 'none' };
    const exists = opts.exists ?? existsSync;
    const roots = dedupe(configured.map((path) => ({ path: normalizeConfiguredDocsRoot(path, exists), source: 'config' as const })));
    return { roots, source: 'config' };
  }

  const exists = opts.exists ?? existsSync;
  const readPackageName = opts.readPackageName ?? defaultReadPackageName;
  const gitRootOf = opts.gitRoot ?? defaultGitRoot;
  const moduleDir = dirname(fileURLToPath(opts.toolModuleUrl ?? import.meta.url));
  const candidates: KnowledgeDocsRoot[] = [];
  const toolDocsSegments = opts.toolDocsSegments ?? ['..', 'docs'];

  const toolDocs = resolve(moduleDir, ...toolDocsSegments);
  const toolPackage = join(dirname(toolDocs), 'package.json');
  if (exists(toolDocs) && readPackageName(toolPackage) === TOOL_PACKAGE_NAME) {
    candidates.push({ path: toolDocs, source: 'tool-checkout' });
  }

  const gitRoot = gitRootOf(opts.cwd ?? process.cwd());
  if (gitRoot) {
    const workDocs = join(gitRoot, 'docs');
    if (exists(workDocs)) candidates.push({ path: workDocs, source: 'workdir' });
  }

  // DOCS-SEARCH-INDEX-EMPTY — 현행 절(current sections) 후보 3종: 좌석 OPS 규칙(파일 뿌리)·
  // conductor 증류 사실(파일 뿌리)·plans(디렉터리 뿌리). fail-soft exists — 없는 절은
  // 조용히 건너뛴다. FACTS 는 KNOWN_PREFIXES 밖이라 도구 docs 순회 선정에서 영원히 탈락한다
  // — 파일 뿌리로 직접 회수한다.
  const seatOpsRules = join(defaultSeatStateRoot(opts.env), 'OPS', 'OPS-RULES.md');
  if (exists(seatOpsRules)) candidates.push({ path: seatOpsRules, source: 'current-sections' });
  const factsDistilled = join(toolDocs, 'conductor', 'FACTS-DISTILLED.md');
  if (exists(factsDistilled)) candidates.push({ path: factsDistilled, source: 'current-sections' });
  const toolPlans = join(toolDocs, 'plans');
  if (exists(toolPlans)) candidates.push({ path: toolPlans, source: 'current-sections' });

  const roots = dedupe(candidates);
  if (roots.length === 0) return { roots: [], source: 'none' };
  return { roots, source: roots.length === 1 ? roots[0]!.source : roots[0]!.source };
}
