import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── 다이나믹 트레일링 손절 (일반화 · 도구화 · P2c · 2026-07-09) ─────────
//
// koru-trailing.ts §4의 트레일링 손절을 임의 레버리지 종목에 적용 가능하게
// 일반화 + 손절 폭을 디깅 신호(풋콜/국면/변동성)로 변조(tightness). 통화 중립
// (달러/원 무관·비율만). READ-ONLY 계산 — 실제 청산은 executeAutonomousTrade 게이트.
//
// P3 에서 koru-trailing 익절 래더·state 와 완전 통합 예정. 여기선 손절 계산+도구화.
// 설계: 내부 문서 `DESIGN-leverage-decision-agent-2026-07-09` §9(P2c).



// 기준 손절 폭(koru-trailing §4 유래). tightness 로 변조.
export const BASE_TRIM25_PCT = 0.05;   // 고가 -5%  → 25% 현금화
export const BASE_TRIM50_PCT = 0.08;   // 고가 -8%  → 50% 현금화
export const BASE_EXIT_PCT = 0.115;    // 고가 -11.5% → 전량(본전 클램프)

export type TrailingAction = 'HOLD' | 'TRIM_25' | 'TRIM_50' | 'EXIT_ALL';

export interface StopSignals {
  /** 풋콜레이쇼(미결제 P/C). >=1.2 하방헤지↑ → 타이트. <=0.8 콜우위 → 여유. */
  putCallRatio?: number;
  /** 국면 라벨(RISK_ON/RISK_OFF/NEUTRAL/BEAR_CASH 등). */
  regimeLabel?: string;
  /** 변동성 %(VIX/ATR 등·클수록 타이트). */
  volatilityPct?: number;
}

/** 디깅 신호 → tightness 계수 [0.6, 1.3]. <1 = 손절 타이트(작은 하락에 발동),
 *  >1 = 여유(더 큰 하락 허용). 순수·결정론. */
export function deriveTightness(sig: StopSignals): number {
  let t = 1.0;
  if (sig.putCallRatio !== undefined) {
    if (sig.putCallRatio >= 1.5) t -= 0.25;        // 강한 하방 헤지 → 타이트
    else if (sig.putCallRatio >= 1.2) t -= 0.12;
    else if (sig.putCallRatio <= 0.8) t += 0.12;   // 콜 우위 → 여유
  }
  const r = (sig.regimeLabel ?? '').toUpperCase();
  if (r.includes('RISK_OFF') || r.includes('BEAR')) t -= 0.15;
  else if (r.includes('RISK_ON') || r.includes('BULL')) t += 0.10;
  if (sig.volatilityPct !== undefined) {
    if (sig.volatilityPct >= 30) t -= 0.15;         // 고변동 → 타이트
    else if (sig.volatilityPct >= 20) t -= 0.08;
  }
  return Math.max(0.6, Math.min(1.3, t));
}

export interface DynamicStops {
  symbol: string;
  highwater: number;
  current: number;
  entryPrice: number | null;
  tightness: number;
  trim25: number;
  trim50: number;
  exitAll: number;
  entryFloorApplied: boolean;
  action: TrailingAction;
  note: string;
}

export interface DynamicStopsInput {
  symbol: string;
  current: number;
  /** 추적 고가(없으면 current). */
  highwater?: number;
  /** 본전(있으면 exit 이 그 아래로 안 내려감·null=클램프 안 함). */
  entryPrice?: number | null;
  signals?: StopSignals;
  /** 직접 지정(0.6~1.3·신호 파생보다 우선). */
  tightness?: number;
}

