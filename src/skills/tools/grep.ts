import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── Grep tool (Claude Code-compatible ripgrep wrapper) ──
//
// Ports claude-code-fork/src/tools/GrepTool. Shells out to the
// system `rg` binary. Not bundling our own copy — elanous's users are
// developers who overwhelmingly already have ripgrep installed via
// brew/apt/cargo. When `rg` is missing we fail fast with an install
// hint rather than silently falling back to POSIX grep (which
// doesn't support --glob, --type, --multiline, etc. and would
// require a much larger shim to match the documented contract).
//
// Key behaviours preserved from claude-code:
//   - Three output_mode values: `files_with_matches` (default),
//     `content`, `count`. The LLM selects based on the task —
//     "is this pattern anywhere?" vs "show me the matches" vs
//     "how often does it occur?".
//   - head_limit default 250. Prevents a broad search from
//     dumping thousands of matches into the LLM's context window.
//   - Supports -A / -B / -C (context lines), -n (line numbers),
//     -i (case insensitive), --multiline (cross-line patterns),
//     --glob (filename filter), --type (language filter).
//   - offset for pagination when the caller wants to page past
//     head_limit.
//
// Output: plain-string tool_result, formatted per mode:
//   - files_with_matches: "Found N files\n/abs/path1\n/abs/path2..."
//   - content:            "/path:line:text\n..." (suffix pagination hint)
//   - count:              "/path:count\n..." + totals line
//
// Failure semantics: throws Error on missing rg, invalid mode,
// invalid regex (rg exits 2). streamLLMWithTools wraps into
// isError tool_result.

import { spawnSync } from 'node:child_process';
import { basename, isAbsolute, resolve } from 'node:path';

import { getSessionCwd } from '../../session/working-dir.js';
import { getUserConfig } from '../../user-config.js';
import { debug } from '../../debug/log.js';
import { rgListFiles } from '../../tool-runtime/ripgrep-core.js';
import { noteBroadSearch, noteNarrowingAction } from './search-loop-guard.js';
import { resolvePathWithPolicy, sensitiveRgExcludeArgs, type PathPolicy } from '../../agent/path-policy.js';

const DEFAULT_HEAD_LIMIT = 250;
const MAX_HEAD_LIMIT = 10_000;
const RG_TIMEOUT_MS = 30_000;
const RG_MAX_BUFFER = 20 * 1024 * 1024;  // 20 MB — matches claude-code

export interface GrepArgs {
  pattern: string;
  /** Ignore rules를 무시해 .elanous-test 같은 관측 경로도 포함한다. */
  no_ignore?: boolean;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'files_with_matches' | 'content' | 'count';
  head_limit?: number;
  offset?: number;
  '-n'?: boolean;
  '-i'?: boolean;
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  multiline?: boolean;
}

export interface GrepResult {
  output: string;
  mode: 'files_with_matches' | 'content' | 'count';
  numFiles: number;
  numMatches: number;
  truncated: boolean;
}

