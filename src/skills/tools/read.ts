import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── Read tool (Claude Code-compatible file reader) ──
//
// Ports claude-code-fork/src/tools/FileReadTool with a scope trimmed
// for elanous's skill runner. Matches the LLM-facing schema exactly
// (`file_path` + `offset` + `limit` + `pages`) so community skills
// that say "use the Read tool to load X" work out of the box.
//
// Scope vs claude-code:
//   - Text files: full parity — pagination + `cat -n` formatted
//     output with right-padded line numbers. LLM can refer to line
//     N when it builds a subsequent Edit call.
//   - Binary / image / PDF: MVP returns a descriptive metadata
//     string ("image: ..., 124KB, png"). Claude Code routes these
//     as ContentBlock tool_results; elanous's streamLLMWithTools
//     currently pipes a string through `dispatchTool`, so base64
//     / DocumentBlockParam wiring lands in a separate phase.
//   - Notebook (.ipynb) cells: out of scope for MVP — skill can
//     use Bash + jq.
//
// Errors surface as thrown Error strings so `streamLLMWithTools`
// catches + wraps them into `tool_result { isError: true }` — matches
// claude-code's "exception → error tool_result" convention.

import { statSync, openSync, readSync, closeSync, createReadStream, existsSync } from 'node:fs';
import { isAbsolute, extname } from 'node:path';

import { debug } from '../../debug/log.js';
import { getSessionCwd } from '../../session/working-dir.js';
import {
  readCacheKey, dedupeStub, logDedupHit, type SessionCache,
  CONSECUTIVE_DEDUP_BLOCK_THRESHOLD,
} from '../../session/cache.js';
import { noteNarrowingAction } from './search-loop-guard.js';
import { resolveReadPathArg } from '../../agent/read-args.js';
import { resolvePathWithPolicy, type PathPolicy } from '../../agent/path-policy.js';

// ── Size budgets ──
// Goal: large-enough defaults that typical source files / JSON blobs
// (≈ 100 KB = 3–5k lines of prose) come back in ONE Read call. Keeps
// the LLM from burning turns re-reading the same file with different
// offsets (a pathology seen with 60 KB personas.json before this).
const DEFAULT_LIMIT = 5000;                 // up from 2000
const DEFAULT_LIMIT_WHEN_DEBUG = 10_000;    // debug mode → verbose, allow more
const MAX_LIMIT = 30_000;                   // up from 10k — still leaves room for extreme edge cases via offset paging
const MAX_BYTES = 1024 * 1024 * 1024;       // 1 GiB hard cap — matches claude-code
const LINE_NUMBER_WIDTH = 6;                // "     1\tcontent" formatting
const TRUNCATE_LINE_LEN = 5000;             // per-line cap — up from 2000, enough for long JSON rows

/** Mirrors the LLM-visible schema. Field names + semantics preserved
 *  so skills carry over without edits. */
export interface ReadArgs {
  file_path: string;
  offset?: number;   // 1-indexed line number to start from (default 1)
  limit?: number;    // max lines to return (default 2000, cap 10000)
  pages?: string;    // PDF page range ("1-5", "3") — MVP: metadata-only
}

export interface ReadResult {
  /** String suitable for use as the tool_result content. */
  output: string;
  /** Number of lines actually read (after offset + limit applied). */
  linesRead: number;
  /** Total lines in the file — helps LLM plan further pagination. */
  totalLines: number;
  /** Total byte size (stat-reported). */
  totalBytes: number;
  /** True when limit cut off more lines past the window. */
  truncated: boolean;
  /** 'text' | 'image' | 'pdf' | 'binary' — affects output shape. */
  kind: 'text' | 'image' | 'pdf' | 'binary';
}

export function buildReadTool(): LLMToolSpec {
  return {
    name: 'Read',
    description:
      'Read a file from disk. Use for inspecting source files, configs, logs. ' +
      'Returns content with `cat -n` line numbers so you can reference specific lines ' +
      'in a subsequent Edit call. ' +
      `Default budget is ${DEFAULT_LIMIT} lines per call (up to ${MAX_LIMIT} if you pass \`limit\` explicitly) — ` +
      'OMIT `offset` and `limit` for files ≤ 5k lines; you\'ll get the full content in one shot. ' +
      'Only paginate (offset = <prev endIdx + 1>) when a file is larger than the default budget. ' +
      'Images and PDFs return metadata only — use Bash (`python3 -m pdfplumber`, `file`, `identify`) to process their contents.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'Path to the file to read. Absolute paths (`/Users/...`) are preferred; ' +
            '`~/...` expands HOME; relative paths (`src/llm.ts`) resolve against the ' +
            'current session working directory.',
        },
        offset: {
          type: 'number',
          description: '1-indexed line number to start reading from. Default 1. Only set this when paginating a file larger than the default limit.',
        },
        limit: {
          type: 'number',
          description: `Max number of lines to return. Default ${DEFAULT_LIMIT} (${DEFAULT_LIMIT_WHEN_DEBUG} when /debug is on), capped at ${MAX_LIMIT}. Omit unless you specifically need a narrow window — a small limit forces multiple round-trips.`,
        },
        pages: {
          type: 'string',
          description: 'PDF page range (e.g. "1-5"). MVP returns metadata only.',
        },
      },
      required: ['file_path'],
    },
  };
}

