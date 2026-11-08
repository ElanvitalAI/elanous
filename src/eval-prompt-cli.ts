import type { LLMToolSpec } from './llm/tool-spec.js';
// ── elanous ask — single-shot CLI prompt evaluator ─────────────────────────
//
// Headless entry that pipes a single user prompt through the same LLM
// dispatch surface the dashboard chat uses (universal preamble +
// native-tool catalog + streamLLMWithTools), prints text + tool-call
// telemetry to stdout, and exits. Lets us self-validate codex pipeline
// fixes from the command line — e.g. after editing src/llm.ts:
//
//   bun run src/index.ts ask --model gpt-5.4 \
//     "이 프로젝트의 디버깅 파이프라인 분석해주세요"
//
// then inspect log/latest for the new chat.universal-preamble /
// chat.project-tree / tool-loop.* events without restarting a daemon
// or asking a human to type the prompt.
//
// Scope: this module only wires the LLM loop. It does NOT spin up the
// dashboard, ACP server, plugin host, or telegram bot. Tools are the
// "skill"-surface catalog (Read / Grep / Glob / ListDir / AstGrep /
// Lsp / Edit / Write / Bash / WebFetch / WebSearch). Dashboard-only
// tools (DashboardSlashExecute, WidgetCall, etc.) are intentionally
// excluded — they would error without a live dashboard host anyway.

