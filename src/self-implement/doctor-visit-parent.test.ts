import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordParentNeedsOwnerVisit } from './doctor-visit.js';
import { appendRunLedgerEntry, loadRunLedger } from './run-ledger.js';

describe('parent needs-owner doctor visit', () => {
  test('records the stop once and retains its reason on repeated dispatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-parent-'));
    const runId = 'run-12222222-2222-4222-8222-222222222222';
    try {
      appendRunLedgerEntry({ runId, event: 'start', data: {} }, dir);
      expect(recordParentNeedsOwnerVisit({ runId, stopKey: 'stop-1', evidence: 'merge held', dir })).toEqual({ status: 'recorded' });
      expect(recordParentNeedsOwnerVisit({ runId, stopKey: 'stop-1', evidence: 'different retry text', dir })).toEqual({ status: 'already-recorded' });
      expect(loadRunLedger(runId, dir)?.filter((entry) => entry.event === 'doctor-visit')).toEqual([
        expect.objectContaining({ data: { from: 'parent', symptom: 'needs-owner', stopKey: 'stop-1', evidence: 'merge held' } }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing ledger does not create a visit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-parent-missing-'));
    const runId = 'run-13333333-3333-4333-8333-333333333333';
    try {
      expect(recordParentNeedsOwnerVisit({ runId, stopKey: 'stop-1', evidence: 'merge held', dir })).toEqual({ status: 'missing-ledger' });
      expect(loadRunLedger(runId, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
