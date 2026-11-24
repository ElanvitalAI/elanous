/**
 * ELN-DEPTH-BY-DIFFICULTY-AND-RETRO (OP #143390 · 지시서 ⑨) — 난이도별 사고 깊이.
 *
 * 일감 시작 시 결정적 1차 난이도 판정(D1/D2/D3) → 산출 형식 강제
 * (D2 «원인·근거·가설» 3줄 · D3 «선택지 3 표 + 채택 + 되돌리기 + 판정식») ·
 * 실패 2회 자동 승급 · 턴 끝 관문이 깊이 부족을 되돌림.
 *
 * 턴 끝 관문(CX-6)과 «같은 관문 코드» — 이 모듈은 순수 함수만 제공하고,
 * llm.ts 의 검증 보충(supplement) 조립(buildLoopHealthSnapshot 계열)이
 * 같은 인터페이스로 줄을 붙인다:
 *   - `depthGateSupplementLines(difficulty, finalText, lines)` — 기존 supplement
 *     줄 앞에 관문 줄을 끼워 넣는다(CX-6 pendingVerifyLine 과 같은 모양).
 */

export type WorkDifficulty = 'D1' | 'D2' | 'D3';

/** 일감 시작 신호 — 결정적 1차 판정 입력(모델 확인은 호출자 몫). */
export type WorkDifficultySignals = {
  /** 알려진 꼴·선례가 있다 */
  knownPattern?: boolean;
  /** 수행 명령이 이미 주어져 있다 */
  commandProvided?: boolean;
  /** 되돌리기 쉽다 */
  easyRevert?: boolean;
  /** 원인 후보 둘 이상 */
  causes?: number;
  /** 처음 보는 조합 */
  firstSeenCombination?: boolean;
  /** 같은 꼴 반복 횟수 */
  repeatedShapeCount?: number;
  /** 목표 미달 연속 */
  goalMissStreak?: number;
  /** 돈/보안 */
  securityOrMoney?: boolean;
};

export type DepthRequirementCheck = { ok: boolean; missing: string[] };

const D2_MARKERS = ['원인', '근거', '가설'] as const;
const D3_MARKERS = ['채택', '되돌리기', '판정식'] as const;
/** D3 «선택지 3 표» — '선택지' 가 든 줄이 3개 이상이어야 한다. */
const D3_OPTION_LINE_MIN = 3;

/** 일감 시작 시 결정적 1차 난이도 판정. 신호가 흐리면 D2(보수). */
export function classifyWorkDifficulty(signals: WorkDifficultySignals): WorkDifficulty {
  if (signals.securityOrMoney) return 'D3';
  if ((signals.repeatedShapeCount ?? 0) >= 2) return 'D3';
  if ((signals.goalMissStreak ?? 0) >= 2) return 'D3';
  if (signals.knownPattern && signals.commandProvided && signals.easyRevert) return 'D1';
  if ((signals.causes ?? 0) >= 2) return 'D2';
  if (signals.firstSeenCombination) return 'D2';
  if (!signals.knownPattern) return 'D2';
  return 'D1';
}

/** 난이도별 필수 산출 형식. D1 은 형식 없음(바로 실행). */
export function requiredOutputFormat(difficulty: WorkDifficulty): { requiredMarkers: string[] } {
  if (difficulty === 'D1') return { requiredMarkers: [] };
  if (difficulty === 'D2') return { requiredMarkers: [...D2_MARKERS] };
  return { requiredMarkers: ['선택지', ...D3_MARKERS] };
}