export function buildGrepTool(): LLMToolSpec {
  return {
    name: 'Grep',
    description:
      'A powerful text search tool built on ripgrep. ' +
      'ALWAYS use Grep for text / pattern search tasks. NEVER invoke `grep` or `rg` ' +
      'as a Bash command — this tool has the correct permissions, caps, and pagination ' +
      'wired in. For the canonical source-exploration sequence, use Grep (find ' +
      'candidates) → Read (inspect specific files) → Edit/Write. Glob is for filename-only ' +
      'patterns. ' +
      'For structural / symbol queries (e.g. "where is X defined", "who calls Y", ' +
      '"list all methods on class Z"), use the `Lsp` tool — its goToDefinition / ' +
      'findReferences / documentSymbol / workspaceSymbol operations are precise ' +
      'where Grep regex would catch false positives in comments and strings. ' +
      'Three modes via output_mode: `files_with_matches` (paths only, default), ' +
      '`content` (matching lines, with -n/-A/-B/-C context), `count` (per-file ' +
      `occurrence count). Results are bounded by head_limit (default ${DEFAULT_HEAD_LIMIT}) ` +
      'to protect your context window; call again with offset to paginate past it. ' +
      'Prefer --type over --glob when searching by language.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for.' },
        no_ignore: { type: 'boolean', description: 'Include paths excluded by .gitignore or .ignore, including hidden observation state. .git is always excluded.' },
        path: { type: 'string', description: 'Directory or file to search. Default: current working directory.' },
        glob: { type: 'string', description: 'Filename glob (e.g., "*.ts"). Omit to search all files ripgrep considers indexable.' },
        type: { type: 'string', description: 'Language filter (e.g., "ts", "py", "rust"). Often cheaper than --glob.' },
        output_mode: {
          type: 'string',
          enum: ['files_with_matches', 'content', 'count'],
          description: 'Format of the result. Default "files_with_matches".',
        },
        head_limit: { type: 'number', description: `Max lines to return. Default ${DEFAULT_HEAD_LIMIT}.` },
        offset: { type: 'number', description: 'Skip the first N result lines before applying head_limit.' },
        '-n': { type: 'boolean', description: 'Show line numbers (content mode).' },
        '-i': { type: 'boolean', description: 'Case-insensitive match.' },
        '-A': { type: 'number', description: 'Lines of trailing context (content mode).' },
        '-B': { type: 'number', description: 'Lines of leading context (content mode).' },
        '-C': { type: 'number', description: 'Lines of surrounding context (content mode).' },
        multiline: { type: 'boolean', description: 'Let `.` match newlines so the regex can span multiple lines.' },
      },
      required: ['pattern'],
    },
  };
}

