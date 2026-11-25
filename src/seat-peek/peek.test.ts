// ELS-PEEK-WATCH — fixtures are literals (screens incl. invalid UTF-8, a 20-turn session, mail windows); no expectation is
// built from the product's own constants or renderers.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  clip, createTranscriptTail, decodeUtf8, isNoiseLine, lastTurns, lineKey, mailLine, mailSince, newScreenLines, paneSession,
  parsePsParents, parseTranscript, recentMail, resolvePane, sanitizeLine, screenTail, type PeekMail, type PeekManifestRow, type PeekPaneRow,
} from './peek.js';
import { parseInterval, runPeek, runWatch } from '../cli/els-peek-cli.js';

// Local-time rendering is asserted in UTC; the previous zone is restored for the next file.
const previousTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'UTC'; });
afterAll(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// A 20-turn session: user «question N», assistant 3 lines, and on even turns one tool row.
function twentyTurns(): string {
  const rows: string[] = [JSON.stringify({ role: 'system', content: 'boot', ts: '2026-11-25T08:00:00.000Z' })];
  for (let n = 1; n <= 20; n++) {
    const mm = String(n).padStart(2, '0');
    rows.push(JSON.stringify({ role: 'user', content: `question ${n}`, ts: `2026-11-25T09:${mm}:00.000Z` }));
    if (n % 2 === 0) rows.push(JSON.stringify({ role: 'tool', content: '', toolName: 'Bash', toolArgs: { command: `ls ${n}` }, toolResult: `ok ${n}`, ts: `2026-11-25T09:${mm}:10.000Z` }));
    rows.push(JSON.stringify({ role: 'assistant', content: `answer ${n} line a\nanswer ${n} line b\n\nanswer ${n} line c`, ts: `2026-11-25T09:${mm}:30.000Z` }));
  }
  return `${rows.join('\n')}\n`;
}

const PANES: PeekPaneRow[] = [
  { pane: 'p1', address: 'mshq:w1/t1/p1', title: 'OP', workspace: 'w1', tab: 't1', state: 'exited', reach: 'local', kind: 'eln', pid: 100 },
  { pane: 'p2', address: 'mshq:w1/t2/p2', title: 'OP', workspace: 'w1', tab: 't2', state: 'idle', reach: 'local', kind: 'eln', pid: 200,
    fgCommand: ['bun', 'elanous.mjs', '--resume', 'argv-session-0001'], status: { state: 'IDLE' }, model: 'gpt-x' },
  { pane: 'p3', address: 'node-b:w9/t9/p3', title: 'TC-H-CX-2', workspace: 'w9', tab: 't9', state: 'working', reach: 'remote', kind: 'eln', host: 'node-b' },
];

describe('text hygiene', () => {
  test('invalid UTF-8 bytes decode to U+FFFD and never throw', () => {
    const bytes = concat(enc('ok '), new Uint8Array([0xff, 0xfe, 0xc3]), enc(' 한글'));
    expect(decodeUtf8(bytes)).toBe('ok ��� 한글');
  });
  test('sanitizeLine drops ANSI and control bytes and repairs lone surrogates', () => {
    expect(sanitizeLine('\x1b[31mred\x1b[0m\x07 bell\x00')).toBe('red bell');
    expect(sanitizeLine('a\ud800b')).toBe('a�b');
  });
  test('clip counts code points, so an emoji pair is never cut', () => {
    expect(clip('ab😀cd', 4)).toBe('ab😀…');
    expect(clip('short', 10)).toBe('short');
  });
});

describe('pane resolution', () => {
  test('a title picks the live pane over the exited one', () => {
    const hit = resolvePane(PANES, 'op');
    expect(hit.ok && hit.row.pane).toBe('p2');
  });
  test('pane id, ws/tab/pane and host:ws/tab/pane all resolve', () => {
    expect(resolvePane(PANES, 'p3').ok).toBe(true);
    const short = resolvePane(PANES, 'w9/t9/p3');
    expect(short.ok && short.row.title).toBe('TC-H-CX-2');
    const full = resolvePane(PANES, 'node-b:w9/t9/p3');
    expect(full.ok && full.row.pane).toBe('p3');
  });
  test('an unknown name is an error, not a guess', () => {
    expect(resolvePane(PANES, 'NOPE')).toEqual({ ok: false, message: 'no pane titled NOPE (try `els ls`)' });
  });
});

describe('pane → session', () => {
  const ps = parsePsParents('  200     1\n  201   200\n  202   201\n  300     1\n');
  const manifest: PeekManifestRow[] = [
    { id: 'tui:300', kind: 'tui', ownerPid: 300, sessionId: 'other-seat', alive: true, closedAt: 0, updatedAt: 9 },
    { id: 'tui:202', kind: 'tui', ownerPid: 202, sessionId: 'live-session-xyz', alive: true, closedAt: 0, updatedAt: 5 },
    { id: 'tui:201', kind: 'tui', ownerPid: 201, sessionId: 'closed-one', alive: false, closedAt: 3, updatedAt: 8 },
  ];
  test('the eln below the pane process reports its session through the manifest (grandchild found)', () => {
    expect(paneSession({ panePid: 200, parents: ps, manifest, fgCommand: ['eln', '--resume', 'argv-session-0001'] }))
      .toEqual({ sessionId: 'live-session-xyz', source: 'pty-manifest', pid: 202 });
  });
  test('no manifest row → the --resume id it was started with', () => {
    expect(paneSession({ panePid: 999, parents: ps, manifest, fgCommand: ['bun', 'elanous.mjs', '--resume', 'argv-session-0001'] }))
      .toEqual({ sessionId: 'argv-session-0001', source: 'argv' });
    expect(paneSession({ parents: ps, manifest: [], fgCommand: ['eln', '--session=abc-123'] })).toEqual({ sessionId: 'abc-123', source: 'argv' });
  });
  test('nothing reported → undefined (never another seat\'s session)', () => {
    expect(paneSession({ panePid: 999, parents: ps, manifest, fgCommand: ['zsh'] })).toBeUndefined();
  });
});

describe('session history', () => {
  test('20 turns → the last 3, tools hidden, lines clipped per turn', () => {
    const { messages, skipped } = parseTranscript(enc(`${twentyTurns()}not json\n`));
    expect(skipped).toBe(1);
    const turns = lastTurns(messages, { turns: 3, lines: 2, tools: false, width: 100 });
    expect(turns.map((t) => t.index)).toEqual([18, 19, 20]);
    expect(turns[2]!.rows).toEqual([
      { role: 'user', at: '09:20:00', lines: ['question 20'] },
      { role: 'assistant', at: '09:20:30', lines: ['answer 20 line a'] },
    ]);
    expect(turns[2]!.clipped).toBe(2);
  });
  test('--tools adds one line per tool row', () => {
    const { messages } = parseTranscript(enc(twentyTurns()));
    const [turn] = lastTurns(messages, { turns: 1, lines: 10, tools: true, width: 100 });
    expect(turn!.rows[1]).toEqual({ role: 'tool', at: '09:20:10', lines: ['⚙ Bash {"command":"ls 20"} → ok 20'] });
  });
  test('a transcript with invalid bytes still parses the valid lines', () => {
    const bad = concat(enc('{"role":"user","content":"hi '), new Uint8Array([0xff]), enc('","ts":"2026-11-25T01:02:03Z"}\n'));
    expect(parseTranscript(bad).messages[0]!.content).toBe('hi �');
  });
  test('the incremental tail waits for a whole line, even when a chunk splits a code point', () => {
    const tail = createTranscriptTail();
    const line = enc('{"role":"assistant","content":"한","ts":"2026-11-25T00:00:00Z"}\n');
    expect(tail.push(line.slice(0, 33))).toEqual([]);
    expect(tail.push(line.slice(33)).map((m) => m.content)).toEqual(['한']);
  });
});

describe('screen', () => {
  const screen1 = ['[screen 80x24 cursor=(row 11, col 0, visible true)]', 'working on it', '⠋ Thinking 12s', '──────────', 'codex default 4% · team 76% │ OR $913 left', 'Queue 0 · Bg 9', '❯ ', 'line A'].join('\n');
  const screen2 = ['working on it', '⠙ Thinking 13s', 'line A', 'line B', 'esc to interrupt', 'line \xff C'].join('\n');
  test('footer, rule, prompt and usage rows are noise', () => {
    expect(screenTail(screen1, 10, 80)).toEqual(['working on it', '⠋ Thinking 12s', 'line A']);
    expect(isNoiseLine('12.3k tokens')).toBe(true);
    expect(isNoiseLine('plain text')).toBe(false);
  });
  test('spinner and clock changes are the same line', () => {
    expect(lineKey('⠋ Thinking 12s')).toBe(lineKey('⠙ Thinking 13s'));
  });
  test('only new lines are emitted, and a repeated line once', () => {
    const recent = new Set<string>();
    const prev = screenTail(screen1, 50, 200);
    const cur = screenTail(screen2, 50, 200);
    expect(newScreenLines(prev, cur, recent)).toEqual(['line B', 'line \xff C']);
    expect(newScreenLines(['x'], cur, recent)).toEqual(['working on it', '⠙ Thinking 13s', 'line A']);
    expect(newScreenLines([], cur, recent)).toEqual([]);
  });
});

describe('mail window', () => {
  // 2500 mails, ids 1..2500: every 100th is to OP, every 250th from OP to TC.
  const all: PeekMail[] = Array.from({ length: 2500 }, (_, i) => {
    const id = i + 1;
    return { id, from: id % 250 === 0 ? 'OP' : 'X', to: id % 100 === 0 ? 'OP' : id % 250 === 0 ? 'TC' : 'Y', kind: 'info', body: `body ${id}\nsecond`, createdAt: '2026-11-25T09:30:00.000Z' };
  });
  const calls: number[] = [];
  const source = { latestId: () => 2500, listAfter: (after: number, limit: number) => { calls.push(after); return all.filter((m) => m.id > after).slice(0, limit); } };
  test('the newest mails are found by walking back from the latest id (msg list is oldest-first)', () => {
    calls.length = 0;
    const got = recentMail(source, 'op', 3, { step: 1000 });
    expect(got.received.map((m) => m.id)).toEqual([2300, 2400, 2500]);
    expect(got.sent.map((m) => m.id)).toEqual([1250, 1750, 2250]);
    expect(calls).toEqual([1500, 500]);
  });
  test('a mail line is one line with local time', () => {
    expect(mailLine(all[99]!, 80)).toBe('#100 09:30 X→OP [info] body 100 second');
  });
  test('mailSince returns the mails touching the seat after a cursor', () => {
    const got = mailSince(source, 'OP', 2350);
    expect(got.mails.map((m) => m.id)).toEqual([2400, 2500]);
    expect(got.last).toBe(2500);
  });
});

describe('runners (fake els, fake store)', () => {
  const session = enc(twentyTurns());
  const deps = (screens: string[], out: string[]) => {
    let reads = 0;
    return {
      listPanes: async () => PANES,
      readScreen: async () => ({ ok: true, text: screens[Math.min(reads++, screens.length - 1)]! }),
      out: (line: string) => { out.push(line); },
      err: (line: string) => { out.push(`ERR ${line}`); },
      psParents: () => parsePsParents('200 1\n'),
      manifestRows: () => [],
      sessionBytes: (id: string) => id === 'argv-session-0001' ? session : null,
      mail: () => ({ latestId: () => 3, listAfter: (after: number) => [
        { id: 1, from: 'TC', to: 'OP', kind: 'ask', body: 'ping', createdAt: '2026-11-25T09:00:00Z' },
        { id: 2, from: 'OP', to: 'TC', kind: 'reply', body: 'pong', createdAt: '2026-11-25T09:01:00Z' },
        { id: 3, from: 'UX', to: 'MK', kind: 'info', body: 'other', createdAt: '2026-11-25T09:02:00Z' },
      ].filter((m) => m.id > after) }),
      now: () => new Date('2026-11-25T10:00:00Z'),
    };
  };
  test('peek prints state, turns, screen and both mail lists', async () => {
    const out: string[] = [];
    const code = await runPeek('OP', { turns: 2, lines: 2, mail: 5 }, deps(['hello\n\xff\xfe bad bytes'], out));
    expect(code).toBe(0);
    expect(out).toEqual([
      '━━━━ OP · mshq:w1/t2/p2 · IDLE · eln · gpt-x · 10:00:00 ━━━━',
      '━━━━ session argv-ses (argv) · last 2 turn(s) · ≤2 lines each ━━━━',
      '── turn 19 ──', '  user @ 09:19:00', '    question 19', '  assistant @ 09:19:30', '    answer 19 line a', '    … 2 more line(s) (raise --lines)',
      '── turn 20 ──', '  user @ 09:20:00', '    question 20', '  assistant @ 09:20:30', '    answer 20 line a', '    … 2 more line(s) (raise --lines)',
      '━━━━ screen (last 2 lines) ━━━━', 'hello', '\xff\xfe bad bytes',
      '━━━━ mail to OP (last 1) ━━━━', '#1 09:00 TC→OP [ask] ping',
      '━━━━ mail from OP (last 1) ━━━━', '#2 09:01 OP→TC [reply] pong',
    ]);
  });
  test('peek --json is one object; a remote pane says where its session lives', async () => {
    const out: string[] = [];
    expect(await runPeek('TC-H-CX-2', { json: true, mail: 0 }, deps(['x'], out))).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as { session: unknown; sessionNote: string; screen: string[] };
    expect(parsed.session).toBeNull();
    expect(parsed.sessionNote).toBe("session history is read on the pane's own host (node-b); showing screen and mail only");
    expect(parsed.screen).toEqual(['x']);
  });
  test('bad numbers are refused before anything is read', async () => {
    const out: string[] = [];
    expect(await runPeek('OP', { turns: 'many' }, deps(['x'], out))).toBe(2);
    expect(out).toEqual(['ERR els peek: --turns must be a whole number ≥ 0 (got many)']);
  });
  test('watch streams new lines and ✉ mail, then stops on abort', async () => {
    const out: string[] = [];
    const controller = new AbortController();
    let ticks = 0;
    const base = deps(['a\nb', 'a\nb\n⠋ busy 1s', 'a\nb\n⠙ busy 2s\nc'], out);
    const mailCalls: number[] = [];
    const code = await runWatch('OP', { interval: '1s', mail: true }, { ...base,
      mail: () => ({ latestId: () => 1, listAfter: (after: number) => { mailCalls.push(after); return after < 2 ? [{ id: 2, from: 'OP', to: 'TC', kind: 'reply', body: 'pong', createdAt: '2026-11-25T09:01:00Z' }] : []; } }),
      signal: controller.signal, sleep: async () => { if (++ticks >= 3) controller.abort(); } });
    expect(code).toBe(0);
    expect(out).toEqual([
      '━━━━ watch OP · mshq:w1/t2/p2 · every 1s · mail after #1 · Ctrl-C ends · read-only ━━━━',
      '10:00:00 │ a', '10:00:00 │ b', '10:00:00 │ ✉ #2 09:01 OP→TC [reply] pong',
      '10:00:00 │ ⠋ busy 1s',
      '10:00:00 │ c',
    ]);
  });
  test('interval parsing', () => {
    expect(parseInterval('3s')).toBe(3000);
    expect(parseInterval('500ms')).toBe(500);
    expect(parseInterval('100ms')).toBe(500);
    expect(parseInterval('1m')).toBe(60000);
    expect(() => parseInterval('soon')).toThrow('--interval: use 3s, 500ms or 1m (got soon)');
  });
});
