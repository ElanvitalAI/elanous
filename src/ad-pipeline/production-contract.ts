/**
 * 접지 뒤에 오는 «제작» 단계들 — 지금은 전부 셸 절차이고 이 진입이 «부르지 않는다».
 * ⛔ 이름을 여기 두는 이유: 안 부르는 것을 «안 부른다고» 말할 수 있어야 하기 때문이다.
 */
export const PRODUCTION_STEPS = ['ground', 'invariants', 'expand', 'cut', 'voiceover', 'soundtrack', 'render'] as const;
export type ProductionStep = typeof PRODUCTION_STEPS[number];
