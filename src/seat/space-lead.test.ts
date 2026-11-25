// SPACE-LEAD-HUMAN — lead kind (llm | human) · switch default off · ✋ to a human-led space → one decision card ·
// 60-min timer · the decided card executed as the ✋ outcome. Independent literals · real temp mail ledger · fake card port.
import { afterAll, afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDecisionRaise } from '../decisions/decision-ledger.js';
import { parseWorkspaceConfig } from '../els/workspace-config.js';
import { MsgStore, type MessageEnvelope } from '../msg/msg-store.js';
import { buildFederationLadder, readHandMail, sweepHandRaises, type DecidedLeadCard, type HumanLeadPort } from '../msg/hand-raise-ladder.js';
import { humanLeadAction, humanLeadCard, humanLeadMsgId, parseSpaceLead, resolveHumanLeads } from './space-lead.js';

const root = mkdtempSync(join(tmpdir(), 'space-lead-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { setSystemTime(); });
const T0 = Date.parse('2026-11-25T06:00:00.000Z');
const ONE_MINUTE = 60_000;
let n = 0;

describe('lead kind and the switch', () => {
  test('parse: llm · human with who and minutes · errors in English', () => {
    expect(parseSpaceLead({ kind: 'llm' }, 'spaces.mk')).toEqual({ lead: { kind: 'llm' } });
    expect(parseSpaceLead({ kind: 'human', who: 'CEO', escalateAfterMin: 45 }, 'spaces.mk')).toEqual({ lead: { kind: 'human', who: 'CEO', escalateAfterMin: 45 } });
    expect(parseSpaceLead({ kind: 'robot' }, 'spaces.mk')).toEqual({ error: 'spaces.mk.lead.kind must be llm or human' });
    expect(parseSpaceLead({ kind: 'human' }, 'spaces.mk')).toEqual({ error: 'spaces.mk.lead.who must name the person' });
    expect(parseSpaceLead({ kind: 'human', who: 'CEO', escalateAfterMin: 0 }, 'spaces.mk')).toEqual({ error: 'spaces.mk.lead.escalateAfterMin must be 1..1440' });
  });

  test('federation.yaml carries spaces.<name>.lead; a bad lead is a declaration error', () => {
    const ok = parseWorkspaceConfig('version: 1\nseats:\n  OP: {}\n  MK: {}\nspaces:\n  hq: { coordinator: OP }\n  marketing: { coordinator: MK, lead: { kind: human, who: CEO } }\n', '/tmp/w/.elanous/federation.yaml', '/tmp');
    expect(ok.errors).toEqual([]);
    expect(ok.config!.spaces.marketing!.lead).toEqual({ kind: 'human', who: 'CEO' });
    const bad = parseWorkspaceConfig('version: 1\nseats:\n  MK: {}\nspaces:\n  marketing: { coordinator: MK, lead: { kind: boss } }\n', '/tmp/w/.elanous/federation.yaml', '/tmp');
    expect(bad.errors.some((e) => e.includes('spaces.marketing.lead.kind must be llm or human'))).toBe(true);
  });

  test('off by default; on = built-in MK → CEO at 60 min; config and federation.yaml override', () => {
    expect([...resolveHumanLeads({}).entries()]).toEqual([]);
    expect([...resolveHumanLeads({ config: { enabled: 'yes' } }).entries()]).toEqual([]);
    expect([...resolveHumanLeads({ config: { enabled: true } }).values()]).toEqual([{ coordinator: 'MK', who: 'CEO', escalateAfterMs: 3_600_000 }]);
    expect([...resolveHumanLeads({ config: { enabled: true, escalateAfterMin: 30, spaces: { MK: false, UX: { who: 'Designer' } } } }).values()])
      .toEqual([{ coordinator: 'UX', who: 'Designer', escalateAfterMs: 1_800_000 }]);
    expect([...resolveHumanLeads({ config: { enabled: true }, declared: [{ coordinator: 'MK', lead: { kind: 'llm' } }, { coordinator: 'TC', lead: { kind: 'human', who: 'CTO', escalateAfterMin: 90 } }] }).values()])
      .toEqual([{ coordinator: 'TC', who: 'CTO', escalateAfterMs: 5_400_000 }]);
  });

  test('the card is a valid decision raise with resolve / reject / escalate buttons and its source ref', () => {
    const card = humanLeadCard({ lead: { coordinator: 'MK', who: 'CEO', escalateAfterMs: 3_600_000 }, msgId: 912, blockedSeat: 'MK-H-1', reason: 'HUMAN_DECISION',
      body: '[✋ NEED HUMAN · MK-H-1] 홈페이지 히어로 문구 A/B 중 무엇으로 갈지. 오늘 배포 전.' });
    const valid = validateDecisionRaise(card);
    expect(valid.options.map((o) => `${o.key}=${o.label}`)).toEqual(['r=Resolve', 'x=Reject', 'e=Escalate']);
    expect(valid.refs).toEqual(['hand-lead:912', 'seat:MK-H-1']);
    expect(valid.raisedBy).toEqual({ agent: 'steward:MK' });
    expect(valid.scqa.c).toBe('You lead the MK space in person; without an answer in 60 min it climbs to the HQ coordinator');
    expect(humanLeadMsgId(valid.refs)).toBe(912);
    expect([humanLeadAction('r'), humanLeadAction('X'), humanLeadAction('e'), humanLeadAction('z')]).toEqual(['resolve', 'reject', 'escalate', undefined]);
  });
});

describe('✋ to a human-led space', () => {
  const ladder = buildFederationLadder({ hq: 'OP', spaces: [{ coordinator: 'OP', seats: ['OP'] }, { coordinator: 'MK', seats: ['MK', 'MK-H-1'] }] });
  const hand = (block: string): MessageEnvelope => ({
    from: 'MK-H-1', to: 'MK', kind: 'request', intent: 'decision', correlationId: block,
    body: '[✋ NEED HUMAN · MK-H-1] 홈페이지 히어로 문구 A/B 중 무엇으로 갈지',
    refs: [`block:${block}`, 'seat:MK-H-1', `reason:HUMAN_DECISION`],
  });
  function harness() {
    const store = new MsgStore(join(root, `m${++n}.db`));
    const cards: { msgId: number; who: string }[] = [];
    const decided: DecidedLeadCard[] = [];
    const logs: string[] = [];
    const port: HumanLeadPort = {
      leads: new Map([['MK', { coordinator: 'MK', who: 'CEO', escalateAfterMs: 60 * ONE_MINUTE }]]),
      raiseCard: (h, lead) => { const fresh = !cards.some((c) => c.msgId === h.id); if (fresh) cards.push({ msgId: h.id, who: lead.who }); return { decisionId: `D-20261125-0${cards.length}`, fresh }; },
      decided: () => decided,
    };
    setSystemTime(new Date(T0));
    const deps = { ladder, now: () => Date.now(), raiseDecision: () => { logs.push('ceo-card'); }, humanLead: port, log: (e: string) => { logs.push(e); } };
    return { store, cards, decided, logs, deps };
  }

  test('one card per ✋ at once; no climb at 11 min; climbs to OP at 60 min (the lead\'s timer, not 10)', () => {
    const h = harness();
    try {
      const raised = h.store.post(hand('blk-mk-1'));
      const t0 = readHandMail(h.store, raised.id)!.createdAtMs;
      expect(sweepHandRaises(h.store, h.deps)).toEqual([]);
      expect(h.cards).toEqual([{ msgId: raised.id, who: 'CEO' }]);
      setSystemTime(new Date(t0 + 11 * ONE_MINUTE));
      expect(sweepHandRaises(h.store, h.deps)).toEqual([]);
      expect(h.cards.length).toBe(1);
      setSystemTime(new Date(t0 + 60 * ONE_MINUTE));
      const done = sweepHandRaises(h.store, h.deps);
      expect(done.map((d) => [d.msgId, d.from, d.to, d.waitedMin])).toEqual([[raised.id, 'MK', 'OP', 60]]);
      expect(h.logs.filter((e) => e === 'needhuman.human-lead-card').length).toBe(1);
    } finally { h.store.close(); }
  });

  test('the CEO taps Resolve → the blocked seat gets the outcome from MK, once', () => {
    const h = harness();
    try {
      const raised = h.store.post(hand('blk-mk-2'));
      sweepHandRaises(h.store, h.deps);
      h.decided.push({ decisionId: 'D-20261125-07', msgId: raised.id, choice: 'r', note: 'A 안으로 간다', via: 'telegram' });
      sweepHandRaises(h.store, h.deps);
      sweepHandRaises(h.store, h.deps);
      const outcomes = h.store.db.query(`SELECT sender, recipient, body FROM msg_messages WHERE refs_json LIKE '%hand-outcome:resolve%'`).all();
      expect(outcomes).toEqual([{ sender: 'MK', recipient: 'MK-H-1', body: '[✋ RESOLVED · MK] A 안으로 간다 — CEO chose resolve via telegram (decision D-20261125-07)' }]);
      expect(h.logs.filter((e) => e === 'needhuman.human-lead-applied').length).toBe(1);
    } finally { h.store.close(); }
  });

  test('the CEO taps Escalate → it climbs to OP now, not after 60 min', () => {
    const h = harness();
    try {
      const raised = h.store.post(hand('blk-mk-3'));
      sweepHandRaises(h.store, h.deps);
      h.decided.push({ decisionId: 'D-20261125-08', msgId: raised.id, choice: 'e', via: 'pwa' });
      sweepHandRaises(h.store, h.deps);
      const up = h.store.db.query(`SELECT sender, recipient FROM msg_messages WHERE refs_json LIKE ?`).all(`%"hand-escalated-from:${raised.id}"%`);
      expect(up).toEqual([{ sender: 'MK', recipient: 'OP' }]);
    } finally { h.store.close(); }
  });

  test('switch off (no port) = the ordinary 10-minute ladder', () => {
    const h = harness();
    try {
      const raised = h.store.post(hand('blk-mk-4'));
      const t0 = readHandMail(h.store, raised.id)!.createdAtMs;
      setSystemTime(new Date(t0 + 10 * ONE_MINUTE));
      const { humanLead: _off, ...plain } = h.deps;
      expect(sweepHandRaises(h.store, plain).map((d) => d.to)).toEqual(['OP']);
      expect(h.cards).toEqual([]);
    } finally { h.store.close(); }
  });
});
