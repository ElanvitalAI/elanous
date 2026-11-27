import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addHold, expireDue, readHolds } from '../hold-ledger/hold-ledger.js';
import { voiceOnce, wakeButler } from './agent.js';
import { judgeButlerVoiceAdapter, parseLoopVoiceInput, speakerOf } from './voice-channel.js';
import type { ButlerPorts, ButlerView } from './body.js';
import { loadCards } from './cards.js';
import { judgeCell, type CellIn, type PrFacts } from './done-when.js';
import { butlerTarget } from './live.js';
import { fileMemory } from './memory.js';
import { buildVoicePrompt, parseVoice, type VoiceInbox, type VoiceLlm, type VoiceMessage } from './voice.js';

// Deterministic fake LLM: answers as the butler from the facts in the prompt, picks actions by what the message asks.
const fakeLlm = (log: Array<{ system: string; user: string }>): VoiceLlm => ({
  async complete(system, user) {
    log.push({ system, user });
    const said = user.slice(user.lastIndexOf('## 받은 말'));
    const cell = /\b(V-\d)\b/u.exec(said)?.[1];
    if (/서명/u.test(said) && cell) return { model: 'fake', text: JSON.stringify({ reply: `${cell} 서명을 시도한다.`, actions: [{ cmd: 'sign', cell }] }) };
    if (/왜/u.test(said) && cell) return { model: 'fake', text: `생각: …\n${JSON.stringify({ reply: `${cell} 는 완료 조건이 빠져 있어 초록이 아니다.`, actions: [{ cmd: 'explain', cell }] })}` };
    if (/해제/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: 'HOLD 해제는 주인·JUD 몫이라 내 권한 밖이다. JUD 로 올린다.', actions: [{ cmd: 'escalate', to: 'JUD', why: 'H-1 해제 요청' }] }) };
    if (/rm -rf/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '셸은 실행하지 않는다.', actions: [{ cmd: 'shell', run: 'rm -rf /' }] }) };
    if (/강등/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '수준을 L1 로 내린다.', actions: [{ cmd: 'demote', to: 'L1' }] }) };
    return { model: 'fake', text: '{"reply":"알겠다.","actions":[]}' };
  },
});

function world() {
  const root = mkdtempSync(join(tmpdir(), 'butler-voice-'));
  const now = new Date('2026-11-27T01:00:00.000Z');
  const h = 'c'.repeat(40);
  const e4 = (id: string) => `E4 test 층 — runId r-${id} · event: checklist.evidence.run · 2026-11-27T00:50:00Z · host minim5 · 칸 ${id} · 명령: bun test x · rc 0 (evidence run · synthetic/test)`;
  const cells = new Map<string, CellIn & { status: string; evidence: string }>([
    ['V-1', { id: 'V-1', title: 'V-1', status: 'yellow', owner: 'TC-H-1', evidence: '#40501 merged', updatedAt: '2026-11-27T00:10:00.000Z', updatedBy: 'TC' }], // missing receipt (and no E4)
    ['V-2', { id: 'V-2', title: 'V-2', status: 'yellow', owner: 'TC-H-2', evidence: `#40502 merged\n${e4('V-2')}`, updatedAt: '2026-11-27T00:10:00.000Z', updatedBy: 'TC' }], // eligible but signed by body first
    ['V-3', { id: 'V-3', title: 'V-3', status: 'yellow', owner: 'TC-H-3', evidence: `#40503 merged\n${e4('V-3')}`, updatedAt: '2026-11-27T00:10:00.000Z', updatedBy: 'TC' }], // security
  ]);
  const facts = new Map<number, PrFacts>([
    [40501, { pr: 40501, merged: true, landedHead: h, receipt: null, files: ['src/a.ts'], securityFindings: [] }],
    [40502, { pr: 40502, merged: true, landedHead: h, receipt: { head: h, dir: 'PREGATE-GREEN/40502-cccccccccccc-minim5', focusedFiles: 1, focused: { pass: 4, fail: 0 } }, files: ['src/b.ts'], securityFindings: [] }],
    [40503, { pr: 40503, merged: true, landedHead: h, receipt: { head: h, dir: 'PREGATE-GREEN/40503-cccccccccccc-minim5', focusedFiles: 1, focused: { pass: 4, fail: 0 } }, files: ['src/secret/vault.ts'], securityFindings: [] }],
  ]);
  addHold(root, { owner: 'TC', cells: ['*'], reason: '격리 입증 전', unlock: 'TC go', by: 'TC' }, { now: new Date(now.getTime() - 60_000), fact: null });
  const posts: Array<{ key: string; to: string; body: string }> = [];
  const memory = fileMemory(root);
  const ports: ButlerPorts = {
    memory, merged: new Set([40501, 40502, 40503]),
    sign(id, evidence, _e, a) { const c = cells.get(id)!; Object.assign(c, { status: 'green', evidence, updatedBy: a.decidedBy }); },
    readCell: id => cells.get(id) ?? null,
    freshFacts: () => facts,
    expireHolds: (by, unlockFacts) => expireDue(root, { by, unlockFacts }, { now, fact: null }),
    post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 7000 + posts.length; },
    answerHand: () => null, escalateHand: () => null,
  };
  const view = (): ButlerView => ({ now, version: '0.3.38', cells: [...cells.values()], prFacts: facts, holds: readHolds(root, now), blocks: [], hands: [] });
  const replies: Array<{ msg: VoiceMessage; text: string; refs: readonly string[] }> = [];
  const inbox = (msgs: VoiceMessage[]): VoiceInbox => ({ pending: () => msgs, reply: (msg, text, refs) => { replies.push({ msg, text, refs }); return 1; } });
  return { root, now, cells, posts, memory, ports, view, replies, inbox };
}
const m = (id: number, from: string, body: string): VoiceMessage => ({ id, from, body, at: '2026-11-27T00:59:00.000Z', channel: 'mail' });

