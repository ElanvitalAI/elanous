// SMART-ROUTER-DEMO-SAVINGS (OP #116366 · 11-23 타임리 시연) — 데모 영수 요약 순수모듈.
//
// 입력은 «실측 원장» 호출 행(llm.usage 이벤트에서 뽑은 것)과 주입 단가(priceOf)뿐:
//   ① 호출별 모델·길목(role/phase)·등급 표 ② 고급 호출 수/전체 ③ «강 단독» 대비 절감 비율.
// ⛔ 가격 비공개 — 렌더 영수에 단가·금액(USD)이 실리지 않는다. 절감 비율은 주입 단가로
//   «내부» 계산한 값이고, 영수에는 비율만 남는다.
// ⛔ 실측 원장만 — 토큰이 없거나 단가를 못 매긴 호출은 합성으로 채우지 않는다. 비교 집합에서
//   빼고 unpricedCalls 로만 센다. 매긴 호출이 0이면 savingsPct = null(과장 0).
//   구독 호출의 실측 값은 apiEquivalentUsd(API 환산), credit/api 호출은 costUsd 를 쓴다.
//   호출 등급 칸은 원장의 workTier(weak/mid/strong — 오케스트레이션 코어 callFields)이고,
//   «고급» = strong(또는 강 모델 그 자체).

export interface SavingsCallRow {
  /** epoch ms. */
  readonly at: number;
  /** 길목 축 1 — ModelRole(planning·review·…). */
  readonly role?: string;
  /** 길목 축 2 — 호출 단계. */
  readonly phase?: string;
  readonly model: string;
  readonly provider?: string;
  readonly billing?: string;
  /** 원장 런 키(data.runId) — 과제/런 키 대차 증거의 그룹 키(judb-39664). 원장 밖 행은 undefined. */
  readonly runKey?: string;
  /** 원장의 호출 등급 칸(workTier: weak/mid/strong). 없어도 영수는 나온다. */
  readonly tier?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** 실제 과금(credit/api 행). */
  readonly costUsd?: number | null;
  /** 구독 행의 API 환산 값. */
  readonly apiEquivalentUsd?: number | null;
}

/** 단가 주입 — (모델, 토큰) → 그 호출의 단가 금액. 못 매기면 null. */
export type SavingsPriceOf = (model: string, tokens: { inputTokens: number; outputTokens: number }) => number | null;

export interface SavingsReceiptRow {
  readonly at: number;
  readonly role: string;
  readonly phase: string | null;
  readonly model: string;
  readonly tier: string | null;
  /** 고급 = 등급 칸이 고급 집합(기본 strong)에 있거나 강 모델 그 자체. */
  readonly premium: boolean;
}

/** 일일 재계산 한 행 — UTC 일(YYYY-MM-DD) 버킷의 호출·고급 비중·절감 비율. ⛔ 가격 비공개 — 비율만. */
export interface SavingsDayRow {
  /** UTC 일자(YYYY-MM-DD). 시각을 못 매긴 행은 '시각 미측정' 버킷. */
  readonly day: string;
  readonly totalCalls: number;
  readonly premiumCalls: number;
  readonly premiumShare: number;
  /** 1 − 실측값/강단독값(그 일 버킷 안에서). 매긴 호출이 없으면 null. */
  readonly savingsPct: number | null;
  readonly unpricedCalls: number;
}

export interface SavingsReceipt {
  readonly totalCalls: number;
  readonly premiumCalls: number;
  /** Present for explicit multi-model classification so the denominator is auditable. */
  readonly premiumModels?: readonly string[];
  readonly rows: readonly SavingsReceiptRow[];
  /** 1 − 실측값/강단독값. 매긴 호출이 없거나 분모가 0 이하면 null. */
  readonly savingsPct: number | null;
  readonly unpricedCalls: number;
  /** 일일 재계산 표(--daily) — UTC 일 버킷별 요약(jud-39614 필수 3). */
  readonly daily?: readonly SavingsDayRow[];
}

export interface SummarizeSavingsInput {
  readonly calls: readonly SavingsCallRow[];
  /** «강 단독» 기준 모델 — 이 모델 단가로 전 호출을 다시 계산한 값이 비교 기준. */
  readonly premiumModel: string;
  /** Additional exact model IDs counted as premium; the counterfactual price still uses premiumModel. */
  readonly premiumModels?: readonly string[];
  readonly priceOf: SavingsPriceOf;
  /** 고급 등급 칸 집합(원장 workTier 어휘). 기본 {strong}. */
  readonly premiumTiers?: ReadonlySet<string>;
}

