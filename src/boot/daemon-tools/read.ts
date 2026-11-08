import type { LLMToolSpec } from '../../llm/tool-spec.js';
// MVP M1.5 A.2 — Read tool (daemon side).
//
// LLM-facing primitive that returns the contents of a single file.
// Hard caps:
//   - 10 MB max bytes (truncate above; first 10 MB only)
//   - binary detection → refuse (no point shipping bytes to an LLM)
//   - cwd-anchored + sensitive deny-list (see path-guard.ts)
//
// Mirrors the dashboard's existing `Read` skill in spirit, but lives
// in the daemon's narrow tool surface so a remote-attached TUI / PWA
// / Telegram client gets the same primitive without dragging in the
// dashboard's full skill catalog.
//
// Rich-feedback opportunistic followup (PLAN-rich-dev-feedback-multi-
// surface · 2026-05-13 §6.2 #1) — when the caller wires
// `ctx.emitFeedback` AND the target file is large (≥ 1 MB), dispatch
// branches into a chunked-read path that emits `tool.progress`
// envelopes (phase=start/delta/end) so PWA `<ToolProgressCard>`
// pulses bytes-so-far while the read completes. Small reads stay on
// the sync fast path — envelope chatter on every <1 MB file would
// flood the wire without UX win.

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';


import {
  createSeqTracker,
  makeEnvelope,
  type FeedbackEnvelope,
} from '../../feedback/envelope.js';

import { isBinary, resolveSafe } from './path-guard.js';
import { ToolSafetyError, type DaemonToolDispatchCtx } from './types.js';
import { debug } from '../../debug/log.js';
import { resolveReadPathArg, READ_PATH_SCHEMA_PROPS } from '../../agent/read-args.js';

export const READ_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/** Files below this size skip progressive emit even when
 *  `ctx.emitFeedback` is wired — a sub-millisecond sync read sending
 *  start+end envelopes would be noise without UX value. Above this,
 *  dispatchRead chunks the read so the user sees byte progress. */
export const READ_PROGRESS_THRESHOLD_BYTES = 1 * 1024 * 1024;

/** Chunk size for the progressive path. Tuned for the typical PWA
 *  SSE wire: a 5 MB file lands ~20 emits with this chunk size, which
 *  feels live without flooding the network. Also the binary-detection
 *  sniffer (`isBinary`) inspects the first 8 KB — one chunk is enough
 *  for the early bail. */
export const READ_CHUNK_BYTES = 256 * 1024;

export interface ReadArgs {
  /** Canonical file-path arg (aligned with daemon Edit/Write · Phase 4a). */
  file_path?: string;
  /** Legacy alias — accepted for backward compat. */
  path?: string;
}

