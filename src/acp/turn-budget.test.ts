// SEAT-TURN-FULL-BUDGET — a seat turn never takes a sentence-shaped budget. Independent literals.
import { expect, test } from 'bun:test';
import { decideTurnBudget, seatFromEnv } from './turn-budget.js';

const member = { factShaped: true, seatTurn: false, armGoalLoop: false, researchAgent: false, goalLoopResearch: false, quickRoute: true,
  factMaxToolTurns: 6, researchMaxToolTurns: 20 };

test('member fact question keeps 6 rounds, the instruction and the quick allowlist', () => {
  expect(decideTurnBudget(member)).toEqual({ factQuestion: true, narrowTools: true, maxToolTurns: 6 }); // 출처: #23034 FACT1 member fact budget
});
test('seat turn: no fact budget, no allowlist, safety cap 400', () => {
  expect(decideTurnBudget({ ...member, seatTurn: true })).toEqual({ factQuestion: false, narrowTools: false, maxToolTurns: 400 }); // 출처: #40092 seat safety cap (grok-cli 400)
});
test('explicit budget wins; member non-fact turn keeps the family default', () => {
  expect(decideTurnBudget({ ...member, seatTurn: true, explicitMaxToolTurns: 40 }).maxToolTurns).toBe(40);
  expect(decideTurnBudget({ ...member, factShaped: false, quickRoute: false })).toEqual({ factQuestion: false, narrowTools: false });
});
test('seatFromEnv: COORD_ID then ELANOUS_TRACK; garbage → null', () => {
  expect(seatFromEnv({ COORD_ID: 'op' })).toBe('OP');
  expect(seatFromEnv({ ELANOUS_TRACK: 'TC-H-1' })).toBe('TC-H-1');
  expect(seatFromEnv({ COORD_ID: '../x' })).toBeNull();
  expect(seatFromEnv({})).toBeNull();
});
