import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── Glob tool (Claude Code-compatible file-path discovery) ──
//
// Ports claude-code-fork/src/tools/GlobTool. The LLM calls this when
// it knows a filename pattern (e.g. "**/*.ts", "src/**/*.test.{ts,tsx}")
// and wants matching PATHS without content. Cheaper than Grep for
// "does file X exist?" / "list all .py files under src/" queries
// because it skips file content scanning entirely.
//
// Implementation uses `rg --files --iglob <pat>` — case-insensitive by
// default (search-bench #40045 ablation: dropping case-insensitivity cost
// recall@5 −0.22 overall, −0.44 on docs — the single biggest lever; a seat
// guesses `*approval*` for `GraphApprovalCard.tsx`). We already require
// rg for the Grep tool, so no new binary dependency. rg's file
// discovery also respects .gitignore by default, which matches the
// user's mental model (the one big reason LLMs typically want Glob
// in the first place — skip node_modules / build artefacts).
//
// Output: sorted list of absolute paths, newest-mtime first (matches
// claude-code-fork's contract). Paginated via head_limit + offset
// so a broad match like "**/*" doesn't blow the context window.

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSessionCwd } from '../../session/working-dir.js';
import { expandHomePath } from '../../agent/path-policy.js';
import { rgListFiles } from '../../tool-runtime/ripgrep-core.js';
import { mapToLatest, staleCwdFor, staleCwdHint } from '../../knowledge/stale-cwd.js';


const DEFAULT_HEAD_LIMIT = 200;
const MAX_HEAD_LIMIT = 5_000;
const GLOB_TIMEOUT_MS = 15_000;
const GLOB_MAX_BUFFER = 8 * 1024 * 1024;  // 8 MB — paths only, smaller cap than Grep

export interface GlobArgs {
  pattern: string;
  /** Ignore rules를 무시해 .elanous-test 같은 관측 경로도 포함한다. */
  no_ignore?: boolean;
  path?: string;
  head_limit?: number;
  offset?: number;
}

export interface GlobResult {
  /** Pre-formatted string for tool_result: one path per line, plus
   *  a header + optional pagination hint. */
  output: string;
  /** Total matches found (before truncation). The caller uses this
   *  to decide whether to paginate. */
  numFiles: number;
  /** How many entries are actually in `output` (≤ head_limit). */
  numShown: number;
  truncated: boolean;
}

export function buildGlobTool(): LLMToolSpec {
  return {
    name: 'Glob',
    description:
      'Find files by path pattern — the first search tool to reach for when the topic names a file. ' +
      'Case-insensitive by default (`*approval*` also finds `GraphApprovalCard.tsx` and `APPROVAL.md`). ' +
      'Paths only, no content scan; standard globs (`**`, `{ts,tsx}`); respects .gitignore. Examples: ' +
      '`**/*approval*card*` (a feature whose filename you can guess) · `docs/**/*release*.md` (a design doc by topic). ' +
      `Results are sorted newest-first, bounded by head_limit (default ${DEFAULT_HEAD_LIMIT}); ` +
      'paginate via `offset` when the match set is large. Then Grep inside the hits, then Read the best one.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, matched case-insensitively. Examples: "**/*approval*", "src/**/*.{ts,tsx}", "*.md".' },
        no_ignore: { type: 'boolean', description: 'Include paths excluded by .gitignore or .ignore, including hidden observation state. .git is always excluded.' },
        path: { type: 'string', description: 'Directory to search from. Defaults to current working directory.' },
        head_limit: { type: 'number', description: `Max paths to return (default ${DEFAULT_HEAD_LIMIT}, cap ${MAX_HEAD_LIMIT}).` },
        offset: { type: 'number', description: 'Skip this many matches before applying head_limit. Use for pagination.' },
      },
      required: ['pattern'],
    },
  };
}

/** Dispatch a Glob call — shells out to `rg --files --iglob <pattern>`,
 *  sorts by mtime descending, applies offset + head_limit, and
 *  returns a formatted string result. Throws on missing rg, invalid
 *  pattern, or timeout. */
