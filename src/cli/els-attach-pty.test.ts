import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../els/client.js';
import { elsSocketPath, startElsServer } from '../els/server.js';
import { simCli } from '../ux-sim/in-process-cli.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// `els attach` in a real terminal against a real els server and a real shell pane: the screen shows the shell, typing
// reaches it, ctrl+b q leaves with exit 0, and the pane is still there afterwards.
test('real terminal: els attach shows the pane, types into it, detaches with ctrl+b q and leaves the pane running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-cliatt-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  const { pane } = JSON.parse(created.message) as { pane: string };
  cleanups.push(async () => { await requestEls(elsSocketPath(root), { op: 'close', pane }); });
  const run = await mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test-state-dir', '{root}', 'side', 'attach', pane],
    root, rows: 20, cols: 80,
    ready: { label: 'attached', timeoutMs: 30_000, until: (screen) => screen.includes('ctrl+b q 분리') && screen.includes('$') }, // 출처: #37153 live PTY readiness bound
    steps: [
      { label: 'typed', text: 'echo CLI_$((20+22))_OK', until: (screen) => screen.split('\n').some((line) => line.startsWith('CLI_42_OK')), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 150 frame polls
    ],
    quitKeys: '\u0002q',
  });
  expect(run.exitCode).toBe(0);
  expect(run.frames[0]?.screen).not.toContain('[screen');
  const listed = JSON.parse((await requestEls(elsSocketPath(root), { op: 'ls' })).message) as { panes: { ptyId: string; state: string }[] };
  expect(listed.panes.map((row) => [row.state === 'exited', row.ptyId !== ''])).toEqual([[false, true]]);
}, 90_000);

test('real terminal: a pane that exits under the view ends els attach with exit 1 and says why (a detach is the only 0)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-cliatt-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  const { pane } = JSON.parse(created.message) as { pane: string };
  const run = await mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test-state-dir', '{root}', 'side', 'attach', pane],
    root, rows: 20, cols: 80,
    ready: { label: 'attached', timeoutMs: 30_000, until: (screen) => screen.includes('ctrl+b q 분리') && screen.includes('$') }, // 출처: #37153 live PTY readiness bound
    steps: [
      { label: 'marked', text: 'echo LAST_SCREEN_$((3*3))', until: (screen) => screen.split('\n').some((line) => line.startsWith('LAST_SCREEN_9')), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 150 frame polls
      { label: 'pane-exits', text: 'exit', until: (screen) => screen.includes('the pane exited'), timeoutMs: 15_000 }, // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 150 frame polls
    ],
    quitKeys: '',
  });
  expect(run.exitCode).toBe(1);
  // The alternate screen is gone, but the pane's last screen is still on the terminal, above the message.
  const final = run.frames.at(-1)!.screen;
  expect(final).toContain('LAST_SCREEN_9');
  expect(final.indexOf('LAST_SCREEN_9')).toBeLessThan(final.indexOf('the pane exited'));
}, 90_000);

test('els attach without a terminal refuses with exit 2 and a hint for scripts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-cliatt-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const run = await simCli(['side', 'attach', 'p1'], { mode: 'spawn', allowPaths: [['side']], stateRoot: root, cwd: root, env: { NODE_ENV: 'development' } });
  expect(run.exitCode).toBe(2);
  expect(run.stderr).toContain('needs a terminal');
});
