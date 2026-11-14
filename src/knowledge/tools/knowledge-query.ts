import type { LLMToolSpec } from '../../llm/tool-spec.js';
import { debug } from '../../debug/log.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// ── PFC-S4.2: KnowledgeQuery LLM tool ──


import { discoverObsidianVault, type ObsidianVault } from '../../auto-research/obsidian-bridge.js';
import { knowledgeQuery, queryInstalledPack, resolveInstalledKnowledgePack, selectInstalledKnowledgePack,
  type InstalledKnowledgePackDecision } from '../query.js';
import type { KnowledgeQueryInput, KnowledgeQueryResult } from '../types.js';
import { kgsDefaultDbPath } from '../kgs/sqlite-store.js';
import { packIdString } from '../kgs/pack.js';
import { validateKnowledgePack } from '../write.js';

const BUNDLED_SYSTEM_ARCHITECTURE = fileURLToPath(new URL('../../../packs/system-architecture-public/', import.meta.url));
const BUNDLED_SYSTEM_ARCHITECTURE_ID = 'pack:system-architecture-public@0.2.0';

function bundledSystemArchitectureEnabled(opts: KnowledgeQueryDispatchOpts): boolean {
  return opts.bundledSystemArchitecture ?? process.env.ELANOUS_SYSTEM_ARCH_PACK !== 'off';
}

function disclaimsArchitectureDesign(question: string): boolean {
  const designClauses = question.split(/[.!?;。\n,]|하지만|대신|그러나|\bbut\b|\binstead\b/iu)
    .filter(clause => /설계|아키텍처|구조|architecture|design/i.test(clause));
  const exclusion = /(?:설계|아키텍처|구조)\s*(?:는|은|을|를|가|이)?\s*(?:필요\s*(?:없|하지\s*않)|불필요|하지\s*마|말고|빼고|원치\s*않)|\b(?:no|without|do\s+not|don't)\s+(?:new\s+)?(?:architecture|design)\b|\b(?:architecture|design)\s+(?:is\s+)?(?:not\s+needed|unnecessary)\b/i;
  const explicitArchitecture = /(?:백엔드|backend|시스템|system).*(?:아키텍처|architecture|설계|design)|(?:아키텍처|architecture).*(?:백엔드|backend|시스템|system)/i;
  return designClauses.some(clause => exclusion.test(clause))
    && !designClauses.some(clause => explicitArchitecture.test(clause) && !exclusion.test(clause));
}

function isArchitectureCopyEditOnly(question: string): boolean {
  return /(?:오탈자|맞춤법|문구|표현|typo|proofread|copy.edit).{0,16}(?:만|only)|(?:만|only).{0,16}(?:오탈자|맞춤법|문구|표현|typo|proofread|copy.edit)/i.test(question)
    && !/(?:백엔드|backend|시스템|system).{0,30}(?:아키텍처|architecture|설계|design).{0,20}(?:설계해|design|만들|구성해)/i.test(question);
}

function isArchitectureDesignRequest(question: string): boolean {
  if (disclaimsArchitectureDesign(question) || isArchitectureCopyEditOnly(question)) return false;
  return /아키텍처|시스템\s*설계|설계.*(?:API|DB|데이터베이스|배포|구성)|(?:API|DB|데이터베이스|배포|구성).*설계|사이트.*구조.*(?:API|DB)|(?:FE|프론트엔드).*(?:BE|백엔드).*(?:DB|데이터베이스)|architecture|system\s+design|(?:frontend|front-end).*(?:backend|back-end).*(?:database|deployment)/i.test(question);
}

function bundledSystemArchitecture(question: string, enabled: boolean) {
  if (!enabled || !isArchitectureDesignRequest(question) || !existsSync(BUNDLED_SYSTEM_ARCHITECTURE)) return null;
  const { pack } = validateKnowledgePack(BUNDLED_SYSTEM_ARCHITECTURE);
  return pack;
}

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
  /** Why a pack-only question returned no cards without consulting a vault. */
  reason?: 'no-matching-pack' | 'architecture-not-requested' | 'pack-disabled' | 'pack-not-installed' | 'pack-search-failed';
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
  /** Trusted pack context must never consult the Obsidian vault, even with explicit filters. */
  trustedPackOnly?: boolean;
  searchPack?: typeof queryInstalledPack;
  selectPack?: typeof selectInstalledKnowledgePack;
  resolvePack?: typeof resolveInstalledKnowledgePack;
  /** A/B seam: disable the shipped public pack while keeping installed packs unchanged. */
  bundledSystemArchitecture?: boolean;
}

