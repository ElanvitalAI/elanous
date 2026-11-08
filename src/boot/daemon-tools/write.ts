import type { LLMToolSpec } from '../../llm/tool-spec.js';
// PLAN-ios-rich-dev-feedback-hydrate followup (2026-05-13) — Write tool
// alongside Edit. Edit 는 *기존* 파일의 exact-substring 치환만 지원하므로
// LLM 이 새 파일 생성 시 Bash 로 우회 → daemon Bash 는 envelope 미발화 →
// iOS chat 에 tool.diff 가 안 보임. Write 가 그 격차 해소.
//
// Scope vs Edit:
//   - Edit: 기존 파일의 exact-substring 치환 (시멘틱 유지).
//   - Write: 새 파일 OR 기존 파일 완전 덮어쓰기. 단 cwd 가드 + 10MB
//            limit + sensitive 디렉토리 deny-list 동일 적용.
//
// `tool.diff` envelope emit:
//   - 새 파일: 모든 라인 'add' (oldStart=0, oldLines=0)
//   - overwrite: 기존 컨텐츠와 신규 컨텐츠 사이의 unified diff hunks
//
// 본 tool 은 'webterm' surface 에만 등록 (Edit 와 같은 write-side gate).

import { promises as fsp } from 'fs';


import { computePatch } from '../../code-edit/diff-compute.js';
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

export const WRITE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB · parity with Edit/Read

export interface WriteArgs {
  file_path: string;
  content: string;
}

export interface WriteResult {
  file_path: string;
  /** Whether the file already existed (true = overwrite). */
  overwrote: boolean;
  /** + line count across all hunks (entire file for new files). */
  linesAdded: number;
  /** - line count across all hunks (0 for new files). */
  linesRemoved: number;
  hunks: DiffHunk[];
}

export function buildWriteTool(): LLMToolSpec {
  return {
    name: 'Write',
    description:
      'Create a new file OR fully overwrite an existing file. Path is anchored under the daemon tool-cwd ' +
      '(same guard as Edit/Read) — paths outside cwd, sensitive deny-list paths, and content > 10 MB are refused. ' +
      'Emits a tool.diff envelope so the chat surface shows the new content inline. For incremental edits to ' +
      'an existing file, prefer the Edit tool (smaller diff payload). Webterm surface only.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or cwd-relative target path. Parent directories must already exist.',
        },
        content: {
          type: 'string',
          description: 'Full UTF-8 content of the file. Trailing newline preservation is up to the caller.',
        },
      },
      required: ['file_path', 'content'],
    },
  };
}

export async function dispatchWrite(
  args: WriteArgs,
  ctx: DaemonToolDispatchCtx,
): Promise<WriteResult> {
  if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
    throw new ToolSafetyError('path-traversal', 'file_path is required');
  }
  if (typeof args.content !== 'string') {
    throw new ToolSafetyError('unavailable', 'content must be a string');
  }
  if (Buffer.byteLength(args.content, 'utf8') > WRITE_MAX_BYTES) {
    throw new ToolSafetyError('too-large', `content exceeds ${WRITE_MAX_BYTES} bytes`);
  }
  const safe = resolveSafe(args.file_path, ctx.cwd);
  let before = '';
  let overwrote = false;
  try {
    const stat = await fsp.stat(safe);
    if (!stat.isFile()) {
      throw new ToolSafetyError('path-traversal', `${args.file_path} exists and is not a regular file`);
    }
    if (stat.size > WRITE_MAX_BYTES) {
      throw new ToolSafetyError('too-large', `${args.file_path} exceeds ${WRITE_MAX_BYTES} bytes`);
    }
    before = await fsp.readFile(safe, 'utf8');
    overwrote = true;
  } catch (err) {
    // ENOENT = new file. Any other stat/read error rethrow.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      before = '';
    } else if (err instanceof ToolSafetyError) {
      throw err;
    } else {
      throw new ToolSafetyError('unavailable', `stat failed: ${(err as Error).message}`);
    }
  }
  await fsp.writeFile(safe, args.content, 'utf8');
  logUnboundedDaemonWrite('write', safe, ctx);
  const structured = computePatch(safe, before, args.content);
  const hunks = structured.map(toEnvelopeHunk);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add') linesAdded++;
      else if (l.kind === 'del') linesRemoved++;
    }
  }
  emitDiff(ctx, safe, hunks);
  return { file_path: safe, overwrote, linesAdded, linesRemoved, hunks };
}

/**
 * 데몬의 «직접» 쓰기가 사람의 살아 있는 체크아웃에 닿았다는 사실을 남긴다.
 *
 * ⛔⭐ 가드가 `try` **안**에 있다 — `edit.ts` 의 짝과 같은 이유(무인 리뷰 should-fix ③).
 *   조회 자체가 관측 코드이므로 그것이 던지면 «이미 끝난 쓰기»의 결과가 바뀐다.
 */
function logUnboundedDaemonWrite(
  tool: 'write',
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
  const blockId = `${ctx.sessionId}:write:${ctx.toolCallId ?? Date.now().toString(36)}`;
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
    /* swallow */
  }
}

function hunksToAscii(filePath: string, hunks: DiffHunk[]): string[] {
  const out: string[] = [`✎ Write ${filePath}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      const prefix = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      out.push(`${prefix}${l.text}`);
    }
  }
  return out;
}

function guessLanguage(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': return 'typescript';
    case 'js': case 'jsx': return 'javascript';
    case 'py': return 'python';
    case 'swift': return 'swift';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'sh': case 'bash': return 'bash';
    case 'md': return 'markdown';
    case 'json': return 'json';
    case 'yaml': case 'yml': return 'yaml';
    case 'html': return 'html';
    case 'css': return 'css';
    default: return undefined;
  }
}
