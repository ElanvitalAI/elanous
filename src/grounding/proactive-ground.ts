// Proactive grounding — one request goes to three indexes (우리가 함 / 남이 함 /
// 전에 실패함) and only the citable survivors come back.
//
// Pure in/out: the three query functions are injected, nothing is read or
// written here. A hit is citable only when it carries a `ref` (source id ⊕
// file path), so everything else is dropped; if nothing survives, the caller
// stays silent instead of inventing a reason.

import type { ReferenceCard } from './ref-index.js';

/** Which index answered: what we did, what others did, what failed before. */
export type RefIndexKey = 'ours' | 'others' | 'failed';

export interface ReferenceHit {
  /** Source id ⊕ file path. A hit without it cannot be linked, so it is dropped. */
  ref?: string;
  title?: string;
  score?: number;
  /** L0 identity of the source, when the index handed it over. */
  card?: ReferenceCard;
}

/** One index, asked once per request. */
export type ReferenceQuery = (request: string) => readonly ReferenceHit[];

export interface ProactiveReferenceSources {
  ours: ReferenceQuery;
  others: ReferenceQuery;
  failed: ReferenceQuery;
}

export interface ProactiveGroundOptions {
  /** Hits scoring under this are dropped. Default 0. */
  minScore?: number;
  /** Max hits kept per index, strongest first. Default 2. */
  perIndex?: number;
}

export interface GroundedReference {
  index: RefIndexKey;
  ref: string;
  title: string;
  score: number;
  card?: ReferenceCard;
}

export interface ProactiveReferencesResult {
  refs: GroundedReference[];
  /** Nothing survived every filter — the request grounds to nothing, so stay silent. */
  silent: boolean;
}

export const DEFAULT_MAX_PER_INDEX = 2;
export const DEFAULT_MIN_SCORE = 0;

/** Asked in this order, so a merged list always reads ours → others → failed. */
const INDEX_ORDER: readonly RefIndexKey[] = ['ours', 'others', 'failed'];

export function proactiveReferences(
  request: string,
  sources: ProactiveReferenceSources,
  opts: ProactiveGroundOptions = {},
): ProactiveReferencesResult {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const perIndex = Math.max(0, Math.trunc(opts.perIndex ?? DEFAULT_MAX_PER_INDEX));

  const refs: GroundedReference[] = [];
  for (const index of INDEX_ORDER) {
    const kept = sources[index](request)
      .filter((hit): hit is ReferenceHit & { ref: string } => typeof hit.ref === 'string' && hit.ref.trim() !== '')
      .map((hit) => ({ hit, score: hit.score ?? DEFAULT_MIN_SCORE }))
      .filter(({ score }) => score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, perIndex)
      .map(({ hit, score }) => ({
        index,
        ref: hit.ref,
        title: hit.title ?? hit.ref,
        score,
        ...(hit.card ? { card: hit.card } : {}),
      }));
    refs.push(...kept);
  }

  return { refs, silent: refs.length === 0 };
}
