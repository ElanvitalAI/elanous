// ── PFC-S4.2: KnowledgeQuery LLM tool ──

import type { LLMToolSpec } from '../../llm.js';
import { discoverObsidianVault, type ObsidianVault } from '../../auto-research/obsidian-bridge.js';
import { knowledgeQuery, queryInstalledPack } from '../query.js';
import type { KnowledgeQueryInput, KnowledgeQueryResult } from '../types.js';

export interface KnowledgeQueryToolInput {
  pack_id?: string;
  question?: string;
  tags?: string[];
  fulltext?: string;
  kind?: 'all' | 'rca' | 'a3' | 'incident' | 'wiki' | 'repomap' | 'note';
  limit?: number;
  offset?: number;
  include_body?: boolean;
}

export interface KnowledgeQueryToolResult {
  output: string;
  /** Cited cards when pack_id is supplied; absent on the existing vault query path. */
  pack_hits?: ReturnType<typeof queryInstalledPack>;
  results: KnowledgeQueryResult['results'];
  total: number;
  truncated: boolean;
  notices?: string[];
}

export interface KnowledgeQueryDispatchOpts {
  vault?: ObsidianVault;
  searchPack?: typeof queryInstalledPack;
}

export async function dispatchKnowledgeQuery(
  input: KnowledgeQueryToolInput,
  opts: KnowledgeQueryDispatchOpts = {},
): Promise<KnowledgeQueryToolResult> {
  if (input.pack_id !== undefined) {
    try {
      if (!input.question?.trim()) throw new Error('question required for pack search');
      const hits = (opts.searchPack ?? queryInstalledPack)(input.pack_id, input.question);
      return { output: hits.map(hit => `[${hit.ref}] ${hit.title}: ${hit.body}`).join('\n') || 'No matching installed pack cards.',
        pack_hits: hits, results: [], total: hits.length, truncated: false };
    } catch (error) {
      return { output: `KnowledgeQuery failed: ${error instanceof Error ? error.message : String(error)}`,
        pack_hits: [], results: [], total: 0, truncated: false };
    }
  }
  const vault = opts.vault ?? discoverObsidianVault();
  const notices: string[] = [];
  if (vault.isSimulated) {
    notices.push(`vault fallback in use: ${vault.root}`);
  }

  const coreInput: KnowledgeQueryInput = {};
  if (input.tags) coreInput.tags = input.tags;
  if (input.fulltext) coreInput.fulltext = input.fulltext;
  if (input.kind) coreInput.kind = input.kind;
  if (input.limit !== undefined) coreInput.limit = input.limit;
  if (input.offset !== undefined) coreInput.offset = input.offset;
  if (input.include_body !== undefined) coreInput.include_body = input.include_body;

  let result: KnowledgeQueryResult;
  try {
    result = knowledgeQuery(vault, coreInput);
  } catch (err) {
    return {
      output: `KnowledgeQuery failed: ${(err as Error).message}`,
      results: [],
      total: 0,
      truncated: false,
      ...(notices.length ? { notices } : {}),
    };
  }

  const summary =
    `KnowledgeQuery: ${result.results.length}/${result.total} result(s) `
    + (result.truncated ? '(more available — use offset) ' : '')
    + `vault=${vault.label}${vault.isSimulated ? ' (fallback)' : ''}`;

  return {
    output: summary,
    results: result.results,
    total: result.total,
    truncated: result.truncated,
    ...(notices.length ? { notices } : {}),
  };
}

export function buildKnowledgeQueryTool(): LLMToolSpec {
  return {
    name: 'KnowledgeQuery',
    description:
      'Search an explicitly installed knowledge pack by pack_id and question for cited cards, or search the Obsidian knowledge vault (or simulated fallback) for notes matching tags, fulltext regex, '
      + 'or kind. Returns paths + parsed frontmatter + excerpts (and optionally full body). Use this to look '
      + 'up prior incident analyses, tool docs, repo maps, or any markdown you or another agent wrote earlier. '
      + 'For writing, use KnowledgeWrite.',
    parameters: {
      type: 'object',
      properties: {
        pack_id: { type: 'string', description: 'Installed pack id, e.g. pack:semiconductor-process-public@0.1.0. Requires question.' },
        question: { type: 'string', description: 'Search words when pack_id is provided.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'AND filter — every listed tag must appear in frontmatter.tags.',
        },
        fulltext: {
          type: 'string',
          description: 'Case-insensitive JavaScript regex pattern. Body-only; excerpts centre on the match.',
        },
        kind: {
          type: 'string',
          enum: ['all', 'rca', 'a3', 'incident', 'wiki', 'repomap', 'note'],
          description: 'Filter by note category. Uses directory hints (Incidents/ RCA/ A3/ OSToolWiki/ RepoMaps/) + frontmatter.kind.',
        },
        limit: { type: 'number', description: 'Max results (default 20, max 100).' },
        offset: { type: 'number', description: 'Pagination offset.' },
        include_body: { type: 'boolean', description: 'Return full body text (default false).' },
      },
      additionalProperties: false,
    },
  };
}
