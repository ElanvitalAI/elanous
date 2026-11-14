import type { LLMToolSpec } from '../llm/tool-spec.js';
import { dispatchKnowledgeQuery, type KnowledgeQueryToolResult } from '../knowledge/tools/knowledge-query.js';

type PackSurfaceResult = Omit<KnowledgeQueryToolResult, 'reason'> & {
  reason?: KnowledgeQueryToolResult['reason'] | 'invalid-pack-query';
};

/** Member-facing surfaces expose only the pack path; legacy vault search stays outside this schema. */
export function buildInstalledPackQueryTool(): LLMToolSpec {
  return {
    name: 'KnowledgeQuery',
    description: 'Before drafting a domain-specific design, consult available cited knowledge packs with a concise topic question. ' +
      'Omit pack_id for installed/bundled pack selection, or name an installed pack explicitly. ' +
      'Returns cited cards, a pack choice question, or an explicit empty-result reason. This surface does not search a host vault.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, description: 'Concise domain-design question for pack selection and cited-card retrieval.' },
        pack_id: { type: 'string', minLength: 1, description: 'Optional installed or bundled knowledge pack identifier.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  };
}

function empty(reason: 'invalid-pack-query' | 'pack-search-failed'): PackSurfaceResult {
  return { output: reason === 'invalid-pack-query' ? 'KnowledgeQuery requires a pack question; vault search options are unavailable.'
    : 'KnowledgeQuery could not read the selected knowledge pack.',
    reason, pack_hits: [], results: [], total: 0, truncated: false };
}

/** The parent pack module must retain its question-only no-match/error no-vault contract. */
export async function dispatchInstalledPackQuery(
  args: Record<string, unknown>,
  execute: typeof dispatchKnowledgeQuery = dispatchKnowledgeQuery,
): Promise<PackSurfaceResult> {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => key !== 'question' && key !== 'pack_id')
    || typeof args.question !== 'string' || !args.question.trim()
    || (args.pack_id !== undefined && (typeof args.pack_id !== 'string' || !args.pack_id.trim()))) {
    return empty('invalid-pack-query');
  }
  try {
    // No vault flags, pagination or raw input object can reach the legacy dispatcher's vault branch.
    const result = await execute({ question: args.question.trim(),
      ...(typeof args.pack_id === 'string' ? { pack_id: args.pack_id.trim() } : {}) }, { trustedPackOnly: true });
    if (result.reason === 'pack-search-failed' || result.output.startsWith('KnowledgeQuery failed:')) {
      return empty('pack-search-failed');
    }
    return result;
  } catch {
    return empty('pack-search-failed');
  }
}
