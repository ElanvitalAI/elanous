// HARNESS-ADVISOR-CHECKPOINTS — 코어의 올림 규칙 모듈(별도 호출 경로 없음 · 대표 11-17 «한 몸 원칙»).
// 출처: seat-state/ELN-DOGFOOD/ASK-RIFLE-NOT-TANK-HARNESS-1117.md §네 칸 2 · §강·중·약 섞기 정책 v0 «강» 행.
//
// 강 모델은 세 순간에만 쓴다: ① 계획 직전(설계·불변식·실패 경로 표) ② 같은 오류 2회 ③ 완료 직전 판정.
// 순간 판정(상태·한 번씩)은 `escalation-rules.ts`(OP-SHADOW-OPUS · eln/harness-advisor-checkpoints 91c170f457)를 그대로 쓴다.
// 이 파일은 그 판정을 코어에 잇는다:
//   - `ADVISOR_ESCALATE_RULE` — 코어 `decide` 의 모듈 규칙. `checkpoint` 가 있을 때만 «강» 을 제안한다.
//     ⛔ L1~3 일감의 ①·③ 은 제안하지 않는다(소총 일에 탱크 금지) · ② 같은 오류 2회는 등급과 무관.
//   - `createCoreAdvisor` — 고 루프가 부르는 얇은 런타임. 모든 상담은 `core.decide` 를 지나고 결정 원장 한 줄을 남긴다.
//     그림자(기본)는 «상담했을 것»만 적고 부르지 않는다. `on` ⊕ 클라이언트가 있을 때만 실제로 부른다.
//     부르는 동안만 호출 문맥(AsyncLocalStorage)을 강·`advisor:<순간>` 으로 건다 = 즉시 내림(손일은 다시 약/중).
//     조언 문면은 고 루프 맥락에만 들어가고, 원장·로그에는 등급·계기·토큰·비용만 남는다.

import { createHash } from 'node:crypto';
import type {
  AccountState,
  AdvisorClient,
  AdvisorMoment,
  CoreDecisionInput,
  CoreDecisionLedgerRecord,
  CoreMode,
  EscalateRule,
  ModelOrchestrationCore,
  WorkMoment,
  WorkSignals,
} from './orchestration-core.js';
import { initialEscalationState, judgeEscalation, type EscalationEvent, type EscalationMoment, type EscalationState } from './escalation-rules.js';
import { isRiskyLevel } from './work-risk-router.js';
import { STRONG_OUTPUT_MAX_TOKENS, runWithWorkTierContext } from './work-tier-policy.js';

/** 공급자가 max_tokens 를 무시할 때의 뒷받침 — 400 토큰 상한 × 토큰당 약 4자(출처: ASK §2 «≤400 토큰»). */
export const ADVISOR_MAX_CHARS = STRONG_OUTPUT_MAX_TOKENS * 4;

const MOMENT_OF: Readonly<Record<EscalationMoment, AdvisorMoment>> = {
  'before-plan': 'plan', 'same-error-twice': 'same-error', 'before-complete': 'pre-complete',
};

const WORK_MOMENT_OF: Readonly<Record<AdvisorMoment, WorkMoment>> = {
  plan: 'design', 'same-error': 'design', 'pre-complete': 'judge',
};

export const ADVICE_HEADER: Readonly<Record<AdvisorMoment, string>> = {
  plan: '[advisor · 계획 직전]',
  'same-error': '[advisor · 같은 오류 2회]',
  'pre-complete': '[advisor · 완료 직전 판정]',
};

/** 코어 모듈 규칙 — 상담 순간에만 «강» 제안. */
export const ADVISOR_ESCALATE_RULE: EscalateRule = {
  name: 'advisor-checkpoints',
  propose: ({ input }) => {
    const moment = input.checkpoint;
    if (!moment) return null;
    if (moment !== 'same-error' && !isRiskyLevel(input.work.level)) return null;
    return { trigger: `advisor:${moment}`, target: 'strong' };
  },
};

/** 오류 서명 → 원장용 키(해시 앞 12자). 오류 문면은 원장에 넣지 않는다. */
export function advisorErrorKey(signature: string): string {
  return createHash('sha256').update(signature).digest('hex').slice(0, 12);
}

export interface CoreAdvisorOptions {
  readonly core: ModelOrchestrationCore;
  readonly runId: string;
  readonly provider: string;
  readonly work: WorkSignals;
  readonly mode: CoreMode;
  /** COST-OPTIMIZER-WINDOW-AWARE — 계정·창 스냅숏(대칭: 발사와 같은 선택기를 거친다). 상담은 프로세스 계정으로 나가므로 호출측이 shadow 로 고정해 넘긴다. */
  readonly accounts?: () => AccountState | undefined;
  readonly client?: AdvisorClient;
  /** 결정 원장 한 줄(호출측이 런 원장·logs.db 로 보낸다). 실패는 고 루프를 막지 않는다. */
  readonly record?: (record: CoreDecisionLedgerRecord, atMs: number) => void;
  readonly now?: () => number;
  readonly onError?: (moment: AdvisorMoment, error: unknown) => void;
  /** 계획·완료 상담을 «런마다 한 번»으로 묶는 표 — 같은 런이 고 루프에 다시 들어와도 다시 묻지 않는다(Opus 리뷰 sf5).
   *  기본 = 프로세스 공용 표. 시험은 새 Set 을 넘긴다. */
  readonly onceRegistry?: Set<string>;
}

const PROCESS_ONCE_REGISTRY = new Set<string>();

export interface AdvisorAdvice {
  readonly moment: AdvisorMoment;
  readonly text: string;
  readonly block: string;
  /** 응답이 상한을 넘어 잘렸나(토큰 보고 또는 글자 수 기준). */
  readonly clipped: boolean;
}

