import type { LLMToolSpec } from '../../llm/tool-spec.js';
// MVP M1.5 A.2 — Grep tool (daemon side).
//
// LLM-facing primitive that runs a regex search across the daemon's
// tool-cwd via the `rg` (ripgrep) CLI. Caps:
//   - 30 s timeout
//   - 1 000 results max (per --max-count)
//   - 5 MB per file (rg --max-filesize)
//   - cwd-anchored (path-guard.ts)
//
// Implementation note: we shell out to `rg --json` rather than
// rolling a JS regex walker — ripgrep is dramatically faster on
// large trees, has gitignore semantics, and is already a project
// development dependency (see CLAUDE.md instrumentation guidance).

import { spawn } from 'node:child_process';


import {
  createSeqTracker,
  makeEnvelope,
  type FeedbackEnvelope,
} from '../../feedback/envelope.js';

import { resolveSafe } from './path-guard.js';
import { parseRgJsonMatchLine } from '../../tool-runtime/ripgrep-core.js';
import { ToolSafetyError, type DaemonToolDispatchCtx } from './types.js';
import { debug } from '../../debug/log.js';

/** M5 PR 2 — emit a coalesced `tool.search-hit` envelope every N hits
 *  during a streaming grep dispatch, plus a phase=end envelope on
 *  close. PWA's `<SearchHitList>` collapses these into one card
 *  (blockId merge), so the UI is identical whether the server sends
 *  one envelope per hit or 50. Default coalesce = 5 keeps the wire
 *  light without sacrificing visible progressiveness. */
const SEARCH_HIT_COALESCE = 5;

export const GREP_TIMEOUT_MS = 30_000;
export const GREP_MAX_RESULTS = 1000;

export interface GrepArgs {
  pattern: string;
  /** Search root, cwd-relative or absolute. Defaults to ctx.cwd. */
  path?: string;
  max_results?: number;
  case_insensitive?: boolean;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  /** Roots actually searched. Useful for the caller to confirm
   *  what was scanned when the LLM asked for a wide search. */
  searchRoot: string;
}

export function buildGrepTool(): LLMToolSpec {
  return {
    name: 'Grep',
    description:
      'Search files under the daemon\'s tool-cwd for a regex pattern (ripgrep ' +
      'semantics). Capped at 1000 matches, 30s timeout, 5 MB per file. Respects ' +
      '.gitignore. Path arg restricts search to a sub-tree (must stay within cwd).',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern (ripgrep / Rust-regex syntax).',
        },
        path: {
          type: 'string',
          description: 'Optional sub-tree to search within. Defaults to the daemon\'s tool-cwd.',
        },
        max_results: {
          type: 'number',
          description: `Max matches to return. Default + cap = ${GREP_MAX_RESULTS}.`,
        },
        case_insensitive: {
          type: 'boolean',
          description: 'When true, pass `-i` to ripgrep. Default false (smart-case via -S).',
        },
      },
      required: ['pattern'],
    },
  };
}

