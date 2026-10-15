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

import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, relative, resolve as resolvePath } from 'node:path';
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
import { effectiveInstanceRoot } from '../instance/resolve.js';

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

/** 🪪 자리 로컬 지시(L0 정체성 · 2026-10-14 · 대표 «TUI 가 자기를 인식 못하면 쓸 수 없다»).
 *  git 에 안 올라가는 «이 디렉터리만의» 지시 — 같은 저장소의 여러 자리(`seats/OP` 등)가 역할을 갈라 갖는 자리다.
 *  한 디렉터리에서 «하나만» 읽는다: `AGENTS.local.md`(엘라누스 정본 이름)가 있으면 그것, 없으면 호환 `CLAUDE.local.md`.
 *  ⚠️ 위 정책 제외는 «공용» `CLAUDE.md` 만이다 — 로컬 파일은 자리 주인이 쓴 비공유 지시라 별개 축이다.
 *  선례: codex `AGENTS.override.md`(`core/src/agents_md.rs:45`) · grok-build `CLAUDE.local.md`(`compat.rs:309-316`). */
export const PROJECT_ANCHOR_LOCAL_CANDIDATES = [
  { filename: 'AGENTS.local.md', label: 'Directory-local instructions (overrides the shared guide)' },
  { filename: 'CLAUDE.local.md', label: 'Directory-local instructions (compat · overrides the shared guide)' },
] as const;
/** 로컬 지시는 공용 앵커와 «따로» 예산을 쓴다 — 공용 `AGENTS.md` 가 상한 가까이라 같은 예산이면 자리 지시가
 *  통째로 빠진다(10-14 실측: 공용 33,050자 / 36K). 그 반대로 로컬이 공용을 밀어내지도 않는다. */
export const PROJECT_ANCHOR_LOCAL_MAX_CHARS = 8 * 1024;
export const PROJECT_ANCHOR_LOCAL_LEAN_MAX_CHARS = 2 * 1024;
export function projectAnchorLocalMaxChars(): number { return promptBudgetLean() ? PROJECT_ANCHOR_LOCAL_LEAN_MAX_CHARS : PROJECT_ANCHOR_LOCAL_MAX_CHARS; }

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
of these three pipelines. Do not tell the user which pipeline you chose
(no "I'll use the analysis pipeline" / "○○ 파이프라인으로 하겠습니다") —
the user sees your tool calls, and the pipeline name adds nothing. Just
execute the next stage; your tool calls are the audit trail.

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
- Pick ONE pipeline at the START of the task, silently — never name it
  in your answer. On follow-up turns just call the next stage's tools
  directly.
