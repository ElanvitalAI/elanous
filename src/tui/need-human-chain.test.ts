// NEED-HUMAN chain (11-25 05:55 incident) — one seat's «⏸ Blocked … a person is needed» end to end, with literal expectations:
//   update_plan args → plan wire → goal-continue → { agent-event bridge → els core → status-board / sidebar / `els --list` ,
//                                                     needs-human push → a real mail ledger (temp file) → 5-min ladder → OP }.
// Only the socket and the clock are replaced. Two holes this pins:
//   (a) a second block with a new reason while the first (already escalated) was never cleared reached nobody;
//   (b) a seat-reported BLOCKED/DEPENDENCY_WAIT read ⚪⏳ in els while the TUI said «a person is needed».
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElsCore, type ElsPty } from '../els/core.js';
import { emptyJournal } from '../els/space.js';
import { parsePaneRows } from '../els/attach-view.js';
import { layoutSpaceList, withCommands } from '../els/space-tabs-view.js';
import { statusBoardLines } from '../els/seat-status.js';
import { paneListLines } from '../cli/els-cli.js';
import { openMsgStore } from '../msg/msg-store.js';
import { parseUpdatePlanArgs } from '../code-edit/plan-tool.js';
import { parsePlanWire, planWireFromState } from '../code-edit/plan-wire.js';
import type { AgentEventFrame } from '../agent-events/protocol.js';
import { createAgentEventBridge, type AgentEventSink } from './agent-event-bridge.js';
import { createGoalContinue } from './input/goal-continue.js';
import type { StartTurnIfIdleResult } from './input/internal-turn.js';
import { createNeedsHumanPush } from './needs-human-push.js';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'need-human-chain-'));
  const store = openMsgStore(join(dir, 'msg.db'));
  // els core with one live eln pane in space TC (the hand TC-H-CX-1).
  let journal = emptyJournal(); const clock = 1_700_000_000_000;
  const core = createElsCore({ load: () => journal, save: (next) => { journal = next; }, now: () => clock,
    spawn: () => ({ id: 'pty1', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {}, lastOutputAt: () => clock - 40_000 }) as ElsPty,
    mailBadges: () => new Map() });
  core.start();
  const pane = (JSON.parse(core.newPane({ ws: 'TC', cwd: '/tmp', command: ['sh'], title: 'TC-H-CX-1' }).message) as { pane: string }).pane;
  core.setForegrounds(new Map([[pane, { kind: 'eln' as const, pid: 1, command: ['eln'] }]]));
  let seq = 0;
  const send = (event: AgentEventFrame['event']) => { core.agentEvent(pane, { op: 'event', v: 1, ws: 'TC', pane, sid: 's1', seq: ++seq, at: clock, event }); };
  const sink: AgentEventSink = { state: (state) => send({ kind: 'state', state }), turn: (phase, id) => send({ kind: 'turn', phase, id }), notice: () => {},
    seatState: (input) => send({ kind: 'state', state: input.state === 'BLOCKED' ? 'blocked' : 'idle', code: input.state, ...(input.reason ? { reason: input.reason } : {}), ...(input.detail ? { detail: input.detail } : {}) }) };
  const bridge = createAgentEventBridge(sink, () => 't1');
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const logs: string[] = [];
  let n = 0;
  const push = createNeedsHumanPush({
    seat: () => 'TC-H-CX-1', paneId: () => pane, coordinatorOf: () => 'TC',
    postMail: (e) => store.post(e, { dedupe: true }).id,
    raiseDecision: () => { logs.push('decision-card'); },
    resumeWith: () => { bridge.resume(); },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
    newBlockId: () => `blk-${++n}`,
    log: (event, data) => { logs.push(`${event} ${JSON.stringify(data)}`); },
  });
  const notices: string[] = [];
  const gc = createGoalContinue({
    startTurnIfIdle: () => ({ opened: true, turnId: 'x' }) as StartTurnIfIdleResult, isEnabled: () => true,
    notify: (line) => notices.push(line), log: () => {},
    // The production wiring (src/tui/entry.ts) — the same three lines.
    onBlocked: (reason, detail, text) => { bridge.blocked(reason, detail); push.blocked(reason, text || detail); },
    onUnblocked: () => { bridge.resume(); push.resumed(); },
  });
  const listJson = () => core.list().message;
  const board = () => statusBoardLines((JSON.parse(listJson()) as { panes: never[] }).panes, clock).join('\n');
  const sidebar = () => { const j = listJson(); return layoutSpaceList(withCommands(parsePaneRows(j), j), pane, 40, 24).lines.join('\n'); };
  const cliList = () => paneListLines(listJson(), clock).join('\n');
  const inbox = (to: string) => store.list(to, 0, 100, { includeAcked: true });
  const fire5m = () => { for (const t of timers.splice(0)) if (t.live && t.ms === 300_000) t.fn(); };
  const done = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { bridge, gc, notices, board, sidebar, cliList, inbox, fire5m, logs, done };
}

function planWire(status: 'blocked' | 'in_progress' | 'completed', reason?: string, code?: string) {
  const parsed = parseUpdatePlanArgs({ plan: [{ step: 'land the PR', status: 'completed' },
    { step: 'take DEMO-GRAPH-POLISH', status, ...(reason ? { reason } : {}), ...(code ? { code } : {}) }] });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsePlanWire(JSON.parse(JSON.stringify(planWireFromState({ steps: parsed.args.plan, updatedAt: 1, version: 2 }, 1))));
}