export async function dispatchGrep(
  args: GrepArgs,
  ctx: DaemonToolDispatchCtx,
): Promise<GrepResult> {
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
    throw new ToolSafetyError('path-traversal', 'pattern is required');
  }
  const root = args.path ? resolveSafe(args.path, ctx.cwd) : ctx.cwd;
  // 제1원칙 관측 — 무엇을·어디서 검색했나(external=cwd 밖 트리).
  try {
    debug.log('agent.source', 'grep', {
      pattern: args.pattern, root, external: !root.startsWith(ctx.cwd),
      ...(ctx.sessionId ? { session: ctx.sessionId } : {}),
    });
  } catch { /* fail-open */ }
  const max = Math.max(1, Math.min(args.max_results ?? GREP_MAX_RESULTS, GREP_MAX_RESULTS));

  // M5 PR 2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
  // optional FeedbackEnvelope emit. emitFeedback is opt-in via ctx;
  // when absent the runtime path stays unchanged. blockId stays
  // stable across all emits for this dispatch so PWA's
  // <SearchHitList> collapses delta + end into one card.
  const emitEnabled = !!(ctx.emitFeedback && ctx.sessionId);
  const seqTracker = emitEnabled ? createSeqTracker() : null;
  const grepBlockId = emitEnabled
    ? `${ctx.sessionId}:grep:${ctx.toolCallId ?? Date.now().toString(36)}`
    : '';
  let lastEmitCount = 0;
  const emitHits = (
    phase: 'start' | 'delta' | 'end',
    matchesSoFar: readonly GrepMatch[],
    finalTruncated: boolean,
  ): void => {
    if (!emitEnabled || !ctx.emitFeedback || !seqTracker) return;
    const hits = matchesSoFar.map((m) => ({
      filePath: m.path,
      line: m.line,
      snippet: m.text,
    }));
    let env: FeedbackEnvelope;
    try {
      env = makeEnvelope(
        {
          kind: 'tool.search-hit',
          sessionId: ctx.sessionId!,
          blockId: grepBlockId,
          phase,
          payload: {
            query: args.pattern,
            hits,
            accumCount: matchesSoFar.length,
            ...(finalTruncated ? { truncated: true } : {}),
          },
          asciiFallback: hits.slice(-3).map((h) => `${h.filePath}:${h.line}  ${h.snippet}`),
          ...(ctx.toolCallId ? { parentToolCallId: ctx.toolCallId } : {}),
        },
        seqTracker,
      );
    } catch {
      return;
    }
    try { ctx.emitFeedback(env); }
    catch { /* upstream wraps in try/catch; defensive guard */ }
  };

  if (emitEnabled) emitHits('start', [], false);

  const flags: string[] = [
    '--json',
    '--no-config',
    '--no-messages',
    '--max-filesize', '5M',
    '-m', String(max),
  ];
  if (args.case_insensitive) flags.push('-i');
  else flags.push('-S');
  flags.push('--', args.pattern, root);

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), GREP_TIMEOUT_MS);
  // Compose caller signal + timeout into a single abort source.
  const composite = new AbortController();
  const onCallerAbort = (): void => composite.abort();
  const onTimeoutAbort = (): void => composite.abort();
  ctx.signal.addEventListener('abort', onCallerAbort, { once: true });
  timeoutCtrl.signal.addEventListener('abort', onTimeoutAbort, { once: true });
  if (ctx.signal.aborted) composite.abort();

  return new Promise<GrepResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('rg', flags, { signal: composite.signal });
    } catch (err) {
      clearTimeout(timer);
      reject(new ToolSafetyError('unavailable', `ripgrep spawn failed: ${(err as Error).message}`));
      return;
    }

    const matches: GrepMatch[] = [];
    let buffer = '';
    let truncated = false;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        // 공유 ripgrep-core 파서(per-line) — streaming/emit/abort 는 데몬 정책으로 유지.
        const m = parseRgJsonMatchLine(line, { pathFallback: '?' });
        if (m) {
          if (matches.length < max) {
            matches.push(m);
            // M5 PR 2 — coalesced delta emit. Fire after every N new
            // matches accumulate (default 5) so the user sees hits land
            // in chunks instead of one mega-blob at end.
            if (
              emitEnabled &&
              matches.length - lastEmitCount >= SEARCH_HIT_COALESCE
            ) {
              emitHits('delta', matches, false);
              lastEmitCount = matches.length;
            }
          } else {
            truncated = true;
          }
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ToolSafetyError('unavailable', `ripgrep error: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onCallerAbort);
      timeoutCtrl.signal.removeEventListener('abort', onTimeoutAbort);
      if (timeoutCtrl.signal.aborted) {
        reject(new ToolSafetyError('timeout', `grep exceeded ${GREP_TIMEOUT_MS}ms`));
        return;
      }
      if (ctx.signal.aborted) {
        reject(new ToolSafetyError('timeout', 'grep aborted by caller'));
        return;
      }
      // rg exits 1 when no matches found — that's a normal result.
      if (code !== 0 && code !== 1 && code !== null) {
        reject(new Error(`ripgrep exit ${code}`));
        return;
      }
      // M5 PR 2 — final envelope with truncated flag carries the
      // server-side cap signal to PWA. blockId is the same, so the
      // accumulator merges the final state in place.
      if (emitEnabled) emitHits('end', matches, truncated);
      resolve({ matches, truncated, searchRoot: root });
    });
  });
}