import { requirePosixShell } from './platform/default-shell.js';
import { type LLMMessage, type LLMProvider, getProviderForConfig, resolveDefaultProvider, streamLLMWithTools } from './llm.js';
import { buildUniversalPreamble } from './prompt-library/universal-preamble.js';
import { elanousSelfAccessPrompt } from './agent/self-ambient.js';
import { getModelFamily } from './models/prompts.js';
import {
  applyRotationEntry,
  getUserConfig,
  jumpToRotationEntry,
  type UserConfig,
} from './user-config.js';
import { buildBashTool, dispatchBash } from './skills/tools/index.js';
import { buildReadTool, dispatchRead } from './skills/tools/read.js';
import { buildEditTool, dispatchEdit } from './skills/tools/edit.js';
import { buildWriteTool, dispatchWrite } from './skills/tools/write.js';
import { buildGrepTool, dispatchGrep } from './skills/tools/grep.js';
import { buildGlobTool, dispatchGlob } from './skills/tools/glob.js';
import { buildListDirTool, dispatchListDir } from './skills/tools/list-dir.js';
import { buildAstGrepTool, dispatchAstGrep } from './skills/tools/ast-grep.js';
import { buildLspTool, dispatchLsp } from './skills/tools/lsp/index.js';
import { buildWebFetchTool, dispatchWebFetch } from './skills/tools/webfetch.js';
import { buildWebSearchTool, dispatchWebSearch } from './skills/tools/web-search.js';
import { buildGetDashboardStateTool } from './skills/tools/dashboard-state.js';
import {
  buildTerminalModalListTool,
  buildTerminalModalObserveTool,
  buildTerminalModalFocusTool,
  buildTerminalModalDetachTool,
  buildTerminalModalKillTool,
} from './skills/tools/terminal-modal.js';
import { SessionCache } from './session/cache.js';
import { toolSurface } from './boot/daemon-tools/index.js';
import type { DaemonToolSurface } from './boot/daemon-tools/types.js';
import { debug } from './debug/log.js';
import { copyFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** 지원 서피스 **단일 출처** — 타입·런타임 가드·에러 문구가 전부 여기서 파생된다.
 *  각자 나열하면 서피스가 늘 때 조용히 어긋난다(리뷰 must-fix). */
export const EVAL_PROMPT_TOOL_SURFACES = ['cli', 'chat', 'webterm'] as const;
export type EvalPromptToolSurface = (typeof EVAL_PROMPT_TOOL_SURFACES)[number];

/** ⭐ repro 파리티 축 ①: **프롬프트**(2026-07-27) — `--tools chat|webterm` 은 "데몬이 쓰는
 *  서피스를 재현하겠다" 는 뜻인데 종전엔 **툴 목록만** 맞추고 시스템 프롬프트는 안 맞췄다.
 *  데몬은 `elanousSelfAccessPrompt`(self-build 자각)를 항상 주입하므로, 같은 골이 데몬에선
 *  `RunDevHarness` 를 부르고 프로브에선 0회로 갈렸다(실측 — 프로브가 **실제와 반대** 답).
 *  ⚠️ `cli` 는 데몬 서피스가 아니므로 무접촉(종전 동작 유지).
 *  seam 으로 뺀 이유: 이건 판정 프로브의 **정확성 계약**이라 인라인 조건으로 두면 조용히
 *  갈릴 수 있다. 순수 함수라 회귀로 잠글 수 있다(리뷰 must-fix). */
export function reproSurfaceParityMessages(
  tools: EvalPromptToolSurface | undefined,
  selfAccessPrompt: () => string,
): LLMMessage[] {
  return (tools === 'chat' || tools === 'webterm')
    ? [{ role: 'system', content: selfAccessPrompt() }]
    : [];
}

/** ⭐ repro 파리티 축 ②: **모델**(2026-07-27) — 종전엔 `opts.model ?? 'gpt-5.5'` **하드코딩**이
 *  기본이라 프로브가 데몬과 다른 모델로 판정했다. B1(자연어→툴선택)은 모델에 따라 답이 갈리는
 *  축이라 이건 파리티 위반이고 실제로 반대 결론을 냈다.
 *  우선순위: **명시 모델 → provider 기본 모델 → 최후 폴백**. 하드코딩은 provider 가 기본
 *  모델을 못 줄 때만 쓰는 마지막 그물이다. */
export function resolveReproModelId(
  explicit: string | undefined,
  providerDefault: string | undefined,
  lastResort = 'gpt-5.5',
): string {
  return explicit ?? providerDefault ?? lastResort;
}

export interface EvalPromptOpts {
  /** User prompt text. Required. */
  prompt: string;
  /** Model id (e.g. 'gpt-5.4', 'claude-opus-4-6'). Default: gpt-5.4. */
  model?: string;
  /** Tool-loop turn budget. Default: codex 8 / others 6 (see llm.ts). */
  maxTurns?: number;
  /** Working directory used for the universal preamble (anchor + tree).
   *  Default: process.cwd(). */
  cwd?: string;
  /** When true, suppress per-tool-call mirroring in stdout — only the
   *  final assistant text is emitted. Useful for piping into JSON
   *  consumers or test harnesses. Default false. */
  silent?: boolean;
  /** When true, write a single-line JSON summary at the end (turns,
   *  tool counts, finalChars, modelFamily, log path). Default false. */
  json?: boolean;
  /** Tool catalog to evaluate. Defaults to the legacy CLI-agent surface. */
  tools?: EvalPromptToolSurface;
  /** ⭐ 테스트 seam — deny 목록 주입(생략 시 `cfg.chat.toolDeny`).
   *  이게 없으면 deny 경계 테스트가 로컬 user-config 에 의존해 결과가 흔들린다. */
  toolDeny?: readonly string[];
  /** ⭐ 테스트 seam — provider 주입(생략 시 rotation/user-config 로 해석).
   *  이게 없으면 배선 회귀(tier-flip 결과 전달·daemon dispatcher 선택)를 실 LLM 없이
   *  검증할 방법이 없다(리뷰 must-fix). 프로덕션 경로는 생략하므로 동작 불변. */
  provider?: LLMProvider;

  // ── Assertion DSL (promptfoo pattern, 2026-05-03) ────────────────────
  // Each assertion holds the run to a check that lives in the run-level
  // contract — final text must contain X, tool Foo must fire ≥N times,
  // guard stub Bar must NOT fire, etc. Failing assertions exit 1.
  /** Final assistant text must include each of these substrings. */
  assertTextContains?: string[];
  /** Map<toolName, minCount> — tool must fire AT LEAST this many times. */
  assertToolMin?: Record<string, number>;
  /** Map<toolName, maxCount> — tool must fire AT MOST this many times. */
  assertToolMax?: Record<string, number>;
  /** Guard event names (e.g. `tool-loop.anchor-grep-blocked`) that MUST
   *  NOT appear in log/latest during the run. */
  assertNoEvent?: string[];
  /** Guard event names that MUST appear at least once. */
  assertEvent?: string[];

  // ── Trace export (inspect_ai JSONL pattern) ──────────────────────────
  /** When set, the per-event JSONL trace from log/latest is copied here
   *  after the run so callers can pin a specific run's trace. */
  jsonlOut?: string;
  /** When set, compares this run's eventCounts + toolBreakdown against
   *  the baseline JSONL trace at the given path. Diff is printed (and
   *  included in the JSON summary as `baselineDelta`). The diff is
   *  informational only — exit code is NOT affected. */
  baseline?: string;
  /** When set, look up the matching rotation entry in the user config
   *  (by label / provider / model substring) and use its provider +
   *  apiKey + model for this run. Overrides --model. Lets multi-
   *  provider users (e.g. opus / xai / codex / gemini rotation) ask
   *  the SAME prompt across all providers without hand-editing
   *  config.json. */
  rotate?: string;
}

export interface AssertionFailure {
  rule: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface EvalPromptResult {
  text: string;
  modelFamily: string;
  modelId: string;
  turnCount: number;
  toolCallCount: number;
  toolBreakdown: Record<string, number>;
  /** The selected repro surface whose catalog was measured. */
  toolSurface: EvalPromptToolSurface;
  /** Complete post-deny catalog actually provided for `toolSurface`, in dispatcher order. */
  surfaceToolNames: string[];
  /** Number of tools in `surfaceToolNames`, included to make JSON audits quick. */
  surfaceToolCount: number;
  durationMs: number;
  logPath: string | null;
  /** Per-guard event count parsed from log/latest after the run.
   *  Includes anchor-grep-blocked, broad-spot-blocked, dedup-blocked,
   *  grace-burned, immediate-stop, exploration-fallback, etc. — useful
   *  for assertions and report generation. */
  eventCounts: Record<string, number>;
  /** Assertion results — empty array means all passed (or no
   *  assertions configured). */
  assertions: AssertionFailure[];
  /** When `jsonlOut` was set, the absolute path of the copied trace. */
  jsonlOutPath?: string;
  /** When `baseline` was set, the diff vs the baseline trace. Maps
   *  event/tool name → `{ baseline: N, current: M, delta: M-N }`.
   *  Includes only entries where N != M to keep the table compact. */
  baselineDelta?: Record<string, { baseline: number; current: number; delta: number }>;
}

export function isEvalPromptToolSurface(value: string): value is EvalPromptToolSurface {
  return (EVAL_PROMPT_TOOL_SURFACES as readonly string[]).includes(value);
}

// Wave 7 — codex-shaped tool subset for codex family. Excludes Read/
// Grep/Glob/Edit/Write since codex-rs (gpt-5.5 training base) has no
// native handlers for those — model is trained to use shell `cat`/`rg`/
// `fd` for text/search and apply_patch for edits. See buildCodexHostTools
// comment for the empirical reproducer.
// Wave 7 — env override `ELANOUS_CODEX_TOOLSET` for hypothesis testing:
//   "shell-shaped" → `shell` (codex-rs schema, command:array) + ListDir
//                    + WebFetch — tests if schema match unlocks codex
//                    use of shell for cat/rg/find
//   "hybrid"      → `shell` + `Read` + ListDir + WebFetch (W7-B) —
//                   tests if pairing codex-rs shell with our JSON Read
//                   pivots codex from shell-list (no cat) to Read for
//                   file content. Reproducer: log/wave7-shell/.
//   "minimal" → Bash + ListDir + WebFetch (3 tools, generic Bash)
//   "shaped"  → Bash + ListDir + Lsp + AstGrep + WebFetch + WebSearch
//               (mid-ground default for codex family)
//   else      → full Claude-Code 11-tool set (default for non-codex)
export function buildEvalPromptToolSurface(
  kind: EvalPromptToolSurface,
  modelFamily: string,
  cfg: UserConfig,
): { specs: LLMToolSpec[]; daemon?: DaemonToolSurface } {
  if (kind !== 'cli') {
    const daemon = toolSurface(kind, cfg);
    return { specs: daemon.specs, daemon };
  }

  const codexToolset = process.env.ELANOUS_CODEX_TOOLSET ?? 'shaped';
  const baseTools = modelFamily === 'codex'
    ? (codexToolset === 'shell-shaped'
        ? buildCodexShellShapedTools()
        : codexToolset === 'hybrid'
          ? buildCodexHybridTools()
          : codexToolset === 'minimal'
            ? buildCodexMinimalTools()
            : buildCodexHostTools())
    : buildHostTools();
  return {
    specs: process.env.ELANOUS_EVAL_INCLUDE_TUI_TOOLS === 'true'
      ? [...baseTools, ...buildTuiMirrorOptionalTools()]
      : baseTools,
  };
}

function buildHostTools(): LLMToolSpec[] {
  return [
    buildBashTool(),
    buildReadTool(),
    buildEditTool(),
    buildWriteTool(),
    buildGrepTool(),
    buildGlobTool(),
    buildListDirTool(),
    buildAstGrepTool(),
    buildLspTool(),
    buildWebFetchTool(),
    buildWebSearchTool(),
  ];
}

/** TUI tool exposure mirror (2026-05-03 PM++) — adds the dashboard-only
 *  optional tool SPECS that the TUI plain-chat path always exposes via
 *  `buildDashboardOptionalToolSpecs` (DashboardState + 5 TerminalModal
 *  tools) on top of the standard host tools. dispatch is stubbed —
 *  these tools require a live dashboard runtime; in headless `elanous
 *  repro` mode they return an error so the model sees the spec but
 *  any actual call fails cleanly.
 *
 *  Triggered by `ELANOUS_EVAL_INCLUDE_TUI_TOOLS=true`. Purpose: measure
 *  whether the extra spec exposure changes codex behavior (W5-G
 *  no-content-read streak counts these calls toward the streak even
 *  though they're not Read/Edit/Write/Lsp).
 *
 *  Reproducer: log/wave7bc/ baseline (host-only) vs new measurement
 *  with this opt-in → diff PASS rate / latency / answer length. */
function buildTuiMirrorOptionalTools(): LLMToolSpec[] {
  return [
    buildGetDashboardStateTool(),
    buildTerminalModalListTool(),
    buildTerminalModalObserveTool(),
    buildTerminalModalFocusTool(),
    buildTerminalModalDetachTool(),
    buildTerminalModalKillTool(),
  ];
}

/** Set of tool names whose dispatch is stubbed in headless mode. The
 *  spec is exposed to the model (so behavior measurement is fair),
 *  but actual invocation returns a clean error — these tools require
 *  a live dashboard runtime that the headless path doesn't have. */
const TUI_MIRROR_TOOL_NAMES = new Set([
  'GetDashboardState',
  'TerminalModalList',
  'TerminalModalObserve',
  'TerminalModalFocus',
  'TerminalModalDetach',
  'TerminalModalKill',
]);

/** Wave 7 hypothesis (2026-05-03 PM) — codex-shaped minimal tool set.
 *  codex-rs (`~/source/ref/codex/codex-rs/core/src/tools/spec.rs`
 *  lines 79-110) registers ONLY: Shell, ApplyPatch, Plan, ListDir, ViewImage,
 *  Goal, MCP, multi-agents. NO native Read/Grep/Glob handlers — codex-trained
 *  models (gpt-5.5) are taught to use shell `cat`/`rg`/`fd` for those.
 *
 *  When monad-agent exposes Read/Grep/Glob/Edit/Write to codex (Claude-Code
 *  convention), the model:
 *    - prefers Grep/Glob (semantically "search")
 *    - never Reads (out-of-distribution vs `cat` via shell)
 *    - never uses Bash (specialized tools more attractive)
 *    - results in 0 Read across analysis prompts (vs opus 4-11 Reads)
 *
 *  This subset gives codex its native shape: Bash for everything text/search,
 *  ListDir for tree, code-intel + web. Edit/Write/Read removed so codex must
 *  use Bash (matching its training). Reproducer: log/wave6-final/run.json
 *  shows codex 0 Read, opus 10 Read on identical analysis prompt. */
function buildCodexHostTools(): LLMToolSpec[] {
  return [
    buildBashTool(),
    buildListDirTool(),
    buildLspTool(),
    buildAstGrepTool(),
    buildWebFetchTool(),
    buildWebSearchTool(),
  ];
}

/** Wave 7 — Hyper-minimal codex set: Bash + ListDir ONLY. Tests the
 *  hypothesis that codex prefers ANY specialized tool (AstGrep, Lsp)
 *  over generic Bash. If codex actually uses Bash with `cat`/`rg` here,
 *  the original Wave 7 hypothesis holds. If it still avoids Bash and
 *  spins on ListDir alone, codex literally cannot operate without a
 *  search-shaped tool — which means our Read/Grep/Glob tools are
 *  necessary infrastructure, not a confound. */
function buildCodexMinimalTools(): LLMToolSpec[] {
  return [
    buildBashTool(),
    buildListDirTool(),
    buildWebFetchTool(),
  ];
}

/** Wave 7-B — Codex-rs `shell` tool with the EXACT schema codex models
 *  are trained on (`~/source/ref/codex/codex-rs/tools/src/
 *  local_tool.rs:136-196`). Critical: parameter `command` is array<string>
 *  (e.g. `["bash", "-lc", "cat src/foo.ts"]`) NOT a single string.
 *
 *  The dispatch glue joins the array back to a single shell command
 *  string and forwards to dispatchBash with the existing safety guards
 *  (timeout, sandbox, network). This is a pure schema adapter — same
 *  underlying execution.
 *
 *  Tested when ELANOUS_CODEX_TOOLSET=shell-shaped. Hypothesis: with
 *  matching schema, codex uses `shell` for `cat`/`rg`/`find` instead of
 *  ignoring our generic Bash tool. */
function buildCodexShellTool(): LLMToolSpec {
  return {
    name: 'shell',
    description:
      'Runs a shell command and returns its output.\n' +
      '- The arguments to `shell` will be passed to execvp(). ' +
      'Most terminal commands should be prefixed with ["bash", "-lc"].\n' +
      '- Always set the `workdir` param when using the shell function. ' +
      'Do not use `cd` unless absolutely necessary.\n' +
      '- Examples:\n' +
      '  - List files: ["ls", "-la"]\n' +
      '  - Read a file: ["bash", "-lc", "cat src/foo.ts"]\n' +
      '  - Recursive grep: ["bash", "-lc", "rg \\"pattern\\" src/"]\n' +
      '  - Find by name: ["bash", "-lc", "rg --files | rg foo.ts"]',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'The command to execute (argv array, e.g. ["bash", "-lc", "cat foo.ts"]).',
        },
        workdir: {
          type: 'string',
          description: 'The working directory to execute the command in. Defaults to the turn cwd.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout for the command in milliseconds. Defaults to 60000.',
        },
      },
      required: ['command'],
    },
  };
}

