import { describe, expect, it } from 'bun:test';
import {
  collectUsageLogPages,
  formatLlmCostLedger,
  main,
  pageIsIncomplete,
  spawnPageFailure,
  summarizeLlmUsageRows,
} from './llm-cost-ledger.js';
// 새 export 는 네임스페이스 경유로만 참조한다 — 조상(base)에는 이 심볼이 없어 네임드 정적
// import 면 모듈 로드 SyntaxError 로 죽고 RED 가 «모듈 로드 에러»로 분류된다. 네임스페이스 +
// typeof 존재 단언이면 base 에서도 모듈이 로드되어 일반 expect 실패(구별되는 RED)가 된다.
import * as ledger from './llm-cost-ledger.js';
import type { LlmPricingUsd } from '../src/budget/llm-cost.js';

// 단가 픽스처 — 모델 «이름»을 박지 않는다(ci-model-hardcode-gate). 단가는 estimateLlmCost 의
// 기존 configPricing 오버레이로 고정하므로 카탈로그 개정에도 이 원장 시험이 늙지 않는다.
// 실 카탈로그 해상도(catalog → bedrock → registry)는 src/budget/llm-cost.test.ts 가 덮는다.
const PRICED_MODEL = 'fixture-priced-model';
const CHEAP_MODEL = 'fixture-cheap-model';
const UNPRICED_MODEL = 'fixture-unpriced-model';

const FIXTURE_PRICING: Readonly<Record<string, LlmPricingUsd>> = {
  [PRICED_MODEL]: { inputPerM: 2, outputPerM: 12 },
  [CHEAP_MODEL]: { inputPerM: 1, outputPerM: 6 },
};

const terraRow = JSON.stringify({ model: PRICED_MODEL, inputTokens: 1, outputTokens: 0 });
const cheapRow = JSON.stringify({ model: CHEAP_MODEL, inputTokens: 3, outputTokens: 1 });
const unpricedRow = JSON.stringify({ model: UNPRICED_MODEL, inputTokens: 3, outputTokens: 1 });

