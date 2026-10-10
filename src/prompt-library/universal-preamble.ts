// Surface-agnostic preamble builder — fix F (Universal layer).
//
// Mirrors Claude Code's Phase 0 auto-memory: every LLM turn (regardless
// of surface — TUI dashboard, telegram, skill runner, sub-agent, future
// web/iPad) gets a baseline understanding of the project's collaboration
// guide + house rules BEFORE the user even speaks. Without this, codex /
// gpt-5.4 / etc. burn the exploration budget on "what is this project?"
// search storms (observed 2026-04-25 stall: 6 turns of ListDir/Grep/Glob
// → autoNarrowedReadCount: 0 → exploration synthesis hard-stop).
//
// **Surface-agnostic by design**: returns `LLMMessage[]` so any caller
// can spread it into its own preamble assembly. NOT named `Dashboard*` /
// `Tui*` / `Acp*` — the universal layer is the seam where multi-channel
// (voice / pushcut / web / iPad per ROADMAP-voice-orchestrated M0~M3)
// will plug in once their surfaces land.
//
// Initial scope (MVP) — only project anchor (AGENTS.md + CLAUDE.md).
// Future migrations from `dashboard/turn-preamble.ts` (ask, approval,
// sandbox, conciseness, impl-discipline) move here as they're verified
// surface-agnostic.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import type { LLMMessage } from '../llm.js';
import type { ModelFamily } from '../models/prompts.js';
import { debug } from '../debug/log.js';
import { buildCodexFamilyAddendum } from './codex-family-addendum.js';
import { buildGpt6FamilyAddendum } from './gpt6-family-addendum.js';
import { buildGeminiFamilyAddendum } from './gemini-family-addendum.js';
import { buildAnthropicFamilyAddendum } from './anthropic-family-addendum.js';
import { buildGrokFamilyAddendum } from './grok-family-addendum.js';
import { buildSessionGuidanceAddendum } from './session-guidance.js';
import { getHarnessSpace } from '../harness/harness-space.js';

export const PROJECT_ANCHOR_MAX_CHARS = 36 * 1024; // 10-10 증액(32K→36K) — 줄이기는 AGENTS-CLAUDE-DIET(0.2.24)
/** «lean» 예산(BACKLOG L2 · 2026-09-25) — 로컬 모델 구현 자식은 매 턴 이것을 prefill 한다.
 *  📏 09-25 node-b 기록 프록시: 시스템 50,068자 중 AGENTS.md 앵커 ~32K · 트리 ~8K 가 상위 둘이었다.
 *  ⭐ 켜는 법: env `ELANOUS_PROMPT_BUDGET=lean` — 하니스 구현 자식 spawn 이 child provider 가 local 일 때 준다.
 *  ⛔ API 모델 경로의 기본(36K·8K)은 그대로다 — 잘 도는 것을 바꾸지 않는다. */
export const PROJECT_ANCHOR_LEAN_MAX_CHARS = 8 * 1024;
export const PROJECT_TREE_LEAN_MAX_CHARS = 2 * 1024;
function promptBudgetLean(): boolean { return process.env.ELANOUS_PROMPT_BUDGET?.trim() === 'lean'; }
export function projectAnchorMaxChars(): number { return promptBudgetLean() ? PROJECT_ANCHOR_LEAN_MAX_CHARS : PROJECT_ANCHOR_MAX_CHARS; }
export function projectTreeMaxChars(): number { return promptBudgetLean() ? PROJECT_TREE_LEAN_MAX_CHARS : PROJECT_TREE_MAX_CHARS; }

export const PROJECT_ANCHOR_CANDIDATES = [
  { filename: 'AGENTS.md', label: 'Project canonical collaboration guide' },
  { filename: 'DESIGN.md', label: 'Project design craft rulebooks' },
] as const;

// AGENTS.md is the repository's canonical collaboration guide. CLAUDE.md
// is intentionally excluded from project anchors by owner policy.
export const PROJECT_ANCHOR_NON_CANDIDATE_FILENAMES = ['CLAUDE.md'] as const;

// W4-B (2026-05-03) — codex-rs `realtime_context.rs` 패턴 차용:
// per-dir DIR_ENTRY_LIMIT=20 으로 1차 통제, character cap 은 최종 안전망.
// gemini-cli 의 MAX_ITEMS=200 글로벌 BFS 도 같은 의도. 문서:
// 내부 문서 `RESEARCH-coding-pipeline-3refs-system-prompt-2026-05-03` §4
export const PROJECT_TREE_MAX_CHARS = 8 * 1024;
export const PROJECT_TREE_DIR_ENTRY_LIMIT = 20;

const NO_TOOLS_VERIFICATION_GUIDANCE = `## Chat without tools — verify rather than guess
This conversation has tools disabled. Do not guess repository or real-time facts that require verification, such as file counts, file contents, commits, or the current date or time. When asked for facts you cannot verify here (including repository state, files, and dates), explicitly say you cannot check them in this mode. The project tree above is for navigation, not evidence for counts.
Give one line explaining how to enable tools: \`elanous agent "<your question>"\`.`;

