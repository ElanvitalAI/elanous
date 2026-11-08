import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── submit_trade_decision 도구 (목표 방출형 · P2a · 2026-07-09) ──────────────
//
// 레버리지 결정 에이전트가 최종 결정을 방출하는 구조화 출력 도구. LLM 은 "목표
// 포지션 + 손절선"만 방출하고(주문 수량 직접 X), 결정론 코드가 현 포지션과 diff 해
// delta 주문을 계산한다(P2b·computeDeltaOrders). LLM=제안자·mandate=인가자.
//
// 안전(dry 단계에서도 강제): 심볼은 계약 화이트리스트 안에서만(환각 차단),
// confidence 0~1, action=adjust 면 targets 최소 1개. 검증 통과분만 getDecision 에
// 남는다(호스트가 runTurn 후 읽어 P2b 에서 집행 경로로 흘림).
//
// 설계: 내부 문서 `DESIGN-leverage-decision-agent-2026-07-09` §6.


import type { TradeContract } from './trade-contract.js';

export interface TradeDecisionTarget {
  symbol: string;
  /** 목표 보유액(원). targetWeight 와 택1. */
  targetKrw?: number;
  /** 목표 비중 0~1. targetKrw 와 택1. */
  targetWeight?: number;
  reason?: string;
}

export interface TradeDecisionStop {
  symbol: string;
  stopPrice?: number;
  note?: string;
}

export interface TradeDecision {
  action: 'hold' | 'adjust';
  targets: TradeDecisionTarget[];
  stops: TradeDecisionStop[];
  rationale: string;
  confidence: number;
  /** 디깅 근거(futuresOi/putCallRatio/foreignIntraday 등) — 감사 추적. */
  digEvidence?: Record<string, unknown>;
}

export interface SubmitDecisionTool {
  spec: LLMToolSpec;
  dispatch: (args: Record<string, unknown>) => Promise<unknown>;
  /** 마지막으로 방출된(검증 통과) 결정. 호스트가 runTurn 후 읽는다. */
  getDecision: () => TradeDecision | null;
}

export function buildSubmitDecisionTool(contract: TradeContract): SubmitDecisionTool {
  let last: TradeDecision | null = null;
  const focus = new Set(contract.focusSymbols);

  const spec: LLMToolSpec = {
    name: 'submit_trade_decision',
    description:
      '레버리지 계약의 최종 결정을 방출한다(목표 방출형). 목표 포지션 + 손절선만 — 주문 수량 직접 X. ' +
      'action=hold 면 targets 비움. targets 심볼은 계약 화이트리스트(' + contract.focusSymbols.join(', ') + ') ' +
      '안에서만. rationale·confidence(0~1)·digEvidence(디깅 근거) 포함. 지금은 dry 관측(집행 미배선·P2b).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['hold', 'adjust'], description: '조정 없으면 hold.' },
        targets: {
          type: 'array',
          description: '목표 포지션(심볼별). action=adjust 시 최소 1개.',
          items: {
            type: 'object',
            properties: {
              symbol: { type: 'string', description: '화이트리스트 심볼(예: 122630.KO, KORU.US).' },
              targetKrw: { type: 'number', description: '목표 보유액(원). targetWeight 와 택1.' },
              targetWeight: { type: 'number', description: '목표 비중 0~1. targetKrw 와 택1.' },
              reason: { type: 'string' },
            },
            required: ['symbol'],
          },
        },
        stops: {
          type: 'array',
          description: '손절선(심볼별·다이나믹).',
          items: {
            type: 'object',
            properties: {
              symbol: { type: 'string' },
              stopPrice: { type: 'number' },
              note: { type: 'string' },
            },
            required: ['symbol'],
          },
        },
        rationale: { type: 'string', description: '결정 근거(현물↔파생 종합).' },
        confidence: { type: 'number', description: '확신도 0~1.' },
        digEvidence: { type: 'object', description: '디깅 근거(futuresOi/putCallRatio/foreignIntraday 등).' },
      },
      required: ['action', 'rationale', 'confidence'],
      additionalProperties: false,
    },
  };

  const dispatch = async (raw: Record<string, unknown>): Promise<unknown> => {
    const r = validateDecision(raw, focus);
    if ('error' in r) return { ok: false, error: r.error };
    last = r.value;
    return {
      ok: true,
      recorded: 'dry',
      action: r.value.action,
      targetCount: r.value.targets.length,
      note: '결정 방출됨(dry 관측). 집행 미배선(P2b) — 실집행 시 mandate 게이트 적용.',
    };
  };

  return { spec, dispatch, getDecision: () => last };
}

/** 결정 검증(순수). 화이트리스트·범위 위반은 error. */
export function validateDecision(
  raw: Record<string, unknown>, focus: Set<string>,
): { value: TradeDecision } | { error: string } {
  const action = raw.action;
  if (action !== 'hold' && action !== 'adjust') return { error: "action 은 'hold' 또는 'adjust'." };

  const confidence = raw.confidence;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    return { error: 'confidence 는 0~1 숫자.' };
  }
  const rationale = typeof raw.rationale === 'string' ? raw.rationale : '';
  if (!rationale.trim()) return { error: 'rationale 필수.' };

  const rawTargets = Array.isArray(raw.targets) ? raw.targets : [];
  const targets: TradeDecisionTarget[] = [];
  for (const item of rawTargets) {
    if (!item || typeof item !== 'object') return { error: 'targets 항목은 객체.' };
    const t = item as Record<string, unknown>;
    const sym = t.symbol;
    if (typeof sym !== 'string' || !focus.has(sym)) {
      return { error: `target 심볼 '${String(sym)}' 은 화이트리스트(${[...focus].join(', ')}) 밖 — 거부.` };
    }
    const tk = t.targetKrw, tw = t.targetWeight;
    if (tk !== undefined && (typeof tk !== 'number' || tk < 0)) return { error: 'targetKrw 는 0 이상 숫자.' };
    if (tw !== undefined && (typeof tw !== 'number' || tw < 0 || tw > 1)) return { error: 'targetWeight 는 0~1.' };
    targets.push({
      symbol: sym,
      ...(typeof tk === 'number' ? { targetKrw: tk } : {}),
      ...(typeof tw === 'number' ? { targetWeight: tw } : {}),
      ...(typeof t.reason === 'string' ? { reason: t.reason } : {}),
    });
  }
  if (action === 'adjust' && targets.length === 0) return { error: "action='adjust' 면 targets 최소 1개." };

  const rawStops = Array.isArray(raw.stops) ? raw.stops : [];
  const stops: TradeDecisionStop[] = [];
  for (const item of rawStops) {
    if (!item || typeof item !== 'object') return { error: 'stops 항목은 객체.' };
    const s = item as Record<string, unknown>;
    const sym = s.symbol;
    if (typeof sym !== 'string' || !focus.has(sym)) {
      return { error: `stop 심볼 '${String(sym)}' 화이트리스트 밖.` };
    }
    const sp = s.stopPrice;
    if (sp !== undefined && (typeof sp !== 'number' || sp < 0)) return { error: 'stopPrice 는 0 이상.' };
    stops.push({
      symbol: sym,
      ...(typeof sp === 'number' ? { stopPrice: sp } : {}),
      ...(typeof s.note === 'string' ? { note: s.note } : {}),
    });
  }

  const digEvidence = (raw.digEvidence && typeof raw.digEvidence === 'object')
    ? raw.digEvidence as Record<string, unknown> : undefined;

  return {
    value: {
      action, targets, stops, rationale, confidence,
      ...(digEvidence ? { digEvidence } : {}),
    },
  };
}
