import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── Edit tool (Claude Code-compatible exact-string replace) ──
//
// Ports claude-code-fork/src/tools/FileEditTool. Core guarantee:
// refuse to edit when `old_string` appears more than once (unless
// `replace_all: true` is explicitly requested). This is the reason
// Edit exists at all rather than having the LLM use `sed -i` via
// Bash — sed can silently substitute in the wrong location when a
// pattern happens to match multiple lines, and the LLM only notices
// the corruption after-the-fact. Edit surfaces the ambiguity back
// to the LLM so it can request more context, quote more specifically,
// or opt into replace_all.
//
// Scope vs claude-code FileEditTool:
//   - Full parity on the core behaviour: exact match, unique-vs-all
//     dispatch, descriptive error on zero/ambiguous matches.
//   - Returns plain-string tool_result (count + before/after hints)
//     rather than the structured diff-hunk protocol. LLMs cope fine
//     with the text summary; adding Patch structure doesn't materially
//     improve their editing accuracy and adds surface area.
//   - Skips the "must have Read'd this file first" enforcement —
//     that's an agent-state concern, not a tool correctness concern,
//     and elanous doesn't track per-file read state today.
//   - No git integration or LSP notification. Bash + the user's own
//     editor loop cover those cases.
//
// Safety: rejects paths >1 GiB, refuses no-op edits (old === new),
// refuses "".
//
// Failure surfaces as a thrown Error (caught by streamLLMWithTools
// and wrapped into isError tool_result).

import { statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { getSessionBoundary, getSessionCwd, isWriteAllowedInBoundary } from '../../session/working-dir.js';
import { harnessMainTreeReject } from '../../harness/harness-write-boundary.js';
import { debug } from '../../debug/log.js';
import { resolvePathWithPolicy, type PathPolicy } from '../../agent/path-policy.js';

const MAX_BYTES = 1024 * 1024 * 1024;     // 1 GiB — same cap as Read

export interface EditArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface EditResult {
  /** Summary string for the tool_result. */
  output: string;
  /** How many substitutions actually happened. */
  replacements: number;
  /** Abs path we touched. */
  filePath: string;
}

export function buildEditTool(): LLMToolSpec {
  return {
    name: 'Edit',
    description:
      'Replace an exact string in a file with another exact string. ' +
      'Fails if `old_string` matches zero times, and refuses to proceed when it ' +
      'matches more than once unless you set `replace_all: true` — this prevents ' +
      'accidentally substituting in the wrong location. For bulk rewrites or ' +
      'multi-file edits, call Edit multiple times or use Bash + sed with care.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to edit.',
        },
        old_string: {
          type: 'string',
          description: 'Exact text to find. Include surrounding context to make the match unambiguous.',
        },
        new_string: {
          type: 'string',
          description: 'Text to substitute in. Must differ from old_string.',
        },
        replace_all: {
          type: 'boolean',
          description: 'When true, replace every occurrence. Default false (unique-match only).',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  };
}

export async function dispatchEdit(
  args: Record<string, unknown>,
  opts: { pathPolicy?: PathPolicy } = {},
): Promise<EditResult> {
  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
  const oldString = typeof args.old_string === 'string' ? args.old_string : '';
  const newString = typeof args.new_string === 'string' ? args.new_string : '';
  const replaceAll = args.replace_all === true;

  if (!filePath) throw new Error('Edit: file_path is required');
  if (oldString === '') {
    throw new Error('Edit: old_string is required and cannot be empty — ' +
      'use Write (or Bash `cat > file`) to create/overwrite files');
  }
  if (oldString === newString) {
    throw new Error('Edit: old_string and new_string are identical — this would be a no-op');
  }

  // Relative-path resolution — parity with Read (read.ts) and Write
  // (write.ts WD6). codex/frontier models routinely emit relative paths;
  // Edit used to hard-reject them ("must be absolute"), producing a per-tool
  // error that, repeated, fed the DoomLoopTracker → HITL freeze (RESEARCH-
  // autonomous-runaway-discipline-2026-07-19 R3). Resolve against the session
  // cwd like the sibling tools instead.
  // ★ Phase 4b(2026-07-22) — 경로 해석+보안을 단일 정책(resolvePathWithPolicy)으로. permissive(기본)=
  //   현행(~ 확장 + relative→sessionCwd·무제한). 서피스가 opts.pathPolicy 로 strict/anchored 를 조이면
  //   cwd-앵커(+credential deny-list) 강제 — telegram/discord=strict(대표 결정 2026-07-22).
  const policy = opts.pathPolicy ?? 'permissive';
  const resolved = resolvePathWithPolicy(filePath, getSessionCwd(), policy);
  const boundary = getSessionBoundary();
  if (boundary !== null && !isWriteAllowedInBoundary(resolved)) {
    throw new Error(`Edit: isolated write boundary rejected ${resolved}; boundary is ${boundary}`);
  }
  if (boundary === null) {
    const harnessReject = harnessMainTreeReject(resolved, process.env, getSessionCwd(), 'skills-edit');
    if (harnessReject) throw new Error(harnessReject);
  }
  if (debug.enabled && !isAbsolute(filePath) && !filePath.startsWith('~')) {
    debug.log('code-edit.dispatch', 'edit.path-resolved', {
      input: filePath,
      resolved,
      policy,
    });
  }
  if (!existsSync(resolved)) {
    throw new Error(`Edit: file does not exist — ${resolved}`);
  }
  const st = statSync(resolved);
  if (!st.isFile()) {
    throw new Error(`Edit: not a regular file — ${resolved}`);
  }
  if (st.size > MAX_BYTES) {
    throw new Error(`Edit: file too large (${formatBytes(st.size)} > 1 GiB cap)`);
  }

  const original = readFileSync(resolved, 'utf8');
  let count = countOccurrences(original, oldString);
  // Fuzzy fallback (gap G3, ref/codex `apply-patch/src/`): when exact
  // match fails, retry with per-line whitespace normalized so the
  // common LLM failure mode (lost / wrong indentation, CRLF vs LF
  // mismatch) still locates the block. Only kicks in when exact
  // count === 0, so the established exact-match behavior is
  // unchanged for callers that supplied the literal text. The fuzzy
  // matcher returns the ORIGINAL substring (with the file's actual
  // indentation) so the subsequent replace preserves formatting.
  let effectiveOldString = oldString;
  let fuzzyApplied = false;
  if (count === 0) {
    const fuzzy = tryFuzzyLineMatch(original, oldString);
    if (fuzzy && 'ambiguous' in fuzzy) {
      throw new Error(
        `Edit: old_string didn't match exactly, and fuzzy (whitespace-tolerant) ` +
        `match found ${fuzzy.ambiguous} candidate locations in ${resolved}. ` +
        `Include more surrounding context so the match is unique, or use ` +
        `replace_all + an exact substring.`);
    }
    if (fuzzy && 'matchedSource' in fuzzy) {
      effectiveOldString = fuzzy.matchedSource;
      count = countOccurrences(original, effectiveOldString);
      fuzzyApplied = true;
    }
  }

  if (count === 0) {
    throw new Error(
      `Edit: old_string not found in ${resolved}. ` +
      `Verify the exact text including whitespace and line endings. ` +
      `If you\'re unsure, Read the file first and copy the literal text.`);
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `Edit: old_string matches ${count} times in ${resolved}. ` +
      `Either include more surrounding context so the match is unique, ` +
      `or pass replace_all: true to substitute every occurrence.`);
  }

  const updated = replaceAll
    ? replaceAllLiteral(original, effectiveOldString, newString)
    : replaceOnce(original, effectiveOldString, newString);
  const replacements = replaceAll ? count : 1;

  writeFileSync(resolved, updated, 'utf8');

  const hint = replaceAll
    ? `Replaced ${replacements} occurrence${replacements === 1 ? '' : 's'}.`
    : `Replaced 1 occurrence.`;
  const fuzzyTag = fuzzyApplied ? ' (fuzzy whitespace-tolerant match)' : '';
  return {
    output: `Edited ${resolved}. ${hint}${fuzzyTag}`,
    replacements,
    filePath: resolved,
  };
}