// P4 (2026-05-03) — Family-agnostic coding-agent lifecycle. Maps the
// three user-facing pipelines to an explicit tool-batch sequence so every
// model (not just codex) follows the same shape. Pattern source:
// gemini-cli `packages/core/src/prompts/snippets.ts:211-267`
// "Research → Strategy → Execution" lifecycle. Adapted to monad-agent's
// vocabulary (분석/구현/디버깅) so the prompt directly mirrors the
// terminology a Korean operator uses when describing what they want.
//
// Rationale — observed (2026-04-25 logs + 2026-05-03 user report) that
// even when the project anchor and codex addendum land, models do not
// reliably produce the find→read→edit→verify shape on coding tasks.
// They tend to either (a) over-search (codex reread pathology) or (b)
// stop after analysis without verifying. Naming the lifecycle stages
// explicitly + binding tool batches to them gives the model a checklist
// it can self-monitor against.
const CODING_AGENT_LIFECYCLE = `# Coding Agent Pipelines — Tool-Batch Discipline

For coding-style tasks (analysis, implementation, debugging), follow ONE
of these three pipelines. State the pipeline you chose ONCE in your
opening sentence (not every turn). On subsequent turns, just execute the
next stage — your tool calls are the audit trail; re-narrating the
pipeline every turn signals you are stuck.

## Analysis (분석) — find → read → organize
When a user's analysis question identifies a concrete, user-fixable code or
configuration defect, end the organized answer with a clear next-action CTA:
ask whether they want the discovered fix implemented (for example,
\`수정할까요?\`). Do not ask this when no actionable defect was found, and do
not claim a change was made before it is implemented and verified.
1. **find**: ONE batch of search tools (Grep / Glob / ListDir / AstGrep
   in parallel) to locate candidate files. Do not run a second \`find\`
   batch unless the first returned ZERO useful candidates — if it
   returned candidate paths, move directly to **read**.
2. **read**: ONE batch of Read calls (parallel) on the 2-5 most
   relevant files identified.
3. **organize**: Plain-text answer summarizing what you found. No more
   tools unless a specific gap remains.

## Implementation (구현) — find → read → edit → verify
1. **find** + **read**: As above.
2. **edit**: Targeted Edit / Write call(s) on the specific file(s).
3. **verify**: Either (a) Read({file_path}) of the edited file to confirm
   the change landed, OR (b) Bash / RunShell to run the relevant tests
   (\`bun test test/<area>.test.ts\` or similar). Skip verification only
   for trivial changes (typo fixes, single-line constants).

## Debugging (디버깅) — find → read → exec → edit → verify
1. **find** + **read**: As above.
2. **exec**: Bash / RunShell to reproduce the failure (run the failing
   test, repro the bug, check error output).
3. **edit**: Apply the fix based on what the exec output shows.
4. **verify**: Re-run the same Bash / RunShell command. The exec must
   now PASS. If it doesn't, repeat exec → edit until it does or until
   you've established a clear blocker for the user.

## Pipeline Discipline
- Pick ONE pipeline at the START of the task. State it ONCE in your
  opening sentence — do NOT re-state on every subsequent turn. On
  follow-up turns just call the next stage's tools directly.
- Each stage = ONE turn (or one parallel batch within a turn). Don't
  spread \`find\` across 4 sequential turns — batch the tools.
- **find → read transition is MANDATORY** after the first \`find\` batch
  produces candidate paths. Do not issue a second \`find\` batch
  searching the SAME paths/globs with different keywords — the
  candidates are already on the table; advance to \`read\`.
- For Analysis: stop at \`organize\`. Don't drift into edit/exec.
- For Implementation/Debugging: \`verify\` is mandatory. "I made the
  change" without verification is incomplete output.
- Do not announce your pipeline choice and then call zero tools — pick a
  pipeline ONLY when you actually need to use it. Pure conversational
  questions don't need a pipeline.`;

/** Build the family-agnostic coding-agent lifecycle addendum. Returns
 *  a single system message describing the analysis / implementation /
 *  debugging pipelines in tool-batch terms. Spread by
 *  `buildUniversalPreamble` for every family (not just codex) — this
 *  is general guidance, not a model quirk patch. */
export function buildCodingLifecycleAddendum(): LLMMessage[] {
  return [{ role: 'system', content: CODING_AGENT_LIFECYCLE }];
}

/** ★ 자기인지 하니스 공간 addendum(2026-07-21 대표 co-design) — 이 프로세스가 격리 self-dev-harness 공간
 *  안이면(ENV 마커·getHarnessSpace) elanous 이 "나는 격리 빌드 샌드박스의 elanous"임을 **자기인지**하고 그에 따라
 *  판단하게 하는 system 메시지. 공간 밖(운영/일반)이면 [](무주입=기존 동작). harness-space 장치의 첫 소비자.
 *  Docker 컨테이너가 자기가 격리됐음을 알고 행동하는 것과 동형. */