test('a hand enters ⏸ Blocked: 1 alert to its coordinator TC within 5 s · els shows ✋ in board, sidebar and els --list', () => {
  const r = rig();
  const t0 = performance.now();
  r.bridge.busy(true);
  r.gc.noteTurnEnded({ lines: ['stopping'], plan: planWire('blocked', 'PR #40001 must land first', 'DEPENDENCY_WAIT') });
  r.bridge.busy(false);
  const tc = r.inbox('TC');
  expect(performance.now() - t0).toBeLessThan(5_000);
  expect(tc.length).toBe(1);
  expect(tc[0]!.from).toBe('TC-H-CX-1');
  expect(tc[0]!.body).toBe('[✋ NEED HUMAN · TC-H-CX-1] PR #40001 must land first · 원하는 것: 이 막힘을 풀 결정·입력 (답장하면 그대로 재개) · 선택지: 재개/중단/다른 방법');
  expect(r.notices.at(-1)).toBe('⏸ Blocked: PR #40001 must land first — a person is needed · any key resumes');
  expect(r.board()).toMatch(/TC-H-CX-1\s+BLOCKED\s+DEPENDENCY_WAIT/);
  expect(r.sidebar()).toContain('⚪✋ TC-H-CX-1');
  expect(r.cliList()).toContain('⚪✋ TC-H-CX-1');
  console.log(`[receipt] coordinator-mail ms=${(performance.now() - t0).toFixed(1)} to=TC from=${tc[0]!.from} id=${tc[0]!.id} intent=${tc[0]!.intent}`);
  console.log(`[receipt] board: ${r.board().split('\n')[1]}`);
  console.log(`[receipt] sidebar: ${r.sidebar().split('\n').find((l) => l.includes('TC-H-CX-1'))!.trim()}`);
  r.done();
});

test('no coordinator action in 5 min → the hand never mails OP (one path: the OP steward watcher climbs)', () => {
  const r = rig();
  r.gc.noteTurnEnded({ lines: [], plan: planWire('blocked', 'which branch should own the fix', 'HUMAN_DECISION') });
  expect(r.inbox('OP').length).toBe(0);
  r.fire5m();
  expect(r.inbox('OP').length).toBe(0);
  expect(r.logs.some((l) => l.includes('held-at-leader'))).toBe(true);
  r.done();
});

test('the seat moves on (a coordinator mail turn ends with the plan open again) → ✋ clears and the 5-min ladder stops', () => {
  const r = rig();
  r.gc.noteTurnEnded({ lines: [], plan: planWire('blocked', 'need the owner of #4242', 'OWNER_UNKNOWN') });
  expect(r.sidebar()).toContain('⚪✋ TC-H-CX-1');
  r.bridge.busy(true);
  r.gc.noteTurnEnded({ lines: [], plan: planWire('in_progress') });
  r.bridge.busy(false);
  expect(r.sidebar()).not.toContain('✋');
  expect(r.board()).toMatch(/TC-H-CX-1\s+IDLE/);
  r.fire5m();
  expect(r.inbox('OP').length).toBe(0);
  r.done();
});

test('a second block with a new reason after the first was escalated reaches the coordinator again (05:57 TC-H-CX-1 hole)', () => {
  const r = rig();
  r.gc.noteTurnEnded({ lines: [], plan: planWire('blocked', 'first: owner unknown', 'HUMAN_DECISION') });
  r.fire5m();
  // A mail turn of its own; the plan is still blocked, same words → no new mail.
  r.gc.noteTurnEnded({ lines: [], plan: planWire('blocked', 'first: owner unknown', 'HUMAN_DECISION') });
  expect(r.inbox('TC').length).toBe(1);
  r.gc.noteTurnEnded({ lines: [], plan: planWire('blocked', 'second: the demo branch is gone', 'HUMAN_DECISION') });
  const tc = r.inbox('TC');
  expect(tc.length).toBe(2);
  expect(tc[1]!.body.startsWith('[✋ NEED HUMAN · TC-H-CX-1] second: the demo branch is gone · ')).toBe(true);
  r.done();
});

test('a person resumes → mark clears; a server-derived dependency wait (unreachable folder) still reads ⏳, not ✋', () => {
  const r = rig();
  r.gc.noteTurnEnded({ lines: [], plan: planWire('blocked', 'r', 'NO_WORK') });
  expect(r.cliList()).toContain('⚪✋ TC-H-CX-1');
  r.bridge.resume();
  expect(r.cliList()).not.toContain('✋');
  const derived = JSON.stringify({ workspaces: [], tabs: [], panes: [{ pane: 'p1', address: 'TC/t1/p1', tab: 't1', workspace: 'TC', title: 'TC-H-X', state: 'blocked',
    activityState: 'blocked', cwd: '/gone', status: { state: 'BLOCKED', reason: 'DEPENDENCY_WAIT', detail: 'cwd-unavailable', since: 1, source: 'derived' } }] });
  expect(layoutSpaceList(withCommands(parsePaneRows(derived), derived), 'p1', 40, 24).lines.join('\n')).toContain('⚪⏳ TC-H-X');
  r.done();
});