/** Fuzzy line-level match used as a fallback when exact-string match
 *  returns 0. Strips per-line leading/trailing whitespace on both
 *  sides AND drops surrounding blank lines from `needle`, then
 *  searches for the trimmed needle as a contiguous line-sequence in
 *  the trimmed haystack. Returns the ORIGINAL haystack substring
 *  (with the file's actual whitespace) so the replace stage
 *  preserves indentation. Returns ambiguity when multiple
 *  candidates match, null when zero — caller handles both. */
function tryFuzzyLineMatch(
  haystack: string,
  needle: string,
): { matchedSource: string } | { ambiguous: number } | null {
  const haystackLines = haystack.split(/\r?\n/);
  let needleLines = needle.split(/\r?\n/);
  // Trim leading + trailing blank lines from needle so a model that
  // pasted with extra surrounding newlines still matches.
  while (needleLines.length > 0 && needleLines[0]!.trim() === '') needleLines.shift();
  while (needleLines.length > 0 && needleLines[needleLines.length - 1]!.trim() === '') needleLines.pop();
  if (needleLines.length === 0) return null;
  const normNeedle = needleLines.map(l => l.trim());
  const matches: number[] = [];
  for (let i = 0; i + normNeedle.length <= haystackLines.length; i++) {
    let ok = true;
    for (let j = 0; j < normNeedle.length; j++) {
      if (haystackLines[i + j]!.trim() !== normNeedle[j]) { ok = false; break; }
    }
    if (ok) matches.push(i);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) return { ambiguous: matches.length };
  const start = matches[0]!;
  const end = start + normNeedle.length;
  return { matchedSource: haystackLines.slice(start, end).join('\n') };
}

// ── internals ──

/** Count non-overlapping literal matches. JS's `split().length - 1`
 *  works correctly even when `needle` itself contains regex
 *  metacharacters (no regex involved). */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/** Replace first occurrence, literal semantics (no regex). */
function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx < 0) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

/** Replace all literal occurrences. JS's String.prototype.replaceAll
 *  does this correctly with a string (not regex) pattern. */
function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
}