- Each stage = ONE turn (or one parallel batch within a turn). Don't
  spread \`find\` across 4 sequential turns — batch the tools.
- **find → read transition is MANDATORY** after the first \`find\` batch
  produces candidate paths. Do not issue a second \`find\` batch
  searching the SAME paths/globs with different keywords — the
  candidates are already on the table; advance to \`read\`.
- For Analysis: stop at \`organize\`. Don't drift into edit/exec.
- For Implementation/Debugging: \`verify\` is mandatory. "I made the
  change" without verification is incomplete output.
- Pick a pipeline ONLY when you actually need to use it. Pure conversational
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
  /** 자리 로컬 지시(`AGENTS.local.md`·`CLAUDE.local.md`)에서 왔나 — 공용 앵커와 예산·순서가 다르다. */
  local?: true;
  /** 층(L0 v2): global = 우주 뿌리(`effectiveInstanceRoot`)의 `AGENTS.md` · root = 저장소 루트 · dir = 루트→cwd 사이·cwd 의 디렉터리 · local = `*.local.md`. */
  layer?: ProjectAnchorLayer;
  /** 읽은 파일의 절대 경로(관측용). */
  path?: string;
}

export type ProjectAnchorLayer = 'global' | 'root' | 'dir' | 'local' | 'last-session';

/** 🪪 TUI 가 통째로 소유하는 «지난 세션» 파일(`dashboard/seat-local-instructions.ts` 가 대화 끝마다 쓴다).
 *  층 ④ 뒤에 싣는다. 작아야 정상이라 상한을 넘으면 자른다(사람 지시가 아니다). */
export const PROJECT_ANCHOR_LAST_SESSION_FILE = '.AGENTS.local.last-session.md';
export const PROJECT_ANCHOR_LAST_SESSION_MAX_CHARS = 2 * 1024;

export type ProjectAnchorSkipReason = 'budget-exhausted' | 'absent' | 'read-failed' | 'policy-excluded' | 'shadowed';

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
 *  character budget — allocate from cwd toward root and global so the
 *  most specific instructions remain intact; render outer-first. */
export function loadProjectAnchorWithMeta(cwd: string): ProjectAnchorResult {
  // L0 v2(대표 10-14) — 층 넷: ① 전역(우주 뿌리 `AGENTS.md`) ② 저장소 루트 AGENTS.md·DESIGN.md
  //   ③ 루트→cwd 사이 각 디렉터리(codex 식) ④ 로컬 `AGENTS.local.md`(호환 `CLAUDE.local.md`).
  //   «예산»은 ④ 먼저(자르지 않는다 · 로컬 상한을 넘으면 경고 관측) → ③(cwd→부모) → ② → ① 순으로 받고,
  //   «싣는» 순서는 ① → ② → ③(루트→cwd) → ④ — 안쪽이 바깥을 덮는다(codex·Claude Code 와 같은 규칙).
  //   ⇒ 예산이 모자라면 잘리는 순서는 ① → ② → ③(얕은 것부터), ④ 는 안 잘린다.
  const files: ProjectAnchorMeta[] = [];
  const skipped: ProjectAnchorSkippedFile[] = [];
  const TRUNCATION_MARKER = '\n…[truncated to fit anchor budget]';
  const root = findProjectRoot(cwd);
  const chain = ancestorChain(root, cwd);
  interface Slot { order: number; text?: string; meta?: ProjectAnchorMeta; skip?: ProjectAnchorSkippedFile }
  const slots: Slot[] = [];
  const fence = (label: string, filename: string, scope: string, content: string): string =>
    `=== ${label} (${filename}${scope}) ===\n${content}\n=== end ${filename}${scope} ===`;
  const readRaw = (path: string): string | null => {
    try {
      const raw = readFileSync(path, 'utf8');
      projectAnchorReadObserverForTest?.(path);
      return raw;
    } catch {
      return null;
    }
  };

  const localRaw = new Map<string, string>();
  // ④ 로컬 — 먼저 읽고 자르지 않는다. 디렉터리마다 하나(AGENTS.local.md 가 이기고 CLAUDE.local.md 는 shadowed).
  const LOCAL_ORDER_BASE = 1_000_000;
  let localUsed = 0;
  chain.forEach((dir, index) => {
    const relDir = relative(cwd, dir);
    const present = PROJECT_ANCHOR_LOCAL_CANDIDATES.filter(({ filename }) => existsSync(join(dir, filename)));
    const chosen = present[0];
    if (!chosen) return;
    for (const other of present.slice(1)) slots.push({ order: LOCAL_ORDER_BASE + index * 10 + 1, skip: { filename: other.filename, relDir, reason: 'shadowed' } });
    const path = join(dir, chosen.filename);
    const raw = readRaw(path);
    if (raw === null) {
      slots.push({ order: LOCAL_ORDER_BASE + index * 10, skip: { filename: chosen.filename, relDir, reason: 'read-failed' } });
      return;
    }
    localUsed += raw.length;
    localRaw.set(path, raw);
    const scope = relDir === '' ? '' : ` @ ${relDir}`;
    slots.push({
      order: LOCAL_ORDER_BASE + index * 10,
      text: fence(chosen.label, chosen.filename, scope, raw),
      meta: { filename: chosen.filename, chars: raw.length, truncated: false, relDir, local: true, layer: 'local', path },
    });
  });
  // ⑤ 지난 세션 — TUI 소유 파일. 로컬 지시 «뒤»(가장 안쪽 · 가장 최근 맥락). «cwd 의 자리 루트»(/seats/<자리>) 하나만 읽는다 —
  //   자리 밖 TUI 나 상위 디렉터리의 같은 이름 파일을 «지난 세션»으로 싣지 않게. 사람 파일이 아니므로 상한에서 자르고 읽기도 상한만큼만.
  const lastSessionPath = seatLastSessionPath(cwd);
  if (lastSessionPath) {
    const relDir = relative(cwd, dirname(lastSessionPath));
    let regular: boolean | null = null;
    try { regular = lstatSync(lastSessionPath).isFile(); } catch { regular = null; /* 없음 */ }
    if (regular === false) {
      // ⛔ 링크·비정규 파일은 읽지 않는다(바깥 파일 주입 차단 · 기록기도 링크를 거부한다).
      slots.push({ order: 2_000_000, skip: { filename: PROJECT_ANCHOR_LAST_SESSION_FILE, relDir, reason: 'read-failed' } });
    } else if (regular === true) {
      const raw = readHeadChars(lastSessionPath, PROJECT_ANCHOR_LAST_SESSION_MAX_CHARS + 1);
      if (raw === null) {
        slots.push({ order: 2_000_000, skip: { filename: PROJECT_ANCHOR_LAST_SESSION_FILE, relDir, reason: 'read-failed' } });
      } else {
        const truncated = raw.length > PROJECT_ANCHOR_LAST_SESSION_MAX_CHARS;
        const content = truncated ? `${raw.slice(0, PROJECT_ANCHOR_LAST_SESSION_MAX_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}` : raw;
        localUsed += content.length;
        const scope = relDir === '' ? '' : ` @ ${relDir}`;
        slots.push({
          order: 2_000_000,
          text: fence('Previous TUI session in this seat (TUI-owned)', PROJECT_ANCHOR_LAST_SESSION_FILE, scope, content),
          meta: { filename: PROJECT_ANCHOR_LAST_SESSION_FILE, chars: content.length, truncated, relDir, layer: 'last-session', path: lastSessionPath },
        });
      }
    }
  }
  const localCap = projectAnchorLocalMaxChars();
  if (localUsed > localCap) {
    // ⛔ 자르지 않는다(대표 «먼저 읽게») — 대신 넘친 만큼 공용 예산이 준다. 그 사실을 «읽을 때마다» 게이트 없이 남긴다
    //   (캐시 적중 턴은 같은 결과를 다시 쓰는 것이라 새로 남기지 않는다 — 파일이 바뀌면 다시 읽혀 다시 남는다).
    debug.log('chat.project-anchor', 'local-over-cap', { cwd, localChars: localUsed, localCapChars: localCap });
  }
  // 공용 예산 = 공용 상한. 로컬이 자기 상한을 넘으면 넘친 만큼 공용에서 뺀다(합계 상한 = 공용 + 로컬).
  const sharedCap = Math.max(0, Math.min(projectAnchorMaxChars(), projectAnchorMaxChars() + localCap - localUsed));
  let sharedUsed = 0;

  // ①②③ 를 «예산 우선순위»로 줄 세운다: cwd → 부모 디렉터리 → 루트 → 전역. order 는 «싣는» 순서다.
  interface Want { order: number; path: string; filename: string; label: string; relDir: string; scope: string; layer: ProjectAnchorLayer; recordAbsent: boolean }
  const wants: Want[] = [];
  const globalPath = globalAnchorPath();
  // 우주 뿌리가 저장소 트리 안이면(예: `--test=<트리>`) 전역 파일이 곧 ②·③ 의 AGENTS.md 다 — 두 번 싣지 않는다.
  const chainAgents = new Set(chain.map((dir) => safeRealpath(join(dir, 'AGENTS.md'))));
  const dirWants = (index: number): Want[] => {
    const dir = chain[index]!;
    const relDir = relative(cwd, dir);
    return PROJECT_ANCHOR_CANDIDATES.map(({ filename, label }, k) => ({
      order: 100 + index * 10 + k,
      path: join(dir, filename),
      filename,
      label,
      relDir,
      scope: relDir === '' ? '' : ` @ ${relDir}`,
      layer: (index === 0 ? 'root' : 'dir') as ProjectAnchorLayer,
      recordAbsent: true,
    }));
  };
  for (let index = chain.length - 1; index >= 0; index--) wants.push(...dirWants(index));
  if (globalPath && existsSync(globalPath) && !chainAgents.has(safeRealpath(globalPath))) {
    wants.push({ order: 0, path: globalPath, filename: basename(globalPath), label: 'User-global instructions', relDir: relative(cwd, dirname(globalPath)), scope: ' @ instance root', layer: 'global', recordAbsent: false });
  }
  for (const want of wants) {
    const skip = (reason: ProjectAnchorSkipReason): void => {
      slots.push({ order: want.order, skip: { filename: want.filename, relDir: want.relDir, reason } });
    };
    // 남은 예산이 절단 마커보다 «작으면» «잘라 싣기»가 상한을 넘긴다 — 그때는 통째로 뺀다(같으면 마커만 싣는다).
    if (sharedCap - sharedUsed < TRUNCATION_MARKER.length) { if (want.recordAbsent || existsSync(want.path)) skip('budget-exhausted'); continue; }
    if (!existsSync(want.path)) { if (want.recordAbsent) skip('absent'); continue; }
    const raw = readRaw(want.path);
    if (raw === null) { skip('read-failed'); continue; }
    const remaining = sharedCap - sharedUsed;
    const truncated = raw.length > remaining;
    const sliceLen = truncated ? Math.max(0, remaining - TRUNCATION_MARKER.length) : raw.length;
    const content = truncated ? `${raw.slice(0, sliceLen)}${TRUNCATION_MARKER}` : raw;
    sharedUsed += content.length;
    slots.push({
      order: want.order,
      text: fence(want.label, want.filename, want.scope, content),
      meta: { filename: want.filename, chars: content.length, truncated, relDir: want.relDir, layer: want.layer, path: want.path },
    });
  }
  chain.forEach((dir, index) => {
    for (const filename of PROJECT_ANCHOR_NON_CANDIDATE_FILENAMES) {
      if (existsSync(join(dir, filename))) {
        slots.push({ order: 100 + index * 10 + 9, skip: { filename, relDir: relative(cwd, dir), reason: 'policy-excluded' } });
      }
    }
  });

  slots.sort((a, b) => a.order - b.order);
  const parts: string[] = [];
  for (const slot of slots) {
    if (slot.text !== undefined && slot.meta) { parts.push(slot.text); files.push(slot.meta); }
    if (slot.skip) skipped.push(slot.skip);
  }
  const result: ProjectAnchorResult = {
    content: parts.length > 0 ? parts.join('\n\n') : null,
    files,
    skipped,
    totalChars: sharedUsed + localUsed,
  };
  // 읽은 로컬 원문 — 자기 편집 비교·백업용(관측 로그에 안 실리게 결과 객체 밖에 둔다).
  localRawByResult.set(result, localRaw);
  return result;
}

function safeRealpath(path: string): string {
  try { return realpathSync(path); } catch { return resolvePath(path); }
}

const SEAT_ROOT_IN_PATH = /^(.*?\/seats\/[A-Za-z][A-Za-z0-9_-]{0,63})(?:\/|$)/;
/** cwd 가 `/seats/<자리>` 아래면 그 자리 루트의 «지난 세션» 파일 경로. 자리 밖이면 null. */
export function seatLastSessionPath(cwd: string): string | null {
  const m = SEAT_ROOT_IN_PATH.exec(cwd);
  return m ? join(m[1]!, PROJECT_ANCHOR_LAST_SESSION_FILE) : null;
}

/** 파일 앞부분만 읽는다(문자 상한의 4배 바이트까지 — UTF-8 최대 폭). */
function readHeadChars(path: string, maxChars: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(maxChars * 4);
    const n = readSync(fd, buf, 0, buf.length, 0);
    projectAnchorReadObserverForTest?.(path);
    return buf.subarray(0, n).toString('utf8').slice(0, maxChars);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

let globalAnchorPathOverride: string | null | undefined;
/** 시험 심 — 전역 앵커 경로를 바꾼다(null = 전역 층 끄기 · undefined = 기본 · 우주 뿌리의 `AGENTS.md`). */
export function setGlobalAnchorPathForTest(path: string | null | undefined): void {
  globalAnchorPathOverride = path;
}
/** ① 전역 층 — 사용자 공통 지시. «이 프로세스의 우주» 뿌리(`effectiveInstanceRoot` — 운영이면 `~/.elanous`,
 *  `--test`·`--config-dir`·`ELANOUS_STATE_DIR` 면 그 우주)의 `AGENTS.md` 다. ⛔ 홈 경로를 박지 않는다 — 격리 우주가
 *  운영 파일을 읽으면 안 된다(isolation-gate). 뿌리를 못 정하면 전역 층을 끈다. */
export function globalAnchorPath(): string | null {
  if (globalAnchorPathOverride !== undefined) return globalAnchorPathOverride;
  try {
    return join(effectiveInstanceRoot(), 'AGENTS.md');
  } catch {
    return null;
  }
}

function projectAnchorCandidates(cwd: string): string[] {
  const root = findProjectRoot(cwd);
  const globalPath = globalAnchorPath();
  return [...(globalPath ? [globalPath] : []), ...ancestorChain(root, cwd).flatMap(dir => [
    ...PROJECT_ANCHOR_CANDIDATES.map(({ filename }) => join(dir, filename)),
    ...PROJECT_ANCHOR_NON_CANDIDATE_FILENAMES.map(filename => join(dir, filename)),
    ...PROJECT_ANCHOR_LOCAL_CANDIDATES.map(({ filename }) => join(dir, filename)),
  ]), ...(seatLastSessionPath(cwd) ? [seatLastSessionPath(cwd)!] : [])];
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
    // 로컬 지시는 따로 예산이라 공용 상한과 비교할 때는 뺀다.
    overflowChars: Math.max(0, result.files.filter((file) => !file.local).reduce((sum, file) => sum + file.chars, 0) - projectAnchorMaxChars()),
  });
}

/** 🪪 자리 로컬 지시가 «바뀌었다»를 남긴다 — TUI 에이전트가 자기 지시 파일을 고치면(Edit 등) 다음 조회에서
 *  mtime 이 바뀌어 다시 읽히고, 그때 «문면»이 달라졌으면(mtime 만 바뀐 touch 는 아니다) 관측 한 줄 ⊕ 직전 판 백업 한 벌.
 *  ⛔ 이 파일은 git 제외라 모델이 잘못 고치면 되돌릴 이력이 없다 ⇒ 직전 내용을 같은 폴더 `.<파일>.prev` 로 덮어쓴다.
 *  드물고 결과가 크니 항상 남긴다(게이트 없음). 백업 실패는 관측만 하고 앵커를 막지 않는다. */
const localRawByResult = new WeakMap<ProjectAnchorResult, Map<string, string>>();

function observeLocalInstructionEdits(cwd: string, previous: ProjectAnchorResult | undefined, next: ProjectAnchorResult): void {
  if (!previous) return;
  for (const file of next.files) {
    if (!file.local) continue;
    const before = previous.files.find((f) => f.local && f.filename === file.filename && f.relDir === file.relDir);
    if (!before) continue;
    // ⛔ 펜스 문면을 역파싱하지 않는다(본문에 `=== end …` 줄이 있으면 잘린다) — 읽은 원문 그대로 비교·백업.
    const prevBody = before.path ? localRawByResult.get(previous)?.get(before.path) ?? null : null;
    const nextBody = file.path ? localRawByResult.get(next)?.get(file.path) ?? null : null;
    if (prevBody === nextBody) continue;
    let prevPath: string | null = null;
    let backupError: string | undefined;
    if (prevBody !== null && file.path) {
      prevPath = join(dirname(file.path), `.${file.filename}.prev`);
      try {
        writeFileSync(prevPath, prevBody);
      } catch (err) {
        backupError = err instanceof Error ? err.message : String(err);
        prevPath = null;
      }
    }
    debug.log('tui.local-instructions', 'edited', {
      cwd,
      file: file.relDir ? `${file.relDir}/${file.filename}` : file.filename,
      charsBefore: before.chars,
      charsAfter: file.chars,
      truncated: file.truncated,
      prevPath,
      ...(backupError ? { backupError } : {}),
    });
  }
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
      observeLocalInstructionEdits(cwd, cached?.result, result);
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
    const hasLocal = result.files.some(f => f.local);
    const header = result.files.length > 0
      ? (
        `## Project Anchor — full text of ${fileList} inline below.\n` +
        `(Already in context — refer to this text instead of re-reading the file.)\n` +
        (hasLocal
          ? `Directory-local instructions (\`*.local.md\`) come last and are specific to this working directory — they define your role here and take precedence over the shared guide where they differ.\n` +
            `That local file is YOUR OWN instruction file: when you learn a lesson or your role changes, edit it yourself with your file-edit tools (keep sections short; never edit the TUI-owned \`.AGENTS.local.last-session.md\`). Your edits load on the next turn.\n`
          : '') +
        `\n`
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
      // L0 v2 — 층·경로·잘림을 한 줄씩(어느 층이 실렸고 어디서 잘렸나).
      anchorLayers: result.files.map(f => ({ layer: f.layer ?? null, path: f.path ?? null, chars: f.chars, truncated: f.truncated })),
      anchorLocalFiles: result.files.filter(f => f.local).map(f => (f.relDir ? `${f.relDir}/${f.filename}` : f.filename)),
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
