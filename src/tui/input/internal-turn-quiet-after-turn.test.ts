import { describe, expect, test } from 'bun:test';
import { humanFirstDetail } from '../turn-events/door-wire.js';
import { createInternalTurnGate } from './internal-turn.js';

/**
 * TURN-FIELD-BUG-5 (OP #91474 · TC #93418): the Enter that submitted a person's turn is not «a person typing» once that
 * turn ended — the goal continue right after it must open, not wait out the 10 s quiet window. A key typed after the
 * turn started still holds the automatic turn back.
 */
describe('internal-turn gate — the submitting key does not count as typing after the turn', () => {
  const rig = () => {
    let clock = 100_000;
    let lastKey = 0;
    const gate = createInternalTurnGate({
      isEnabled: () => true,
      isTurnRunning: () => false,
      getBufferText: () => '',
      getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0,
      lastHumanKeyAt: () => lastKey,
      now: () => clock,
      log: () => {},
    });
    gate.port.attach(() => true);
    return { gate, press: () => { lastKey = clock; }, tick: (ms: number) => { clock += ms; } };
  };

  test('Enter submits a person turn; 2 s later the goal continue opens (no HumanTyping quiet window)', () => {
    const r = rig();
    r.press();
    r.gate.noteHumanTurn();
    r.tick(2_000);
    expect(r.gate.startTurnIfIdle('continue', { origin: 'goal-continue' })).toMatchObject({ opened: true });
  });

  test('a key typed after that turn started still holds it back (quiet-window)', () => {
    const r = rig();
    r.press();
    r.gate.noteHumanTurn();
    r.tick(1_000);
    r.press();
    r.tick(1_000);
    expect(r.gate.startTurnIfIdle('continue', { origin: 'goal-continue' })).toMatchObject({ opened: false, reason: 'HumanTyping' });
  });
});

describe('door humanFirstDetail — same rule for the C2 door', () => {
  const facts = (last: number, mark: number | undefined) => ({
    draft: () => '', unreadKeys: () => 0, lastHumanKeyAt: () => last, now: () => 102_000,
    ...(mark === undefined ? {} : { lastHumanTurnKeyAt: () => mark }),
  });
  test('the submitting key (≤ mark) is not quiet-window; a later key is; no mark = old behaviour', () => {
    expect(humanFirstDetail(facts(100_000, 100_000))).toBeNull();
    expect(humanFirstDetail(facts(101_000, 100_000))).toBe('quiet-window');
    expect(humanFirstDetail(facts(100_000, undefined))).toBe('quiet-window');
  });
});
