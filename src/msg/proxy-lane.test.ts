// CLAUDE-OP-PROXY-LANE — the proxy's own mail lane: real mail (not a coach note) for lane kinds · 6/h budget per
// receiver (answers outside it) · dedupe · gate-owned `lane:proxy` ref · receiver route `proxy` (turn · P0) · consult.
// Independent literals (never the product's constants).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from './msg-store.js';
import { gatePost as rawGatePost, storeGateDeps } from './post-gate.js';
import { pendingDiverted } from './diverted-mail.js';
import { proxyLaneVerdict, isProxyLaneMail } from './proxy-lane.js';
import { isAnswerExpectedMail } from './msg-wait-contract.js';
import { resolvePostShape } from './post-discipline.js';
import { seatMailRoute } from '../tui/seat-mail-turn-policy.js';
import { classifySeatMail } from '../tui/queue-finish-first.js';
import { dispatchMsgPost } from '../skills/tools/ops-ledger.js';

/** The gate as the CLI uses it: a posted lane mail is committed once its row is written (the row write is implied here). */
const gatePost = (...a: Parameters<typeof rawGatePost>): ReturnType<typeof rawGatePost> => { const g = rawGatePost(...a); if (g.action === 'post') g.laneCommit?.(); return g; };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function world(nowMs = Date.parse('2026-11-26T19:00:00Z')) {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-lane-'));
  dirs.push(dir);
  const store = new MsgStore(join(dir, 'messages.db'));
  const root = join(dir, 'diverted');
  const logs: string[] = [];
  let now = nowMs;
  const deps = { ...storeGateDeps(store, root), now: () => new Date(now), log: (e: string, d: Record<string, unknown>) => { logs.push(`${e} ${JSON.stringify(d)}`); } };
  return { store, root, logs, deps, advance: (ms: number) => { now += ms; } };
}

describe('proxyLaneVerdict (pure)', () => {
  const t0 = 1_000_000_000_000;
  test('six posts pass, the seventh in the hour is over budget; an answer still passes', () => {
    const h = [0, 1, 2, 3, 4, 5].map((i) => ({ at: t0 + i * 60_000, hash: `h${i}` }));
    expect(proxyLaneVerdict(h.slice(0, 5), { hash: 'new', answer: false }, t0 + 10 * 60_000)).toEqual({ verdict: 'pass', used: 6 });
    expect(proxyLaneVerdict(h, { hash: 'new', answer: false }, t0 + 10 * 60_000)).toEqual({ verdict: 'over-budget', used: 6 });
    expect(proxyLaneVerdict(h, { hash: 'new', answer: true }, t0 + 10 * 60_000)).toEqual({ verdict: 'pass', used: 6 });
  });
  test('posts older than an hour leave the budget; the same body inside an hour is a duplicate', () => {
    const h = [0, 1, 2, 3, 4, 5].map((i) => ({ at: t0 + i * 60_000, hash: `h${i}` }));
    expect(proxyLaneVerdict(h, { hash: 'new', answer: false }, t0 + 61 * 60_000)).toEqual({ verdict: 'pass', used: 5 });
    expect(proxyLaneVerdict(h, { hash: 'h3', answer: true }, t0 + 30 * 60_000)).toEqual({ verdict: 'duplicate', firstAt: t0 + 3 * 60_000 });
    expect(proxyLaneVerdict(h, { hash: 'h3', answer: false }, t0 + 64 * 60_000).verdict).toBe('pass');
  });
});