function buildCodexShellShapedTools(): LLMToolSpec[] {
  return [
    buildCodexShellTool(),
    buildListDirTool(),
    buildWebFetchTool(),
  ];
}

/** Wave 7-B (W7-B) — Hybrid tool set: codex-rs `shell` (array schema)
 *  PLUS our JSON `Read`. Hypothesis: shell-shaped alone produced 11
 *  shell calls but 0 `cat` (codex listed file paths via `rg --files` /
 *  `find` and never read content). Exposing `Read` alongside `shell`
 *  may reactivate the `read_file` distribution codex was trained on,
 *  letting it pivot from shell-list to Read-content for synthesis.
 *
 *  Reproducer: log/wave7-shell/ — shell × 11, Read × 0, [NO FINAL
 *  SYNTHESIS]. Expected hybrid outcome: shell × 5-10 (search) + Read
 *  × 3-5 (content) → substantive answer 1500-3000 chars. */
function buildCodexHybridTools(): LLMToolSpec[] {
  return [
    buildCodexShellTool(),
    buildReadTool(),
    buildListDirTool(),
    buildWebFetchTool(),
  ];
}

/** Native-tool dispatcher — same shape as the skill runner's uniform
 *  table but trimmed to the headless-safe set. Bash gets its own
 *  context shape (cwd / signal). All others go through the uniform
 *  `{ output: string }` contract. */