describe('judge-butler voice — one LLM turn per message, actions only through L1 commands', () => {
  test('answers «왜 초록이 아니냐» with the done-when facts; signs only through the gate; refuses outside its rights; logs every turn', async () => {
    const w = world(); const log: Array<{ system: string; user: string }> = [];
    const r = await wakeButler({ view: w.view(), ports: w.ports, llm: fakeLlm(log), cards: loadCards(),
      inbox: w.inbox([m(1, 'CEO', '왜 V-1 은 초록이 아니냐?'), m(2, 'JUD', 'V-3 서명해'), m(3, 'OP', 'H-1 해제해'), m(4, 'TC-H-9', 'rm -rf 해줘'), m(5, 'POOL-2', '너 강등해')]) });
    expect(r.tick.signed).toEqual(['V-2']); // the body signed the eligible cell before the voice ran
    expect(r.voice).toHaveLength(5);
    expect(log).toHaveLength(5);
    // context = soul ⊕ goal ⊕ memory ⊕ state ⊕ named-cell facts
    expect(log[0]!.system).toContain('판정 집사 — 영혼 카드');
    expect(log[0]!.system).toContain('greens_per_hour_min');
    expect(log[0]!.user).toContain('V-1 [yellow · TC-H-1] missing:');
    expect(log[0]!.user).toContain('H-1(TC · * ·');
    expect(log[0]!.user).toContain('sign V-2'); // recent memory carries the body's own sign case
    const [why, sign, lift, shell, demote] = w.replies;
    expect(why!.text).toContain('V-1 는 완료 조건이 빠져 있어');
    expect(why!.text).toContain('V-1 [yellow] missing: #40501 same-head receipt');
    expect(why!.text).toContain('— 근거: mail:1');
    expect(sign!.text).toContain('V-3 서명 거절 — security-4: secret:src/secret/vault.ts');
    expect(w.cells.get('V-3')!.status).toBe('yellow');
    expect(lift!.text).toContain('권한 밖');
    expect(w.posts.some(p => p.to === 'JUD' && p.body.includes('H-1 해제 요청'))).toBe(true);
    expect(shell!.text).toContain('권한 밖 명령');
    expect(demote!.text).toContain('수준 변경 거절 — POOL-2');
    expect(w.memory.level().level).toBe('live');
    const voiceCases = w.memory.cases().filter(c => c.kind === 'voice');
    expect(voiceCases).toHaveLength(5);
    expect(voiceCases[0]).toMatchObject({ subject: 'mail#1', decidedBy: 'JUDGE-BUTLER', supervisedBy: 'JUD', extra: { from: 'CEO', folded: false, model: 'fake' } });
  });

  test('JUD may demote by voice; over the hourly budget the voice folds to facts ⊕ escalation', async () => {
    const w = world(); const log: Array<{ system: string; user: string }> = [];
    const cards = loadCards(); cards.goal.voice.per_hour_max = 2;
    await wakeButler({ view: w.view(), ports: w.ports, llm: fakeLlm(log), cards,
      inbox: w.inbox([m(11, 'OP', '왜 V-1 은 초록이 아니냐?'), m(12, 'JUD', '강등해'), m(13, 'TC', '왜 V-1 은?')]) });
    expect(log).toHaveLength(2);
    expect(w.memory.level().level).toBe('L1');
    const folded = w.replies[2]!.text;
    expect(folded).toStartWith('[판정 집사 · 목소리 접힘: 수준 L1]'); // demoted → voice off even before the budget
    expect(folded).toContain('V-1 [yellow · TC-H-1] missing:');
    expect(w.posts.some(p => p.to === 'JUD' && p.key === 'voice-esc:mail:13:JUD')).toBe(true);
  });

  test('budget fold at live level, and no LLM = fold (never silent)', async () => {
    const w = world(); const log: Array<{ system: string; user: string }> = [];
    const cards = loadCards(); cards.goal.voice.per_hour_max = 1;
    await wakeButler({ view: w.view(), ports: w.ports, llm: fakeLlm(log), cards, inbox: w.inbox([m(21, 'OP', '왜 V-1?'), m(22, 'OP', '왜 V-1?')]) });
    expect(log).toHaveLength(1);
    expect(w.replies[1]!.text).toStartWith('[판정 집사 · 목소리 접힘: 예산 초과(1/h)]');
    const w2 = world();
    await wakeButler({ view: w2.view(), ports: w2.ports, llm: null, cards, inbox: w2.inbox([m(31, 'CEO', '말할 수 있나?')]) });
    expect(w2.replies[0]!.text).toStartWith('[판정 집사 · 목소리 접힘: LLM 없음]');
  });

  test('prompt/parse units', () => {
    expect(parseVoice('noise {"reply":"ok","actions":[{"cmd":"explain","cell":"A"},{"x":1}]} tail')).toEqual({ reply: 'ok', actions: [{ cmd: 'explain', cell: 'A' }] });
    expect(parseVoice('그냥 말')).toEqual({ reply: '그냥 말', actions: [] });
    const p = buildVoicePrompt({ soulText: 'S', goalText: 'G', msg: m(1, 'CEO', 'H-9 은?'), cases: [], lessons: [],
      state: { now: new Date('2026-11-27T01:00:00Z'), level: 'live', cells: [], verdicts: new Map(), holds: [], frozenHands: 0, judgeQueue: { count: 0, medianWaitMin: null } } });
    expect(p.user).toContain('보낸 이 CEO');
    expect(p.system).toContain('{"cmd":"sign","cell":"<칸>"}');
  });
});

