// KIT mail-route · hand classifier — Jev (Typesafe System One, the decision model) reads ONE unstructured ✋ block line and
// returns PROBABILITIES over the hand-routes.yaml `classifier` words (wip · jud · hold · guardian · approval · cell ·
// decision · unclear). It generates no text (대표 22:1x «분류기는 jev 로 · 결정 모델»). The top word wins only at or above
// `classifierMinProbability`; below it, or `unclear`, the ✋ is ambiguous and keeps its old rung (TC). Asked only when the
// block carries no structured `cause:` / `reason:` code that decides it (standing rule 11-20: no regex/keyword routing).
// Unavailable · slow · no key · malformed → null → the old first rung; it never blocks.
//
// Plumbing (access · egress · timeout + abort · redaction · usage row · 402 breaker) = the kit src/kit/jev-decide; the
// question text and the egress rule = graphs/policies/jev-sites.yaml `mail-route.hand-classify`.
//
// 세 얼굴: 관측 = `msg.hand-classify {root, p, ms, model}` per call ⊕ `jev.decide` ⊕ usage row (providerName typesafe · site
// mail-route.hand-classify · role classify) · 판단 근거 = Jev probabilities ⊕ the YAML threshold · 수복과 인계 = null → old rung.
import type { JevAnswer, JevQuestion, JevRequest, JevResponse } from '../../decide/jev.js';
import { jevDecide, jevSite, jevTopChoice, resolveLiveJevAccess, type JevDecideDeps } from '../jev-decide/index.js';
import { readHandRoutes, type HandRoot, type HandRoutesTable } from './hand-routes.js';

/** Fallback only — the timeout in force is hand-routes.yaml `classifierTimeoutSeconds`. */
export const HAND_CLASSIFY_TIMEOUT_MS = 8_000;
const SITE_ID = 'mail-route.hand-classify';
export const HAND_CLASSIFY_USAGE_SITE = jevSite(SITE_ID).usageSite;
const UNCLEAR = 'unclear';

/** The Jev choice question — the words and what each means are hand-routes.yaml `classifier` rows (a new root = a YAML row). */
export function handJevQuestion(table: HandRoutesTable = readHandRoutes()): JevQuestion {
  return {
    type: 'choice',
    instructions: jevSite(SITE_ID).questions.owner?.instructions
      ?? 'An agent seat is blocked and wrote the line in state.line. Who can unblock it? Pick the owner whose description fits the line.',
    criteria: { ...Object.fromEntries(Object.entries(table.classifier).map(([word, row]) => [word, row.means])), [UNCLEAR]: 'none of the others fits, or not enough information' },
  };
}

export interface HandPick { readonly root: HandRoot | null; readonly word: string | null; readonly p: number }

/**
 * The max-probability word → its root; below the YAML threshold (the root's own `rootMinProbability` bar when it has one ·
 * env 0.65 — a ✋ leaving its space for a loop agent needs a clear resource reading), `unclear`, or unknown → root null.
 * Pure over the table.
 */
export function pickHandRoot(answer: JevAnswer | undefined, table: HandRoutesTable = readHandRoutes()): HandPick {
  const { word, p } = jevTopChoice(answer);
  if (word === null) return { root: null, word: null, p: 0 };
  const key = word.trim().toLowerCase();
  if (key === UNCLEAR || p < table.classifierMinProbability || !Object.hasOwn(table.classifier, key)) return { root: null, word: key, p };
  const root = table.classifier[key]!.root;
  const bar = table.rootMinProbability[root];
  if (bar !== undefined && p < bar) return { root: null, word: key, p };
  return { root, word: key, p };
}

/** The decision call: a Jev request → its response (default: Typesafe via src/decide/jev.ts). Tests and sims inject one. */
export type HandDecide = (req: JevRequest, signal: AbortSignal) => Promise<JevResponse>;

export interface HandClassifierOptions {
  readonly decide?: HandDecide;
  readonly timeoutMs?: number;
  readonly table?: HandRoutesTable;
}

/**
 * The live decision transport for a usage site that is not routed through a jev-sites.yaml row (steward:mail shadow ·
 * record-only): access from the jev-decide kit (resolveLiveJevAccess — decide.endpoint > ELANOUS_JEV_ENDPOINT > Typesafe ⊕
 * key), abort on the caller's signal, one usage row per call. The ✋ owner classifier itself goes through jevDecide (kit).
 */
export function makeJevDecide(site: string): HandDecide {
  return async (req, signal) => {
    const { callJev } = await import('../../decide/jev.js');
    const resolved = resolveLiveJevAccess();
    if (!resolved.ok) throw new Error('jev-no-key');
    const fetchWithAbort = ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal })) as typeof fetch;
    const response = await callJev({ ...req, ...(resolved.access.model ? { model: resolved.access.model } : {}) }, resolved.access.key, fetchWithAbort, resolved.access.endpoint);
    if (response.usage) {
      try {
        const { logAgentTurnUsage } = await import('../../llm.js');
        logAgentTurnUsage(response.model, { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
          { providerName: 'typesafe', site, role: 'classify' });
      } catch { /* usage observation never blocks routing */ }
    }
    return response;
  };
}

const note = (event: string, data: Record<string, unknown>): void => {
  try { (require('../../debug/log.js') as typeof import('../../debug/log.js')).debug.log('msg', event, data); } catch { /* observation is fail-open */ }
};

/** The full classification (root · p · word · model · ms). Never throws; root null = unclear/unavailable. */
export async function classifyHandLine(text: string, opts: HandClassifierOptions = {}): Promise<HandPick & { readonly model: string | null; readonly ms: number }> {
  const line = text.replace(/\s+/gu, ' ').trim().slice(0, 600);
  if (!line) return { root: null, word: null, p: 0, model: null, ms: 0 };
  const table = opts.table ?? readHandRoutes();
  // The kit redacts the state, judges egress, owns the timeout + abort, the usage row and the 402 breaker. Under bun test
  // with no injected decision call it makes no live call (a test must never spend or wait on a provider).
  const deps: JevDecideDeps = opts.decide ? { transport: opts.decide } : {};
  const decided = await jevDecide({ site: SITE_ID, state: { line }, questions: { owner: handJevQuestion(table) }, timeoutMs: opts.timeoutMs ?? table.classifierTimeoutMs }, deps);
  if (!decided.ok) {
    // 관측 — every classification leaves one line (2130: the silent null hid a dead classifier for hours).
    note('msg.hand-classify', { root: null, p: 0, ms: decided.ms, model: null, error: decided.reason, ...(decided.status !== undefined ? { status: decided.status } : {}) });
    return { root: null, word: null, p: 0, model: null, ms: decided.ms };
  }
  const pick = pickHandRoot(decided.response.answers?.owner, table);
  const model = decided.response.model ?? null;
  note('msg.hand-classify', { root: pick.root, word: pick.word, p: Number(pick.p.toFixed(3)), ms: decided.ms, model });
  return { ...pick, model, ms: decided.ms };
}

/** The classifier the routers call (Jev). Null = unclear/unavailable (the caller keeps the old rung). Never throws. */
export async function cheapHandClassifier(text: string, opts: HandClassifierOptions = {}): Promise<HandRoot | null> {
  return (await classifyHandLine(text, opts)).root;
}
