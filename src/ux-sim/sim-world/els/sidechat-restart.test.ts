// ELS-SIDECHAT-EDGE A4 sim — cancel guarantees incl. an els server restart, over a REAL registry + hub and REAL attach apps
// (sidechat-world.ts). Seeded: the old server dies while the sidechat is waiting / streaming / done; a new server starts on
// the SAME state dir (overlays.json restores the layer) → the restored popup shows the one-line restart note, never the dead
// session's turns or a ghost «thinking…/answering…»; a late chunk of the dead request shows nowhere; a new question is a fresh
// session. Plus Esc mid-stream → the request is aborted and no late chunk ever appears. Frame invariants on every frame each
// viewer writes (rows · width · status line). Literal expectations.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [31, 32, 33, 34, 35, 36] as const;
const PREFIX = '\u0002';
const NOTE = 'Previous sidechat was closed when els restarted.';
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds.reverse()) one.dispose(); });
const world = (seed: number, root?: string): SidechatWorld => { const made = createSidechatWorld(seed, undefined, undefined, root ? { root } : {}); worlds.push(made); return made; };
const text = (v: SidechatViewer): string => v.last().join('\n');
const typeIn = (v: SidechatViewer, words: string): void => { for (const ch of Array.from(words)) v.press(ch); };
const PHASES = ['waiting', 'streaming', 'done'] as const;

describe('A4 · els restart: restored sidechat = the note, no stale turn, no ghost output, fresh session', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const a = world(seed);
    const va = await a.viewer({ cols: a.rand.int(70, 140), rows: a.rand.int(20, 36) });
    va.press(`${PREFIX}/`);
    await a.flush();
    typeIn(va, 'old question');
    va.press('\r');
    await a.flush();
    const phase = PHASES[a.rand.int(0, 2)]!;
    if (phase !== 'waiting') { await a.calls[0]!.say('old answer part'); await a.flush(); }
    if (phase === 'done') { await a.calls[0]!.end(); await a.flush(); }
    expect(text(va)).toContain('old question');
    const old = a.calls[0]!;
    a.crash();
    expect(old.aborted()).toBe(phase !== 'done');                           // the dead request is gone with its process
    const saved = readFileSync(join(a.root, 'els', 'overlays.json'), 'utf8');
    expect(saved).toContain('old question');                                // what the restart restores from
    // The new server on the same state dir.
    const b = world(seed + 100, a.root);
    const restored = b.layer();
    expect(restored).toBeDefined();
    expect(JSON.stringify(restored!.props)).not.toContain('old question');
    expect(readFileSync(join(a.root, 'els', 'overlays.json'), 'utf8')).not.toContain('old question');
    const vb = await b.viewer({ cols: b.rand.int(70, 140), rows: b.rand.int(20, 36) });
    await b.flush();
    const shown = text(vb);
    expect(shown).toContain('Sidechat');
    expect(shown).toContain(NOTE);
    expect(shown).not.toContain('old question');
    expect(shown).not.toContain('old answer');
    expect(shown).not.toContain('thinking…');
    expect(shown).not.toContain('answering…');
    if (phase !== 'done') { await old.say(' late ghost chunk'); await b.flush(); }
    expect(text(vb)).not.toContain('ghost');
    // A fresh session: only the new question goes up, the note goes once the user asks.
    typeIn(vb, 'new question');
    vb.press('\r');
    await b.flush();
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]!.messages.filter((one) => one.role === 'user').map((one) => one.content)).toEqual(['new question']);
    await b.calls[0]!.say('fresh answer');
    await b.calls[0]!.end();
    await b.flush();
    expect(text(vb)).toContain('fresh answer');
    expect(text(vb)).not.toContain(NOTE);
    expect(text(vb)).not.toContain('old question');
    vb.press('\u001b');
    await b.flush();
    vb.press(`${PREFIX}/`);
    await b.flush();
    expect(text(vb)).toContain('Ask anything');
    expect(text(vb)).not.toContain(NOTE);
    expect([...va.violations, ...vb.violations]).toEqual([]);
  });
});

describe('A4 · Esc while waiting or streaming: request aborted, a late chunk never shows, reopen is empty', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed + 200);
    const v = await w.viewer({ cols: 110, rows: 30 });
    v.press(`${PREFIX}/`);
    await w.flush();
    typeIn(v, 'cancel me');
    v.press('\r');
    await w.flush();
    const streaming = w.rand.int(0, 1) === 1;
    if (streaming) { await w.calls[0]!.say('partial '); await w.flush(); }
    v.press('\u001b');
    await w.flush();
    expect(w.layer()).toBeUndefined();
    expect(w.calls[0]!.aborted()).toBe(true);
    await w.calls[0]!.say('LATE');
    await w.flush();
    expect(text(v)).not.toContain('LATE');
    v.press(`${PREFIX}/`);
    await w.flush();
    expect(text(v)).toContain('Ask anything');
    expect(text(v)).not.toContain('cancel me');
    expect(text(v)).not.toContain('LATE');
    expect(text(v)).not.toContain(NOTE);
    expect(v.violations).toEqual([]);
  });
});