async function dispatchHostTool(
  name: string,
  args: Record<string, unknown>,
  sessionCache: SessionCache,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<unknown> {
  if (name === 'Bash') {
    const bashOpts: Parameters<typeof dispatchBash>[1] = {
      cwd,
      shell: requirePosixShell(),
      defaultTimeoutMs: 60_000,
    };
    if (signal !== undefined) bashOpts.signal = signal;
    return dispatchBash(args, bashOpts);
  }
  if (name === 'shell') {
    // Wave 7-B — codex `shell` tool adapter. Convert array<string>
    // command to a single string for dispatchBash; if the array is
    // ["bash", "-lc", "cat foo.ts"] we strip the "bash -lc" prefix
    // (dispatchBash already wraps via bash -c). Other forms get
    // joined with spaces and run as-is — argv quoting is the model's
    // responsibility per codex-rs conventions.
    const cmdArr = Array.isArray(args.command) ? args.command : [];
    let commandStr: string;
    if (cmdArr.length >= 3 && cmdArr[0] === 'bash' && (cmdArr[1] === '-lc' || cmdArr[1] === '-c')) {
      commandStr = String(cmdArr[2] ?? '');
    } else {
      commandStr = cmdArr.map(s => String(s)).join(' ');
    }
    const bashOpts: Parameters<typeof dispatchBash>[1] = {
      cwd: typeof args.workdir === 'string' ? args.workdir : cwd,
      shell: requirePosixShell(),
      defaultTimeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : 60_000,
    };
    if (signal !== undefined) bashOpts.signal = signal;
    return dispatchBash({ command: commandStr }, bashOpts);
  }
  switch (name) {
    case 'Read':      return dispatchRead(args, { sessionCache });
    case 'Edit':      return dispatchEdit(args);
    case 'Write':     return dispatchWrite(args);
    case 'Grep':      return dispatchGrep(args);
    case 'Glob':      return dispatchGlob(args);
    case 'ListDir':   return dispatchListDir(args);
    case 'AstGrep':   return dispatchAstGrep(args);
    case 'Lsp':       return (await dispatchLsp(args)).output;
    case 'WebFetch':  return dispatchWebFetch(args, { signal });
    case 'WebSearch': return dispatchWebSearch(args, { signal });
    default:
      // TUI tool exposure mirror — DashboardState + TerminalModal
      // family. Spec is exposed (so codex sees identical tool list to
      // TUI), but dispatch returns a clean error (these tools require
      // a live dashboard runtime). Codex behavior measurement is fair:
      // model-side spec list matches TUI; tool-call outcome differs
      // only when codex actually invokes one — typical analysis
      // prompts don't trigger these. If codex does call one, the
      // error result mimics the same structural outcome as the live
      // TUI returning a runtime error.
      if (TUI_MIRROR_TOOL_NAMES.has(name)) {
        return {
          available: false,
          reason: `tool ${name} requires a live dashboard runtime — not available in 'elanous repro' headless mode`,
        };
      }
      return { error: `tool ${name} not available in 'elanous ask' headless mode` };
  }
}

/** Parse a JSONL trace file (output of --jsonl-out from a prior run) and
 *  return the per-event count. Returns {} when the file is missing or
 *  unreadable. Used by --baseline to compare against a saved trace. */
function readEventCountsFromJsonl(path: string): Record<string, number> {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const obj = JSON.parse(line);
      const ev = typeof obj?.event === 'string' ? obj.event : null;
      if (ev !== null) counts[ev] = (counts[ev] ?? 0) + 1;
    } catch {
      // skip malformed lines
    }
  }
  return counts;
}

/** Compute the delta map (baseline → current) over event counts.
 *  Includes only entries where baseline != current to keep the diff
 *  compact. Used by the --baseline flag. */
