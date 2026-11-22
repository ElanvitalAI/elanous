// ELS-APP-RENDER-SINGLE-FRAME: the full-screen els app paints one composed frame per render — the new-tab dialog spliced
// into its rows (no second cursor-addressed overlay pass), only the changed rows after the first frame, and every write
// one DEC 2026 synchronized update. Expectations are literals (rule 11), not built from the product's own constants.
import { expect, test } from 'bun:test';
import type { AttachHandlers, Attached } from './attach-client.js';
import { createAttachApp } from './attach-app.js';
import { createAppFrameWriter } from './attach-view.js';
import type { ElsResult } from './core.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const listing = JSON.stringify({ workspaces: [], tabs: [], panes: [{ address: 'w1/t1/p1', workspace: 'name-w1', pane: 'p1', title: 'one', state: 'idle' }] });

function app() {
  const out: string[] = [];
  const handlers: AttachHandlers[] = [];
  const view = createAttachApp({
    request: async (request): Promise<ElsResult> => ({ exitCode: 0, message: request.op === 'ls' ? listing : '' }),
    attach: (_pane, _size, h): Attached => { handlers.push(h); return { input: () => {}, resize: () => {}, scroll: () => {}, detach: () => {} }; },
    write: createAppFrameWriter((text) => { out.push(text); }),
    size: () => ({ cols: 80, rows: 24 }),
    cwd: '/work', env: { SHELL: '/bin/zsh' },
    setInterval: () => 0, clearInterval: () => {}, pollMs: 1000,
    chatCommand: ['/opt/elanous/bin/elanous'],
    memory: { load: () => ({}), save: () => {} },
  });
  const frame = (text: string): void => handlers[0]!.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 23, back: 0, screen: `[screen 51x23 cursor=(row 0, col 0, visible true)]\n${text}` });
  return { view, out, frame };
}

test('(a)(c) dialog open, then a background pane frame: one write, only the changed pane row — no dialog-area row is written again', async () => {
  const { view, out, frame } = app();
  await view.start();
  frame('first');
  view.key('\u0002c');                                            // ctrl+b c: the new-tab dialog opens
  expect(plain(out.at(-1)!)).toContain('새 탭 이름');               // the dialog arrives inside the frame write
  const before = out.length;
  frame('second');                                                // the pane changes under the open dialog
  expect(out.length - before).toBe(1);                            // (c) one render = one write
  const bytes = out.at(-1)!;
  expect(plain(bytes)).toContain('second');
  expect(plain(bytes)).not.toContain('새 탭 이름');                 // (a) the dialog's rows are not repainted
  expect(plain(bytes)).not.toContain('Name');
  for (const row of [9, 10, 11, 12, 13, 14, 15]) expect(bytes).not.toContain(`\u001b[${row};`);
  expect(bytes).toContain('\u001b[2;1H');                          // the pane's first line sits under the tab row
});

test('(b) every write is one synchronized update: starts with ?2026h, ends with ?2026l; an unchanged frame writes nothing; no 2J', async () => {
  const { view, out, frame } = app();
  await view.start();
  frame('first');
  view.key('\u0002c');
  view.key('ab');
  frame('second');
  const before = out.length;
  frame('second');                                                // identical frame: nothing to write
  expect(out.length).toBe(before);
  expect(out.length).toBeGreaterThan(3);
  for (const bytes of out) {
    expect(bytes.startsWith('\u001b[?2026h')).toBe(true);
    expect(bytes.endsWith('\u001b[?2026l')).toBe(true);
    expect(bytes).not.toContain('\u001b[2J');
  }
});

test('the dialog is spliced into the composed rows: row 9 keeps the side list and carries the box top — no cursor-addressed overlay', async () => {
  const { view, out, frame } = app();
  await view.start();
  frame('first');
  view.key('\u0002c');
  const all = out.join('');
  expect(all).not.toMatch(/\u001b\[9;31H/);                        // the old separate overlay write addressed (9, 31)
  const full = out.find((bytes) => bytes.includes('\u001b[9;1H'))!;
  const row9 = plain(full.slice(full.indexOf('\u001b[9;1H')).split('\u001b[10;1H')[0]!);
  expect(row9).toContain('│');
  expect(row9).toMatch(/╔ +새 탭 이름 +✕ ╗/);
});
