import { describe, expect, test } from 'bun:test';

import { ansi } from '../tui.js';
import { applyTurnTypeaheadKey, createTurnTypeaheadState } from '../chat/turn-typeahead.js';
import { drawDashboardTurnTypeaheadPromptRows } from '../dashboard/index.js';
import { buildFirstScreenBand } from '../dashboard/first-screen-band.js';
import { countFullScreenClears } from './slash-menu-frames.js';
import { simHeadlessDashboardFrames, type HeadlessDashboardFrame } from './headless-tui.js';

function frame(lines: string[], caret = { row: 7, col: 3, visible: true }): HeadlessDashboardFrame {
  return {
    lines,
    input: {
      overlay: '', force: false, cursorOwner: 'none', claimedCursor: null,
      promptCaret: caret, suppressPromptArea: false,
    },
  };
}

describe('headless dashboard terminal — real renderer, parsed screen', () => {
  test('stream update keeps input and status rows stable without clearing the full screen', async () => {
    const base = ['header', 'RunShell(cat)', 'stream 1', 'esc 중단', '', '│ local:test-model │', '❯ '];
    const next = [...base];
    next[2] = 'stream 2';
    next[6] = '❯ abc';
    const [boot, streaming] = await simHeadlessDashboardFrames([
      frame(base), frame(next, { row: 7, col: 6, visible: true }),
    ], { rows: 8, cols: 40 });
    expect(boot!.lines[1]).toBe('RunShell(cat)');
    expect(streaming!.lines[2]).toBe('stream 2');
    expect(streaming!.lines[5]).toBe(boot!.lines[5]);
    expect(streaming!.lines[6]).toBe('❯ abc');
    expect(streaming!.cursor).toEqual({ row: 7, col: 6 });
    expect(streaming!.bytes.endsWith(ansi.showCursor)).toBe(true);
    expect(countFullScreenClears(streaming!.bytes)).toBe(0);
    expect(streaming!.bytes).not.toContain(ansi.moveTo(1, 1) + ansi.eraseDown);
    expect(streaming!.bytes).not.toMatch(/\x1b\[(?:2|3)J/);
    expect(streaming!.bytes).not.toContain(ansi.moveTo(6, 1));
  });

  test('overlay and claimed cursor take precedence on the parsed terminal', async () => {
    const f = frame(['base', 'other']);
    f.input.overlay = `${ansi.moveTo(2, 1)}modal`;
    f.input.cursorOwner = 'modal';
    f.input.claimedCursor = { row: 2, col: 4, visible: true };
    const [screen] = await simHeadlessDashboardFrames([f], { rows: 4, cols: 20 });
    expect(screen!.lines[1]).toBe('modal');
    expect(screen!.cursor).toEqual({ row: 2, col: 4 });
  });

  test('production first-screen band and streaming typeahead retain their screen rows', async () => {
    const guidance = buildFirstScreenBand({ width: 40, daemon: false, locale: 'ko' });
    const promptFrame = {
      inputHeight: 2, promptTopRow: 10, promptBottomRow: 11,
      topDividerRow: 9, bottomDividerRow: 12,
    };
    const empty = createTurnTypeaheadState();
    const typed = applyTurnTypeaheadKey(empty, { name: '한' }).state;
    const promptRows = (state: typeof empty) => drawDashboardTurnTypeaheadPromptRows({
      frame: promptFrame, height: 2, placeholder: '❯ ', prompt: '❯ ', state, width: 40,
    });
    const base = [...guidance, ...Array.from({ length: 9 - guidance.length }, () => ''), ...promptRows(empty)];
    const streaming = [...base];
    streaming[8] = 'esc 중단';
    streaming.splice(9, 2, ...promptRows(typed));
    const [first, next] = await simHeadlessDashboardFrames([
      frame(base, { row: 11, col: 3, visible: true }),
      frame(streaming, { row: 11, col: 5, visible: true }),
    ], { rows: 12, cols: 40 });
    expect(first!.lines[0]).toContain('elanous');
    expect(first!.lines[10]).toBe('❯ ');
    expect(next!.lines[8]).toBe('esc 중단');
    expect(next!.lines[10]).toBe('❯ 한');
    expect(next!.cursor).toEqual({ row: 11, col: 5 });
  });

  test('a renderer exception restores stdout, dimensions and the next capture', async () => {
    const write = process.stdout.write;
    const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const broken = new Proxy(['bad'], {
      get(target, key, receiver) {
        if (key === '0') throw new Error('paint failed');
        return Reflect.get(target, key, receiver);
      },
    });
    await expect(simHeadlessDashboardFrames([frame(broken)], { rows: 4, cols: 20 }))
      .rejects.toThrow('paint failed');
    expect(process.stdout.write).toBe(write);
    expect(Object.getOwnPropertyDescriptor(process.stdout, 'rows')).toEqual(rows);
    expect(Object.getOwnPropertyDescriptor(process.stdout, 'columns')).toEqual(columns);
    const [recovered] = await simHeadlessDashboardFrames([frame(['recovered'])], { rows: 4, cols: 20 });
    expect(recovered!.lines[0]).toBe('recovered');
  });
});
