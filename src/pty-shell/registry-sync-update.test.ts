import { afterEach, expect, test } from 'bun:test';
import { resetForTesting, setPtyAdapterForTesting, startPty, type StartOpts } from './registry.js';

const ESC = '\u001b';
const BEGIN = `${ESC}[?2026h`;
const END = `${ESC}[?2026l`;

/** The stage plays the OS only: it hands the registry the bytes a TUI wrote. Emulator, screen render and the els frame feed are the real ones. */
function stage() {
  const callbacks: { data?: (chunk: string) => void } = {};
  return {
    emit: (chunk: string): void => callbacks.data?.(chunk),
    adapter: { pid: 4343, write() {}, kill() {}, onData(cb: (chunk: string) => void) { callbacks.data = cb; return { dispose() {} }; }, onExit() { return { dispose() {} }; } },
  };
}

afterEach(() => { resetForTesting(); setPtyAdapterForTesting(null); });

// ELS-RENDER-ELN-PANE: eln (an alternate-screen TUI) draws every frame inside DECSET 2026. A snapshot taken between the begin and the
// end showed the half-erased frame — lines twice or missing — in the els app view. The frame feed must show the last complete frame.
test('a screen read inside a synchronized update shows the last complete frame, and the new frame once the update ends', async () => {
  const os = stage();
  setPtyAdapterForTesting(() => os.adapter);
  const handle = startPty({ id: 'shell_5e2026a1', kind: 'shell', cmd: 'eln-stand-in', detach: true, cols: 40, rows: 6 } as StartOpts);
  const frame = (tag: string): string => ['한국어 줄 1', `${tag} 줄 2`, `${tag} 줄 3`].map((line, row) => `${ESC}[${row + 1};1H${ESC}[2K${line}`).join('');

  os.emit(`${ESC}[?1049h${BEGIN}${ESC}[H${ESC}[J${frame('OLD')}${END}`);
  const complete = await handle.renderScreen();
  expect(complete).toContain('OLD 줄 3');

  // The next frame is half on the wire: erased, first row drawn, end not yet sent.
  os.emit(`${BEGIN}${ESC}[H${ESC}[J${ESC}[1;1HNEW 줄 1 (half)`);
  for (const ansi of [false, true]) {
    const held = await handle.renderScreen(ansi ? { ansi: true } : undefined);
    expect(held).toContain('OLD 줄 3');
    expect(held).not.toContain('half');
    expect(held.split('\n').filter((line) => line.includes('한국어 줄 1')).length).toBe(1);
  }

  os.emit(`${frame('NEW')}${END}`);
  const done = await handle.renderScreen();
  expect(done).toContain('NEW 줄 3');
  expect(done).not.toContain('OLD');
});

test('a resize drops the held frame: the next read is the live grid at the new size', async () => {
  const os = stage();
  setPtyAdapterForTesting(() => ({ ...os.adapter, resize() {} }));
  const handle = startPty({ id: 'shell_5e2026a2', kind: 'shell', cmd: 'eln-stand-in', detach: true, cols: 40, rows: 6 } as StartOpts);
  os.emit(`${ESC}[1;1HSTILL_HERE${BEGIN}${ESC}[H${ESC}[JRESIZED_MID_FRAME`);
  expect(await handle.renderScreen()).toContain('STILL_HERE');
  handle.resize(30, 5);
  const live = await handle.renderScreen();
  expect(live).toContain('RESIZED_MID_FRAME');
  expect(live.split('\n')[0]).toContain('30x5');
});

test('a scrolled-back read inside a synchronized update shows history, not the held frame; scrollBack=0 still shows the held frame', async () => {
  const os = stage();
  setPtyAdapterForTesting(() => os.adapter);
  const handle = startPty({ id: 'shell_5e2026a3', kind: 'shell', cmd: 'eln-stand-in', detach: true, cols: 40, rows: 6 } as StartOpts);
  os.emit(Array.from({ length: 14 }, (_, i) => `LINE_${String(i + 1).padStart(2, '0')}`).join('\r\n'));
  // The region opens over a complete frame (LINE_14 at the bottom), then the viewport is erased mid-frame.
  os.emit(`${BEGIN}${ESC}[H${ESC}[J${ESC}[1;1HNEW_HALF`);

  const live = await handle.renderScreen();
  expect(live).toContain('LINE_14');
  expect(live).toContain('cursor=');
  expect(live).not.toContain('NEW_HALF');

  const back = await handle.renderScreen({ scrollBack: 3 });
  expect(back.split('\n')[0]).toContain('scrolled-back=3');
  expect(back).not.toContain('cursor=');
  expect(back).toContain('LINE_06');
  expect(back).not.toContain('LINE_14');

  expect(await handle.renderScreen({ scrollBack: 0 })).toContain('LINE_14');
});
