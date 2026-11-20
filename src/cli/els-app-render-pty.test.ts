import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Terminal } from '@xterm/headless';
import { requestEls } from '../els/client.js';
import { LEAVE_VIEW, SIDEBAR_COLS } from '../els/attach-view.js';
import { elsSocketPath } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// SOCKET_SAFE_TMP: a Unix socket path holds at most 103 bytes (macOS), a long TMPDIR falls back to /tmp.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const COLS = 100;
const ROWS = 30;
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

/** What an eln tab prints in the middle pane: Korean text, an OSC 8 link, an underlined coloured link (the colon-form underline
 *  the emulator hands the view), a separator far wider than the pane, and a table of double-width cells. One marker per logical line. */
function wideOutput(): string {
  const url = 'https://m.blog.naver.com/thegunggwol/222163566833';
  const lines = [
    `KO_LINE ${'한국어 문장 '.repeat(20)}`,
    `OSC_LINE ${ESC}]8;;${url}${ESC}\\[자료](${url})${ESC}]8;;${ESC}\\ ${'링크 '.repeat(20)}`,
    `UL_LINE ${ESC}[4m${ESC}[58;5;6m[자료](${url}) ${url}${ESC}[0m after`,
    `SEP_LINE ${'─'.repeat(200)}`,
    ...[1, 2, 3].map((n) => `TABLE_${n} │ 효종 │ 1649~1659 │ [자료](${url}) · 2020-12-05 · 2026-11-20 │`),
    'END_OF_WIDE',
  ];
  return `${lines.join('\n')}\n`;
}

/** Replays the bytes the app view wrote into a second headless terminal of the same size, so the result is read as a person's terminal draws it. */
function replayer(): { feed: (chunk: string) => void; settle: () => Promise<void>; terminal: Terminal } {
  const terminal = new Terminal({ rows: ROWS, cols: COLS, scrollback: 0, allowProposedApi: true });
  let pending = Promise.resolve();
  return { terminal, feed: (chunk) => { pending = pending.then(() => new Promise<void>((resolve) => terminal.write(chunk, resolve))); }, settle: () => pending };
}

test('real terminal: bare els with a pane printing Korean, OSC 8 links, a 200-cell separator and a CJK table — each line once, nothing past the pane width, no style leaking into the side list', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-wide-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'wide.txt'), wideOutput());
  const env = { SHELL: '/bin/sh', NODE_ENV: 'development' };
  const view = { executable: process.execPath, args: [BIN, '--test-state-dir', '{root}', 'side'], root, rows: ROWS, cols: COLS, env };
  const shellShown = (screen: string): boolean => screen.split('\n').some((line) => line.includes('│') && line.includes('$'));
  // The server is started by the first bare els; the person's OP seat lets the second one type into the pane.
  const first = await mockSeatPtySequence({ ...view, ready: { label: 'first-screen', timeoutMs: 30_000, until: shellShown }, steps: [{ label: 'looked', text: '', until: 'new · menu', timeoutMs: 15_000 }], quitKeys: '\u0002q' });
  expect(first.exitCode).toBe(0);
  const pid = Number((await requestEls(elsSocketPath(root), { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
  cleanups.push(() => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  expect((await registerOpSeat(root)).exitCode).toBe(0);

  const replay = replayer();
  const run = await mockSeatPtySequence({
    ...view,
    onOutput: (chunk) => replay.feed(chunk.split(LEAVE_VIEW).join('')), // the screen as it was before the view was left
    ready: { label: 'first-screen-again', timeoutMs: 30_000, until: shellShown },
    steps: [{ label: 'printed', text: `cat ${join(root, 'wide.txt')}`, until: 'END_OF_WIDE', timeoutMs: 20_000 }],
    quitKeys: '\u0002q',
  });
  expect(run.exitCode).toBe(0);
  const screen = run.frames.at(-1)!.screen;
  const lines = screen.split('\n');
  // (1) each logical line is drawn once.
  for (const marker of ['KO_LINE', 'OSC_LINE', 'UL_LINE', 'SEP_LINE', 'TABLE_1', 'TABLE_2', 'TABLE_3', 'END_OF_WIDE']) {
    expect(lines.filter((line) => line.includes(marker)).length).toBe(1);
  }
  // (2) the pane region is exactly the columns right of the side list: the divider stays on every pane row, and no row of the outer
  //     terminal was wrapped by an over-wide line.
  await replay.settle();
  const outer = replay.terminal.buffer.active;
  for (let y = 0; y < ROWS - 1; y++) {
    const line = outer.getLine(y)!;
    expect(line.isWrapped).toBe(false);
    expect(line.getCell(SIDEBAR_COLS)?.getChars()).toBe('│');
    for (let x = 0; x < SIDEBAR_COLS; x++) expect(line.getCell(x)?.isUnderline()).toBe(0);
  }
}, 180_000);
