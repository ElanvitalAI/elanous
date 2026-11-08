import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── file_write tool (explicit create / overwrite) ──
//
// Ports claude-code-fork's FileWriteTool. Use when the LLM wants to
// create a new file OR fully rewrite an existing one. Until now
// skills relied on `Bash cat <<EOF > path` for this — opaque, no
// permission hook, no diff preview. Having a dedicated tool lets
// the log pane show "⏺ Write(path) — N bytes" and future permission
// gating gets ONE place to intercept destructive writes.
//
// Contract (matches claude-code semantics):
//   • file_path: absolute or relative path. Parent directories are
//     created on demand (mkdir -p) so the tool doesn't fail when
//     the caller didn't pre-create them.
//   • content: string body. No binary support — callers needing that
//     should still use Bash.
//   • Default is "refuse to overwrite existing files" UNLESS the
//     caller passes overwrite=true. Matches the spirit of Edit
//     (which fails loudly rather than silently destroying state).
//   • Returns a summary string shaped like Edit/Grep:
//     "Wrote 123 bytes to /abs/path (new file)"
//     "Wrote 456 bytes to /abs/path (overwritten, was 789 bytes)"
//
// Safety: MUTATING + NOT parallel-safe. Two concurrent writes to the
// same path would race, and even distinct paths can race through
// parent-dir creation. Keep supportsParallel=false in the catalog.

import { writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePathWithPolicy, type PathPolicy } from '../../agent/path-policy.js';

import { getSessionBoundary, getSessionCwd, isWriteAllowedInBoundary } from '../../session/working-dir.js';
import { harnessMainTreeReject } from '../../harness/harness-write-boundary.js';

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;  // 10 MB — anything larger
                                             // is likely a mistake. Bash
                                             // can handle true binary.

export interface WriteArgs {
  file_path: string;
  content: string;
  overwrite?: boolean;
}

export interface WriteResult {
  output: string;
  path: string;
  bytesWritten: number;
  /** Present when we overwrote a file; bytes of the previous
   *  contents. Absent for new files. Lets callers show a diff-size
   *  preview in the log pane. */
  overwrittenBytes?: number;
  created: boolean;  // true when file didn't exist before
}

export function buildWriteTool(): LLMToolSpec {
  return {
    name: 'Write',
    description:
      'Create a new file or fully overwrite an existing one. Parent dirs are created ' +
      'on demand. Existing files are NOT overwritten unless overwrite=true (guards ' +
      'against silent clobber). Prefer Edit for partial changes — use Write only ' +
      'when the whole file is being replaced / is new.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path. Parent directories will be created on demand.' },
        content: { type: 'string', description: 'File body. UTF-8 string.' },
        overwrite: { type: 'boolean', description: 'Allow overwriting an existing file. Default false (throws if path exists).' },
      },
      required: ['file_path', 'content'],
    },
  };
}

export async function dispatchWrite(
  args: Record<string, unknown>,
  opts: { pathPolicy?: PathPolicy } = {},
): Promise<WriteResult> {
  const raw = String(args.file_path ?? '').trim();
  if (!raw) throw new Error('file_path is required');
  // `content` is required but may legitimately be empty (e.g., touch
  // a placeholder). Don't throw on "".
  if (typeof args.content !== 'string') {
    throw new Error('content must be a string');
  }
  const content = args.content;
  const overwrite = !!args.overwrite;
  // WD6 — relative paths resolve against the session working dir.
  // ★ Phase 4b(2026-07-22) — 경로 해석+보안 단일 정책. permissive(기본)=현행(relative→sessionCwd,
  //   무제한) + `~` 확장 획득(read/edit 와 일관성·종전 write 만 ~ 미확장이던 것 통일). 서피스가
  //   opts.pathPolicy 로 strict/anchored 조이면 cwd-앵커(+deny-list) 강제 — telegram/discord=strict.
  const policy = opts.pathPolicy ?? 'permissive';
  const abs = resolvePathWithPolicy(raw, getSessionCwd(), policy);
  const boundary = getSessionBoundary();
  if (boundary !== null && !isWriteAllowedInBoundary(abs)) {
    throw new Error(`Write: isolated write boundary rejected ${abs}; boundary is ${boundary}`);
  }
  if (boundary === null) {
    const harnessReject = harnessMainTreeReject(abs, process.env, getSessionCwd(), 'skills-write');
    if (harnessReject) throw new Error(harnessReject);
  }

  if (content.length > MAX_CONTENT_BYTES) {
    throw new Error(`content exceeds ${MAX_CONTENT_BYTES} byte cap (${content.length} bytes). Use Bash for huge / binary writes.`);
  }

  let existed = false;
  let overwrittenBytes: number | undefined;
  try {
    const st = statSync(abs);
    existed = true;
    overwrittenBytes = st.size;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      // Permission / path-type errors — surface them instead of
      // silently creating the file.
      throw new Error(`stat failed for ${abs}: ${err?.message ?? err}`);
    }
  }

  if (existed && !overwrite) {
    throw new Error(`refusing to overwrite existing ${abs} (pass overwrite=true to force; was ${overwrittenBytes} bytes)`);
  }

  // Ensure parent dir exists. recursive: true makes this idempotent.
  try {
    mkdirSync(dirname(abs), { recursive: true });
  } catch (err: any) {
    throw new Error(`mkdir parent failed for ${abs}: ${err?.message ?? err}`);
  }

  try {
    writeFileSync(abs, content, 'utf8');
  } catch (err: any) {
    throw new Error(`write failed for ${abs}: ${err?.message ?? err}`);
  }

  const bytesWritten = Buffer.byteLength(content, 'utf8');
  const output = existed
    ? `Wrote ${bytesWritten} bytes to ${abs} (overwritten, was ${overwrittenBytes} bytes)`
    : `Wrote ${bytesWritten} bytes to ${abs} (new file)`;

  return {
    output,
    path: abs,
    bytesWritten,
    ...(overwrittenBytes !== undefined ? { overwrittenBytes } : {}),
    created: !existed,
  };
}
