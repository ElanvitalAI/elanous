// STEWARD-MAIL (shadow) 시험 — 정책 YAML · 구조 판정 · 반복 · Jev 승급 · 그림자 표 · 틱 · CLI · 시뮬.
// 기대값은 독립 리터럴이다(제품 상수·렌더 함수 재사용 0). 실 Jev 호출 0(가짜 decide).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  askStewardJev, classifyStewardMail, findDuplicates, jevPromotes, readStewardMailPolicy, shadowReport, shadowRows, stewardSubject,
  type StewardDecide, type StewardMail,
} from './steward-mail.js';
import { loadStewardMails, stewardMailShadowTick } from './steward-mail-shadow.js';
import { registerStewardShadowCommand } from './steward-mail-cli.js';
import { MsgStore } from '../../msg/msg-store.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const NO_OVERRIDE = '/nonexistent/steward-mail.yaml';
const policy = () => readStewardMailPolicy({ override: NO_OVERRIDE });

let seq = 1000;
const T = Date.parse('2026-11-27T10:00:00.000Z');
function mail(over: Partial<StewardMail> & { min?: number } = {}): StewardMail {
  const { min, ...rest } = over;
  seq += 1;
  return { id: seq, from: 'TC', to: 'OP', createdAt: new Date(T + (min ?? 0) * 60_000).toISOString(), body: `body ${seq}`, kind: 'info', intent: 'info', ...rest };
}
const verdict = (m: StewardMail, dup: number | null = null) => { const d = classifyStewardMail(m, { duplicateOf: dup }, policy()); return `${d.verdict}:${d.reason}${d.askJev ? '?' : ''}`; };

describe('policy YAML', () => {
  test('the built-in file loads without problems', () => {
    const p = policy();
    expect(p.problems).toEqual([]);
    expect([...p.recipients]).toEqual(['OP']);
    expect(p.digestMs).toBe(600_000);
    expect(p.duplicateWindowMs).toBe(1_800_000);
    expect(p.jev.minProbability).toBe(0.7);
  });

  test('an override replaces only the keys it names', () => {
    const dir = tmp('steward-policy-');
    const over = join(dir, 'steward-mail.yaml');
    writeFileSync(over, 'recipients: [OP, TC]\ndigestMinutes: 5\n');
    const p = readStewardMailPolicy({ override: over });
    expect([...p.recipients]).toEqual(['OP', 'TC']);
    expect(p.digestMs).toBe(300_000);
    expect(p.wake.decisionKinds.has('question')).toBe(true);
    expect(p.source).toEqual([join(import.meta.dir, 'steward-mail.yaml'), over]);
  });
});

describe('structured verdict', () => {
  test('wake-now: crown · hand · P0 · decision · HQ reason', () => {
    expect(verdict(mail({ crownDirective: 'ship it' }))).toBe('wake-now:crown');
    expect(verdict(mail({ from: 'CLAUDE-OP', refs: ['lane:proxy'] }))).toBe('wake-now:crown');
    expect(verdict(mail({ fromKind: 'human' }))).toBe('wake-now:crown');
    expect(verdict(mail({ refs: ['block:b1', 'reason:TOOL_DENIED'] }))).toBe('wake-now:hand');
    expect(verdict(mail({ priority: 1 }))).toBe('wake-now:p0');
    expect(verdict(mail({ kind: 'incident' }))).toBe('wake-now:p0');
    expect(verdict(mail({ kind: 'question', intent: 'request' }))).toBe('wake-now:decision');
    expect(verdict(mail({ kind: 'request', intent: 'decision' }))).toBe('wake-now:decision');
    expect(verdict(mail({ kind: 'request', intent: 'request', refs: ['reason:BUDGET'] }))).toBe('wake-now:hq-reason');
  });

  test('record-only: self · repeat · receipts · ledger echo', () => {
    expect(verdict(mail({ from: 'OP', kind: 'coord' }))).toBe('record-only:self');
    expect(verdict(mail({ kind: 'report' }), 1)).toBe('record-only:duplicate');
    expect(verdict(mail({ kind: 'ack' }))).toBe('record-only:ack');
    expect(verdict(mail({ from: 'LAND-GRAPH' }))).toBe('record-only:ledger-fact');
  });

  test('a repeat never silences a wake', () => {
    expect(verdict(mail({ kind: 'question' }), 1)).toBe('wake-now:decision');
    expect(verdict(mail({ refs: ['block:b1', 'reason:HOLD'] }), 1)).toBe('wake-now:hand');
  });

  test('digest: status replies · routine requests · info — and which may ask Jev', () => {
    expect(verdict(mail({ kind: 'status', replyTo: 77, replyToSender: 'OP' }))).toBe('digest:status-reply?');
    expect(verdict(mail({ kind: 'request', intent: 'request', needsAck: true }))).toBe('digest:routine-request?');
    expect(verdict(mail({ kind: 'steward-exception', intent: 'alert' }))).toBe('digest:info?');
    expect(verdict(mail({ kind: '', intent: 'info' }))).toBe('digest:no-kind?');
    expect(verdict(mail({ kind: 'digest' }))).toBe('digest:info');
  });
});

