// ELS-CHANNEL P0 — the channel log: id grammar, authority, every refusal rule, the hub (append · read · ack · wait ·
// hold/resume · restart restore) and a seeded multi-agent simulation (seeds 1..5) checking the invariants.
import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  channelAuthority, channelStem, createChannelHub, stemToId, DEFAULT_POLICY, isPingPong, judgePost, openItems, pairChannel, parseChannelId, PING_PONG_WINDOW,
  type ChannelCaller, type ChannelMessage, type ChannelMeta,
} from './channel-log.js';

const OP: ChannelCaller = { role: 'op', seat: 'OP', pane: 'p0' };
const HUMAN: ChannelCaller = { role: 'operator', human: true };
const hand = (pane: string, ws = 'w1'): ChannelCaller => ({ role: 'hand', pane, seat: `HAND-${pane}`, workspaces: [ws, `name-${ws}`] });
const tmp = (): string => mkdtempSync(join(tmpdir(), 'els-channel-'));
const parse = <T = Record<string, unknown>>(r: { message: string }): T => JSON.parse(r.message) as T;
const msg = (seq: number, pane: string, extra: Partial<ChannelMessage> = {}): ChannelMessage =>
  ({ id: `cm-${seq}-aaaaaa`, seq, at: seq * 1000, channel: 'ws:w1', type: 'say', from: { role: 'hand', pane }, body: `b${seq}`, ...extra });

describe('channel id grammar', () => {
  test('ws · run · sorted pair are accepted; anything else is refused', () => {
    expect(parseChannelId('ws:w1')).toEqual({ kind: 'ws', ws: 'w1' });
    expect(parseChannelId('run:orch-1')).toEqual({ kind: 'run', run: 'orch-1' });
    expect(parseChannelId('pair:p1+p2')).toEqual({ kind: 'pair', a: 'p1', b: 'p2' });
    expect(pairChannel('p9', 'p1')).toBe('pair:p1+p9');
    for (const bad of ['pair:p2+p1', 'pair:p1+p1', 'ws:', 'ws:../x', 'ws:a/b', 'dm:p1', 'ws:a+b', '', 'x'.repeat(200), 42]) expect(parseChannelId(bad)).toBeUndefined();
  });
});

describe('authority (ELS-CHANNEL §3-3)', () => {
  const meta: ChannelMeta = { policy: DEFAULT_POLICY, ws: 'w1' };
  test('OP and the operator reach every channel', () => {
    for (const c of [OP, HUMAN]) for (const a of ['read', 'post', 'hold', 'resume'] as const) expect(channelAuthority(c, parseChannelId('ws:w9')!, undefined, a)).toBe(true);
  });
  test('a hand pane: own workspace (id or name), own run, own pair only · never resume', () => {
    const h = hand('p1');
    expect(channelAuthority(h, parseChannelId('ws:w1')!, undefined, 'post')).toBe(true);
    expect(channelAuthority(h, parseChannelId('ws:name-w1')!, undefined, 'read')).toBe(true);
    expect(channelAuthority(h, parseChannelId('ws:w2')!, undefined, 'read')).toBe(false);
    expect(channelAuthority(h, parseChannelId('run:r1')!, meta, 'post')).toBe(true);
    expect(channelAuthority(h, parseChannelId('run:r1')!, { ...meta, ws: 'w2' }, 'read')).toBe(false);
    expect(channelAuthority(h, parseChannelId('run:r1')!, undefined, 'read')).toBe(false);
    expect(channelAuthority(h, parseChannelId('pair:p1+p7')!, undefined, 'post')).toBe(true);
    expect(channelAuthority(h, parseChannelId('pair:p2+p7')!, undefined, 'read')).toBe(false);
    expect(channelAuthority(h, parseChannelId('ws:w1')!, undefined, 'hold')).toBe(true);
    expect(channelAuthority(h, parseChannelId('ws:w1')!, undefined, 'resume')).toBe(false);
  });
});

