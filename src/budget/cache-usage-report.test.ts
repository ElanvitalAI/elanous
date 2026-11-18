import { describe, expect, test } from 'bun:test';
import { formatCacheUsageReport, summarizeCacheUsage, type CacheUsageRow } from './cache-usage-report.js';

const rows: CacheUsageRow[] = [
  { sessionId: 's1', billingProvider: 'glm', model: 'glm-5.3', inputTokens: 200, cacheReadInputTokens: 800 },
  { sessionId: 's1', billingProvider: 'glm', model: 'glm-5.3', inputTokens: 100, cacheReadInputTokens: 900 },
  { sessionId: 's1', billingProvider: 'grok', model: 'grok-x', inputTokens: 500 },
  { sessionId: 's2', billingProvider: 'openrouter', model: 'anthropic/claude', inputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 950 },
];

describe('O4 cache usage report', () => {
  test('hit rate = cacheRead / (input + cacheRead + cacheWrite) over calls that reported cache fields', () => {
    const report = summarizeCacheUsage(rows, { sessionId: 's1', compactions: 2 });
    const glm = report.groups.find(group => group.key === 'glm/glm-5.3')!;
    expect(glm.hitRate).toBe((800 + 900) / (200 + 800 + 100 + 900));
    expect(report.total.calls).toBe(3);
    expect(report.total.reportedCalls).toBe(2);
    expect(report.compactions).toBe(2);
  });

  test('a provider that never reports cache fields is «not measured», not a 0% miss', () => {
    const report = summarizeCacheUsage(rows, { sessionId: 's1' });
    expect(report.groups.find(group => group.key === 'grok/grok-x')).toMatchObject({ calls: 1, reportedCalls: 0, hitRate: null });
    expect(formatCacheUsageReport(report)).toContain('못 잼');
  });

  test('cache writes count toward the prompt but not the hit', () => {
    const report = summarizeCacheUsage(rows, { sessionId: 's2' });
    expect(report.total).toMatchObject({ cacheCreationInputTokens: 950, hitRate: 0 });
  });

  test('no session filter aggregates every row', () => {
    expect(summarizeCacheUsage(rows).total.calls).toBe(rows.length);
  });

  test('calls without cache fields still count in total input but not in the hit-rate denominator', () => {
    const report = summarizeCacheUsage(rows, { sessionId: 's1' });
    const grok = report.groups.find(group => group.key === 'grok/grok-x')!;
    expect(grok).toMatchObject({ inputTokens: 500, reportedInputTokens: 0 });
    expect(report.total.inputTokens).toBe(200 + 100 + 500);
    expect(report.total.reportedInputTokens).toBe(200 + 100);
    expect(report.total.hitRate).toBe((800 + 900) / (200 + 100 + 800 + 900));
  });

  test('the compaction count is shown even when no usage row matched', () => {
    const text = formatCacheUsageReport(summarizeCacheUsage([], { sessionId: 'quiet', compactions: 2 }));
    expect(text).toContain('압축 2회');
    expect(text).toContain('quiet');
  });
});
