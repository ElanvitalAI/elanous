// SEAT-COORDINATOR-PROMPT-PROFILE — 자리 역할은 자리 원장(scripts/coord-tracks.json)의 구조화 값으로 정한다.
// 기대값은 독립 리터럴(규칙 11) — 제품 상수를 재사용하지 않는다.
import { describe, expect, test } from 'bun:test';
import { isCoordinatorSeat, seatRole } from './seat-role.js';

describe('seat role from the seat registry', () => {
  test('OP is the coordinator seat', () => {
    expect(seatRole('OP')).toBe('coordinator');
    expect(seatRole('op')).toBe('coordinator');
    expect(isCoordinatorSeat('OP')).toBe(true);
  });

  test('hand seats stay hand seats', () => {
    expect(seatRole('TC')).toBe('hand');
    expect(seatRole('MK')).toBe('hand');
    expect(seatRole('UX')).toBe('hand');
    expect(isCoordinatorSeat('TC')).toBe(false);
  });

  test('unknown or missing seats have no role (legacy alias is not an id)', () => {
    expect(seatRole('OPC')).toBeNull();
    expect(seatRole('S')).toBeNull();
    expect(seatRole(undefined)).toBeNull();
    expect(seatRole('')).toBeNull();
    expect(isCoordinatorSeat('S')).toBe(false);
  });

  test('a registry without a role field marks no seat as coordinator', () => {
    expect(seatRole('OP', [{ id: 'OP', title: 'COO' }])).toBe('hand');
    expect(seatRole('OP', [{ id: 'OP', title: 'COO', role: 'coordinator' }])).toBe('coordinator');
  });
});