describe('judgePost (ELS-CHANNEL §3-2)', () => {
  const meta: ChannelMeta = { policy: DEFAULT_POLICY };
  const from = { role: 'hand' as const, pane: 'p1' };
  test('paused · cap · rate · dup · turn · floor · system refusals', () => {
    expect(judgePost([], 0, { ...meta, paused: { reason: 'hold', at: 1 } }, { type: 'say', body: 'x', from }, 0)).toMatchObject({ ok: false, code: 'paused' });
    expect(judgePost([], 200, meta, { type: 'say', body: 'x', from }, 0)).toMatchObject({ ok: false, code: 'cap', pause: 'cap' });
    const six = [1, 2, 3, 4, 5, 6].map((n) => msg(n, 'p1', { at: 10_000 + n }));
    expect(judgePost(six, 6, meta, { type: 'say', body: 'new', from }, 20_000)).toMatchObject({ ok: false, code: 'rate' });
    expect(judgePost(six, 6, meta, { type: 'say', body: 'new', from }, 80_000)).toEqual({ ok: true });
    expect(judgePost([msg(1, 'p1', { body: 'hello  world' })], 1, meta, { type: 'say', body: 'hello world', from }, 90_000)).toMatchObject({ ok: false, code: 'dup' });
    expect(judgePost([msg(1, 'p1', { turn: 't1', type: 'answer' })], 1, meta, { type: 'answer', body: 'other', turn: 't1', from }, 90_000)).toMatchObject({ ok: false, code: 'turn' });
    const moderated: ChannelMeta = { policy: { ...DEFAULT_POLICY, floor: 'moderated', moderator: 'pM' } };
    expect(judgePost([], 0, moderated, { type: 'say', body: 'x', from }, 0)).toMatchObject({ ok: false, code: 'floor' });
    expect(judgePost([msg(1, 'pM', { to: ['p1'] })], 1, moderated, { type: 'answer', body: 'x', from }, 90_000)).toEqual({ ok: true });
    expect(judgePost([], 0, meta, { type: 'system', body: 'x', from }, 0)).toMatchObject({ ok: false, code: 'invalid' });
  });
  test('a person passes paused/rate/ping-pong; the server always passes', () => {
    const human = { type: 'say' as const, body: 'stop', from: { role: 'operator' as const }, human: true };
    expect(judgePost([], 0, { ...meta, paused: { reason: 'ping-pong', at: 1 } }, human, 0)).toEqual({ ok: true });
    expect(judgePost([], 999, meta, { type: 'system', body: 'x', from: { role: 'server' } }, 0)).toEqual({ ok: true });
  });
  test('ping-pong: exactly two strictly alternating senders over the window, no person/moderator/done', () => {
    const alt = Array.from({ length: PING_PONG_WINDOW }, (_, i) => msg(i + 1, i % 2 ? 'pB' : 'pA'));
    expect(isPingPong(alt)).toBe(true);
    expect(isPingPong(alt.slice(1))).toBe(false);
    expect(isPingPong(alt.map((m, i) => (i === 5 ? { ...m, human: true as const } : m)))).toBe(false);
    expect(isPingPong(alt.map((m, i) => (i === 5 ? { ...m, type: 'done' as const } : m)))).toBe(false);
    expect(isPingPong(alt, 'pA')).toBe(false);
    expect(isPingPong(alt.map((m, i) => (i === 4 ? { ...m, from: { role: 'hand' as const, pane: 'pC' } } : m)))).toBe(false);
  });
  test('open items: asks/handoffs without a later answer/done', () => {
    const items = [msg(1, 'pA', { type: 'ask' }), msg(2, 'pB', { type: 'answer', replyTo: 'cm-1-aaaaaa' }), msg(3, 'pA', { type: 'handoff', id: 'cm-3-bbbbbb' })];
    expect(openItems(items)).toEqual(['cm-3-bbbbbb']);
  });
});

