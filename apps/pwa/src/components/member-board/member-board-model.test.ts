import { describe, expect, test } from 'bun:test';
import { msUntilNextSeoulMidnight, projectMemberBoardCards, rowsForVerifiedMember, rowsFromApi, todayInSeoul } from './member-board-model';

const card = (state: 'proposed' | 'approved' | 'developing' | 'testing' | 'deployed' | 'failed') => ({
  id: `card-${state}`, memberId: 'member-a', title: '강의 노트 앱', state, progress: '실행 확인', updatedAt: '2026-11-09T01:00:00Z',
});

describe('mini board projection', () => {
  test('maps member API states onto the shared five-column projection', () => {
    const projection = projectMemberBoardCards(['proposed', 'approved', 'developing', 'testing', 'deployed']
      .map((state) => card(state as ReturnType<typeof card>['state'])));
    expect(Object.fromEntries(Object.entries(projection).map(([column, cards]) => [column, cards.length])))
      .toEqual({ steward: 1, landing: 1, execution: 1, release: 1, done: 1 });
    expect(projection.steward[0]?.title).toBe('강의 노트 앱');
  });

  test('keeps result URLs only on completed cards and carries rerun context', () => {
    const pending = projectMemberBoardCards([{ ...card('testing'), resultUrl: 'https://demo.example.test', runId: 'run-1234567890' }]).release[0];
    expect(pending).not.toHaveProperty('resultUrl');
    expect(pending?.runId).toBe('1234');
    const deployed = projectMemberBoardCards([{ ...card('deployed'), resultUrl: 'https://demo.example.test' }]).done[0];
    expect(deployed?.resultUrl).toBe('https://demo.example.test/');
    const deployedPublic = projectMemberBoardCards([{ ...card('deployed'), publicUrl: 'https://public.example.test' }]).done[0];
    expect(deployedPublic?.resultUrl).toBe('https://public.example.test/');
    const unsafe = projectMemberBoardCards([{ ...card('deployed'), resultUrl: 'javascript:alert(1)' }]).done[0];
    expect(unsafe).not.toHaveProperty('resultUrl');
    const failed = projectMemberBoardCards([{ ...card('failed'), reason: '검증 실패' }]).release[0];
    expect(failed?.summary).toBe('검증 실패');
  });

  test('accepts the array and wrapped response shapes used by the Android API', () => {
    expect(rowsFromApi([{ id: 'a' }], 'cards')).toEqual([{ id: 'a' }]);
    expect(rowsFromApi({ items: [{ id: 'b' }] }, 'briefings')).toEqual([{ id: 'b' }]);
    expect(rowsFromApi({ cards: [{ id: 'c' }] }, 'cards')).toEqual([{ id: 'c' }]);
  });

  test('keeps only cards and briefings attested for the signed-in member', () => {
    expect(rowsForVerifiedMember([{ id: 'mine', memberId: 'member-a' }, { id: 'other', memberId: 'member-b' }], 'member-a'))
      .toEqual([{ id: 'mine', memberId: 'member-a' }]);
  });

  test('formats the briefing query day in Seoul time', () => {
    expect(todayInSeoul(new Date('2026-11-08T15:30:00.000Z'))).toBe('2026-11-09');
  });

  test("schedules a refresh at the next Seoul date boundary", () => {
    expect(msUntilNextSeoulMidnight(new Date("2026-11-09T14:59:30.000Z"))).toBe(30_000);
    expect(msUntilNextSeoulMidnight(new Date("2026-11-09T15:00:00.000Z"))).toBe(86_400_000);
  });

});
