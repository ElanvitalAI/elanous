// SPACE-ADVISOR — independent literals · a real temp ledger · injected clock (setSystemTime; the ledger stamps wall time).
import { afterAll, afterEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../../msg/msg-store.js';
import { buildFederationLadder, handClosedOn, readHandMail } from '../../msg/hand-raise-ladder.js';
import { parseWorkspaceConfig } from '../../els/workspace-config.js';
import {
  adviseTick, advisorBoardLine, advisorDigest, advisorMetrics, appendPrecedent, causeOfReason, learnFromCoordinator,
  matchPrecedent, readAdvisorEvents, readPrecedents, type Precedent,
} from './advisor.js';
import { runAdvisorSim, tcEvening } from './advisor-sim.js';

const root = mkdtempSync(join(tmpdir(), 'advisor-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { setSystemTime(); });
const ONE_MINUTE = 60_000;
const T0 = Date.parse('2026-11-25T14:00:00.000Z');
let n = 0;
const ladder = buildFederationLadder({ spaces: [{ coordinator: 'TC', seats: ['TC', 'TC-ADV', 'TC-H-1'] }, { coordinator: 'OP', seats: ['OP'] }] });

function setup(precedents: Precedent[] = []) {
  const dir = join(root, `c${++n}`);
  const store = new MsgStore(join(root, `m${n}.db`));
  const precedentsPath = join(dir, 'precedents.jsonl');
  for (const p of precedents) appendPrecedent(precedentsPath, p);
  let now = T0;
  setSystemTime(new Date(now));
  const deps = { ladder, now: () => now, raiseDecision: () => {}, advisor: 'TC-ADV', coordinator: 'TC', precedentsPath, eventsPath: join(dir, 'events.jsonl'), live: true };
  const raise = (reason: string, ctx: string[] = []) => store.append({ from: 'TC-H-1', to: 'TC', kind: 'request', intent: 'decision', body: '[✋ NEED HUMAN · TC-H-1] blocked',
    refs: ['block:b-' + reason, 'seat:TC-H-1', `reason:${reason}`, ...ctx] });
  return { store, deps, raise, at: (ms: number) => { now = ms; setSystemTime(new Date(ms)); } };
}

const WRITER: Precedent = { id: 'writer-check-2min-rule', cause: 'writer-handover', keys: {}, answer: 'check writer; idle 2 min → take it', owner: '{seat}', deadlineMin: 15, next: 'eln work next', source: 'feedback-memory', at: '2026-11-25T00:00:00.000Z' };

test('cause: structured reason codes map exactly; unknown is other', () => {
  expect(causeOfReason('writer-conflict')).toBe('writer-handover');
  expect(causeOfReason('WORKTREE')).toBe('worktree-path');
  expect(causeOfReason('slot')).toBe('slot-isolation');
  expect(causeOfReason('scope')).toBe('scope-decision');
  expect(causeOfReason('criteria')).toBe('cap-criteria');
  expect(causeOfReason('please help writer')).toBe('other');
});

test('precedent match: same cause ⊕ every key equal · most specific wins · judge breaks ties', () => {
  const a: Precedent = { ...WRITER, id: 'a', keys: {} };
  const b: Precedent = { ...WRITER, id: 'b', keys: { cell: 'C-7' } };
  const c: Precedent = { ...WRITER, id: 'c', keys: { cell: 'C-7' }, at: '2026-11-25T01:00:00.000Z' };
  const hand = { id: 1, reason: 'writer', refs: ['ctx:cell=C-7'], body: '' };
  expect(matchPrecedent(hand, [a, b])?.id).toBe('b');
  expect(matchPrecedent({ ...hand, refs: ['ctx:cell=C-9'] }, [a, b])?.id).toBe('a');
  expect(matchPrecedent({ ...hand, reason: 'scope' }, [a, b])).toBeNull();
  expect(matchPrecedent(hand, [b, c])?.id).toBe('c');
  expect(matchPrecedent(hand, [b, c], () => 'b')?.id).toBe('b');
});

test('routine ✋ with a precedent: the advisor resolves with owner ⊕ deadline — the ladder sees it closed', () => {
  const { store, deps, raise } = setup([WRITER]);
  const h = raise('writer-conflict');
  const steps = adviseTick(store, deps);
  expect(steps).toEqual([{ kind: 'resolved', handId: h.id, cause: 'writer-handover', precedent: 'writer-check-2min-rule' }]);
  expect(handClosedOn(store, readHandMail(store, h.id)!)).toBe('resolved');
  const outcome = store.db.query("SELECT refs_json FROM msg_messages WHERE refs_json LIKE '%hand-outcome:resolve%'").get() as { refs_json: string };
  expect(outcome.refs_json).toContain('"hand-owner:TC-H-1"');
  expect(outcome.refs_json).toContain('"hand-deadline:2026-11-25T14:15:00.000Z"');
});

test('the steward resolver goes first; a resolved ✋ never reaches the advisor', () => {
  const { store, deps, raise } = setup([WRITER]);
  const h = raise('writer');
  const steps = adviseTick(store, { ...deps, steward: () => ({ resolved: true }) });
  expect(steps).toEqual([{ kind: 'steward', handId: h.id, cause: 'writer-handover' }]);
});

test('judgment ✋: ONE card to TC · TC picks option 2 → hold with owner ⊕ deadline', () => {
  const { store, deps, raise, at } = setup();
  const h = raise('scope');
  const first = adviseTick(store, deps);
  expect(first[0]!.kind).toBe('recommended');
  adviseTick(store, deps); // second tick: no second card
  const cards = store.db.query("SELECT body FROM msg_messages WHERE sender = 'TC-ADV' AND recipient = 'TC'").all() as { body: string }[];
  expect(cards.length).toBe(1);
  expect(cards[0]!.body).toContain('1) hold');
  at(T0 + 3 * ONE_MINUTE);
  store.append({ from: 'TC', to: 'TC-ADV', kind: 'reply', intent: 'decision', refs: [`advisor-pick:${h.id}:1`], body: '1' });
  expect(adviseTick(store, deps)).toEqual([{ kind: 'picked', handId: h.id, cause: 'scope-decision' }]);
  expect(handClosedOn(store, readHandMail(store, h.id)!)).toBe('resolved');
});

test('TC silent: judgment class escalates to OP one tick before the ladder timer · routine class auto-applies', () => {
  const { store, deps, raise, at } = setup();
  const j = raise('cap');
  adviseTick(store, deps);
  at(T0 + 8 * ONE_MINUTE);
  expect(adviseTick(store, deps)).toEqual([{ kind: 'waiting', handId: j.id, cause: 'cap-criteria' }]);
  at(T0 + 9 * ONE_MINUTE);
  expect(adviseTick(store, deps)).toEqual([{ kind: 'escalated', handId: j.id, cause: 'cap-criteria' }]);
  const fwd = store.db.query("SELECT recipient FROM msg_messages WHERE refs_json LIKE ?").get(`%hand-escalated-from:${j.id}%`) as { recipient: string };
  expect(fwd.recipient).toBe('OP');

  // routine cause whose precedent carries a key the ✋ lacks → no direct resolve; a card, then auto-apply after silence
  const s2 = setup([{ ...WRITER, id: 'wt-1', cause: 'worktree-path', keys: {} }]);
  const r = s2.raise('worktree-path');
  // a card exists first (e.g. written by an earlier shadow-off tick): emulate by appending the provenance row
  s2.store.appendWithProvenance({ from: 'TC-ADV', to: 'TC', kind: 'request', intent: 'decision', refs: [`advisor-rec:TC-ADV:${r.id}`], body: 'card' }, `advisor-rec:TC-ADV:${r.id}`);
  s2.at(T0 + 10 * ONE_MINUTE);
  expect(adviseTick(s2.store, s2.deps)).toEqual([{ kind: 'auto', handId: r.id, cause: 'worktree-path', precedent: 'wt-1' }]);
});

test('learning: a TC resolve on a ✋ becomes a precedent (cause ⊕ ctx keys ⊕ text) exactly once', () => {
  const { store, deps, raise } = setup();
  const h = raise('slot', ['ctx:host=node-b']);
  store.append({ from: 'TC', to: 'TC-H-1', kind: 'reply', intent: 'decision', replyTo: h.id, refs: ['hand-outcome:resolve', `hand-of:${h.id}`, `hand-msg:${h.id}`], body: '[✋ RESOLVED · TC] use minim5 slot 2' });
  const learned = learnFromCoordinator(store, deps, T0 - ONE_MINUTE);
  expect(learned.map((p) => [p.cause, p.keys, p.answer])).toEqual([['slot-isolation', { host: 'node-b' }, 'use minim5 slot 2']]);
  expect(learnFromCoordinator(store, deps, T0 - ONE_MINUTE)).toEqual([]);
  expect(readPrecedents(deps.precedentsPath).length).toBe(1);
});

test('metrics ⊕ board line ⊕ 30-min digest (one mail per slot)', () => {
  const { store, deps, raise } = setup([WRITER]);
  raise('writer'); raise('scope');
  adviseTick(store, deps);
  const m = advisorMetrics(readAdvisorEvents(deps.eventsPath), T0 - ONE_MINUTE, 1);
  expect(advisorBoardLine('TC-ADV', 'TC', m)).toBe('🧭 TC-ADV 30m — resolved 1 · recommended 1 · TC-picked 0 · auto 0 · escalated 0 · steward 0 · TC ✋ open 1');
  const d1 = advisorDigest(store, deps);
  const d2 = advisorDigest(store, deps);
  expect(d1.mailId).toBe(d2.mailId);
  expect(d1.body).toContain('open ✋ by cause: scope-decision 1');
});

test('shadow mode writes nothing', () => {
  const { store, deps, raise } = setup([WRITER]);
  raise('writer');
  const before = (store.db.query('SELECT COUNT(*) AS n FROM msg_messages').get() as { n: number }).n;
  expect(adviseTick(store, { ...deps, live: false })[0]!.kind).toBe('resolved');
  expect((store.db.query('SELECT COUNT(*) AS n FROM msg_messages').get() as { n: number }).n).toBe(before);
  expect(() => readFileSync(deps.eventsPath)).toThrow();
});

test('federation.yaml: role advisor needs parent = a space coordinator', () => {
  const yaml = (parent: string) => `version: 1\nseats:\n  TC: { runtime: codex }\n  TC-ADV: { role: advisor, parent: ${parent}, runtime: codex, model: gpt-5.4-mini }\nspaces:\n  tc: { coordinator: TC, seats: [TC, TC-ADV] }\n`;
  const ok = parseWorkspaceConfig(yaml('TC'), '/tmp/x/.elanous/federation.yaml', '/tmp');
  expect(ok.errors).toEqual([]);
  expect(ok.config?.seats['TC-ADV']?.parent).toBe('TC');
  expect(parseWorkspaceConfig(yaml('TC-ADV'), '/tmp/x/.elanous/federation.yaml', '/tmp').errors.join(' ')).toContain('parent must name a space coordinator');
});

test('federation.yaml: spaces.kind (direct · federation · kingdom) is accepted; another value is an error', () => {
  const yaml = (kind: string) => `version: 1\nseats:\n  TC: { runtime: codex }\nspaces:\n  tc: { coordinator: TC, kind: ${kind} }\n`;
  expect(parseWorkspaceConfig(yaml('direct'), '/tmp/x/.elanous/federation.yaml', '/tmp').errors).toEqual([]);
  expect(parseWorkspaceConfig(yaml('kingdom'), '/tmp/x/.elanous/federation.yaml', '/tmp').errors).toEqual([]);
  expect(parseWorkspaceConfig(yaml('empire'), '/tmp/x/.elanous/federation.yaml', '/tmp').errors.join(' ')).toContain('kind must be direct, federation or kingdom');
});

test('sim: TC 11-25 evening 55 ✋ → ≤10 cards per 30 min reach TC', () => {
  const r = runAdvisorSim(tcEvening());
  expect(r.total).toBe(55);
  expect(r.steward).toBe(18);
  expect(r.resolved).toBe(30);
  expect(r.recommended).toBe(7);
  expect(r.reachTcPer30m).toBeLessThanOrEqual(10);
  expect(r.reachOp).toBe(7);
});
