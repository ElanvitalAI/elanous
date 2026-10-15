import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../mss/logging/log-store.js';
import { readUsageDaily } from './usage-daily-store.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'usage-daily-read-'));
  const path = join(root, 'logs', 'logs.db');
  const logs = new LogStore(path);
  const put = (event: string, data: Record<string, unknown>, ts = '2026-10-01T12:00:00Z') =>
    logs.insertBatch([{ rec: { ts, category: 'llm.usage', event, data }, surface: 'harness' }]);
  const close = () => { logs.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, path, logs, put, close };
}

test('reads every llm.usage event into UTC hour buckets without creating an output ledger', () => {
  const f = fixture();
  try {
    f.put('llm-usage', { site: 'stream-llm', model: 'm', inputTokens: 7, cost: { kind: 'unknown' } });
    f.put('other-usage-event', { site: 'stream-llm', model: 'm', inputTokens: 9, cost: { kind: 'known', usd: 0.2 } }, '2026-10-01T13:00:00Z');
    f.put('llm-usage', { origin: 'pod', podJob: 'j', inputTokens: 100 });
    f.put('llm-usage', { measured: false, inputTokens: 200 });
    const report = readUsageDaily(f.path);
    expect(report).toMatchObject({ podObservedRows: 1, unclassifiedRows: 1,
      rows: [
        { day: '2026-10-01', hour: '2026-10-01T12', inputTokens: 7, unknownCostCalls: 1 },
        { day: '2026-10-01', hour: '2026-10-01T13', inputTokens: 9, usdKnown: 0.2 },
      ] });
    expect(report!.rows.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(16);
    expect(existsSync(join(f.root, 'budget'))).toBe(false);
    expect(f.logs.query({ exactCategories: ['llm.usage'], limit: 100 })).toHaveLength(4);
  } finally { f.close(); }
});

test('reports a missing source, and since filters retained rows without modifying them', () => {
  const f = fixture();
  try {
    f.put('usage-a', { model: 'old', inputTokens: 1 }, '2026-09-30T23:00:00Z');
    f.put('usage-b', { model: 'new', inputTokens: 2 }, '2026-10-01T00:00:00Z');
    expect(readUsageDaily(f.path, '2026-10-01')?.rows).toMatchObject([{ day: '2026-10-01', inputTokens: 2 }]);
    expect(readUsageDaily(join(f.root, 'absent.db'))).toBeNull();
    expect(f.logs.query({ exactCategories: ['llm.usage'], limit: 100 })).toHaveLength(2);
  } finally { f.close(); }
});

test('preserves explicit zero counts and reads beyond the first 1,000-row page', () => {
  const f = fixture();
  try {
    const rec = { ts: '2026-10-01T12:00:00Z', category: 'llm.usage', event: 'another-usage-event',
      data: { model: 'm', calls: 0, inputTokens: 1, cost: { kind: 'unknown', unknownCostCalls: 0, includedCalls: 0 } } };
    f.logs.insertBatch(Array.from({ length: 1002 }, () => ({ rec, surface: 'harness' })));
    const report = readUsageDaily(f.path);
    expect(report?.rows).toMatchObject([{ calls: 0, inputTokens: 1002, unknownCostCalls: 0, includedCalls: 0 }]);
    expect(f.logs.query({ exactCategories: ['llm.usage'], limit: 2000 })).toHaveLength(1002);
  } finally { f.close(); }
});
