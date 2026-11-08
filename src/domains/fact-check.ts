import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── fact_check — 팩트체크 캐스케이드 (커뮤니티 정성 감시 P0 · 2026-07-09) ──────
//
// PLAN-community-buzz-surveillance-2026-07-09 §5-①. 특정 사실/뉴스/이벤트가 실제로
// 있었는지 확인한다. 캐스케이드:
//   ① 내부 — elanous 가 발송한 리포트/알림 + 나눈 대화(surface_events) 먼저 검색.
//      있으면 출처와 함께 "내부에서 확인"(우리가 이미 봤/보낸 사실).
//   ② 외부 — 내부에 없거나 약하면 자동으로 X/레딧/웹(omni_search)까지 에스컬레이션.
//
// 대표 use-case: "게시판(내부) 보다가 특정 사실 발생했는지 FACT 체크 → 없으면 X·레딧 검색".
// P1/P2 에서 community_buzz.db(포럼 버즈)가 내부 소스로 합류하면 recallInternal 에 얹는다.
//
// READ-ONLY · fail-soft. bump=false — 팩트체크는 관찰이지 회상-사용이 아니라 미엘린 강화 안 함.

import { existsSync } from 'node:fs';

import { surfaceEventsDbPath, openSurfaceEventsDb, recallEvents, ftsQuery } from './surface-events.js';
import { searchArchive } from './memory-archive.js';
import { BUZZ_DB_PATH, openBuzzDb } from './community-buzz/store.js';

export type FactVerdict = 'found-internal' | 'found-external' | 'not-found';

export interface FactCheckHit {
  when: string;
  surface: string;
  kind: string | null;
  text: string;
  importance: number | null;
  score: number;
}

export interface InternalResult {
  hits: FactCheckHit[];
  archived: Array<{ when: string; summary: string | null }>;
}

export interface FactCheckOpts {
  query: string;
  /** 내부 조회 기간(시간). 기본 168=7일. */
  sinceHours?: number;
  /** 내부 반환 건수. 기본 6. */
  limit?: number;
  /** 내부 "확인" 판정 최소 스코어(0~1). 기본 0.35. */
  minInternalScore?: number;
  /** 내부에 없을 때 외부(X/레딧/웹) 에스컬레이션. 기본 true. */
  external?: boolean;
  /** 내부 종류 필터(선택) — alert|report|digest. 리포트 채널만 보려면 report/alert(채널롤 프록시). */
  kind?: string;
  /** 방향 필터(선택) — outbound(발송)|inbound(대화). 생략 시 둘 다. */
  direction?: 'outbound' | 'inbound';
}

export interface FactCheckDeps {
  /** 내부 검색(surface_events·vetted). 테스트 seam. */
  recallInternal?: (opts: Required<Pick<FactCheckOpts, 'query' | 'sinceHours' | 'limit'>> & Pick<FactCheckOpts, 'kind' | 'direction'>) => InternalResult;
  /** 외부 검색(뉴스/X/레딧). 테스트 seam. */
  searchExternal?: (query: string, recencyDays: number) => Promise<{ output: string; totalHits: number }>;
  /** 펨코(무필터 커뮤니티) 회자 검색 — 미검증 신호. 테스트 seam. */
  searchCommunity?: (query: string, limit: number) => FactCheckHit[];
}

export interface FactCheckResult {
  verdict: FactVerdict;
  query: string;
  internal: FactCheckHit[];
  archived?: Array<{ when: string; summary: string | null }>;
  external?: { output: string; totalHits: number } | null;
  /** ⚠️ 펨코 회자(무필터·미검증) — verdict 에 안 씀. rumor≠fact. 별도 참고 신호. */
  community?: FactCheckHit[];
  note: string;
}

// ── 관련성 게이트 ────────────────────────────────────────────────────
// ⚠️ FTS OR-prefix + recency 가중 스코어만으론 오판한다(라이브 실증 2026-07-09):
// "SpaceX Starship test flight outcome" 가 일반 토큰(test/latest/outcome)으로 elanous
// 자기 로그(backtest/delegate)와 매칭 → 무관한데 score 0.73 → 거짓 '내부확인'.
// → 질의의 '유의 토큰'이 실제 히트 본문에 있어야 내부확인으로 인정(정밀도 우선).

