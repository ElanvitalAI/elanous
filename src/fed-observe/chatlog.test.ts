import { describe, expect, test } from 'bun:test';
import type { SerializedMessage } from '../session/index.js';
import { buildChatlog, formatChatlog, turnsOf, type ChatTurn } from './chatlog.js';
import { classifyLogRow, panesFromListing, queueDepths, readTranscriptSince, type LogRowLite } from './sources-live.js';
import { runFedChatlogCli } from './fed-observe-cli.js';

const T0 = Date.parse('2026-11-26T14:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const m = (role: SerializedMessage['role'], s: number, content: string, extra: Partial<SerializedMessage> = {}): SerializedMessage => ({ role, ts: at(s), content, ...extra });

describe('chatlog turns', () => {
  test('a turn = input → final reply → tools → outcome; leading [tag] is split off', () => {
    const turns = turnsOf({ seat: 'tc', sessionId: 'abcdef1234', messages: [
      m('assistant', 1, 'tail of an earlier turn'),
      m('user', 10, '[bulletin · graph] fill the two lines'),
      m('tool', 11, '⚙️ Read', { toolName: 'Read' }), m('tool', 12, '⚙️ Edit', { toolName: 'Edit' }), m('tool', 13, '⚙️ Edit', { toolName: 'Edit' }),
      m('assistant', 14, 'interim', { goalInterim: true }), m('assistant', 15, 'filled both lines'),
      m('user', 20, 'how is it going?'), m('assistant', 21, 'fine'),
    ] }, { now: T0 + 60_000, clip: 0 });
    expect(turns.map(t => [t.turnId, t.inputTag, t.input, t.reply, t.tools.count, t.tools.names.join(' '), t.outcome])).toEqual([
      ['TC/abcdef12/140010', 'bulletin · graph', 'fill the two lines', 'filled both lines', 3, 'Edit×2 Read', 'did'],
      ['TC/abcdef12/140020', 'user', 'how is it going?', 'fine', 0, '', 'reply'],
    ]);
  });

  test('outcomes: fatal log row → failed · enforce noop → no-op · promise ending → no-op · silent recent → running · silent old → failed', () => {
    const msgs = [
      m('user', 0, 'a'), m('assistant', 5, 'done'),
      m('user', 100, 'b'), m('assistant', 105, 'ok'),
      m('user', 200, 'c'), m('tool', 201, '', { toolName: 'MsgList' }), m('assistant', 205, '요청 보냈습니다.\n23:27에 다시 점검합니다'),
      m('user', 300, 'd'),
      m('user', 400, 'e'),
    ];
    const turns = turnsOf({ seat: 'OP', sessionId: 'ffffffff00', messages: msgs }, {
      now: T0 + 410_000, clip: 0,
      facts: { fatal: new Map([['OP', [{ at: T0 + 3_000, what: 'session.compact over-budget' }]]]), enforce: [{ since: T0 + 100_000, noop: true, promise: true }] },
    });
    expect(turns.map(t => `${t.outcome}|${t.why ?? ''}`)).toEqual([
      'failed|session.compact over-budget',
      'no-op|engine: no state change · ended on «HH:MM에 확인»',
      'no-op|ended on «HH:MM에 확인» with no action',
      'failed|no reply',
      'running|',
    ]);
  });
});

describe('chatlog stream', () => {
  const sessions = [
    { seat: 'OP', sessionId: 'op000000', messages: [m('user', 30, '[mail] TC asks'), m('assistant', 40, 'answered TC')] },
    { seat: 'TC', sessionId: 'tc000000', messages: [m('user', 5, 'start'), m('assistant', 8, 'token ghp_0123456789abcdef0123456789abcdef0123 leaked'), m('user', 50, 'next'), m('assistant', 55, 'x'.repeat(50))] },
  ];
  const mails = [
    { id: 7, from: 'TC', to: 'OP', kind: 'request', body: '\n  please decide\nsecond line', createdAt: at(30) },
    { id: 6, from: 'UX', to: 'MK', kind: 'info', body: 'unrelated', createdAt: at(20) },
    { id: 5, from: 'JUD', to: 'TC', kind: 'report', body: 'old', createdAt: at(-500) },
  ];

  test('interleaves turns and mails by time (a mail sorts before the turn it opened) and redacts secrets', () => {
    const log = buildChatlog(sessions, mails, { now: T0 + 60_000, since: T0, turns: null, seats: null, grep: null, clip: 20 });
    expect(log.map(e => (e.type === 'mail' ? `mail#${e.id}` : `${e.seat}@${e.at.slice(14, 19)}`))).toEqual(['TC@00:05', 'mail#6', 'mail#7', 'OP@00:30', 'TC@00:50']);
    const tc = log[0] as ChatTurn;
    expect(tc.reply).not.toContain('0123456789abcdef0123456789abcdef');
    expect((log[4] as ChatTurn).reply).toBe(`${'x'.repeat(19)}…`);
    expect(log[2]).toMatchObject({ type: 'mail', line: 'please decide', from: 'TC', to: 'OP', kind: 'request' });
  });

  test('seat filter keeps mails from or to the seats; grep and --turns narrow; --turns alone opens the mail window at the first turn', () => {
    const onlyOp = buildChatlog(sessions, mails, { now: T0 + 60_000, since: T0, turns: null, seats: new Set(['OP']), grep: null, clip: 0 });
    expect(onlyOp.map(e => (e.type === 'mail' ? `mail#${e.id}` : e.seat))).toEqual(['mail#7', 'OP']);
    const grep = buildChatlog(sessions, mails, { now: T0 + 60_000, since: T0, turns: null, seats: null, grep: 'DECIDE', clip: 0 });
    expect(grep.map(e => e.type)).toEqual(['mail']);
    const last1 = buildChatlog(sessions, mails, { now: T0 + 60_000, since: null, turns: 1, seats: null, grep: null, clip: 0, mail: true });
    expect(last1.map(e => (e.type === 'mail' ? `mail#${e.id}` : `${e.seat}@${e.at.slice(14, 19)}`))).toEqual(['mail#7', 'OP@00:30', 'TC@00:50']);
  });

  test('human lines: ✉ for mail, ▶ ◀ ⚙ and the outcome mark for turns', () => {
    const lines = formatChatlog(buildChatlog(sessions.slice(0, 1), mails.slice(0, 1), { now: T0 + 60_000, since: T0, turns: null, seats: null, grep: null, clip: 0 }));
    expect(lines.length).toBe(4);
    expect(lines[0]).toMatch(/✉ #7 TC→OP \[request\] please decide$/);
    expect(lines[1]).toMatch(/▶ OP OP\/op000000\/140030 \[mail\] TC asks$/);
    expect(lines[2]).toBe('         ◀ answered TC');
    expect(lines[3]).toBe('         · reply');
  });

  test('CLI: bad --turns is a usage error; --json carries entries', async () => {
    const errs: string[] = [];
    expect(await runFedChatlogCli({ turns: '-1' }, { err: l => errs.push(l), out: () => {} })).toBe(2);
    expect(errs[0]).toBe('fed chatlog: --turns must be a whole number ≥ 0 (got -1)');
    const out: string[] = [];
    const code = await runFedChatlogCli({ since: '5m', json: true }, { now: () => new Date(T0 + 60_000), out: l => out.push(l),
      collect: async () => ({ sessions, mails, facts: {}, unmeasured: [] }) });
    expect(code).toBe(0);
    expect((JSON.parse(out[0]!) as { entries: unknown[] }).entries.length).toBe(5);
  });
});

describe('live-source pure helpers', () => {
  const row = (over: Partial<LogRowLite>): LogRowLite => ({ ts: at(0), ts_ms: T0, level: 'info', category: 'x', event: 'y', session_id: null, data: null, ...over });
  test('log rows: over-budget is fatal · Cap without retry is a miss · Cap with retry is pacing (ignored) · info is ignored', () => {
    expect(classifyLogRow(row({ level: 'error', category: 'session.compact', event: 'over-budget', session_id: 's1' }))).toEqual({ session: 's1', pid: null, kind: 'fatal', what: 'session.compact over-budget' });
    expect(classifyLogRow(row({ category: 'tui.autoturn', event: 'rejected', data: '{"reason":"Cap","detail":"turn-cap","tuiSession":"s2","tuiPid":9}' })))
      .toEqual({ session: 's2', pid: 9, kind: 'cap', what: 'tui.autoturn rejected Cap (turn-cap)' });
    expect(classifyLogRow(row({ data: '{"reason":"Cap","retryAt":1,"tuiSession":"s2"}' }))).toBeNull();
    // CAP-ECHO (11-27): a caller echoing the gate's refusal is not a drop; a producer's own «missed» is.
    expect(classifyLogRow(row({ category: 'op.requirements', event: 'continue-rejected', data: '{"reason":"Cap","tuiSession":"s2"}' }))).toBeNull();
    expect(classifyLogRow(row({ category: 'autopilot', event: 'drive-refused', data: '{"reason":"Cap","detail":"pacing:min-interval","tuiSession":"s2"}' }))).toBeNull();
    expect(classifyLogRow(row({ category: 'seat.retro', event: 'missed', data: '{"reason":"Cap","tuiSession":"s2","tuiPid":9}' })))
      .toEqual({ session: 's2', pid: 9, kind: 'cap', what: 'seat.retro missed Cap' });
    expect(classifyLogRow(row({ level: 'error', category: 'nexus.app-db-backup', event: 'credential-missing' }))!.kind).toBe('error');
    expect(classifyLogRow(row({}))).toBeNull();
  });

  test('queue depth = held items not joined since the last release', () => {
    const q = (s: number, event: string, data: Record<string, unknown>) => row({ ts_ms: T0 + s, category: 'tui.queue', event, data: JSON.stringify(data) });
    const depth = queueDepths([
      q(1, 'held', { itemId: 'q1', tuiSession: 'A' }), q(2, 'held', { itemId: 'q2', tuiSession: 'A' }), q(3, 'released', { count: 2, tuiSession: 'A' }),
      q(4, 'held', { itemId: 'q3', tuiSession: 'A' }), q(5, 'held', { itemId: 'q4', tuiSession: 'A' }), q(6, 'p1-joined', { itemId: 'q3', tuiSession: 'A' }),
      q(0, 'held', { itemId: 'q9', tuiSession: 'B' }),
    ]);
    expect([...depth].sort()).toEqual([['A', 1], ['B', 1]]);
  });

  test('els listing → one row per seat, coordinator from the workspace, live beats exited, loop tabs kept', () => {
    const panes = panesFromListing({
      workspaces: [{ name: 'JUDGE', coordinatorSeat: 'JUD' }, { name: 'OP', role: 'coordinator' }],
      panes: [
        { seat: 'jud', kind: 'eln', status: { state: 'EXITED' } }, { seat: 'JUD', kind: 'eln', status: { state: 'IDLE', since: 5 }, build: { sha: 'a', desired: 'a' } },
        { seat: 'OP', kind: 'eln', status: { state: 'WORKING' } }, { title: '↻ loops (7)', kind: 'eln' }, { title: 'watch tc', kind: 'shell' },
      ],
    }, () => 'sess-1');
    expect(panes.map(p => [p.seat, p.status?.state ?? null, p.coordinator, p.sessionId])).toEqual([
      ['JUD', 'IDLE', true, 'sess-1'], ['OP', 'WORKING', true, 'sess-1'], ['↻ loops (7)', null, false, 'sess-1'],
    ]);
  });
});

describe('Terra r1 must-fix regressions', () => {
  test('#1 a secret inside the leading [tag] is redacted in the tag, the text and the JSON', () => {
    const turns = turnsOf({ seat: 'OP', sessionId: 'aaaaaaaa00', messages: [
      { role: 'user', ts: '2026-11-26T14:00:00.000Z', content: '[ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789] hi' },
      { role: 'assistant', ts: '2026-11-26T14:00:01.000Z', content: 'ok' },
    ] }, { now: Date.parse('2026-11-26T14:10:00.000Z'), clip: 0 });
    expect(JSON.stringify(turns)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(formatChatlog(turns).join('\n')).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(turns[0]!.inputTag.startsWith('ghp_')).toBe(true);
  });

  test('#3 --turns 0 shows no turns (CLI)', async () => {
    const out: string[] = [];
    const code = await runFedChatlogCli({ turns: '0', json: true }, { now: () => new Date('2026-11-26T14:10:00.000Z'), out: l => out.push(l),
      collect: async () => ({ sessions: [{ seat: 'OP', sessionId: 'op000000', messages: [{ role: 'user', ts: '2026-11-26T14:00:00.000Z', content: 'a' }, { role: 'assistant', ts: '2026-11-26T14:00:01.000Z', content: 'b' }] }], mails: [], facts: {}, unmeasured: [] }) });
    expect(code).toBe(0);
    expect((JSON.parse(out[0]!) as { entries: unknown[] }).entries).toEqual([]);
  });

  test('#4 the newest turn with tool calls but no reply yet is running, not did; an older one with tools is did', () => {
    const msgs: SerializedMessage[] = [
      { role: 'user', ts: '2026-11-26T14:00:00.000Z', content: 'a' }, { role: 'tool', ts: '2026-11-26T14:00:01.000Z', content: '', toolName: 'Bash' },
      { role: 'user', ts: '2026-11-26T14:05:00.000Z', content: 'b' }, { role: 'tool', ts: '2026-11-26T14:05:01.000Z', content: '', toolName: 'Bash' },
    ];
    const turns = turnsOf({ seat: 'TC', sessionId: 'tc000000', messages: msgs }, { now: Date.parse('2026-11-26T14:06:00.000Z'), clip: 0 });
    expect(turns.map(t => t.outcome)).toEqual(['did', 'running']);
  });
});

// SIM — CAP-ECHO (11-27 · build 261127_0004 snapshot: «OP 16 turns dropped by Cap (no retry)», «UX 5» after #40312). Seeds
// 1–5 replay an hour of OP pacing: each gate refusal (`tui.autoturn rejected` with retryAt) is echoed by its caller without
// retryAt (op.requirements continue-rejected · autopilot drive-refused · tui.goal-continue decided); a few run-cap
// refusals (no retryAt) and producer «missed» rows are real drops. Expect: only those real drops count.
describe('SIM Cap drops vs echoes — seeds 1–5', () => {
  const T0 = Date.parse('2026-11-26T15:00:00.000Z');
  const row = (over: Partial<LogRowLite>): LogRowLite => ({ ts: new Date(T0).toISOString(), ts_ms: T0, level: 'info', category: 'x', event: 'y', session_id: null, data: null, ...over });
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: echoes of paced refusals are not drops; run-cap and «missed» are`, () => {
      let a = seed; const r = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; };
      const rows: LogRowLite[] = []; let real = 0;
      for (let i = 0; i < 20 + Math.floor(r() * 20); i++) {
        const d = `{"reason":"Cap","detail":"pacing:min-interval","retryAt":${T0 + 45_000},"tuiSession":"op","tuiPid":43940}`;
        rows.push(row({ category: 'tui.autoturn', event: 'rejected', data: d }));
        const echo = ['op.requirements continue-rejected', 'autopilot drive-refused', 'tui.goal-continue decided'][Math.floor(r() * 3)]!.split(' ');
        rows.push(row({ category: echo[0]!, event: echo[1]!, data: '{"reason":"Cap","tuiSession":"op","tuiPid":43940}' }));
        if (r() < 0.1) { rows.push(row({ category: 'tui.autoturn', event: 'rejected', data: '{"reason":"Cap","detail":"pacing:run-cap 5/5","tuiSession":"op","tuiPid":43940}' })); real++; }
        if (r() < 0.05) { rows.push(row({ category: 'resource', event: 'missed', data: '{"reason":"Cap","tuiSession":"op","tuiPid":43940}' })); real++; }
      }
      expect(rows.map(classifyLogRow).filter(x => x?.kind === 'cap').length).toBe(real);
    });
  }
});

// SIM — TRANSCRIPT-WINDOW (11-27 · «OP ran only 2 turns» in the 00:18 window while the log store shows a turn every
// 1–3 min). Seeds 1–5 build an OP transcript of 20–60 turns with large rows; a fixed tail covers only the last few. The
// window read grows until it reaches the window start: every turn of the window is seen.
describe('SIM transcript window — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: the read reaches back to the window start`, () => {
      let a = seed; const r = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; };
      const T0 = Date.parse('2026-11-26T15:18:00.000Z');
      const turns = 20 + Math.floor(r() * 40);
      const all: SerializedMessage[] = [];
      for (let i = 0; i < turns; i++) {
        const at = new Date(T0 - (turns - i) * 90_000).toISOString();
        all.push({ role: 'user', content: `turn ${i} ${'m'.repeat(20_000 + Math.floor(r() * 80_000))}`, ts: at } as SerializedMessage,
          { role: 'assistant', content: 'ok', ts: at } as SerializedMessage);
      }
      const sizes = all.map(m => String(m.content).length + 40);
      const tail = (_id: string, max: number): SerializedMessage[] => { let n = 0; let i = all.length; while (i > 0 && n + sizes[i - 1]! <= max) { n += sizes[--i]!; } return all.slice(i); };
      const since = T0 - 60 * 60_000;
      const inWindow = all.filter(m => m.role === 'user' && Date.parse(m.ts) >= since).length;
      const fixed = tail('s', 512 * 1024).filter(m => m.role === 'user' && Date.parse(m.ts) >= since).length;
      const grown = readTranscriptSince('s', since, 512 * 1024, tail)!.filter(m => m.role === 'user' && Date.parse(m.ts) >= since).length;
      expect(grown).toBe(inWindow);
      expect(fixed <= grown).toBe(true);
    });
  }
});