describe('llm-cost-ledger pagination', () => {
  it('does not treat a truncated page without a cursor as a complete total', () => {
    const parsed = pageIsIncomplete(
      `${terraRow}\n${JSON.stringify({ _meta: { type: 'log-query-limit', limitReached: true, nextCursor: null } })}\n`,
      'elanous logs: result may be truncated (limitReached=true)\n',
      0,
    );
    expect(parsed.limitReached).toBe(true);
    expect(parsed.incomplete).toBe(true);
    expect(parsed.usageLines).toHaveLength(1);
  });

  it('pages through nextCursors until the scan is complete', () => {
    const pages = [
      {
        stdout: [
          cheapRow,
          JSON.stringify({ _meta: { type: 'log-query-limit', limitReached: true, nextCursor: null, nextCursors: { prod: 9 } } }),
        ].join('\n'),
        stderr: 'elanous logs: result may be truncated (limitReached=true)\n',
        status: 0,
      },
      {
        stdout: JSON.stringify({ model: PRICED_MODEL, inputTokens: 1_000_000, outputTokens: 0 }),
        stderr: '',
        status: 0,
      },
    ];
    const befores: Array<string | undefined> = [];
    const collected = collectUsageLogPages((before) => {
      befores.push(before);
      return pages.shift() ?? { stdout: '', stderr: '', status: 1 };
    });
    expect(befores).toEqual([undefined, '{"prod":9}']);
    expect(collected.incomplete).toBe(false);
    expect(collected.lines).toHaveLength(2);
  });

  it('prints pinned-unit-price totals and keeps omitted tokens out of known totals', () => {
    const summary = {
      ...summarizeLlmUsageRows([
        JSON.stringify({ category: 'llm.usage', data: { model: PRICED_MODEL, inputTokens: 1_000_000, outputTokens: 0 } }),
        cheapRow,
        JSON.stringify({ category: 'llm.usage', data: { model: PRICED_MODEL, outputTokens: 1_000_000 } }),
      ], FIXTURE_PRICING),
      incomplete: false,
    };
    expect(summary.knownUsd).toBe(2.000009);
    expect(summary.partialUsd).toBe(12);
    expect(summary.measurableUsd).toBe(14.000009);
    expect(summary.unknownRows).toBe(0);
    expect(summary.unknownModels).toEqual([]);
    expect(summary.partialRows).toBe(1);
    expect(summary.partialModels).toEqual([PRICED_MODEL]);
    const printed = formatLlmCostLedger(summary);
    expect(printed).toContain('measurableUsd 14.000009');
    expect(printed).toContain('knownUsd 2.000009');
    expect(printed).toContain('partialUsd 12');
    expect(printed).toContain('unknownRows 0');
    expect(printed).toContain('unknownModels (none)');
    expect(printed).toContain('incomplete false');
  });

  it('prints measurable USD and unknown remainder together', () => {
    const summary = {
      ...summarizeLlmUsageRows([
        JSON.stringify({ model: PRICED_MODEL, inputTokens: 1_000_000, outputTokens: 0 }),
        unpricedRow,
        JSON.stringify({ model: PRICED_MODEL, outputTokens: 1_000_000 }),
      ], FIXTURE_PRICING),
      incomplete: false,
    };
    expect(summary.knownUsd).toBe(2);
    expect(summary.partialUsd).toBe(12);
    expect(summary.measurableUsd).toBe(14);
    expect(summary.unknownRows).toBe(1);
    expect(summary.unknownModels).toEqual([UNPRICED_MODEL]);
    expect(formatLlmCostLedger(summary)).toContain(`unknownModels ${UNPRICED_MODEL}`);
  });

  it('adds the priced portion of a partial row to the total without calling it known', () => {
    const summary = summarizeLlmUsageRows([
      JSON.stringify({ model: PRICED_MODEL, outputTokens: 1_000_000 }),
    ], FIXTURE_PRICING);
    expect(summary.knownUsd).toBe(0);
    expect(summary.partialUsd).toBe(12);
    expect(summary.measurableUsd).toBe(12);
    expect(summary.partialRows).toBe(1);
    expect(summary.unknownRows).toBe(0);
  });

  it('treats spawn status !== 0, null status, error, and signal as incomplete failures', () => {
    const cases = [
      pageIsIncomplete(`${terraRow}\n`, '', 1),
      pageIsIncomplete(`${terraRow}\n`, '', null),
      pageIsIncomplete(`${terraRow}\n`, '', 0, {
        error: Object.assign(new Error('stdout maxBuffer exceeded'), { code: 'ENOBUFS' }),
      }),
      pageIsIncomplete(`${terraRow}\n`, '', null, { signal: 'SIGTERM' }),
    ];
    expect(cases.map((parsed) => ({
      incomplete: parsed.incomplete,
      failure: parsed.failure,
      rows: parsed.usageLines.length,
    }))).toEqual([
      { incomplete: true, failure: 'exit 1', rows: 1 },
      { incomplete: true, failure: 'spawn status null', rows: 1 },
      { incomplete: true, failure: 'spawn error: ENOBUFS', rows: 1 },
      { incomplete: true, failure: 'killed by SIGTERM', rows: 1 },
    ]);
    expect(spawnPageFailure(0)).toBeUndefined();
    expect(spawnPageFailure(null)).toBe('spawn status null');
    expect(spawnPageFailure(2)).toBe('exit 2');
  });

  it('does not treat a valid row followed by truncated JSON as a complete total', () => {
    const parsed = pageIsIncomplete(
      `${terraRow}\n{"model":"${CHEAP_MODEL}","inputTokens":\n`,
      '',
      0,
    );
    expect(parsed.usageLines).toEqual([terraRow]);
    expect(parsed.incomplete).toBe(true);
    expect(parsed.failure).toBe('invalid-json');
    expect(parsed.limitReached).toBe(false);
  });

  it('propagates spawn and truncated-JSON failures through page collection', () => {
    const spawnFailed = collectUsageLogPages(() => ({
      stdout: terraRow,
      stderr: '',
      status: null,
      error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    }));
    expect(spawnFailed.incomplete).toBe(true);
    expect(spawnFailed.failure).toBe('spawn error: ETIMEDOUT');
    expect(spawnFailed.lines).toEqual([terraRow]);

    const truncated = collectUsageLogPages(() => ({
      stdout: `${terraRow}\n["not", "an", "object"]\n`,
      stderr: '',
      status: 0,
    }));
    expect(truncated.incomplete).toBe(true);
    expect(truncated.failure).toBe('invalid-json');
    expect(truncated.lines).toEqual([terraRow]);
    expect(formatLlmCostLedger({
      ...summarizeLlmUsageRows(truncated.lines, FIXTURE_PRICING),
      incomplete: truncated.incomplete,
      failure: truncated.failure,
    })).toContain('failure invalid-json');
  });
});

