// 저잔액·구독 소진 알림 — 관문 결정이 «임계 아래라서» 행을 건너뛰고 폴백했을 때 우편 1건(행·레벨당 중복 억제).
// 임계는 새로 만들지 않는다: 구독 capPct(정책) · 크레딧 잔액 ≤ 0 / 잔액 < 예약+추정(결정 함수 규칙)이 곧 «레벨»이다.
// 켜짐 = 데이터 유무(정책이 있어 관문이 행을 건너뛴 경우만). 깃발·env 0.
// ⛔ 비밀 0: 행 이름·레벨·% · USD 만. 우편 실패는 삼킨다 — 관문 결정(go/stop)을 막지도 바꾸지도 않는다(fail-open 아님: 결정은 이미 났다).

import type { LlmSpendPolicyDoc, LlmSpendRowState } from '../nexus/llm-spend-policy/types.js';
import type { LlmSpendSkippedRow } from './llm-spend-decision.js';
import type { GuardMemoryStore } from './llm-spend-guard.js';

export interface LowBalanceMail { readonly row: string; readonly level: string; readonly subject: string; readonly body: string }
export type LowBalanceMailer = (mail: LowBalanceMail) => void | Promise<void>;

/** 결정 함수가 행을 건너뛴 사유 코드 → 심각도(높을수록 심하다). 같은 행에서 심각도가 «올라갈 때만» 새 우편. */
const LEVEL_RANK: Readonly<Record<string, number>> = { 'cap-pct-exhausted': 1, 'balance-insufficient': 1, 'balance-empty': 2 };

/** skipped.why 는 `코드(설명)` 꼴 — 코드만 뗀다(문자열 분해, 정규식 분류 0). */
const levelOf = (why: string): string => why.split('(')[0] ?? why;

function describe(policy: LlmSpendPolicyDoc, state: LlmSpendRowState | undefined, level: string): string {
  const row = policy.providers[state?.row ?? ''];
  if (level === 'cap-pct-exhausted') {
    const w = state?.window;
    const cap = row && 'capPct' in row ? row.capPct : undefined;
    return `구독 창 사용 ${w?.status === 'measured' ? `${w.usedPct}%` : '?'} / 상한 ${cap ?? '?'}%`;
  }
  const b = state?.balance;
  return `크레딧 잔액 ${b?.status === 'measured' ? `${b.usd} USD` : '?'}`;
}

export async function alertOnFallback(input: {
  readonly policy: LlmSpendPolicyDoc;
  readonly states: readonly LlmSpendRowState[];
  readonly skipped: readonly LlmSpendSkippedRow[];
  /** 이번 결정이 고른 행(멈춤이면 undefined). */
  readonly chosenRow?: string;
  readonly memory: GuardMemoryStore;
  readonly mailer: LowBalanceMailer;
}): Promise<void> {
  try {
    const mem = input.memory.load();
    const alerted: Record<string, string> = { ...(mem.alerted ?? {}) };
    let changed = false;
    if (input.chosenRow !== undefined && input.chosenRow in alerted) { delete alerted[input.chosenRow]; changed = true; } // 회복 = 그 행이 다시 선택됨 → 재무장
    for (const skip of input.skipped) {
      const level = levelOf(skip.why);
      const rank = LEVEL_RANK[level];
      if (rank === undefined) continue;
      const prev = alerted[skip.row];
      if (prev === level) continue;
      const escalated = prev === undefined || rank > (LEVEL_RANK[prev] ?? 0);
      if (escalated) {
        const fellTo = input.chosenRow !== undefined ? `폴백 행 ${input.chosenRow}` : '폴백 없음(멈춤)';
        try {
          await input.mailer({
            row: skip.row, level, subject: `LLM 임계 알림 ${skip.row} ${level}`,
            body: `행 ${skip.row} 레벨 ${level}: ${describe(input.policy, input.states.find((s) => s.row === skip.row), level)} → ${fellTo}`,
          });
        } catch { continue; } // 못 보냈으면 기록하지 않는다 — 다음 호출이 다시 시도
      }
      alerted[skip.row] = level;
      changed = true;
    }
    if (changed) input.memory.save({ ...input.memory.load(), alerted });
  } catch { /* 알림 실패 = 결정 그대로 */ }
}
