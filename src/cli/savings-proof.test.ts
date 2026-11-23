// ROUTER-SAVINGS-PROOF (OP #132083 · FINISH-0333) — 실측 원장 리터럴로 절감 증명 시험.
// 계약: ① 실측 원장 행(llm-usage · estimated 아님 · 실제 logs.db 6행 그대로)이 요약으로 들어온다
//   ② 일일 재계산(summarizeDailySavings)이 원장 ts 그대로 UTC 일 버킷 ③ runLlmSavings --daily json
//   영수에 일별 표가 실린다 ④ 가격 비공개(영수에 usd/$ 없음) ⑤ 매긴 호출이 없으면 savingsPct=null.
// 출처: #39641(ROUTER-95 · 같은 원장·같은 shadow 대차 체인).

import { describe, expect, test } from 'bun:test';
import {
  buildPairedBundleEvidence,
  pairLedgerRowsByRunKey,
  runLlmSavings,
  savingsCallsFromLedger,
  summarizeDailySavings,
  type SavingsLedgerRow,
} from './llm-savings-cli.js';
import type { SavingsPriceOf } from '../model-tier/router-savings.js';

const PREMIUM_MODEL = 'gpt-6.1-terra';

// 실측 원장 6행(logs.db 2026-11-22 · id/tokens/apiEquivalentUsd 그대로 — 합성 0).
const REAL_ROWS: readonly SavingsLedgerRow[] = [
  {
    id: 18707460,
    ts: "2026-11-22T17:17:18.881Z",
    category: "llm.usage",
    event: "llm-usage",
    data: "{\"site\":\"stream-llm-with-tools\",\"sessionId\":\"4bee8147-ebc1-4d0e-b6da-a3101f304e4c\",\"model\":\"gpt-6.1-terra\",\"billingProvider\":\"openai-codex\",\"billing\":\"subscription\",\"measured\":false,\"missingReason\":\"provider-call-failed\",\"cost\":{\"kind\":\"unknown\",\"model\":\"gpt-6.1-terra\"},\"workTier\":\"mid\",\"workTierTrigger\":\"base\",\"workTierSource\":\"model-lookup\",\"runId\":\"run-06c42068-22f5-438c-8d5c-d06c3758f4b7\",\"hostId\":\"01M6EGNCFA9F06ZTDMHXSX7P82\",\"tuiPid\":63560}",
  },
  {
    id: 18707420,
    ts: "2026-11-22T17:17:18.635Z",
    category: "llm.usage",
    event: "llm-usage",
    data: "{\"site\":\"agent-turn\",\"role\":\"main\",\"sessionId\":\"4bee8147-ebc1-4d0e-b6da-a3101f304e4c\",\"model\":\"gpt-6.1-terra\",\"provider\":\"openai\",\"billingProvider\":\"openai-codex\",\"billing\":\"subscription\",\"inputTokens\":272,\"outputTokens\":24,\"stopReason\":\"completed\",\"cacheReadInputTokens\":60032,\"cost\":{\"kind\":\"included\",\"model\":\"gpt-6.1-terra\",\"usd\":0,\"billing\":\"subscription\",\"apiEquivalentUsd\":0.0033936},\"workTier\":\"mid\",\"workTierTrigger\":\"base\",\"workTierSource\":\"model-lookup\",\"runId\":\"run-06c42068-22f5-438c-8d5c-d06c3758f4b7\",\"hostId\":\"01M6EGNCFA9F06ZTDMHXSX7P82\",\"tuiPid\":63560}",
  },
  {
    id: 18707065,
    ts: "2026-11-22T17:16:50.127Z",
    category: "llm.usage",
    event: "llm-usage",
    data: "{\"site\":\"agent-turn\",\"role\":\"main\",\"sessionId\":\"5472805f-921d-4fcd-879a-df0c3961e52c\",\"model\":\"glm-5.3\",\"provider\":\"openai\",\"billingProvider\":\"glm\",\"billing\":\"unknown\",\"inputTokens\":738,\"outputTokens\":352,\"stopReason\":\"stop\",\"cacheReadInputTokens\":99776,\"cacheCreationInputTokens\":0,\"cost\":{\"kind\":\"unknown\",\"model\":\"glm-5.3\"},\"workTier\":\"mid\",\"workTierTrigger\":\"base\",\"workTierSource\":\"model-lookup\",\"runId\":\"run-ca23a298-aff1-48ae-b3b6-ba86de24097c\",\"hostId\":\"01M6EGNCFA9F06ZTDMHXSX7P82\",\"tuiPid\":91151}",
  },
  {
    id: 18707007,
    ts: "2026-11-22T17:16:44.545Z",
    category: "llm.usage",
    event: "llm-usage",
    data: "{\"site\":\"agent-turn\",\"role\":\"main\",\"sessionId\":\"5472805f-921d-4fcd-879a-df0c3961e52c\",\"model\":\"glm-5.3\",\"provider\":\"openai\",\"billingProvider\":\"glm\",\"billing\":\"unknown\",\"inputTokens\":303,\"outputTokens\":270,\"stopReason\":\"tool_calls\",\"cacheReadInputTokens\":99520,\"cacheCreationInputTokens\":0,\"cost\":{\"kind\":\"unknown\",\"model\":\"glm-5.3\"},\"workTier\":\"mid\",\"workTierTrigger\":\"base\",\"workTierSource\":\"model-lookup\",\"runId\":\"run-ca23a298-aff1-48ae-b3b6-ba86de24097c\",\"hostId\":\"01M6EGNCFA9F06ZTDMHXSX7P82\",\"tuiPid\":91151}",
  },
  {
    id: 18703877,
    ts: "2026-11-22T17:12:45.608Z",
    category: "llm.usage",
    event: "llm-usage",
    data: "{\"site\":\"stream-llm\",\"model\":\"glm-5.3-flash\",\"billingProvider\":\"glm\",\"billing\":\"unknown\",\"inputTokens\":41,\"outputTokens\":843,\"stopReason\":\"stop\",\"cacheReadInputTokens\":384,\"cacheCreationInputTokens\":0,\"cost\":{\"kind\":\"unknown\",\"model\":\"glm-5.3-flash\"},\"workTier\":\"weak\",\"workTierTrigger\":\"base\",\"workTierSource\":\"model-lookup\",\"runId\":\"run-1b2c86a2-52c2-4fb7-8ef5-7a26f1bb5616\",\"hostId\":\"01M6EGNCFA9F06ZTDMHXSX7P82\"}",
  },
  {
    id: 18702183,
    ts: "2026-11-22T17:11:27.409Z",
    category: "llm.usage",
    event: "llm-usage",
    data: "{\"site\":\"agent-turn\",\"role\":\"main\",\"sessionId\":\"966f3985-d315-443f-97a8-1816026853dd\",\"model\":\"gpt-6-luna\",\"provider\":\"openai\",\"billingProvider\":\"openai-codex\",\"billing\":\"subscription\",\"inputTokens\":1757,\"outputTokens\":278,\"stopReason\":\"completed\",\"cacheReadInputTokens\":41472,\"cost\":{\"kind\":\"included\",\"model\":\"gpt-6-luna\",\"usd\":0,\"billing\":\"subscription\",\"apiEquivalentUsd\":0.00072942},\"workTier\":\"weak\",\"workTierTrigger\":\"base\",\"workTierSource\":\"model-lookup\",\"runId\":\"run-9722435b-f280-4d58-b2b8-71b513b755e5\",\"hostId\":\"01M6EGNCFA9F06ZTDMHXSX7P82\",\"tuiPid\":62771}",
  },
];