export function buildHarnessSpaceAddendum(): LLMMessage[] {
  const space = getHarnessSpace();
  if (!space) return [];
  return [{
    role: 'system',
    content:
      `## 실행 맥락 — 너는 격리 self-dev-harness 공간의 elanous 다 (자기인지)\n` +
      `- 공간: kind=\`${space.kind}\`${space.id ? ` · id=\`${space.id}\`` : ''}. 이건 **새 git worktree = 격리 빌드 샌드박스**이지 운영 레포가 아니다.\n` +
      `- 목표: 요청된 변경을 **끝까지 구현**하고 **컴파일(tsc)·게이트를 통과**시켜라. "고쳤다"만 하고 검증 안 하면 미완이다.\n` +
      `- ⚠️ 테스트 검증은 **네가 바꾼/추가한 테스트 파일 경로만** 돌려라(\`run_tests\` 툴 또는 \`bun test <경로>\`). **경로 없는 전체 \`bun test\` 스위트는 금지** — 통합/네트워크 테스트를 포함해 격리 worktree 에서 매우 느려 시간초과로 미완 처리된다(게이트도 변경 파일만 스코프한다).\n` +
      `- 제약(격리 공간 규율): PR 개설은 **fail-closed**(명시 승인 시에만) · **미션 DB 무접촉**(미션 생성/상태전이 금지) · 운영 상태 무접촉.\n` +
      `- 자유: 이 worktree 안에서는 파일 편집·빌드·테스트를 자율로 반복(HITL 없이)해 게이트 통과까지 밀어붙여라.`,
  }];
}

export interface UniversalPreambleContext {
  /** Working directory the agent is operating in. Anchor files
   *  (AGENTS.md / CLAUDE.md) load relative to this. */
  cwd: string;
  /** Optional model family. When provided, family-specific behavioral
   *  addendums append after the project anchor. codex (L-1, anti-
   *  reread), gemini (Wave 2, multi-turn activation), claude (Wave 3,
   *  engineering-standards) — each addresses a distinct family weak
   *  spot. */
  modelFamily?: ModelFamily;
  /** Active tool names for session-specific guidance. When provided,
   *  `buildSessionGuidanceAddendum` emits per-tool one-liner directives
   *  (Wave 3 — pattern source ref/claude-code-fork
   *  `getSessionSpecificGuidanceSection`). When omitted or empty, no
   *  session guidance section appears. Family-agnostic — all providers
   *  benefit. */
  enabledTools?: readonly string[];
}

export interface ProjectAnchorMeta {
  filename: string;
  chars: number;
  truncated: boolean;
  /** Directory the file was read from, relative to cwd. Empty string
   *  means the file lives in cwd itself; "../packages/api" means the
   *  file came from a sibling/ancestor in the hierarchical chain.
   *  Mirrors ref/codex's path-aware AGENTS.md ordering — the model
   *  needs to know which scope a given fragment came from. */
  relDir: string;
}

export type ProjectAnchorSkipReason = 'budget-exhausted' | 'absent' | 'read-failed' | 'policy-excluded';

export interface ProjectAnchorSkippedFile {
  filename: string;
  relDir: string;
  reason: ProjectAnchorSkipReason;
}

interface ProjectAnchorResultShape {
  /** Concatenated anchor text or `null` when neither file exists. */
  content: string | null;
  files: ProjectAnchorMeta[];
  skipped: ProjectAnchorSkippedFile[];
  totalChars: number;
}

export type ProjectAnchorResult = ProjectAnchorResultShape;

interface ProjectAnchorCandidate {
  path: string;
  mtimeMs: number | null;
}

interface ProjectAnchorCacheEntry {
  result: ProjectAnchorResult;
  candidates: ProjectAnchorCandidate[];
}

const _projectAnchorCache = new Map<string, ProjectAnchorCacheEntry>();
let _projectTreeCache: { cwd: string; result: ProjectTreeResult } | null = null;
let projectAnchorReadObserverForTest: ((path: string) => void) | undefined;

/** Test seam for deterministic read/stat race coverage. */
export function setProjectAnchorReadObserverForTest(observer: ((path: string) => void) | undefined): void {
  projectAnchorReadObserverForTest = observer;
}

/** Reset the per-cwd cache. Tests + live edits of anchor-policy files
 *  call this so the next read picks up disk state. */
export function resetUniversalPreambleCache(): void {
  _projectAnchorCache.clear();
  _projectTreeCache = null;
}

// ── Project tree light snapshot (W4-B · 2026-05-03) ─────────────────────
//
// Codex (and other weak/local models) burn turn budget on broad Grep
// storms because they don't know which paths in the repo to start with.
// AGENTS.md / CLAUDE.md describe the architecture in prose, but they
// don't enumerate the actual on-disk layout. This snapshot fills that
// gap: a `tree -L 2`-style pre-rendered view of the project's top-level
// directories with file counts, capped at projectTreeMaxChars() so the
// system prompt stays under budget.
//
// Cache strategy mirrors the project anchor — per-cwd, lifetime of the
// process. `resetUniversalPreambleCache()` clears it for tests / live
// disk mutations. The tree is cheap to compute (no file content reads,
// just `readdirSync` calls), but caching avoids re-walking on every turn.

