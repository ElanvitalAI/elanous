// WRITER-CHECK-RESOLVER — independent literals · a real temp ledger (test universe) · literal ports (no gh/git).
import { afterAll, afterEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore, type MessageEnvelope } from '../../msg/msg-store.js';
import { beaconHands, buildFederationLadder, handClosedOn, openHands, readHandMail } from '../../msg/hand-raise-ladder.js';
import { handCauseOf, resolveWriterCheck, runWriterCheckResolver, type WriterCheckPorts } from './writer-resolver.js';
import { parseRecentLog, parseWorktreeList } from './writer-resolver-live.js';

const root = mkdtempSync(join(tmpdir(), 'writer-resolver-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { setSystemTime(); });
const T0 = Date.parse('2026-11-25T13:30:00.000Z');
let n = 0;
const freshStore = (): MsgStore => new MsgStore(join(root, `m${++n}.db`));
const ladder = buildFederationLadder({ spaces: [{ coordinator: 'TC', seats: ['TC', 'TC-H-CX-1', 'TC-H-CX-6', 'MOB-1', 'MVP-B', 'HAND-TUI-D'] }, { coordinator: 'OP', seats: ['OP'] }] });

const hand = (from: string, block: string, reason: string, extra: string[] = []): MessageEnvelope => ({
  from, to: 'TC', kind: 'request', intent: 'decision', correlationId: block,
  body: `[✋ NEED HUMAN · ${from}] 기존 writer 인계 및 TC의 명시 해제 전 편집·시험 금지`,
  refs: [`block:${block}`, `seat:${from}`, 'pane:p1', `reason:${reason}`, ...extra],
});

const ports = (over: Partial<WriterCheckPorts> = {}): WriterCheckPorts => ({
  worktreeOf: (seat) => (seat === 'TC-H-CX-1' ? '/wt/tc-h-cx-1' : null),
  uncommitted: () => [],
  openPrs: () => [],
  recentCommits: () => [],
  ...over,
});

function deps(extra: { ports: WriterCheckPorts; live?: boolean }) {
  const logs: string[] = [];
  return { logs, d: { ladder, now: () => Date.now(), raiseDecision: () => {}, log: (e: string) => { logs.push(e); }, ...extra } };
}

test('cause comes from structured fields only: ref cause: first, then the block code; CEO-only categories never', () => {
  expect(handCauseOf({ reason: 'HUMAN_DECISION', refs: ['cause:worktree-path'] })).toBe('worktree-path');
  expect(handCauseOf({ reason: 'OWNER_UNKNOWN', refs: [] })).toBe('writer-handover');
  expect(handCauseOf({ reason: 'DEPENDENCY_WAIT', refs: [] })).toBe('writer-handover');
  expect(handCauseOf({ reason: 'APPROVAL_PENDING', refs: [] })).toBe('res-approval');
  expect(handCauseOf({ reason: 'HUMAN_DECISION', refs: [] })).toBeNull();
  expect(handCauseOf({ reason: 'APPROVAL_PENDING', refs: ['category:money'] })).toBeNull();
  expect(handCauseOf({ reason: 'OWNER_UNKNOWN', refs: ['cause:bogus'] })).toBeNull();
});

test('writer check ladder: open PR → continue on it · other seat commit → coordinate · uncommitted → new branch · none → you are the writer', () => {
  const h = { reason: 'OWNER_UNKNOWN', blockedSeat: 'TC-H-CX-1', refs: ['path:src/a.ts'] };
  expect(resolveWriterCheck(h, ports({ openPrs: () => [{ number: 40146, branch: 'fix/els-x', files: ['src/a.ts'] }] })))
    .toEqual({ kind: 'resolve', cause: 'writer-handover', answer: 'open PR #40146 touches these paths — continue on top of its branch fix/els-x' });
  expect(resolveWriterCheck(h, ports({ recentCommits: () => [{ sha: 'abcdef1234567', seat: 'TC-H-CX-6', files: ['src/a.ts'] }] })))
    .toEqual({ kind: 'resolve', cause: 'writer-handover', coordinateWith: 'TC-H-CX-6',
      answer: 'TC-H-CX-6 committed abcdef1234 on these files within 2h — one mail to TC-H-CX-6 is sent for you; proceed in 30 min' });
  expect(resolveWriterCheck({ ...h, refs: [] }, ports({ uncommitted: () => ['src/b.ts'] })))
    .toEqual({ kind: 'resolve', cause: 'writer-handover', answer: 'uncommitted files in /wt/tc-h-cx-1 (src/b.ts) — start a new branch and keep their files untouched' });
  expect(resolveWriterCheck(h, ports())).toEqual({ kind: 'resolve', cause: 'writer-handover', answer: 'no open PR and no recent commit on these paths — you are the writer; proceed' });
  // A port that throws is «unknown», not a crash.
  expect(resolveWriterCheck(h, ports({ openPrs: () => { throw new Error('gh down'); } }))!.kind).toBe('resolve');
});

test('worktree-path: found → the path · not found → escalate · slot/RES → policy auto', () => {
  expect(resolveWriterCheck({ reason: 'HUMAN_DECISION', blockedSeat: 'TC-H-CX-1', refs: ['cause:worktree-path'] }, ports()))
    .toEqual({ kind: 'resolve', cause: 'worktree-path', answer: 'your worktree is /wt/tc-h-cx-1 — proceed there' });
  expect(resolveWriterCheck({ reason: 'HUMAN_DECISION', blockedSeat: 'MOB-1', refs: ['cause:worktree-path'] }, ports())!.kind).toBe('escalate');
  expect(resolveWriterCheck({ reason: 'HUMAN_DECISION', blockedSeat: 'HAND-TUI-D', refs: ['cause:slot-isolation'] }, ports()))
    .toEqual({ kind: 'resolve', cause: 'slot-isolation', answer: 'policy auto (guardian caps) · RES absorbed — no approval needed; test-universe read-only runs never need one' });
});

test('tick: resolves with owner ⊕ deadline (a real outcome), overrides a leader HOLD and logs it, one digest per leader', () => {
  const store = freshStore();
  setSystemTime(new Date(T0));
  const raised = store.append(hand('TC-H-CX-6', 'blk-6', 'OWNER_UNKNOWN'));
  store.append({ from: 'TC', to: 'TC-H-CX-6', kind: 'reply', replyTo: raised.id, body: '기존 writer 인계 확인 전 HOLD 유지' });
  setSystemTime(new Date(T0 + 60_000));
  const { d, logs } = deps({ ports: ports() });
  const report = runWriterCheckResolver(store, d);
  expect(report.resolved.map((r) => [r.msgId, r.cause, r.overrode])).toEqual([[raised.id, 'writer-handover', true]]);
  expect(handClosedOn(store, readHandMail(store, raised.id)!)).toBe('resolved');
  expect(logs).toContain('needhuman.resolver-override');
  const outcome = store.db.query(`SELECT body, refs_json FROM msg_messages WHERE refs_json LIKE '%hand-outcome:resolve%'`).get() as { body: string; refs_json: string };
  expect(outcome.refs_json).toContain('"hand-owner:TC-H-CX-6"');
  expect(outcome.refs_json).toContain('"hand-deadline:2026-11-25T14:01:00.000Z"');
  expect(report.digests).toEqual([`[행정관 · writer-check] TC: resolved 1 ✋ — writer-handover ×1 (#${raised.id}) · 회신 불필요`]);
  // Idempotent: the next tick finds nothing open.
  expect(runWriterCheckResolver(store, d).resolved).toEqual([]);
});

test('shadow (live=false) computes the same answers and writes nothing', () => {
  const store = freshStore();
  setSystemTime(new Date(T0));
  store.append(hand('MOB-1', 'blk-m', 'APPROVAL_PENDING'));
  const before = (store.db.query('SELECT COUNT(*) AS n FROM msg_messages').get() as { n: number }).n;
  const report = runWriterCheckResolver(store, deps({ ports: ports(), live: false }).d);
  expect(report.resolved.length).toBe(1);
  expect((store.db.query('SELECT COUNT(*) AS n FROM msg_messages').get() as { n: number }).n).toBe(before);
});

test('sim 22:4x: 55 ✋ at TC (31 dependency · 14 approval · 2 owner · 3 worktree unknown · 5 human) → ≥80% resolved · one card per cause', () => {
  const store = freshStore();
  setSystemTime(new Date(T0));
  const seats = ['TC-H-CX-6', 'TC-H-CX-1', 'HAND-TUI-D', 'MOB-1', 'MVP-B'];
  const mix: Array<[string, string[]]> = [
    ...Array.from({ length: 31 }, (): [string, string[]] => ['DEPENDENCY_WAIT', []]),
    ...Array.from({ length: 14 }, (): [string, string[]] => ['APPROVAL_PENDING', []]),
    ...Array.from({ length: 2 }, (): [string, string[]] => ['OWNER_UNKNOWN', []]),
    ...Array.from({ length: 3 }, (): [string, string[]] => ['HUMAN_DECISION', ['cause:worktree-path']]),
    ...Array.from({ length: 5 }, (): [string, string[]] => ['HUMAN_DECISION', []]),
  ];
  mix.forEach(([reason, extra], i) => store.append(hand(i >= 47 && i < 50 ? 'MOB-1' : seats[i % seats.length]!, `blk-${i}`, reason, extra)));
  expect(mix.length).toBe(55);
  setSystemTime(new Date(T0 + 2 * 60_000));
  const { d } = deps({ ports: ports({ openPrs: () => [{ number: 40151, branch: 'fix/beacon', files: ['src/msg/hand-raise-ladder.ts'] }] }) });
  const report = runWriterCheckResolver(store, d);
  expect(report.resolved.length).toBe(47);
  expect(report.resolved.length / 55).toBeGreaterThanOrEqual(0.8);
  expect(report.cards.map((c) => [c.cause, c.members.length])).toEqual([['worktree-path', 3]]);
  // What is left is the HUMAN_DECISION family: the beacon fires it as one card (same leader · seat · reason groups).
  const atTc = (): number => openHands(store, { now: Date.now(), ladder }).filter((h) => h.receiver === 'TC').length;
  expect(atTc()).toBe(5);
  setSystemTime(new Date(T0 + 11 * 60_000));
  const beacon = beaconHands(store, { ...d, dormantSeats: [] });
  expect(beacon.fired.length).toBeGreaterThanOrEqual(1);
  // #40160 beacon cap: ≤3 cards per 10 min — the other causes stay open and go on the next window.
  expect(beacon.fired.length).toBeLessThanOrEqual(3);
  expect(atTc()).toBeLessThan(5);
  for (const m of [22, 33]) { setSystemTime(new Date(T0 + m * 60_000)); beaconHands(store, { ...d, dormantSeats: [] }); }
  expect(atTc()).toBe(0);
});

test('live parsers: worktree list porcelain and recent log with the seat from the ref name', () => {
  expect(parseWorktreeList('worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r/.claude/wt/tc-h-cx-1\nHEAD 2\nbranch refs/heads/tc-h-cx-1/els-api\n'))
    .toEqual([{ path: '/r', branch: 'main' }, { path: '/r/.claude/wt/tc-h-cx-1', branch: 'tc-h-cx-1/els-api' }]);
  expect(parseRecentLog('@@aaa\trefs/heads/tc-h-cx-6/fix\n\nsrc/a.ts\nsrc/b.ts\n@@bbb\trefs/heads/main\n\nsrc/c.ts\n', ['TC', 'TC-H-CX-6']))
    .toEqual([{ sha: 'aaa', seat: 'TC-H-CX-6', files: ['src/a.ts', 'src/b.ts'] }]);
});

test('live 23:0x: a family ✋ escalated up to CLAUDE-OP (the CEO copy) is still answered and closes', () => {
  const store = freshStore();
  setSystemTime(new Date(T0));
  const raised = store.append(hand('TC-H-CX-6', 'blk-up', 'DEPENDENCY_WAIT'));
  store.append({ from: 'OP', to: 'CLAUDE-OP', kind: 'request', intent: 'decision', correlationId: 'blk-up', body: '[✋ ESCALATED · OP → CLAUDE-OP] copy',
    refs: ['block:blk-up', 'seat:TC-H-CX-6', 'reason:DEPENDENCY_WAIT', `hand-of:${raised.id}`, `hand-escalated-from:${raised.id}`] });
  setSystemTime(new Date(T0 + 60_000));
  const report = runWriterCheckResolver(store, deps({ ports: ports() }).d);
  expect(report.resolved.map((r) => [r.leader, r.seat, r.cause])).toEqual([['CLAUDE-OP', 'TC-H-CX-6', 'writer-handover']]);
  expect(openHands(store, { now: Date.now(), ladder }).length).toBe(0);
});