const priceOf: SavingsPriceOf = (model, tokens) => {
  if (model === PREMIUM_MODEL) return (tokens.inputTokens * 10 + tokens.outputTokens * 30) / 1_000_000;
  return (tokens.inputTokens * 1 + tokens.outputTokens * 3) / 1_000_000;
};

describe('ROUTER-SAVINGS-PROOF — 실측 원장 절감 증명', () => {
  test('실측 원장 6행 — llm-usage estimated 아닌 행만 요약으로 들어온다(행 소실 0)', () => {
    const calls = savingsCallsFromLedger(REAL_ROWS, { now: Date.parse('2026-11-22T18:00:00Z'), sinceMs: 3600_000 });
    expect(calls.length).toBe(6); // 출처: #39641+logs.db 실측 — 6행 전부 요약으로 들어온다(tokens 미기록 행 포함 · 행 소실 0)
    for (const c of calls) expect(c.at).toBeGreaterThanOrEqual(Date.parse('2026-11-22T17:00:00Z')); // 출처: #39641 실측 원장 창
    expect(REAL_ROWS).toHaveLength(6);
  });

  test('일일 재계산 — 실측 6행이 같은 UTC 일 버킷 하나로 묶인다(2026-11-22)', () => {
    const calls = savingsCallsFromLedger(REAL_ROWS, { now: Date.parse('2026-11-22T18:00:00Z'), sinceMs: 3600_000 });
    const daily = summarizeDailySavings(calls, { premiumModel: PREMIUM_MODEL, priceOf });
    expect(daily).toHaveLength(1);
    expect(daily[0]!.day).toBe('2026-11-22');
    expect(daily[0]!.totalCalls).toBe(calls.length);
  });

  test('runLlmSavings --daily json — 실측 원장 기준 일별 영수 · 가격 비공개', async () => {
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    const calls = savingsCallsFromLedger(REAL_ROWS, { now: Date.parse('2026-11-22T18:00:00Z'), sinceMs: 3600_000 });
    const r = await runLlmSavings({ premiumModel: PREMIUM_MODEL, json: true, daily: true }, { rows: calls, priceOf, out });
    expect(r.error).toBeUndefined();
    expect(r.json!.daily).toHaveLength(1);
    expect(r.json!.daily![0]!.day).toBe('2026-11-22');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[$]usd|USD /);
  });
});

