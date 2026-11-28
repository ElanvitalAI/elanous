// WORK-PULL-REACHES-ROSTER — the WIP-1 guard (OP's `eln seat assign` · steward pushes) sees a hand's WRITER claim on a
// coordinator-held cell: the hand is not free, a higher cell does not preempt it (the veto path would move OP's ownership),
// and a writer claim older than the guard's active window is not held. Literals (rule 11).
import { describe, expect, test } from 'bun:test';
import type { HandPoolEntry } from './hand-pool.js';
import { freeHands, wip1Decide, type HeldCell, type Wip1Policy } from './seat-assign-wip1.js';

const T0 = Date.parse('2026-11-28T02:00:00.000Z');
const ONE_MINUTE = 60_000;
const POLICY: Wip1Policy = { activeWindowMs: 180 * ONE_MINUTE, priorityOrder: ['P0', 'P1', 'P2'], unrankedAs: 'P2', activeRecentMs: 30 * ONE_MINUTE, activePanes: ['WORKING', 'WAITING_APPROVAL', 'WAITING_REPLY'] };
const idle = (seat: string): HandPoolEntry => ({ seat, home: 'TC', state: 'idle', lent: false, closeCandidate: false, since: T0 - 10 * ONE_MINUTE } as HandPoolEntry);
const cell = (id: string, priority: 'P0' | 'P1' | 'P2', writerAgoMin?: number, writer = 'TC-1'): HeldCell => ({ id, status: 'yellow', owner: 'OP/claude', priority,
  updatedAt: new Date(T0 - (writerAgoMin ?? 300) * ONE_MINUTE).toISOString(), ...(writerAgoMin !== undefined ? { writer: { seat: writer, at: new Date(T0 - writerAgoMin * ONE_MINUTE).toISOString(), by: writer } } : {}) });

describe('WIP-1 guard × writer claims', () => {
  test('a hand writing an OP-held cell (claimed 50 min ago) is not free and is never named as a suggestion', () => {
    const held = [cell('ROS-1', 'P2', 50)];
    expect(freeHands([idle('TC-1'), idle('TC-2')], held, T0, POLICY).map((e) => e.seat)).toEqual(['TC-2']);
  });

  test('a strictly higher cell for that hand is refused («writer claim»), not a preempt of the OP cell', () => {
    const d = wip1Decide({ seat: 'TC-1', cell: { id: 'NEW-P0', priority: 'P0' }, held: [cell('ROS-1', 'P2', 50)], pool: [idle('TC-1'), idle('TC-2')], nowMs: T0, policy: POLICY });
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') { expect(d.holder.id).toBe('ROS-1'); expect(d.why).toBe('actively-on'); expect(d.line).toContain('writer claim'); expect(d.suggest).toBe('TC-2'); }
  });

  test('a writer claim older than the 180-min window is not held: the hand is free and the new cell clears', () => {
    const held = [cell('ROS-1', 'P2', 200)];
    expect(freeHands([idle('TC-1')], held, T0, POLICY).map((e) => e.seat)).toEqual(['TC-1']);
    expect(wip1Decide({ seat: 'TC-1', cell: { id: 'NEW-P0', priority: 'P0' }, held, pool: [idle('TC-1')], nowMs: T0, policy: POLICY }).kind).toBe('clear');
  });

  test('another hand\'s writer cell is not the caller\'s', () => {
    const held = [cell('ROS-1', 'P0', 10, 'TC-3')];
    expect(wip1Decide({ seat: 'TC-1', cell: { id: 'NEW-P1', priority: 'P1' }, held, pool: [idle('TC-1')], nowMs: T0, policy: POLICY }).kind).toBe('clear');
  });
});