/** Directories that are NEVER walked into for the tree snapshot —
 *  these are either generated, vendored, or VCS internals that don't
 *  inform the model about the project's structure. Match by exact name.
 *  Lang-specific additions: Rust (`target`), Java/Kotlin (`.gradle`,
 *  `pkg`), iOS/macOS (`Pods`, `DerivedData`), Python (`__pycache__`,
 *  `.venv`), JS (`node_modules`, `.next`), generic build (`dist`,
 *  `build`, `out`), VCS (`.git`). Mirrors codex-rs NOISY_DIR_NAMES +
 *  gemini-cli DEFAULT_IGNORED_FOLDERS. */
const PROJECT_TREE_SKIP_DIRS = new Set<string>([
  'node_modules', '.git', '.cache', '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'out', 'target', 'vendor', 'log', 'logs', 'tmp',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.tox', '.ruff_cache', 'coverage', '.nyc_output', '.parcel-cache',
  '.turbo', '.vercel', '.DS_Store',
  // Lang-specific additions (W4-B)
  '.gradle', 'pkg', 'Pods', 'DerivedData', '.idea', '.vscode',
  '.bundle', '.terraform', '.serverless', 'bower_components',
]);

export interface ProjectTreeEntry {
  name: string;
  /** 'dir' or 'file'. */
  kind: 'dir' | 'file';
  /** For files: byte size from statSync. For dirs: undefined. */
  bytes?: number;
  /** For dirs: child entry count from readdirSync (filtered). For
   *  files: undefined. */
  childCount?: number;
  /** For dirs we descended into: rendered children. Top-level only. */
  children?: ProjectTreeEntry[];
}

