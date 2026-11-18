/** TURN-CAPSULE-EVENTS contract — literal expectations (rule 11: never derived from the product constants). */
import { describe, expect, test } from 'bun:test';
import * as contract from './contract.js';
import { canTurnTransition, compareTurnEvents, type TurnEvent, type TurnState } from './contract.js';

const ev = (id: string, source: TurnEvent['source'], arrivedAt: number): TurnEvent => ({ id, source, dedupeKey: id, arrivedAt, text: id });

describe('TURN-CAPSULE-EVENTS contract', () => {
  test('bus order: a person first, then urgent mail, capsule-done, wakeup, mail, watch — then arrival, then id', () => {
    const events = [
      ev('w1', 'watch', 1), ev('m1', 'mail', 2), ev('h1', 'human', 9), ev('c1', 'capsule-done', 3),
      ev('u1', 'urgent-mail', 8), ev('k1', 'wakeup', 4), ev('m0', 'mail', 2), ev('m2', 'mail', 1),
    ];
    expect([...events].sort(compareTurnEvents).map((e) => e.id)).toEqual(['h1', 'u1', 'c1', 'k1', 'm2', 'm0', 'm1', 'w1']);
  });



  test('no switches left in the contract (CAPSULE-FLAGS-REMOVE-DEFAULT · the way back is a revert PR)', () => {
    for (const name of ['capsuleModeEnabled', 'capsuleStageEnabled', 'flagOffCapsulePolicy', 'CAPSULE_MODE_ENV', 'CAPSULE_STAGES_ENV', 'CAPSULE_STAGES']) {
      expect(name in contract).toBe(false);
    }
  });
  test('v1.1 turn transitions: idle→reserved→running→closing→idle, reserved→idle; nothing else', () => {
    const states: TurnState[] = ['idle', 'reserved', 'running', 'closing'];
    const allowed = states.flatMap((from) => states.filter((to) => canTurnTransition(from, to)).map((to) => `${from}>${to}`));
    expect(allowed).toEqual(['idle>reserved', 'reserved>idle', 'reserved>running', 'running>closing', 'closing>idle']);
  });

});