describe('els channel loop-voice contract (PR #40331) — {loop,from,channel,text,refs,messageId} → {text,evidence[],actions[]}', () => {
  test('in-process adapter on the same core: actions already ran through L1 (sign gate + verify); evidence/actions fit the channel ref grammar', async () => {
    const w = world(); const log: Array<{ system: string; user: string }> = [];
    const cards = loadCards();
    const adapter = judgeButlerVoiceAdapter(msg => voiceOnce({ view: w.view(), ports: w.ports, llm: fakeLlm(log), cards }, msg), () => w.now);
    const line = JSON.stringify({ loop: 'judge-butler', from: { role: 'pane', pane: 'w1:p2', seat: 'JUD' }, channel: 'judge', text: 'V-2 서명해', refs: ['cell:V-2'], messageId: 'm-1' });
    const reply = await adapter(parseLoopVoiceInput(line));
    expect(reply.text).toContain('V-2 초록 서명');
    expect(reply.actions).toEqual(['sign:V-2']);
    expect(reply.evidence).toContain('els:judge:m-1');
    expect(reply.evidence).toContain('cell:V-2');
    for (const r of reply.evidence) expect(r).toMatch(/^[A-Za-z0-9._:/#@+-]{1,200}$/);
    for (const a of reply.actions) expect(a).toMatch(/^[A-Za-z0-9._:=-]{1,120}$/);
    expect(w.cells.get('V-2')!.status).toBe('green'); // executed by the body, not by the channel
    expect(log[0]!.user).toContain('els:judge #m-1 · 보낸 이 JUD');
    // a refused sign is reported as an action token, and nothing changes
    const refused = await adapter(parseLoopVoiceInput(JSON.stringify({ loop: 'judge-butler', from: { role: 'human' }, channel: 'judge', text: 'V-3 서명해', refs: [], messageId: 'm-2' })));
    expect(refused.actions).toEqual(['sign-refused:V-3']);
    expect(w.cells.get('V-3')!.status).toBe('yellow');
    // killed → answers, acts on nothing
    w.memory.setLevel('off', 'JUD', 'drill', w.now);
    const off = await adapter(parseLoopVoiceInput(JSON.stringify({ loop: 'judge-butler', from: { role: 'pane', seat: 'OP' }, channel: 'judge', text: 'V-1 서명해', refs: [], messageId: 'm-3' })));
    expect(off).toMatchObject({ actions: [], text: expect.stringContaining('[판정 집사 · off') });
    expect(log).toHaveLength(2);
  });

  test('input parsing: wrong loop refused · speaker from seat/pane/role', () => {
    expect(() => parseLoopVoiceInput(JSON.stringify({ loop: 'guardian', from: { role: 'pane' }, channel: 'c', text: 't', refs: [], messageId: 'x' }))).toThrow('not loop:guardian');
    expect(() => parseLoopVoiceInput('{"loop":"judge-butler"}')).toThrow('needs');
    expect(speakerOf({ role: 'loop', seat: 'loop:land' })).toBe('LAND');
    expect(speakerOf({ role: 'pane', pane: 'w1:p2' })).toBe('W1:P2');
    expect(speakerOf({ role: 'human' })).toBe('HUMAN');
  });
});

describe('SAFETY (Terra r1) — re-read and re-judge right before signing; answer a ✋ only after the sign is confirmed', () => {
  test('evidence changed after the observation (security-4 file now in the PR) → body refuses, ✋ escalates to JUD, nothing says «서명했다»', async () => {
    const w = world();
    const fresh = new Map(w.view().prFacts);
    fresh.set(40502, { ...fresh.get(40502)!, files: ['src/secret/vault.ts'] });
    const answered: string[] = []; const escalated: string[] = [];
    const ports = { ...w.ports, freshFacts: () => fresh,
      answerHand: (h: { id: number }, text: string) => { answered.push(`${h.id}:${text}`); return 1; },
      escalateHand: (h: { id: number }, _to: string, text: string) => { escalated.push(`${h.id}:${text}`); return 2; } };
    const hand = { id: 900, rootId: 900, sender: 'TC-H-2', receiver: 'JUD', blockedSeat: 'TC-H-2', cell: 'V-2', reason: 'judge', refs: ['block:V-2'], createdAtMs: w.now.getTime(), body: '✋ V-2?' };
    const r = await wakeButler({ view: { ...w.view(), hands: [hand] }, ports, cards: loadCards() });
    expect(r.tick.signed).toEqual([]);
    expect(r.tick.signRefused[0]).toMatchObject({ cell: 'V-2', why: expect.stringContaining('re-judge: security') });
    expect(w.cells.get('V-2')!.status).toBe('yellow');
    expect(answered).toEqual([]);
    expect(escalated).toEqual([expect.stringContaining('V-2 서명 실패')]);
    expect(w.posts.some(p => p.key === 'security:V-2' && p.to === 'JUD')).toBe(true);
  });

  test('a confirmed sign answers the ✋ with «서명했다»', async () => {
    const w = world(); const answered: string[] = [];
    const ports = { ...w.ports, answerHand: (h: { id: number }, text: string) => { answered.push(`${h.id}:${text}`); return 1; } };
    const hand = { id: 901, rootId: 901, sender: 'TC-H-2', receiver: 'JUD', blockedSeat: 'TC-H-2', cell: 'V-2', reason: 'judge', refs: ['block:V-2'], createdAtMs: w.now.getTime(), body: '✋ V-2?' };
    const r = await wakeButler({ view: { ...w.view(), hands: [hand] }, ports, cards: loadCards() });
    expect(r.tick.signed).toEqual(['V-2']);
    expect(answered).toEqual([expect.stringContaining('901:V-2 는 완료 조건을 채워 판정 집사가 초록으로 서명했다')]);
  });

  test('voice sign re-judges on fresh facts too (a stale «sign» verdict cannot sign)', async () => {
    const w = world(); const log: Array<{ system: string; user: string }> = [];
    const fresh = new Map(w.view().prFacts); fresh.set(40502, { ...fresh.get(40502)!, receipt: null });
    const ports = { ...w.ports, freshFacts: () => fresh };
    const reply = await voiceOnce({ view: w.view(), ports, llm: fakeLlm(log), cards: loadCards() }, m(50, 'JUD', 'V-2 서명해'));
    expect(reply.actions).toEqual(['sign-refused:V-2']);
    expect(reply.reply).toContain('V-2 서명 거절 — #40502 same-head receipt');
    expect(w.cells.get('V-2')!.status).toBe('yellow');
  });
});

describe('BUTLER-RESCAN — escalations re-judged when the rules change (or after 30 min)', () => {
  test('rules changed: an escalated cell now signable is signed and the escalation withdrawn; a not-yet-green one is withdrawn with what is missing; a real security-4 stays', async () => {
    const w = world();
    const s0 = w.memory.readState();
    s0.sent = { 'security:V-2': '2026-11-27T00:55:00.000Z', 'security:V-1': '2026-11-27T00:55:00.000Z', 'security:V-3': '2026-11-27T00:55:00.000Z' };
    w.memory.writeState(s0); // no rulesVersion = escalated under the old rules
    w.memory.appendCase({ at: '2026-11-27T00:55:00.000Z', kind: 'escalate-cell', subject: 'V-2', why: 'security-4: remote-exec:src/x-pty.test.ts', refs: ['msg:187532'], decidedBy: 'JUDGE-BUTLER', supervisedBy: 'JUD' });
    const r = await wakeButler({ view: w.view(), ports: w.ports, cards: loadCards() });
    expect(r.tick.signed).toEqual(['V-2']);
    const notes = w.posts.filter(p => p.key.startsWith('withdraw:'));
    expect(notes.map(p => p.key.split(':')[1]).sort()).toEqual(['V-1', 'V-2']);
    expect(notes.find(p => p.key.includes(':V-2:'))!.body).toContain('보안 4종 올림 #187532 철회 → V-2 서명 완료');
    expect(notes.find(p => p.key.includes(':V-1:'))!.body).toContain('아직 초록 아님: #40501 same-head receipt');
    const s1 = w.memory.readState();
    expect(Object.keys(s1.sent).filter(k => k.startsWith('security:'))).toEqual(['security:V-3']);
    expect(s1.rulesVersion).toMatch(/^[0-9a-f]{12}$/);
    // same rules, fresh escalation (< 30 min) → no rescan noise
    const again = await wakeButler({ view: w.view(), ports: w.ports, cards: loadCards() });
    expect(again.tick.signed).toEqual([]);
    expect(w.posts.filter(p => p.key.startsWith('withdraw:'))).toHaveLength(2);
  });
});

describe('BUTLER-E4-AUTORUN ⊕ TARGET-VERSION', () => {
  const e4line = (id: string) => `E4 test 층 — runId auto-${id} · event: checklist.evidence.run · 2026-11-27T01:00:00Z · host minim5 · 칸 ${id} · 명령: bun test x · rc 0 (evidence run · synthetic/test)`;
  test('GREEN-DEFINITION-ONE: receipt + focused exit 0 signs without E4; the evidence command runs first (≤3 per tick, never blocks); no E4 → one FU cell', async () => {
    const w = world();
    const h = 'c'.repeat(40);
    const facts = w.view().prFacts as Map<number, PrFacts>;
    for (let i = 4; i <= 8; i++) {
      const id = `V-${i}`; const pr = 40500 + i;
      const title = i <= 7 ? `${id}\n- 완료 경계 증거 명령: bun test src/x-${i}.test.ts` : id; // V-8 has no evidence command
      w.cells.set(id, { id, title, status: 'yellow', owner: 'TC-H-4', evidence: `#${pr} merged`, updatedAt: '2026-11-27T00:10:00.000Z', updatedBy: 'TC' });
      facts.set(pr, { pr, merged: true, landedHead: h, receipt: { head: h, dir: `PREGATE-GREEN/${pr}-cccccccccccc-minim5`, focusedFiles: 1, focused: { pass: 3, fail: 0 } }, files: [`src/x-${i}.ts`], securityFindings: [] });
      (w.ports.merged as Set<number>).add(pr);
    }
    const runs: string[] = []; const fu: string[] = [];
    const ports = { ...w.ports,
      runEvidence: (cell: string, version: string) => {
        runs.push(`${cell}@${version}`);
        if (cell === 'V-5') return { rc: 1, out: 'focused 1 fail' };
        const c = w.cells.get(cell)!; c.evidence = `${c.evidence}\n${e4line(cell)}`; return { rc: 0, out: 'rc 0' };
      },
      addFollowUp: (id: string, title: string) => { fu.push(`${id}|${title.includes('run failed') ? 'failed' : 'not-run'}`); return true; } };
    const r = await wakeButler({ view: w.view(), ports, cards: loadCards() });
    expect(runs).toEqual(['V-4@0.3.38', 'V-5@0.3.38', 'V-6@0.3.38']); // ≤3 per tick, the target version
    expect(r.tick.signed.sort()).toEqual(['V-2', 'V-4', 'V-5', 'V-6', 'V-7', 'V-8']); // rc 1 and «no command» sign anyway
    expect(r.tick.e4).toEqual({ tried: 3, ok: 2, fail: 1, fu: 3, noCommand: 1, cooldown: 0, cap: 1 });
    expect(fu.sort()).toEqual(['V-5-E4|failed', 'V-7-E4|not-run', 'V-8-E4|not-run']); // BUTLER-E4-FU-UNOWNED: no owner argument at all
  });

  test('a view that is not the target release acts on nothing (no sign, no run) and says why once', async () => {
    const w = world(); const runs: string[] = [];
    const r = await wakeButler({ view: { ...w.view(), version: '0.3.37', actable: false, targetWhy: '0.3.37 is already published' }, ports: { ...w.ports, runEvidence: (c: string) => { runs.push(c); return { rc: 0, out: '' }; } }, cards: loadCards() });
    expect(r.tick.signed).toEqual([]); expect(r.tick.planned).toBe(0); expect(runs).toEqual([]);
    expect(w.cells.get('V-2')!.status).toBe('yellow');
    expect(w.memory.cases().filter(c => c.kind === 'off-target')).toHaveLength(1);
    const voice = await voiceOnce({ view: { ...w.view(), version: '0.3.37', actable: false, targetWhy: 'published' }, ports: w.ports, llm: fakeLlm([]), cards: loadCards() }, m(70, 'JUD', 'V-2 서명해'));
    expect(voice.actions).toEqual(['sign-refused:V-2']);
  });

  test('butlerTarget: stale plan «current = 0.3.37» loses to release.graph.version 0.3.38; unset graph or a published target → not actable', () => {
    const hq = mkdtempSync(join(tmpdir(), 'butler-target-'));
    mkdirSync(join(hq, 'seat-state', 'OP', 'plans'), { recursive: true });
    writeFileSync(join(hq, 'seat-state', 'OP', 'plans', 'PLAN-0.3.37.md'), '---\nstatus: current\n---\n# PLAN-0.3.37 — old\n');
    const ledger = mkdtempSync(join(tmpdir(), 'butler-ledger-'));
    expect(butlerTarget({ hqRoot: hq, ledgerRoot: ledger, readRaw: () => ({ release: { graph: { version: '0.3.38' } } }) })).toMatchObject({ version: '0.3.38', source: 'graph', actable: true });
    expect(butlerTarget({ hqRoot: hq, ledgerRoot: ledger, readRaw: () => ({}) })).toMatchObject({ version: '0.3.37', source: 'plan', actable: false });
    mkdirSync(join(ledger, 'release', '0.3.38'), { recursive: true });
    writeFileSync(join(ledger, 'release', '0.3.38', 'release.json'), JSON.stringify({ version: '0.3.38', publishedAt: '2026-11-28T06:00:00Z' }));
    expect(butlerTarget({ hqRoot: hq, ledgerRoot: ledger, readRaw: () => ({ release: { graph: { version: '0.3.38' } } }) })).toMatchObject({ version: '0.3.38', actable: false, why: '0.3.38 is already published' });
  });
});

describe('BUTLER-RESPECT-VETO — a revert after the butler signed is a veto (any actor), lifted only by new evidence', () => {
  test('revert by «cli» → lesson, 0 re-signs on later ticks; a new PR head + receipt lifts it; a registered HOLD blocks the sign', async () => {
    const w = world();
    expect((await wakeButler({ view: w.view(), ports: w.ports, cards: loadCards() })).tick.signed).toEqual(['V-2']);
    Object.assign(w.cells.get('V-2')!, { status: 'yellow', updatedBy: 'cli' }); // JUD's revert, as it arrived live
    for (let i = 0; i < 3; i++) expect((await wakeButler({ view: w.view(), ports: w.ports, cards: loadCards() })).tick.signed).toEqual([]);
    expect(w.memory.lessons().map(l => l.cell)).toEqual(['V-2']);
    expect(w.memory.cases().filter(c => c.kind === 'sign' && c.subject === 'V-2')).toHaveLength(1); // greens/h counts it once
    // new evidence: the PR landed a new head with its own same-head receipt → the veto lifts
    const facts = w.view().prFacts as Map<number, PrFacts>; const h2 = 'd'.repeat(40);
    facts.set(40502, { ...facts.get(40502)!, landedHead: h2, receipt: { head: h2, dir: 'PREGATE-GREEN/40502-dddddddddddd-minim5', focusedFiles: 1, focused: { pass: 5, fail: 0 } } });
    const ports = { ...w.ports, freshFacts: () => facts };
    expect((await wakeButler({ view: w.view(), ports, cards: loadCards() })).tick.signed).toEqual(['V-2']);
    expect(w.memory.readState().reversed).toEqual({});
  });

  test('a cell covered by a registered HOLD is not signed (body and voice)', async () => {
    const w = world();
    addHold(w.root, { owner: 'JUD', cells: ['V-2'], reason: '기존 부분 판정과 충돌', unlock: 'JUD lifts', by: 'JUD' }, { now: new Date(w.now.getTime() - 60_000), fact: null });
    expect((await wakeButler({ view: w.view(), ports: w.ports, cards: loadCards() })).tick.signed).toEqual([]);
    const v = await voiceOnce({ view: w.view(), ports: w.ports, llm: fakeLlm([]), cards: loadCards() }, m(80, 'OP', 'V-2 서명해'));
    expect(v.reply).toContain('V-2 서명 거절 — 등록된 HOLD 가 덮고 있다');
    expect(w.cells.get('V-2')!.status).toBe('yellow');
  });
});

// JUDGE-BUTLER-E4-RESIGN-SCOPE ⊕ BUTLER-E4-FU-UNOWNED — replays the 11-27 09:4x conflict (CX3-LAND-VERSION-REVERT-E4-E4 ·
// FED-FACT-OP-ACTIONS-E4-E4): JUD judged the E4 child yellow, the butler re-signed it on the parent's focused-only receipt.
// Expected values are literals from the two cells' raw history (test-expect-independent).
describe('JUDGE-BUTLER-E4-RESIGN-SCOPE — a parent focused receipt never signs an independent E4 child', () => {
  const parentHead = '5d237548c458'.padEnd(40, '0');
  const e4run = (id: string) => `E4 sim 층 — runId fed-org-s1 · event: checklist.evidence.run · 2026-11-27T10:00:00Z · host node-b · 칸 ${id} · 명령: bun bin/elanous.mjs --test sim world run fed-org --seed 1 · rc 0`;
  const child = (id: string, evidence: string, updatedBy = 'cli', updatedAt = '2026-11-27T09:30:00.000Z') =>
    ({ id, title: `${id.replace(/-E4$/u, '')} — E4 sim/test-universe evidence`, status: 'yellow', owner: 'OP', evidence, updatedAt, updatedBy });
  const parentFacts = (w: ReturnType<typeof world>) => {
    const facts = w.view().prFacts as Map<number, PrFacts>;
    facts.set(40445, { pr: 40445, merged: true, landedHead: parentHead, receipt: { head: parentHead, dir: 'PREGATE-GREEN/40445-5d237548c458-minim5', focusedFiles: 6, focused: { pass: 51, fail: 0 } }, files: ['src/fed-state/actions.ts'], securityFindings: [] });
    facts.set(40463, { pr: 40463, merged: true, landedHead: 'cd0d3495ec59'.padEnd(40, '0'), receipt: { head: 'cd0d3495ec59'.padEnd(40, '0'), dir: 'PREGATE-GREEN/40463-cd0d3495ec59-node-b', focusedFiles: 1, focused: { pass: 6, fail: 0 } }, files: ['src/cli/pr-land-scope-revert-guard.test.ts'], securityFindings: [] });
    (w.ports.merged as Set<number>).add(40445); (w.ports.merged as Set<number>).add(40463);
  };

  test('judgeCell: an «-E4» cell citing only the parent PR is missing its own E4 run; with the run it signs; a non-E4 cell is unchanged', () => {
    const w = world(); parentFacts(w);
    const facts = w.view().prFacts;
    const bare = judgeCell(child('FED-FACT-OP-ACTIONS-E4-E4', 'JUD #195542: 부모 #40445 focused 51/0 은 E4 실행 근거가 아님'), facts);
    expect(bare.kind).toBe('missing');
    expect(bare.why).toContain('a parent PR\'s focused receipt is not E4 evidence');
    const run = judgeCell(child('FED-FACT-OP-ACTIONS-E4-E4', `#40445 merged\n${e4run('FED-FACT-OP-ACTIONS-E4-E4')}`), facts);
    expect(run).toMatchObject({ kind: 'sign', e4: 'fed-org-s1' });
    // no PR cited: the E4 cell closes on its own run (existing scene re-run)
    expect(judgeCell(child('CX3-LAND-VERSION-REVERT-E4-E4', e4run('CX3-LAND-VERSION-REVERT-E4-E4')), facts)).toMatchObject({ kind: 'sign', why: 'E4 fed-org-s1 rc 0 (own evidence run · no PR)' });
    // another cell's E4 line is not this cell's
    expect(judgeCell(child('CX3-LAND-VERSION-REVERT-E4-E4', `#40463 merged\n${e4run('CX3-LAND-VERSION-REVERT-E4')}`), facts).kind).toBe('missing');
    // GREEN-DEFINITION-ONE unchanged for ordinary cells: receipt + focused exit 0 signs without E4
    expect(judgeCell({ id: 'FED-FACT-OP-ACTIONS', status: 'yellow', evidence: '#40445 head 5d237548' }, facts)).toMatchObject({ kind: 'sign', e4: null });
  });

  test('the two 11-27 cells stay yellow across ticks (no re-sign, no E4-of-E4 FU); the ordinary parent still signs once with one unowned FU', async () => {
    const w = world(); parentFacts(w);
    w.cells.set('FED-FACT-OP-ACTIONS-E4-E4', child('FED-FACT-OP-ACTIONS-E4-E4', 'JUD #195542/#195728: 부모 #40445@5d237548c458 focused 51/0 및 E4 없음→FU 서명은 실 E4 실행 근거가 아님'));
    w.cells.set('CX3-LAND-VERSION-REVERT-E4-E4', child('CX3-LAND-VERSION-REVERT-E4-E4', 'JUD #195686: #40463@cd0d3495ec59 focused는 PR 전용 시험이며 E4 실행 영수가 아니다'));
    w.cells.set('FED-FACT-OP-ACTIONS', { id: 'FED-FACT-OP-ACTIONS', title: 'FED-FACT-OP-ACTIONS', status: 'yellow', owner: 'OP', evidence: '#40445 head 5d237548', updatedAt: '2026-11-27T00:10:00.000Z', updatedBy: 'OP' });
    const fu: string[] = [];
    const ports = { ...w.ports, addFollowUp: (id: string) => { fu.push(id); return true; } };
    const first = await wakeButler({ view: w.view(), ports, cards: loadCards() });
    expect(first.tick.signed.sort()).toEqual(['FED-FACT-OP-ACTIONS', 'V-2']);
    for (let i = 0; i < 3; i++) expect((await wakeButler({ view: w.view(), ports, cards: loadCards() })).tick.signed).toEqual([]); // same head, repeated ticks
    expect(w.cells.get('FED-FACT-OP-ACTIONS-E4-E4')!.status).toBe('yellow');
    expect(w.cells.get('CX3-LAND-VERSION-REVERT-E4-E4')!.status).toBe('yellow');
    expect(fu).toEqual(['FED-FACT-OP-ACTIONS-E4']); // V-2 carries its E4 line · no «-E4-E4»
  });

  test('an E4 cell signed on its own run never spawns an «-E4-E4» FU', async () => {
    const w = world(); parentFacts(w);
    w.cells.set('FED-FACT-OP-ACTIONS-E4', child('FED-FACT-OP-ACTIONS-E4', `#40445 merged\n${e4run('FED-FACT-OP-ACTIONS-E4')}`, 'TC'));
    const fu: string[] = [];
    const r = await wakeButler({ view: w.view(), ports: { ...w.ports, addFollowUp: (id: string) => { fu.push(id); return true; } }, cards: loadCards() });
    expect(r.tick.signed).toContain('FED-FACT-OP-ACTIONS-E4');
    expect(fu).toEqual([]);
  });

  test('JUD\'s latest write on a yellow cell is an independent verdict: no sign on that evidence; one lesson per write; new evidence lifts it', async () => {
    const w = world();
    Object.assign(w.cells.get('V-2')!, { updatedBy: 'JUD', updatedAt: '2026-11-27T00:40:00.000Z' }); // signable, but JUD judged it yellow
    for (let i = 0; i < 3; i++) expect((await wakeButler({ view: w.view(), ports: w.ports, cards: loadCards() })).tick.signed).toEqual([]);
    expect(w.memory.lessons().map(l => l.cell)).toEqual(['V-2']); // one lesson, not one per tick
    expect(w.memory.cases().filter(c => c.kind === 'sign')).toHaveLength(0);
    // the voice respects it too
    const v = await voiceOnce({ view: w.view(), ports: w.ports, llm: fakeLlm([]), cards: loadCards() }, m(90, 'OP', 'V-2 서명해'));
    expect(v.actions).toEqual(['sign-refused:V-2']);
    // a new landed head with its own same-head receipt → the verdict was on older evidence → sign
    const facts = w.view().prFacts as Map<number, PrFacts>; const h2 = 'e'.repeat(40);
    facts.set(40502, { ...facts.get(40502)!, landedHead: h2, receipt: { head: h2, dir: 'PREGATE-GREEN/40502-eeeeeeeeeeee-minim5', focusedFiles: 1, focused: { pass: 5, fail: 0 } } });
    expect((await wakeButler({ view: w.view(), ports: { ...w.ports, freshFacts: () => facts }, cards: loadCards() })).tick.signed).toEqual(['V-2']);
  });

  test('a JUD write the butler cannot sign anyway leaves no lesson; the butler\'s own write is never a verdict', async () => {
    const w = world();
    Object.assign(w.cells.get('V-1')!, { updatedBy: 'JUD-B', updatedAt: '2026-11-27T00:41:00.000Z' }); // missing receipt → nothing to sign over
    Object.assign(w.cells.get('V-2')!, { updatedBy: 'JUDGE-BUTLER', updatedAt: '2026-11-27T00:42:00.000Z' });
    expect((await wakeButler({ view: w.view(), ports: w.ports, cards: loadCards() })).tick.signed).toEqual(['V-2']);
    expect(w.memory.lessons()).toEqual([]);
  });
});
