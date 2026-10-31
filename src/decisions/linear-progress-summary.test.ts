import { describe, expect, test } from 'bun:test';
import type { Checklist, ChecklistHistory } from '../release-loop/checklist.js';
import type { DecisionEntry } from './decision-ledger.js';
import { buildLinearProgressSummaries } from './linear-progress-summary.js';

const checklist: Checklist = {
  version: '0.2.43', released: '0.2.42', dev: '0.2.43-dev.0',
  items: [
    { id: 'CELL-1', title: 'ELA-53 secret title must not leave this process', status: 'green', evidence: 'approved https://github.com/acme/repo/pull/42', updatedAt: '2026-10-30T08:00:00.000Z', updatedBy: 'OPT' },
    { id: 'CELL-2', title: 'ELA-23 follow-up', status: 'yellow', updatedAt: '2026-10-30T08:00:00.000Z', updatedBy: 'OPT' },
  ], history: [],
};

const history: ChecklistHistory[] = [
  { at: '2026-10-30T08:10:00.000Z', by: 'OPT', id: 'CELL-1', field: 'status', from: 'yellow', to: 'green', released: '0.2.42', dev: '0.2.43-dev.0' },
  { at: '2026-10-30T08:11:00.000Z', by: 'OPT', id: 'CELL-1', field: 'evidence.add', from: null, to: 'merged https://github.com/acme/repo/pull/42', released: '0.2.42', dev: '0.2.43-dev.0' },
  { at: '2026-10-29T23:59:59.000Z', by: 'OPT', id: 'CELL-2', field: 'status', from: 'red', to: 'yellow', released: '0.2.42', dev: '0.2.43-dev.0' },
];

const decision = {
  id: 'D-20261030-1', title: 'private decision title', category: 'scope',
  scqa: { s: '', c: '' }, options: [], recommendation: { skipped: true, reason: 'not sent' },
  raisedBy: { agent: 'OPT' }, refs: ['https://linear.app/elanous-lab/issue/ELA-53'],
  status: 'decided', history: [{ type: 'decided', at: '2026-10-30T08:12:00.000Z', by: 'OP', choice: 'a' }],
} as unknown as DecisionEntry;

describe('buildLinearProgressSummaries', () => {
  test('groups daily status, decisions, merged PR links, and next cells by ELA issue without leaking titles', () => {
    const rows = buildLinearProgressSummaries({ checklist, history, decisions: [decision], since: '2026-10-30T00:00:00Z', now: new Date('2026-10-30T09:00:00Z') });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ issue: 'ELA-23', day: '2026-10-30' });
    expect(rows[0]).not.toHaveProperty('fingerprint');
    expect(rows[0]!.body).toContain('다음: CELL-2');
    expect(rows[0]!.body).not.toContain('private decision title');
    expect(rows[1]!.body).toContain('칸 CELL-1: yellow → green');
    expect(rows[1]!.body).toContain('결정 D-20261030-1: 확정 a');
    expect(rows[1]!.body).toContain('https://github.com/acme/repo/pull/42');
    expect(rows[1]!.body).not.toContain('secret title');
  });

  test('rejects an invalid reporting window', () => {
    expect(() => buildLinearProgressSummaries({ checklist, history, decisions: [], since: 'invalid' })).toThrow('since must be a valid timestamp');
  });
});