export async function dispatchGrep(
  args: Record<string, unknown>,
  opts: { pathPolicy?: PathPolicy } = {},
): Promise<GrepResult> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (!pattern) throw new Error('Grep: pattern is required');

  const mode = validateMode(args.output_mode) ?? 'files_with_matches';
  const headLimit = clampInt(args.head_limit, DEFAULT_HEAD_LIMIT, 1, MAX_HEAD_LIMIT);
  const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const searchPath = typeof args.path === 'string' && args.path ? args.path : '.';
  // ★ Phase 4b PR3(2026-07-22) — 서피스 트러스트 정책. permissive(기본)=현행 무변경. 원격 메신저
  //   (telegram/discord)=strict: (1) 검색 루트가 cwd-탈출/자격증명 파일이면 차단(resolvePathWithPolicy),
  //   (2) 재귀 매칭에서 credential/키 파일을 rg exclude glob 으로 배제 → content mode 로도 .env/.ssh
  //   덤프 불가(Read strict 로 닫은 갭을 Grep 우회로 다시 열지 않게).
  const policy = opts.pathPolicy ?? 'permissive';
  if (policy !== 'permissive') {
    resolvePathWithPolicy(searchPath, getSessionCwd(), policy); // 루트 안전성 검증(위반 시 throw)
  }

  if (mode === 'files_with_matches') {
    const searchLoop = noteBroadSearch([
      'grep-files',
      searchPath,
      typeof args.glob === 'string' ? args.glob : '',
      typeof args.type === 'string' ? args.type : '',
      String(headLimit),
      String(offset),
      pattern,
    ], [
      'grep-files-scope',
      searchPath,
      typeof args.glob === 'string' ? args.glob : '',
      typeof args.type === 'string' ? args.type : '',
    ]);
    if (searchLoop.blocked) {
      const nativeStructureEnabled = getUserConfig().tools.nativeStructure.enabled;
      const delegationHint = nativeStructureEnabled
        ? ' You may delegate broad read-only exploration to PersistentGrounding.'
        : '';
      // ⛔⭐ 차단을 «관측»에 남긴다 — 종전엔 throw 만 해서 「막혔다」가 어디에도 안 찍혔다.
      //   그래서 `PLAN-grok-native-structure-absorption` §5 ①("RUNTIME BLOCKED 건수")이
      //   ***원리상 잴 수 없었다*** — 조회하면 0 이 나오는데 그 0 은 「안 막혔다」가 아니라
      //   「안 쟀다」였다(2026-08-18 실측: 24h 전 우주 0건 ⊕ 이 자리에 계측 없음).
      //   ⭐ `nativeStructureEnabled` 를 같이 싣는 이유: on/off 대조가 그 축으로 갈린다.
      debug.log('tools.search', 'broad-search-blocked', {
        consecutive: searchLoop.consecutive,
        nativeStructureEnabled,
        delegationHintShown: delegationHint.length > 0,
      }, { level: 'warn' });
      throw new Error(
        `RUNTIME BLOCKED — repeated broad search loop detected (${searchLoop.consecutive} consecutive broad-search calls). ` +
        `You already ran several broad Grep/ListDir steps. Stop issuing more files_with_matches searches. ` +
        `Choose candidate files from prior results and continue with Read, Grep(output_mode="content"), or Lsp.` +
        delegationHint,
      );
    }
  } else {
    noteNarrowingAction();
  }

  if (!hasRipgrep()) {
    throw new Error(
      'Grep: `rg` (ripgrep) is not installed. Install it via `brew install ripgrep` ' +
      '(macOS), `apt install ripgrep` (Ubuntu), `cargo install ripgrep` (any), or ' +
      'fall back to Bash with `grep -r` / `find ... | xargs grep` for similar results.');
  }

  const rgArgs = buildRgArgs({ ...args, pattern, output_mode: mode });
  // strict — 자격증명/키 파일을 rg 가 아예 읽지 않도록 exclude glob 주입(재귀 매칭 차단).
  if (policy === 'strict') rgArgs.push(...sensitiveRgExcludeArgs());
  rgArgs.push('--', pattern, searchPath);

  const started = Date.now();
  const proc = spawnSync('rg', rgArgs, {
    // WD6 — spawn in the session working directory so `.` and
    // relative paths resolve against the active project.
    cwd: getSessionCwd(),
    encoding: 'utf8',
    timeout: RG_TIMEOUT_MS,
    maxBuffer: RG_MAX_BUFFER,
  });

  // rg exit codes:
  //   0 = matches found
  //   1 = no matches (NOT an error)
  //   2 = error (invalid regex, bad path, etc.)
  //  >2 or signals = abort/timeout
  if (proc.status === 2) {
    const err = (proc.stderr ?? '').trim() || 'ripgrep reported an error';
    throw new Error(`Grep: ${err}`);
  }
  if (proc.status === null) {
    throw new Error(`Grep: ripgrep exited abnormally (timeout after ${RG_TIMEOUT_MS}ms or signal)`);
  }

  const raw = proc.stdout ?? '';
  const allLines = raw.split('\n').filter(Boolean);
  const sliceStart = Math.min(allLines.length, offset);
  const sliceEnd = Math.min(allLines.length, sliceStart + headLimit);
  const kept = allLines.slice(sliceStart, sliceEnd);
  const truncated = sliceEnd < allLines.length;

  // Per-mode result formatting.
  if (mode === 'files_with_matches') {
    const numFiles = kept.length;
    const ranked = rankCandidatePathsForPattern(kept, pattern);
    const discovered = discoverFocusedPathCandidates(searchPath, args, pattern);
    const suggested = rankCandidatePathsForPattern(
      [...new Set([...discovered, ...ranked])],
      pattern,
    ).slice(0, 5);
    const header = numFiles === 0
      ? `No files matched`
      : `Found ${numFiles}${truncated ? '+' : ''} file${numFiles === 1 ? '' : 's'}`;
    const suggestionBlock = suggested.length > 0
      ? `\n[Suggested next Read/Lsp candidates]\n${suggested.map(p => `- ${p}`).join('\n')}\n`
      : '';
    const body = kept.join('\n');
    const footer = truncated
      ? `\n\n[... ${allLines.length - sliceEnd} more results — offset:${sliceEnd} to paginate ...]`
      : '\n\n[Next step: pick 1-5 candidate files from this list and use Read or Lsp. Do not issue another broad files_with_matches search unless you are changing scope materially.]';
    return {
      output: `${header}${suggestionBlock}${body ? '\n' + body : ''}${footer}`,
      mode, numFiles, numMatches: numFiles, truncated,
    };
  }

  if (mode === 'count') {
    // rg's --count output is "path:N" per matching file.
    let totalMatches = 0;
    const files = new Set<string>();
    for (const line of kept) {
      const m = line.match(/^(.+):(\d+)$/);
      if (m) {
        files.add(m[1]!);
        totalMatches += Number(m[2]) || 0;
      }
    }
    const footer = truncated
      ? `\n\n[... ${allLines.length - sliceEnd} more files — offset:${sliceEnd} to paginate ...]`
      : '';
    return {
      output: `${kept.join('\n')}\n\nFound ${totalMatches} match${totalMatches === 1 ? '' : 'es'} across ${files.size} file${files.size === 1 ? '' : 's'}${truncated ? ' (partial)' : ''}${footer}`,
      mode, numFiles: files.size, numMatches: totalMatches, truncated,
    };
  }

  // content mode
  const numMatches = kept.length;
  const files = new Set<string>();
  for (const line of kept) {
    const idx = line.indexOf(':');
    if (idx > 0) files.add(line.slice(0, idx));
  }
  const footer = truncated
    ? `\n\n[... ${allLines.length - sliceEnd} more lines — offset:${sliceEnd} to paginate ...]`
    : '';
  return {
    output: numMatches === 0
      ? `No matches`
      : `${kept.join('\n')}${footer}`,
    mode, numFiles: files.size, numMatches, truncated,
  };
}

