// ELS-SIDECHAT-EDGE A1 sim — «include context» (ctrl+o) over a REAL registry + hub and REAL attach apps (sidechat-world.ts):
// ctrl+b / opens the popup over pane p1 → ctrl+o → a dim «context: <title>» row → the question goes with the pane's last 60
// visible lines, redacted; ctrl+o again → off; the pane closed → «context: unavailable» and the question goes without.
// Per-frame invariants (every frame each viewer writes): row count, row width, the status line never covered, and the raw
// secret printed on the pane never appears in a frame nor in any pushed overlay stack (props). Seeded, literal expectations.
import { afterAll, describe, expect, test } from 'bun:test';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [11, 12, 13, 14, 15, 16] as const;
const PREFIX = '\u0002';
const CTRL_O = '\u000f';
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); });
const world = (seed: number): SidechatWorld => { const made = createSidechatWorld(seed); worlds.push(made); return made; };
const text = (v: SidechatViewer): string => v.last().join('\n');
const SECRET = 'sk-proj-AbCdEf0123456789AbCdEf0123456789xyz';
const TITLES = ['build log', 'zsh — repo', '빌드 창', 'tests'] as const;

/** A pane screen of `n` numbered lines with the secret on a random line inside the last 60, plus trailing blank rows. */
function screenOf(w: SidechatWorld, n: number): { screen: string; secretAt: number } {
  const secretAt = w.rand.int(Math.max(1, n - 59), n - 1);
  const rows = Array.from({ length: n }, (_, at) => at + 1 === secretAt ? `export OPENAI_API_KEY=${SECRET}` : `line ${at + 1}`);
  return { screen: `${rows.join('\n')}\n\n   \n`, secretAt };
}

describe('A1 · ctrl+o context: header · last 60 lines · redacted · off · unavailable', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    w.forbidden.push(SECRET);
    const title = TITLES[w.rand.int(0, TITLES.length - 1)]!;
    const n = w.rand.int(70, 140);
    const { screen } = screenOf(w, n);
    w.screens.set('p1', { title, screen });
    const v = await w.viewer({ cols: w.rand.int(70, 150), rows: w.rand.int(20, 40) });
    v.press(`${PREFIX}/`);
    await w.flush();
    expect(w.layer()).toBeDefined();
    expect(text(v)).not.toContain('context:');
    v.press(CTRL_O);
    await w.flush();
    expect(text(v)).toContain(`context: ${title}`);
    expect(v.typed()).toEqual([]);                                           // ctrl+o never reaches the pane
    for (const ch of Array.from('what failed?')) v.press(ch);
    v.press('\r');
    await w.flush();
    expect(w.calls).toHaveLength(1);
    const sent = w.calls[0]!.messages;
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'what failed?' });
    const ctx = sent.find((one) => one.role === 'system' && one.content.startsWith('Context'))!;
    expect(ctx.content).toContain(`«${title}»`);
    expect(ctx.content).toContain(`line ${n}\n`);                            // the last visible line (trailing blanks dropped)
    expect(ctx.content).not.toContain(`line ${n - 60}\n`);                   // only the last 60
    expect(ctx.content).not.toContain(SECRET);
    expect(ctx.content).toContain('OPENAI_API_KEY=***');
    await w.calls[0]!.say('The build failed on line 3.');
    await w.calls[0]!.end();
    await w.flush();
    expect(text(v)).toContain(`context: ${title}`);
    // The pane closes: the header stays on, the next question goes without context and the header says unavailable.
    w.screens.delete('p1');
    for (const ch of Array.from('and now?')) v.press(ch);
    v.press('\r');
    await w.flush();
    expect(w.calls).toHaveLength(2);
    expect(w.calls[1]!.messages.some((one) => one.content.startsWith('Context'))).toBe(false);
    expect(text(v)).toContain('context: unavailable');
    await w.calls[1]!.say('ok');
    await w.calls[1]!.end();
    await w.flush();
    // Off: no header, no context.
    w.screens.set('p1', { title, screen });
    v.press(CTRL_O);
    await w.flush();
    expect(text(v)).not.toContain('context:');
    for (const ch of Array.from('plain')) v.press(ch);
    v.press('\r');
    await w.flush();
    expect(w.calls[2]!.messages.some((one) => one.content.startsWith('Context'))).toBe(false);
    await w.calls[2]!.end();
    await w.flush();
    // Reopen = a fresh session: context is off again.
    v.press('\u001b');
    await w.flush();
    v.press(`${PREFIX}/`);
    await w.flush();
    expect(text(v)).not.toContain('context:');
    expect(v.violations).toEqual([]);
    expect(w.stackViolations).toEqual([]);
  });
});

describe('A1 · two viewers: the header shows on both, the toggle while streaming applies to the next question', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const w = world(seed);
    w.forbidden.push(SECRET);
    w.screens.set('p1', { title: 'work', screen: screenOf(w, w.rand.int(5, 80)).screen });
    const a = await w.viewer({ cols: 120, rows: 30 });
    const b = await w.viewer({ cols: w.rand.int(64, 100), rows: w.rand.int(18, 26) });
    a.press(`${PREFIX}/`);
    await w.flush();
    for (const ch of Array.from('q1')) a.press(ch);
    a.press('\r');
    await w.flush();
    await w.calls[0]!.say('part');
    a.press(CTRL_O);                                                         // toggled mid-stream
    await w.flush();
    expect(text(a)).toContain('context: work');
    expect(text(b)).toContain('context: work');
    expect(w.calls[0]!.messages.some((one) => one.content.startsWith('Context'))).toBe(false);
    await w.calls[0]!.end();
    await w.flush();
    for (const ch of Array.from('q2')) a.press(ch);
    a.press('\r');
    await w.flush();
    expect(w.calls[1]!.messages.some((one) => one.content.startsWith('Context'))).toBe(true);
    await w.calls[1]!.end();
    await w.flush();
    expect([...a.violations, ...b.violations]).toEqual([]);
    expect(w.stackViolations).toEqual([]);
  });
});