function searchPack(packId: string, question: string, opts: KnowledgeQueryDispatchOpts,
  selectedPack?: { id: string; title: string }): KnowledgeQueryToolResult {
  if (!opts.searchPack && !existsSync(kgsDefaultDbPath())) {
    return { output: `KnowledgeQuery: pack not installed: ${packId}`, reason: 'pack-not-installed',
      pack_hits: [], results: [], total: 0, truncated: false };
  }
  try {
    const hits = (opts.searchPack ?? queryInstalledPack)(packId, question);
    for (const hit of hits) debug.log('pack.load', 'document', {
      packId, documentId: hit.id, documentSha256: createHash('sha256').update(hit.body).digest('hex'),
    });
    const selected = selectedPack ? `Selected knowledge pack ${selectedPack.id} (${selectedPack.title}).\n` : '';
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
      reason: 'pack-search-failed',
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
    if (input.pack_id === BUNDLED_SYSTEM_ARCHITECTURE_ID && bundledSystemArchitectureEnabled(opts)) {
      try {
        const pack = validateKnowledgePack(BUNDLED_SYSTEM_ARCHITECTURE).pack;
        return searchPack(input.pack_id, input.question, {
          ...opts, searchPack: opts.searchPack ?? ((id, question) => queryInstalledPack(id, question, { readPack: () => pack })),
        });
      } catch (error) {
        return { output: `KnowledgeQuery failed: ${error instanceof Error ? error.message : String(error)}`,
          pack_hits: [], results: [], total: 0, truncated: false };
      }
    }
    return searchPack(input.pack_id, input.question, opts);
  }
  const packQuestion = input.question?.trim() || (opts.trustedPackOnly ? input.fulltext?.trim() : undefined);
  const hasVaultSearchOptions = !opts.trustedPackOnly && (input.tags !== undefined || input.fulltext !== undefined
    || input.kind !== undefined || input.limit !== undefined || input.offset !== undefined
    || input.include_body !== undefined);
  if (packQuestion && !hasVaultSearchOptions) {
    const packSearch = (opts.trustedPackOnly && input.fulltext?.trim()) || packQuestion;
    let decision: InstalledKnowledgePackDecision = { kind: 'none' };
    try {
      if (opts.resolvePack) {
        decision = opts.resolvePack(packQuestion);
      } else if (opts.selectPack) {
        const selected = opts.selectPack(packQuestion);
        decision = selected ? { kind: 'selected', pack: selected, priority: 0, intentTags: [] } : { kind: 'none' };
      } else if (existsSync(kgsDefaultDbPath())) {
        decision = resolveInstalledKnowledgePack(packQuestion);
      }
    } catch (error) {
      debug.log('knowledge-pack.select', 'failed', {
        fallback: 'none',
        errorType: error instanceof Error ? error.name : typeof error,
      }, { level: 'warn' });
      return { output: `KnowledgeQuery failed: ${error instanceof Error ? error.message : String(error)}`,
        pack_hits: [], results: [], total: 0, truncated: false };
    }
    if (decision.kind === 'selected' && decision.pack.id.startsWith('pack:system-architecture-public@')
      && (disclaimsArchitectureDesign(packQuestion) || isArchitectureCopyEditOnly(packQuestion)
        || !bundledSystemArchitectureEnabled(opts))) {
      debug.log('knowledge-pack.select', 'architecture-skipped', { packId: decision.pack.id,
        reason: disclaimsArchitectureDesign(packQuestion) || isArchitectureCopyEditOnly(packQuestion)
          ? 'not-design-request' : 'ab-off' });
      decision = { kind: 'none' };
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
      return searchPack(decision.pack.id, packSearch, opts, decision.pack);
    }
    try {
      const bundled = bundledSystemArchitecture(packQuestion, bundledSystemArchitectureEnabled(opts));
      if (bundled) {
        const packId = packIdString(bundled.metadata.id);
        debug.log('knowledge-pack.select', 'bundled', { packId });
        return searchPack(packId, packSearch, {
          ...opts, searchPack: opts.searchPack ?? ((id, question) => queryInstalledPack(id, question, { readPack: () => bundled })),
        }, { id: packId, title: bundled.metadata.title });
      }
    } catch (error) {
      return { output: `KnowledgeQuery failed: ${error instanceof Error ? error.message : String(error)}`,
        pack_hits: [], results: [], total: 0, truncated: false };
    }
    const reason = !bundledSystemArchitectureEnabled(opts) ? 'pack-disabled'
      : !isArchitectureDesignRequest(packQuestion) && /아키텍처|architecture|설계|design/i.test(packQuestion)
        ? 'architecture-not-requested' : 'no-matching-pack';
    debug.log('knowledge-pack.select', 'no-pack', { reason });
    return { output: `KnowledgeQuery: no matching knowledge pack (${reason}); no cards loaded.`, reason,
      pack_hits: [], results: [], total: 0, truncated: false };
  }
  if (opts.trustedPackOnly) {
    return { output: 'KnowledgeQuery: no matching knowledge pack (no-matching-pack); no cards loaded.',
      reason: 'no-matching-pack', pack_hits: [], results: [], total: 0, truncated: false };
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
      'For system architecture design, FE BE DB testing deployment, or 아키텍처 설계 FE BE DB 시험 배포, call before drafting with a concise topic question. The shipped public architecture pack is read on demand without installation; installed packs also auto-select and return cited cards. A question with no matching pack returns an empty result and reason without opening a vault. Vault search requires explicit tags, fulltext, kind, limit, offset, or include_body. You may search an explicit pack by pack_id, or search the Obsidian knowledge vault for notes matching tags, fulltext regex, '
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