export interface ProjectTreeResult {
  /** Pre-rendered string ready to drop into a system message. `null`
   *  when the cwd has nothing readable. */
  content: string | null;
  /** Number of UTF-16 code units in the rendered content (post-truncation). */
  totalChars: number;
  /** Whether the renderer hit projectTreeMaxChars() and emitted a
   *  truncation marker. */
  truncated: boolean;
  /** Top-level entries the walker observed (pre-render — useful for
   *  tests that want to assert structure without parsing the rendered
   *  string). */
  topLevelCount: number;
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeStat(path: string): { isDir: boolean; bytes: number } | null {
  try {
    const s = statSync(path);
    return { isDir: s.isDirectory(), bytes: s.size };
  } catch {
    return null;
  }
}

function shouldSkipName(name: string): boolean {
  if (PROJECT_TREE_SKIP_DIRS.has(name)) return true;
  // Skip dotfiles at top-level except .gitignore/.env.example/etc which
  // would have informational value — but keep it simple: skip ALL dotfiles
  // for now. A repo's layout is mostly its non-hidden tree.
  if (name.startsWith('.')) return true;
  return false;
}

function walkProjectTree(cwd: string): ProjectTreeEntry[] {
  // W4-B — Sort top-level alphabetically. We DO NOT cap top-level
  // entries (a typical repo root has < 30 visible items after the skip
  // filter) — only per-dir children get the cap. If a project somehow
  // has 100+ top-level dirs the character cap will catch it.
  const top = safeReaddir(cwd).filter(n => !shouldSkipName(n)).sort();
  const entries: ProjectTreeEntry[] = [];
  for (const name of top) {
    const full = join(cwd, name);
    const st = safeStat(full);
    if (!st) continue;
    if (st.isDir) {
      const allChildNames = safeReaddir(full).filter(n => !shouldSkipName(n)).sort();
      // W4-B per-dir cap (codex pattern, DIR_ENTRY_LIMIT=20). When a
      // dir has more than 20 children, list the first 20 + emit a
      // synthetic `(... + N more)` marker so the model knows there's
      // more on disk. Without this cap, monad-agent's docs/ (1153
      // entries) ate the entire character budget and src/ got truncated.
      const childNamesShown = allChildNames.slice(0, PROJECT_TREE_DIR_ENTRY_LIMIT);
      const truncatedHere = allChildNames.length > PROJECT_TREE_DIR_ENTRY_LIMIT;
      const children: ProjectTreeEntry[] = [];
      for (const cname of childNamesShown) {
        const cfull = join(full, cname);
        const cst = safeStat(cfull);
        if (!cst) continue;
        if (cst.isDir) {
          // Count grandchildren without descending further.
          const gcCount = safeReaddir(cfull).filter(n => !shouldSkipName(n)).length;
          children.push({ name: cname, kind: 'dir', childCount: gcCount });
        } else {
          children.push({ name: cname, kind: 'file', bytes: cst.bytes });
        }
      }
      if (truncatedHere) {
        // Synthetic marker entry — distinct kind so the renderer can
        // emit a "(... + N more)" line. We reuse `kind: 'file'` with a
        // sentinel name; the renderer special-cases it.
        const remaining = allChildNames.length - PROJECT_TREE_DIR_ENTRY_LIMIT;
        children.push({ name: `__truncation_marker__:${remaining}`, kind: 'file' });
      }
      entries.push({ name, kind: 'dir', childCount: allChildNames.length, children });
    } else {
      entries.push({ name, kind: 'file', bytes: st.bytes });
    }
  }
  return entries;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

function renderProjectTree(entries: ProjectTreeEntry[], cwd: string): { content: string; totalChars: number; truncated: boolean } {
  // W4-B — codex-rs format: simple `- name/` with 2-space indent per
  // depth level. ~30% fewer tokens than ASCII tree (├── / └── / │)
  // because the indent is 2 chars instead of 4-5 and there are no UTF-8
  // box-drawing characters to encode.
  const lines: string[] = [];
  const root = basename(cwd) || cwd;
  lines.push(`${root}/`);
  let charsUsed = root.length + 2;
  let truncated = false;
  const tryPush = (line: string): boolean => {
    const cost = line.length + 1; // +1 for the newline join
    if (charsUsed + cost > projectTreeMaxChars()) {
      truncated = true;
      return false;
    }
    lines.push(line);
    charsUsed += cost;
    return true;
  };
  const renderEntry = (e: ProjectTreeEntry, depth: number): boolean => {
    const indent = '  '.repeat(depth);
    if (e.kind === 'file') {
      // Synthetic truncation marker (see walkProjectTree).
      if (e.name.startsWith('__truncation_marker__:')) {
        const remaining = e.name.split(':')[1] ?? '?';
        return tryPush(`${indent}- … (+${remaining} more)`);
      }
      const sizeLabel = e.bytes !== undefined ? ` (${formatBytes(e.bytes)})` : '';
      return tryPush(`${indent}- ${e.name}${sizeLabel}`);
    }
    // Directory line: `- name/  (N entries)`. Children render at
    // depth+1 with the same dash-indent convention.
    const dirCount = e.childCount !== undefined ? `  (${e.childCount} entries)` : '';
    if (!tryPush(`${indent}- ${e.name}/${dirCount}`)) return false;
    const children = e.children ?? [];
    for (const c of children) {
      if (!renderEntry(c, depth + 1)) return false;
    }
    return true;
  };
  for (const e of entries) {
    if (!renderEntry(e, 0)) break;
  }
  if (truncated) {
    lines.push(`…[truncated to fit ${projectTreeMaxChars()} chars project-tree budget]`);
  }
  const content = lines.join('\n');
  return { content, totalChars: content.length, truncated };
}

/** Compute the project tree snapshot WITHOUT cache. Use
 *  `loadProjectTree` for the cached path. */
export function loadProjectTreeWithMeta(cwd: string): ProjectTreeResult {
  const entries = walkProjectTree(cwd);
  if (entries.length === 0) {
    return { content: null, totalChars: 0, truncated: false, topLevelCount: 0 };
  }
  const rendered = renderProjectTree(entries, cwd);
  return {
    content: rendered.content,
    totalChars: rendered.totalChars,
    truncated: rendered.truncated,
    topLevelCount: entries.length,
  };
}

/** Cached project-tree lookup. Per-cwd cache lives for the process
 *  lifetime; tests/long-running daemons call `resetUniversalPreambleCache`
 *  to invalidate. */
export function loadProjectTree(cwd: string): ProjectTreeResult {
  if (_projectTreeCache && _projectTreeCache.cwd === cwd) {
    return _projectTreeCache.result;
  }
  const result = loadProjectTreeWithMeta(cwd);
  _projectTreeCache = { cwd, result };
  if (debug.enabled) {
    debug.log('chat.project-tree', result.content ? 'loaded' : 'empty', {
      cwd,
      totalChars: result.totalChars,
      truncated: result.truncated,
      topLevelCount: result.topLevelCount,
      capChars: projectTreeMaxChars(),
    });
  }
  return result;
}

/** Walk up from `cwd` looking for a project root marker (`.git`
 *  directory). Stops at the first marker found OR at the filesystem
 *  root (in which case `cwd` itself is treated as root). Mirrors
 *  ref/codex's `agents_md_paths` walk in `core/src/agents_md.rs:213`
 *  with the default `project_root_markers = ['.git']`. */
function findProjectRoot(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/** Build the ordered chain from project root → cwd inclusive. Each
 *  entry is an absolute directory path. Used by the hierarchical
 *  AGENTS.md loader so per-directory fragments concatenate root-first
 *  (most general) to cwd-last (most specific) — the same order
 *  ref/codex emits in `read_agents_md`. */
function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = [];
  let dir = cwd;
  for (;;) {
    chain.unshift(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

/** Return the raw project anchor result (text + per-file telemetry).
 *  Useful for tests / `chat.project-anchor` debug logging. Does NOT
 *  cache — every call re-reads disk. Use `loadProjectAnchor` for the
 *  cached path.
 *
 *  Hierarchical loading (gap G1, ref/codex `core/src/agents_md.rs`):
 *  walk from project root (`.git` marker) down to cwd, reading the
 *  configured anchor candidates at every level. Root-most fragments land
 *  first so general project guidance precedes sub-package specifics. Same
 *  character budget — ancestor fragments consume budget before cwd's, but
 *  in practice the chain is shallow (≤ 5 dirs) and individual AGENTS
 *  files are small. */
export function loadProjectAnchorWithMeta(cwd: string): ProjectAnchorResult {
  const parts: string[] = [];
  const files: ProjectAnchorMeta[] = [];
  const skipped: ProjectAnchorSkippedFile[] = [];
  let charsUsed = 0;
  const TRUNCATION_MARKER = '\n…[truncated to fit anchor budget]';
  const root = findProjectRoot(cwd);
  const chain = ancestorChain(root, cwd);
  const readWithBudget = (dir: string, filename: string, label: string): void => {
    const relDir = relative(cwd, dir);
    const skip = (reason: ProjectAnchorSkipReason): void => {
      skipped.push({ filename, relDir, reason });
    };
    if (charsUsed >= projectAnchorMaxChars()) {
      skip('budget-exhausted');
      return;
    }
    const path = join(dir, filename);
    if (!existsSync(path)) {
      skip('absent');
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
      projectAnchorReadObserverForTest?.(path);
    } catch {
      skip('read-failed');
      return;
    }
    const remaining = projectAnchorMaxChars() - charsUsed;
    const truncated = raw.length > remaining;
    const sliceLen = truncated ? Math.max(0, remaining - TRUNCATION_MARKER.length) : raw.length;
    const content = truncated ? `${raw.slice(0, sliceLen)}${TRUNCATION_MARKER}` : raw;
    // Disambiguate fragments from different scopes in the inline
    // header so the model can tell "this is the root project guide"
    // from "this is the sub-package override". Empty relDir = cwd
    // itself, render plain filename for backwards-compat with the
    // single-fragment case.
    const scopeSuffix = relDir === '' ? '' : ` @ ${relDir}`;
    parts.push(`=== ${label} (${filename}${scopeSuffix}) ===\n${content}\n=== end ${filename}${scopeSuffix} ===`);
    charsUsed += content.length;
    files.push({ filename, chars: content.length, truncated, relDir });
  };
  for (const dir of chain) {
    for (const candidate of PROJECT_ANCHOR_CANDIDATES) {
      readWithBudget(dir, candidate.filename, candidate.label);
    }
    for (const filename of PROJECT_ANCHOR_NON_CANDIDATE_FILENAMES) {
      if (existsSync(join(dir, filename))) {
        skipped.push({ filename, relDir: relative(cwd, dir), reason: 'policy-excluded' });
      }
    }
  }
  return {
    content: parts.length > 0 ? parts.join('\n\n') : null,
    files,
    skipped,
    totalChars: charsUsed,
  };
}

function projectAnchorCandidates(cwd: string): string[] {
  const root = findProjectRoot(cwd);
  return ancestorChain(root, cwd).flatMap(dir => [
    ...PROJECT_ANCHOR_CANDIDATES.map(({ filename }) => join(dir, filename)),
    ...PROJECT_ANCHOR_NON_CANDIDATE_FILENAMES.map(filename => join(dir, filename)),
  ]);
}

function projectAnchorMtimes(candidates: string[]): ProjectAnchorCandidate[] {
  return candidates.map(path => {
    try {
      return { path, mtimeMs: statSync(path).mtimeMs };
    } catch {
      return { path, mtimeMs: null };
    }
  });
}

function projectAnchorSnapshotsMatch(
  left: ProjectAnchorCandidate[],
  right: ProjectAnchorCandidate[],
): boolean {
  return left.length === right.length && left.every((candidate, index) =>
    candidate.path === right[index]!.path && candidate.mtimeMs === right[index]!.mtimeMs,
  );
}

function projectAnchorCacheIsFresh(entry: ProjectAnchorCacheEntry, candidates: string[]): boolean {
  return projectAnchorSnapshotsMatch(entry.candidates, projectAnchorMtimes(candidates));
}

/** Cached anchor lookup. Per-cwd entries refresh automatically when any
 *  candidate or policy-observed non-candidate is modified, created, or deleted. */
/** ⛔⭐⭐ **앵커가 «잘렸다」는 사실에 «읽는 자»를 둔다** (상설 PLAN §6 「새로 열린 것」 ①).
 *
 *  📏 실측 2026-08-25: `ProjectAnchorMeta.truncated` 도 `skipped[].reason==='budget-exhausted'` 도
 *  ***이 모듈 밖에 읽는 자가 «0»이었다.*** 그래서 예산이 차서 `DESIGN.md` 가 통째로 빠져도
 *  ***아무 일도 안 일어난다*** — 자식은 「디자인이 없는 저장소」로 읽고 조용히 진행한다.
 *
 *  ⛔⭐ 그리고 종전 관측은 `if (debug.enabled)` 뒤에 있었다 — ***그건 핫패스 게이트라 운영에서 꺼져 있다.***
 *  절단은 «드물고 결과가 크다» ⇒ ***항상 남긴다.*** (같은 판단의 선례 = `acp/server.ts` 세션 lifecycle)
 *
 *  📄 근거 = 내부 문서 `PLAN-the-loop-does-not-read-its-own-design-2026-08-24` §6 ① */
function observeProjectAnchorLoss(cwd: string, result: ProjectAnchorResult): void {
  const truncatedFiles = result.files.filter((file) => file.truncated).map((file) => file.filename);
  const budgetSkipped = result.skipped.filter((file) => file.reason === 'budget-exhausted').map((file) => file.filename);
  if (truncatedFiles.length === 0 && budgetSkipped.length === 0) return;
  debug.log('chat.project-anchor', 'budget-loss', {
    cwd,
    truncatedFiles,
    budgetSkipped,
    totalChars: result.totalChars,
    capChars: projectAnchorMaxChars(),
    // ⛔ 「얼마나 모자랐나」를 같이 낸다 — 「잘렸다」만으론 «얼마나» 키워야 할지 모른다
    overflowChars: Math.max(0, result.totalChars - projectAnchorMaxChars()),
  });
}

export function loadProjectAnchor(cwd: string): ProjectAnchorResult {
  const candidates = projectAnchorCandidates(cwd);
  const cached = _projectAnchorCache.get(cwd);
  if (cached && projectAnchorCacheIsFresh(cached, candidates)) {
    return cached.result;
  }

  // Cache only a stable read/stat snapshot. A write between reading an
  // anchor and recording its metadata must not pair stale content with the
  // new mtime and make the cache appear fresh forever.
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = projectAnchorMtimes(candidates);
    const result = loadProjectAnchorWithMeta(cwd);
    const after = projectAnchorMtimes(candidates);
    if (projectAnchorSnapshotsMatch(before, after)) {
      _projectAnchorCache.set(cwd, { result, candidates: after });
      observeProjectAnchorLoss(cwd, result);
      if (debug.enabled) {
        debug.log('chat.project-anchor', result.content ? 'loaded' : 'empty', {
          cwd,
          totalChars: result.totalChars,
          files: result.files,
          skipped: result.skipped,
          capChars: projectAnchorMaxChars(),
        });
      }
      return result;
    }
  }

  const result = loadProjectAnchorWithMeta(cwd);
  observeProjectAnchorLoss(cwd, result);
  if (debug.enabled) {
    debug.log('chat.project-anchor', result.content ? 'loaded' : 'empty', {
      cwd,
      totalChars: result.totalChars,
      files: result.files,
      skipped: result.skipped,
      capChars: projectAnchorMaxChars(),
    });
  }
  return result;
}

/** Build the surface-agnostic preamble. Surfaces spread the result
 *  into their own preamble; e.g.
 *
 *  ```ts
 *  return [
 *    ...buildUniversalPreamble({ cwd }),
 *    ...planModeSystemMsgs,
 *    // …surface-specific builders…
 *  ];
 *  ```
 */
export function buildUniversalPreamble(ctx: UniversalPreambleContext): LLMMessage[] {
  const out: LLMMessage[] = [];
  // ★ 자기인지 공간 프레임(2026-07-21) — 격리 하니스 공간 안이면 최상단에 실행-맥락 자기인지를 심는다
  //   (프로젝트 앵커보다 먼저 = "너는 격리 샌드박스의 elanous"라는 정체성이 나머지를 프레이밍). 공간 밖=무주입.
  out.push(...buildHarnessSpaceAddendum());
  // Keep the runtime path cached while loadProjectAnchorWithMeta remains the test/debug reader.
  const result = loadProjectAnchor(ctx.cwd);
  if (result.content) {
    // W5-D companion (2026-05-03 PM) — Header instructs the model that
    // the anchor below IS the file content, so Read/Grep on AGENTS.md
    // / CLAUDE.md is redundant. Without this, codex was observed
    // (log/debug-20260503125128) emitting Read({file_path: 'AGENTS.md'})
    // 5× across 5 turns even with the file content already in context.
    // The dispatcher blocks those calls (anchor-grep-blocked / anchor-
    // read-blocked) but the redirect costs a turn each. The header
    // tells the model upfront: this IS the file, don't re-fetch.
    //
    // Only mention files actually present (the anchor result.files
    // list reflects what was read), so a project with only CLAUDE.md
    // doesn't see a misleading AGENTS.md reference.
    const fileList = result.files.map(f => `\`${f.filename}\``).join(' and ');
    const header = result.files.length > 0
      ? (
        `## Project Anchor — full text of ${fileList} inline below.\n` +
        `(Already in context — refer to this text instead of re-reading the file.)\n\n`
      )
      : '';
    out.push({ role: 'system', content: `${header}${result.content}` });
  }
  // W4-B (2026-05-03) — Project tree light snapshot. Pre-renders a
  // `tree -L 2`-style overview of the cwd's top-level layout (file
  // counts per directory, key file sizes) so the model can navigate
  // straight to relevant paths instead of issuing broad Grep storms.
  // Skip when the walker found nothing readable (empty/tmp dirs in
  // tests). Lands AFTER the anchor (architecture prose first, then
  // concrete on-disk shape) and BEFORE the lifecycle so the model sees
  // the layout when planning which pipeline stage to use.
  const tree = loadProjectTree(ctx.cwd);
  if (tree.content) {
    out.push({
      role: 'system',
      content: `## Project Layout (top-level + 1 depth)\n\n\`\`\`\n${tree.content}\n\`\`\`\n\nUse this layout to pick directories directly instead of issuing broad project-root Grep/Glob calls. When AGENTS.md / CLAUDE.md describe a track or subsystem, this layout shows where its files actually live.`,
    });
  }
  if (!ctx.enabledTools?.length) {
    out.push({ role: 'system', content: NO_TOOLS_VERIFICATION_GUIDANCE });
  }
  // P4 (2026-05-03) — Family-agnostic coding-agent lifecycle. Append
  // before family addendum so codex (which has its own discipline
  // overlay) sees both: lifecycle (what shape) + addendum (how to behave
  // inside that shape). Other families see lifecycle alone.
  out.push(...buildCodingLifecycleAddendum());
  // Family-specific behavioral addendums. Append after the anchor +
  // lifecycle so the model sees project context first, then the generic
  // pipeline shape, then per-family discipline.
  if (ctx.modelFamily === 'codex') {
    out.push(...buildCodexFamilyAddendum());
  }
  // Wave 2 (2026-05-04) — gemini-3.x's documented weakness on multi-
  // turn analysis prompts is silent single-turn termination (emit text
  // from training memory, skip tool calls). Addendum forces tool-use
  // for project-specific prompts + parallelize-by-default rhythm,
  // matching ref/gemini-cli's Core Mandates / Tool Usage sections.
  // 🩸⭐⭐ 2026-09-13 (🅕) — ***`gpt` 칸이 «없어서» `gpt-6-astra` 가 규율을 하나도 못 받았다.***
  //    `models/prompts.ts` 는 `startsWith('gpt-5')` 만 codex 로 보내므로 gen-6 은 `gpt` 로 떨어진다.
  //    그 상태로 이 저장소의 `AGENTS.md`·`CLAUDE.md`(⛔ 금지 수백 줄)를 앵커로 받았고,
  //    관측된 결과가 ***멈춤·되묻기·산출 0*** 이었다(인계 §10·§36·§37).
  //    ⇒ 공식 GPT-6 가이드의 문면을 «옮겨» 채운다 — 출처·사각은 `gpt6-family-addendum.ts`.
  //    ⛔ 이것은 계열 판정기 수리가 «아니다»(그 23곳은 별개 축).
  if (ctx.modelFamily === 'gpt') {
    out.push(...buildGpt6FamilyAddendum());
  }
  if (ctx.modelFamily === 'gemini') {
    out.push(...buildGeminiFamilyAddendum());
  }
  // Wave 3 (2026-05-04) — claude family is already aligned on
  // elanous's analysis benchmark (15-17 calls / 9-10K chars baseline);
  // addendum codifies engineering standards (read-first, no gold-
  // plating, faithful reporting, verification) so behavior matches
  // the model's full capability rather than a quality push. Pattern
  // source: ref/claude-code-fork `getSimpleDoingTasksSection` +
  // related sections; conciseness directives intentionally NOT
  // brought over (collide with elanous's analysis depth requirement).
  if (ctx.modelFamily === 'claude') {
    out.push(...buildAnthropicFamilyAddendum());
  }
  if (ctx.modelFamily === 'grok') {
    out.push(...buildGrokFamilyAddendum(ctx.enabledTools));
  }
  // Wave 3 (2026-05-04) — session-specific guidance based on the
  // active toolset. Family-agnostic; emits 0-1 system message with
  // per-tool one-liners (e.g. `AskUserQuestion` active → use it for
  // tool-deny clarification; `Agent` active → search vs Agent split;
  // `TaskCreate` active → don't batch). Pattern source: ref/claude-
  // code-fork `getSessionSpecificGuidanceSection`. Lands AFTER the
  // family addendum so a per-tool directive can override family
  // defaults when the tool is in scope.
  out.push(...buildSessionGuidanceAddendum(ctx.enabledTools));
  if (debug.enabled) {
    debug.log('chat.universal-preamble', 'built', {
      cwd: ctx.cwd,
      modelFamily: ctx.modelFamily ?? null,
      hasProjectAnchor: result.content !== null,
      anchorChars: result.totalChars,
      anchorFiles: result.files.map(f => f.filename),
      anchorSkipped: result.skipped,
      hasProjectTree: tree.content !== null,
      treeChars: tree.totalChars,
      treeTopLevelCount: tree.topLevelCount,
      treeTruncated: tree.truncated,
      messageCount: out.length,
      harnessSpace: getHarnessSpace()?.kind ?? null,   // ★ 자기인지 공간 인식 여부(2026-07-21)
    });
  }
  return out;
}
