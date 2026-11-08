import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Opportunistic followup §6.2 (tool.diff slot · 2026-05-13) — daemon-
// side Edit tool with `tool.diff` envelope emit. M4 PR 1 #2486 shipped
// `<DiffBlock>` with mock-test coverage; this is its first production
// caller.
//
// Scope vs dashboard's `src/code-edit/tools.ts`:
//   - dashboard Edit has approver gates, read-state invariants (must
//     Read before Edit), undo capture, and a sophisticated policy
//     framework — all dashboard-specific concerns.
//   - daemon Edit is narrower: same path-guard as Read/Grep (cwd
//     anchor + sensitive deny-list), pure-function edit application
//     (re-using `applyEditsInMemory` from the diff-compute helper),
//     and one fs.writeFile call. No approver — the caller (PWA chat
//     user) gates write-side access by opting into the `webterm`
//     surface explicitly, same model as WebTerminalInput.
//
// Surface placement: registered only on `webterm` (write-side gate
// matches the existing pattern). `readonly` stays Read+Grep+
// WebSearch+Plan+MarkStepDone.

import { promises as fsp } from 'fs';


import {
  applyEditsInMemory,
  computePatch,
} from '../../code-edit/diff-compute.js';
import type { StructuredPatchHunk } from '../../code-edit/types.js';
import {
  createSeqTracker,
  makeEnvelope,
  type DiffHunk,
  type DiffHunkLine,
  type FeedbackEnvelope,
} from '../../feedback/envelope.js';

import { debug } from '../../debug/log.js';
import { getSessionBoundary } from '../../session/working-dir.js';

import { resolveSafe } from './path-guard.js';
import { ToolSafetyError, type DaemonToolDispatchCtx } from './types.js';

export const EDIT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — parity with Read

export interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface EditArgs {
  file_path: string;
  edits: EditSpec[];
}

export interface EditResult {
  file_path: string;
  /** Number of substitutions applied across all edits. */
  applied: number;
  /** + line count across all hunks. */
  linesAdded: number;
  /** - line count across all hunks. */
  linesRemoved: number;
  /** Structured patch hunks (also fanned out via tool.diff envelope). */
  hunks: DiffHunk[];
}

export function buildEditTool(): LLMToolSpec {
  return {
    name: 'Edit',
    description:
      'Apply exact-string substitutions to a file under the daemon tool-cwd. ' +
      'Each edit pair must match unambiguously in the current file content; ' +
      'set replace_all:true for batch substitutions. The diff is emitted to ' +
      'the chat surface via a tool.diff envelope so the user sees the change ' +
      'inline. Refused on paths outside cwd, on credential/key deny-list ' +
      'paths, and on files larger than 10 MB. Webterm surface only.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or cwd-relative file path.',
        },
        edits: {
          type: 'array',
          description: 'One or more old_string → new_string substitutions, applied in order. First failure aborts the batch (no partial writes).',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact text to find.' },
              new_string: { type: 'string', description: 'Replacement text.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence (default false → exactly one match required).' },
            },
            required: ['old_string', 'new_string'],
          },
          minItems: 1,
        },
      },
      required: ['file_path', 'edits'],
    },
  };
}

export async function dispatchEdit(
  args: EditArgs,
  ctx: DaemonToolDispatchCtx,
): Promise<EditResult> {
  if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
    throw new ToolSafetyError('path-traversal', 'file_path is required');
  }
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    throw new ToolSafetyError('unavailable', 'edits must be a non-empty array');
  }
  for (let i = 0; i < args.edits.length; i++) {
    const e = args.edits[i]!;
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
      throw new ToolSafetyError(
        'unavailable',
        `edits[${i}]: old_string and new_string must be strings`,
      );
    }
  }
  const safe = resolveSafe(args.file_path, ctx.cwd);
  const stat = await fsp.stat(safe);
  if (!stat.isFile()) {
    throw new ToolSafetyError('path-traversal', `${args.file_path} is not a regular file`);
  }
  if (stat.size > EDIT_MAX_BYTES) {
    throw new ToolSafetyError('too-large', `${args.file_path} exceeds ${EDIT_MAX_BYTES} bytes`);
  }
  const before = await fsp.readFile(safe, 'utf8');
  const applied = applyEditsInMemory(before, args.edits);
  if ('ok' in applied && applied.ok === false) {
    throw new ToolSafetyError('unavailable', `Edit failed: ${applied.message}`);
  }
  if (!('newContent' in applied)) {
    throw new ToolSafetyError('unavailable', 'Edit failed: unexpected diff-compute result');
  }
  const structured = computePatch(safe, before, applied.newContent);
  const hunks = structured.map(toEnvelopeHunk);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add') linesAdded++;
      else if (l.kind === 'del') linesRemoved++;
    }
  }
  await fsp.writeFile(safe, applied.newContent, 'utf8');
  logUnboundedDaemonWrite('edit', safe, ctx);
  emitDiff(ctx, safe, hunks);
  return {
    file_path: safe,
    applied: applied.applied,
    linesAdded,
    linesRemoved,
    hunks,
  };
}

