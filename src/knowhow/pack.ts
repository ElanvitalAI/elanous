/** Shared, deterministic retrieval contract for TUI and task-agent knowhow. */

export const KNOWHOW_PACK_DEFAULT_K = 8;
export const KNOWHOW_PACK_DEFAULT_CHAR_BUDGET = 32_000;

export type KnowhowSourceKind = 'KNOWHOW.md' | 'PLAYBOOK' | 'know-candidates' | 'autopsy';
export type KnowhowKind = 'fact' | 'warning' | 'heuristic' | 'playbook' | 'case';

export const KNOWHOW_HALF_LIFE_DAYS: Readonly<Record<KnowhowKind, number>> = {
  fact: 14,
  warning: 30,
  heuristic: 90,
  playbook: 60,
  case: Number.POSITIVE_INFINITY,
};

export interface KnowhowTarget {
  surface: string;
  scope: string;
  tool?: string;
  commandClass?: string;
}

/** Values are normalized by the consumer; the shared core compares them exactly. */
export interface KnowhowFailureSignature {
  kind: string;
  stableCode: string;
  normalizedArgsHash: string;
}

export interface KnowhowFragment {
  id: string;
  target: KnowhowTarget;
  signature: KnowhowFailureSignature;
  text: string;
  kind: KnowhowKind;
  source: { kind: KnowhowSourceKind; path: string; ref: string };
  status: 'verified' | 'candidate' | 'challenged' | 'rejected';
  confidence: number;
  verifiedAt: string;
  expiresAt: string;
}

export interface KnowhowPackRequest {
  target: KnowhowTarget;
  signature: KnowhowFailureSignature;
  now?: number;
  maxItems?: number;
  maxChars?: number;
}

export interface KnowhowPack {
  snippets: Array<Pick<KnowhowFragment, 'id' | 'text' | 'source' | 'status' | 'confidence' | 'verifiedAt'>>;
  omittedCount: number;
  diagnostics: string[];
}

function sameTarget(a: KnowhowTarget, b: KnowhowTarget): boolean {
  return a.surface === b.surface
    && a.scope === b.scope
    && a.tool === b.tool
    && a.commandClass === b.commandClass;
}

function sameSignature(a: KnowhowFailureSignature, b: KnowhowFailureSignature): boolean {
  return a.kind === b.kind
    && a.stableCode === b.stableCode
    && a.normalizedArgsHash === b.normalizedArgsHash;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTarget(value: unknown): value is KnowhowTarget {
  if (!isRecord(value)) return false;
  return typeof value.surface === 'string' && value.surface.trim().length > 0
    && typeof value.scope === 'string' && value.scope.trim().length > 0
    && (value.tool === undefined || typeof value.tool === 'string')
    && (value.commandClass === undefined || typeof value.commandClass === 'string');
}

function validSignature(value: unknown): value is KnowhowFailureSignature {
  return isRecord(value)
    && typeof value.kind === 'string' && value.kind.trim().length > 0
    && typeof value.stableCode === 'string' && value.stableCode.trim().length > 0
    && typeof value.normalizedArgsHash === 'string' && value.normalizedArgsHash.trim().length > 0;
}

function validFragment(fragment: KnowhowFragment, request: KnowhowPackRequest, now: number): boolean {
  const verifiedAt = timestamp(fragment.verifiedAt);
  const expiresAt = timestamp(fragment.expiresAt);
  return fragment.status === 'verified'
    && Object.hasOwn(KNOWHOW_HALF_LIFE_DAYS, fragment.kind)
    && Number.isFinite(fragment.confidence)
    && fragment.confidence >= 0 && fragment.confidence <= 1
    && ['KNOWHOW.md', 'PLAYBOOK', 'know-candidates', 'autopsy'].includes(fragment.source.kind)
    && fragment.id.trim().length > 0
    && fragment.text.trim().length > 0
    && fragment.source.path.trim().length > 0
    && fragment.source.ref.trim().length > 0
    && verifiedAt !== null && verifiedAt <= now
    && expiresAt !== null && expiresAt > now
    && expiresAt >= verifiedAt
    && (now - verifiedAt <= KNOWHOW_HALF_LIFE_DAYS[fragment.kind]
      * 24 * 60 * 60 * 1000)
    && sameTarget(fragment.target, request.target)
    && sameSignature(fragment.signature, request.signature);
}

/**
 * Select only verified, unexpired fragments for an exact target and failure
 * signature. Whole snippets are admitted or omitted; this function never
 * truncates evidence-bearing text. Invalid limits and malformed input fail
 * open as an empty pack, leaving the caller's existing path usable.
 */
export function buildKnowhowPack(
  fragments: readonly KnowhowFragment[],
  request: KnowhowPackRequest,
): KnowhowPack {
  try {
    const inputCount = Array.isArray(fragments) ? fragments.length : 0;
    if (!isRecord(request) || !validTarget(request.target) || !validSignature(request.signature)) {
      return { snippets: [], omittedCount: inputCount, diagnostics: ['invalid-request'] };
    }
    if (!Array.isArray(fragments)) {
      return { snippets: [], omittedCount: 0, diagnostics: ['invalid-fragments'] };
    }
    const maxItems = request.maxItems ?? KNOWHOW_PACK_DEFAULT_K;
    const maxChars = request.maxChars ?? KNOWHOW_PACK_DEFAULT_CHAR_BUDGET;
    const now = request.now ?? Date.now();
    if (!Number.isFinite(now) || !Number.isInteger(maxItems) || maxItems < 0
      || !Number.isInteger(maxChars) || maxChars < 0) {
      return { snippets: [], omittedCount: inputCount, diagnostics: ['invalid-request'] };
    }

    const sorted = [...fragments].filter((fragment) => validFragment(fragment, request, now)).sort((a, b) => {
      // Most recently verified wins; the id is the stable tie breaker.
      return timestamp(b.verifiedAt)! - timestamp(a.verifiedAt)!
        || compareText(a.id, b.id)
        || compareText(a.verifiedAt, b.verifiedAt)
        || b.confidence - a.confidence
        || compareText(a.expiresAt, b.expiresAt)
        || compareText(a.source.kind, b.source.kind)
        || compareText(a.source.path, b.source.path)
        || compareText(a.source.ref, b.source.ref)
        || compareText(a.text, b.text);
    });
    const seen = new Set<string>();
    const eligible = sorted.filter((fragment) => {
      if (seen.has(fragment.id)) return false;
      seen.add(fragment.id);
      return true;
    });

    const snippets: KnowhowPack['snippets'] = [];
    let chars = 0;
    for (const fragment of eligible) {
      if (snippets.length >= maxItems) break;
      const snippet: KnowhowPack['snippets'][number] = {
        id: fragment.id,
        text: fragment.text,
        source: {
          kind: fragment.source.kind,
          path: fragment.source.path,
          ref: fragment.source.ref,
        },
        status: fragment.status,
        confidence: fragment.confidence,
        verifiedAt: fragment.verifiedAt,
      };
      // Budget the complete serialized snippet, including provenance metadata.
      const snippetChars = JSON.stringify(snippet).length;
      if (chars + snippetChars > maxChars) continue;
      snippets.push(snippet);
      chars += snippetChars;
    }
    return {
      snippets,
      omittedCount: fragments.length - snippets.length,
      diagnostics: [],
    };
  } catch {
    return {
      snippets: [],
      omittedCount: Array.isArray(fragments) ? fragments.length : 0,
      diagnostics: ['fragment-validation-failed'],
    };
  }
}