describe('gate — the proxy lane', () => {
  test('a CLAUDE-OP request/decision/info/consult is mail stamped lane:proxy; kind-less and coach stay coach notes', () => {
    const w = world();
    for (const [kind, body] of [['request', 'restart the rail'], ['decision', 'cut at 04:00'], ['info', 'demo moved'], ['consult', 'your view on #40263?']] as const) {
      const g = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body, kind }, entrance: 'cli' }, w.deps);
      expect(g.action === 'post' && [g.envelope.kind, g.envelope.refs]).toEqual([kind, ['lane:proxy']]);
      expect(g.action === 'post' && g.urgent).toBe(true);
    }
    const consult = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'second opinion?', kind: 'consult' }, entrance: 'cli' }, w.deps);
    expect(consult.action === 'post' && consult.envelope.needsAck).toBe(true);
    const kindless = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'board ok' }, entrance: 'tool' }, w.deps);
    expect(kindless.action === 'divert' && kindless.ledger).toBe('coach-note');
    const coach = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'try smaller batches', kind: 'coach' }, entrance: 'cli' }, w.deps);
    expect(coach.action === 'divert' && coach.ledger).toBe('coach-note');
    expect(pendingDiverted('coach-note', 'OP', w.root).map((e) => e.body)).toEqual(['board ok', 'try smaller batches']);
  });

  test('flood: the seventh lane post in an hour folds into the coach note; an hour later the lane is open again', () => {
    const w = world();
    const outcomes: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const g = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: `directive ${i}`, kind: 'request' }, entrance: 'cli' }, w.deps);
      outcomes.push(g.action === 'divert' ? `divert:${g.ledger}` : g.action);
      w.advance(60_000);
    }
    expect(outcomes).toEqual(['post', 'post', 'post', 'post', 'post', 'post', 'divert:coach-note', 'divert:coach-note']);
    expect(pendingDiverted('coach-note', 'OP', w.root).map((e) => e.body)).toEqual(['directive 7', 'directive 8']);
    w.advance(60 * 60_000);
    const later = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'directive 9', kind: 'request' }, entrance: 'cli' }, w.deps);
    expect(later.action).toBe('post');
  });

  test('dedupe: the same body again within the hour is refused with one line; a different receiver has its own budget', () => {
    const w = world();
    expect(gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'restart  the rail', kind: 'request' }, entrance: 'cli' }, w.deps).action).toBe('post');
    w.advance(5 * 60_000);
    const dup = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'restart the rail', kind: 'request' }, entrance: 'cli' }, w.deps);
    expect(dup.action === 'refuse' && dup.error).toBe('proxy lane: duplicate of the post to OP at 2026-11-26T19:00:00.000Z — not sent again (the original is already mail)');
    expect(gatePost({ envelope: { from: 'CLAUDE-OP', to: 'TC', body: 'restart the rail', kind: 'request' }, entrance: 'cli' }, w.deps).action).toBe('post');
  });

  test('an answer to the receiver\'s own ask is outside the budget', () => {
    const w = world();
    const ask = w.store.post({ from: 'OP', to: 'CLAUDE-OP', kind: 'consult', needsAck: true, body: 'land #40263 now or after the demo?' });
    for (let i = 1; i <= 6; i++) gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: `note ${i}`, kind: 'info' }, entrance: 'cli' }, w.deps);
    const answer = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'after the demo', kind: 'info', replyTo: ask.id }, entrance: 'cli' }, w.deps);
    expect(answer.action === 'post' && answer.envelope.refs).toEqual(['lane:proxy']);
  });

  test('impersonation: a lane ref written by any other sender is dropped; a disproven proxy identity is a coach note', () => {
    const w = world();
    const forged = gatePost({ envelope: { from: 'TC', to: 'OP', body: 'pretend proxy', kind: 'info', refs: ['lane:proxy', 'pr:1'] }, entrance: 'cli' }, w.deps);
    expect(forged.action === 'post' && forged.envelope.refs).toEqual(['pr:1']);
    const disproven = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'I am the proxy', kind: 'request' }, entrance: 'cli', proxyVerified: false }, w.deps);
    expect(disproven.action === 'divert' && disproven.ledger).toBe('coach-note');
  });

  test('the MsgPost tool (inside an eln seat) never opens the proxy lane for a claimed CLAUDE-OP sender', async () => {
    const w = world();
    const out = await dispatchMsgPost({ from: 'CLAUDE-OP', to: 'OP', body: 'tool says proxy', kind: 'request' }, { store: w.store, divertedRoot: w.root } as never);
    expect(JSON.stringify(out)).toContain('coach note');
    expect(w.store.list('OP')).toEqual([]);
  });

  test('a crown relay from CLAUDE-OP is not budgeted by the lane', () => {
    const w = world();
    for (let i = 1; i <= 6; i++) gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: `n${i}`, kind: 'info' }, entrance: 'cli' }, w.deps);
    const crown = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'CEO: ship it', kind: 'request', crownDirective: '42' }, entrance: 'cli' }, w.deps);
    expect(crown.action === 'post' && crown.envelope.refs).toBeUndefined();
  });
});