describe('repeats', () => {
  test('subject = pr · cell · block · correlation · bare tag; never a thread or a valued ref', () => {
    expect(stewardSubject(mail({ refs: ['run:x', 'cell:LAND-1'] }))).toBe('cell:land-1');
    expect(stewardSubject(mail({ correlationId: 'k9' }))).toBe('corr:k9');
    expect(stewardSubject(mail({ refs: ['board-steward'] }))).toBe('tag:board-steward');
    expect(stewardSubject(mail({ refs: ['steward:OP', 'run:1'], replyTo: 5 }))).toBe(null);
  });

  test('same body or same subject inside 30 min repeats; the window slides from the first', () => {
    const a = mail({ body: 'RED again', min: 0 });
    const b = mail({ body: 'RED again', min: 10 });
    const c = mail({ refs: ['board-steward'], body: 'x1', min: 0 });
    const d = mail({ refs: ['board-steward'], body: 'x2', min: 20 });
    const e = mail({ refs: ['board-steward'], body: 'x3', min: 31 });
    const f = mail({ replyTo: 9, body: 'first reply', min: 1 });
    const g = mail({ replyTo: 9, body: 'second reply', min: 2 });
    const dups = findDuplicates([a, b, c, d, e, f, g], 30 * 60_000);
    expect([...dups.entries()]).toEqual([[b.id, a.id], [d.id, c.id]]);
  });
});

describe('Jev — promote only', () => {
  test('only `wake` at or above the threshold promotes', () => {
    const p = policy();
    expect(jevPromotes({ type: 'choice', probabilities: { wake: 0.71, digest: 0.29 } }, p)).toEqual({ promote: true, word: 'wake', p: 0.71 });
    expect(jevPromotes({ type: 'choice', probabilities: { wake: 0.68, digest: 0.32 } }, p).promote).toBe(false);
    expect(jevPromotes({ type: 'choice', probabilities: { record: 0.9 } }, p).promote).toBe(false);
    expect(jevPromotes(undefined, p)).toEqual({ promote: false, word: null, p: 0 });
  });

  test('askStewardJev sends the mail as state and survives a failing call', async () => {
    const seen: unknown[] = [];
    const ok: StewardDecide = async (req) => { seen.push(req.state); return { model: 'm', answers: { act: { type: 'choice', probabilities: { wake: 0.9 } } } }; };
    const m = mail({ kind: 'status', body: 'blocked:   waiting on HOLD lift' });
    expect(await askStewardJev(m, policy(), ok)).toEqual({ promote: true, word: 'wake', p: 0.9 });
    expect(seen).toEqual([{ from: 'TC', kind: 'status', intent: 'info', refs: [], body: 'blocked: waiting on HOLD lift' }]);
    expect(await askStewardJev(m, policy(), async () => { throw new Error('down'); })).toBe(null);
  });

  test('a known Jev promotion turns a digest row into wake-now (signal jev); never a structured wake into anything else', () => {
    const a = mail({ kind: 'status', replyTo: 3, replyToSender: 'OP' });
    const b = mail({ kind: 'question' });
    const known = new Map([[a.id, { promote: true, word: 'wake', p: 0.8 }], [b.id, { promote: false, word: 'record', p: 0.9 }]]);
    const rows = shadowRows([a, b], { policy: policy(), jevKnown: known });
    expect(rows.map(r => `${r.verdict}:${r.reason}:${r.signal}`)).toEqual(['wake-now:jev-wake:jev', 'wake-now:decision:structured']);
  });
});

