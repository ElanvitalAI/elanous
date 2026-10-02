import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLedger, costTable, judge, lastLedgerLine, pickRange, writeCardDraft } from './lib.js';

const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'];
const costs = new Map([['a.test.ts', 30], ['b.test.ts', 30], ['c.test.ts', 100], ['d.test.ts', 5]]);

describe('pickRange — a cost-weighted slice from the cursor', () => {
  test('stops before the budget is exceeded and reports the next cursor', () => {
    expect(pickRange(files, 0, costs, 60)).toMatchObject({ start: 0, end: 1, next: 2, files: ['a.test.ts', 'b.test.ts'], estimatedSecs: 60 });
  });
  test('always takes at least one file, even one above the budget', () => {
    expect(pickRange(files, 2, costs, 10).files).toEqual(['c.test.ts']);
  });
  test('wraps at the end of the suite; unknown files cost the default', () => {
    expect(pickRange(files, 3, costs, 40)).toMatchObject({ start: 3, files: ['d.test.ts', 'a.test.ts'], next: 1 });
    expect(pickRange(['x.test.ts'], 0, new Map(), 5).estimatedSecs).toBe(10);
  });
});

describe('judge — mechanical, never an action', () => {
  const base = { file: 'x.test.ts', secs: 5, rssMb: 100, rc: 0, pass: 3, fail: 0 };
  test('slow or heavy with nothing caught in 90 days is «review»; with a catch it is «keep»', () => {
    expect(judge({ ...base, secs: 90 }, 0)).toMatchObject({ verdict: 'review', flags: ['slow'] });
    expect(judge({ ...base, rssMb: 4096 }, 0)).toMatchObject({ verdict: 'review', flags: ['heavy'] });
    expect(judge({ ...base, secs: 90 }, 2).verdict).toBe('keep');
  });
  test('a non-zero exit is «failing» and keeps its reason', () => {
    expect(judge({ ...base, rc: 1, reason: 'Unable to locate a Java Runtime.' }, 0)).toMatchObject({ verdict: 'failing', reason: 'Unable to locate a Java Runtime.' });
  });
});

describe('ledger and card draft', () => {
  test('one line per run carries the range «#a~#b»; the draft lists only non-keep files with their reason', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-diet-'));
    try {
      const results = [judge({ file: 'ok.test.ts', secs: 1, rssMb: 30, rc: 0, pass: 1, fail: 0 }, 0), judge({ file: 'java.test.ts', secs: 0, rssMb: 29, rc: 1, pass: 0, fail: 1, reason: 'Unable to locate a Java Runtime.' }, 0)];
      const line = { at: '2026-10-02T00:40:00.000Z', range: '#0~#1', start: 0, end: 1, next: 2, total: 2, commit: 'abc', budgetSecs: 60, results };
      appendLedger(root, line);
      expect(lastLedgerLine(root)?.range).toBe('#0~#1');
      const card = writeCardDraft(root, line)!;
      const text = readFileSync(card, 'utf8');
      expect(text).toContain('`java.test.ts` | failing');
      expect(text).toContain('Unable to locate a Java Runtime.');
      expect(text).not.toContain('`ok.test.ts`');
      expect(text).toContain('아무것도 지우거나 옮기지 않았다');
      expect(writeCardDraft(root, { ...line, results: [results[0]!] })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('the cost table reads the TD1 whole-gate TSV', () => {
    expect(costTable('file\tsecs\trss\nx.test.ts\t12\t30\nbad\tNaN\t1\n')).toEqual(new Map([['x.test.ts', 12]]));
  });
});