describe('the hub', () => {
  test('post stamps the server-side sender, ignores request fields, appends one line per message; read and ack', async () => {
    const dir = tmp();
    try {
      const hub = createChannelHub({ dir });
      const posted = await hub.apply({ action: 'post', channel: 'ws:w1', type: 'ask', body: 'review #1?', to: ['p2'], ...({ from: { role: 'op', seat: 'OP' } } as object) }, hand('p1'));
      expect(posted.exitCode).toBe(0);
      const { id } = parse<{ id: string }>(posted);
      const read = parse<{ messages: ChannelMessage[]; open: string[] }>(await hub.apply({ action: 'read', channel: 'ws:w1' }, hand('p2')));
      expect(read.messages[0]).toMatchObject({ id, seq: 1, type: 'ask', from: { role: 'hand', pane: 'p1', seat: 'HAND-p1' }, to: ['p2'] });
      expect(read.open).toEqual([id]);
      expect((await hub.apply({ action: 'ack', channel: 'ws:w1', id }, hand('p2'))).exitCode).toBe(0);
      expect(readFileSync(join(dir, 'ws_3aw1.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
      expect(readFileSync(join(dir, 'ws_3aw1.acks.jsonl'), 'utf8')).toContain('"by":"p2"');
      expect((await hub.apply({ action: 'post', channel: 'ws:w2', body: 'x' }, hand('p1'))).exitCode).toBe(1);
      expect((await hub.apply({ action: 'post', channel: 'ws:w1', type: 'system', body: 'x' }, hand('p1'))).exitCode).toBe(1);
      expect((await hub.apply({ action: 'post', channel: 'ws:w1', body: 'x'.repeat(8_001) }, hand('p1'))).exitCode).toBe(2);
      hub.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('wait is answered by the post itself (no poll) and times out through one timer', async () => {
    const dir = tmp();
    try {
      const timers: Array<() => void> = [];
      const hub = createChannelHub({ dir, setTimer: (cb) => { timers.push(cb); return timers.length; }, clearTimer: () => {} });
      const waiting = hub.apply({ action: 'wait', channel: 'pair:p1+p2' }, hand('p2'));
      await hub.apply({ action: 'post', channel: 'pair:p1+p2', type: 'answer', body: 'done', to: ['p2'] }, hand('p1'));
      expect(parse<{ message: ChannelMessage }>(await waiting).message).toMatchObject({ seq: 1, body: 'done' });
      const idle = hub.apply({ action: 'wait', channel: 'pair:p1+p2', after: 1 }, hand('p2'));
      timers[timers.length - 1]!();
      expect(parse<{ timeout?: boolean; after?: number }>(await idle)).toEqual({ timeout: true, after: 1 });
      const notMine = hub.apply({ action: 'wait', channel: 'pair:p1+p2', after: 1 }, hand('p2'));
      await hub.apply({ action: 'post', channel: 'pair:p1+p2', body: 'for someone else', to: ['p9'] }, hand('p1'));
      hub.dispose();
      expect(parse<{ timeout?: boolean; after?: number }>(await notMine)).toEqual({ timeout: true, after: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('ping-pong pauses the channel with a server line; a person speaks, OP resumes', async () => {
    const dir = tmp();
    let t = 0;
    try {
      const hub = createChannelHub({ dir, now: () => (t += 20_000) });
      let refused: Record<string, unknown> | undefined;
      for (let i = 0; i < PING_PONG_WINDOW + 2 && !refused; i++) {
        const r = await hub.apply({ action: 'post', channel: 'ws:w1', type: 'answer', body: `round ${i}` }, hand(i % 2 ? 'pB' : 'pA'));
        if (r.exitCode !== 0) refused = parse(r);
      }
      expect(refused).toMatchObject({ refused: 'ping-pong' });
      const read = parse<{ paused: { reason: string }; messages: ChannelMessage[] }>(await hub.apply({ action: 'read', channel: 'ws:w1', limit: 200, after: 0 }, OP));
      expect(read.paused.reason).toBe('ping-pong');
      expect(read.messages.at(-1)).toMatchObject({ type: 'system', from: { role: 'server' } });
      expect(parse(await hub.apply({ action: 'post', channel: 'ws:w1', body: 'agent again' }, hand('pA')))).toMatchObject({ refused: 'paused' });
      expect((await hub.apply({ action: 'post', channel: 'ws:w1', body: 'person here' }, HUMAN)).exitCode).toBe(0);
      expect((await hub.apply({ action: 'resume', channel: 'ws:w1' }, hand('pA'))).exitCode).toBe(1);
      expect((await hub.apply({ action: 'resume', channel: 'ws:w1' }, OP)).exitCode).toBe(0);
      expect((await hub.apply({ action: 'post', channel: 'ws:w1', body: 'agent after resume' }, hand('pA'))).exitCode).toBe(0);
      hub.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('restart restores seq, pause and policy from the files; list shows only readable channels', async () => {
    const dir = tmp();
    try {
      const a = createChannelHub({ dir });
      expect((await a.apply({ action: 'open', channel: 'run:r1', policy: { floor: 'moderated', moderator: 'pM', maxMessages: 50 } }, hand('pM'))).exitCode).toBe(0);
      expect((await a.apply({ action: 'open', channel: 'run:r1' }, hand('pM'))).exitCode).toBe(1);
      await a.apply({ action: 'post', channel: 'run:r1', type: 'ask', body: 'topic', to: ['p1'] }, hand('pM'));
      await a.apply({ action: 'post', channel: 'ws:w2', body: 'elsewhere' }, OP);
      await a.apply({ action: 'hold', channel: 'ws:w2' }, OP);
      a.dispose();
      const b = createChannelHub({ dir });
      expect(parse(await b.apply({ action: 'post', channel: 'run:r1', type: 'answer', body: 'mine', replyTo: 'cm-1-000000' }, hand('p1')))).toMatchObject({ seq: 2 });
      expect(parse(await b.apply({ action: 'post', channel: 'run:r1', body: 'not addressed' }, hand('p3')))).toMatchObject({ refused: 'floor' });
      const mine = parse<{ channels: Array<{ channel: string }> }>(await b.apply({ action: 'list' }, hand('p1'))).channels.map((c) => c.channel);
      expect(mine).toEqual(['run:r1']);
      const all = parse<{ channels: Array<{ channel: string; paused?: string }> }>(await b.apply({ action: 'list' }, OP)).channels;
      expect(all.find((c) => c.channel === 'ws:w2')?.paused).toContain('hold');
      b.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Terra #40282 regressions', () => {
  test('must-1: the file stem is injective — ws:a:b and ws:a_b never share a file, and each pane sees only its own', async () => {
    // 출처: Terra #40282 must-1 — the literal stems are written out here, not computed from the product function.
    expect(channelStem('ws:a:b')).toBe('ws_3aa_3ab');
    expect(channelStem('ws:a_b')).toBe('ws_3aa_5fb');
    expect(channelStem('pair:p1+p2')).toBe('pair_3ap1_2bp2');
    for (const id of ['ws:a:b', 'ws:a_b', 'pair:p1+p2', 'run:x.y-z']) expect(stemToId(channelStem(id))).toBe(id);
    expect(stemToId('ws_3Aa')).toBeUndefined();
    expect(stemToId('ws:a')).toBeUndefined();
    const dir = tmp();
    try {
      const hub = createChannelHub({ dir });
      const inColon = hand('pc', 'a:b'), inUnderscore = hand('pu', 'a_b');
      expect((await hub.apply({ action: 'post', channel: 'ws:a:b', body: 'colon secret' }, inColon)).exitCode).toBe(0);
      expect((await hub.apply({ action: 'post', channel: 'ws:a_b', body: 'underscore note' }, inUnderscore)).exitCode).toBe(0);
      const seenByUnderscore = parse<{ messages: ChannelMessage[] }>(await hub.apply({ action: 'read', channel: 'ws:a_b' }, inUnderscore)).messages.map((m) => m.body);
      expect(seenByUnderscore).toEqual(['underscore note']);
      expect((await hub.apply({ action: 'read', channel: 'ws:a:b' }, inUnderscore)).exitCode).toBe(1);
      expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()).toEqual(['ws_3aa_3ab.jsonl', 'ws_3aa_5fb.jsonl']);
      hub.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('must-2: a torn tail is cut before the next append — restart, re-append, nothing glued or dropped, seq not reused', async () => {
    const dir = tmp();
    try {
      const a = createChannelHub({ dir });
      await a.apply({ action: 'post', channel: 'ws:w1', body: 'first' }, OP);
      a.dispose();
      appendFileSync(join(dir, 'ws_3aw1.jsonl'), '{"id":"cm-2-torn", "seq":2');
      const b = createChannelHub({ dir });
      expect(parse(await b.apply({ action: 'post', channel: 'ws:w1', body: 'second' }, OP))).toMatchObject({ seq: 2 });
      expect(parse(await b.apply({ action: 'post', channel: 'ws:w1', body: 'third' }, HUMAN))).toMatchObject({ seq: 3 });
      b.dispose();
      const c = createChannelHub({ dir });
      const bodies = parse<{ messages: ChannelMessage[]; lastSeq: number }>(await c.apply({ action: 'read', channel: 'ws:w1', after: 0 }, OP));
      expect([bodies.lastSeq, bodies.messages.map((m) => `${m.seq}:${m.body}`)]).toEqual([3, ['1:first', '2:second', '3:third']]);
      expect(readFileSync(join(dir, 'ws_3aw1.jsonl'), 'utf8').includes('torn')).toBe(false);
      c.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('must-3: a channel created by open (meta only, no messages yet) is listed', async () => {
    const dir = tmp();
    try {
      const hub = createChannelHub({ dir });
      expect((await hub.apply({ action: 'open', channel: 'run:empty', ws: 'w1' }, OP)).exitCode).toBe(0);
      hub.dispose();
      const again = createChannelHub({ dir });
      expect(parse<{ channels: Array<{ channel: string; lastSeq: number }> }>(await again.apply({ action: 'list' }, OP)).channels).toEqual([{ channel: 'run:empty', lastSeq: 0, open: 0 } as never]);
      again.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('must-4 + should: an ask older than the memory window stays open, ackable and reachable by an old wait cursor', async () => {
    const dir = tmp();
    const OLD_SPAN = 260; // 출처: Terra #40282 must-4 — more messages than the 200-message memory window
    try {
      const a = createChannelHub({ dir });
      const ask = parse<{ id: string }>(await a.apply({ action: 'post', channel: 'ws:w1', type: 'ask', body: 'old question' }, hand('p1'))).id;
      for (let i = 0; i < OLD_SPAN; i++) expect((await a.apply({ action: 'post', channel: 'ws:w1', body: `chatter ${i}` }, HUMAN)).exitCode).toBe(0);
      expect(parse<{ open: string[] }>(await a.apply({ action: 'read', channel: 'ws:w1' }, OP)).open).toEqual([ask]);
      a.dispose();
      const b = createChannelHub({ dir });
      expect(parse<{ open: string[] }>(await b.apply({ action: 'read', channel: 'ws:w1' }, OP)).open).toEqual([ask]);
      expect((await b.apply({ action: 'ack', channel: 'ws:w1', id: ask }, hand('p2'))).exitCode).toBe(0);
      expect(parse<{ message: ChannelMessage }>(await b.apply({ action: 'wait', channel: 'ws:w1', after: 0 }, hand('p2'))).message.body).toBe('old question');
      expect((await b.apply({ action: 'post', channel: 'ws:w1', type: 'answer', body: 'late answer', replyTo: ask }, HUMAN)).exitCode).toBe(0); // past the 200 cap only a person posts
      expect(parse<{ open: string[] }>(await b.apply({ action: 'read', channel: 'ws:w1' }, OP)).open).toEqual([]);
      b.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── seeded simulation: N agents in one workspace + a person, random posts/acks/waits ─────────────────────────────────
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('sim — invariants hold for seeds 1..5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, async () => {
      const dir = tmp();
      const r = rng(seed);
      let clock = 0;
      try {
        const hub = createChannelHub({ dir, now: () => clock });
        const agents = ['pA', 'pB', 'pC', 'pD'].map((p) => hand(p));
        const outsider = hand('pX', 'w9');
        const delivered: ChannelMessage[] = [];
        hub.onPost((m) => delivered.push(m));
        let waits = 0, waitHits = 0, refusals = 0, pauses = 0;
        for (let step = 0; step < 400; step++) {
          clock += Math.floor(r() * 15_000);
          const roll = r();
          if (roll < 0.03) {
            const res = await hub.apply({ action: 'post', channel: 'ws:w1', body: `person ${step}` }, HUMAN);
            expect(res.exitCode).toBe(0);
            await hub.apply({ action: 'resume', channel: 'ws:w1' }, HUMAN);
            continue;
          }
          if (roll < 0.06) { expect((await hub.apply({ action: 'post', channel: 'ws:w1', body: 'sneak' }, outsider)).exitCode).toBe(1); continue; }
          if (roll < 0.15) {
            waits++;
            const who = agents[Math.floor(r() * agents.length)]!;
            const w = hub.apply({ action: 'wait', channel: 'ws:w1', timeoutMs: 1 }, who);
            const poster = agents.find((a) => a !== who)!;
            const p = await hub.apply({ action: 'post', channel: 'ws:w1', body: `wake ${step}`, to: [who.pane!] }, poster);
            const got = parse<{ message?: ChannelMessage; timeout?: true }>(await w);
            if (p.exitCode === 0) { expect(got.message?.body).toBe(`wake ${step}`); waitHits++; } else refusals++;
            continue;
          }
          // two agents favoured → ping-pong pressure; occasional repeats → dup pressure
          const pick = r() < 0.7 ? agents[step % 2]! : agents[Math.floor(r() * agents.length)]!;
          const body = r() < 0.1 ? 'same text' : `msg ${step} ${Math.floor(r() * 1e6)}`;
          const res = await hub.apply({ action: 'post', channel: 'ws:w1', type: r() < 0.3 ? 'ask' : 'answer', body }, pick);
          if (res.exitCode !== 0) {
            const why = parse<{ refused: string }>(res).refused;
            expect(['rate', 'dup', 'ping-pong', 'paused', 'cap']).toContain(why);
            refusals++;
            if (why === 'ping-pong' || why === 'cap') pauses++;
          }
        }
        hub.dispose();
        // Invariants: seq is 1..N without gaps, the file equals the delivered stream, no message from the outsider,
        // no two strictly alternating agent-only windows ever got through, every sender is server-stamped.
        const lines = readFileSync(join(dir, 'ws_3aw1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ChannelMessage);
        expect(lines.map((m) => m.seq)).toEqual(lines.map((_, i) => i + 1));
        expect(lines.map((m) => m.id)).toEqual(delivered.filter((m) => m.channel === 'ws:w1').map((m) => m.id));
        expect(lines.some((m) => m.from.pane === 'pX')).toBe(false);
        for (let i = PING_PONG_WINDOW; i <= lines.length; i++) expect(isPingPong(lines.slice(i - PING_PONG_WINDOW, i).filter((m) => m.type !== 'system'))).toBe(false);
        expect(lines.every((m) => m.from.role === 'server' || m.from.role === 'operator' || /^p[A-D]$/.test(m.from.pane ?? ''))).toBe(true);
        expect(waitHits).toBeGreaterThan(0);
        expect(refusals).toBeGreaterThan(0);
        expect(waits).toBeGreaterThan(0);
        expect(pauses).toBeGreaterThanOrEqual(0);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
