import { describe, expect, it } from 'bun:test';
import {
  collectUsageLogPages,
  formatLlmCostLedger,
  pageIsIncomplete,
  spawnPageFailure,
  summarizeLlmUsageRows,
} from './llm-cost-ledger.js';

const terraRow = JSON.stringify({ model: 'gpt-5.6-terra', inputTokens: 1, outputTokens: 0 });

describe('llm-cost-ledger pagination', () => {
  it('does not treat a truncated page without a cursor as a complete total', () => {
    const parsed = pageIsIncomplete(
      `${JSON.stringify({ model: 'gpt-5.6-terra', inputTokens: 1, outputTokens: 0 })}\n${JSON.stringify({ _meta: { type: 'log-query-limit', limitReached: true, nextCursor: null } })}\n`,
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
          JSON.stringify({ model: 'gpt-5.6-luna', inputTokens: 1, outputTokens: 0 }),
          JSON.stringify({ _meta: { type: 'log-query-limit', limitReached: true, nextCursor: null, nextCursors: { prod: 9 } } }),
        ].join('\n'),
        stderr: 'elanous logs: result may be truncated (limitReached=true)\n',
        status: 0,
      },
      {
        stdout: JSON.stringify({ model: 'gpt-5.6-terra', inputTokens: 1_000_000, outputTokens: 0 }),
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

  it('prints catalog-priced totals and keeps omitted tokens out of known totals', () => {
    const summary = {
      ...summarizeLlmUsageRows([
        JSON.stringify({ category: 'llm.usage', data: { model: 'gpt-5.6-terra', inputTokens: 1_000_000, outputTokens: 0 } }),
        JSON.stringify({ model: 'gpt-5.6-luna', inputTokens: 3, outputTokens: 1 }),
        JSON.stringify({ category: 'llm.usage', data: { model: 'gpt-5.6-terra', outputTokens: 1_000_000 } }),
      ], {}),
      incomplete: false,
    };
    expect(summary.knownUsd).toBe(2.000009);
    expect(summary.partialUsd).toBe(12);
    expect(summary.measurableUsd).toBe(14.000009);
    expect(summary.unknownRows).toBe(0);
    expect(summary.unknownModels).toEqual([]);
    expect(summary.partialRows).toBe(1);
    expect(summary.partialModels).toEqual(['gpt-5.6-terra']);
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
        JSON.stringify({ model: 'gpt-5.6-terra', inputTokens: 1_000_000, outputTokens: 0 }),
        JSON.stringify({ model: 'unpriced-model', inputTokens: 3, outputTokens: 1 }),
        JSON.stringify({ model: 'gpt-5.6-terra', outputTokens: 1_000_000 }),
      ], {}),
      incomplete: false,
    };
    expect(summary.knownUsd).toBe(2);
    expect(summary.partialUsd).toBe(12);
    expect(summary.measurableUsd).toBe(14);
    expect(summary.unknownRows).toBe(1);
    expect(summary.unknownModels).toEqual(['unpriced-model']);
    expect(formatLlmCostLedger(summary)).toContain('unknownModels unpriced-model');
  });

  it('adds the priced portion of a partial row to the total without calling it known', () => {
    const summary = summarizeLlmUsageRows([
      JSON.stringify({ model: 'gpt-5.6-terra', outputTokens: 1_000_000 }),
    ], {});
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
      `${terraRow}\n{"model":"gpt-5.6-luna","inputTokens":\n`,
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
      ...summarizeLlmUsageRows(truncated.lines, {}),
      incomplete: truncated.incomplete,
      failure: truncated.failure,
    })).toContain('failure invalid-json');
  });
});