const reconcileRows = [
  JSON.stringify({ model: PRICED_MODEL, inputTokens: 1_000_000, outputTokens: 0 }),
  JSON.stringify({ model: PRICED_MODEL, outputTokens: 1_000_000 }),
  unpricedRow,
];

function expectReconcileApi(): void {
  expect(typeof ledger.reconcileLlmCostVsBalance).toBe('function');
}

function runLedgerWithBalance(balance: { beforeUsd: number; afterUsd: number; provider?: string }) {
  expectReconcileApi();
  const out: string[] = [];
  const summary = main(process.cwd(), {
    fetchPage: () => ({ stdout: reconcileRows.join('\n'), stderr: '', status: 0 }),
    balance,
    configPricing: FIXTURE_PRICING,
    out: (line) => out.push(line),
  });
  return { summary, printed: out.join('\n') };
}

describe('llm-cost-ledger balance reconcile', () => {
  it('exposes reconcileLlmCostVsBalance from the ledger module', () => {
    expectReconcileApi();
  });

  it('TOKEN-BILLING-RECONCILE: 대조 대상: 일별 토큰×단가와 공급자 잔액 변화, 경보 임계: 차이 10% 초과', () => {
    const { summary, printed } = runLedgerWithBalance({ beforeUsd: 20, afterUsd: 8 });

    expect(summary.measurableUsd).toBe(14);
    expect(summary.reconcile).toMatchObject({
      measuredUsd: 14,
      balanceDeltaUsd: 12,
      diffUsd: 2,
      thresholdRatio: 0.1,
      status: 'alert',
      unmeasuredRows: 1,
      unmeasuredModels: [UNPRICED_MODEL],
      unmeasuredUsd: null,
    });
    expect(summary.reconcile!.provider).toBeUndefined();
    expect(summary.reconcile!.diffRatio).toBeCloseTo(2 / 12, 12);
    expect(printed).toContain('reconcileProvider (unknown)');
    expect(printed).not.toContain('reconcileProvider provider');
    expect(printed).toContain('reconcileMeasuredUsd 14');
    expect(printed).toContain('reconcileBalanceDeltaUsd 12');
    expect(printed).toContain('reconcileDiffUsd 2');
    expect(printed).toContain('reconcileStatus alert');
    expect(printed).toContain('alert reconcile-diff');
  });

  it('prints the provider only when the caller reported one, never a synthesised default', () => {
    const observed = runLedgerWithBalance({ beforeUsd: 20, afterUsd: 8, provider: 'fixture-provider' });
    expect(observed.summary.reconcile!.provider).toBe('fixture-provider');
    expect(observed.printed).toContain('reconcileProvider fixture-provider');

    const blank = runLedgerWithBalance({ beforeUsd: 20, afterUsd: 8, provider: '   ' });
    expect(blank.summary.reconcile!.provider).toBeUndefined();
    expect(blank.printed).toContain('reconcileProvider (unknown)');

    const missing = ledger.reconcileLlmCostVsBalance({ measuredUsd: 14, balanceBeforeUsd: 20, balanceAfterUsd: 8 });
    expect(missing.provider).toBeUndefined();
    expect('provider' in missing).toBe(false);
    expect(formatLlmCostLedger({ ...summarizeLlmUsageRows(reconcileRows, FIXTURE_PRICING), incomplete: false, reconcile: missing }))
      .toContain('reconcileProvider (unknown)');
  });

  it('keeps the ledger quiet when the difference stays at or below 10%', () => {
    expectReconcileApi();
    const atThreshold = ledger.reconcileLlmCostVsBalance({ measuredUsd: 11, balanceBeforeUsd: 20, balanceAfterUsd: 10 });
    expect(atThreshold.diffUsd).toBe(1);
    expect(atThreshold.diffRatio).toBe(0.1);
    expect(atThreshold.status).toBe('ok');

    const within = ledger.reconcileLlmCostVsBalance({ measuredUsd: 10.5, balanceBeforeUsd: 20, balanceAfterUsd: 10 });
    expect(within.status).toBe('ok');

    const { printed, summary } = runLedgerWithBalance({ beforeUsd: 20, afterUsd: 6 });
    expect(summary.reconcile!.balanceDeltaUsd).toBe(14);
    expect(summary.reconcile!.diffUsd).toBe(0);
    expect(summary.reconcile!.status).toBe('ok');
    expect(printed).toContain('reconcileStatus ok');
    expect(printed).not.toContain('alert reconcile-diff');
  });

  it('keeps the unpriced remainder separate from the reconciled dollars', () => {
    const { summary, printed } = runLedgerWithBalance({ beforeUsd: 20, afterUsd: 8 });
    expect(summary.knownUsd).toBe(2);
    expect(summary.partialUsd).toBe(12);
    expect(summary.measurableUsd).toBe(14);
    expect(summary.unknownRows).toBe(1);
    expect(printed).toContain('reconcileMeasuredUsd 14');
    expect(printed).toContain('reconcileUnmeasuredRows 1');
    expect(printed).toContain(`reconcileUnmeasuredModels ${UNPRICED_MODEL}`);
    expect(printed).toContain('unknownRows 1');
    expect(printed).not.toContain('reconcileMeasuredUsd 17');
  });

  it('does not call a provider balance top-up a clean reconcile', () => {
    expectReconcileApi();
    const topUp = ledger.reconcileLlmCostVsBalance({ measuredUsd: 14, balanceBeforeUsd: 10, balanceAfterUsd: 40 });
    expect(topUp.balanceDeltaUsd).toBe(-30);
    expect(topUp.diffUsd).toBeNull();
    expect(topUp.diffRatio).toBeNull();
    expect(topUp.status).toBe('unmeasured');

    const { printed } = runLedgerWithBalance({ beforeUsd: 10, afterUsd: 40 });
    expect(printed).toContain('reconcileStatus unmeasured');
    expect(printed).not.toContain('alert reconcile-diff');
  });

  it('alerts when the provider balance did not move but the ledger measured spend', () => {
    const { summary, printed } = runLedgerWithBalance({ beforeUsd: 12, afterUsd: 12 });
    expect(summary.reconcile!.balanceDeltaUsd).toBe(0);
    expect(summary.reconcile!.status).toBe('alert');
    expect(summary.reconcile!.diffRatio).toBeNull();
    expect(printed).toContain('reconcileBalanceDeltaUsd 0');
    expect(printed).toContain('alert reconcile-diff');
  });

  it('prints the unchanged ledger when no provider balance is supplied', () => {
    expectReconcileApi();
    const out: string[] = [];
    const summary = main(process.cwd(), {
      fetchPage: () => ({ stdout: reconcileRows.join('\n'), stderr: '', status: 0 }),
      configPricing: FIXTURE_PRICING,
      out: (line) => out.push(line),
    });
    expect(summary.reconcile).toBeUndefined();
    expect(out.join('\n')).toBe([
      'measurableUsd 14',
      'knownUsd 2',
      'partialUsd 12',
      'unknownRows 1',
      `unknownModels ${UNPRICED_MODEL}`,
      'partialRows 1',
      `partialModels ${PRICED_MODEL}`,
      'rows 3',
      'incomplete false',
    ].join('\n'));
  });
});
