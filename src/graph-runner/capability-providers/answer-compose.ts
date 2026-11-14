/** A bounded, source-bound answer envelope. Transport and model credentials belong to the host. */
export const ANSWER_COMPOSE = Object.freeze({ id: 'answer.compose@1', maxSources: 20 } as const);
// Keep each model-supplied citation URL within an ordinary UTF-8 request target budget.
const MAX_SOURCE_URL_BYTES = 2_048;

export interface AnswerSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedAt?: string;
}
export interface AnswerComposeInput {
  readonly question: string;
  readonly sources: readonly AnswerSource[];
}
export interface AnswerCitation { readonly sourceId: string; readonly url: string }
/** Answer is inert plain text. Citation links come only from citations[], indexed as [1], [2], ... in array order. */
export interface AnswerDraft { readonly answer: string; readonly citations: readonly AnswerCitation[] }
export type AnswerComposeResult =
  | { readonly status: 'ok'; readonly answer: string; readonly citations: readonly AnswerCitation[];
      readonly sourceIds: readonly string[] }
  | { readonly status: 'invalid-input' | 'model-unavailable' | 'invalid-citations' };

function validSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

function validInput(input: AnswerComposeInput): boolean {
  if (!input || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 10_000
      || !Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > ANSWER_COMPOSE.maxSources) return false;
  const ids = new Set<string>();
  for (const source of input.sources) {
    if (!source || typeof source.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(source.id) || ids.has(source.id)
        || typeof source.title !== 'string' || !source.title.trim() || source.title.length > 300
        || typeof source.snippet !== 'string' || !source.snippet.trim() || source.snippet.length > 4_000
        || typeof source.url !== 'string' || Buffer.byteLength(source.url, 'utf8') > MAX_SOURCE_URL_BYTES || !validSourceUrl(source.url)
        || (source.publishedAt !== undefined && (typeof source.publishedAt !== 'string' || source.publishedAt.length > 40))) return false;
    ids.add(source.id);
  }
  return true;
}

function snapshotInput(input: AnswerComposeInput): AnswerComposeInput {
  const sources = input.sources.map(source => Object.freeze({
    id: source.id, title: source.title, url: source.url, snippet: source.snippet,
    ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
  }));
  return Object.freeze({ question: input.question, sources: Object.freeze(sources) });
}

function verifiedDraft(input: AnswerComposeInput, draft: AnswerDraft): AnswerComposeResult {
  if (!draft || typeof draft.answer !== 'string' || !draft.answer.trim() || draft.answer.length > 20_000
      || !Array.isArray(draft.citations) || draft.citations.length === 0 || draft.citations.length > input.sources.length) {
    return { status: 'invalid-citations' };
  }
  const sources = new Map(input.sources.map(source => [source.id, source.url]));
  const cited = new Set<string>();
  for (const [index, citation] of draft.citations.entries()) {
    if (!citation || typeof citation.sourceId !== 'string' || typeof citation.url !== 'string'
        || cited.has(citation.sourceId) || sources.get(citation.sourceId) !== citation.url
        || !draft.answer.includes(`[${index + 1}]`)) return { status: 'invalid-citations' };
    cited.add(citation.sourceId);
  }
  // Citation numbers are array positions. A numeric marker without a matching
  // structured citation is invalid; all other answer bytes are inert prose.
  // Renderers must use text nodes with auto-link and markup disabled, and make
  // links only from citations[]. This provider has no renderer integration.
  for (const match of draft.answer.matchAll(/\[(\d+)\]/g)) {
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 1 || index > draft.citations.length) return { status: 'invalid-citations' };
  }
  return { status: 'ok', answer: draft.answer, citations: draft.citations,
    sourceIds: [...cited] };
}

/** Host-owned Solar adapter supplies `compose`; this module never resolves a key or sends a request. */
export function createAnswerComposeProvider(deps: {
  readonly compose: (input: AnswerComposeInput) => Promise<AnswerDraft>;
}) {
  return async (input: AnswerComposeInput): Promise<AnswerComposeResult> => {
    if (!validInput(input)) return { status: 'invalid-input' };
    // Capture the validated source boundary before compose can await a key or transport.
    // Revalidate the copy in case caller-owned getters changed between reads.
    const checked = snapshotInput(input);
    if (!validInput(checked)) return { status: 'invalid-input' };
    let draft: AnswerDraft;
    try { draft = await deps.compose(checked); }
    catch { return { status: 'model-unavailable' }; }
    return verifiedDraft(checked, draft);
  };
}
