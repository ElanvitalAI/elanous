import { expect, test } from 'bun:test';
import { classifySeatTrafficProposal } from './traffic-signal.js';

test('seat message proposes hold at manual implementation start', () => {
  expect(classifySeatTrafficProposal('TC 자리: 손 구현 착수')).toBe('hold');
});

test('seat message proposes UNHOLD when the first line is confirmed', () => {
  expect(classifySeatTrafficProposal('TC 자리: 첫 줄 확정')).toBe('UNHOLD');
  expect(classifySeatTrafficProposal('손 구현 착수 후 첫 줄 확정')).toBe('UNHOLD');
});

test('unrelated seat message makes no traffic proposal', () => {
  expect(classifySeatTrafficProposal('TC 자리: 진행 상태를 공유합니다')).toBeNull();
  expect(classifySeatTrafficProposal('')).toBeNull();
});
