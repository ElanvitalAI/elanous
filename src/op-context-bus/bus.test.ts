// OP-CONTEXT-BUS — typed append-only stream · CEO-line dedupe across surfaces · decision conflicts · ack cursor and
// catch-up · bounded digest · rollup keeps pinned types · cross-process concurrency · `--as` claims (proxy grant).
// Independent literals (never the product's constants).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { ackCursor, busAck, busDigest, busPost, captureCeoLine, catchUp, readAcks, readBus, watchBus } from './bus.js';
import { checkBusClaim, registerBusCommands } from '../cli/bus-cli.js';
import { verifyProxyCaller, writeProxyGrant, type ProcInfo, type ProcLookup } from '../proxy/proxy-identity.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function root(): string { const d = mkdtempSync(join(tmpdir(), 'op-bus-')); dirs.push(d); return d; }
const T0 = Date.parse('2026-11-26T19:00:00Z');
const MIN = 60_000; // 출처: 내부 문서 `CLAUDE-OP-PROXY` §A4 — one minute in ms, the sim clock unit

describe('post · dedupe · conflict', () => {
  test('the same CEO words from telegram then tui are one item with two surfaces; the same surface again is a no-op', () => {
    const r = root();
    const a = busPost(r, { type: 'ceo-request', from: 'CEO', body: 'Ship the demo build  at 20:45', source: 'telegram' }, { now: T0 });
    const b = busPost(r, { type: 'ceo-request', from: 'CLAUDE-OP', body: 'ship the demo build at 20:45', source: 'tui' }, { now: T0 + MIN });
    const c = busPost(r, { type: 'ceo-request', from: 'CEO', body: 'Ship the demo build at 20:45', source: 'telegram' }, { now: T0 + 2 * MIN });
    expect(a.kind).toBe('posted');
    expect(b.kind === 'also' && b.source).toBe('tui');
    expect(c.kind).toBe('duplicate');
    const items = readBus(r);
    expect(items.map((i) => [i.type, i.source, i.alsoFrom])).toEqual([['ceo-request', 'telegram', ['tui']]]);
  });
  test('two different decisions on the same ref are both kept; the later is marked conflictsWith the earlier', () => {
    const r = root();
    const d1 = busPost(r, { type: 'decision', from: 'OP', body: 'land #40270 after the demo', refs: ['pr:40270'] }, { now: T0 });
    const same = busPost(r, { type: 'decision', from: 'CLAUDE-OP', body: 'Land #40270 after the demo', refs: ['pr:40270'] }, { now: T0 + MIN });
    const d2 = busPost(r, { type: 'decision', from: 'CLAUDE-OP', body: 'hold #40270 until JUD reads it', refs: ['pr:40270'] }, { now: T0 + 2 * MIN });
    expect(same.kind === 'posted' && same.conflict).toBeUndefined();
    // the later decision is marked against the newest differing decision on that ref (here the restated one)
    expect(d1.kind === 'posted' && same.kind === 'posted' && d2.kind === 'posted' && d2.conflict).toBe(same.kind === 'posted' ? same.entry.id : '');
    expect(readBus(r).length).toBe(3);
  });
  test('closed type set · a commitment needs owner and done-when · a ceo-request needs a surface', () => {
    const r = root();
    expect(() => busPost(r, { type: 'memo' as never, from: 'OP', body: 'x' })).toThrow('bus post: unknown --type "memo"');
    expect(() => busPost(r, { type: 'commitment', from: 'OP', body: 'rail at 22:00' })).toThrow('bus post: a commitment needs --owner and --done-when');
    expect(() => busPost(r, { type: 'ceo-request', from: 'CEO', body: 'go' })).toThrow('bus post: a ceo-request needs --source');
    expect(captureCeoLine(' Telegram ', '  go live  ')).toEqual({ type: 'ceo-request', from: 'CEO', body: 'go live', source: 'telegram' });
    expect(captureCeoLine('web', '   ')).toBeNull();
  });
  test('ids are monotonic in log order even when the clock steps back', () => {
    const r = root();
    busPost(r, { type: 'status', from: 'OP', body: 'a' }, { now: T0 + 5 * MIN });
    busPost(r, { type: 'status', from: 'OP', body: 'b' }, { now: T0 });
    const ids = readBus(r).map((i) => i.id);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('ack · catch-up · digest', () => {
  test('after an OP restart, catch-up = the items after its own last ack', () => {
    const r = root();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { const p = busPost(r, { type: 'status', from: 'CLAUDE-OP', body: `s${i}` }, { now: T0 + i * MIN }); if (p.kind === 'posted') ids.push(p.entry.id); }
    busAck(r, ids[2]!, 'op', { now: T0 + 10 * MIN });
    expect(ackCursor(readAcks(r), 'OP')).toBe(ids[2]!);
    expect(catchUp(r, 'OP').map((i) => i.body)).toEqual(['s3', 's4']);
    expect(catchUp(r, 'CLAUDE-OP').map((i) => i.body)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(() => busAck(r, 'b-nope', 'OP')).toThrow('bus ack: no item b-nope');
  });
  test('digest: CEO words pinned first, then decisions/commitments, newest first; ✓/· = the other side acked; ⚠ conflicts; bounded', () => {
    const r = root();
    busPost(r, { type: 'status', from: 'OP', body: 'rail green' }, { now: T0 });
    const d1 = busPost(r, { type: 'decision', from: 'OP', body: 'cut at 04:00', refs: ['rail:0.3.39'] }, { now: T0 + MIN });
    busPost(r, { type: 'ceo-request', from: 'CEO', body: 'demo build only', source: 'telegram' }, { now: T0 + 2 * MIN });
    busPost(r, { type: 'decision', from: 'CLAUDE-OP', body: 'cut at 05:00', refs: ['rail:0.3.39'] }, { now: T0 + 3 * MIN });
    busPost(r, { type: 'commitment', from: 'OP', body: 'rehearse', owner: 'REL', due: '22:00', doneWhen: 'hard rehearsal green' }, { now: T0 + 4 * MIN });
    if (d1.kind === 'posted') busAck(r, d1.entry.id, 'CLAUDE-OP', { now: T0 + 5 * MIN });
    const text = busDigest(r, { forSeat: 'OP' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('<op_context_bus space="OP" new="5">');
    expect(lines.slice(1, 6).map((l) => l.split(' ').slice(2, 4).join(' '))).toEqual(['ceo-request CEO@telegram:', 'commitment OP:', 'decision CLAUDE-OP', 'decision OP:', 'status OP:']);
    expect(lines[3]).toContain('⚠ conflicts');
    expect(lines.slice(1, 6).map((l) => l[0])).toEqual(['·', '·', '·', '✓', '✓']);
    expect(lines[2]).toContain('(owner REL · due 22:00 · done when hard rehearsal green)');
    expect(lines.at(-1)).toBe('</op_context_bus>');
    for (let i = 0; i < 60; i++) busPost(r, { type: 'opinion', from: 'CLAUDE-OP', body: `long opinion ${i} `.repeat(8) }, { now: T0 + (10 + i) * MIN });
    const bounded = busDigest(r, { forSeat: 'OP', maxChars: 1200 });
    expect(bounded.length).toBeLessThanOrEqual(1200);
    expect(bounded.split('\n')[1]).toContain('ceo-request');
    expect(bounded).toMatch(/… \d+ more \(eln bus since -\)/);
    expect(busDigest(root(), { forSeat: 'OP' })).toBe('');
  });
  test('watch is event-driven: a post from elsewhere arrives without polling', async () => {
    const r = root();
    busPost(r, { type: 'status', from: 'OP', body: 'before' }, { now: T0 });
    const got: string[] = [];
    const arrived = new Promise<void>((resolve) => {
      const stop = watchBus(r, (items) => { got.push(...items.map((i) => i.body)); stop(); resolve(); });
    });
    busPost(r, { type: 'handoff', from: 'CLAUDE-OP', body: 'after' }, { now: T0 + MIN });
    // fs.watch delivery can lag under a loaded test host: wait up to 10 s (the test itself allows 15 s).
    await Promise.race([arrived, new Promise((res) => setTimeout(res, 10_000))]);
    expect(got).toEqual(['after']);
  }, 15_000);
});

describe('rollup', () => {
  test('past the line cap, old status/opinion fold into one row per day; ceo-request/decision/commitment/handoff stay', () => {
    const r = root();
    const DAY = 24 * 60 * MIN;
    busPost(r, { type: 'ceo-request', from: 'CEO', body: 'keep me', source: 'web' }, { now: T0 - 2 * DAY });
    busPost(r, { type: 'decision', from: 'OP', body: 'keep this decision', refs: ['cell:A1'] }, { now: T0 - 2 * DAY + MIN });
    busPost(r, { type: 'commitment', from: 'OP', body: 'keep this promise', owner: 'TC', doneWhen: 'merged' }, { now: T0 - 2 * DAY + 2 * MIN });
    for (let i = 0; i < 6; i++) busPost(r, { type: 'status', from: 'OP', body: `old ${i}` }, { now: T0 - 2 * DAY + (3 + i) * MIN, maxLines: 1000 });
    for (let i = 0; i < 3; i++) busPost(r, { type: 'opinion', from: 'CLAUDE-OP', body: `older ${i}` }, { now: T0 - DAY + i * MIN, maxLines: 1000 });
    const last = readBus(r).at(-1)!.id;
    busAck(r, last, 'OP', { now: T0 - MIN });
    busPost(r, { type: 'status', from: 'OP', body: 'unseen by CLAUDE-OP' }, { now: T0 - DAY + 10 * MIN, maxLines: 8 });
    expect(readBus(r).some((i) => i.type === 'rollup')).toBe(false); // only one reader acked: nothing folds
    busAck(r, last, 'CLAUDE-OP', { now: T0 - MIN });
    busPost(r, { type: 'status', from: 'OP', body: 'today' }, { now: T0, maxLines: 8 });
    const items = readBus(r);
    // the row after both cursors (unseen by CLAUDE-OP when posted) stays unfolded even though it is a day old
    expect(items.map((i) => i.type)).toEqual(['ceo-request', 'decision', 'commitment', 'rollup', 'rollup', 'status', 'status']);
    expect(items[5]!.body).toBe('unseen by CLAUDE-OP');
    expect(items[3]!.body).toBe('6 status/opinion rows on 2026-11-24: OP: old 0 | OP: old 1 | OP: old 2 | OP: old 3 | OP: old 4 | OP: old 5');
    expect(items[4]!.body.startsWith('3 status/opinion rows on 2026-11-25:')).toBe(true);
    expect(items[6]!.body).toBe('today');
    expect(catchUp(r, 'OP').map((i) => i.body)).toEqual(['unseen by CLAUDE-OP', 'today']);
  });
});

describe('Terra r1 — torn line · read failure · CEO words never dropped', () => {
  test('a torn last line (no newline) does not swallow the next post', () => {
    const r = root();
    busPost(r, { type: 'status', from: 'OP', body: 'first' }, { now: T0 });
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(join(r, 'op-context-bus', 'OP.jsonl'), '{"id":"b-torn","at":"2026');
    busPost(r, { type: 'status', from: 'OP', body: 'after the tear' }, { now: T0 + MIN });
    expect(readBus(r).map((i) => i.body)).toEqual(['first', 'after the tear']);
  });
  test('an unreadable bus file reads as empty (no throw) for tail/since/digest', () => {
    const r = root();
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(r, 'op-context-bus', 'OP.jsonl'), { recursive: true }); // a directory where the file should be
    expect(readBus(r)).toEqual([]);
    expect(busDigest(r, { forSeat: 'OP' })).toBe('');
  });
  test('a CEO line longer than the remaining budget is clipped, not dropped', () => {
    const r = root();
    busPost(r, { type: 'ceo-request', from: 'CEO', body: 'very long CEO instruction '.repeat(40), source: 'telegram' }, { now: T0 });
    const text = busDigest(r, { forSeat: 'OP', maxChars: 300 });
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.split('\n')[1]).toContain('ceo-request CEO@telegram: very long CEO instruction');
    expect(text.split('\n')[1]!.endsWith('…')).toBe(true);
  });
  test('ack of a missing id is refused under the lock; a dead holder\'s lock is broken', () => {
    const r = root();
    busPost(r, { type: 'status', from: 'OP', body: 'x' }, { now: T0 });
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(join(r, 'op-context-bus', 'OP.jsonl.lock'), '2147483646'); // a pid that does not exist
    const id = readBus(r)[0]!.id;
    expect(busAck(r, id, 'OP', { now: T0 }).id).toBe(id);
    expect(() => busAck(r, 'b-missing', 'OP')).toThrow('bus ack: no item b-missing');
  });
});

describe('concurrency — separate processes', () => {
  test('12 processes posting at once: 12 items, unique monotonic ids, no torn lines; the same CEO words race to one item', async () => {
    const r = root();
    const script = join(import.meta.dir, 'bus.ts');
    const spawn = (code: string) => Bun.spawn([process.execPath, '-e', `const m = require(${JSON.stringify(script)}); ${code}`], { stdout: 'pipe', stderr: 'pipe' });
    const ps = Array.from({ length: 12 }, (_, i) => spawn(`m.busPost(${JSON.stringify(r)}, { type: 'status', from: 'OP', body: 'p${i}' }); process.stdout.write('ok');`));
    const outs = await Promise.all(ps.map(async (p) => { await p.exited; return new Response(p.stdout).text(); }));
    expect(outs.filter((o) => o === 'ok').length).toBe(12);
    const ids = readBus(r).map((i) => i.id);
    expect(new Set(ids).size).toBe(12);
    expect([...ids].sort()).toEqual(ids);
    const raw = readFileSync(join(r, 'op-context-bus', 'OP.jsonl'), 'utf8').trim().split('\n');
    expect(raw.every((l) => { try { JSON.parse(l); return true; } catch { return false; } })).toBe(true);
    const r2 = root();
    const surfaces = ['telegram', 'tui', 'web', 'telegram', 'tui'];
    const cs = surfaces.map((s) => spawn(`process.stdout.write(m.busPost(${JSON.stringify(r2)}, { type: 'ceo-request', from: 'CEO', body: 'one line', source: '${s}' }).kind);`));
    const kinds = await Promise.all(cs.map(async (p) => { await p.exited; return new Response(p.stdout).text(); }));
    expect(kinds.filter((k) => k === 'posted').length).toBe(1);
    const only = readBus(r2);
    expect(only.length).toBe(1);
    expect([only[0]!.source!, ...only[0]!.alsoFrom].sort()).toEqual(['telegram', 'tui', 'web']);
  });
});

describe('--as claims', () => {
  const UID = 501;
  function procs(): ProcLookup {
    const m = new Map<number, ProcInfo>();
    const add = (pid: number, ppid: number, name: string) => m.set(pid, { pid, ppid, uid: UID, start: `${pid}:0`, name });
    add(5, 1, 'herdr'); add(100, 5, 'claude'); add(101, 100, 'zsh'); add(102, 101, 'bun'); add(200, 5, 'codex'); add(201, 200, 'zsh'); add(202, 201, 'bun');
    return (pid) => m.get(pid);
  }
  test('CLAUDE-OP needs the grant; the proxy session writes only as CLAUDE-OP; other seats must be the caller; CEO is never a CLI writer', () => {
    const ok = { ok: true } as const;
    const no = { ok: false, line: 'proxy: this process does not run inside the CLAUDE-OP session — a --from/ELANOUS_TRACK name is not an identity' } as const;
    expect(checkBusClaim('claude-op', { callerSeat: 'OP', proxy: ok })).toEqual({ ok: true, seat: 'CLAUDE-OP' });
    expect(checkBusClaim('CLAUDE-OP', { callerSeat: 'TC', proxy: no })).toEqual({ ok: false, line: no.line });
    expect(checkBusClaim('OP', { callerSeat: 'OP', proxy: ok })).toEqual({ ok: false, line: 'bus: this process is the CLAUDE-OP session — it writes as CLAUDE-OP only' });
    expect(checkBusClaim('OP', { callerSeat: 'OP', proxy: no })).toEqual({ ok: true, seat: 'OP' });
    expect(checkBusClaim('OP', { callerSeat: 'TC', proxy: no })).toEqual({ ok: false, line: 'bus: --as OP refused — this process is seat TC' });
    expect(checkBusClaim('OP', { callerSeat: null, proxy: no }).ok).toBe(false);
    expect(checkBusClaim('CEO', { callerSeat: 'OP', proxy: no }).ok).toBe(false);
  });
  test('impersonation through the CLI: codex(202) claiming CLAUDE-OP is refused and nothing is written; claude(102) posts', async () => {
    const r = root();
    const lookup = procs();
    writeProxyGrant(r, lookup(100)!, T0);
    const run = async (pid: number, args: string[]) => {
      const out: string[] = []; const err: string[] = []; const codes: number[] = [];
      const program = new Command();
      registerBusCommands(program, { stateRoot: () => r, callerSeat: () => 'TC', out: (l) => out.push(l), err: (l) => err.push(l), setExitCode: (c) => codes.push(c), now: () => T0,
        verifyProxy: () => { const v = verifyProxyCaller({ stateRoot: r, pid, lookup, now: T0, selfUid: UID }); return v.ok ? { ok: true } : { ok: false, line: v.line }; } });
      await program.parseAsync(['bus', ...args], { from: 'user' });
      return { out, err, codes };
    };
    const forged = await run(202, ['post', '--as', 'CLAUDE-OP', '--type', 'decision', 'take', 'over']);
    expect(forged.err).toEqual(['proxy: this process does not run inside the CLAUDE-OP session — a --from/ELANOUS_TRACK name is not an identity']);
    expect(forged.codes).toEqual([2]);
    expect(readBus(r)).toEqual([]);
    const real = await run(102, ['post', '--as', 'CLAUDE-OP', '--type', 'opinion', '--ref', 'pr:40270', 'land', 'it', 'after', 'the', 'demo']);
    expect(real.codes).toEqual([]);
    expect(readBus(r).map((i) => [i.from, i.type, i.body, i.refs])).toEqual([['CLAUDE-OP', 'opinion', 'land it after the demo', ['pr:40270']]]);
  });
});

describe('OP-CONTEXT-BUS sim world (seeds 1–5 · an evening of two writers and three CEO surfaces)', () => {
  // Invariants per seed: I1 every distinct CEO line is exactly one item (surfaces merged) · I2 every pair of different
  // decisions on one ref has the later one marked · I3 OP's catch-up after a restart = exactly the items after its ack ·
  // I4 pinned types are never folded by rollups.
  function rng(seed: number): () => number { let x = seed * 2654435761 >>> 0; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); }
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, () => {
      const rand = rng(seed);
      const r = root();
      const ceoLines = ['demo build only', 'no paid VM tonight', 'cut at 04:00', 'MK stays on the homepage'];
      const pinnedPosted: string[] = [];
      let t = T0 - 26 * 60 * MIN;
      let opAck: string | null = null;
      let afterAck = 0;
      for (let step = 0; step < 220; step++) {
        t += (1 + Math.floor(rand() * 12)) * MIN;
        const roll = rand();
        let res;
        if (roll < 0.2) res = busPost(r, { type: 'ceo-request', from: 'CEO', body: ceoLines[Math.floor(rand() * ceoLines.length)]!, source: ['telegram', 'tui', 'web'][Math.floor(rand() * 3)]! }, { now: t, maxLines: 120 });
        else if (roll < 0.35) res = busPost(r, { type: 'decision', from: rand() < 0.5 ? 'OP' : 'CLAUDE-OP', body: rand() < 0.5 ? 'land now' : 'hold', refs: [`pr:${1 + Math.floor(rand() * 3)}`] }, { now: t, maxLines: 120 });
        else if (roll < 0.4) res = busPost(r, { type: 'commitment', from: 'OP', body: `promise ${step}`, owner: 'TC', doneWhen: 'merged' }, { now: t, maxLines: 120 });
        else res = busPost(r, { type: rand() < 0.5 ? 'status' : 'opinion', from: rand() < 0.5 ? 'OP' : 'CLAUDE-OP', body: `chatter ${step}` }, { now: t, maxLines: 120 });
        if (res.kind === 'posted') {
          if (['ceo-request', 'decision', 'commitment'].includes(res.entry.type)) pinnedPosted.push(res.entry.id);
          if (opAck !== null && res.entry.type !== 'status' && res.entry.type !== 'opinion') afterAck++;
        }
        if (step === 150) { const last = readBus(r).at(-1)!; busAck(r, last.id, 'OP', { now: t }); busAck(r, last.id, 'CLAUDE-OP', { now: t }); opAck = last.id; }
      }
      const items = readBus(r);
      const ceo = items.filter((i) => i.type === 'ceo-request');
      expect(new Set(ceo.map((i) => i.dedupeKey)).size).toBe(ceo.length); // I1
      expect(ceo.length).toBeLessThanOrEqual(ceoLines.length);
      const decisions = items.filter((i) => i.type === 'decision');
      for (let j = 0; j < decisions.length; j++) { // I2
        const later = decisions[j]!;
        const earlierDifferent = decisions.slice(0, j).some((e) => e.refs[0] === later.refs[0] && e.body !== later.body);
        if (earlierDifferent) expect(later.conflictsWith).toBeDefined();
      }
      const caught = catchUp(r, 'OP'); // I3
      expect(caught.every((i) => i.id > opAck!)).toBe(true);
      expect(caught.filter((i) => i.type !== 'status' && i.type !== 'opinion' && i.type !== 'rollup').length).toBe(afterAck);
      const ids = new Set(items.map((i) => i.id)); // I4
      for (const id of pinnedPosted) expect(ids.has(id)).toBe(true);
      expect(items.some((i) => i.type === 'rollup')).toBe(true);
    });
  }
});