/** 최종 답변이 난이도별 산출 형식을 갖췄는지 — 빠진 표지 목록과 함께. */
export function checkDepthRequirement(difficulty: WorkDifficulty, finalText: string): DepthRequirementCheck {
  if (difficulty === 'D1') return { ok: true, missing: [] };
  const missing: string[] = [];
  if (difficulty === 'D2') {
    for (const marker of D2_MARKERS) {
      if (!finalText.includes(marker)) missing.push(marker);
    }
    return { ok: missing.length === 0, missing };
  }
  // D3 — 선택지 3 표(줄 단위 3개 이상) + 채택 + 되돌리기 + 판정식
  const optionLines = finalText.split('\n').filter((line) => line.includes('선택지')).length;
  if (optionLines < D3_OPTION_LINE_MIN) missing.push('선택지');
  for (const marker of D3_MARKERS) {
    if (!finalText.includes(marker)) missing.push(marker);
  }
  return { ok: missing.length === 0, missing };
}

/** 승급 규칙 — D1 실패 2회 → D2 · D2 가설 전멸 → D3 · D3 유지. */
export function escalateDifficulty(
  current: WorkDifficulty,
  outcome: { failureCount?: number; hypothesesAllWrong?: boolean },
): WorkDifficulty {
  if (current === 'D1') {
    return (outcome.failureCount ?? 0) >= 2 ? 'D2' : 'D1';
  }
  if (current === 'D2') {
    return outcome.hypothesesAllWrong ? 'D3' : 'D2';
  }
  return 'D3';
}

/** 턴 끝 관문 줄 — 깊이 부족일 때만(CX-6 pendingVerifyLine 과 같은 모양). 통과면 null. */
export function buildDepthGateLine(difficulty: WorkDifficulty, check: DepthRequirementCheck): string | null {
  if (check.ok) return null;
  return `- 난이도 관문: ${difficulty} 산출 형식이 부족합니다 (${check.missing.join('·')}) — 깊이를 보강해 관문을 통과하세요.`;
}

/**
 * supplement 줄 조립 — 관문 줄을 기존 줄(루프 마감 상태 등) «앞»에 끼운다.
 * CX-6 검증 보충 조립과 같은 인터페이스: 통과하면 입력 줄을 그대로 돌려준다.
 */
export function depthGateSupplementLines(
  difficulty: WorkDifficulty,
  finalText: string,
  existingLines: readonly string[],
): string[] {
  const check = checkDepthRequirement(difficulty, finalText);
  const gateLine = buildDepthGateLine(difficulty, check);
  if (gateLine === null) return [...existingLines];
  return [gateLine, ...existingLines];
}

/** 일감 끝 미니 회고 1줄 — 자리 기억 후보(무엇을 했나·예상과 달랐던 것·다르게 할 것). */
export function buildMiniRetroLine(retro: { did: string; unexpected: string; next: string }): string {
  return `미니 회고: ${retro.did} · 예상과 달랐던 것: ${retro.unexpected} · 다르게 할 것: ${retro.next}`;
}

/**
 * 턴 끝 관문 배선 — llm.ts 검증 보충(supplement)에 관문 줄을 주입한다.
 * CX-6 «루프 마감 상태» 줄 «앞»에 낀다(관문이 마감 판정보다 먼저 말한다).
 * - 최종 답이 형식을 갖췄거나 D1 이면 supplement 를 그대로 돌려준다(변경 0).
 * - supplement 가 없어도 관문 줄을 단독으로 만든다 — 되돌림을 놓치지 않는다.
 * - D1 이고 supplement 도 없으면 null (기존 동작 유지).
 */
export function injectDepthGateIntoSupplement(
  difficulty: WorkDifficulty,
  finalText: string,
  supplement: string | null,
): string | null {
  const check = checkDepthRequirement(difficulty, finalText);
  if (check.ok) return supplement;
  const gateLine = buildDepthGateLine(difficulty, check)!.replace(/^- /, '');
  if (!supplement) return difficulty === 'D1' ? null : gateLine;
  const lines = supplement.split('\n');
  const closureIndex = lines.findIndex((line) => line.includes('루프 마감 상태'));
  if (closureIndex === -1) return `${supplement}\n${gateLine}`;
  return [...lines.slice(0, closureIndex), gateLine, ...lines.slice(closureIndex)].join('\n');
}
