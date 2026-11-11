import type { LLMToolSpec } from '../../llm/tool-spec.js';
import { debug } from '../../debug/log.js';
// ── PFC-S4.2: KnowledgeQuery LLM tool ──


import { discoverObsidianVault, type ObsidianVault } from '../../auto-research/obsidian-bridge.js';
import { knowledgeQuery, queryInstalledPack, resolveInstalledKnowledgePack, selectInstalledKnowledgePack,
  type InstalledKnowledgePackDecision } from '../query.js';
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
  /** Cited cards when an installed pack was explicitly or automatically selected. */
  pack_hits?: ReturnType<typeof queryInstalledPack>;
  /** The unique installed pack selected from its metadata for a question-only call. */
  selectedPack?: { id: string; title: string };
  /** A one-line user choice request when equal-ranked installed packs match the same intent tags. */
  selectionQuestion?: string;
  results: KnowledgeQueryResult['results'];
  total: number;
  truncated: boolean;
  notices?: string[];
}

export interface KnowledgeQueryDispatchOpts {
  vault?: ObsidianVault;
  searchPack?: typeof queryInstalledPack;
  selectPack?: typeof selectInstalledKnowledgePack;
  resolvePack?: typeof resolveInstalledKnowledgePack;
}

function searchPack(packId: string, question: string, opts: KnowledgeQueryDispatchOpts,
  selectedPack?: { id: string; title: string }): KnowledgeQueryToolResult {
  try {
    const hits = (opts.searchPack ?? queryInstalledPack)(packId, question);
    const selected = selectedPack ? `Selected installed pack ${selectedPack.id} (${selectedPack.title}).\n` : '';
    return {
      output: selected + (hits.map(hit => `[${hit.ref}] ${hit.title}: ${hit.body}`).join('\n') || 'No matching installed pack cards.'),
      pack_hits: hits, results: [], total: hits.length, truncated: false,
      ...(selectedPack ? { selectedPack } : {}),
    };
  } catch (error) {
    if (selectedPack) {
      debug.log('knowledge-pack.select', 'provider-failed', {
        stage: 'pack-search',
        fallback: 'none',
        packId: selectedPack.id,
        errorType: error instanceof Error ? error.name : typeof error,
      }, { level: 'warn' });
    }
    return { output: `KnowledgeQuery failed: ${error instanceof Error ? error.message : String(error)}`,
      pack_hits: [], results: [], total: 0, truncated: false };
  }
}

export async function dispatchKnowledgeQuery(
  input: KnowledgeQueryToolInput,
  opts: KnowledgeQueryDispatchOpts = {},
): Promise<KnowledgeQueryToolResult> {
  if (input.pack_id !== undefined) {
    if (!input.question?.trim()) return { output: 'KnowledgeQuery failed: question required for pack search',
      pack_hits: [], results: [], total: 0, truncated: false };
    return searchPack(input.pack_id, input.question, opts);
  }
  const hasVaultSearchOptions = input.tags !== undefined || input.fulltext !== undefined
    || input.kind !== undefined || input.limit !== undefined || input.offset !== undefined
    || input.include_body !== undefined;
  if (input.question?.trim() && !hasVaultSearchOptions) {
    let decision: InstalledKnowledgePackDecision = { kind: 'none' };
    try {
      if (opts.resolvePack) {
        decision = opts.resolvePack(input.question);
      } else if (opts.selectPack) {
        const selected = opts.selectPack(input.question);
        decision = selected ? { kind: 'selected', pack: selected, priority: 0, intentTags: [] } : { kind: 'none' };
      } else {
        decision = resolveInstalledKnowledgePack(input.question);
      }
    } catch (error) {
      debug.log('knowledge-pack.select', 'failed', {
        fallback: 'vault',
        errorType: error instanceof Error ? error.name : typeof error,
      }, { level: 'warn' });
    }
    if (decision.kind === 'ambiguous') {
      const names = decision.candidates.map(candidate => candidate.title);
      const selectionQuestion = `어느 지식 팩을 사용할까요? ${names.join(' / ')} 중에서 선택해 주세요.`;
      debug.log('knowledge-pack.select', 'choice-needed', {
        priority: decision.priority,
        intentTags: decision.intentTags,
        candidateIds: decision.candidates.map(candidate => candidate.id),
        candidateNames: names,
      });
      return { output: selectionQuestion, selectionQuestion, results: [], total: 0, truncated: false };
    }
    if (decision.kind === 'selected') {
      debug.log('knowledge-pack.select', 'selected', {
        priority: decision.priority,
        intentTags: decision.intentTags,
        packId: decision.pack.id,
      });
      return searchPack(decision.pack.id, input.question, opts, decision.pack);
    }
    debug.log('knowledge-pack.select', 'vault-fallback', { reason: 'no-match' });
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
      'For a domain-specific design request, call this before drafting with a concise topic question; omitting pack_id auto-selects a unique matching installed knowledge pack and returns cited cards. You may also search an explicitly installed pack by pack_id, or search the Obsidian knowledge vault (or simulated fallback) for notes matching tags, fulltext regex, '
      + 'or kind. Returns paths + parsed frontmatter + excerpts (and optionally full body). Use this to look '
      + 'up prior incident analyses, tool docs, repo maps, or any markdown you or another agent wrote earlier. '
      + 'For writing, use KnowledgeWrite.',
    parameters: {
      type: 'object',
      properties: {
        pack_id: { type: 'string', description: 'Installed pack id, e.g. pack:semiconductor-process-public@0.1.0. Requires question.' },
        question: { type: 'string', description: 'Concise topic words for automatic installed-pack selection, or search words for an explicit pack_id.' },
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
