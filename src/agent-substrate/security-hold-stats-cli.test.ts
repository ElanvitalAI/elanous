import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityHoldStats, savedReviewStats, runSecurityHoldStatsCli } from './security-hold-stats-cli.js';

const at = '2026-11-23T01:00:00Z';
const encode = (rows: object[]) => rows.map(x => JSON.stringify(x)).join('\n');

test('functional, ambiguous and unrelated failures are not security holds', () => {
  const report = securityHoldStats(encode([
    { judge: 'J', verdict: 'fail', reviewedAt: at, mustFix: ['wrong output'] },
    { judge: 'J', verdict: 'hold', reviewedAt: at },
    { judge: 'J', verdict: 'fail', reviewedAt: at, mustFix: ['wrong output'], securityFindings: [{ text: 'other', kind: 'security-only', securityClass: 'destructive' }] },
    { judge: 'J', verdict: 'fail', reviewedAt: at, mustFix: ['leak', 'wrong output'], securityFindings: [{ text: 'leak', kind: 'security-only', securityClass: 'secret-leak' }] },
    { judge: 'J', verdict: 'fail', reviewedAt: at, mustFix: ['unknown'], securityFindings: [{ text: 'unknown', kind: 'security-only' }] },
    { judge: 'J', verdict: 'warn', reviewedAt: at, edges: ['later'], fu: [{ text: 'later' }], followUp: ['next'] },
    { judge: 'J', verdict: 'fail', reviewed: false, reviewedAt: at },
  ]), '2026-11-23');
  expect(report.invalidLines).toBe(1);
  expect(report.reviewers[0]).toMatchObject({ verdictCount: 6, holdCount: 2, otherFailures: 3, unclassified: 1, unclassifiedRatio: 0.5, fuCount: 2, byClass: { 'secret-leak': 1 } });
});

test('saved review directory reads formatted files, model identity, dedup and visible mtime fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hold-stats-'));
  try {
    const row = { pr: '12', headCommit: 'a'.repeat(40), reviewed: true, model: 'model-A', verdict: 'fail', mustFix: ['functional'], edges: ['follow up'] };
    const path = join(dir, 'pr-12-aaaaaaaaaaaa.json');
    writeFileSync(path, JSON.stringify(row, null, 2));
    writeFileSync(join(dir, 'alias.json'), JSON.stringify(row));
    utimesSync(path, new Date(at), new Date(at));
    writeFileSync(join(dir, 'review.json'), JSON.stringify({ ...row, pr: '13', verdict: 'fail', reviewedAt: at, securityClass: 'destructive' }));
    writeFileSync(join(dir, 'invalid.json'), '{');
    writeFileSync(join(dir, 'waiver.json'), JSON.stringify({ reviewed: false, verdict: 'fail' }));
    const result = savedReviewStats(dir, '2026-11-23');
    expect(result.input).toMatchObject({ duplicateFiles: 1, invalidFiles: 1, ignoredFiles: 1, mtimeFallbackFiles: 1 });
    expect(result.reviewers[0]).toMatchObject({ reviewer: 'model-A', verdictCount: 2, holdCount: 1, otherFailures: 1, fuCount: 2, byClass: { destructive: 1 } });
    expect(runSecurityHoldStatsCli([dir, '2026-11-23'])).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('UTC week boundaries and strict retrospective thresholds', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ judge: 'J', verdict: i < 4 ? 'fail' : 'pass', reviewedAt: at, securityClass: 'destructive' })),
    { judge: 'J', verdict: 'fail', reviewedAt: '2026-11-30T00:00:00Z', securityClass: 'destructive' },
    { judge: 'J', verdict: 'fail', reviewedAt: '2026-11-22T23:59:59Z', securityClass: 'destructive' },
  ];
  expect(securityHoldStats(encode(rows), '2026-11-23').reviewers[0]).toMatchObject({ verdictCount: 10, holdCount: 4, holdRatio: 0.4, retrospective: false });
  expect(() => securityHoldStats('', '2026-11-24')).toThrow();
  expect(securityHoldStats('', '2026-11-23').reviewers).toEqual([]);
  expect(runSecurityHoldStatsCli(['/not/a/real/input.jsonl', '2026-11-23'])).toBe(1);
});
