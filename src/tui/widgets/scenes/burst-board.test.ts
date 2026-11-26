// BURST-BOARD B1 — widgets as hand-written literals (rule 11) · the scene at 120×36 and 80×24 with zero overflow.
import { describe, expect, test } from 'bun:test';
import { renderCountdown, renderFlowLane, renderHandGrid, renderHostTile, renderPulseDot, renderSparkline, renderTicker } from '../index.js';
import { renderBurstBoard } from './burst-board.js';
import { BURST_FIXTURE_NAMES, burstDemoSnapshot, burstFixture, DEMO_TICKS, playBurstReplay } from './burst-replay.js';

describe('burst widgets', () => {
  test('PulseDot breathes on calm ticks, holds when busy', () => {
    expect([0, 1, 2].map((tick) => renderPulseDot({ tick, busy: false }))).toEqual(['●', '○', '●']);
    expect(renderPulseDot({ tick: 1, busy: true })).toBe('●');
  });
  test('Countdown', () => {
    expect(renderCountdown({ elapsedSec: 42, totalSec: 240 }, 40)).toBe('0:42 / 4:00 ██░░░░░░░░░░ 3:18 left');
    expect(renderCountdown({ elapsedSec: 600, totalSec: 14400 }, 20)).toBe('10:00 / 4:00:00 · 3…');
  });
  test('HandGrid: new hand enters as + then ▪; closing fades', () => {
    const hands = [{ host: 'mshq', state: 'busy' as const }, { host: 'mshq', state: 'idle' as const }, { host: 'node-b', state: 'new' as const, task: 'A301' }, { host: 'node-b', state: 'closing' as const }];
    expect(renderHandGrid({ hands, frame: 0 }, 40)).toEqual(['mshq ▪ ·', 'node-b + ·  A301']);
    expect(renderHandGrid({ hands, frame: 3 }, 40)).toEqual(['mshq ▪ ·', 'node-b ▪']);
  });
  test('FlowLane: rate drives motion, zero rate holds, a jam piles right', () => {
    expect(renderFlowLane({ items: 2, speed: 1, tick: 0, frame: 0 }, 10)).toBe('•────•────');
    expect(renderFlowLane({ items: 2, speed: 1, tick: 1, frame: 0 }, 10)).toBe('─•────•───');
    expect(renderFlowLane({ items: 2, speed: 0, tick: 7, frame: 3 }, 10)).toBe('•────•────');
    expect(renderFlowLane({ items: 3, speed: 0, blocked: true, tick: 0, frame: 0 }, 10)).toBe('───────▓▓▓');
  });
  test('Ticker slides only a fresh event in', () => {
    const events = [{ at: '00:41', text: 'review +1' }, { at: '00:35', text: 'node-b +1' }];
    expect(renderTicker({ events, fresh: false, frame: 0 }, 40)).toBe('00:41 review +1 · 00:35 node-b +1');
    expect(renderTicker({ events, fresh: true, frame: 0 }, 40)).toBe('           00:4 · 00:35 node-b +1');
  });
  test('HostTile states', () => {
    // 출처: #40144 fixture host slots — display literal, not a bound
    expect(renderHostTile({ name: 'gcp3', kind: 'cloud', used: 0, cap: 2, state: 'off', frame: 0 }, 60)).toBe('gcp3    ○ off');
    // 출처: #40144 fixture host slots — display literal, not a bound
    expect(renderHostTile({ name: 'gcp3', kind: 'cloud', used: 0, cap: 2, state: 'card', frame: 0 }, 60)).toBe('gcp3    $? cloud card pending — press v to approve');
    // 출처: #40144 fixture host slots — display literal, not a bound
    expect(renderHostTile({ name: 'minim5', kind: 'lan', used: 4, cap: 4, load: 9, role: 'pregate 4', state: 'cap', frame: 0 }, 80)).toBe('minim5    ▓▓▓▓▓▓ 4/4 cap  load 9      pregate 4');
    // 출처: #40144 fixture host slots — display literal, not a bound
    expect(renderHostTile({ name: 'node-b', kind: 'lan', used: 3, cap: 5, state: 'on', next: true, frame: 0 }, 80)).toBe('node-b      ▓▓▓▓░░ 3/5  ← next');
  });
  test('Sparkline marks the target crossing', () => {
    expect(renderSparkline({ label: 'Landed/h', values: [7, 14], target: 20 }, 60)).toBe('Landed/h ▃▆ 14 (target 20)');
    expect(renderSparkline({ label: 'Landed/h', values: [14, 21], target: 20 }, 60)).toBe('Landed/h ▆█ 21 ✓ above target 20');
  });
});

describe('renderBurstBoard (120×36 · 80×24 fallbacks)', () => {
  for (const [width, height] of [[120, 36], [80, 24]] as const) {
    test(`${width}×${height}: every replay frame fits`, () => {
      for (let t = 0; t < DEMO_TICKS; t++) for (let f = 0; f < 4; f++) {
        const lines = renderBurstBoard(burstDemoSnapshot(t), width, f);
        expect(lines.length).toBeLessThanOrEqual(height);
        for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      }
      expect(BURST_FIXTURE_NAMES.length).toBe(7);
    });
  }
  test('calm reads quiet, burst reads busy', () => {
    const calm = renderBurstBoard(burstFixture('calm'), 120);
    expect(calm[0]!.startsWith('● Burst Board · 0.3.37 · test universe · Calm · rhythm 60m')).toBe(true);
    expect(calm[1]).toBe('Quiet · resources at rest · cloud off');
    const busy = renderBurstBoard(burstFixture('bursting'), 120);
    expect(busy[0]!.startsWith('● BURST 4h · Burst Board · 0.3.37 · test universe · trigger: CEO «all resources» (#166501)')).toBe(true);
  });
  test('exit sequence then receipt', () => {
    expect(renderBurstBoard(burstFixture('exit'), 80)[0]).toBe('● EXIT 3/4 · Close hands · Burst Board · 0.3.37 · test universe');
    const receipt = renderBurstBoard(burstFixture('receipt'), 80);
    expect(receipt).toContain('  every launched resource released ✓');
  });
  test('the replay writes 4 frames per snapshot and restores the cursor', async () => {
    const out: string[] = [];
    await playBurstReplay({ write: (t) => out.push(t), sleep: async () => {}, columns: () => 80 }, { fromTick: DEMO_TICKS - 2 });
    expect(out.length).toBe(1 + 2 * 4 + 1);
    expect(out.at(-1)).toBe('\x1b[?25h');
  });
});
