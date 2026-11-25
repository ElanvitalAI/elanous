// LEADER-HAND-CONTRACT — independent literals · real temp ledger · the 11-25 TC ✋ stream replayed (55 raises, HOLD replies).
import { afterAll, afterEach, expect, setSystemTime, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore, type MessageEnvelope } from './msg-store.js';
import {
  applyHandOutcome, beaconLine, buildFederationLadder, countHoldRejects, handClosedOn, holdReplyWarning, leaderHandCard,
  leaderHandSla, openHands, readHandMail, readLeaderHandMemories, type CeoCard,
} from './hand-raise-ladder.js';
import { dispatchHandRaise, normalizeDeadline } from '../skills/tools/hand-raise-tool.js';

const root = mkdtempSync(join(tmpdir(), 'leader-hand-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { setSystemTime(); });
const T0 = Date.parse('2026-11-25T13:30:00.000Z');
let n = 0;
const freshStore = (): MsgStore => new MsgStore(join(root, `m${++n}.db`));
const ladder = buildFederationLadder({ spaces: [{ coordinator: 'TC', seats: ['TC', 'TC-H-CC-1', 'TC-H-CC-2'] }, { coordinator: 'OP', seats: ['OP'] }] });
const deps = { ladder, now: () => Date.now(), raiseDecision: (_c: CeoCard) => {} };

const hand = (from: string, i: number): MessageEnvelope => ({
  from, to: 'TC', kind: 'request', intent: 'decision', correlationId: `wc-${i}`,
  body: `[✋ NEED HUMAN · ${from}] writer check: cell X-${i} has another writer`,
  refs: [`block:wc-${i}`, `seat:${from}`, 'reason:WRITER_CHECK'],
});

// The leader's literal replies from tonight (TC · 11-25 22:2x~22:5x).
const TONIGHT_HOLDS = [
  '각 기존 writer에 작업물 보존·명시 인계 여부와 해당 HOLD 유지',
  '기존 결정 #167537 유지: 기존 writer 응답까지 보류',
  'wait for RES approval',
];

test('tool: resolve without owner/deadline is refused, counted, and the ✋ stays open', () => {
  setSystemTime(new Date(T0));
  const path = join(root, `m${++n}.db`);
  const seed = new MsgStore(path); const h = seed.append(hand('TC-H-CC-1', 1)); seed.close();
  expect(() => dispatchHandRaise({ action: 'resolve', msgId: h.id, text: 'continue on top of PR #40150' }, { openStore: () => new MsgStore(path), ladder, now: () => T0 }))
    .toThrow(/owner and deadline/);
  const s = new MsgStore(path);
  expect(countHoldRejects(s, T0 - 1)).toBe(1);
  expect(handClosedOn(s, readHandMail(s, h.id)!)).toBeNull();
  s.close();
});

test('tool: a HOLD text is refused even with owner absent; the error lists continue-on-PR · one mail then 30 min · new branch · policy auto', () => {
  setSystemTime(new Date(T0));
  const path = join(root, `m${++n}.db`);
  const seed = new MsgStore(path); const h = seed.append(hand('TC-H-CC-2', 2)); seed.close();
  let message = '';
  try { dispatchHandRaise({ action: 'resolve', msgId: h.id, text: TONIGHT_HOLDS[1] }, { openStore: () => new MsgStore(path), ladder, now: () => T0 }); }
  catch (e) { message = String(e); }
  expect(message).toContain('continue on top of PR #<n>');
  expect(message).toContain('then proceed in 30 min');
  expect(message).toContain('new branch from origin/main');
  expect(message).toContain('RES/REL are absorbed');
});

test('tool: a concrete resolve with owner + «30m» deadline closes the ✋ as resolved with owner refs', () => {
  setSystemTime(new Date(T0));
  const path = join(root, `m${++n}.db`);
  const seed = new MsgStore(path); const h = seed.append(hand('TC-H-CC-1', 3)); seed.close();
  const r = dispatchHandRaise({ action: 'resolve', msgId: h.id, text: 'continue on top of PR #40150, rebase then push', owner: 'TC-H-CC-1', deadline: '30m' },
    { openStore: () => new MsgStore(path), ladder, now: () => T0 });
  expect(r.action).toBe('resolve');
  const s = new MsgStore(path);
  expect(handClosedOn(s, readHandMail(s, h.id)!)).toBe('resolved');
  const out = s.getMessage(r.mailId!)!;
  expect(out.refs).toContain('hand-owner:TC-H-CC-1');
  expect(out.refs).toContain('hand-deadline:2026-11-25T14:00:00.000Z');
  s.close();
});

test('normalizeDeadline: 30m / 2h relative, ISO passes through', () => {
  expect(normalizeDeadline('30m', T0)).toBe('2026-11-25T14:00:00.000Z');
  expect(normalizeDeadline('2h', T0)).toBe('2026-11-25T15:30:00.000Z');
  expect(normalizeDeadline('2026-11-26T00:00:00Z', T0)).toBe('2026-11-26T00:00:00Z');
  expect(normalizeDeadline('', T0)).toBe('');
});

test('CLI door (applyHandOutcome): HOLD without owner refused · HOLD with owner ⊕ deadline accepted', () => {
  setSystemTime(new Date(T0));
  const store = freshStore();
  const a = store.append(hand('TC-H-CC-1', 4));
  expect(() => applyHandOutcome(store, { msgId: a.id, action: 'resolve', text: TONIGHT_HOLDS[0]!, via: 'cli' }, deps)).toThrow(/refused/);
  const ok = applyHandOutcome(store, { msgId: a.id, action: 'resolve', text: '보류 — RES 재기동 후 진행', owner: 'TC', deadline: '2026-11-25T14:00:00Z' }, deps);
  expect(ok.mailId).not.toBeNull();
  expect(handClosedOn(store, readHandMail(store, a.id)!)).toBe('resolved');
  store.close();
});

test('msg post path: free-text HOLD reply to a ✋ warns, is counted, and does not close it; a concrete reply gets no warning', () => {
  setSystemTime(new Date(T0));
  const store = freshStore();
  const a = store.append(hand('TC-H-CC-2', 5));
  const hold = store.append({ from: 'TC', to: 'TC-H-CC-2', kind: 'reply', body: TONIGHT_HOLDS[1]!, replyTo: a.id });
  const w = holdReplyWarning(store, { from: 'TC', replyTo: a.id, body: hold.body, refs: [], now: T0 });
  expect(w).toContain('does NOT close the ✋');
  expect(handClosedOn(store, readHandMail(store, a.id)!)).toBeNull();
  expect(holdReplyWarning(store, { from: 'TC', replyTo: a.id, body: 'new branch from origin/main, keep the uncommitted files', refs: [], now: T0 })).toBeNull();
  expect(holdReplyWarning(store, { from: 'TC', replyTo: 999999, body: 'HOLD', refs: [], now: T0 })).toBeNull();
  expect(countHoldRejects(store, T0 - 1, 'TC')).toBe(1);
  store.close();
});

test('sim: tonight 55 ✋ at TC — leader replays a HOLD reply, tool refuses each, leader re-answers with a standard answer → 55 resolved with owner', () => {
  setSystemTime(new Date(T0));
  const path = join(root, `m${++n}.db`);
  const seed = new MsgStore(path);
  const ids: number[] = [];
  for (let i = 0; i < 55; i++) ids.push(seed.append(hand(i % 2 ? 'TC-H-CC-1' : 'TC-H-CC-2', 100 + i)).id);
  seed.close();
  let refused = 0;
  ids.forEach((id, i) => {
    setSystemTime(new Date(T0 + 4 * 60_000));
    // first attempt: the leader model replays tonight's HOLD reply.
    try { dispatchHandRaise({ action: 'resolve', msgId: id, text: TONIGHT_HOLDS[i % 3]!, seat: 'TC' }, { openStore: () => new MsgStore(path), ladder, now: () => T0 }); }
    catch (e) { if (/refused/.test(String(e))) refused += 1; }
    // re-answer after reading the refusal.
    dispatchHandRaise({ action: 'resolve', msgId: id, text: 'coordinate: one mail to the current writer, then proceed', owner: i % 2 ? 'TC-H-CC-1' : 'TC-H-CC-2', deadline: '30m', seat: 'TC' },
      { openStore: () => new MsgStore(path), ladder, now: () => T0 });
  });
  expect(refused).toBe(55);
  const s = new MsgStore(path);
  expect(openHands(s, { now: T0 + 5 * 60_000, involving: 'TC' }).length).toBe(0);
  const sla = leaderHandSla(s, { now: T0 + 5 * 60_000 });
  expect(sla.resolved).toBe(55);
  expect(sla.withOwner).toBe(55);
  expect(sla.medianMin).toBe(4);
  expect(sla.holdRejected).toBe(55);
  expect(beaconLine({ open: 0, oldestMin: 0, escalated: 0, sla })).toBe('✋ open 0 · oldest 0m · escalated 0 · leader SLA: median 4m · with-owner 100% (55/55) · HOLD refused 55');
  s.close();
});

test('leader card: open ✋ table (cause · age · repeat) ⊕ 4 answers ⊕ rule ⊕ seat memory read by file name', () => {
  setSystemTime(new Date(T0));
  const store = freshStore();
  store.append(hand('TC-H-CC-1', 7)); store.append(hand('TC-H-CC-1', 7)); store.append(hand('TC-H-CC-2', 8));
  const dir = join(root, 'seats', 'TC'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'writer-check-2min-rule.md'), '---\nname: x\n---\nwriter check older than 2 min = stale, proceed\n');
  writeFileSync(join(dir, 'unrelated.md'), 'do not load me');
  const card = leaderHandCard({ seat: 'TC', opens: openHands(store, { now: T0 + 7 * 60_000, involving: 'TC' }), memories: readLeaderHandMemories(dir) });
  expect(card).toContain('open ✋ | cause | age | repeat');
  expect(card).toContain('TC-H-CC-1 | WRITER_CHECK: writer check: cell X-7 has another writer | 7m | ×2');
  expect(card).toContain('TC-H-CC-2 | WRITER_CHECK: writer check: cell X-8 has another writer | 7m | ×1');
  expect(card).toContain('4. policy: auto — RES/REL are absorbed');
  expect(card).toContain('Never HOLD without owner ⊕ deadline');
  expect(card).toContain('seat memory writer-check-2min-rule.md: writer check older than 2 min = stale, proceed');
  expect(card).not.toContain('do not load me');
  store.close();
});