describe('shadow rows and report', () => {
  test('router route, answered flag, agreement and wakes/h', () => {
    const p = policy();
    const rows = shadowRows([
      mail({ kind: 'status', replyTo: 1, replyToSender: 'OP', min: 1, answeredAt: new Date(T + 5 * 60_000).toISOString() }),
      mail({ kind: 'status', replyTo: 2, replyToSender: 'OP', min: 2 }),
      mail({ kind: 'question', min: 3, answeredAt: new Date(T + 10 * 60_000).toISOString() }),
      mail({ kind: 'ack', min: 4 }),
      mail({ kind: 'info', min: 15 }),
      mail({ from: 'OP', kind: 'coord', min: 16, answeredAt: new Date(T + 17 * 60_000).toISOString() }),
    ], { policy: p, senderAbove: () => false });
    expect(rows.map(r => `${r.verdict}:${r.reason}|${r.actual}:${r.actualReason}|${r.answered}`)).toEqual([
      'digest:status-reply|turn:delegated-result|true',
      'digest:status-reply|turn:delegated-result|false',
      'wake-now:decision|turn:question|true',
      'record-only:ack|passive:info|false',
      'digest:info|passive:info|false',
      'record-only:self|passive:info|true',
    ]);
    const r = shadowReport(rows, 1, p);
    expect([r.mails, r.wakeNow, r.digest, r.digestBatches, r.recordOnly, r.wouldWakes, r.actualTurns]).toEqual([6, 1, 3, 2, 2, 3, 3]);
    expect([r.routerAgreement, r.shadowAgreement, r.silencedAnswered, r.answered]).toEqual([66.7, 83.3, 1, 3]);
    expect(r.line).toBe('📮 steward:mail shadow · 1h · mails 6 · would wake 3/h (now 1 ⊕ digest turns 2) vs router 3/h · record-only 2 · digest 3 · agreement 83.3% (router 66.7%) · silenced-but-answered 1/3');
  });
});