export interface CoreAdvisor {
  /** ① 첫 턴 직전 — 한 번만. */
  plan(objective: string): Promise<AdvisorAdvice | undefined>;
  /** 실패한 도구 결과를 센다 — 같은 서명이 «두 번째»일 때만 서명을 돌려준다(상한 안에서). */
  noteToolResult(name: string, result: unknown): string | undefined;
  /** ② 같은 오류 2회 — 모인 서명으로 한 번 상담. */
  sameError(objective: string, signatures: readonly string[]): Promise<AdvisorAdvice | undefined>;
  /** ③ 완료 직전 — 루프당 한 번 · 남은 라운드가 있을 때만. */
  beforeComplete(objective: string, evidence: string, round: { iteration: number; maxIterations: number; aborted?: boolean }): Promise<AdvisorAdvice | undefined>;
}

export function createCoreAdvisor(options: CoreAdvisorOptions): CoreAdvisor {
  const now = options.now ?? Date.now;
  const once = options.onceRegistry ?? PROCESS_ONCE_REGISTRY;
  const firstForRun = (moment: AdvisorMoment): boolean => {
    const key = `${options.runId}\u0000${moment}`;
    if (once.has(key)) return false;
    once.add(key);
    return true;
  };
  let state: EscalationState = initialEscalationState();
  const judge = (event: EscalationEvent) => {
    const next = judgeEscalation(state, event);
    state = next.state;
    return next.decision;
  };
  const consult = async (moment: AdvisorMoment, prompt: { objective: string; detail: string }, errorKey?: string): Promise<AdvisorAdvice | undefined> => {
    const input: CoreDecisionInput = {
      runId: options.runId, moment: WORK_MOMENT_OF[moment], provider: options.provider, work: options.work, checkpoint: moment,
      ...(moment === 'same-error' ? { failures: { sameErrorCount: 2, ...(errorKey ? { errorKey } : {}) } } : {}),
      ...(() => { try { const accounts = options.accounts?.(); return accounts ? { accounts } : {}; } catch { return {}; } })(),
    };
    const decision = options.core.decide(input);
    if (decision.trigger !== `advisor:${moment}`) return undefined; // 규칙이 상담을 안 고른 순간(L1~3 의 ①·③)
    const readFailed = input.accounts?.routerMix?.codexReadFailed === true;
    const call = options.mode === 'on' && options.client !== undefined && decision.model !== null && !readFailed;
    const skip = options.mode !== 'on' ? 'shadow' : !options.client ? 'no-advisor-client' : readFailed ? 'account-window-read-failed' : decision.model === null ? 'no-tier-ladder' : null;
    try {
      options.record?.(options.core.decisionRecord(decision, input, {
        mode: options.mode, applied: call, skip, launched: { provider: decision.provider, model: call ? decision.model : null },
      }), now());
    } catch { /* 관측은 루프를 막지 않는다 */ }
    if (!call) return undefined;
    const maxOutputTokens = decision.maxOutputTokens ?? STRONG_OUTPUT_MAX_TOKENS;
    let reply: Awaited<ReturnType<AdvisorClient['advise']>>;
    try {
      // 상담 한 번만 강·advisor:<순간> 문맥 — 감싼 비동기 사슬이 끝나면 자동으로 내려온다(즉시 내림).
      // ROUTER-OR-CODEX-MIX-CHOKEPOINT(OP #132227) — 결정 id 를 호출 문맥에 실어 보낸다: 같은 id 가 llm.usage 줄(routeDecisionId)까지 결속된다.
      reply = await runWithWorkTierContext({ tier: decision.tier, trigger: decision.trigger, decisionId: decision.decisionId }, () => options.client!.advise({
        runId: options.runId, moment, provider: decision.provider, model: decision.model!, maxOutputTokens, prompt,
      }));
    } catch (error) {
      options.onError?.(moment, error);
      return undefined;
    }
    const chars = Array.from(typeof reply.advice === 'string' ? reply.advice.trim() : '');
    if (chars.length === 0) return undefined;
    const overTokens = typeof reply.outputTokens === 'number' && reply.outputTokens > maxOutputTokens;
    const clipped = overTokens || chars.length > ADVISOR_MAX_CHARS;
    const text = chars.length > ADVISOR_MAX_CHARS ? `${chars.slice(0, ADVISOR_MAX_CHARS).join('')}…` : chars.join('');
    return { moment, text, block: `${ADVICE_HEADER[moment]}\n${text}`, clipped };
  };
  return {
    async plan(objective) {
      const decision = judge({ kind: 'turn-start', iteration: 1 });
      return decision.escalate && firstForRun('plan') ? consult(MOMENT_OF[decision.moment], { objective, detail: '' }) : undefined;
    },
    noteToolResult(name, result) {
      const decision = judge({ kind: 'tool-result', tool: name, result });
      return decision.escalate ? decision.reason.replace(/^same-error-twice:/, '') : undefined;
    },
    async sameError(objective, signatures) {
      if (signatures.length === 0) return undefined;
      return consult('same-error', { objective, detail: signatures.join('\n') }, advisorErrorKey(signatures.join('\n')));
    },
    async beforeComplete(objective, evidence, round) {
      const decision = judge({ kind: 'completion-claim', iteration: round.iteration, maxIterations: round.maxIterations, ...(round.aborted ? { aborted: true } : {}) });
      return decision.escalate && firstForRun('pre-complete') ? consult(MOMENT_OF[decision.moment], { objective, detail: evidence }) : undefined;
    },
  };
}
