import { describe, expect, test } from 'bun:test';

import { render, resetRenderCache } from '../tui.js';
import { countFullScreenClears, simSlashMenuFrames } from './slash-menu-frames.js';

// Catalog whose filtered list SHRINKS as the keyword grows — so typing
// also exercises the "picker height changed" path, not only re-filtering.
const commands = Array.from({ length: 12 }, (_, i) => ({
  name: `abcdefghijklmnopqrstuvwxyz`.slice(0, 4 + i * 2) + `-${i}`,
  description: `cmd ${i}`,
}));
const TYPED_20 = 'abcdefghijklmnopqrst';
// ⚠️ The CLOSING key (Esc / Enter) is excluded on purpose: closing the picker
// goes through coordinator.popModal, whose blanket full-frame force is a
// separate, deliberate decision (Q7 / federation invariant F9) — one clear
// per close, not per keystroke. This card covers typing and ↑/↓ only.
const isClose = (key: string): boolean => key === 'esc' || key === 'enter';
const ARROWS_30 = Array.from({ length: 30 }, (_, i) => (i % 3 === 2 ? 'up' : 'down') as 'up' | 'down');

describe('TUI-SLASH-FLICKER — slash picker never erases the whole screen', () => {
  test('the counter bites: a forced tui.render IS a full-screen clear', () => {
    const chunks: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
    try {
      resetRenderCache();
      render(['a', 'b']);
      chunks.length = 0;
      render(['a', 'b'], { force: true });
    } finally {
      process.stdout.write = realWrite as typeof process.stdout.write;
      resetRenderCache();
    }
    expect(countFullScreenClears(chunks.join(''))).toBe(1);
  });

  test('20 typed chars after «/» (list shrinking) → 0 full-screen clears', async () => {
    const r = await simSlashMenuFrames({ typed: TYPED_20, commands });
    const typedFrames = r.frames.filter((f) => !isClose(f.key));
    expect(typedFrames).toHaveLength(21); // «/» + 20
    expect(typedFrames.map((f) => f.fullClears)).toEqual(typedFrames.map(() => 0));
  });

  test('30 ↓/↑ presses in the open picker → 0 full-screen clears, only the bottom band redrawn', async () => {
    const r = await simSlashMenuFrames({ typed: 'abcd', arrows: ARROWS_30, commands });
    const arrowFrames = r.frames.filter((f) => f.key === '↓' || f.key === '↑');
    expect(arrowFrames).toHaveLength(30);
    expect(arrowFrames.reduce((n, f) => n + f.fullClears, 0)).toBe(0);
    // Only changed lines: rows above the picker band (row 1..10 of 24) are never re-emitted.
    for (const f of arrowFrames) {
      const rows = (f.bytes.match(/\x1b\[(\d+);1H\x1b\[2K/g) ?? []).map((s) => Number(s.match(/\d+/)![0]));
      expect(rows.length).toBeGreaterThan(0);
      expect(Math.min(...rows)).toBeGreaterThan(10);
    }
  });

  test('behaviour kept: ↓ then Enter submits the selected command; Esc cancels', async () => {
    const entered = await simSlashMenuFrames({ typed: 'abcd', arrows: ['down'], commands, finish: 'enter' });
    expect(entered.frames.filter((f) => !isClose(f.key)).every((f) => f.fullClears === 0)).toBe(true);
    expect(entered.submitted).toBe(true);
    expect(entered.finalText).toBe('/abcdef-1');

    const escaped = await simSlashMenuFrames({ typed: 'ab', commands });
    expect(escaped.submitted).toBe(false);
    expect(escaped.finalText).toBe('');
  });
});

// TUI-DIRECT-WRITE-ROWS — closing the picker must not erase rows outside the
// picker band. The old direct clear (`paintChatPickerClear` via the textInput
// `writeTerminal` bypass) erased one row ABOVE the band and the frame cache
// never learned about it, so that row stayed blank until the next full
// repaint (live: ChatLog header blank ~31ms on `/` → ↓ → Esc).
describe('TUI-DIRECT-WRITE-ROWS — picker close erases nothing outside the picker band', () => {
  const erasedRows = (bytes: string): number[] =>
    (bytes.match(/\x1b\[(\d+);\d+H\x1b\[2K/g) ?? []).map((s) => Number(s.match(/\d+/)![0]));

  test('Esc after «/abcd» ↓ — rows erased before the coordinator repaint ⊆ picker band', async () => {
    const r = await simSlashMenuFrames({ typed: 'abcd', arrows: ['down'], commands });
    const open = r.frames.find((f) => f.key === '↓')!;
    const close = r.frames.find((f) => f.key === 'esc')!;
    // Picker band = the rows the open frame painted with the modal box chars.
    const band = [...open.bytes.matchAll(/\x1b\[(\d+);1H\x1b\[2K([╭│╰])/g)].map((m) => Number(m[1]));
    const top = Math.min(...band);
    const bottom = Math.max(...band);
    expect(bottom - top).toBeGreaterThan(2);
    // Everything before the first full-screen clear is the direct-write window
    // the frame cache cannot see; nothing there may touch a row outside the band.
    const preRepaint = close.bytes.split('\x1b[1;1H\x1b[J')[0]!;
    const outside = erasedRows(preRepaint).filter((row) => row < top || row > bottom);
    expect(outside).toEqual([]);
    // The close still repaints exactly once (popModal's Q7 / F9 blanket force).
    expect(close.fullClears).toBe(1);
  });
});
