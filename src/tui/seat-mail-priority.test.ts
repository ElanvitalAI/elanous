import { describe, expect, test } from 'bun:test';
import { isUrgentSeatMail, prioritizeSeatMail } from './seat-mail-priority.js';

describe('seat mail urgent lane', () => {
  test('only leading urgent markers in kind or body select the lane', () => {
    expect(isUrgentSeatMail({ kind: '  ⚡', body: 'normal' })).toBe(true);
    expect(isUrgentSeatMail({ kind: '🔴 request', body: 'normal' })).toBe(true);
    expect(isUrgentSeatMail({ body: '\n  🔴 urgent' })).toBe(true);
    expect(isUrgentSeatMail({ body: '⚡ urgent' })).toBe(true);
    expect(isUrgentSeatMail({ kind: 'request', body: 'normal ⚡ later' })).toBe(false);
    expect(isUrgentSeatMail({ kind: 'not🔴', body: '' })).toBe(false);
  });

  test('urgent items go first with stable order in both groups', () => {
    const messages = [
      { id: 1, body: 'ordinary one' }, { id: 2, body: '⚡ urgent one' },
      { id: 3, body: 'ordinary two' }, { id: 4, body: '🔴 urgent two' },
    ];
    expect(prioritizeSeatMail(messages, isUrgentSeatMail).map(item => item.id)).toEqual([2, 4, 1, 3]);
    expect(messages.map(item => item.id)).toEqual([1, 2, 3, 4]);
  });
});
