import { describe, expect, test } from 'bun:test';
import { checklistCandidates, selfPullOwnerLine } from './seat-self-pull-sources.js';
import { formatSelfPullPrompt } from './seat-self-pull.js';

const item = checklistCandidates('CX-5', [{ version: '0.3.30', items: [
  { id: 'CELL-A', title: 'A', status: 'yellow', owner: 'CX-5' },
] }]).candidates[0]!;

describe('self-pull owner line', () => {
  test('handoff prompt puts owner confirmation before investigation', () => {
    const prompt = formatSelfPullPrompt('CX-5', item, 'owned');
    expect(prompt).toContain('다른 자리 담당이면 그 자리에게 먼저 묻고');
    expect(prompt).toContain('확인되지 않으면 원장과 담당자를 확인');
  });
  test('preserves version and checks fresh exact cell before handoff', () => {
    expect(item.checklistVersion).toBe('0.3.30');
    expect(selfPullOwnerLine('CX-5', item, version => {
      expect(version).toBe('0.3.30');
      return [{ id: 'CELL-A', owner: 'CX-5' }, { id: 'OTHER', owner: 'CX-2' }];
    })).toBe('[주인 확인] 이 일의 주인 = CX-5 (이 자리) · 조사 전 담당 이력을 확인하세요.');
    expect(selfPullOwnerLine('CX-5', item, () => [{ id: 'CELL-A', owner: 'CX-2' }]))
      .toBe('[주인 확인] 이 일의 주인 = CX-2 · 조사 전에 담당자에게 묻기 우선.');
  });
  test('missing, duplicate, unreadable and unrelated queue references are unknown', () => {
    const unknown = '[주인 확인] 확인 불가 — 조사 전에 원장과 담당자를 직접 확인하세요.';
    expect(selfPullOwnerLine('CX-5', item, () => [])).toBe(unknown);
    expect(selfPullOwnerLine('CX-5', item, () => [{ id: 'CELL-A' }])).toBe(unknown);
    expect(selfPullOwnerLine('CX-5', item, () => [{ id: 'CELL-A', owner: 'CX-5' }, { id: 'CELL-A', owner: 'CX-2' }])).toBe(unknown);
    expect(selfPullOwnerLine('CX-5', item, () => { throw new Error('unreadable'); })).toBe(unknown);
    expect(selfPullOwnerLine('CX-5', { ...item, source: 'work-queue' }, () => { throw new Error('must not read'); })).toBe(unknown);
  });
});