export function computeDynamicStops(input: DynamicStopsInput): DynamicStops {
  const current = input.current;
  const highwater = Math.max(input.highwater ?? current, current); // 오르면 따라 올림
  const entryPrice = input.entryPrice ?? null;
  const tightness = input.tightness ?? deriveTightness(input.signals ?? {});

  const trim25 = highwater * (1 - BASE_TRIM25_PCT * tightness);
  const trim50 = highwater * (1 - BASE_TRIM50_PCT * tightness);
  const rawExit = highwater * (1 - BASE_EXIT_PCT * tightness);
  const exitAll = entryPrice != null ? Math.max(rawExit, entryPrice) : rawExit; // 본전 아래 금지
  const entryFloorApplied = entryPrice != null && entryPrice > rawExit;

  let action: TrailingAction = 'HOLD';
  if (current <= exitAll) action = 'EXIT_ALL';
  else if (current <= trim50) action = 'TRIM_50';
  else if (current <= trim25) action = 'TRIM_25';

  const fx = (n: number): number => Number(n.toFixed(2));
  return {
    symbol: input.symbol, highwater: fx(highwater), current: fx(current), entryPrice,
    tightness: fx(tightness), trim25: fx(trim25), trim50: fx(trim50), exitAll: fx(exitAll),
    entryFloorApplied, action,
    note: `tightness ${tightness.toFixed(2)} · 고가 ${fx(highwater)} → trim25 ${fx(trim25)} / trim50 ${fx(trim50)} / exit ${fx(exitAll)}`
      + `${entryFloorApplied ? '(본전 클램프)' : ''} · 현재 ${fx(current)} → ${action}`,
  };
}

// ── 도구화 — 레버리지 결정 에이전트가 손절선을 계산해 결정에 넣도록 ─────────
export function buildTrailingStopsTool(): LLMToolSpec {
  return {
    name: 'trailing_stops',
    description:
      '다이나믹 트레일링 손절선 계산(레버리지 종목·통화중립). 고가 대비 3단(trim25/trim50/exitAll) + 본전 ' +
      '클램프(entryPrice 아래로 exit 안 내림). 손절 폭은 디깅 신호로 변조(tightness): 풋콜↑·고변동·약세국면 ' +
      '→ 타이트(작은 하락에 발동), 콜우위·강세 → 여유. 결정 전에 호출해 손절선을 구하고 ' +
      'submit_trade_decision 의 stops 에 넣어라. READ-ONLY 계산.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '대상 심볼(예: 122630.KO, KORU.US).' },
        current: { type: 'number', description: '현재가.' },
        highwater: { type: 'number', description: '추적 고가(없으면 current).' },
        entryPrice: { type: 'number', description: '본전(있으면 exit 이 그 아래로 안 내려감).' },
        putCallRatio: { type: 'number', description: '풋콜레이쇼(미결제 P/C·>=1.2 타이트).' },
        regimeLabel: { type: 'string', description: '국면(RISK_ON/RISK_OFF/BEAR_CASH 등).' },
        volatilityPct: { type: 'number', description: '변동성 %(VIX/ATR·>=20 타이트).' },
        tightness: { type: 'number', description: '직접 지정(0.6~1.3·신호보다 우선).' },
      },
      required: ['symbol', 'current'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTrailingStops(raw: Record<string, unknown>): Promise<unknown> {
  const symbol = typeof raw.symbol === 'string' ? raw.symbol : '';
  const current = typeof raw.current === 'number' ? raw.current : NaN;
  if (!symbol || !(current > 0)) return { error: 'symbol + 양수 current 필수.' };
  const signals: StopSignals = {
    ...(typeof raw.putCallRatio === 'number' ? { putCallRatio: raw.putCallRatio } : {}),
    ...(typeof raw.regimeLabel === 'string' ? { regimeLabel: raw.regimeLabel } : {}),
    ...(typeof raw.volatilityPct === 'number' ? { volatilityPct: raw.volatilityPct } : {}),
  };
  return computeDynamicStops({
    symbol, current,
    ...(typeof raw.highwater === 'number' ? { highwater: raw.highwater } : {}),
    ...(typeof raw.entryPrice === 'number' ? { entryPrice: raw.entryPrice } : {}),
    ...(typeof raw.tightness === 'number' ? { tightness: raw.tightness } : {}),
    signals,
  });
}
