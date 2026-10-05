import { expect, test } from 'bun:test';
import { calculateSeatBaseShares } from './seat-share.js';
import { ORCHESTRATOR_DEFAULTS } from '../../user-config.js';

const seatCaps = ORCHESTRATOR_DEFAULTS.seatCaps;
const yellow = (owner: string) => ({ owner, status: 'yellow' as const });

test('current yellow work weighs twice next-round yellow work, and subowners count for their seat', () => {
  const result = calculateSeatBaseShares({ totalSlots: 8,
    currentRound: [yellow('TC/core'), yellow('MK'), { owner: 'UX', status: 'green' }],
    nextRound: [yellow('OP'), yellow('UX'), { owner: 'TC', status: 'done' }], seatCaps });
  expect(result).toEqual({ OP: 1, TC: 3, MK: 3, UX: 1 });
});

test('caps ceiling reallocates unused portions to other seats, never exceeding total slots', () => {
  const result = calculateSeatBaseShares({ totalSlots: 8,
    currentRound: Array.from({ length: 6 }, () => yellow('TC')).concat([yellow('MK')]),
    nextRound: [], seatCaps: { OP: 4, TC: 2, MK: 6, UX: 6 } });
  expect(result).toEqual({ OP: 0, TC: 2, MK: 6, UX: 0 });
  expect(Object.values(result).reduce((sum, share) => sum + share, 0)).toBe(8);
});

test('integer remainder tie is deterministic in seat order, and zero work cannot claim slots', () => {
  expect(calculateSeatBaseShares({ totalSlots: 3, currentRound: [yellow('OP'), yellow('TC'), yellow('MK'), yellow('UX')],
    nextRound: [], seatCaps })).toEqual({ OP: 1, TC: 1, MK: 1, UX: 0 });
  expect(calculateSeatBaseShares({ totalSlots: 12, currentRound: [yellow('TC'), yellow('UNKNOWN'), { owner: 'MK', status: 'red' }],
    nextRound: [], seatCaps })).toEqual({ OP: 0, TC: 8, MK: 0, UX: 0 });
  expect(calculateSeatBaseShares({ totalSlots: 12, currentRound: [], nextRound: [], seatCaps }))
    .toEqual({ OP: 0, TC: 0, MK: 0, UX: 0 });
});

test('zero cap, zero slots and total capacity below budget leave unallocatable slots unused', () => {
  const args = { currentRound: [yellow('TC'), yellow('MK')], nextRound: [] };
  expect(calculateSeatBaseShares({ ...args, totalSlots: 10, seatCaps: { OP: 0, TC: 0, MK: 3, UX: 0 } }))
    .toEqual({ OP: 0, TC: 0, MK: 3, UX: 0 });
  expect(calculateSeatBaseShares({ ...args, totalSlots: 0, seatCaps })).toEqual({ OP: 0, TC: 0, MK: 0, UX: 0 });
});

test('the calculation leaves frozen work and seat caps unchanged', () => {
  const currentRound = Object.freeze([Object.freeze(yellow('MK'))]);
  const nextRound = Object.freeze([Object.freeze(yellow('UX'))]);
  const caps = Object.freeze({ OP: 1, TC: 1, MK: 3, UX: 3 });
  expect(calculateSeatBaseShares({ totalSlots: 4, currentRound, nextRound, seatCaps: caps }))
    .toEqual({ OP: 0, TC: 0, MK: 3, UX: 1 });
  expect(currentRound).toEqual([yellow('MK')]);
  expect(nextRound).toEqual([yellow('UX')]);
  expect(caps).toEqual({ OP: 1, TC: 1, MK: 3, UX: 3 });
});

test('invalid slot and cap counts are rejected instead of making fractional or negative allocations', () => {
  const args = { currentRound: [yellow('TC')], nextRound: [], seatCaps };
  expect(() => calculateSeatBaseShares({ ...args, totalSlots: -1 })).toThrow(RangeError);
  expect(() => calculateSeatBaseShares({ ...args, totalSlots: 1.5 })).toThrow(RangeError);
  expect(() => calculateSeatBaseShares({ ...args, totalSlots: 2, seatCaps: { ...seatCaps, TC: -1 } })).toThrow(RangeError);
});