/** 고급 등급 칸 기본값 — 원장 workTier 어휘의 위 칸. */
export const DEFAULT_PREMIUM_TIERS: ReadonlySet<string> = new Set<string>(['strong']);

export function summarizeRouterSavings(input: SummarizeSavingsInput): SavingsReceipt {
  const premiumTiers = input.premiumTiers ?? DEFAULT_PREMIUM_TIERS;
  const rows: SavingsReceiptRow[] = [];
  let premiumCalls = 0;
  let actual = 0;
  let counterfactual = 0;
  let priced = 0;
  let unpriced = 0;
  const premiumModels = new Set([input.premiumModel, ...(input.premiumModels ?? [])]);
  for (const call of input.calls) {
    const tier = call.tier ?? null;
    const premium = (tier !== null && premiumTiers.has(tier)) || premiumModels.has(call.model);
    if (premium) premiumCalls += 1;
    rows.push({ at: call.at, role: call.role ?? '(없음)', phase: call.phase ?? null, model: call.model, tier, premium });
    const actualUsd = call.costUsd ?? call.apiEquivalentUsd ?? null;
    const tokens = call.inputTokens !== undefined && call.outputTokens !== undefined
      ? { inputTokens: call.inputTokens, outputTokens: call.outputTokens }
      : null;
    const cf = tokens !== null ? input.priceOf(input.premiumModel, tokens) : null;
    if (actualUsd === null || cf === null || !Number.isFinite(actualUsd) || !Number.isFinite(cf)) {
      unpriced += 1;
      continue;
    }
    actual += actualUsd;
    counterfactual += cf;
    priced += 1;
  }
  const savingsPct = priced === 0 || counterfactual <= 0 ? null : 1 - actual / counterfactual;
  return { totalCalls: input.calls.length, premiumCalls, ...(input.premiumModels ? { premiumModels: [...premiumModels] } : {}), rows, savingsPct, unpricedCalls: unpriced };
}

export interface RenderSavingsReceiptOpts {
  readonly title: string;
  /** 영수 기준 시각(원문 그대로). */
  readonly at: string;
  /** 강 모델 이름 표기(영수에 모델명은 공개 — 단가만 비공개). */
  readonly premiumModel?: string;
}

/** 영수 마크다운 — 호출별 표 + 고급 비율 + 절감 비율. ⛔ 단가·금액 문자열 없음(비공개 계약). */
export function renderSavingsReceiptMd(receipt: SavingsReceipt, opts: RenderSavingsReceiptOpts): string {
  const savings = receipt.savingsPct === null
    ? '측정 불가(매긴 호출 0)'
    : `${(receipt.savingsPct * 100).toFixed(2)}%`;
  const lines: string[] = [
    `# ${opts.title} — eln --provider auto 실측 영수`,
    ``,
    `- 기준 시각: ${opts.at}`,
    ...(opts.premiumModel ? [`- 강 단독 기준 모델: ${opts.premiumModel}`] : []),
    ...(receipt.premiumModels ? [`- 고급 호출 모델 집합: ${receipt.premiumModels.join(', ')}`] : []),
    `- 고급 호출 수/전체: ${receipt.premiumCalls}/${receipt.totalCalls}`,
    `- 강 단독 대비 절감: ${savings} (매긴 호출 ${receipt.totalCalls - receipt.unpricedCalls}건 기준 · 단가는 비공개 내부 계산)`,
    `- 단가 미측정 호출: ${receipt.unpricedCalls}건 (합성 미기입)`,
    ``,
    `| # | 시각 | 길목(role) | 단계 | 모델 | 등급 | 고급 |`,
    `|---|---|---|---|---|---|---|`,
  ];
  receipt.rows.forEach((row, i) => {
    // 렌더 방어 — 시각을 못 매긴 행(비유한 at)에서도 영수가 나온다(데모 비정지 · RangeError 금지).
    const atStr = Number.isFinite(row.at) ? new Date(row.at).toISOString() : '시각 미측정';
    lines.push(`| ${i + 1} | ${atStr} | ${row.role} | ${row.phase ?? '—'} | ${row.model} | ${row.tier ?? '—'} | ${row.premium ? '●' : '—'} |`);
  });
  return lines.join('\n') + '\n';
}