// ── judb-39664-84d0ecbb51c6 mustFix — 과제/런 키 대차 증거(증거 세트 하나) ──────────────────
// 같은 과제 묶음을 ① 고정 티어 실행(전 과제 강 모델)과 ② 라우터 실행(가벼운 선출→임계 게이트→상향)으로
// 돌려 비용·품질을 모두 대차한다. 키 = 과제 id(묶음)·원장 runId(실측 행). ⛔ 가격 비공개 — 비율만.
describe('ROUTER-SAVINGS-PROOF — 과제/런 키 대차 증거 (judb-39664 mustFix)', () => {
  // 같은 묶음 — ROUTER-QUALITY-GUARD-95 시나리오(#39641)와 같은 과제 3개(chat 1 + codegen 2)·같은 점수.
  const bundlePriceOf: SavingsPriceOf = (model, tokens) =>
    model === 'premium-max' // 출처: #39641 데모 단가 체계 — 강 10/30 · 경 1/3 (per 1M 토큰)
      ? (tokens.inputTokens * 10 + tokens.outputTokens * 30) / 1_000_000
      : (tokens.inputTokens * 1 + tokens.outputTokens * 3) / 1_000_000;
  const BUNDLE_TOKENS = { inputTokens: 1_000, outputTokens: 2_000 } as const; // 출처: #39641 묶음 과제 공통 적재
  const bundleScores: Readonly<Record<string, Readonly<Record<string, number>>>> = {
    // 출처: #39641 ROUTER-QUALITY-GUARD-95 평가 큐 [0.93,0.99, 0.97,0.99, 0.60,0.99] — (가벼운, 강)×3과제
    'bundle-t1-chat': { 'light-mini': 0.93, 'premium-max': 0.99 },
    'bundle-t2-codegen': { 'light-mini': 0.97, 'premium-max': 0.99 },
    'bundle-t3-codegen': { 'light-mini': 0.60, 'premium-max': 0.99 },
  };
  const evalCalls: { model: string; key: string }[] = [];
  const evaluate = (model: string, key: string): number => {
    evalCalls.push({ model, key });
    const score = bundleScores[key]?.[model];
    if (score === undefined) throw new Error(`no score for ${model} @ ${key}`);
    return score;
  };

  test('묶음 대차 — 고정 티어 vs 라우터 실행 · 비용+품질 · 같은 과제 키로 연결', async () => {
    const evidence = await buildPairedBundleEvidence({
      tasks: [
        { key: 'bundle-t1-chat', taskType: 'chat', tokens: BUNDLE_TOKENS },
        { key: 'bundle-t2-codegen', taskType: 'codegen', tokens: BUNDLE_TOKENS },
        { key: 'bundle-t3-codegen', taskType: 'codegen', tokens: BUNDLE_TOKENS },
      ],
      lightweight: 'light-mini',
      premium: 'premium-max',
      evaluate,
      floors: { chat: 0.95 }, // 출처: #39641 — chat 유형 임계(전유형 바닥 ≥0.95 · OP #132280)
      priceOf: bundlePriceOf,
    });
    // ① 같은 묶음 — 세 과제 키가 한 세트로 그대로 연결된다(모드 간 키 일치 · 소실 0).
    expect(evidence.rows.map(r => r.key))
      .toEqual(['bundle-t1-chat', 'bundle-t2-codegen', 'bundle-t3-codegen']); // 출처: #39641 묶음 과제 원문
    // ② 고정 티어 실행 — 전 과제가 강 모델이고, 라우터 실행은 상향 2·가벼운 유지 1.
    expect(evidence.rows.every(r => r.fixedTierModel === 'premium-max')).toBe(true); // 출처: #39664 — 고정 티어 실행 정의
    expect(evidence.escalated).toBe(2); // 출처: #39641 — t1(0.93<0.95)·t3(0.60<0.95) 상향
    expect(evidence.kept).toBe(1); // 출처: #39641 — t2(0.97≥0.95) 가벼운 유지
    // ③ 품질 대차 — 라우터 인도 품질은 전 과제 적용 임계 이상(품질 하한 보존).
    expect(evidence.rows.map(r => r.routedQuality)).toEqual([0.99, 0.97, 0.99]); // 출처: #39641 인도 점수 원문
    expect(evidence.minQualityVsFloor).not.toBeNull();
    expect(evidence.minQualityVsFloor!).toBeGreaterThanOrEqual(0); // 출처: #39641 — 인도 ≥ 적용 임계(0.95)
    // ④ 비용 대차 — 같은 토큰을 강 단가로 다시 계산한 짝 기준: 유지 t2가 절감을 만든다(묶음 절감 >0).
    expect(evidence.rows[1]!.costSavingsPct).not.toBeNull();
    expect(evidence.rows[1]!.costSavingsPct!).toBeCloseTo(0.9); // 출처: #39664 — 1 − 0.007/0.07(t2 유지 · 같은 토큰)
    expect(evidence.costSavingsPct).not.toBeNull();
    expect(evidence.costSavingsPct!).toBeCloseTo(0.3); // 출처: #39664 — 1 − 0.147/0.21(묶음 합)
    // ⑤ shadow 강 평가는 과제당 정확히 1회 — 그 점수가 고정 티어 품질로 그대로 재사용된다(평가 이중화 0).
    expect(evidence.premiumEvaluations).toBe(3); // 출처: #39641 — 과제당 1회
    expect(evidence.rows.map(r => r.fixedTierQuality)).toEqual([0.99, 0.99, 0.99]); // 출처: #39641 shadow 점수 원문
    expect(evalCalls.filter(c => c.model === 'premium-max').map(c => c.key))
      .toEqual(['bundle-t1-chat', 'bundle-t2-codegen', 'bundle-t3-codegen']); // 출처: #39641 — 강 평가 키 = 과제 키
  });

  test('실측 원장 6행 — runId 키로 묶어 짝 대차(행 소실 0 · 합성 0)', () => {
    const paired = pairLedgerRowsByRunKey(REAL_ROWS, {
      now: Date.parse('2026-11-22T18:00:00Z'),
      sinceMs: 3600_000,
      premiumModel: PREMIUM_MODEL,
      priceOf,
    });
    // ① 행→키 연결 — 6행이 전부 정확히 하나의 runId 키에 들어간다(행 소실 0).
    expect(paired).toHaveLength(4); // 출처: logs.db 실측 6행의 data.runId 4종(#39664)
    expect(paired.reduce((a, r) => a + r.calls, 0)).toBe(6); // 출처: logs.db 실측 6행(#39664 원장 그대로)
    expect(paired.map(r => r.key)).toEqual([
      'run-06c42068-22f5-438c-8d5c-d06c3758f4b7',
      'run-ca23a298-aff1-48ae-b3b6-ba86de24097c',
      'run-1b2c86a2-52c2-4fb7-8ef5-7a26f1bb5616',
      'run-9722435b-f280-4d58-b2b8-71b513b755e5',
    ]); // 출처: logs.db 실측 6행 data.runId 원문(#39664)
    // ② terra 런 — 매긴 1행(272/24) 실측환산값 vs 같은 토큰 강 단가 → 짝 대차 절감 비율.
    const terraRun = paired[0]!;
    expect(terraRun.pricedCalls).toBe(1); // 출처: logs.db — 18707420행만 토큰·환산값 기록
    expect(terraRun.unpricedCalls).toBe(1); // 출처: logs.db — 18707460행 provider-call-failed(토큰 미기록)
    const fixedTerra = priceOf(PREMIUM_MODEL, { inputTokens: 272, outputTokens: 24 }); // 출처: logs.db 18707420행 토큰 원문
    expect(terraRun.savingsPct).not.toBeNull();
    // 출처: logs.db 18707420행 apiEquivalentUsd=0.0033936 실측값 — 계산 1 − 실측/강단가
    expect(terraRun.savingsPct!).toBeCloseTo(1 - 0.0033936 / fixedTerra!);
    // ③ 환산값 없는 런 — 합성 없이 null(과장 0): glm 2행(kind unknown)·flash 1행(kind unknown).
    expect(paired[1]!.savingsPct).toBeNull(); // 출처: logs.db — run-ca23a298 glm-5.3 2행 cost kind unknown
    expect(paired[1]!.unpricedCalls).toBe(2); // 출처: logs.db — 18707065·18707007행 환산값 미기록
    expect(paired[2]!.savingsPct).toBeNull(); // 출처: logs.db — run-1b2c86a2 flash 1행 cost kind unknown
    // ④ luna 런 — 매긴 1행(1757/278) 실측환산값 vs 같은 토큰 강 단가.
    const lunaRun = paired[3]!;
    expect(lunaRun.pricedCalls).toBe(1); // 출처: logs.db — 18702183행 토큰·환산값 기록
    const fixedLuna = priceOf(PREMIUM_MODEL, { inputTokens: 1757, outputTokens: 278 }); // 출처: logs.db 18702183행 토큰 원문
    expect(lunaRun.savingsPct).not.toBeNull();
    // 출처: logs.db 18702183행 apiEquivalentUsd=0.00072942 실측값 — 계산 1 − 실측/강단가
    expect(lunaRun.savingsPct!).toBeCloseTo(1 - 0.00072942 / fixedLuna!);
  });

  test('구독 행 실측값 계약 — cost.usd=0은 구독 부과분이지 실측 지출이 아니다(절감 100% 과장 방지)', () => {
    const calls = savingsCallsFromLedger(REAL_ROWS, { now: Date.parse('2026-11-22T18:00:00Z'), sinceMs: 3600_000 });
    const terra = calls[1]!; // 출처: logs.db 18707420행(구독 · 272/24)
    expect(terra.costUsd).toBeNull(); // 출처: router-savings.ts 실측 계약 «구독 호출의 실측 값은 apiEquivalentUsd»
    expect(terra.apiEquivalentUsd).toBe(0.0033936); // 출처: logs.db 18707420행 원문
    const luna = calls[5]!; // 출처: logs.db 18702183행(구독 · 1757/278)
    expect(luna.costUsd).toBeNull(); // 출처: router-savings.ts 실측 계약 — 구독 행은 환산값을 쓴다
    expect(luna.apiEquivalentUsd).toBe(0.00072942); // 출처: logs.db 18702183행 원문
  });

  test('증거 비공개 — 대차 출력에 단가·금액(USD)이 실리지 않는다(비율·횟수만)', () => {
    const paired = pairLedgerRowsByRunKey(REAL_ROWS, {
      now: Date.parse('2026-11-22T18:00:00Z'), sinceMs: 3600_000, premiumModel: PREMIUM_MODEL, priceOf,
    });
    const text = JSON.stringify(paired);
    expect(text).not.toMatch(/usd/i); // 출처: #39664 — 가격 비공개 계약(출력은 비율·횟수만)
    expect(text).not.toMatch(/[$]/); // 출처: #39664 — 가격 비공개 계약
  });
});