export interface ReadResult {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

export function buildReadTool(): LLMToolSpec {
  return {
    name: 'Read',
    description:
      'Read a single file from the daemon machine, returning its UTF-8 contents. ' +
      'Path is resolved relative to the daemon\'s tool-cwd. Paths escaping that ' +
      'cwd, paths matching credential / key deny-list patterns (.ssh/, .env, *.pem, ' +
      'id_rsa, etc.), and binary files are refused. Files larger than 10 MB return ' +
      'the first 10 MB with `truncated: true`.',
    parameters: {
      type: 'object',
      // ★ Phase 4a(2026-07-22) — file_path canonical(+path 레거시 별칭). daemon Edit/Write 의
      //   file_path 와 정합·모델의 Claude-Code 표준 file_path 거부 버그 제거. resolveReadPathArg 공유.
      properties: { ...READ_PATH_SCHEMA_PROPS },
      required: ['file_path'],
    },
  };
}

export async function dispatchRead(
  args: ReadArgs,
  ctx: DaemonToolDispatchCtx,
): Promise<ReadResult> {
  // file_path(canonical) ?? path(레거시) — 단일 출처 리졸버(Phase 4a). 어느 이름으로 와도 수용.
  const inputPath = resolveReadPathArg(args as Record<string, unknown>);
  if (!inputPath) {
    throw new ToolSafetyError('path-traversal', 'file_path (or legacy path) arg must be a non-empty string');
  }
  const safe = resolveSafe(inputPath, ctx.cwd);
  const stat = statSync(safe);
  if (!stat.isFile()) {
    throw new ToolSafetyError('path-traversal', `${inputPath} is not a regular file`);
  }
  // 제1원칙 관측 — 어떤 소스를 열람했나(로컬 vs 외부 트리 구분). external=cwd 밖
  // (예: ~/source/ref) → "canonical 로컬 소스 대신 우회했나" 를 elanous logs 로 판별.
  try {
    debug.log('agent.source', 'read', {
      path: inputPath, resolved: safe, bytes: stat.size,
      external: !safe.startsWith(ctx.cwd),
      ...(ctx.sessionId ? { session: ctx.sessionId } : {}),
    });
  } catch { /* fail-open */ }
  const emitEnabled =
    !!(ctx.emitFeedback && ctx.sessionId)
    && stat.size >= READ_PROGRESS_THRESHOLD_BYTES;
  if (!emitEnabled) {
    return dispatchReadSync(safe, stat.size, inputPath);
  }
  return dispatchReadProgressive(safe, stat.size, inputPath, ctx);
}

function dispatchReadSync(safe: string, size: number, origPath: string): ReadResult {
  if (size > READ_MAX_BYTES) {
    const fd = openSync(safe, 'r');
    try {
      const buf = Buffer.alloc(READ_MAX_BYTES);
      readSync(fd, buf, 0, READ_MAX_BYTES, 0);
      if (isBinary(buf)) {
        throw new ToolSafetyError('binary', `${origPath} appears to be a binary file`);
      }
      return {
        path: safe,
        content: buf.toString('utf8'),
        size,
        truncated: true,
      };
    } finally {
      closeSync(fd);
    }
  }
  const buf = readFileSync(safe);
  if (isBinary(buf)) {
    throw new ToolSafetyError('binary', `${origPath} appears to be a binary file`);
  }
  return {
    path: safe,
    content: buf.toString('utf8'),
    size,
    truncated: false,
  };
}

async function dispatchReadProgressive(
  safe: string,
  totalSize: number,
  origPath: string,
  ctx: DaemonToolDispatchCtx,
): Promise<ReadResult> {
  const seqTracker = createSeqTracker();
  const blockId = `${ctx.sessionId}:read:${ctx.toolCallId ?? Date.now().toString(36)}`;
  const targetBytes = Math.min(totalSize, READ_MAX_BYTES);
  const truncated = totalSize > READ_MAX_BYTES;

  const emitPhase = (
    phase: 'start' | 'delta' | 'end',
    bytesSoFar: number,
    lines: string[],
    exitCode?: number,
  ): void => {
    if (!ctx.emitFeedback) return;
    let env: FeedbackEnvelope;
    try {
      env = makeEnvelope(
        {
          kind: 'tool.progress',
          sessionId: ctx.sessionId!,
          blockId,
          phase,
          payload: {
            stream: 'generic',
            lines,
            bytesSoFar,
            ...(exitCode !== undefined ? { exitCode } : {}),
          },
          asciiFallback: lines,
          ...(ctx.toolCallId ? { parentToolCallId: ctx.toolCallId } : {}),
        },
        seqTracker,
      );
    } catch {
      return;
    }
    try {
      ctx.emitFeedback(env);
    } catch {
      /* wire glue swallows — bridge must not break the LLM turn */
    }
  };

  emitPhase('start', 0, [`📖 Reading ${origPath} (${formatBytes(totalSize)})`]);

  const fd = openSync(safe, 'r');
  try {
    const buf = Buffer.alloc(targetBytes);
    let offset = 0;
    let binaryChecked = false;
    while (offset < targetBytes) {
      if (ctx.signal.aborted) {
        emitPhase('end', offset, ['✗ read aborted by caller'], 1);
        throw new ToolSafetyError('timeout', 'read aborted by caller');
      }
      const want = Math.min(READ_CHUNK_BYTES, targetBytes - offset);
      const got = readSync(fd, buf, offset, want, offset);
      if (got === 0) break;
      offset += got;
      // Early binary bail after the first chunk — `isBinary` only
      // inspects the first 8 KB so there's no need to keep reading
      // multi-MB binary blobs just to refuse them at the end.
      if (!binaryChecked && offset >= Math.min(8192, targetBytes)) {
        binaryChecked = true;
        if (isBinary(buf.subarray(0, offset))) {
          emitPhase('end', offset, [`✗ binary file refused`], 1);
          throw new ToolSafetyError('binary', `${origPath} appears to be a binary file`);
        }
      }
      // Emit one delta per chunk. The last chunk (offset === targetBytes)
      // is collapsed into the phase=end envelope below — no need for an
      // extra delta right before end.
      if (offset < targetBytes) {
        emitPhase('delta', offset, []);
      }
    }
    emitPhase(
      'end',
      offset,
      [
        truncated
          ? `✓ Read ${formatBytes(offset)} of ${formatBytes(totalSize)} (truncated)`
          : `✓ Read ${formatBytes(offset)}`,
      ],
      0,
    );
    return {
      path: safe,
      content: buf.subarray(0, offset).toString('utf8'),
      size: totalSize,
      truncated,
    };
  } finally {
    closeSync(fd);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
