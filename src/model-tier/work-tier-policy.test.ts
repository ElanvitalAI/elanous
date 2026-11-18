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
