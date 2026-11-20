import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { requestEls } from '../els/client.js';
import { elsSocketPath } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// SOCKET_SAFE_TMP: a Unix socket path holds at most 103 bytes (macOS), a long TMPDIR falls back to /tmp.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const ESC = '\u001b';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** `seat-set OP` as the person's terminal sends it: the credential is the server's owner-token file; this process's env is put back after. */
async function registerOpSeat(root: string): Promise<{ exitCode: number; message: string }> {
  const before = process.env.ELANOUS_ELS_OWNER_TOKEN;
  process.env.ELANOUS_ELS_OWNER_TOKEN = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();
  try { return await requestEls(elsSocketPath(root), { op: 'seat-set', seat: 'OP' }); }
  finally { if (before === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = before; }
}

/** The pane's rows of an app-view screen: what is right of the divider. */
const paneRows = (screen: string): string[] => screen.split('\n').filter((line) => line.includes('│')).map((line) => line.slice(line.indexOf('│') + 1).trimEnd());
const wheelUp = `${ESC}[<64;60;10M`;

test('real terminal: bare els over a pane whose output is longer than the screen — wheel up over the pane and ctrl+b [ show the earlier lines, typing returns to the live bottom', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-back-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const env = { SHELL: '/bin/sh', NODE_ENV: 'development' };
  const view = { executable: process.execPath, args: [BIN, '--test-state-dir', '{root}', 'side'], root, rows: 30, cols: 100, env };
  const shellShown = (screen: string): boolean => screen.split('\n').some((line) => line.includes('│') && line.includes('$'));
  const first = await mockSeatPtySequence({ ...view, ready: { label: 'first-screen', timeoutMs: 30_000, until: shellShown }, steps: [{ label: 'looked', text: '', until: 'new · menu', timeoutMs: 15_000 }], quitKeys: '\u0002q' });
  expect(first.exitCode).toBe(0);
  const pid = Number((await requestEls(elsSocketPath(root), { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
  cleanups.push(() => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  expect((await registerOpSeat(root)).exitCode).toBe(0);

  const has = (screen: string, row: string): boolean => paneRows(screen).includes(row);
  const run = await mockSeatPtySequence({
    ...view,
    ready: { label: 'first-screen-again', timeoutMs: 30_000, until: shellShown },
    steps: [
      { label: 'long-output', text: 'i=1; while [ $i -le 150 ]; do echo LINE_$i; i=$((i+1)); done; echo DONE_PRINTING', until: (screen) => has(screen, 'DONE_PRINTING'), timeoutMs: 60_000 },
      { label: 'wheel-up', keys: wheelUp.repeat(10), until: (screen) => has(screen, 'LINE_110') && !has(screen, 'DONE_PRINTING'), timeoutMs: 15_000 },
      { label: 'typing-returns-to-live', keys: 'z', until: (screen) => has(screen, 'DONE_PRINTING'), timeoutMs: 15_000 },
      { label: 'prefix-key-pages-up', keys: '\u0002[', until: (screen) => !has(screen, 'DONE_PRINTING') && paneRows(screen).some((row) => /^LINE_1[0-4]\d$/.test(row)), timeoutMs: 15_000 },
    ],
    quitKeys: '\u0002q',
  });
  expect(run.exitCode).toBe(0);
  expect(paneRows(run.frames[1]!.screen).filter((row) => row === 'LINE_100')).toEqual([]);   // before the wheel the earlier lines are off screen
}, 180_000);
