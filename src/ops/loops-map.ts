import type { LoopRow, OverviewSnapshot } from './overview.js';

/** 루프 지도의 한 칸 — 캐시 스냅숏의 루프 행을 그대로 옮긴다(합성 없음). */
export interface LoopsMapRow {
  name: string;
  era: LoopRow['era'];
  /** 이 주기 이상 박동이 없으면 정지로 본다. null = 주기 미상(판정에서 뺀다) — 캐시 값 그대로. */
  staleAfterSeconds: number | null;
  /** 박동 칸: 못 잼이면 value·observedAt 이 null 이고 reason 이 남는다(캐시 그대로). */
  beat: LoopRow['beat'];
}

/**
 * LOOP-MAP-API 응답 — overviewCache 의 loops 스냅숏만 투영한 것.
 * edges(loop-edges 결합)는 후속 조각이라 여기에 넣지 않는다.
 */
export interface LoopsMap {
  /** 캐시 스냅숏이 만든 시각. 캐시가 비면 null. */
  generatedAt: string | null;
  /** 요청 시각(캐시 시계)과 generatedAt 의 차이. 캐시가 비면 null. */
  cacheAgeMs: number | null;
  loops: LoopsMapRow[];
}

/** 캐시 미스 응답 — 원격 조회를 유발하지 않고 «아직 캐시 없음»을 그대로 말한다. */
const EMPTY_LOOPS_MAP: LoopsMap = { generatedAt: null, cacheAgeMs: null, loops: [] };

/**
 * overviewCache.peek() 결과 하나를 루프 지도 응답으로 투영한다.
 * `at` 은 캐시의 시계로 잰 «읽은 시각»이라 가짜 시계를 주입하면 cacheAgeMs 가 결정적이다.
 * 여기서 원천을 더 읽지 않는다 — 순수 투영이다.
 */
export function loopsMapFromCache(peeked: { snapshot: OverviewSnapshot; at: number } | null): LoopsMap {
  if (!peeked) return EMPTY_LOOPS_MAP;
  const generatedAtMs = Date.parse(peeked.snapshot.generatedAt);
  return {
    generatedAt: peeked.snapshot.generatedAt,
    cacheAgeMs: Number.isFinite(generatedAtMs) ? Math.max(0, peeked.at - generatedAtMs) : null,
    loops: peeked.snapshot.loops.map((loop) => ({
      name: loop.name,
      era: loop.era,
      staleAfterSeconds: loop.staleAfterSeconds,
      beat: loop.beat,
    })),
  };
}