const FACT_STOPWORDS = new Set<string>([
  'test', 'tests', 'testing', 'latest', 'outcome', 'result', 'results', 'news', 'update', 'updates',
  'the', 'a', 'an', 'of', 'on', 'in', 'to', 'and', 'for', 'is', 'was', 'are', 'be', 'it', 'this', 'that',
  'run', 'running', 'check', 'report', 'reported', 'reportedly', 'big', 'new', 'about', 'with',
  '뉴스', '발표', '진짜', '정말', '이거', '그거', '저거', '오늘', '어제', '내일', '관련', '소식', '확인', '발생', '있었', '있나', '했나',
]);

/** 질의에서 유의 토큰 추출 — 일반/시스템 불용어·1글자 제거. */
export function significantTokens(query: string): string[] {
  return query.toLowerCase().replace(/["^*():.,?!·]/g, ' ').split(/\s+/)
    .filter(t => t.length > 1 && !FACT_STOPWORDS.has(t));
}

/** 관련성 판정 — 히트 본문(+요약)에 유의 토큰이 충분히 있나. substring 이라 한국어 prefix
 *  자동 처리("삼성"⊂"삼성전자"). 60%(최소 1) 이상 존재 요구 — distinctive 명사 위주 매칭이라
 *  크로스링구얼/패러프레이즈(flight↔궤도) 관용하되 무관 로그는 배제. 토큰 0=통과. */
export function relevanceOk(hay: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const need = Math.max(1, Math.ceil(tokens.length * 0.6));
  const lc = hay.toLowerCase();
  const present = tokens.filter(t => lc.includes(t)).length;
  return present >= need;
}

/** 순수 판정 — 내부 top 스코어·외부 히트 → verdict. IO 없음(단위테스트 대상). */
export function decideVerdict(
  internalTop: number,
  externalHits: number | null,
  minInternalScore: number,
): FactVerdict {
  if (internalTop >= minInternalScore) return 'found-internal';
  if (externalHits != null && externalHits > 0) return 'found-external';
  return 'not-found';
}

/** 펨코 인기글 검색 — buzz_fts 매칭 + 관련성 게이트. **인기글(lane=popular)만**(대표 지시:
 *  전체글 개인 잡담은 노이즈라 제외·인기글은 crowd 추천·검증돼 의미 있음). 저장은 전체 유지.
 *  importance+recency 스코어. */
function searchCommunityBuzz(query: string, limit: number, nowMs: number): FactCheckHit[] {
  if (!existsSync(BUZZ_DB_PATH)) return [];
  const db = openBuzzDb();
  try {
    const rows = db.prepare(
      `SELECT bp.title, bp.url, bp.importance, bp.tickers, bp.fetch_ts, bp.recommends, bp.comments
       FROM buzz_fts f JOIN buzz_posts bp ON bp.id = f.id
       WHERE buzz_fts MATCH ? AND bp.lane = 'popular'
       ORDER BY COALESCE(bp.recommends,0) DESC, COALESCE(bp.importance,0) DESC, bp.fetch_ts DESC LIMIT ?`,
    ).all(ftsQuery(query), limit * 3) as Array<{ title: string; url: string | null; importance: number | null; tickers: string | null; fetch_ts: string; recommends: number | null; comments: number | null }>;
    const toks = significantTokens(query);
    return rows.filter(r => relevanceOk(r.title, toks)).slice(0, limit).map(r => {
      const ageH = Math.max(0, (nowMs - Date.parse(r.fetch_ts)) / 3.6e6);
      // crowd 검증 가중 — 추천 많을수록 신뢰(인기글). recency + importance + 추천.
      const crowd = Math.min(1, (r.recommends ?? 0) / 50);
      const score = Math.round((0.4 * Math.exp(-ageH / 72) + 0.3 * ((r.importance ?? 3) / 10) + 0.3 * crowd) * 1000) / 1000;
      const badge = `👍${r.recommends ?? 0}${r.comments ? `·💬${r.comments}` : ''}`;
      return {
        when: r.fetch_ts, surface: 'community-popular', kind: 'buzz',
        text: `[${badge}] ${r.title}${r.tickers ? ` [${r.tickers}]` : ''}${r.url ? ` ${r.url}` : ''}`.slice(0, 400),
        importance: r.importance, score,
      };
    });
  } catch { return []; } finally { db.close(); }
}

/** 기본 내부 검색 — surface_events(elanous 가 발송한 vetted 원장)만. 검증(verdict)의 근거.
 *  ⚠️ 펨코(무필터 커뮤니티)는 여기 안 넣는다 — rumor 를 confirmed 로 오인하면 위험(대표 지적).
 *  펨코는 factCheck 가 별도 '미검증 회자' 신호로 다룬다. */
function defaultRecallInternal(
  opts: Required<Pick<FactCheckOpts, 'query' | 'sinceHours' | 'limit'>> & Pick<FactCheckOpts, 'kind' | 'direction'>,
): InternalResult {
  if (!existsSync(surfaceEventsDbPath())) return { hits: [], archived: [] };
  const toks = significantTokens(opts.query);
  const db = openSurfaceEventsDb();
  try {
    const raw = recallEvents(db, {
      query: opts.query, sinceHours: opts.sinceHours, limit: Math.max(opts.limit, 20),
      bump: false, // 관찰이지 회상-사용 아님
      ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.direction ? { direction: opts.direction } : {}),
    });
    const hits = raw.filter(h => relevanceOk(`${h.text} ${h.summary ?? ''}`, toks)).slice(0, opts.limit).map(h => ({
      when: h.ts, surface: h.surface, kind: h.kind, text: h.text.slice(0, 400),
      importance: h.importance, score: Math.round(h.score * 1000) / 1000,
    }));
    const archived = searchArchive(db, opts.query, { limit: 3 }).map(a => ({ when: a.ts, summary: a.summary }));
    return { hits, archived };
  } catch { return { hits: [], archived: [] }; } finally { db.close(); }
}

/** 기본 외부 검색 — omni_search(멀티 프로바이더·Grok 이 X/레딧 커버). 프로바이더 0 이면 totalHits=0. */
async function defaultSearchExternal(query: string, recencyDays: number): Promise<{ output: string; totalHits: number }> {
  try {
    const { dispatchOmniSearch } = await import('../skills/tools/omni-search.js');
    const r = await dispatchOmniSearch({ query, recency_days: recencyDays, limit: 6 });
    return { output: r.output, totalHits: r.metadata.totalHits };
  } catch (e) {
    return { output: `외부 검색 실패: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`, totalHits: 0 };
  }
}

/** 팩트체크 캐스케이드 — 내부(surface_events) → 외부(X/레딧/웹). READ-ONLY·fail-soft. */
export async function factCheck(opts: FactCheckOpts, deps: FactCheckDeps = {}): Promise<FactCheckResult> {
  const sinceHours = opts.sinceHours ?? 168;
  const limit = opts.limit ?? 6;
  const minInternalScore = opts.minInternalScore ?? 0.35;
  const externalEnabled = opts.external !== false;
  const recallInternal = deps.recallInternal ?? defaultRecallInternal;
  const searchExternal = deps.searchExternal ?? defaultSearchExternal;
  const searchCommunity = deps.searchCommunity ?? ((q, l) => searchCommunityBuzz(q, l, Date.now()));

  // 검증(verdict) 근거 = vetted 발송(surface_events) + 외부 뉴스. 펨코는 별도(미검증).
  const internal = recallInternal({ query: opts.query, sinceHours, limit, ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.direction ? { direction: opts.direction } : {}) });
  const topScore = internal.hits[0]?.score ?? 0;
  // 펨코 회자(무필터·미검증) — 리포트-전용 필터(kind/direction) 조회 시엔 제외.
  const community = (opts.kind || opts.direction) ? [] : searchCommunity(opts.query, limit);
  const commNote = community.length ? ` · 🔥 펨코 인기글 ${community.length}건 회자(crowd 추천·참고)` : '';
  const base = {
    query: opts.query, internal: internal.hits,
    ...(internal.archived.length ? { archived: internal.archived } : {}),
    ...(community.length ? { community } : {}),
  };

  // ① vetted 내부에서 확인 → 외부 비용 절약.
  if (topScore >= minInternalScore) {
    return { ...base, verdict: 'found-internal', note: `내부(elanous 발송 리포트/대화)에서 확인 — 상위 ${topScore}${commNote}` };
  }

  // ② 외부(뉴스/X/레딧) 에스컬레이션.
  if (externalEnabled) {
    const recencyDays = Math.max(1, Math.round(sinceHours / 24));
    const external = await searchExternal(opts.query, recencyDays);
    const verdict = decideVerdict(topScore, external.totalHits, minInternalScore);
    const note = external.totalHits > 0
      ? `외부(뉴스/X/레딧)에서 ${external.totalHits}건 확인${commNote}`
      : community.length
        ? `⚠️ 뉴스/발송엔 근거 없음 · 펨코 인기글만 ${community.length}건 회자 = 선행 신호일 수 있으나 아직 미검증(뉴스 대기)`
        : '내부·외부 모두 근거 없음 — 확인 안 됨(허위/미발생 가능성).';
    return { ...base, verdict, external, note };
  }

  return { ...base, verdict: 'not-found', external: null, note: `외부 미검색(external=false)${commNote}` };
}

