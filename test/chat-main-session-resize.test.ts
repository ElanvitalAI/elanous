import { describe, expect, spyOn, test } from 'bun:test';

import { textInput } from '../src/chat/index.js';
import { createChatPickerModalRuntime } from '../src/chat/pickers/modal-runtime.js';
import type { PickerState } from '../src/chat/pickers/state.js';
import { createChatMainInputSession } from '../src/dashboard/input/chat-main-session.js';
import { buildChatMainTextInputRequest } from '../src/dashboard/input/chat-main-turn.js';
import type { PromptFrame } from '../src/display/prompt-frame.js';
import { stripAnsi, visibleWidth, type Key } from '../src/tui.js';

const frame: PromptFrame = {
  inputHeight: 1,
  promptTopRow: 10,
  promptBottomRow: 10,
  topDividerRow: 9,
  bottomDividerRow: 11,
};

describe('chat main prompt resize', () => {
  test('repaints the divider and text input to the current width', async () => {
    let cols = 120;
    const writes: string[] = [];
    const controlOut = { repaint: () => {} };
    let releaseRead: ((key: Key) => void) | undefined;
    const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const session = createChatMainInputSession({
      promptFrame: frame,
      inputCols: cols,
      getInputCols: () => cols,
      surfaceRegistry: { register: () => {}, unregister: () => {} } as never,
      invalidateRenderCacheRow: () => {},
      buildPromptFrameDividerRows: (_frame, divider) => [{ row: frame.topDividerRow, text: divider }],
      shouldPaint: () => true,
    });

    try {
      const input = textInput(buildChatMainTextInputRequest({
        session,
        history: [],
        placeholder: '',
        textInputOpts: { controlOut, readKey: () => new Promise<Key>((resolve) => { releaseRead = resolve; }) },
      }));
      cols = 80;
      writes.length = 0;
      controlOut.repaint();
      const divider = writes.find((write) => write.startsWith('\x1b[9;1H'));
      const body = writes.find((write) => write.startsWith('\x1b[10;1H'));
      expect(divider).toBeDefined();
      expect(body).toBeDefined();
      expect(visibleWidth(stripAnsi(divider ?? ''))).toBe(80);
      expect(visibleWidth(stripAnsi(body ?? ''))).toBeLessThanOrEqual(80);
      cols = 120;
      writes.length = 0;
      controlOut.repaint();
      expect(visibleWidth(stripAnsi(writes.find((write) => write.startsWith('\x1b[9;1H')) ?? ''))).toBe(120);
      expect(visibleWidth(stripAnsi(writes.find((write) => write.startsWith('\x1b[10;1H')) ?? ''))).toBeLessThanOrEqual(120);
      releaseRead?.({ name: 'escape', ctrl: false, shift: false } as Key);
      expect((await input).submitted).toBe(false);
    } finally {
      stdout.mockRestore();
    }
  });

  test('an active picker recalculates its bounds when the prompt narrows', () => {
    let cols = 120;
    const runtime = createChatPickerModalRuntime({
      picker: { selectedIdx: () => 0 } as PickerState,
      getBufferView: () => ({ lines: ['/h'], lineIdx: 0, colIdx: 2 }),
      writeTerminal: () => {},
      getBounds: () => ({ row: 12, col: 1, width: cols, height: 1 }),
      getInputZoneHeight: () => 1,
      onDispatchResult: async () => true,
    });
    const family = runtime.createFamily({
      bounds: { row: 12, col: 1, width: cols, height: 1 },
      maxVisible: 5,
      sources: {
        slash: { id: 'chat:slash', getItems: () => [{ name: 'help', description: 'Help', aliases: [] }] },
        arg: { id: 'chat:arg', getItems: () => [] },
        at: { id: 'chat:at', getItems: () => [] },
        skill: { id: 'chat:skill', getItems: () => [] },
      },
    });
    const picker = family.createSurface('slash');
    expect(picker.getBounds?.()?.width).toBe(120);
    cols = 80;
    expect(picker.getBounds?.()?.width).toBe(80);
  });
});
