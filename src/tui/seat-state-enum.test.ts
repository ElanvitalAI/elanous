// SEAT-STATE-ENUM — the eln side: a «a person is needed» stop and an approval prompt leave this process as state CODES on the
// agent-event wire. Real chain: update_plan args → plan-tool parse → plan wire (child → host) → goal-continue → agent-event
// bridge → the real emitter, with only the socket replaced by a frame recorder. Expectations are literals.
import { expect, test } from 'bun:test';
import { createAgentEventEmitter } from '../agent-events/emit.js';
import type { AgentEventFrame } from '../agent-events/protocol.js';
import { parseEventFrame } from '../agent-events/protocol.js';
import { parseUpdatePlanArgs } from '../code-edit/plan-tool.js';
import { parsePlanWire, planWireFromState } from '../code-edit/plan-wire.js';
import { createAgentEventBridge } from './agent-event-bridge.js';
import { createGoalContinue } from './input/goal-continue.js';
import type { StartTurnIfIdleResult } from './input/internal-turn.js';

function seat() {
  const frames: AgentEventFrame[] = [];
  const emitter = createAgentEventEmitter({ ws: 'HQ', socketPath: '/unused', pane: 'p1', now: () => 1_700_000_000_000,
    send: async (_path, frame) => { frames.push(frame); return { exitCode: 0, message: '' }; } });
  const bridge = createAgentEventBridge(emitter, () => 'turn1');
  const notices: string[] = [];
  const gc = createGoalContinue({
    startTurnIfIdle: () => ({ opened: true, turnId: 'x' }) as StartTurnIfIdleResult,
    isEnabled: () => true,
    notify: (line) => notices.push(line),
    onBlocked: (reason, detail) => bridge.blocked(reason, detail),
    log: () => {},
  });
  return { frames, emitter, bridge, gc, notices };
}

/** The model's update_plan call, as the REPL child parses it and hands it across the pipe. */
function blockedPlanWire(reasonText: string) {
  const parsed = parseUpdatePlanArgs({ plan: [
    { step: 'land the PR', status: 'completed' },
    { step: 'take #4242', status: 'blocked', reason: reasonText, code: 'OWNER_UNKNOWN' },
  ] });
  if (!parsed.ok) throw new Error(parsed.reason);
  const wire = planWireFromState({ steps: parsed.args.plan, updatedAt: 1, version: 2 }, 1);
  return parsePlanWire(JSON.parse(JSON.stringify(wire)));
}

const stateEvents = (frames: readonly AgentEventFrame[]) => frames.flatMap((f) => f.event.kind === 'state' ? [f.event] : []);

test('TUI blocked on an unknown owner → the report payload is {state: BLOCKED, reason: OWNER_UNKNOWN}', async () => {
  const s = seat();
  s.bridge.busy(true);
  s.gc.noteTurnEnded({ lines: ['done for now'], plan: blockedPlanWire('owner of #4242 is not confirmed') });
  s.bridge.busy(false);               // the turn ends after the verdict: the block is what the pane reports, not idle
  await s.emitter.flush();
  expect(s.notices.at(-1)).toContain('a person is needed');
  const last = stateEvents(s.frames).at(-1);
  expect(last).toEqual({ kind: 'state', state: 'blocked', code: 'BLOCKED', reason: 'OWNER_UNKNOWN', detail: 'plan-blocked' });
  // The frame is valid on the wire (the els reader accepts it as sent).
  const parsed = parseEventFrame(JSON.parse(JSON.stringify(s.frames.at(-1))));
  expect(parsed.ok && parsed.frame.event).toEqual({ kind: 'state', state: 'blocked', code: 'BLOCKED', reason: 'OWNER_UNKNOWN', detail: 'plan-blocked' });
});

test('changing the human-visible blocked wording does not change the reported state', async () => {
  const a = seat();
  a.gc.noteTurnEnded({ lines: [], plan: blockedPlanWire('owner of #4242 is not confirmed') });
  const b = seat();
  b.gc.noteTurnEnded({ lines: [], plan: blockedPlanWire('누가 이 칸 주인인지 모름 — 다른 말로 적음') });
  await a.emitter.flush(); await b.emitter.flush();
  expect(a.notices.at(-1)).not.toBe(b.notices.at(-1));
  expect(stateEvents(a.frames).at(-1)).toEqual({ kind: 'state', state: 'blocked', code: 'BLOCKED', reason: 'OWNER_UNKNOWN', detail: 'plan-blocked' });
  expect(stateEvents(b.frames).at(-1)).toEqual({ kind: 'state', state: 'blocked', code: 'BLOCKED', reason: 'OWNER_UNKNOWN', detail: 'plan-blocked' });
});

test('an approval prompt reports WAITING_APPROVAL/APPROVAL_PENDING and its close returns to WORKING', async () => {
  const s = seat();
  s.bridge.busy(true);
  s.bridge.approval(true);
  s.bridge.approval(false);
  await s.emitter.flush();
  expect(stateEvents(s.frames)).toEqual([
    { kind: 'state', state: 'working' },
    { kind: 'state', state: 'waiting-input', code: 'WAITING_APPROVAL', reason: 'APPROVAL_PENDING' },
    { kind: 'state', state: 'working', code: 'WORKING' },
  ]);
});

test('a blocked step with a code outside the enum is refused by update_plan; BLOCKED without a reason is refused on the wire', () => {
  const parsed = parseUpdatePlanArgs({ plan: [{ step: 'x', status: 'blocked', reason: 'r', code: 'SOMETHING_ELSE' }] });
  expect(parsed.ok).toBe(false);
  const frame = { op: 'event', v: 1, ws: 'HQ', sid: 's', seq: 1, at: 1, event: { kind: 'state', state: 'blocked', code: 'BLOCKED' } };
  expect(parseEventFrame(frame)).toEqual({ ok: false, ignore: false, reason: 'state: BLOCKED needs one reason' });
});

test('a block without a code (an older model) is still one reason: HUMAN_DECISION', async () => {
  const s = seat();
  const parsed = parseUpdatePlanArgs({ plan: [{ step: 'x', status: 'blocked', reason: 'needs the operator' }] });
  if (!parsed.ok) throw new Error(parsed.reason);
  s.gc.noteTurnEnded({ lines: [], plan: planWireFromState({ steps: parsed.args.plan, updatedAt: 1, version: 2 }, 1) });
  await s.emitter.flush();
  expect(stateEvents(s.frames).at(-1)).toEqual({ kind: 'state', state: 'blocked', code: 'BLOCKED', reason: 'HUMAN_DECISION', detail: 'plan-blocked' });
});
