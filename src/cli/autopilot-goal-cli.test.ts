// CROWN-GOAL-APPLY — `autopilot goal set` posts one structured goal mail (literal expectations · temp ledger).
import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { MsgStore } from '../msg/msg-store.js';
import { registerAutopilotGoalCommands } from './autopilot-goal-cli.js';

const root = mkdtempSync(join(tmpdir(), 'ap-goal-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { process.exitCode = 0; });
let n = 0;

// An independent literal ladder: TC coordinates TC-H-CX-1; UX coordinates UX-H-1; coordinators report to OP.
const PARENT: Record<string, string> = { OP: 'CEO', TC: 'OP', UX: 'OP', 'TC-H-CX-1': 'TC', 'UX-H-1': 'UX' };
const literalLadder = { hq: 'OP', parentOf: (seat: string) => PARENT[seat] ?? 'OP' };

function run(args: string[]) {
  const db = join(root, `m${++n}.db`);
  const lines: string[] = [];
  const errors: string[] = [];
  const program = new Command().exitOverride();
  registerAutopilotGoalCommands(program, { msgPath: () => db, callerSeat: () => null, ladder: () => literalLadder, out: { log: (l) => { lines.push(l); }, error: (l) => { errors.push(l); } } });
  program.parse(['node', 'eln', ...args]);
  return { db, lines, errors };
}

test('OP sets OP\'s goal: one mail with the structured goal field, addressed to OP', () => {
  const r = run(['autopilot', 'goal', 'set', '--seat', 'OP', '착지 10/시간', '--from', 'OP', '--json']);
  expect(r.errors).toEqual([]);
  expect(JSON.parse(r.lines[0]!)).toEqual({ ok: true, msgId: 1, seat: 'OP', from: 'OP', goal: '착지 10/시간' });
  const store = new MsgStore(r.db);
  try {
    const m = store.getMessage(1)!;
    expect([m.from, m.to, m.kind, m.intent, m.goal, m.body]).toEqual(['OP', 'OP', 'goal', 'info', '착지 10/시간', 'Autopilot goal set by OP: 착지 10/시간']);
  } finally { store.close(); }
});

test('CLAUDE-OP may set a goal with a done line; TC is refused and nothing is posted', () => {
  const ok = run(['autopilot', 'goal', 'set', '--seat', 'op', 'A 골', '--from', 'CLAUDE-OP', '--done', '시간당 착지 10']);
  expect(ok.lines).toEqual(['goal mail #1 → OP: A 골 (applied by the seat\'s TUI on arrival)']);
  const s1 = new MsgStore(ok.db);
  try { expect(s1.getMessage(1)?.doneWhen).toBe('시간당 착지 10'); } finally { s1.close(); }
  const refused = run(['autopilot', 'goal', 'set', '--seat', 'OP', 'B 골', '--from', 'TC']);
  expect(refused.errors).toEqual(['autopilot goal set: TC is not above OP on the federation ladder (parent of OP = CEO) — only OP / CLAUDE-OP (any seat), a space coordinator (its own hands) or --crown-directive <id> may set a seat goal']);
  expect(process.exitCode).toBe(2);
  const s2 = new MsgStore(refused.db);
  try { expect(s2.getMessage(1)).toBeNull(); } finally { s2.close(); }
});

test('GOAL-SET-COORD-BY-OP: OP → TC posts; TC → its own hand posts; TC → UX is refused with the reason and posts nothing', () => {
  const opToTc = run(['autopilot', 'goal', 'set', '--seat', 'TC', '스페이스 주인 골', '--from', 'OP', '--json']);
  expect(opToTc.errors).toEqual([]);
  expect(JSON.parse(opToTc.lines[0]!)).toEqual({ ok: true, msgId: 1, seat: 'TC', from: 'OP', goal: '스페이스 주인 골' });
  const tcToHand = run(['autopilot', 'goal', 'set', '--seat', 'TC-H-CX-1', '손 골', '--from', 'TC', '--json']);
  expect(tcToHand.errors).toEqual([]);
  expect(JSON.parse(tcToHand.lines[0]!)).toEqual({ ok: true, msgId: 1, seat: 'TC-H-CX-1', from: 'TC', goal: '손 골' });
  const tcToUx = run(['autopilot', 'goal', 'set', '--seat', 'UX', '남의 골', '--from', 'TC']);
  expect(tcToUx.errors).toEqual(['autopilot goal set: TC is not above UX on the federation ladder (parent of UX = OP) — only OP / CLAUDE-OP (any seat), a space coordinator (its own hands) or --crown-directive <id> may set a seat goal']);
  expect(process.exitCode).toBe(2);
  const s = new MsgStore(tcToUx.db);
  try { expect(s.getMessage(1)).toBeNull(); } finally { s.close(); }
});
