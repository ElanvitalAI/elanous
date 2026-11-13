import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFederalTransition, formatFederalSummary, routeFederalUpdate, summarizeFederalFeed, type FederalUpdate } from './federal-feed.js';

const routine: FederalUpdate = { kind: 'transition', from: 'TC', cell: 'MSG-FEDERAL-FEED', state: 'yellow', evidence: 'seat-state/OPS/receipt.md', detail: 'authoring' };

test('routine transition appends one system-timestamped TSV row and never posts OP mail', () => {
  const root = mkdtempSync(join(tmpdir(), 'federal-feed-'));
  try {
    const at = new Date('2026-11-11T22:10:00.000Z');
    let posts = 0;
    const destination = routeFederalUpdate(routine, {
      append: input => appendFederalTransition(input, { root, now: () => at }),
      postOp: () => { posts++; },
    });
    const path = join(root, 'OPS', 'FEED-20261112.tsv');
    expect(destination).toBe('feed');
    expect(posts).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('2026-11-11T22:10:00.000Z\tTC\tMSG-FEDERAL-FEED\tyellow\tseat-state/OPS/receipt.md\tauthoring\n');
    const summary = summarizeFederalFeed(new Date('2026-11-11T22:15:00.000Z'), root);
    expect(summary.count).toBe(1);
    expect(summary.source).toBe('complete');
    expect(summary.bySeat).toEqual({ TC: 1 });
    expect(summary.anomalies).toEqual([]);
    expect(formatFederalSummary(summary)).toContain('events=1 seats=TC=1 anomalies=0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP route admits only alert, question and card; malformed routine rows cannot inject TSV lines', () => {
  const delivered: string[] = [];
  for (const kind of ['alert', 'question', 'card'] as const) {
    expect(routeFederalUpdate({ ...routine, kind }, { append: () => { throw new Error('feed used'); }, postOp: input => delivered.push(input.kind) })).toBe('op');
  }
  expect(delivered).toEqual(['alert', 'question', 'card']);
  expect(() => routeFederalUpdate({ ...routine, detail: 'first\nsecond' }, { append: () => { throw new Error('should not append'); } })).toThrow('one TSV field');
});

test('15-minute summary includes both KST date files across midnight and excludes the end', () => {
  const root = mkdtempSync(join(tmpdir(), 'federal-midnight-'));
  try {
    appendFederalTransition({ ...routine, state: 'hold' }, { root, now: () => new Date('2026-11-11T14:59:00Z') });
    appendFederalTransition({ ...routine, state: 'green', detail: 'focused 3 pass/0 fail' }, { root, now: () => new Date('2026-11-11T15:00:00Z') });
    appendFederalTransition(routine, { root, now: () => new Date('2026-11-11T15:10:00Z') });
    const summary = summarizeFederalFeed(new Date('2026-11-11T15:10:00Z'), root);
    expect(summary.count).toBe(2);
    expect(summary.anomalies.map(row => row.state)).toEqual(['hold']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('absent feed is unmeasured, not a complete zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'federal-missing-'));
  try {
    const summary = summarizeFederalFeed(new Date('2026-11-11T22:15:00Z'), root);
    expect(summary.count).toBe(0);
    expect(summary.source).toBe('unmeasured');
    expect(formatFederalSummary(summary)).toContain('source=unmeasured');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('summary uses each row shape status and evidence columns, and flags invalid states', () => {
  const root = mkdtempSync(join(tmpdir(), 'federal-columns-'));
  try {
    const at = new Date('2026-11-11T22:10:00Z');
    const path = join(root, 'OPS', 'FEED-20261112.tsv');
    appendFederalTransition({ ...routine, state: 'green', evidence: 'review/hold-receipt.md' }, { root, now: () => at });
    appendFileSync(path, [
      '2026-11-11T22:11:00Z\tTC\tnew-empty\t\tproof/hold.md\tdetail',
      '2026-11-11T22:12:00Z\tTC\tnew-arbitrary\tbanana\tproof/green.md\tdetail',
      '2026-11-11T22:13:00Z\tTC\told-source\tproducer\thold\tproof/old.md\tdetail',
      '2026-11-11T22:14:00Z\tTC\told-green\tproducer\tgreen\tproof/hold.md\tdetail',
      '2026-11-11T22:14:01Z\tTC\tunknown\tunknown\tproof/unknown.md\tdetail',
      '2026-11-11T22:14:02Z\tTC\tgreen-suffix\tgreen/banana\tproof/suffix.md\tdetail',
      '2026-11-11T22:14:03Z\tTC\tupper-green\tGREEN\tproof/hold.md\tdetail',
      '2026-11-11T22:14:04Z\tTC\tmixed-yellow\tYellow\tproof/hold.md\tdetail',
    ].join('\n') + '\n');
    const summary = summarizeFederalFeed(new Date('2026-11-11T22:15:00Z'), root);
    expect(summary.count).toBe(9);
    expect(summary.anomalies).toEqual([
      { from: 'TC', cell: 'new-empty', state: 'invalid:(empty)', evidence: 'proof/hold.md' },
      { from: 'TC', cell: 'new-arbitrary', state: 'invalid:banana', evidence: 'proof/green.md' },
      { from: 'TC', cell: 'old-source', state: 'hold', evidence: 'proof/old.md' },
      { from: 'TC', cell: 'unknown', state: 'invalid:unknown', evidence: 'proof/unknown.md' },
      { from: 'TC', cell: 'green-suffix', state: 'invalid:green/banana', evidence: 'proof/suffix.md' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
