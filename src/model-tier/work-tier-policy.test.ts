// 강·중·약 섞기 정책 v0 — 올림·내림 · 강 출력 상한 · 호출 원장 칸 · 등급별 몫 보기.
// 숫자는 모듈 상수에서 유도한다(NUMGUARD) · 시계·네트워크·LLM 0.
import { afterEach, describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import {
  MID_SHARE_TARGET,
  RED_ROUNDS_ESCALATE_AT,
  SAME_ERROR_ESCALATE_AT,
  STRONG_OUTPUT_MAX_TOKENS,
  STRONG_SHARE_YELLOW_ABOVE,
  WEAK_SHARE_MIN,
  WORK_TIER_CLASSES,
  afterJudgement,
  escalateOnce,
  outputCapForClass,
  runWithWorkTierContext,
  strongOutputOverCap,
  summarizeTierShares,
  workTierClassForModel,
  workTierUsageFields,
  type EscalationSignals,
  type EscalationTrigger,
} from './work-tier-policy.js';
import { lookupLlmTierSpec } from './llm-tier-map.js';
import { registerUsageCommand } from '../cli/usage-cli.js';
import type { LogStoreRow } from '../mss/logging/log-store.js';
import { createModelOrchestrationCore, DEFAULT_CORE_MODULES } from './model-orchestration.js';
import { classifyWorkRisk, workRiskInputFromFields } from './work-risk-router.js';
import type { TierShareInput } from './work-tier-policy.js';

const TRIGGERS: ReadonlyArray<[EscalationTrigger, EscalationSignals]> = [
  ['same-error-twice', { sameErrorCount: SAME_ERROR_ESCALATE_AT }],
  ['red-rounds', { redRounds: RED_ROUNDS_ESCALATE_AT }],
  ['risky-first-design', { riskyFirstDesign: true }],
];


describe('escalateOnce — one step up, one judgement, straight back down', () => {
  for (const [trigger, signals] of TRIGGERS) {
    it(`${trigger}: weak → mid → weak · mid → strong → mid`, () => {
      const fromWeak = escalateOnce('weak', signals)!;
      expect(fromWeak).toMatchObject({ from: 'weak', to: 'mid', trigger, judgements: 1 });
      expect(fromWeak.maxOutputTokens).toBeUndefined();
      expect(afterJudgement(fromWeak)).toBe('weak');
      const fromMid = escalateOnce('mid', signals)!;
      expect(fromMid).toMatchObject({ from: 'mid', to: 'strong', trigger, maxOutputTokens: STRONG_OUTPUT_MAX_TOKENS });
      expect(afterJudgement(fromMid)).toBe('mid');
      expect(WORK_TIER_CLASSES.indexOf(fromWeak.to) - WORK_TIER_CLASSES.indexOf(fromWeak.from)).toBe(1);
      expect(escalateOnce('strong', signals)).toBeNull();
    });
  }

  it('below the thresholds nothing escalates; several triggers still move one step', () => {
    expect(escalateOnce('weak', { sameErrorCount: SAME_ERROR_ESCALATE_AT - 1, redRounds: RED_ROUNDS_ESCALATE_AT - 1, riskyFirstDesign: false })).toBeNull();
    const all = escalateOnce('weak', { sameErrorCount: SAME_ERROR_ESCALATE_AT, redRounds: RED_ROUNDS_ESCALATE_AT, riskyFirstDesign: true })!;
    expect(all).toMatchObject({ to: 'mid', trigger: 'risky-first-design' });
  });
});

describe('strong output cap', () => {
  it('only strong carries the cap and over-cap is detected', () => {
    expect(outputCapForClass('strong')).toBe(STRONG_OUTPUT_MAX_TOKENS);
    expect(outputCapForClass('mid')).toBeUndefined();
    expect(outputCapForClass('weak')).toBeUndefined();
    expect(strongOutputOverCap('strong', STRONG_OUTPUT_MAX_TOKENS)).toBe(false);
    expect(strongOutputOverCap('strong', STRONG_OUTPUT_MAX_TOKENS + 1)).toBe(true);
    expect(strongOutputOverCap('mid', STRONG_OUTPUT_MAX_TOKENS + 1)).toBe(false);
  });
});

describe('per-call ledger fields', () => {
  it('resolve through the tier ladder (lowest cell wins) and carry no text', () => {
    expect(workTierClassForModel('openai-codex', lookupLlmTierSpec('openai-codex', 'budget').model)).toBe('weak');
    expect(workTierClassForModel('grok', lookupLlmTierSpec('grok', 'better').model)).toBe('mid');
    expect(workTierClassForModel('openai-codex', lookupLlmTierSpec('openai-codex', 'best').model)).toBe(
      lookupLlmTierSpec('openai-codex', 'best').model === lookupLlmTierSpec('openai-codex', 'better').model ? 'mid' : 'strong');
    expect(workTierClassForModel('grok', 'not-on-the-ladder')).toBeUndefined();
    expect(workTierUsageFields('grok', 'not-on-the-ladder')).toEqual({});
    const fields = workTierUsageFields('openai-codex', lookupLlmTierSpec('openai-codex', 'budget').model);
    expect(fields).toEqual({ workTier: 'weak', workTierTrigger: 'base', workTierSource: 'model-lookup' });
    expect(runWithWorkTierContext({ tier: 'strong', trigger: 'same-error-twice' }, () => workTierUsageFields('openai-codex', 'anything')))
      .toEqual({ workTier: 'strong', workTierTrigger: 'same-error-twice', workTierSource: 'context' });
    expect(workTierUsageFields('grok', 'not-on-the-ladder')).toEqual({});
    for (const value of Object.values(fields)) expect(['weak', 'mid', 'strong', 'base', 'model-lookup', 'context']).toContain(value);
  });
});

/** 가짜 원장 줄 — 토큰은 목표 몫 상수에서 유도한다(합 = 1 단위 × SCALE). */
const SCALE = 1000;
const usageRow = (data: Record<string, unknown>): LogStoreRow => ({
  id: 1, ts: '2026-11-17T00:00:00Z', ts_ms: 1, level: 'info', instance: 'test', surface: 'tui', category: 'llm.usage',
  event: 'llm-usage', session_id: null, trace_id: null, data: JSON.stringify(data),
});

function rowsFor(strongShare: number) {
  const mid = MID_SHARE_TARGET.min;
  const weak = 1 - mid - strongShare;
  return [
    { runId: 'run-hdr-a', workTier: 'weak', inputTokens: weak * SCALE, cost: { kind: 'known', usd: weak } },
    { runId: 'run-hdr-a', workTier: 'mid', inputTokens: mid * SCALE, cost: { kind: 'known', usd: mid } },
    { runId: 'run-hdr-a', workTier: 'strong', outputTokens: strongShare * SCALE, cost: { kind: 'included', apiEquivalentUsd: strongShare } },
    { runId: 'run-hdr-b', model: 'not-on-the-ladder', inputTokens: SCALE },
  ];
}

describe('usage runs --by role tier shares', () => {
  it('shares are over classified tokens; unknown is listed but not counted', () => {
    const report = summarizeTierShares(rowsFor(STRONG_SHARE_YELLOW_ABOVE / 2));
    const byTier = Object.fromEntries(report.rows.map((row) => [row.tier, row]));
    expect(byTier.weak!.share).toBeCloseTo(1 - MID_SHARE_TARGET.min - STRONG_SHARE_YELLOW_ABOVE / 2);
    expect(byTier.weak!.share!).toBeGreaterThanOrEqual(WEAK_SHARE_MIN);
    expect(byTier.mid!.share).toBeCloseTo(MID_SHARE_TARGET.min);
    expect(byTier.strong!).toMatchObject({ apiEquivalentUsd: STRONG_SHARE_YELLOW_ABOVE / 2, runs: 1 });
    expect(byTier.strong!).not.toHaveProperty('rounds');
    expect(byTier.unknown!).toMatchObject({ share: null, runs: 1 });
    expect(report.status).toBe('GREEN');
  });

  it('strong above the threshold is YELLOW; exactly at it is GREEN; nothing classified is UNMEASURED', () => {
    expect(summarizeTierShares(rowsFor(STRONG_SHARE_YELLOW_ABOVE)).status).toBe('GREEN');
    expect(summarizeTierShares(rowsFor(STRONG_SHARE_YELLOW_ABOVE * 2)).status).toBe('YELLOW');
    expect(summarizeTierShares([{ model: 'not-on-the-ladder', inputTokens: SCALE }]).status).toBe('UNMEASURED');
  });

  // P2-13 HARNESS-DIFFICULTY-ROUTER-WEAK70-FU(ROSTER-0334) — 약 몫 하한 WEAK_SHARE_MIN 이 status 에 반영되는가.
  it('weak below WEAK_SHARE_MIN is not GREEN — 약 하한 미달(합성 fixture)', () => {
    // 합성 fixture(칸 증거 우주 = 시뮬 · 실측·원장 데이터 아님): 약 몫이 하한의 절반에 그친 모집단.
    const weak = WEAK_SHARE_MIN / 2;
    const mid = 1 - weak;
    const report = summarizeTierShares([
      { runId: 'run-weak-short', workTier: 'weak', inputTokens: weak * SCALE },
      { runId: 'run-weak-short', workTier: 'mid', inputTokens: mid * SCALE },
    ]);
    const byTier = Object.fromEntries(report.rows.map((row) => [row.tier, row]));
    expect(byTier.weak!.share).toBeLessThan(WEAK_SHARE_MIN); // 전건: 약 몫이 실제로 하한 아래
    expect(report.weakShare).toBeCloseTo(weak);
    expect(report.status).toBe('YELLOW'); // GREEN — 구현 후 약 하한 미달은 GREEN 이 아니다
  });

  it('the view appears only with --tier-share; the default text and JSON stay as before', async () => {
    const run = async (args: string[]) => {
      const lines: string[] = [];
      const command = new Command();
      registerUsageCommand(command, { readRunLogs: () => rowsFor(STRONG_SHARE_YELLOW_ABOVE * 2).map(usageRow),
        out: { log: (line) => lines.push(line) }, exit: (code) => { throw new Error(`exit ${code}`); } });
      await command.parseAsync(['usage', ...args], { from: 'user' });
      return lines;
    };
    // 생략 = 종전 출력 그대로: 텍스트에 등급 몫 줄이 없고, JSON 은 행 배열이다.
    const plain = await run(['runs', '--by', 'role']);
    expect(plain.some((line) => line.includes('등급별 몫') || /\b(weak|mid|strong|unknown)  calls=/.test(line))).toBe(false);
    const plainJson = JSON.parse((await run(['runs', '--by', 'role', '--json']))[0]!);
    expect(Array.isArray(plainJson)).toBe(true);
    expect(plain).toHaveLength(plainJson.length);
    const text = await run(['runs', '--by', 'role', '--tier-share']);
    expect(text[0]).toContain('YELLOW');
    expect(text.slice(text.length - plain.length)).toEqual(plain);
    expect(text.join('\n')).not.toContain('rounds=');
    const withShare = JSON.parse((await run(['runs', '--by', 'role', '--json', '--tier-share']))[0]!);
    expect(withShare.tierShare.status).toBe('YELLOW');
    expect(withShare.tierShare.targets.strongYellowAbove).toBe(STRONG_SHARE_YELLOW_ABOVE);
  });
});

// ── P2-13 HARNESS-DIFFICULTY-ROUTER-WEAK70-FU 시뮬 증명(ROSTER-0334 · 증거 우주 = 시뮬) ──
// 합성 골 모집단(plain L1~L3 다수 + risky L4+ 소수 · «구조 칸» 줄머리 형식)에서 코어 decide(CORE_BASE_TIER 배정)가
// 고른 등급의 토큰 몫이 약 하한 WEAK_SHARE_MIN(표 ≥70%) 에 닿는다. 실제 원장·실측 데이터 아님 — 문면 전부 합성 fixture.
// 골 산문에 정규식을 걸지 않는다(A205 · R-SIG) — 구조 칸 줄머리 일치(workRiskInputFromFields)만 읽는다.
describe('weak ≥70% over a synthetic routed population — 칸 시뮬', () => {
  // 합성 모집단 규모(정책 상수 아님 — 시나리오 fixture 크기): plain 12 · risky 2.
  const plainPaths = (count: number, group: string) =>
    Array.from({ length: count }, (_, index) => `synth/${group}/file-${index}.ts`); // 문서(.md) 경로 아님
  const plainGold = [
    ...Array.from({ length: 4 }, (_, index) => `대상 경로: ${plainPaths(1, `ui-${index}`).join(' · ')}`), // 경로 1 = L1
    ...Array.from({ length: 4 }, () => `대상 경로: ${plainPaths(3, 'text').join(' · ')}`), // 경로 3 = L2
    ...Array.from({ length: 4 }, () => `대상 경로: ${plainPaths(4, 'view').join(' · ')}`), // 경로 4 = L3
  ];
  const riskyGold = [
    '대상 경로: synth/auth/vault.ts\n위험 범주: security', // 선언 범주 1개 → L4
    '대상 경로: synth/store/cart.ts', // 경로 토큰 store → persistence L4
  ];

  it('core decide over a plain-majority gold population reaches weak share ≥ WEAK_SHARE_MIN (GREEN)', () => {
    const core = createModelOrchestrationCore(DEFAULT_CORE_MODULES);
    const rows: TierShareInput[] = [];
    for (const [index, doc] of [...plainGold, ...riskyGold].entries()) {
      const work = classifyWorkRisk(workRiskInputFromFields(doc));
      for (const moment of ['design', 'judge', 'implement'] as const) {
        // 계기 없는 손일 결정 — CORE_BASE_TIER: plain 전 순간 약 · risky 설계·판정 강 · 구현 중.
        const decision = core.decide({ runId: `sim-weak70-${index}`, provider: 'grok', work, moment });
        rows.push({ runId: `sim-weak70-${index}`, workTier: decision.tier, inputTokens: SCALE });
      }
    }
    const report = summarizeTierShares(rows);
    // 분포 산출: 약 36/42 ≈ 85.7% ≥ WEAK_SHARE_MIN · 강 4/42 ≈ 9.5% ≤ STRONG_SHARE_YELLOW_ABOVE.
    expect(report.weakShare).not.toBeNull();
    expect(report.weakShare!).toBeGreaterThanOrEqual(WEAK_SHARE_MIN);
    expect(report.strongShare!).toBeLessThanOrEqual(STRONG_SHARE_YELLOW_ABOVE);
    expect(report.status).toBe('GREEN');
  });
});
