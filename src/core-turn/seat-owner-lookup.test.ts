import { describe, expect, test } from 'bun:test';
import { lookupSeatOwners, pullRequestCellIds, type SeatOwnerReaders } from './seat-owner-lookup.js';
import type { WorkReference } from './seat-owner-check.js';

const cell: WorkReference = { kind: 'cell', id: 'TEST-CELL', version: '0.3.30' };
const pr: WorkReference = { kind: 'pr', repository: 'org/repo', number: 42 };
const mail: WorkReference = { kind: 'mail', id: '123' };
const readers = (): SeatOwnerReaders => {
  const items = [{ id: 'TEST-CELL', owner: 'TC', title: 'x', status: 'yellow' as const, updatedAt: '', updatedBy: 'OP' },
    { id: 'OTHER-CELL', owner: 'OP', title: 'y', status: 'yellow' as const, updatedAt: '', updatedBy: 'OP' }];
  return {
    checklistVersion: () => '0.3.30',
    readChecklist: version => ({ version, items }),
    listChecklists: () => [{ version: '0.3.30', items }],
    readPullRequest: () => ({ number: 42, body: '칸 닫음: TEST-CELL' }),
    readMail: id => ({ id, body: '칸 TEST-CELL 확인' }),
  };
};

describe('checklist-based owner lookup', () => {
  test('cell, PR marker and mail body resolve from checklist on each call', () => {
    const r = readers();
    expect(lookupSeatOwners('TC', [cell, pr, mail], r).references.map(x => x.status)).toEqual(['owned', 'owned', 'owned']);
    expect(lookupSeatOwners('OP', [cell, pr, mail], r).status).toBe('foreign');
    const original = r.readChecklist;
    r.readChecklist = v => { const c = original(v); return { ...c, items: c.items.map(i => ({ ...i, owner: 'OP' })) }; };
    expect(lookupSeatOwners('TC', [cell, pr, mail], r).status).toBe('foreign');
  });
  test('PR without marker is unknown even when assignee and evidence suggest a cell', () => {
    const r = readers();
    r.readPullRequest = () => ({ number: 42, body: 'TEST-CELL #42', assignees: [{ login: 'TC' }] });
    expect(lookupSeatOwners('TC', [pr], r).status).toBe('unknown');
    r.readPullRequest = () => ({ number: 43, body: '칸 닫음: TEST-CELL' });
    expect(lookupSeatOwners('TC', [pr], r).status).toBe('unknown');
  });
  test('only actual PR body marker lines count, not quoted, fenced or incidental text', () => {
    expect(pullRequestCellIds('> 칸 닫음: BAD\n```\n칸 닫음: BAD\n```\n제목 TEST-CELL\n- 칸 닫음: TEST-CELL\n칸 닫음: OTHER-CELL'))
      .toEqual(['TEST-CELL', 'OTHER-CELL']);
    expect(pullRequestCellIds('칸 닫음: TEST-CELL-EXTRA 설명\n    칸 닫음: TEST-CELL')).toEqual([]);
  });
  test('multiple owner cells conflict, incomplete or ambiguous cells remain unknown', () => {
    const r = readers();
    r.readPullRequest = () => ({ number: 42, body: '칸 닫음: TEST-CELL\n칸 닫음: OTHER-CELL' });
    expect(lookupSeatOwners('TC', [pr], r).status).toBe('conflict');
    r.readPullRequest = () => ({ number: 42, body: '칸 닫음: MISSING' });
    expect(lookupSeatOwners('TC', [pr], r).status).toBe('unknown');
    r.checklistVersion = () => null;
    expect(lookupSeatOwners('TC', [mail], r).status).toBe('unknown');
    r.readChecklist = () => { throw new Error('unavailable'); };
    expect(lookupSeatOwners('TC', [cell], r).status).toBe('unknown');
  });
  test('mail links only exact known body IDs, never sender, recipient, PR number or partial ID', () => {
    const r = readers();
    for (const body of ['owner=TC #42', 'TEST-CELL-EXTRA', '']) {
      r.readMail = id => ({ id, body, from: 'TC', to: 'TC' });
      expect(lookupSeatOwners('TC', [mail], r).status).toBe('unknown');
    }
    r.readMail = id => ({ id, body: 'TEST-CELL OTHER-CELL' });
    expect(lookupSeatOwners('TC', [mail], r).status).toBe('conflict');
    expect(lookupSeatOwners('TC', [{ kind: 'mail', id: '01' }], r).status).toBe('unknown');
  });
});