// ── internals ──

function extractPatternTerms(pattern: string): string[] {
  return [...new Set(
    pattern
      .toLowerCase()
      .split(/[^a-z0-9_-]+/i)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => s.length >= 4)
      .filter(s => !/^\d+$/.test(s)),
  )];
}

const LOW_SIGNAL_PATTERN_TERMS = new Set([
  'state',
  'guard',
  'search',
  'session',
  'runtime',
  'exploration',
  'synthesis',
  'inspect',
  'observe',
]);

const DEBUG_FOCUS_TERMS = new Set([
  'debug',
  'trace',
  'logger',
  'logging',
  'loglevel',
  'verbose',
  'diagnostic',
  'dashboard',
]);

const DEBUG_CORE_PATH_HINTS = [
  '/src/debug/',
  '/src/display/',
  '/src/window/',
  '/src/dashboard/',
] as const;

const DEBUG_CORE_BASENAME_HINTS = [
  'debug-',
  'debug_',
  'debug.',
  'debugsurface',
  'debug-window',
  'call-stack',
  'log.',
  'logger',
  'trace',
] as const;

const DEBUG_GENERIC_PENALTY_PATHS = [
  '/src/acp/',
  '/src/code-edit/',
  '/src/ask-user-question/',
  '/test/',
] as const;

function tokenizePath(path: string): string[] {
  return path
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .map(s => s.trim())
    .filter(Boolean);
}

function scorePathForPattern(path: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const lowerPath = path.toLowerCase();
  const lowerBase = basename(path).toLowerCase();
  const pathTokens = new Set(tokenizePath(path));
  const debugFocused = terms.some(term => DEBUG_FOCUS_TERMS.has(term));
  let score = 0;
  for (const term of terms) {
    const weight = LOW_SIGNAL_PATTERN_TERMS.has(term) ? 1 : 3;
    if (pathTokens.has(term)) score += 6 * weight;
    else if (lowerBase.includes(term)) score += 4 * weight;
    else if (lowerPath.includes(`/${term}`) || lowerPath.includes(`${term}/`)) score += 3 * weight;
    else if (lowerPath.includes(term)) score += weight;
  }
  if (debugFocused) {
    for (const hint of DEBUG_CORE_PATH_HINTS) {
      if (lowerPath.includes(hint)) score += 14;
    }
    for (const hint of DEBUG_CORE_BASENAME_HINTS) {
      if (lowerBase.includes(hint)) score += 10;
    }
    if (lowerBase === 'log.ts') score += 16;
    if (lowerBase === 'call-stack.ts') score += 16;
    if (lowerBase === 'debug-surface.ts') score += 18;
    if (lowerBase === 'debug-window-consumers.ts') score += 18;
    if (lowerBase.includes('debug')) score += 8;
    if (lowerBase.includes('dashboard')) score += 6;
    if (lowerPath.includes('/dashboard/runtime/')) score += 6;
    if (lowerPath.includes('/dashboard/chat/')) score += 4;
    for (const penalty of DEBUG_GENERIC_PENALTY_PATHS) {
      if (lowerPath.includes(penalty) && !lowerPath.includes('/debug')) score -= 10;
    }
    if (lowerPath.includes('/src/acp/') && lowerBase.includes('state')) score -= 8;
    if (lowerPath.includes('/src/code-edit/')) score -= 12;
  }
  if (lowerPath.includes('/src/')) score += 1;
  return score;
}