export function computeBaselineDelta(
  baseline: Record<string, number>,
  current: Record<string, number>,
): Record<string, { baseline: number; current: number; delta: number }> {
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const out: Record<string, { baseline: number; current: number; delta: number }> = {};
  for (const k of allKeys) {
    const b = baseline[k] ?? 0;
    const c = current[k] ?? 0;
    if (b !== c) out[k] = { baseline: b, current: c, delta: c - b };
  }
  return out;
}

/** Read every JSON line from `log/latest` and return the per-event
 *  count keyed by event name. Returns {} when the symlink doesn't
 *  resolve or the file is unreadable — the run already produced a
 *  text answer; missing trace is informational, not fatal. */
function readEventCountsFromLogLatest(): { counts: Record<string, number>; path: string | null } {
  const linkPath = resolvePath(process.cwd(), 'log/latest');
  if (!existsSync(linkPath)) return { counts: {}, path: null };
  let real: string;
  try {
    real = realpathSync(linkPath);
  } catch {
    return { counts: {}, path: null };
  }
  let raw: string;
  try {
    raw = readFileSync(real, 'utf8');
  } catch {
    return { counts: {}, path: real };
  }
  const counts: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const obj = JSON.parse(line);
      const ev = typeof obj?.event === 'string' ? obj.event : null;
      if (ev !== null) counts[ev] = (counts[ev] ?? 0) + 1;
    } catch {
      // skip malformed lines (debug log is mostly clean but be lenient)
    }
  }
  return { counts, path: real };
}

/** Run all assertions configured on `opts` against the resolved run
 *  state. Returns the list of failures (empty = all passed). */
export function rejectAssertionsOutsideToolSurface(
  assertToolMin: Record<string, number> | undefined,
  assertToolMax: Record<string, number> | undefined,
  toolSurface: EvalPromptToolSurface,
  surfaceToolNames: readonly string[],
): void {
  const available = new Set(surfaceToolNames);
  const asserted = new Set([
    ...Object.keys(assertToolMin ?? {}),
    ...Object.keys(assertToolMax ?? {}),
  ]);
  const missing = [...asserted].filter((tool) => !available.has(tool));
  if (missing.length > 0) {
    throw new Error(
      `tool assertion references unavailable tool(s) for surface ${JSON.stringify(toolSurface)}: ` +
      `${missing.map((tool) => JSON.stringify(tool)).join(', ')}; ` +
      `surface has ${surfaceToolNames.length} tool(s): ${surfaceToolNames.join(', ')}`,
    );
  }
}

export function evaluateAssertions(
  opts: EvalPromptOpts,
  finalText: string,
  toolBreakdown: Record<string, number>,
  eventCounts: Record<string, number>,
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  for (const needle of opts.assertTextContains ?? []) {
    if (!finalText.includes(needle)) {
      failures.push({
        rule: 'assertTextContains',
        expected: needle,
        actual: finalText.length > 200 ? `${finalText.slice(0, 200)}…` : finalText,
        message: `final text did not contain ${JSON.stringify(needle)}`,
      });
    }
  }
  for (const [tool, min] of Object.entries(opts.assertToolMin ?? {})) {
    const actual = toolBreakdown[tool] ?? 0;
    if (actual < min) {
      failures.push({
        rule: 'assertToolMin',
        expected: `${tool}>=${min}`,
        actual,
        message: `tool ${tool} fired ${actual}× but expected at least ${min}`,
      });
    }
  }
  for (const [tool, max] of Object.entries(opts.assertToolMax ?? {})) {
    const actual = toolBreakdown[tool] ?? 0;
    if (actual > max) {
      failures.push({
        rule: 'assertToolMax',
        expected: `${tool}<=${max}`,
        actual,
        message: `tool ${tool} fired ${actual}× but expected at most ${max}`,
      });
    }
  }
  for (const ev of opts.assertNoEvent ?? []) {
    const actual = eventCounts[ev] ?? 0;
    if (actual > 0) {
      failures.push({
        rule: 'assertNoEvent',
        expected: `${ev}=0`,
        actual,
        message: `forensic event ${ev} fired ${actual}× but expected zero`,
      });
    }
  }
  for (const ev of opts.assertEvent ?? []) {
    const actual = eventCounts[ev] ?? 0;
    if (actual === 0) {
      failures.push({
        rule: 'assertEvent',
        expected: `${ev}>=1`,
        actual: 0,
        message: `forensic event ${ev} expected at least once but did not fire`,
      });
    }
  }
  return failures;
}

function previewArgs(args: Record<string, unknown>, max = 200): string {
  try {
    const s = JSON.stringify(args);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return '<unserializable>';
  }
}

function previewResult(result: unknown, max = 200): string {
  try {
    const s = typeof result === 'string' ? result : JSON.stringify(result);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return '<unserializable>';
  }
}

/**
 * Run a single prompt through the headless LLM loop. Streams text +
 * tool-call telemetry to stdout (unless `silent`), then resolves with
 * a structured summary. The function is async so callers in scripts /
 * tests can await it.
 */