export const FACT_CHECK_SPEC: LLMToolSpec = {
  name: 'fact_check',
  description: "⭐ 팩트체크 캐스케이드 (코어) — 특정 사실/뉴스가 실제로 있었는지 확인. **검증(verdict)** = ① elanous 가 발송한 vetted 리포트/대화(surface_events) → ② 없으면 외부 뉴스/X/레딧(omni_search) 에스컬레이션. verdict = found-internal|found-external|not-found. **★ 펨코(에펨코리아) 회자는 검증 근거로 안 씀 — 대신 별도 'community' 필드에 참고로 표시. 단 crowd 가 추천·검증한 인기글만(전체글 개인 잡담은 노이즈라 제외)**. 뉴스에 없는데 펨코 인기글만 회자 = 선행 신호 가능(미검증·뉴스 대기). '이거 진짜야?' '그 뉴스 났어?' 급 사실확인에 사용. READ-ONLY·fail-soft. (과거 발송 회상만=memory_recall · 순수 웹검색=OmniSearch 와 구분.)",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '확인할 사실/뉴스/이벤트(자연어). 예: "엔비디아 어제 실적 서프라이즈"·"삼성 감산 발표".' },
      external: { type: 'boolean', description: '내부에 없을 때 외부(X/레딧/웹) 에스컬레이션 여부(기본 true).' },
      kind: { type: 'string', description: '내부 종류 필터(선택) — alert|report|digest. 리포트 채널만 보려면 report 또는 alert(채널롤 프록시).' },
      direction: { type: 'string', description: '방향 필터(선택) — outbound(발송)|inbound(대화). 생략 시 둘 다.' },
      sinceHours: { type: 'number', description: '내부 조회 기간 시간(기본 168=7일).' },
      limit: { type: 'number', description: '내부 반환 건수(기본 6).' },
    },
    required: ['query'],
  },
};

/** fact_check 코어 도구 dispatch. */
export async function dispatchFactCheck(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { error: 'fact_check: query(확인할 사실) 필요.' };
  try {
    return await factCheck({
      query,
      ...(args.external === false ? { external: false } : {}),
      ...(typeof args.kind === 'string' && args.kind ? { kind: String(args.kind) } : {}),
      ...(args.direction === 'inbound' || args.direction === 'outbound' ? { direction: args.direction } : {}),
      ...(typeof args.sinceHours === 'number' ? { sinceHours: args.sinceHours } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    });
  } catch (e) {
    return { error: `팩트체크 실패: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
  }
}