function rankCandidatePathsForPattern(paths: readonly string[], pattern: string): string[] {
  const terms = extractPatternTerms(pattern);
  if (terms.length === 0) return [];
  return [...paths]
    .map(path => ({ path, score: scorePathForPattern(path, terms) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map(entry => entry.path);
}

function looksLikeFocusedPathCandidate(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const lowerBase = basename(path).toLowerCase();
  return (
    DEBUG_CORE_PATH_HINTS.some(hint => lowerPath.includes(hint))
    || DEBUG_CORE_BASENAME_HINTS.some(hint => lowerBase.includes(hint))
    || lowerBase === 'log.ts'
    || lowerBase === 'call-stack.ts'
    || lowerBase === 'debug-surface.ts'
    || lowerBase === 'debug-window-consumers.ts'
  );
}

function discoverFocusedPathCandidates(
  searchPath: string,
  args: Record<string, unknown>,
  pattern: string,
): string[] {
  const terms = extractPatternTerms(pattern);
  if (!terms.some(term => DEBUG_FOCUS_TERMS.has(term))) return [];
  // 공유 discovery 프리미티브(ripgrep-core) — Glob 툴·존재맵과 동일 rg --files.
  const rg = rgListFiles({
    roots: [searchPath],
    ...(typeof args.glob === 'string' && args.glob ? { globs: [args.glob] } : {}),
    noIgnore: args.no_ignore === true,
    cwd: getSessionCwd(),
    timeoutMs: RG_TIMEOUT_MS,
    maxBuffer: RG_MAX_BUFFER,
  });
  if (!rg.ok) return [];
  return rg.paths
    .map(line => (isAbsolute(line) ? line : resolve(getSessionCwd(), line)))
    .filter(looksLikeFocusedPathCandidate)
    .slice(0, 50);
}

function validateMode(v: unknown): GrepResult['mode'] | null {
  if (v === 'content' || v === 'count' || v === 'files_with_matches') return v;
  if (v === undefined || v === null || v === '') return null;
  throw new Error(`Grep: invalid output_mode ${JSON.stringify(v)} — use "files_with_matches" | "content" | "count"`);
}

function hasRipgrep(): boolean {
  const r = spawnSync('which', ['rg'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout ?? '').trim().length > 0;
}

function buildRgArgs(args: Record<string, unknown> & { output_mode: GrepResult['mode'] }): string[] {
  const out: string[] = [];

  // Output mode flags. `--no-messages` swallows stderr noise about
  // unreadable dirs so we don't leak it into the tool_result.
  // `--sort path` forces alphabetical ordering so offset-based
  // pagination produces disjoint slices across calls — rg's default
  // walk is parallel and non-deterministic.
  out.push('--no-messages', '--sort', 'path');
  if (args.output_mode === 'files_with_matches') out.push('-l');
  else if (args.output_mode === 'count') out.push('-c');
  else out.push('--color', 'never');

  if (args.no_ignore === true) out.push('--no-ignore', '--hidden', '--glob', '!**/.git/**');
  if (args['-i'] === true) out.push('-i');
  if (args.multiline === true) out.push('-U', '--multiline-dotall');

  // Line numbers (content mode only).
  if (args.output_mode === 'content' && args['-n'] === true) out.push('-n');

  // Context flags (content mode only).
  if (args.output_mode === 'content') {
    const A = clampInt(args['-A'], 0, 0, 100);
    const B = clampInt(args['-B'], 0, 0, 100);
    const C = clampInt(args['-C'], 0, 0, 100);
    if (C > 0) out.push('-C', String(C));
    else {
      if (A > 0) out.push('-A', String(A));
      if (B > 0) out.push('-B', String(B));
    }
  }

  if (typeof args.glob === 'string' && args.glob) out.push('-g', args.glob);
  if (typeof args.type === 'string' && args.type) out.push('-t', args.type);

  return out;
}

function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}
