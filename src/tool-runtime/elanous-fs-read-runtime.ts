import type { LLMToolSpec } from '../llm/tool-spec.js';
// PLAN-codex-app-server-hermes-parity §5 Phase H1·5e (2026-05-16) —
// `elanous_fs_read` MCP tool. Mirrors the daemon-side ACP method
// `elanous/fs/read` (src/acp/server.ts:2015). Session-agnostic so the
// codex app-server can call it via the elanous-tools MCP server without
// first opening an ACP session.
//
// Reads at most `maxBytes` of a file (default 256 KB · cap 8 MB) and
// branches the payload by mime — text/* and application/json return
// `content` (utf8 string); everything else returns `bytes` (base64).
// Partial reads set `truncated: true` so callers can render a "first
// 256 KB shown" banner without choking the wire.

import { open, stat as fsStat } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import {
  resolveFsRoot,
  clampToRoot,
  type FsRootKind,
} from '../acp/fs-roots.js';
import { detectMime, isTextMime } from '../acp/fs-mime.js';

import type { ToolRuntime } from './types.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
const ABSOLUTE_MAX_BYTES = 8 * 1024 * 1024;

export interface ElanousFsReadArgs {
  /** Root anchor. `'cwd'` (default) or `'obsidian'`. */
  root?: 'cwd' | 'obsidian';
  /** Path under the chosen root (relative or absolute). Required. */
  path?: string;
  /** Byte cap (1..8388608 · default 262144 = 256 KB). */
  maxBytes?: number;
}

export interface ElanousFsReadResult extends Record<string, unknown> {
  output: string;
  path: string;
  root: 'cwd' | 'obsidian';
  mime?: string;
  /** UTF-8 content for text mimes. */
  content?: string;
  /** Base64-encoded bytes for binary mimes. */
  bytes?: string;
  /** Full file size in bytes (not the read length). */
  size?: number;
  /** `true` when `size > maxBytes` and only the first `maxBytes` were read. */
  truncated?: boolean;
  error?: string;
}

export function buildElanousFsReadTool(): LLMToolSpec {
  return {
    name: 'elanous_fs_read',
    description:
      'Read a single file clamped to either the daemon cwd or the Obsidian vault. Text mimes return `content` (utf8); binary mimes return `bytes` (base64). 256KB default cap, 8MB hard ceiling. Codex app-server callback via the elanous-tools MCP server. Read-only.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        root: {
          type: 'string',
          enum: ['cwd', 'obsidian'],
          description: "Root anchor. 'cwd' = daemon working dir (default), 'obsidian' = vault.",
        },
        path: {
          type: 'string',
          description: 'Path to the file (relative or absolute · clamped to the chosen root).',
        },
        maxBytes: {
          type: 'integer',
          description: 'Byte cap (1..8388608 · default 262144).',
          minimum: 1,
          maximum: ABSOLUTE_MAX_BYTES,
        },
      },
      additionalProperties: false,
    },
  };
}

/** `opts.rootResolver` lets tests inject a custom path resolver so
 *  vault resolution doesn't depend on the host's real ~/.elanous state. */
export async function dispatchElanousFsRead(
  args: ElanousFsReadArgs = {},
  opts: { rootResolver?: (kind: FsRootKind) => string } = {},
): Promise<ElanousFsReadResult> {
  const root: FsRootKind = args.root === 'obsidian' ? 'obsidian' : 'cwd';
  if (typeof args.path !== 'string' || args.path.length === 0) {
    return {
      output: '(path required)',
      path: '',
      root,
      error: 'path-required',
    };
  }
  const resolver = opts.rootResolver ?? resolveFsRoot;
  let baseRoot: string;
  try {
    baseRoot = resolver(root);
  } catch (e) {
    return {
      output: `(failed to resolve root '${root}')`,
      path: args.path,
      root,
      error: String(e instanceof Error ? e.message : e),
    };
  }
  const resolved = clampToRoot(baseRoot, args.path);
  if (resolved == null) {
    return {
      output: '(path escapes root)',
      path: args.path,
      root,
      error: 'path-escapes-root',
    };
  }
  const maxBytes =
    typeof args.maxBytes === 'number' &&
    args.maxBytes > 0 &&
    args.maxBytes <= ABSOLUTE_MAX_BYTES
      ? Math.floor(args.maxBytes)
      : DEFAULT_MAX_BYTES;
  try {
    const stat = await fsStat(resolved);
    if (stat.isDirectory()) {
      return {
        output: `(${resolved} is a directory)`,
        path: resolved,
        root,
        error: 'path-is-directory',
      };
    }
    const mime = detectMime(resolved);
    const truncated = stat.size > maxBytes;
    const handle = await open(resolved, 'r');
    try {
      const readLen = Math.min(stat.size, maxBytes);
      const buf = Buffer.allocUnsafe(readLen);
      await handle.read(buf, 0, readLen, 0);
      const base = {
        output: truncated
          ? `read first ${readLen} of ${stat.size} bytes from ${resolved}`
          : `read ${readLen} bytes from ${resolved}`,
        path: resolved,
        root,
        mime,
        size: stat.size,
        ...(truncated ? { truncated: true } : {}),
      };
      if (isTextMime(mime)) {
        return { ...base, content: buf.toString('utf8') };
      }
      return { ...base, bytes: buf.toString('base64') };
    } finally {
      await handle.close();
    }
  } catch (e) {
    return {
      output: `(failed to read ${resolved})`,
      path: resolved,
      root,
      error: String(e instanceof Error ? e.message : e),
    };
  }
}

export const elanousFsReadRuntime: ToolRuntime<ElanousFsReadArgs, ElanousFsReadResult> =
  {
    id: 'elanous_fs_read',
    spec: buildElanousFsReadTool(),
    async run(req) {
      return dispatchElanousFsRead(req);
    },
  };
