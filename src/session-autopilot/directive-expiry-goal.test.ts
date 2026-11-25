import { describe, expect, test } from 'bun:test';
import { goalApplyFromMail } from './crown-goal-apply.js';
import { firstClassFromMail } from './dynamic-goal.js';

const AT = Date.parse('2026-11-25T09:00:00.000Z');

describe('DIRECTIVE-EXPIRY goal pins', () => {
  test('a goal mail that lapsed before it applied never sets the goal', () => {
    expect(goalApplyFromMail({ msgId: 4, sender: 'OP', goal: 'assign now', expiresAt: '2026-11-25T08:59:00.000Z' }, AT))
      .toEqual({ kind: 'expired', goal: 'assign now', sender: 'OP', expiresAt: '2026-11-25T08:59:00.000Z' });
    expect(goalApplyFromMail({ msgId: 4, sender: 'OP', goal: 'assign now', expiresAt: '2026-11-25T11:00:00.000Z' }, AT).kind).toBe('apply');
  });
  test('a crown mail carries its expiry into the first-class goal; a lapsed one opens none', () => {
    expect(firstClassFromMail({ msgId: 8, crownDirective: '21', body: 'land 10/h', expiresAt: '2026-11-25T11:00:00.000Z' }, AT))
      .toEqual({ id: 'crown:21', source: 'crown', text: '[지시] land 10/h', at: AT, expiresAt: Date.parse('2026-11-25T11:00:00.000Z') });
    expect(firstClassFromMail({ msgId: 8, crownDirective: '21', body: 'land 10/h', expiresAt: '2026-11-25T08:00:00.000Z' }, AT)).toBeNull();
  });
});
