/**
 * SIM — HAND-RESOLVE-CROSSTALK (CEO 11-27 P0). Tonight TC's «✋ RESOLVED» replies carried answers addressed to OTHER hands
 * (#186198 to TC-H-CX-5: «owner TC-H-CX-5 · by … · owner TC-H-POOL-1 · by … · <POOL-1's answer> · (TC-ADV · precedent
 * tc-186177)»): the advisor learned TC's whole resolve body for POOL-1 as a precedent and re-sent it to the next hand.
 * Seeds 1–5 vary the hands and how many ✋ reuse the precedent. Expect: every reply names only its own hand as owner,
 * carries no other hand's seat, owner or deadline, and still carries the answer.
 */
import { afterAll, afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../../msg/msg-store.js';
import { applyHandOutcome, buildFederationLadder } from '../../msg/hand-raise-ladder.js';
import { adviseTick, answerOfResolve, learnFromCoordinator, readPrecedents } from './advisor.js';

const root = mkdtempSync(join(tmpdir(), 'advisor-crosstalk-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { setSystemTime(); });
const T0 = Date.parse('2026-11-26T14:30:00.000Z');
const HANDS = ['TC-H-POOL-1', 'TC-H-CX-5', 'TC-H-CX-2', 'MOB-1', 'TC-H-POOL-2', 'TC-H-CX-7'];

describe('SIM advisor precedent crosstalk — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: a learned precedent never carries the first hand's owner/deadline/seat to the next hands`, () => {
      let a = seed; const r = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; };
      const ladder = buildFederationLadder({ spaces: [{ coordinator: 'TC', seats: ['TC', 'TC-ADV', ...HANDS] }, { coordinator: 'OP', seats: ['OP'] }] });
      const store = new MsgStore(join(root, `s${seed}.db`));
      let now = T0; setSystemTime(new Date(now));
      const base = { ladder, now: () => now, raiseDecision: () => {} };
      const deps = { ...base, advisor: 'TC-ADV', coordinator: 'TC', precedentsPath: join(root, `p${seed}.jsonl`), eventsPath: join(root, `e${seed}.jsonl`), live: true };
      const raise = (seat: string, i: number) => store.append({ from: seat, to: 'TC', kind: 'request', intent: 'decision', body: `[✋ NEED HUMAN · ${seat}] writer check blocked`,
        refs: [`block:b-${seat}-${i}`, `seat:${seat}`, 'reason:writer'] });
      // TC answers the first hand itself (owner ⊕ deadline, its own words naming that hand).
      const first = HANDS[Math.floor(r() * HANDS.length)]!;
      const h0 = raise(first, 0);
      applyHandOutcome(store, { msgId: h0.id, action: 'resolve', owner: first, deadline: new Date(T0 + 30 * 60_000).toISOString(),
        text: `#40134 기존 수행선에서 ${first} 가 조율자 식별 정본을 대조하고 칸에 기록하세요.`, actor: 'TC' }, base);
      now += 60_000; setSystemTime(new Date(now));
      expect(learnFromCoordinator(store, deps, T0 - 60_000).length).toBe(1);
      const p = readPrecedents(deps.precedentsPath)[0]!;
      expect(p.answer).toBe('#40134 기존 수행선에서 {seat} 가 조율자 식별 정본을 대조하고 칸에 기록하세요.');
      // Other hands raise the same cause; the advisor answers each from the precedent.
      const others = HANDS.filter(h => h !== first).slice(0, 2 + Math.floor(r() * 3));
      const ids = others.map((h, i) => ({ seat: h, id: raise(h, i + 1).id }));
      now += 60_000; setSystemTime(new Date(now));
      adviseTick(store, deps);
      const replies = store.listCreatedBetween(new Date(T0).toISOString(), new Date(now + 1000).toISOString()).filter(m => m.from === 'TC' && (m.refs ?? []).includes('hand-outcome:resolve'));
      for (const { seat, id } of ids) {
        const reply = replies.find(m => (m.refs ?? []).includes(`hand-msg:${id}`))!;
        expect(reply).toBeDefined();
        expect(reply.body).toContain(`${seat} 가 조율자 식별 정본`);
        expect(reply.body.includes(first)).toBe(false); // no other hand's seat, owner or deadline
        expect(reply.body.match(/owner \S+/gu)?.length ?? 0).toBeLessThanOrEqual(1);
      }
      store.close();
    });
  }
  test('an old precedent that still holds a whole body is sanitized when applied', () => {
    expect(answerOfResolve('[✋ RESOLVED · TC] owner TC-H-CX-5 · by 2026-11-26T15:22:08.491Z · owner TC-H-POOL-1 · by 2026-11-26T15:19:37.704Z · do X · next: TC-H-CX-5 continues · (TC-ADV · precedent tc-186177)'))
      .toBe('do X');
    expect(answerOfResolve('owner TC-H-POOL-1 · by 2026-11-26T15:19:37.704Z · do Y for TC-H-POOL-1', 'TC-H-POOL-1')).toBe('do Y for {seat}');
  });
});