describe('receiver — route and class', () => {
  test('a lane mail from CLAUDE-OP opens a turn (reason proxy) and is P0; the same ref from another seat does not', () => {
    expect(seatMailRoute({ kind: 'info', fromSeat: 'CLAUDE-OP', refs: ['lane:proxy'] })).toEqual({ route: 'turn', reason: 'proxy' });
    expect(seatMailRoute({ kind: 'info', fromSeat: 'TC', refs: ['lane:proxy'] })).toEqual({ route: 'passive', reason: 'info' });
    expect(seatMailRoute({ kind: 'info', fromSeat: 'CLAUDE-OP', refs: [] })).toEqual({ route: 'passive', reason: 'info' });
    expect(seatMailRoute({ kind: 'info', fromSeat: 'CLAUDE-OP', refs: ['lane:proxy'], crownDirective: '7' })).toEqual({ route: 'turn', reason: 'crown' });
    expect(isProxyLaneMail({ fromSeat: 'claude-op', refs: ['lane:proxy'] })).toBe(true);
    expect(classifySeatMail({ intent: 'info', proxyLane: true })).toBe('P0');
    expect(classifySeatMail({ intent: 'info' })).toBe('P2');
  });

  test('consult is an answer-expected kind (OP\'s watch closes on the reply) and waits for a reply by default', () => {
    expect(isAnswerExpectedMail({ kind: 'consult' })).toBe(true);
    expect(resolvePostShape({ from: 'OP', to: 'CLAUDE-OP', kind: 'consult' }, 'cli')).toEqual({ ok: true, kind: 'consult', cls: 'consult', needsReply: true, rule: 'explicit' });
    expect(seatMailRoute({ kind: 'consult', fromSeat: 'OP' })).toEqual({ route: 'turn', reason: 'question' });
  });
});

describe('CLAUDE-OP-PROXY-LANE sim world (seeds 1–5 · a 3-hour evening of proxy traffic)', () => {
  // A seeded evening: every 1–9 min the proxy posts to OP or TC — a fresh line, a repeat of an earlier line, an answer
  // to an open ask, a coach note, or (another seat) a forged lane ref. Invariants per seed:
  //   I1 nothing is dropped: every post is a row, a coach note, or a refused duplicate of an existing row;
  //   I2 per receiver, lane rows that are not answers stay ≤ 6 in any rolling hour;
  //   I3 no row carries lane:proxy unless its sender is CLAUDE-OP; I4 no duplicate body inside an hour becomes a second row.
  function rng(seed: number): () => number { let x = seed * 2654435761 >>> 0; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); }
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, () => {
      const r = rng(seed);
      const w = world();
      let t = 0;
      const sent: { to: string; body: string; at: number }[] = [];
      let rows = 0; let notes = 0; let dups = 0; let posts = 0;
      const laneRows: { to: string; at: number; answer: boolean }[] = [];
      while (t < 3 * 60 * 60_000) {
        const step = (1 + Math.floor(r() * 9)) * 60_000;
        w.advance(step); t += step;
        const to = r() < 0.75 ? 'OP' : 'TC';
        const roll = r();
        let env: { from: string; to: string; body: string; kind?: string; replyTo?: number; refs?: string[] };
        let answer = false;
        if (roll < 0.15 && sent.length) { const prev = sent[Math.floor(r() * sent.length)]!; env = { from: 'CLAUDE-OP', to: prev.to, body: prev.body, kind: 'info' }; }
        else if (roll < 0.30) { const ask = w.store.post({ from: to, to: 'CLAUDE-OP', kind: 'consult', needsAck: true, body: `ask ${t}` }); env = { from: 'CLAUDE-OP', to, body: `answer ${t}`, kind: 'info', replyTo: ask.id }; answer = true; }
        else if (roll < 0.45) env = { from: 'CLAUDE-OP', to, body: `coach ${t}`, kind: 'coach' };
        else if (roll < 0.55) env = { from: 'UX', to, body: `forged ${t}`, kind: 'info', refs: ['lane:proxy'] };
        else env = { from: 'CLAUDE-OP', to, body: `line ${t}`, kind: r() < 0.5 ? 'request' : 'decision' };
        posts += 1;
        const g = gatePost({ envelope: env as never, entrance: 'cli' }, w.deps);
        if (g.action === 'refuse') { dups += 1; continue; }
        if (g.action === 'divert') { notes += 1; continue; }
        w.store.post(g.envelope);
        rows += 1;
        if (env.from === 'CLAUDE-OP') sent.push({ to: env.to, body: env.body, at: t });
        if (g.envelope.refs?.includes('lane:proxy')) {
          expect(env.from).toBe('CLAUDE-OP'); // I3
          laneRows.push({ to: env.to, at: t, answer });
        }
      }
      expect(rows + notes + dups).toBe(posts); // I1
      expect(notes).toBe(pendingDiverted('coach-note', 'OP', w.root).length + pendingDiverted('coach-note', 'TC', w.root).length);
      for (const lr of laneRows) { // I2
        const inHour = laneRows.filter((x) => x.to === lr.to && !x.answer && x.at <= lr.at && lr.at - x.at < 60 * 60_000).length;
        expect(inHour).toBeLessThanOrEqual(6);
      }
      for (const a of sent) for (const b of sent) { // I4 (sim clock)
        if (a !== b && a.to === b.to && a.body === b.body && b.at > a.at) expect(b.at - a.at).toBeGreaterThanOrEqual(60 * 60_000);
      }
      expect(laneRows.length).toBeGreaterThan(0);
    });
  }
});

