// ELS-WHEEL-SCROLLBACK (OP #136704): a wheel over an alternate-screen pane that tracks its own
// mouse (?1049h + ?1000h/?1006h) must reach the pane as bytes — els has no scrollback lane to
// spin there (baseY=0 → clamped to 0), and swallowing the wheel leaves `eln`/`less` panes with
// their own scroller unable to scroll at all. A wheel over a normal-buffer pane keeps asking els
// to scroll the els scrollback (the existing lane — unchanged).
import { expect, test } from 'bun:test';
import type { AttachHandlers, Attached } from './attach-client.js';
import { createAttachApp } from './attach-app.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';

const row = (ws: string, pane: string) => ({ address: `${ws}/t1/${pane}`, workspace: `name-${ws}`, pane, title: 'alt', state: 'working' });
const listOf = (...panes: object[]): string => JSON.stringify({ workspaces: [], tabs: [], panes });
const WHEEL_UP = '\u001b[<64;60;10M';                                 // SGR 1006 wheel-up over the pane

type FramePayload = Parameters<AttachHandlers['onFrame']>[0];

function harness() {
  const listing = listOf(row('w1', 'p1'));
  const requests: ElsRequest[] = [];
  const attachments: { pane: string; handlers: AttachHandlers; typed: string[]; scrolls: number[] }[] = [];
  const app = createAttachApp({
    request: async (request: ElsRequest): Promise<ElsResult> => {
      requests.push(request);
      if (request.op === 'ls') return { exitCode: 0, message: listing };
      return { exitCode: 0, message: '' };
    },
    attach: (pane: string, size: { cols: number; rows: number }, handlers: AttachHandlers): Attached => {
      const a = { pane, size, handlers, typed: [] as string[], resizes: [] as [number, number][], scrolls: [] as number[], detached: false };
      attachments.push(a);
      return {
        input: (text: string) => { a.typed.push(text); },
        resize: (cols: number, rows: number) => { a.resizes.push([cols, rows]); },
        scroll: (lines: number) => { a.scrolls.push(lines); },   // Attached.scroll (attach-client.ts:27) — the wheel lane today
        detach: () => { a.detached = true; },
      } as unknown as Attached;
    },
    write: () => {},
    size: () => ({ cols: 80, rows: 24 }),
    cwd: '/tmp',
    env: {},
    setInterval: () => 0,
    clearInterval: () => {},
    pollMs: 60_000,
    chatCommand: ['elanous'],
    memory: { load: () => ({}), save: () => {} },
  });
  return { app, attachments, requests };
}

test('wheel over an alternate-screen pane that tracks its own mouse reaches the pane as bytes', async () => {
  const h = harness();
  await h.app.start('p1');
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 23, back: 0, screen: '[screen 51x23 scrolled-back=0]', wheelPassthrough: true } as FramePayload);
  h.app.key(WHEEL_UP);
  expect(h.attachments[0]!.typed).toEqual([WHEEL_UP]);              // RED today: swallowed into scrolls=[3]
  expect(h.attachments[0]!.scrolls).toEqual([]);
});

test('wheel over a normal-buffer pane keeps asking els to scroll the els scrollback', async () => {
  const h = harness();
  await h.app.start('p1');
  h.attachments[0]!.handlers.onFrame({ pane: 'p1', seq: 1, cols: 51, rows: 23, back: 0, screen: '[screen 51x23 scrolled-back=0]' } as FramePayload);
  h.app.key(WHEEL_UP);
  expect(h.attachments[0]!.scrolls).toEqual([3]);
  expect(h.attachments[0]!.typed).toEqual([]);
});