export async function runEvalPrompt(opts: EvalPromptOpts): Promise<EvalPromptResult> {
  const startedAt = Date.now();
  const cwd = opts.cwd ?? process.cwd();
  // Provider + model resolution. Three modes:
  //   1. --rotate <needle> — look up rotation entry by label/provider/
  //      model substring, build provider with that entry's apiKey +
  //      model. Overrides --model.
  //   2. --model <id> — use the existing user-config provider but ask
  //      for a specific model id (works when the model belongs to the
  //      same provider family).
  //   3. neither — use user-config defaults (cfg.llm.provider + .model).
  let modelId: string;
  let provider: LLMProvider;
  let activatedRotationLabel: string | undefined;
  if (opts.rotate !== undefined && opts.rotate.length > 0) {
    const baseCfg = getUserConfig();
    const { cfg: cfgWithEntry, entry } = jumpToRotationEntry(baseCfg, opts.rotate);
    if (entry === null) {
      throw new Error(
        `--rotate "${opts.rotate}": no matching rotation entry. Configure llm.rotation in ` +
        `user config and try again with the entry's label / provider / model substring.`,
      );
    }
    activatedRotationLabel = entry.label ?? `${entry.provider}/${entry.model ?? 'default'}`;
    // Apply the entry to a temporary cfg copy and let getProviderForConfig
    // build the right provider with the entry's apiKey baked in. This does
    // NOT mutate the persisted on-disk config.
    const cfgForCall = applyRotationEntry(cfgWithEntry, entry);
    provider = getProviderForConfig(cfgForCall, opts.model ?? entry.model);
    modelId = opts.model ?? entry.model ?? provider.defaultModel;
  } else if (opts.provider !== undefined) {
    provider = opts.provider;                 // 테스트 seam(주입) — 해석 생략.
    modelId = opts.model ?? provider.defaultModel;
  } else {
    // ⭐ config 라우팅 우선(2026-07-27) — 종전엔 `'gpt-5.5'` **하드코딩**이 기본이라
    //   프로브가 **데몬과 다른 모델**로 판정했다. B1(자연어→툴선택) 은 모델에 따라 답이
    //   갈리는 축이라, 이건 서피스 파리티 위반이고 실제로 반대 결론을 냈다(실측).
    //   ⊕ 윈도우도 함께 풀린다 — config codex 계열은 1M 인데 하드코딩 모델은 훨씬 작아
    //     10턴 누적 툴결과 + 웜-preload 스키마에서 컨텍스트 초과로 죽었다.
    //   ⚠️ 하드코딩은 **최후 폴백**으로만 남긴다(provider 가 기본 모델을 못 주는 경우).
    provider = resolveDefaultProvider(opts.model);
    modelId = resolveReproModelId(opts.model, provider.defaultModel);
  }
  const modelFamily = getModelFamily(modelId);

  // Auto-enable diag debug mode for the duration of the run. The
  // 122-site hot-path `if (debug.enabled) debug.log(...)` gate is OFF
  // by default to keep dashboard chat lean; in self-validation mode
  // we explicitly want every guard event (anchor-grep-blocked,
  // broad-spot-blocked, dedup-blocked, grace-burned, immediate-stop,
  // edit-applied, etc.) recorded so log/latest is a complete
  // forensic transcript. Silent / json modes still get the file
  // sink — only stdout-mirror stays off.
  const wasDiag = debug.isDiagEnabled();
  if (!wasDiag) debug.setDiagEnabled(true);
  if (!opts.silent) {
    if (activatedRotationLabel !== undefined) {
      process.stdout.write(`[ask] rotation activated → label=${activatedRotationLabel}\n`);
    }
    process.stdout.write(`[ask] model=${modelId} family=${modelFamily} provider=${provider.name} cwd=${cwd}\n`);
    process.stdout.write(`[ask] diag mode auto-enabled — full guard telemetry in log/latest\n`);
  }

  // Build the same system-prompt prefix the dashboard / skill / agent
  // surfaces use. Universal preamble = project anchor + project-tree
  // (W4-B) + family-agnostic lifecycle (P4) + codex addendum (L-1) when
  // applicable. Without this the eval would see codex behave very
  // differently than in dashboard chat.
  const sessionCache = new SessionCache();
  // 툴셋 선택 — cli 는 종전 조립(모델별 변형 포함) · chat/webterm 은 데몬 서피스.
  //   상세(codex 변형·ELANOUS_CODEX_TOOLSET 가설)는 buildEvalPromptToolSurface 주석 참조.
  const selectedSurface = opts.tools ?? 'cli';
  // 데몬 서피스용 never-abort 신호(헤드리스에선 프로세스 kill 이 곧 중단이라 발화 없음).
  const headlessSignal = new AbortController().signal;
  const cfg = getUserConfig();
  const { specs: assembledTools, daemon: daemonSurface } = buildEvalPromptToolSurface(
    selectedSurface,
    modelFamily,
    cfg,
  );
  // Wave 8 (2026-05-04) — apply user-config tool deny list. Empty
  // list = no-op. ref/claude-code-fork `filterToolsByDenyRules`
  // (`src/tools.ts:262-269`) pattern.
  const denyList = opts.toolDeny ?? cfg.chat.toolDeny;
  const { filterToolsByDeny } = await import('./tool-runtime/tool-deny.js');
  const tools = filterToolsByDeny(assembledTools, denyList) ?? assembledTools;
  // The assertion catalog and JSON audit fields must describe the exact
  // post-deny tool array supplied to the provider, not the candidate pool.
  const surfaceToolNames = tools.map((tool) => tool.name);
  rejectAssertionsOutsideToolSurface(
    opts.assertToolMin,
    opts.assertToolMax,
    selectedSurface,
    surfaceToolNames,
  );
  // 필터로 떨어져 나간 이름 — dispatch 경계 차단에 쓴다(위 dispatchTool 참조).
  const allowedNames = new Set(tools.map((t) => t.name));
  const deniedNames = new Set(
    assembledTools.map((t) => t.name).filter((n) => !allowedNames.has(n)),
  );
  if (!opts.silent) {
    process.stdout.write(`[ask] tools: ${tools.length} (${tools.map(t => t.name).join(', ')})\n`);
    if (tools.length < assembledTools.length) {
      process.stdout.write(`[ask] tool-deny: ${assembledTools.length - tools.length} filtered\n`);
    }
  }

  // Wave 3 (2026-05-04) — preamble built AFTER tools so the session-
  // guidance addendum can see the active toolset and emit per-tool
  // one-liners (e.g. AskUserQuestion → use for tool-deny clarification).
  const preamble = buildUniversalPreamble({
    cwd,
    modelFamily,
    enabledTools: tools.map(t => t.name),
  });
  if (!opts.silent) {
    process.stdout.write(`[ask] preamble: ${preamble.length} system messages\n`);
  }

  // ⭐ 데몬 서피스 프롬프트 파리티(2026-07-27) — `--tools chat|webterm` 은 **데몬이 쓰는
  //   서피스**를 재현하겠다는 뜻인데, 종전엔 **툴 목록만** 맞추고 시스템 프롬프트는 안 맞췄다.
  //   데몬은 `elanousSelfAccessPrompt`(self-build 자각 · 배틀쉽 소환 안내)를 항상 주입하는데
  //   repro 는 universal preamble 만 써서, **같은 골이 데몬에선 RunDevHarness 를 부르고
  //   프로브에선 0회**로 갈렸다(실측). 판정 프로브가 실제와 반대 답을 내면 B1 사다리 자체가
  //   못 쓰게 되므로(매뉴얼 §4 "1~3 건너뛰면 왜 안 되는지 안 나온다") 여기서 축을 맞춘다.
  //   ⚠️ `cli` 서피스는 데몬이 아니므로 무접촉 — 종전 동작 그대로.
  const surfaceParity: LLMMessage[] = reproSurfaceParityMessages(opts.tools, elanousSelfAccessPrompt);
  if (!opts.silent && surfaceParity.length > 0) {
    process.stdout.write(`[ask] surface parity: +elanousSelfAccessPrompt (tools=${opts.tools})\n`);
  }
  const messages: LLMMessage[] = [
    ...preamble,
    ...surfaceParity,
    { role: 'user', content: opts.prompt },
  ];

  const toolBreakdown: Record<string, number> = {};
  let turnCount = 0;
  let toolCallCount = 0;
  let finalText = '';

  // Forensic log: mirror the headless invocation as a chat-surface
  // event so log/latest shows the entry point alongside the dashboard
  // history. Same category as the dashboard's chat-surface mirror.
  if (debug.enabled) {
    debug.log('chat.user-message', 'submitted (ask CLI)', {
      preview: opts.prompt.length > 500 ? `${opts.prompt.slice(0, 500)}…` : opts.prompt,
      modelId,
      modelFamily,
      cwd,
    });
  }

  // ⭐ tier-flip 적용 (라이브 패리티 · 2026-07-26 손딜리버).
  //   repro 는 `streamLLMWithTools` 를 직접 부르는데, deferral/소환기 주입은
  //   `run-core-turn.ts` 의 `applyDeferredTools` 에 있다 → 그대로 두면 서피스만 바꿔도
  //   **모든 툴이 raw 로** 나가 "deferred + ToolSearch 소환"이라는 webterm 표면의 판단을
  //   재현하지 못한다(실측: 모델이 "ToolSearch 도구는 제공되지 않았다"고 답함).
  //   ⚠️ cli 서피스는 deferred 가 0 이라 이 호출이 **no-op**이다(무회귀·실측 확인).
  const { applyDeferredTools } = await import('./session-runtime/tier-flip.js');
  const deferredSplit = applyDeferredTools(messages, tools, { userText: opts.prompt });
  if (!opts.silent && deferredSplit.stats.deferredCount > 0) {
    process.stdout.write(
      `[ask] tier-flip: active=${deferredSplit.stats.activeCount} deferred=${deferredSplit.stats.deferredCount}`
      + `${deferredSplit.stats.toolSearchInjected ? ' (+ToolSearch)' : ''}\n`,
    );
  }

  const result = await streamLLMWithTools(
    deferredSplit.messages,
    {
      onText: (delta: string) => {
        finalText += delta;
        if (!opts.silent && !opts.json) {
          process.stdout.write(delta);
        }
      },
      onToolCall: (call) => {
        toolCallCount++;
        toolBreakdown[call.name] = (toolBreakdown[call.name] ?? 0) + 1;
        if (!opts.silent) {
          process.stdout.write(`\n[tool] ${call.name}(${previewArgs(call.args)})\n`);
        }
      },
      onToolResult: (r) => {
        if (!opts.silent) {
          process.stdout.write(`[tool-result] ${r.name} → ${previewResult(r.result)}\n`);
        }
      },
      // Wave A1 (2026-05-04) — funnel CLI usage events into the
      // session-cumulative metrics module so prompt-cache hit rate
      // is observable from CLI runs (scenarios, repro, eval). Best-
      // effort import — failure doesn't block the turn.
      onUsage: (usage) => {
        import('./prompt-cache/metrics.js')
          .then(({ recordUsage }) => recordUsage(usage))
          .catch(() => { /* metrics best-effort */ });
      },
      dispatchTool: async (name, args) => {
        // ⚠️ deny-list 는 **서피스와 무관하게** dispatch 경계에서 막는다(리뷰 must-fix).
        //   spec 필터만으론 부족하다 — 프로바이더가 스펙에 없는 이름을 그냥 부를 수 있고,
        //   데몬 서피스의 ToolSearch 는 **필터 전 원본 풀**에서 스키마를 하이드레이트하므로
        //   거부된 툴이 소환→호출로 되살아난다. 두 경로 모두 여기서 차단.
        if (deniedNames.has(name)) {
          return { error: `tool '${name}' is denied by chat.toolDeny` };
        }
        // 데몬 서피스 dispatch 는 ctx.signal 이 **필수 필드**라 한 번 만들어 재사용한다
        // (툴콜마다 새 AbortController 를 만들 이유가 없다).
        if (daemonSurface !== undefined) {
          return daemonSurface.dispatch(name, args, { cwd, signal: headlessSignal });
        }
        // No abort signal threading in headless mode — the user's
        // `kill` of the CLI process tears down the whole event loop,
        // so per-tool abort isn't needed. Pass undefined.
        // ⚠️ cli 경로는 **종전 그대로**(무회귀 요구) — signal 을 끼워 넣지 않는다.
        return dispatchHostTool(name, args, sessionCache, undefined, cwd);
      },
    },
    {
      provider,
      model: modelId,
      // tier-flip 이 고른 active 목록(+주입된 소환기). cli 는 원본과 동일(no-op).
      tools: deferredSplit.tools,
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    },
  );

  // streamLLMWithTools returns the LLM's final text concatenated; if
  // the streamed onText already covered it the strings match. Keep
  // the streamed accumulation as the canonical answer (catches edge
  // cases where streamLLMWithTools post-processes).
  if (typeof result === 'string' && result.length > 0) finalText = result;

  // Approximate turn count from the breakdown — streamLLMWithTools
  // doesn't return it directly; the cleanest substitute is the number
  // of distinct `tool-loop.turn.start` events the run emitted. Without
  // hooking into the debug log here, we approximate as
  // `Math.ceil(toolCallCount / avg_tools_per_turn)` ≈ ceil(N/2). Live
  // log/latest still shows the precise count.
  turnCount = toolCallCount === 0 ? 1 : Math.ceil(toolCallCount / 2);

  const durationMs = Date.now() - startedAt;

  // Restore diag flag BEFORE reading log/latest — the file sink
  // flushes on debug-mode toggle. Explicit `debug.flush()` afterwards
  // because the W5-E force-synthesis path (and any other tail-end
  // events) can land within the 100ms async-flush window and be lost
  // if the CLI exits before the next flush tick. Synchronous flush
  // guarantees the trace is on disk by the time we read it.
  if (!wasDiag) debug.setDiagEnabled(false);
  debug.flush();

  // Parse forensic event counts from log/latest. Used by assertions
  // (assertEvent / assertNoEvent) AND included in the summary so
  // callers can audit guard activity without a second file read.
  const { counts: eventCounts, path: logPath } = readEventCountsFromLogLatest();

  // Optional JSONL trace export — copy log/latest's resolved file to
  // the user-supplied path. inspect_ai pattern: each run gets its own
  // immutable trace file so you can pin a specific run alongside the
  // commit hash that produced it.
  let jsonlOutPath: string | undefined;
  if (opts.jsonlOut !== undefined && opts.jsonlOut.length > 0 && logPath !== null) {
    const dst = resolvePath(opts.jsonlOut);
    try {
      copyFileSync(logPath, dst);
      jsonlOutPath = dst;
      if (!opts.silent) {
        process.stdout.write(`[ask] jsonl trace → ${dst}\n`);
      }
    } catch (err) {
      if (!opts.silent) {
        process.stdout.write(`[ask] jsonl trace export FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  // Run assertions — promptfoo pattern. Each failure shows up in
  // stdout (unless silent+json) AND in the returned summary.
  const assertions = evaluateAssertions(opts, finalText, toolBreakdown, eventCounts);
  if (assertions.length > 0 && !opts.silent) {
    process.stdout.write(`\n[ask] assertion failures:\n`);
    for (const f of assertions) {
      process.stdout.write(`  ✗ [${f.rule}] ${f.message}\n`);
    }
  }

  // P4 (2026-05-03 PM) — Baseline diff. When --baseline <path> was
  // given, parse it and compare event counts against the current run.
  // Informational only — exit code unaffected.
  let baselineDelta: EvalPromptResult['baselineDelta'];
  if (opts.baseline !== undefined && opts.baseline.length > 0) {
    const baselinePath = resolvePath(opts.baseline);
    const baselineCounts = readEventCountsFromJsonl(baselinePath);
    baselineDelta = computeBaselineDelta(baselineCounts, eventCounts);
    if (!opts.silent && Object.keys(baselineDelta).length > 0) {
      const sorted = Object.entries(baselineDelta).sort(([, a], [, b]) =>
        Math.abs(b.delta) - Math.abs(a.delta),
      );
      process.stdout.write(`[ask] baseline diff vs ${baselinePath}:\n`);
      for (const [name, d] of sorted.slice(0, 12)) {
        const sign = d.delta > 0 ? '+' : '';
        const arrow = d.delta > 0 ? '↑' : '↓';
        process.stdout.write(`  ${arrow} ${name}: ${d.baseline} → ${d.current} (${sign}${d.delta})\n`);
      }
      if (sorted.length > 12) {
        process.stdout.write(`  …and ${sorted.length - 12} more\n`);
      }
    }
  }

  const summary: EvalPromptResult = {
    text: finalText,
    modelId,
    modelFamily,
    turnCount,
    toolCallCount,
    toolBreakdown,
    toolSurface: selectedSurface,
    surfaceToolNames,
    surfaceToolCount: surfaceToolNames.length,
    durationMs,
    logPath: logPath ?? (process.env.ELANOUS_LOG_LATEST ?? 'log/latest'),
    eventCounts,
    assertions,
    ...(jsonlOutPath !== undefined ? { jsonlOutPath } : {}),
    ...(baselineDelta !== undefined ? { baselineDelta } : {}),
  };
  if (opts.json) {
    process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  } else if (!opts.silent) {
    process.stdout.write(`\n\n[ask] done — ${toolCallCount} tool calls in ${durationMs}ms\n`);
    if (toolCallCount > 0) {
      const breakdown = Object.entries(toolBreakdown).map(([n, c]) => `${n}:${c}`).join(', ');
      process.stdout.write(`[ask] tool breakdown: ${breakdown}\n`);
    }
    // Top guard events (anchor/broad-spot/dedup/grace/immediate-stop/
    // exploration-fallback). Inspired by promptfoo's per-test
    // assertion summary at the bottom of `eval` runs.
    const guardKeys = Object.keys(eventCounts).filter(k =>
      k.includes('blocked')
      || k.includes('grace-burned')
      || k.includes('immediate-stop')
      || k.includes('exploration-fallback')
      || k.includes('dedup-reset'));
    if (guardKeys.length > 0) {
      const guards = guardKeys.map(k => `${k}:${eventCounts[k]}`).join(', ');
      process.stdout.write(`[ask] guards: ${guards}\n`);
    }
    process.stdout.write(`[ask] log: ${logPath ?? 'log/latest'}\n`);
    if (assertions.length > 0) {
      process.stdout.write(`[ask] ${assertions.length} assertion(s) FAILED\n`);
    }
  }
  return summary;
}

/** Argv-driven entry. Wired by `program.command('repro')` in src/index.ts. */
export async function runAskCommand(opts: EvalPromptOpts): Promise<void> {
  try {
    const summary = await runEvalPrompt(opts);
    // Exit code policy (inspect_ai / promptfoo convention):
    //   0 — text produced AND all assertions passed
    //   1 — assertion failure OR loop exhausted with empty text
    //   2 — system error (caught below)
    if (summary.assertions.length > 0) {
      process.exit(1);
    }
    process.exit(summary.text.length > 0 ? 0 : 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ask] error: ${msg}\n`);
    process.exit(2);
  }
}
