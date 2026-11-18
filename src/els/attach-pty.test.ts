import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachEls, type AttachFrame } from './attach-client.js';
import { requestEls } from './client.js';
import { elsSocketPath, startElsServer } from './server.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (check: () => boolean, ms = 15_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 20)); }
};

// ELS-ATTACH-VIEW stage 2 on a REAL shell PTY owned by a real els server: type through the attach, see the answer in a
// frame, resize and see the shell's own size change, detach and find the pane still running with its output.
test('real PTY: typing, seeing the answer, resizing, detaching — the pane survives and a new attach sees the history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-ptyatt-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const socket = elsSocketPath(root);
  const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  expect(created.exitCode).toBe(0);
  const { pane } = JSON.parse(created.message) as { pane: string };
  cleanups.push(async () => { await requestEls(socket, { op: 'close', pane }); });

  const frames: AttachFrame[] = [];
  const first = attachEls(socket, pane, { cols: 90, rows: 20 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {} });
  cleanups.push(() => first.detach());
  const seen = (text: string) => frames.some((frame) => frame.screen.includes(text));
  await until(() => frames.length > 0);
  first.input('echo REAL_$((6*7))_OK\r');
  await until(() => seen('REAL_42_OK'));
  first.input('stty size\r');
  await until(() => seen('20 90'));
  first.resize(110, 31);
  first.input('stty size\r');
  await until(() => seen('31 110'));
  first.detach();

  // The pane outlived the view; a new attach starts from what the shell already printed.
  const later: AttachFrame[] = [];
  const second = attachEls(socket, pane, { cols: 110, rows: 31 }, { onFrame: (frame) => later.push(frame), onEnd: () => {} });
  cleanups.push(() => second.detach());
  await until(() => later.length > 0);
  expect(later[0]!.screen).toContain('REAL_42_OK');
}, 60_000); // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — a real shell start plus five waits of at most 15 s each