describe('ledger I/O — tick and CLI', () => {
  function store() {
    const dir = tmp('steward-store-');
    const path = join(dir, 'messages.db');
    return { dir, path, s: new MsgStore(path) };
  }

  test('loadStewardMails reads fields, the replied-to sender and the recipient\'s reply', () => {
    const { s } = store();
    try {
      const ask = s.post({ from: 'OP', to: 'TC', body: 'please do X', kind: 'request', intent: 'request' });
      const rep = s.post({ from: 'TC', to: 'OP', body: 'X done', kind: 'status', replyTo: ask.id, refs: ['cell:X-1'] });
      s.post({ from: 'OP', to: 'TC', body: 'thanks', kind: 'ack', replyTo: rep.id });
      const got = loadStewardMails(s.db, 'OP', '2000-01-01T00:00:00.000Z');
      expect(got).toHaveLength(1);
      expect(got[0]!.replyToSender).toBe('OP');
      expect(got[0]!.refs).toEqual(['cell:X-1']);
      expect(typeof got[0]!.answeredAt).toBe('string');
    } finally { s.close(); }
  });

  test('a tick appends each new mail once, asks Jev within its cap, and rewrites the report', async () => {
    const { s, dir } = store();
    try {
      s.post({ from: 'TC', to: 'OP', body: 'progress on Y', kind: 'report', intent: 'info' });
      s.post({ from: 'UX', to: 'OP', body: 'which branch?', kind: 'question', intent: 'request' });
      let calls = 0;
      const decide: StewardDecide = async () => { calls++; return { model: 'm', answers: { act: { type: 'choice', probabilities: { digest: 0.8 } } } }; };
      const events: string[] = [];
      const deps = { db: s.db, stateRoot: dir, decide, emit: (e: string) => { events.push(e); } };
      const first = await stewardMailShadowTick(deps);
      expect(first.OP!.mails).toBe(2);
      expect(first.OP!.wakeNow).toBe(1);
      expect(calls).toBe(1);
      const day = new Date().toISOString().slice(0, 10);
      const ledger = join(dir, 'steward', `mail-shadow-${day}.jsonl`);
      expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(2);
      await stewardMailShadowTick(deps);
      expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(2);
      expect(calls).toBe(1);
      expect(events).toEqual(['steward.mail.shadow', 'steward.mail.shadow']);
      expect(existsSync(join(dir, 'steward', 'mail-shadow.json'))).toBe(true);
    } finally { s.close(); }
  });

  test('eln msg steward-shadow prints the report line', async () => {
    const { s, path } = store();
    s.post({ from: 'TC', to: 'OP', body: 'note', kind: 'info', intent: 'info' });
    s.close();
    const outLines: string[] = [];
    const program = new Command().exitOverride();
    const msg = program.command('msg');
    registerStewardShadowCommand(msg, { out: { log: l => outLines.push(l), error: l => outLines.push(`ERR ${l}`) }, setExitCode: () => {} });
    await program.parseAsync(['node', 'elanous', 'msg', 'steward-shadow', '--to', 'OP', '--hours', '1', '--db', path]);
    expect(outLines[0]!.startsWith('OP · 📮 steward:mail shadow · 1h · mails 1 · would wake 1/h (now 0 ⊕ digest turns 1)')).toBe(true);
    expect(outLines[1]).toBe('  digest:info 1');
  });
});

describe('sim — an 11-27-shaped hour at the OP mailbox', () => {
  test('80 mails: ✋/CEO/decisions all wake, the rest ride ≤ 6 digest turns, wakes stay ≤ 20/h', () => {
    const p = policy();
    const mails: StewardMail[] = [];
    for (let i = 0; i < 40; i++) mails.push(mail({ from: `TC-H-${i % 8}`, kind: i % 2 ? 'status' : 'report', replyTo: 500 + i, replyToSender: 'OP', min: (i * 1.4) % 60 }));
    for (let i = 0; i < 12; i++) mails.push(mail({ from: 'OP', kind: 'coord', refs: [`cell:C-${i}`], min: i * 5 }));
    for (let i = 0; i < 8; i++) mails.push(mail({ from: 'RES-INFRA', kind: 'report', body: 'webchat smoke RED', min: i * 7 }));
    for (let i = 0; i < 6; i++) mails.push(mail({ from: 'LAND-GRAPH', kind: 'info', min: i * 9 }));
    for (let i = 0; i < 6; i++) mails.push(mail({ from: 'MK', kind: 'info', min: i * 10 }));
    for (let i = 0; i < 3; i++) mails.push(mail({ from: 'TC-H-CX-1', kind: 'status', refs: [`block:b${i}`, 'reason:HUMAN_DECISION'], min: i * 20 }));
    for (let i = 0; i < 3; i++) mails.push(mail({ from: 'UX', kind: 'question', intent: 'request', min: 5 + i * 20 }));
    mails.push(mail({ from: 'CLAUDE-OP', kind: 'info', refs: ['lane:proxy'], min: 30 }));
    mails.push(mail({ from: 'RES', kind: 'alert', intent: 'alert', min: 33 }));
    const r = shadowReport(shadowRows(mails, { policy: p }), 1, p);
    expect(r.mails).toBe(80);
    expect(r.wakeNow).toBe(8);
    expect(r.recordOnly).toBe(12 + 6 + 6); // self 12 · RES-INFRA repeats 6 (0→7..28 · 35→42,49) · ledger echo 6
    expect(r.digestBatches).toBeLessThanOrEqual(6);
    expect(r.wouldWakesPerHour).toBeLessThanOrEqual(20);
  });
});
