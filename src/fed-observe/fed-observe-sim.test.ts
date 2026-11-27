// FED-OBSERVE seeded sim (seeds 1–5): a synthetic federation with the four faults of 11-26 night injected among random
// healthy noise — a ✋ unanswered for 13 h · a TC HOLD freezing hands · 1 039 overdue OP commitments · Cap misses — must
// each be flagged with its own rule, and nothing healthy may be flagged. The chat log of the same world must come out in
// time order (turns of many seats ⊕ mails interleaved) with every planted secret redacted.
import { describe, expect, test } from 'bun:test';
import type { SerializedMessage } from '../session/index.js';
import { buildFedSnapshot, formatAnomalies, type FedSources, type PaneIn } from './snapshot.js';
import { buildChatlog, type MailRow, type SeatSession } from './chatlog.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { panesFromListing, readLogRows, seatTranscripts } from './sources-live.js';
import { paneSession } from '../seat-peek/peek.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const NOW = new Date('2026-11-26T14:30:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function world(seed: number) {
  const r = rng(seed);
  const handCount = 6 + Math.floor(r() * 8);
  const hands = Array.from({ length: handCount }, (_, i) => `TC-H-${seed}-${i}`);
  const coords = ['OP', 'TC', 'JUD', 'UX', 'MK'];
  const panes: PaneIn[] = [
    ...coords.map(seat => ({ seat, coordinator: true, status: { state: r() < 0.5 ? 'IDLE' : 'WORKING' }, build: { sha: 'cafe', desired: 'cafe' }, unreadMail: { count: Math.floor(r() * 5), oldestCreatedAt: ago(Math.floor(r() * 30)) } })),
    ...hands.map(seat => ({ seat, workspace: 'TC', status: { state: 'IDLE' }, build: { sha: 'cafe', desired: 'cafe' }, unreadMail: { count: 0 } })),
  ];
  // TC HOLD: 3..all hands blocked on TC within the last hour, each with HOLD in the reason.
  const frozen = hands.slice(0, 3 + Math.floor(r() * (handCount - 3)));
  const blocks = frozen.map((by, i) => ({ by, on: 'TC', cell: `CELL-${i}`, reason: `TC #18${i} 사건별 시험 HOLD 유지`, at: ago(1 + Math.floor(r() * 50)) }));
  // healthy noise: one or two hands blocked on JUD (below the freeze threshold), old blocks on TC (outside the window).
  blocks.push({ by: hands[handCount - 1]!, on: 'JUD', cell: 'J-1', reason: 'verdict pending', at: ago(5) });
  blocks.push({ by: 'OLD-HAND', on: 'TC', cell: 'OLD', reason: 'HOLD', at: ago(200) }, { by: 'OLD-HAND-2', on: 'TC', cell: 'OLD2', reason: 'HOLD', at: ago(300) });
  // Cap misses on one random hand (≥3), single noise misses elsewhere.
  const capSeat = hands[Math.floor(r() * handCount)]!;
  const capN = 3 + Math.floor(r() * 6);
  const errors = [
    ...Array.from({ length: capN }, (_, i) => ({ seat: capSeat, at: ago(i * 5), kind: 'cap' as const, what: 'tui.autoturn rejected Cap (turn-cap)' })),
    { seat: 'UX', at: ago(7), kind: 'cap' as const, what: 'tui.autoturn rejected Cap' },
    { seat: 'MK', at: ago(90), kind: 'fatal' as const, what: 'old fatal outside the window' },
  ];
  const sources: FedSources = {
    now: NOW, installedSha: 'cafe', panes,
    pool: hands.map(seat => ({ seat, home: 'TC', state: 'idle' as const })),
    turns: coords.map(seat => ({ seat, at: ago(2), outcome: 'did' as const })),
    errors, queues: [], mail: [],
    hands: [
      { id: 900 + seed, from: hands[1]!, to: 'TC', blockedSeat: hands[1]!, reason: 'needs TC decision on scope', waitedMs: 13 * 3_600_000 + Math.floor(r() * 600_000) },
      { id: 950 + seed, from: hands[2]!, to: 'TC', blockedSeat: hands[2]!, reason: 'fresh ask', waitedMs: Math.floor(r() * 20) * 60_000 },
    ],
    blocks, landingFreeze: null, landHolds: [],
    commitments: { seat: 'OP', open: 1_100, overdue: 1_039, action: 12 },
    land: { lastAt: ago(4), landedToday: 9, pending: 3, mode: 'live' }, judge: { queue: 2, medianWaitMin: 10 },
    loops: { windowMin: 60, ok: 40, goalNotMet: 0, failed: 0, stale: 0, running: 1, failing: [] },
    release: { version: '0.3.37', green: 10, yellow: 50, total: 60 }, kpi: { landedPerHour: 8, opInboundPerHour: 20, idleWithWork: [] }, unmeasured: [],
  };
  // chat world: every seat gets 1..4 turns at random times; mails at random times; one reply carries a secret.
  const sessions: SeatSession[] = [...coords, ...hands.slice(0, 3)].map((seat, si) => {
    const msgs: SerializedMessage[] = [];
    let t = Math.floor(r() * 300);
    const n = 1 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      msgs.push({ role: 'user', ts: ago(30 - t / 60), content: `[mail] turn ${k} of ${seat}` });
      msgs.push({ role: 'assistant', ts: ago(30 - (t + 5) / 60), content: si === 0 && k === 0 ? `token ${SECRET}` : `done ${k}` });
      t += 30 + Math.floor(r() * 300);
    }
    return { seat, sessionId: `${seat.toLowerCase().replace(/[^a-z0-9]/g, '')}00000000`, messages: msgs };
  });
  const mails: MailRow[] = Array.from({ length: 5 + Math.floor(r() * 10) }, (_, i) => ({
    id: 1000 + i, from: coords[Math.floor(r() * coords.length)]!, to: hands[Math.floor(r() * handCount)]!, kind: 'request',
    body: i === 0 ? `password=${SECRET}` : `ask ${i}`, createdAt: ago(Math.floor(r() * 29)),
  }));
  return { sources, sessions, mails, frozen, capSeat, capN, seedHands: hands };
}

