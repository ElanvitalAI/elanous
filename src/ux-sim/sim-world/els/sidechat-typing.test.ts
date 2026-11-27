// ELS-SIDECHAT-EDGE A5 sim — the typing indicator and first-token timing over a REAL registry + hub and REAL attach apps
// (sidechat-world.ts, fake clock). Seeded: the model starts after a random delay (several indicator steps), streams in random
// chunks with random gaps, then ends. Checked on every step's frame: the frame invariants (rows · width · status line), the
// spinner glyph = the step (literal list), «thinking…» and «first token» never in the same title, the first-token latency and
// the total exactly from the fake clock, and when idle no timer is left armed (the indicator stops). Literal expectations.
import { afterAll, describe, expect, test } from 'bun:test';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [21, 22, 23, 24, 25, 26] as const;
const PREFIX = '\u0002';
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); });
const world = (seed: number): SidechatWorld => { const made = createSidechatWorld(seed); worlds.push(made); return made; };
const titleOf = (v: SidechatViewer): string => v.last().find((row) => row.includes('Sidechat')) ?? '';
const settle = async (): Promise<void> => { for (let at = 0; at < 6; at++) await Promise.resolve(); await new Promise((done) => setImmediate(done)); };
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Per-step frame checks beyond the world's own invariants. */
function titleViolations(title: string): string[] {
  const out: string[] = [];
  if (title.includes('thinking…') && title.includes('first token')) out.push(`title mixes waiting and timing: ${title}`);
  if (title.includes('answering…') && title.includes('total')) out.push(`title mixes streaming and total: ${title}`);
  return out;
}

describe('A5 · typing indicator steps on the push timer · first-token and total time from the clock · stops when idle', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer({ cols: w.rand.int(70, 150), rows: w.rand.int(18, 40) });
    const extra: string[] = [];
    v.press(`${PREFIX}/`);
    await w.flush();
    for (const ch of Array.from('timing?')) v.press(ch);
    const sentAt = w.timers.now();
    v.press('\r');
    await settle();
    expect(titleOf(v)).toContain(`${SPINNER[0]} thinking…`);
    const steps = w.rand.int(3, 14);
    for (let step = 1; step <= steps; step++) {
      w.timers.advance(300);
      await settle();
      const title = titleOf(v);
      extra.push(...titleViolations(title));
      expect(title).toContain(`${SPINNER[step % 10]} thinking…`);
    }
    w.timers.advance(w.rand.int(0, 299));                                   // the first token lands between two steps
    await settle();
    const firstMs = w.timers.now() - sentAt;
    await w.calls[0]!.say('First ');
    w.timers.advance(150);
    await settle();
    expect(titleOf(v)).toContain(`answering… · ${secs(firstMs)} first token`);
    expect(titleOf(v)).not.toContain('thinking…');
    const chunks = w.rand.int(2, 8);
    for (let at = 0; at < chunks; at++) {
      w.timers.advance(w.rand.int(10, 900));
      await w.calls[0]!.say(`chunk${at} `);
      await settle();
      extra.push(...titleViolations(titleOf(v)));
      expect(titleOf(v)).not.toContain('thinking…');
    }
    const totalMs = w.timers.now() - sentAt;
    await w.calls[0]!.end();
    await settle();
    expect(titleOf(v)).toContain(`Sidechat · ${secs(firstMs)} first token · ${secs(totalMs)} total`);
    expect(w.timers.active()).toBe(0);                                      // idle: no indicator timer, no run timer
    const frames = v.frames();
    w.timers.advance(5_000);
    await settle();
    expect(v.frames()).toBe(frames);                                         // and nothing repaints while idle
    // The next question restarts the indicator at the first frame and drops the old timing.
    for (const ch of Array.from('again')) v.press(ch);
    v.press('\r');
    await settle();
    expect(titleOf(v)).toContain(`${SPINNER[0]} thinking…`);
    expect(titleOf(v)).not.toContain('total');
    // Closing while waiting stops the chain too.
    v.press('\u001b');
    await w.flush();
    expect(w.layer()).toBeUndefined();
    expect(w.timers.active()).toBe(0);
    expect(v.violations).toEqual([]);
    expect(extra).toEqual([]);
  });
});

describe('A5 · the model never starts: the indicator runs to the 30 s cut, then the error line, then idle', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    const v = await w.viewer({ cols: 100, rows: 28 });
    v.press(`${PREFIX}/`);
    await w.flush();
    for (const ch of Array.from('slow')) v.press(ch);
    v.press('\r');
    await settle();
    let seen = 0;
    for (let at = 0; at < 100; at++) { w.timers.advance(300); await settle(); if (titleOf(v).includes('thinking…')) seen++; }
    expect(seen).toBe(99);                                                   // the 100th step is the 30 s cut
    expect(v.last().join('\n')).toContain('No answer yet');
    expect(titleOf(v)).toContain('Sidechat · 30.0s total');
    expect(w.timers.active()).toBe(0);
    expect(v.violations).toEqual([]);
  });
});