/**
 * 데몬의 «직접» 쓰기가 사람의 살아 있는 체크아웃에 닿았다는 사실을 남긴다.
 *
 * ⛔⭐ 가드가 `try` **안**에 있다 — 무인 리뷰 should-fix ③(2026-08-05).
 *   `getSessionBoundary()` 조회도 «관측 코드의 일부»다. 그것이 던지면 **이미 끝난 쓰기의
 *   결과가 바뀐다.** 초판은 그 한 줄만 `try` 밖에 둬서 ***아래 주석이 선언한 fail-soft 계약을
 *   가드 자신이 깼다.***
 */
function logUnboundedDaemonWrite(
  tool: 'edit',
  path: string,
  ctx: DaemonToolDispatchCtx,
): void {
  try {
    if (getSessionBoundary() !== null) return;
    debug.log('harness.boundary', 'live-checkout-write', {
      via: `daemon-${tool}`,
      path,
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
    });
  } catch { /* fail-soft observability must not alter a completed write */ }
}

function toEnvelopeHunk(h: StructuredPatchHunk): DiffHunk {
  const lines: DiffHunkLine[] = h.lines.map((raw) => {
    if (raw.startsWith('+')) return { kind: 'add', text: raw.slice(1) };
    if (raw.startsWith('-')) return { kind: 'del', text: raw.slice(1) };
    // ' ' or '\\' (no-newline marker) — treat as context for the
    // renderer (`<DiffBlock>` collapses ctx visually).
    return { kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw };
  });
  return {
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines,
  };
}

function emitDiff(
  ctx: DaemonToolDispatchCtx,
  filePath: string,
  hunks: DiffHunk[],
): void {
  if (!ctx.emitFeedback || !ctx.sessionId) return;
  const blockId = `${ctx.sessionId}:edit:${ctx.toolCallId ?? Date.now().toString(36)}`;
  let env: FeedbackEnvelope;
  try {
    env = makeEnvelope(
      {
        kind: 'tool.diff',
        sessionId: ctx.sessionId,
        blockId,
        phase: 'end',
        payload: {
          filePath,
          ...(guessLanguage(filePath) ? { language: guessLanguage(filePath)! } : {}),
          hunks,
        },
        asciiFallback: hunksToAscii(filePath, hunks),
        ...(ctx.toolCallId ? { parentToolCallId: ctx.toolCallId } : {}),
      },
      createSeqTracker(),
    );
  } catch {
    return;
  }
  try {
    ctx.emitFeedback(env);
  } catch {
    /* wire glue swallows — emit must not break the LLM turn */
  }
}

function hunksToAscii(filePath: string, hunks: DiffHunk[]): string[] {
  const out: string[] = [`✎ Edit ${filePath}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      const prefix = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      out.push(`${prefix}${l.text}`);
    }
  }
  return out;
}

/** Minimal language hint for `<DiffBlock>` syntax-highlight — extends
 *  as needed. Avoids pulling in shiki's full extension map. */
function guessLanguage(filePath: string): string | undefined {
  const idx = filePath.lastIndexOf('.');
  if (idx < 0) return undefined;
  const ext = filePath.slice(idx + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    css: 'css',
    html: 'html',
  };
  return map[ext];
}
