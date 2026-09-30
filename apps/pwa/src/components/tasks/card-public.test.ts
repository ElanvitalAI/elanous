import { describe, expect, it } from 'bun:test';
import { maskCardsForPublic } from './card-public';
import { cardTitle, type TaskCard } from '@/lib/task-card-model';

const card = (title: string): TaskCard => ({
  taskId: 'task-mbp-node-b', apiTitle: title, sections: {}, incidents: [], updatedAt: 0,
} as unknown as TaskCard);

describe('board public capture (teaser S02 · host names in card titles)', () => {
  it('hides machine names in titles but keeps the task id usable', () => {
    const [masked] = maskCardsForPublic([card('[eln][run] mbp-node-b 임대 기계 이름 실측')]);
    expect(cardTitle(masked!)).not.toMatch(/mbp|msb\d/i);
    expect(cardTitle(masked!)).toContain('임대 기계 이름 실측');
    expect(masked!.taskId).toBe('task-mbp-node-b');
  });
  it('plain titles are unchanged', () => {
    const [masked] = maskCardsForPublic([card('[elanous-lab] 오늘 착지한 PR 수를 한 줄로')]);
    expect(cardTitle(masked!)).toBe('[elanous-lab] 오늘 착지한 PR 수를 한 줄로');
  });
});
