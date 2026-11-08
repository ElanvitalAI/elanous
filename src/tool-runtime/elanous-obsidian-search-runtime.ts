import type { LLMToolSpec } from '../llm/tool-spec.js';
// PLAN-codex-app-server-hermes-parity §5 Phase H1·5b (2026-05-16) —
// `elanous_obsidian_search` MCP tool. Mirrors the daemon-side ACP method
// `elanous/obsidian/search` (src/acp/server.ts:2135). Wraps `rg --json`
// over the resolved Obsidian vault and projects each `type: 'match'`
// event into `{path, snippet, lineNumber}`. Session-agnostic so the
// codex app-server can call it via the elanous-tools MCP server without
// first opening an ACP session.
//
// `--max-count 3` per file matches the ACP handler — prevents a
// single noisy file (e.g. a giant changelog) from saturating the
// match list. Caller-side `limit` further caps the total matches the
// dispatcher returns (50 default · 200 max).

import { parseRgJsonMatches, rgJsonMatchesAsync } from './ripgrep-core.js';
import { resolveObsidianRoot } from '../acp/fs-roots.js';

import type { ToolRuntime } from './types.js';

export interface ElanousObsidianSearchArgs {
  /** Case-insensitive search string. Required (empty returns error). */
  query?: string;
  /** Maximum matches to return (1..200 · default 50). */
  limit?: number;
}

export interface ElanousObsidianSearchMatch {
  /** Path relative to the vault root. */
  path: string;
  /** Matching line text (≤240 chars · trailing newlines stripped). */
  snippet: string;
  /** 1-based line number within the file. */
  lineNumber: number;
}

export interface ElanousObsidianSearchResult extends Record<string, unknown> {
  /** LLM-facing one-line summary. */
  output: string;
  matches: ElanousObsidianSearchMatch[];
  error?: string;
}

export function buildElanousObsidianSearchTool(): LLMToolSpec {
  return {
    name: 'elanous_obsidian_search',
    description:
      'Search the Obsidian vault with ripgrep (markdown files only). Returns file path + matching line snippet + line number. Codex app-server callback via the elanous-tools MCP server. Read-only.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring to search for. Required.',
        },
        limit: {
          type: 'integer',
          description: 'Cap on returned matches (1..200 · default 50).',
          minimum: 1,
          maximum: 200,
        },
      },
      additionalProperties: false,
    },
  };
}

/** Pure projector — 공유 ripgrep-core parseRgJsonMatches 래퍼(obsidian 출력 형태로 매핑).
 *  exported for unit tests (rg --json 파싱을 subprocess 없이 검증). */
export function parseRgMatchStream(
  stdout: string,
  vaultRoot: string,
  limit: number,
): ElanousObsidianSearchMatch[] {
  return parseRgJsonMatches(stdout, { relTo: vaultRoot, snippetMax: 240, limit })
    .map((m) => ({ path: m.path, snippet: m.text, lineNumber: m.line }));
}

/** Dispatch the search. `opts.vaultRoot` overrides the resolver for
 *  tests (point at a tmp vault). `opts.spawnRg` overrides the child
 *  process factory so parser correctness can be tested in isolation
 *  from `rg` being installed. */
export async function dispatchElanousObsidianSearch(
  args: ElanousObsidianSearchArgs = {},
  opts: {
    vaultRoot?: string;
    spawnRg?: (
      rgArgs: string[],
    ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  } = {},
): Promise<ElanousObsidianSearchResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length === 0) {
    return { output: '(query required)', matches: [], error: 'query-required' };
  }
  const limit =
    typeof args.limit === 'number' && args.limit > 0 && args.limit <= 200
      ? Math.floor(args.limit)
      : 50;
  let vaultRoot: string;
  if (opts.vaultRoot) {
    vaultRoot = opts.vaultRoot;
  } else {
    const r = resolveObsidianRoot();
    if (!r.available) {
      return {
        output: '(obsidian vault unavailable)',
        matches: [],
        error: 'obsidian-vault-unavailable',
      };
    }
    vaultRoot = r.root;
  }
  // 공유 ripgrep-core(rg --json) — obsidian·vault·acp 동일 프리미티브. spawnRg seam→core spawn.
  const res = await rgJsonMatchesAsync(query, {
    roots: [vaultRoot], ignoreCase: true, lineNumber: true, perFileMaxCount: 3,
    typeAdd: ['md:*.md'], types: ['md'], relTo: vaultRoot, snippetMax: 240, limit,
    ...(opts.spawnRg ? { spawn: opts.spawnRg } : {}),
  });
  // rg exits 0 when matches found, 1 when none, 2+ on error.
  if (!res.ok) {
    return {
      output: `(rg exited ${res.code})`,
      matches: [],
      error: `rg-exit-${res.code}: ${res.stderr.slice(0, 200)}`,
    };
  }
  const matches = res.matches.map((m) => ({ path: m.path, snippet: m.text, lineNumber: m.line }));
  return {
    output: `${matches.length} match(es) for "${query}" in ${vaultRoot}`,
    matches,
  };
}

export const elanousObsidianSearchRuntime: ToolRuntime<
  ElanousObsidianSearchArgs,
  ElanousObsidianSearchResult
> = {
  id: 'elanous_obsidian_search',
  spec: buildElanousObsidianSearchTool(),
  async run(req) {
    return dispatchElanousObsidianSearch(req);
  },
};
