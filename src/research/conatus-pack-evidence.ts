import type { ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import { debug } from '../debug/log.js';

/**
 * g6 CONATUS-PACK-STEP — the installed conatus-solution pack (Korea↔US sector map · capstone rules) as a BOUNDED, parallel
 * research prepass step. g5 only told the synthesis model to call KnowledgeQuery first; measured on the demo server the
 * model never called it (0 KnowledgeQuery calls), so the map never reached the answer. This step runs beside the web axes
 * and market-data (it never replaces or delays them), and its output is capped so a large pack cannot crowd the context.
 */
export const CONATUS_SOLUTION_PACK_ID = 'pack:conatus-solution@0.1.0';
/** Cards kept from the pack's ranked hits (most relevant first). */
export const CONATUS_PACK_CARD_LIMIT = 4;
/** Per-card body cap (characters). */
export const CONATUS_PACK_CARD_CHARS = 600;
/** Whole-section cap (characters) — the pack may hold many cards; the evidence it adds stays this small. */
export const CONATUS_PACK_SECTION_CHARS = 2_400;
/** The step's own time cap: a slow local pack store never holds the research turn. */
export const CONATUS_PACK_TIMEOUT_MS = 3_000;
export const CONATUS_PACK_SOURCE_KIND = 'knowledge-pack';
/** The label the answer uses for this evidence — research basis, never a live number source. */
export const CONATUS_PACK_LABEL = '연구 근거(코나투스)';

export interface PackHit { id: string; title: string; body: string; ref: string }
export interface PackQueryResult { pack_hits?: readonly PackHit[]; reason?: string }
export type PackQuery = (args: { question: string; pack_id: string }) => Promise<PackQueryResult>;

export interface ConatusPackEvidenceDeps {
  /** Default: the member-surface KnowledgeQuery dispatch (installed/bundled packs only · no vault). */
  query?: PackQuery;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => Date;
}

export interface ConatusPackEvidence {
  status: 'ok' | 'empty' | 'unavailable';
  evidence: ResearchEvidenceEnvelope[];
  section: string;
  cardCount: number;
  truncated: boolean;
}

/** Korean listings in the plan route (6-digit KRX codes) — the structured signal that this is a Korean market question. */
export function koreanRouteSymbols(symbols: readonly string[]): string[] {
  return symbols.filter((symbol) => /^\d{6}$/.test(symbol));
}

async function defaultPackQuery(args: { question: string; pack_id: string }): Promise<PackQueryResult> {
  const { dispatchInstalledPackQuery } = await import('../boot/installed-pack-query.js');
  return dispatchInstalledPackQuery(args);
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= max ? { text: chars.join(''), truncated: false } : { text: `${chars.slice(0, max - 1).join('')}…`, truncated: true };
}

/** Query the pack with a fixed sector-map question plus the route's KR codes (no user text), keep the top cards, cap size. */
export async function conatusPackEvidence(
  krSymbols: readonly string[],
  questionId: string,
  deps: ConatusPackEvidenceDeps = {},
): Promise<ConatusPackEvidence> {
  const query = deps.query ?? defaultPackQuery;
  const timeoutMs = deps.timeoutMs ?? CONATUS_PACK_TIMEOUT_MS;
  const startedAt = Date.now();
  const question = ['한국 섹터 미국 ETF 핵심 종목 연동 지도', ...krSymbols].join(' ');
  const unavailable = (reason: string): ConatusPackEvidence => {
    debug.log('research.pack', 'skipped', { packId: CONATUS_SOLUTION_PACK_ID, reason, durationMs: Date.now() - startedAt });
    return { status: 'unavailable', evidence: [], section: '', cardCount: 0, truncated: false };
  };
  if (deps.signal?.aborted) return unavailable('aborted');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: PackQueryResult;
  try {
    result = await Promise.race([
      query({ question, pack_id: CONATUS_SOLUTION_PACK_ID }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('pack-timeout')), timeoutMs); }),
    ]);
  } catch (error) {
    return unavailable(error instanceof Error && error.message === 'pack-timeout' ? 'timeout' : 'pack-search-failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const hits = result.pack_hits ?? [];
  if (hits.length === 0) {
    if (result.reason) return unavailable(result.reason);
    debug.log('research.pack', 'empty', { packId: CONATUS_SOLUTION_PACK_ID, durationMs: Date.now() - startedAt });
    return { status: 'empty', evidence: [], section: '', cardCount: 0, truncated: false };
  }
  const observedAt = (deps.now ?? (() => new Date()))().toISOString();
  const evidence: ResearchEvidenceEnvelope[] = [];
  const lines: string[] = [];
  let used = 0;
  let truncated = hits.length > CONATUS_PACK_CARD_LIMIT;
  for (const hit of hits.slice(0, CONATUS_PACK_CARD_LIMIT)) {
    const remaining = CONATUS_PACK_SECTION_CHARS - used;
    if (remaining < 80) { truncated = true; break; }
    const body = clip(`${hit.title}: ${hit.body}`, Math.min(CONATUS_PACK_CARD_CHARS, remaining));
    truncated ||= body.truncated;
    used += Array.from(body.text).length;
    lines.push(`- [${hit.ref}] ${body.text}`);
    evidence.push({
      questionId, sourceKind: CONATUS_PACK_SOURCE_KIND, source: hit.ref, observedAt,
      content: body.text, outcome: 'complete', truncated: body.truncated,
    });
  }
  debug.log('research.pack', 'complete', {
    packId: CONATUS_SOLUTION_PACK_ID, hitCount: hits.length, cardCount: evidence.length, chars: used, truncated,
    durationMs: Date.now() - startedAt,
  });
  const section = [
    `## ${CONATUS_PACK_LABEL} — ${CONATUS_SOLUTION_PACK_ID}`,
    '과거 연구·섹터 지도(한국 섹터 ↔ 미국 ETF·핵심 종목)다. 지금 시세·수급 수치의 출처가 아니다 — 수치는 시장데이터 절에서만 인용한다.',
    ...lines,
    ...(truncated ? [`(팩 카드 ${hits.length}장 중 관련도 상위 ${evidence.length}장만 실음 · 크기 상한 ${CONATUS_PACK_SECTION_CHARS}자)`] : []),
  ].join('\n');
  return { status: 'ok', evidence, section, cardCount: evidence.length, truncated };
}
