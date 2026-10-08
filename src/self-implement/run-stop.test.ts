import { describe, expect, test } from 'bun:test';
import { boundRunStopCause, classifyMergeHoldStop, classifyPodExitStop, readRunStopRecord, recordRunStop, runStopRecorded, RUN_STOP_CLASSES } from './run-stop.js';
import { debug } from '../debug/log.js';
import { spyOn } from 'bun:test';
import type { RunLedgerEntry } from './run-ledger.js';

describe('recordRunStop', () => {
  test('appends one stop with a closed class and preserves earlier entries', () => {
    const prior: RunLedgerEntry = { runId: 'run-test', event: 'merge-decision', data: { reason: 'no-auto-flag' } };
    const entries = [prior];
    recordRunStop({ runId: 'run-test', class: 'main-sync', cause: 'merge held: main-sync-conflict-unresolved', evidenceRef: 'run-ledger:run-test:merge-decision', nextMove: 'Review merge decision' }, (entry) => entries.push(entry));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toBe(prior);
    expect(entries[1]).toMatchObject({ runId: 'run-test', event: 'stop', data: { class: 'main-sync', cause: 'merge held: main-sync-conflict-unresolved', evidenceRef: 'run-ledger:run-test:merge-decision', nextMove: 'Review merge decision' } });
    expect(RUN_STOP_CLASSES).toEqual(['env-unrelated', 'main-sync', 'pod-died', 'review-repeat', 'review-out-of-scope', 'evidence-uncovered', 'fabric', 'launch-failed', 'unclassified']);
  });

  test('unknown class is unclassified; cause is one line at most 120 characters without truncation marker', () => {
    const entries: RunLedgerEntry[] = [];
    recordRunStop({ runId: 'run-test', class: 'invented', cause: `reason\n생략] ${'x'.repeat(200)}\rraw`, evidenceRef: 'run-ledger:run-test:implemented', nextMove: 'Inspect evidence' }, (entry) => entries.push(entry));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data.class).toBe('unclassified');
    const cause = entries[0]!.data.cause as string;
    expect(Array.from(cause).length).toBeLessThanOrEqual(120);
    expect(cause).toBe('reason');
    expect(cause).not.toMatch(/[\r\n]|생략\]/);
  });

  test('long single-line causes are capped without appending a truncation suffix', () => {
    const entries: RunLedgerEntry[] = [];
    recordRunStop({ runId: 'run-test', cause: 'x'.repeat(250), evidenceRef: 'ledger', nextMove: 'Inspect' }, (entry) => entries.push(entry));
    expect(entries[0]!.data.cause).toBe('x'.repeat(120));
    expect(entries[0]!.data.class).toBe('unclassified');
  });

  test('cause never carries a raw log tail: ANSI stripped, first non-empty line only', () => {
    const tail = ['', '\x1b[31merror: unknown option --bogus\x1b[0m', ...Array.from({ length: 50 }, (_, i) => `    at frame${i} (file.ts:${i})`)].join('\n');
    expect(boundRunStopCause(tail)).toBe('error: unknown option --bogus');
    expect(boundRunStopCause('')).toBe('stop reason unclassified');
  });

  test('classifiers map known reasons into the closed list and the rest to unclassified', () => {
    expect(classifyMergeHoldStop('main-sync-conflict-unresolved')).toBe('main-sync');
    expect(classifyMergeHoldStop('required-evidence-uncovered')).toBe('evidence-uncovered');
    expect(classifyMergeHoldStop('review-must-fix')).toBe('review-repeat');
    expect(classifyMergeHoldStop('no-real-review')).toBe('review-out-of-scope');
    expect(classifyMergeHoldStop('something-new')).toBe('unclassified');
    expect(classifyMergeHoldStop(undefined)).toBe('unclassified');
    expect(classifyPodExitStop('pod-failure')).toBe('pod-died');
    expect(classifyPodExitStop('OOMKilled')).toBe('pod-died');
    expect(classifyPodExitStop('no-launch')).toBe('launch-failed');
    expect(classifyPodExitStop('unknown')).toBe('unclassified');
  });

  test('records the observation and remembers the run; readRunStopRecord round-trips the schema', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const runId = `run-stop-observe-${Date.now()}`;
      expect(runStopRecorded(runId)).toBe(false);
      const entry = recordRunStop({ runId, site: 'merge-hold', class: 'main-sync', cause: 'merge held: main-sync', evidenceRef: 'pr', nextMove: 'sync' }, () => {});
      expect(runStopRecorded(runId)).toBe(true);
      expect(log).toHaveBeenCalledWith('self-implement.run-stop', 'recorded', expect.objectContaining({ runId, site: 'merge-hold', class: 'main-sync' }));
      expect(readRunStopRecord(entry)).toEqual({ class: 'main-sync', cause: 'merge held: main-sync', evidenceRef: 'pr', nextMove: 'sync' });
      expect(readRunStopRecord({ runId, event: 'merge-decision', data: {} })).toBeUndefined();
    } finally { log.mockRestore(); }
  });
});
