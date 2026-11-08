import type { LLMToolSpec } from '../llm/tool-spec.js';
// PLAN-codex-app-server-hermes-parity §5 Phase H1·5d (2026-05-16) —
// `elanous_fs_list` MCP tool. Mirrors the daemon-side ACP method
// `elanous/fs/list` (src/acp/server.ts:1960). Session-agnostic so the
// codex app-server can call it via the elanous-tools MCP server without
// first opening an ACP session.
//
// Two roots — `'cwd'` (daemon process.cwd) and `'obsidian'` (resolved
// vault). `..` cannot escape the chosen root (clampToRoot guard).
// Default cap 200 entries · max 500 · directories sorted before files
// and then alphabetically inside each group. Hidden files are skipped
// via isHiddenForBrowser (same filter the iPad picker uses).

import { readdir } from 'node:fs/promises';
import {
  resolveFsRoot,
  clampToRoot,
  isHiddenForBrowser,
  type FsRootKind,
} from '../acp/fs-roots.js';

import type { ToolRuntime } from './types.js';

export interface ElanousFsListArgs {
  /** Root anchor. `'cwd'` = daemon process.cwd (default), `'obsidian'`
   *  = resolved vault. Anything else falls back to `'cwd'` for safety. */
  root?: 'cwd' | 'obsidian';
  /** Path under the chosen root (relative or absolute). Omitted = the
   *  root itself. Resolved + clamped to the root. */
  cwd?: string;
  /** Case-insensitive substring filter on entry name. Empty = all. */
  query?: string;
  /** Entry cap (1..500 · default 200). */
  limit?: number;
}

export interface ElanousFsListEntry {
  name: string;
  isDir: boolean;
  /** Name only (relative to `cwd`) — not the full path. Matches the
   *  ACP handler shape used by the iPad picker. */
  relPath: string;
}

export interface ElanousFsListResult extends Record<string, unknown> {
  output: string;
  cwd: string;
  root: 'cwd' | 'obsidian';
  entries: ElanousFsListEntry[];
  error?: string;
}

export function buildElanousFsListTool(): LLMToolSpec {
  return {
    name: 'elanous_fs_list',
    description:
      'List entries under a directory (clamped to either the daemon cwd or the Obsidian vault). Returns {name, isDir, relPath}. Codex app-server callback via the elanous-tools MCP server. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          enum: ['cwd', 'obsidian'],
          description: "Root anchor. 'cwd' = daemon working dir, 'obsidian' = vault.",
        },
        cwd: {
          type: 'string',
          description: 'Directory under the chosen root (relative or absolute · default = root itself).',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive substring filter on entry name.',
        },
        limit: {
          type: 'integer',
          description: 'Entry cap (1..500 · default 200).',
          minimum: 1,
          maximum: 500,
        },
      },
      additionalProperties: false,
    },
  };
}

/** `opts.rootResolver` lets tests inject a custom path resolver so
 *  vault resolution doesn't depend on the host's real ~/.elanous state. */
export async function dispatchElanousFsList(
  args: ElanousFsListArgs = {},
  opts: {
    rootResolver?: (kind: FsRootKind) => string;
  } = {},
): Promise<ElanousFsListResult> {
  const root: FsRootKind = args.root === 'obsidian' ? 'obsidian' : 'cwd';
  const resolver = opts.rootResolver ?? resolveFsRoot;
  let baseRoot: string;
  try {
    baseRoot = resolver(root);
  } catch (e) {
    return {
      output: `(failed to resolve root '${root}')`,
      cwd: '',
      root,
      entries: [],
      error: String(e instanceof Error ? e.message : e),
    };
  }
  const rawCwd =
    typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : baseRoot;
  const cwd = clampToRoot(baseRoot, rawCwd);
  if (cwd == null) {
    return {
      output: '(cwd escapes root)',
      cwd: baseRoot,
      root,
      entries: [],
      error: 'cwd-escapes-root',
    };
  }
  const query = (args.query ?? '').toLowerCase();
  const cap =
    typeof args.limit === 'number' && args.limit > 0 && args.limit <= 500
      ? Math.floor(args.limit)
      : 200;
  try {
    const dirents = await readdir(cwd, { withFileTypes: true });
    let mapped = dirents
      .filter((e) => !isHiddenForBrowser(e.name))
      .map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
        relPath: e.name,
      }));
    if (query.length > 0) {
      mapped = mapped.filter((e) => e.name.toLowerCase().includes(query));
    }
    mapped.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    if (mapped.length > cap) mapped = mapped.slice(0, cap);
    return {
      output: `${mapped.length} entr${mapped.length === 1 ? 'y' : 'ies'} under ${cwd}`,
      cwd,
      root,
      entries: mapped,
    };
  } catch (e) {
    return {
      output: `(failed to read ${cwd})`,
      cwd,
      root,
      entries: [],
      error: String(e instanceof Error ? e.message : e),
    };
  }
}

export const elanousFsListRuntime: ToolRuntime<ElanousFsListArgs, ElanousFsListResult> =
  {
    id: 'elanous_fs_list',
    spec: buildElanousFsListTool(),
    async run(req) {
      return dispatchElanousFsList(req);
    },
  };
