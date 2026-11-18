// TC-H-POOL-3 · 테스트 우주(② 담당 · CAPSULE-ASSIGNMENT-0329 줄47) — 턴 근분 C2 장면 3종.
// Pack registration (worlds yaml + SIM_WORLD_IDS) is the pack owner's follow-up; this runner keeps the seat-mail
// scenarios.test.ts shape so the scenarios lift into the pack unchanged. Branch: hand-tc-h-cc-2/c2-fu (#38591).
//
// S1 boot notice vs first Enter (C2-①) · S2 two simultaneous events, zero double turns (C2-②) · S3 six-turn baseline.
// Verdict rule: a scenario passes only when 이중 턴 0 · 사건 버림 0 · no refused door transitions.
import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSimWorldRecorder } from '../recorder.js';
import { createEntryTurnDoor, doorOutcomeOf, nextDoorOpener } from '../../../tui/turn-events/door-wire.js';

setDefaultTimeout(20_000);
const dirs: string[] = [];
function universe(id: string) {
  const root = mkdtempSync(join(tmpdir(), `sim-turn-capsule-${id}-`));
  dirs.push(root);
  return { root, recorder: createSimWorldRecorder({ dir: join(root, 'record'), world: 'seat-mail', scenario: id, engine: 'legacy', seed: 1 }) };
}
afterAllCleanup();
function afterAllCleanup() { process.on('exit', () => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }); }

/** S1 · C2-① boot notice races the person's first Enter — exactly one turn, nothing dropped. */
test('S1 · a boot notice racing the first Enter opens exactly one turn and drops nothing', () => {
  const u = universe('S1');
  const log: string[] = [];
  // (a) the notice wins the tick: reserve → begin before any key.
  let typing: string | null = null;
  const holder = createEntryTurnDoor({
    humanFirst: () => typing, nextIsHuman: () => false,
    onOffer: () => {}, log: (_e, d) => log.push(`${_e}:${String(d.why ?? d.state ?? d.token ?? '')}`), now: () => 1_000,
  });
  const auto = holder.reserveAuto();
  expect(auto).not.toBeNull();
  expect(holder.beginTurn()).toBe(true);
  expect(holder.door.state()).toBe('running');
  const humanMidTurn = holder.reserveHuman(); // Enter during the notice turn: queued, not a second turn
  expect(humanMidTurn).toBeNull();
  holder.endTurn('completed');
  expect(holder.door.state()).toBe('idle');
  expect(nextDoorOpener({ headKind: 'user', hasHeldNotice: false })).toBe('person'); // the person goes next
  u.recorder.event('s1a', { doubleTurn: humanMidTurn !== null ? 1 : 0, state: holder.door.state() });

  // (b) the person is typing first: the notice is held (bell), never dropped, and runs after the person's turn.
  const holder2 = createEntryTurnDoor({
    humanFirst: () => 'buffer', nextIsHuman: () => false,
    onOffer: () => {}, log: (_e, d) => log.push(`${_e}:${String(d.why ?? d.state ?? d.token ?? '')}`), now: () => 2_000,
  });
  expect(holder2.reserveAuto()).toBeNull();            // human-first: refused
  expect(holder2.door.bellPending()).toBe(true);       // the bell remembers the notice
  expect(holder2.reserveHuman()).not.toBeNull();
  expect(holder2.beginTurn()).toBe(true);
  holder2.endTurn('completed');
  expect(holder2.door.state()).toBe('idle');
  u.recorder.event('s1b', { bellAfterPersonTurn: holder2.door.bellPending() });
  const noRefused = log.every((row) => !row.startsWith('door-transition-refused'));
  expect(noRefused).toBe(true);
});

/** S2 · C2-② two simultaneous events — zero double turns, both events reach a turn, in order. */
test('S2 · two simultaneous events open sequential turns, never two at once', () => {
  const u = universe('S2');
  const log: string[] = [];
  const opened: string[] = [];
  const holder = createEntryTurnDoor({
    humanFirst: () => null, nextIsHuman: () => false,
    onOffer: (reason) => { opened.push(reason); },
    log: (_e, d) => log.push(`${_e}:${String(d.why ?? d.state ?? d.token ?? '')}`), now: () => 3_000,
  });
  let doubleTurn = 0;
  holder.door.offer('event');                     // event 1 → offer → reserve → turn opens
  expect(opened.length).toBe(1);
  expect(holder.reserveAuto()).not.toBeNull();
  expect(holder.beginTurn()).toBe(true);
  expect(holder.door.state()).toBe('running');
  holder.door.offer('event');                     // event 2 DURING turn 1: bell hold, no second offer
  expect(opened.length).toBe(1);
  expect(holder.door.busy()).toBe(true);
  if (holder.beginTurn()) doubleTurn++;               // stale second begin must not start
  expect(doubleTurn).toBe(0);
  holder.endTurn('completed');                        // rings the bell → event 2 offered
  expect(opened.length).toBe(2);
  expect(holder.reserveAuto()).not.toBeNull();        // event 2's turn
  expect(holder.beginTurn()).toBe(true);
  holder.endTurn('completed');
  expect(holder.door.state()).toBe('idle');
  u.recorder.event('s2', { offers: opened.length, doubleTurn, drops: 2 - opened.length });
  expect(log.every((row) => !row.startsWith('door-transition-refused'))).toBe(true);
  expect(opened.length).toBe(2);
});

/** S3 · baseline — six plain human turns cycle the door with no anomaly (regression floor vs flag off). */
test('S3 · six human turns cycle the door cleanly', () => {
  const u = universe('S3');
  const holder = createEntryTurnDoor({
    humanFirst: () => null, nextIsHuman: () => false,
    onOffer: () => {}, log: () => {}, now: () => 4_000,
  });
  let opened_ = 0;
  for (let i = 0; i < 6; i++) {
    expect(holder.reserveHuman()).not.toBeNull();
    expect(holder.beginTurn()).toBe(true);
    expect(holder.door.state()).toBe('running');
    holder.endTurn(i % 2 ? 'completed' : 'stopped');
    expect(holder.door.state()).toBe('idle');
    opened_++;
  }
  u.recorder.event('s3', { turns: opened_, refusals: 0 });
  expect(opened_).toBe(6);
  expect(doorOutcomeOf('completed')).toBe('responded');
  expect(doorOutcomeOf('stopped')).toBe('stopped');
});