export async function dispatchRead(
  args: Record<string, unknown>,
  opts: { sessionCache?: SessionCache; pathPolicy?: PathPolicy } = {},
): Promise<ReadResult> {
  noteNarrowingAction();
  // file_path(canonical) ?? path(레거시 별칭) — 단일 출처 리졸버(Phase 4a). daemon Read 와 동일 계약
  //   이라 어느 서피스에서 온 인자든 관용. 광고 스키마는 file_path 유지(무-churn).
  const filePath = resolveReadPathArg(args);
  if (!filePath) throw new Error('Read: file_path is required');
  // ★ Phase 4b(2026-07-22) — 경로 해석+보안을 단일 정책(resolvePathWithPolicy)으로 수렴. 기본
  //   permissive = native 현행: `~` 확장 + relative→getSessionCwd·무제한(claude-code-fork expandPath
  //   ergonomics·codex 상대경로 stall 회피). 서피스가 opts.pathPolicy 로 조이면 strict(cwd-앵커 +
  //   credential deny-list)/anchored 강제 — telegram/discord=strict(원격 트러스트·대표 결정).
  const policy = opts.pathPolicy ?? 'permissive';
  const resolved = resolvePathWithPolicy(filePath, getSessionCwd(), policy);
  if (debug.enabled && !isAbsolute(filePath) && !filePath.startsWith('~')) {
    debug.log('code-edit.dispatch', 'read.path-resolved', {
      input: filePath,
      resolved,
      policy,
    });
  }

  if (!existsSync(resolved)) {
    throw new Error(`Read: file does not exist — ${resolved}`);
  }
  const st = statSync(resolved);
  if (!st.isFile()) {
    throw new Error(`Read: not a regular file — ${resolved}`);
  }
  if (st.size > MAX_BYTES) {
    throw new Error(`Read: file too large (${formatBytes(st.size)} > 1 GiB cap) — use Bash with head/tail/sed for targeted inspection`);
  }

  const kind = classify(resolved);

  if (kind === 'image') {
    return {
      output: `[image: ${resolved}, ${formatBytes(st.size)}, ${extname(resolved).slice(1) || 'unknown'} — MVP: use Bash for base64/identify]`,
      linesRead: 0, totalLines: 0, totalBytes: st.size, truncated: false, kind,
    };
  }
  if (kind === 'pdf') {
    const pages = typeof args.pages === 'string' ? args.pages : '(full)';
    return {
      output: `[pdf: ${resolved}, ${formatBytes(st.size)}, pages ${pages} — MVP: use Bash + pdfplumber/pdftotext to extract]`,
      linesRead: 0, totalLines: 0, totalBytes: st.size, truncated: false, kind,
    };
  }
  if (kind === 'binary') {
    return {
      output: `[binary: ${resolved}, ${formatBytes(st.size)} — not a text file; use Bash (file/xxd/hexdump) to inspect]`,
      linesRead: 0, totalLines: 0, totalBytes: st.size, truncated: false, kind,
    };
  }

  // Text path. Default limit is mode-aware: when the debug tracer is
  // ON the user has opted into verbose output (tail -f / mirror), so
  // we default to DEFAULT_LIMIT_WHEN_DEBUG (10k) instead of 5k so a
  // single Read pulls most files in full. Explicit `limit` still
  // wins either way, clamped to MAX_LIMIT.
  const offset = clampInt(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
  const effectiveDefault = debug.enabled ? DEFAULT_LIMIT_WHEN_DEBUG : DEFAULT_LIMIT;
  const limit = clampInt(args.limit, effectiveDefault, 1, MAX_LIMIT);

  // Session-scoped dedup: if the same (path, offset, limit) window
  // was read earlier in this skill run, return a short stub instead
  // of the full body. Prevents context bloat when the LLM repeats
  // the identical Read — the previous tool_result is still in its
  // history, so we tell it to use that.
  if (opts.sessionCache) {
    const key = readCacheKey(resolved, offset, limit);
    const hit = opts.sessionCache.check(key);
    if (hit) {
      const label = `Read ${resolved}${offset > 1 ? ` offset=${offset}` : ''}${limit !== effectiveDefault ? ` limit=${limit}` : ''}`;
      logDedupHit('tool.read', label, hit, {
        file: resolved, offset, limit,
        consecutive: opts.sessionCache.consecutiveHits,
      });

      // Runtime-level block: when the parent has made the IDENTICAL
      // Read call N times in a row (no other tool use in between),
      // the soft dedup stub isn't landing — see
      // log/debug-20260415151315.log for 12 back-to-back hits.
      // Throw so the caller's tool_result carries is_error=true; the
      // model sees this as a tool FAILURE (not a soft stub) and is
      // far more likely to change strategy.
      if (opts.sessionCache.consecutiveHits >= CONSECUTIVE_DEDUP_BLOCK_THRESHOLD) {
        debug.log('tool.read', 'consecutive-block', {
          file: resolved, offset, limit,
          consecutive: opts.sessionCache.consecutiveHits,
          threshold: CONSECUTIVE_DEDUP_BLOCK_THRESHOLD,
        });
        throw new Error(
          `RUNTIME BLOCKED — Read(${resolved}) has been called ` +
          `${opts.sessionCache.consecutiveHits} times in a row with no ` +
          `intervening tool use. The previous Read result is in your ` +
          `conversation history above — use it directly. If you need a ` +
          `DIFFERENT part of the file, change offset/limit. If you need ` +
          `to parse/filter, use Bash (grep/jq/python). Do NOT repeat this ` +
          `exact Read call. Next turn must emit text OR a different tool.`,
        );
      }

      const stub = dedupeStub(
        label,
        hit.hits,
        hit.firstSeenAt,
        `If you need a DIFFERENT part of this file, change offset/limit. ` +
        `If you need the content parsed/filtered, use Bash (grep, jq, python3) ` +
        `on the earlier result — don't re-Read.`,
      );
      return {
        output: stub,
        linesRead: 0,
        totalLines: 0,
        totalBytes: st.size,
        truncated: false,
        kind: 'text',
      };
    }
    opts.sessionCache.noteSeen(key, `Read ${resolved}`);
  }

  // Read entire file when small (<10MB) — fast path. Claude Code does
  // the same split.
  let allLines: string[];
  if (st.size < 10 * 1024 * 1024) {
    const buf = Buffer.alloc(st.size);
    const fd = openSync(resolved, 'r');
    try { readSync(fd, buf, 0, st.size, 0); } finally { closeSync(fd); }
    const text = stripBom(buf.toString('utf8').replace(/\r\n/g, '\n'));
    allLines = text.split('\n');
    // Strip trailing empty line from final \n — so a 3-line file
    // doesn't show as 4 lines.
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
  } else {
    allLines = await streamLines(resolved);
  }

  const totalLines = allLines.length;
  const startIdx = Math.max(0, offset - 1);
  const endIdx = Math.min(totalLines, startIdx + limit);
  const slice = allLines.slice(startIdx, endIdx);
  const truncated = endIdx < totalLines;

  const formatted = slice
    .map((ln, i) => {
      const n = String(startIdx + i + 1).padStart(LINE_NUMBER_WIDTH, ' ');
      const truncLine = ln.length > TRUNCATE_LINE_LEN
        ? ln.slice(0, TRUNCATE_LINE_LEN) + ` [... ${ln.length - TRUNCATE_LINE_LEN} more chars ...]`
        : ln;
      return `${n}\t${truncLine}`;
    })
    .join('\n');

  let footer = '';
  if (truncated) {
    footer = `\n\n[... ${totalLines - endIdx} more lines — call Read again with offset:${endIdx + 1} to continue ...]`;
  }

  debug.log('tool.read', 'served', {
    file: resolved,
    offset,
    limit,
    effectiveDefault,
    linesRead: slice.length,
    totalLines,
    truncated,
    totalBytes: st.size,
  });

  return {
    output: formatted + footer,
    linesRead: slice.length,
    totalLines,
    totalBytes: st.size,
    truncated,
    kind: 'text',
  };
}

// ── internals ──

/** Classify by extension — inexpensive and matches what users expect. */
function classify(path: string): ReadResult['kind'] {
  const ext = extname(path).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  // Well-known binary formats that should NOT be read as text.
  if (['.zip', '.tar', '.gz', '.bz2', '.xz', '.7z',
       '.exe', '.dll', '.so', '.dylib', '.o', '.a',
       '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac',
       '.db', '.sqlite', '.sqlite3'].includes(ext)) return 'binary';
  return 'text';
}

function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

/** Streaming read for files > 10MB — avoids loading the whole blob
 *  into memory when we may only want the first 2000 lines. */
async function streamLines(path: string): Promise<string[]> {
  return new Promise((resolveP, rejectP) => {
    const lines: string[] = [];
    let carry = '';
    const s = createReadStream(path, { encoding: 'utf8' });
    s.on('data', (chunk) => {
      const data = carry + chunk;
      const parts = data.split('\n');
      carry = parts.pop() ?? '';
      for (const p of parts) lines.push(p.replace(/\r$/, ''));
    });
    s.on('end', () => {
      if (carry) lines.push(carry.replace(/\r$/, ''));
      resolveP(lines);
    });
    s.on('error', rejectP);
  });
}
