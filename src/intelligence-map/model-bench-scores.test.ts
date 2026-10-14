import { expect, test } from 'bun:test';
import { BUILTIN_CATALOG } from './model-catalog.js';
import { compareRows, joinWithCatalog, parseBenchScoresTsv } from './model-bench-scores.js';

// Three rows only: a catalog/OpenRouter match, a zero-cost known score, and an unknown score.
const fixture = [
  'notes\tAA_coding\tid\tsources\test_run$\tTerminalBench\tprovider\tctx\tin$/1M\tout$/1M\tcacheRead$/1M\tAA_intel\tAA_agentic\tSWE_verified\tSWE_pro\tLiveCodeBench\ttool_use',
  'labeled\tAA TB4.0 33.3\tdeepseek/deepseek-v4.1-flash\tAA;OR\t0.5\t12\tdeepseek\t1,048,576\t0.15\t0.60\t미표기\t미확인\t18\t50\t-\t\t0',
  'free\t80\tno-such-vendor/unknown\tOR\t0\t9\tother\t1000\t0\t0\t-\t1\t2\t3\t4\t5\t6',
  'missing\t미확인\topenai/gpt-4o\tAA\t\t7\topenai\t\t미확인\t미표기\t\t-\t\t\t\t\t',
].join('\n');

test('parses header-positioned numeric cells, preserves originals and never invents zero for unknowns', () => {
  const rows = parseBenchScoresTsv(fixture);
  expect(rows).toHaveLength(3);
  expect(rows[0]?.AA_coding).toBe(33.3);
  expect(rows[0]?.raw.AA_coding).toBe('AA TB4.0 33.3');
  expect(rows[0]?.ctx).toBe(1048576);
  expect(rows[0]?.['in$/1M']).toBe(0.15);
  expect(rows[0]?.['out$/1M']).toBe(0.60);
  expect(rows[0]?.raw.sources).toBe('AA;OR');
  expect(rows[0]?.['cacheRead$/1M']).toBeNull();
  expect(rows[0]?.AA_intel).toBeNull();
  expect(rows[0]?.SWE_pro).toBeNull();
  expect(rows[0]?.LiveCodeBench).toBeNull();
  expect(rows[0]?.tool_use).toBe(0);
  expect(rows[1]?.est_run$).toBe(0);
  expect(rows[2]?.est_run$).toBeNull();
  expect(rows[2]?.['in$/1M']).toBeNull();
  expect(rows[2]?.['out$/1M']).toBeNull();
  expect(rows[2]?.['cacheRead$/1M']).toBeNull();
});

test('rejects TSV without an id header', () => {
  expect(() => parseBenchScoresTsv('provider\tAA_coding\nopenai\t12')).toThrow('missing id header');
});

test('joins catalog IDs and OpenRouter vendor IDs without treating unknown models as catalog entries', () => {
  const joined = joinWithCatalog(parseBenchScoresTsv(fixture), BUILTIN_CATALOG);
  expect(joined.map((row) => row.inCatalog)).toEqual([true, false, true]);
  expect(joinWithCatalog(parseBenchScoresTsv(fixture.replace('deepseek/deepseek-v4.1-flash', 'openrouter/deepseek/deepseek-v4.1-flash')), BUILTIN_CATALOG)[0]?.inCatalog).toBe(true);
});

test('compares score per estimated dollar, keeps unknown score last and unpriceable value null', () => {
  const rows = joinWithCatalog(parseBenchScoresTsv(fixture), BUILTIN_CATALOG);
  const compared = compareRows(rows, { score: 'AA_coding' });
  expect(compared.map((row) => row.id)).toEqual([
    'deepseek/deepseek-v4.1-flash', 'no-such-vendor/unknown', 'openai/gpt-4o',
  ]);
  expect(compared[0]?.value).toBeCloseTo(66.6);
  expect(compared[0]?.sources).toBe('AA;OR');
  expect(compared[0]?.inCatalog).toBe(true);
  expect(compared[1]?.value).toBeNull();
  expect(compared[2]?.value).toBeNull();
  expect(compared[2]?.status).toBe('미확인');
  expect(compareRows(rows, { score: 'TerminalBench' })[0]?.id).toBe('deepseek/deepseek-v4.1-flash');
});

test('sorts positive-cost rows by descending score per dollar, not input order', () => {
  const rows = parseBenchScoresTsv(fixture);
  const lowerValue = rows[0]!; // 33.3 / 0.5 = 66.6
  const higherValue = { ...rows[1]!, est_run$: 0.5 }; // 80 / 0.5 = 160
  const compared = compareRows([lowerValue, higherValue], { score: 'AA_coding' });
  expect(compared.map((row) => row.id)).toEqual([
    'no-such-vendor/unknown', 'deepseek/deepseek-v4.1-flash',
  ]);
  expect(compared.map((row) => row.value)).toEqual([160, 66.6]);
});
