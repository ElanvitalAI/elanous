// KIT mail-route · hand classifier — Jev (Typesafe System One, the decision model) reads ONE unstructured ✋ block line and
// returns PROBABILITIES over the hand-routes.yaml `classifier` words (wip · jud · hold · guardian · approval · cell ·
// decision · unclear). It generates no text (대표 22:1x «분류기는 jev 로 · 결정 모델»). The top word wins only at or above
// `classifierMinProbability`; below it, or `unclear`, the ✋ is ambiguous and keeps its old rung (TC). Asked only when the
// block carries no structured `cause:` / `reason:` code that decides it (standing rule 11-20: no regex/keyword routing).
// Unavailable · slow · no key · malformed → null → the old first rung; it never blocks.
//
// 세 얼굴: 관측 = `msg.hand-classify {root, p, ms, model}` per call ⊕ usage row (providerName typesafe · site
// mail-route.hand-classify · role classify) · 판단 근거 = Jev probabilities ⊕ the YAML threshold · 수복과 인계 = null → old rung.
import type { JevAnswer, JevQuestion, JevRequest, JevResponse } from '../../decide/jev.js';
import { readHandRoutes, type HandRoot, type HandRoutesTable } from './hand-routes.js';

/** Fallback only — the timeout in force is hand-routes.yaml `classifierTimeoutSeconds`. */
export const HAND_CLASSIFY_TIMEOUT_MS = 8_000;
export const HAND_CLASSIFY_USAGE_SITE = 'mail-route.hand-classify';
const UNCLEAR = 'unclear';

/** The Jev choice question — the words and what each means are hand-routes.yaml `classifier` rows (a new root = a YAML row). */
export function handJevQuestion(table: HandRoutesTable = readHandRoutes()): JevQuestion {
  return {
    type: 'choice',
    instructions: 'An agent seat is blocked and wrote the line in state.line. Who can unblock it? Pick the owner whose description fits the line.',
    criteria: { ...Object.fromEntries(Object.entries(table.classifier).map(([word, row]) => [word, row.means])), [UNCLEAR]: 'none of the others fits, or not enough information' },
  };
}

export interface HandPick { readonly root: HandRoot | null; readonly word: string | null; readonly p: number }

/** The max-probability word → its root; below the YAML threshold, `unclear`, or unknown → root null. Pure over the table. */
export function pickHandRoot(answer: JevAnswer | undefined, table: HandRoutesTable = readHandRoutes()): HandPick {
  const probs = answer?.probabilities ?? (answer?.choice ? { [answer.choice]: 1 } : {});
  let word: string | null = null; let p = 0;
  for (const [w, v] of Object.entries(probs)) if (typeof v === 'number' && Number.isFinite(v) && v > p) { word = w; p = v; }
  if (word === null) return { root: null, word: null, p: 0 };
  const key = word.trim().toLowerCase();
  if (key === UNCLEAR || p < table.classifierMinProbability || !Object.hasOwn(table.classifier, key)) return { root: null, word: key, p };
  return { root: table.classifier[key]!.root, word: key, p };
}

/** The decision call: a Jev request → its response (default: Typesafe via src/decide/jev.ts). Tests and sims inject one. */
export type HandDecide = (req: JevRequest, signal: AbortSignal) => Promise<JevResponse>;

export interface HandClassifierOptions {
  readonly decide?: HandDecide;
  readonly timeoutMs?: number;
  readonly table?: HandRoutesTable;
}

function readDecideConfig(): Record<string, unknown> | undefined {
  try {
    const { getUserConfig } = require('../../user-config.js') as typeof import('../../user-config.js');
    const raw = getUserConfig().raw.decide;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** The live decision call: access as `elanous decide` resolves it (decide.endpoint > ELANOUS_JEV_ENDPOINT > Typesafe ⊕ key). */
async function jevDecide(req: JevRequest, signal: AbortSignal): Promise<JevResponse> {
  const { callJev, resolveJevAccess } = await import('../../decide/jev.js');
  const { existsSync, readFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const expand = (path: string): string => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
  const config = readDecideConfig();
  const resolved = resolveJevAccess({
    ...(config ? { config } : {}),
    env: process.env,
    readFile: (path) => { const file = expand(path); try { return existsSync(file) ? readFileSync(file, 'utf8') : undefined; } catch { return undefined; } },
    typesafeCachePath: join(homedir(), '.cache', 'typesafe_api_key'),
  });
  if (!resolved.ok) throw new Error('jev-no-key');
  const fetchWithAbort = ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal })) as typeof fetch;
  const response = await callJev({ ...req, ...(resolved.access.model ? { model: resolved.access.model } : {}) }, resolved.access.key, fetchWithAbort, resolved.access.endpoint);
  if (response.usage) {
    try {
      const { logAgentTurnUsage } = await import('../../llm.js');
      logAgentTurnUsage(response.model, { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        { providerName: 'typesafe', site: HAND_CLASSIFY_USAGE_SITE, role: 'classify' });
    } catch { /* usage observation never blocks routing */ }
  }
  return response;
}

const note = (event: string, data: Record<string, unknown>): void => {
  try { (require('../../debug/log.js') as typeof import('../../debug/log.js')).debug.log('msg', event, data); } catch { /* observation is fail-open */ }
};
const redact = (s: string): string => {
  try { return (require('../../debug/log.js') as typeof import('../../debug/log.js')).redactSecretText(s); } catch { return s; }
};

/** The full classification (root · p · word · model · ms). Never throws; root null = unclear/unavailable. */
export async function classifyHandLine(text: string, opts: HandClassifierOptions = {}): Promise<HandPick & { readonly model: string | null; readonly ms: number }> {
  const line = redact(text.replace(/\s+/gu, ' ').trim().slice(0, 600));
  if (!line) return { root: null, word: null, p: 0, model: null, ms: 0 };
  // Under bun test with no injected decision call: no live Jev (a test must never spend or wait on a provider).
  if (!opts.decide && (process.env.BUN_TEST !== undefined || process.env.NODE_ENV === 'test')) return { root: null, word: null, p: 0, model: null, ms: 0 };
  const table = opts.table ?? readHandRoutes();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? table.classifierTimeoutMs);
  const t0 = Date.now();
  try {
    const response = await Promise.race([
      (opts.decide ?? jevDecide)({ state: { line }, questions: { owner: handJevQuestion(table) } }, controller.signal),
      new Promise<never>((_, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }); }),
    ]);
    const pick = pickHandRoot(response.answers?.owner, table);
    const ms = Date.now() - t0;
    // 관측 — every classification leaves one line (2130: the silent null hid a dead classifier for hours).
    note('msg.hand-classify', { root: pick.root, word: pick.word, p: Number(pick.p.toFixed(3)), ms, model: response.model ?? null });
    return { ...pick, model: response.model ?? null, ms };
  } catch (error) {
    const ms = Date.now() - t0;
    note('msg.hand-classify', { root: null, p: 0, ms, model: null, error: String(error instanceof Error ? error.message : error).slice(0, 200) });
    return { root: null, word: null, p: 0, model: null, ms };
  } finally { clearTimeout(timer); }
}

/** The classifier the routers call (Jev). Null = unclear/unavailable (the caller keeps the old rung). Never throws. */
export async function cheapHandClassifier(text: string, opts: HandClassifierOptions = {}): Promise<HandRoot | null> {
  return (await classifyHandLine(text, opts)).root;
}