export async function dispatchGlob(args: Record<string, unknown>): Promise<GlobResult> {
  const pattern = String(args.pattern ?? '').trim();
  if (!pattern) throw new Error('pattern is required');

  // WD6 — default search path is the session working directory so
  // relative globs ("src/**/*.ts") resolve against the active project.
  const sessionCwd = getSessionCwd();
  const searchPath = args.path ? resolve(sessionCwd, expandHomePath(String(args.path))) : sessionCwd;
  const head = Math.min(
    MAX_HEAD_LIMIT,
    Math.max(1, Number(args.head_limit) || DEFAULT_HEAD_LIMIT),
  );
  const offset = Math.max(0, Number(args.offset) || 0);

  // rg's --glob uses gitignore-style anchoring, so `src/**/*.ts`
  // won't match unless it's rooted to the walker's actual position.
  // Normalize the user-visible shell-glob semantics by prepending
  // `**/` to any pattern that has a `/` and doesn't already start
  // with `**/`. Basename-only patterns (`*.ts`, `*.md`) are left
  // alone — they already match anywhere.
  const normalizedPattern = (pattern.includes('/') && !pattern.startsWith('**/'))
    ? `**/${pattern}`
    : pattern;

  // 공유 discovery 프리미티브(ripgrep-core) — 존재 맵·미션 루프와 동일한 rg --files --glob.
  const rg = rgListFiles({ roots: [searchPath], iglobs: [normalizedPattern], noIgnore: args.no_ignore === true, maxBuffer: GLOB_MAX_BUFFER, timeoutMs: GLOB_TIMEOUT_MS });
  if (!rg.ok) {
    if (rg.errorKind === 'missing-rg') throw new Error('ripgrep (rg) not found on PATH. Install via `brew install ripgrep` or equivalent.');
    if (rg.errorKind === 'timeout') throw new Error(`rg killed by signal (likely timeout after ${GLOB_TIMEOUT_MS}ms)`);
    if (rg.errorKind === 'invalid') throw new Error(`rg failed: ${rg.stderr || 'unknown error'}`); // 잘못된 패턴/경로
    throw new Error(`rg spawn failed: ${rg.stderr ?? 'unknown'}`);
  }
  const paths = rg.paths;

  // Sort by mtime descending (newest first). stat failures demote the
  // path to mtime=0 rather than throw — a single stale symlink
  // shouldn't break a 500-file listing.
  const stamped = paths.map(p => {
    try { return { p, mtime: statSync(p).mtimeMs }; }
    catch { return { p, mtime: 0 }; }
  });
  // Equal mtimes are common; rg traversal order is not guaranteed across calls.
  // Break ties by path so offset pages remain stable while the tree is unchanged.
  stamped.sort((a, b) => b.mtime - a.mtime || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));

  const numFiles = stamped.length;
  const start = Math.min(offset, numFiles);
  const end = Math.min(start + head, numFiles);
  const window = stamped.slice(start, end);
  const numShown = window.length;
  const truncated = end < numFiles;

  const header = numFiles === 0
    ? `No files matched "${pattern}" under ${searchPath}`
    : `${numFiles} file${numFiles === 1 ? '' : 's'} matched "${pattern}"${truncated ? ` (showing ${start + 1}-${end})` : ''}`;
  const body = window.map(x => x.p).join('\n');
  const tail = truncated
    ? `\n\n… ${numFiles - end} more — call again with offset=${end} to paginate.`
    : '';

  // 낡은 cwd 트리면 latest 의 같은 상대 경로도 찾아 붙인다(stale-cwd.ts · 실패는 조용히 생략).
  let latest = '';
  let hint = '';
  try {
    const stale = staleCwdFor(sessionCwd);
    const mapped = stale ? mapToLatest(searchPath, stale) : null;
    if (stale && mapped) {
      const lr = rgListFiles({ roots: [mapped], iglobs: [normalizedPattern], noIgnore: args.no_ignore === true, maxBuffer: GLOB_MAX_BUFFER, timeoutMs: GLOB_TIMEOUT_MS });
      if (lr.ok) {
        hint = `[${staleCwdHint(stale)}]\n`;
        const shown = [...lr.paths].sort().slice(0, head);
        const more = lr.paths.length > shown.length ? `\n… ${lr.paths.length - shown.length} more in latest` : '';
        latest = shown.length > 0
          ? `\n\n[latest: ${stale.latestRoot}] ${lr.paths.length} file${lr.paths.length === 1 ? '' : 's'}\n${shown.join('\n')}${more}`
          : `\n\n[latest: ${stale.latestRoot}] no files matched`;
      }
    }
  } catch { /* 보조 검색 실패는 본 결과를 막지 않는다 */ }

  return {
    output: `${hint}${body.length > 0 ? `${header}\n\n${body}${tail}` : header}${latest}`,
    numFiles,
    numShown,
    truncated,
  };
}