describe('fed observe sim — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: every planted fault is flagged, nothing healthy is`, () => {
      const w = world(seed);
      const s = buildFedSnapshot(w.sources);
      const rules = s.anomalies.map(a => `${a.rule}:${a.seat ?? '-'}`).sort();
      expect(rules).toEqual(['cap-refusals:' + w.capSeat, 'commitments-overdue:OP', 'hand-unanswered:TC', 'hold-freeze:TC'].sort());
      const byRule = new Map(s.anomalies.map(a => [a.rule, a]));
      expect(byRule.get('hand-unanswered')!.why).toContain(`✋ #${900 + seed} `);
      expect(byRule.get('hand-unanswered')!.why).toContain('unanswered 13h');
      expect(byRule.get('hold-freeze')!.why).toContain(`TC HOLD freezes ${w.frozen.length} hands in 60m`);
      expect(byRule.get('commitments-overdue')!.why).toContain('OP has 1039 overdue commitments');
      expect(byRule.get('cap-refusals')!.why).toContain(`${w.capSeat} ${w.capN} turns dropped by Cap`);
      expect(s.totals.hands!.holding).toBe(w.frozen.length + (w.frozen.includes(w.seedHands[w.seedHands.length - 1]!) ? 0 : 1));
      const block = formatAnomalies(s);
      expect(block.length).toBeLessThanOrEqual(1500);
      expect(block.split('\n').length).toBe(5);
    });

    test(`seed ${seed}: chat log is time-ordered across seats and mails, secrets redacted`, () => {
      const w = world(seed);
      const log = buildChatlog(w.sessions, w.mails, { now: NOW.getTime(), since: NOW.getTime() - 60 * 60_000, turns: null, seats: null, grep: null, clip: 0 });
      const times = log.map(e => Date.parse(e.at));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(log.filter(e => e.type === 'turn').length).toBe(w.sessions.reduce((n, s) => n + s.messages.length / 2, 0));
      expect(log.filter(e => e.type === 'mail').length).toBe(w.mails.length);
      expect(new Set(log.flatMap(e => (e.type === 'turn' ? [e.seat] : []))).size).toBe(w.sessions.length);
      expect(JSON.stringify(log)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    });
  }
});

describe('Terra r1 must-fix regressions (live sources)', () => {
  test('#5 a missing log store is a read failure, not «no errors»', () => {
    expect(() => readLogRows({ sinceMs: 0, limit: 1 }, join(mkdtempSync(join(tmpdir(), 'fed-logs-')), 'nope.db'))).toThrow('log store missing');
  });

  test('#6 remote seats resolve their session by argv; an unreadable transcript or session is named, never skipped', () => {
    const panes = panesFromListing({ workspaces: [], panes: [
      { seat: 'TC-H-REMOTE-1', kind: 'eln', reach: 'up', host: 'node-b', fgCommand: ['eln', '--resume', 'remote-sess-1'] },
      { seat: 'LOCAL-1', kind: 'eln', reach: 'local', fgCommand: ['eln', '--resume', 'local-sess-1'] },
      { seat: 'NOSESS', kind: 'eln', reach: 'local', fgCommand: ['eln'] },
      { seat: 'SHELL', kind: 'shell', reach: 'local' },
    ] }, (row) => paneSession({ parents: new Map(), manifest: [], fgCommand: (row.fgCommand as string[] | undefined) ?? [] })?.sessionId ?? null);
    expect(panes.find(p => p.seat === 'TC-H-REMOTE-1')!.sessionId).toBe('remote-sess-1');
    const r = seatTranscripts(panes, 1024, (id) => (id === 'local-sess-1' ? [{ role: 'user', ts: '2026-11-26T14:00:00.000Z', content: 'x' }] : null));
    expect(r.sessions.map(s => s.seat)).toEqual(['LOCAL-1']);
    expect(r.unmeasured.sort()).toEqual(['session(NOSESS)', 'transcript(TC-H-REMOTE-1@node-b)']);
  });
});
