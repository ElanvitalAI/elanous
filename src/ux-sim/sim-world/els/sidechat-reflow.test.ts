// ELS-SIDECHAT-EDGE A3 sim — resize, two attach viewers of different sizes, and the pane under the popup exiting while the
// answer streams, over a REAL registry + hub and REAL attach apps (sidechat-world.ts). Seeded: random chunks interleaved with
// random resizes of either viewer and (once) the pane exit. Every frame each viewer writes is checked at ITS current size
// (rows · width in cells · the status line never covered); after every step both viewers show the popup with the same
// streamed tail; at the end exactly one sidechat layer, no timer armed, and Esc removes it from both. Literal expectations.
import { afterAll, describe, expect, test } from 'bun:test';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [41, 42, 43, 44, 45, 46] as const;
const PREFIX = '\u0002';
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); });
const world = (seed: number): SidechatWorld => { const made = createSidechatWorld(seed); worlds.push(made); return made; };
const text = (v: SidechatViewer): string => v.last().join('\n');
const sidechatLayers = (w: SidechatWorld): number => w.registry.stack().layers.filter((one) => one.kind === 'sidechat').length;

describe('A3 · resize · two viewers · pane exit while streaming: the stream goes on, each view reflows, nothing orphaned', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const a = await w.viewer({ cols: w.rand.int(110, 170), rows: w.rand.int(30, 48) });
    const b = await w.viewer({ cols: w.rand.int(64, 100), rows: w.rand.int(18, 28) });
    a.press(`${PREFIX}/`);
    await w.flush();
    for (const ch of Array.from('stream please')) a.press(ch);
    a.press('\r');
    await w.flush();
    const words = Array.from({ length: w.rand.int(12, 30) }, (_, at) => `w${at}`);
    const exitAt = w.rand.int(2, words.length - 3);
    let exited = false;
    for (let at = 0; at < words.length; at++) {
      await w.calls[0]!.say(`${words[at]} `);
      const roll = w.rand.int(0, 5);
      if (roll === 0) a.resize(w.rand.int(60, 180), w.rand.int(16, 50));
      if (roll === 1) b.resize(w.rand.int(60, 180), w.rand.int(16, 50));
      if (at === exitAt) { w.removePane('p1'); a.endPane('p1'); b.endPane('p1'); exited = true; }
      await w.flush();
      for (const v of [a, b]) {
        expect(text(v)).toContain('Sidechat');
        expect(text(v)).toContain('answering…');
        expect(v.last()).toHaveLength(v.size.rows);
      }
      expect(w.calls[0]!.aborted()).toBe(false);
    }
    expect(exited).toBe(true);
    expect(w.calls).toHaveLength(1);                                         // the pane exit asked nothing again
    await w.calls[0]!.end();
    await w.flush();
    const tail = words.at(-1)!;
    for (const v of [a, b]) {
      expect(text(v)).toContain(tail);
      expect(text(v)).not.toContain('answering…');
    }
    expect(sidechatLayers(w)).toBe(1);
    expect(w.hub.snapshot().status).toBe('idle');
    expect(w.timers.active()).toBe(0);
    // One more resize after the end reflows without a server push.
    b.resize(w.rand.int(60, 120), w.rand.int(16, 30));
    await w.flush();
    expect(text(b)).toContain(tail);
    b.press('\u001b');                                                       // Esc from the other viewer closes it for both
    await w.flush();
    expect(sidechatLayers(w)).toBe(0);
    expect(text(a)).not.toContain('Sidechat');
    expect(text(b)).not.toContain('Sidechat');
    expect([...a.violations, ...b.violations]).toEqual([]);
  });
});

describe('A3 · a very narrow resize while streaming keeps every frame inside the view and recovers when wide again', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed + 100);
    const v = await w.viewer({ cols: 120, rows: 30 });
    v.press(`${PREFIX}/`);
    await w.flush();
    for (const ch of Array.from('narrow')) v.press(ch);
    v.press('\r');
    await w.flush();
    await w.calls[0]!.say('| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nconst wide = "x".repeat(200);\n```\n');
    v.resize(w.rand.int(30, 59), w.rand.int(10, 16));
    await w.flush();
    expect(v.last()).toHaveLength(v.size.rows);
    await w.calls[0]!.say('done here');
    await w.calls[0]!.end();
    v.resize(120, 30);
    await w.flush();
    expect(text(v)).toContain('done here');
    expect(v.violations).toEqual([]);
  });
});