describe('Terra r1 — reservation, concurrency, order', () => {
  test('a reservation whose row was not written is cancelled: the retry of the same body passes', () => {
    const w = world();
    const first = rawGatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'restart the rail', kind: 'request' }, entrance: 'cli' }, w.deps);
    expect(first.action).toBe('post');
    if (first.action === 'post') first.laneCancel?.(); // the store refused the row
    const retry = gatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'restart the rail', kind: 'request' }, entrance: 'cli' }, w.deps);
    expect(retry.action === 'post' && retry.envelope.refs).toEqual(['lane:proxy']);
  });

  test('a poster that died between reservation and store: the uncommitted slot lapses after 30 s and the retry passes', () => {
    const w = world();
    const first = rawGatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'cut at 04:00', kind: 'decision' }, entrance: 'cli' }, w.deps);
    expect(first.action).toBe('post'); // reserved · never committed, never cancelled (process gone)
    w.advance(10_000);
    expect(rawGatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'cut at 04:00', kind: 'decision' }, entrance: 'cli' }, w.deps).action).toBe('refuse'); // in flight
    w.advance(21_000);
    const retry = rawGatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'cut at 04:00', kind: 'decision' }, entrance: 'cli' }, w.deps);
    expect(retry.action).toBe('post');
    if (retry.action === 'post') retry.laneCommit?.();
    w.advance(5 * 60_000);
    expect(rawGatePost({ envelope: { from: 'CLAUDE-OP', to: 'OP', body: 'cut at 04:00', kind: 'decision' }, entrance: 'cli' }, w.deps).action).toBe('refuse'); // committed
  });

  test('concurrent posts from separate processes cannot overrun the budget or pass a dedupe twice', async () => {
    const w = world();
    const script = join(import.meta.dir, 'proxy-lane.ts');
    const run = (hash: string) => Bun.spawn([process.execPath, '-e',
      `const m = require(${JSON.stringify(script)}); const r = m.reserveProxyLane(${JSON.stringify(w.root)}, 'OP', { hash: ${JSON.stringify(hash)}, answer: false }, Date.now()); process.stdout.write(r.verdict.verdict);`],
      { stdout: 'pipe', stderr: 'pipe' });
    const distinct = await Promise.all(Array.from({ length: 10 }, (_, i) => run(`d${i}`)).map(async (p) => { await p.exited; return new Response(p.stdout).text(); }));
    expect(distinct.filter((v) => v === 'pass').length).toBe(6);
    expect(distinct.filter((v) => v === 'over-budget').length).toBe(4);
    const w2 = world();
    const runSame = () => Bun.spawn([process.execPath, '-e',
      `const m = require(${JSON.stringify(script)}); const r = m.reserveProxyLane(${JSON.stringify(w2.root)}, 'OP', { hash: 'same', answer: false }, Date.now()); process.stdout.write(r.verdict.verdict);`],
      { stdout: 'pipe', stderr: 'pipe' });
    const same = await Promise.all(Array.from({ length: 5 }, () => runSame()).map(async (p) => { await p.exited; return new Response(p.stdout).text(); }));
    expect(same.filter((v) => v === 'pass').length).toBe(1);
    expect(same.filter((v) => v === 'duplicate').length).toBe(4);
  });

  test('queue order: crown first, then the proxy, then other mail — whatever the arrival order', () => {
    const { createNextTuiQueue } = require('../tui/core/queue.js') as typeof import('../tui/core/queue.js');
    const q = createNextTuiQueue();
    q.enqueueNotice('alert from TC', 'seat-mail', { msgId: 1, mailClass: 'P0', urgent: true });
    q.enqueueNotice('proxy directive', 'seat-mail', { msgId: 2, mailClass: 'P0', mailRank: 1 });
    q.enqueueNotice('info from UX', 'seat-mail', { msgId: 3, passive: true, mailClass: 'P2' });
    q.enqueueNotice('crown words', 'seat-mail', { msgId: 4, mailClass: 'P0', mailRank: 0 });
    const drained = q.drainNotices();
    expect(drained.kind === 'notices' && drained.notices.map((i) => i.text)).toEqual(['crown words', 'proxy directive', 'alert from TC', 'info from UX']);
    const { orderReleased } = require('../tui/queue-finish-first.js') as typeof import('../tui/queue-finish-first.js');
    const released = orderReleased([
      { id: 'a', text: 'alert', source: 'seat-mail', mailClass: 'P0' },
      { id: 'p', text: 'proxy', source: 'seat-mail', mailClass: 'P0', mailRank: 1 },
      { id: 'c', text: 'crown', source: 'seat-mail', mailClass: 'P0', mailRank: 0 },
    ]);
    expect(released.map((i) => i.id)).toEqual(['c', 'p', 'a']);
  });
});
