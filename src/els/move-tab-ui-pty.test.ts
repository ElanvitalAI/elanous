import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requestEls } from './client.js';
import { elsSocketPath } from './server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// Same PTY readiness and action bounds as src/cli/els-app-tabs-pty.test.ts.
const READY_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

test('80x24 terminal moves the selected live tab to another space', async () => {
  const root = mkdtempSync('/tmp/els-move-ui-');
  const socket = elsSocketPath(root);
  const view = { executable: process.execPath, args: [join(import.meta.dir, '../../bin/elanous.mjs'), '--test-state-dir', '{root}', 'side'], root, rows: 24, cols: 80, env: { SHELL: '/bin/sh', NODE_ENV: 'development' }, quitKeys: '\u0002q' };
  let pid = 0;
  const original = process.env.ELANOUS_ELS_OWNER_TOKEN;
  try {
    const first = await mockSeatPtySequence({ ...view, ready: { label: 'initial', until: 'new · menu', timeoutMs: READY_TIMEOUT_MS }, steps: [{ label: 'initial-view', until: 'new · menu' }] });
    expect(first.exitCode).toBe(0);
    pid = Number((await requestEls(socket, { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
    process.env.ELANOUS_ELS_OWNER_TOKEN = readFileSync(join(root, 'els', 'owner-token'), 'utf8').trim();
    expect((await requestEls(socket, { op: 'seat-set', seat: 'OP' })).exitCode).toBe(0);
    const before = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { pane: string; workspace: string; ptyId: string }[] };
    const selected = before.panes[0]!;
    expect(selected.ptyId).toBeTruthy();
    expect((await requestEls(socket, { op: 'new', ws: 'target-space', cwd: root, command: ['/bin/sh'], title: 'target' })).exitCode).toBe(0);
    const run = await mockSeatPtySequence({ ...view, ready: { label: 'before-move', until: 'TARGET-SPACE', timeoutMs: READY_TIMEOUT_MS }, steps: [
      { label: 'choose-space', keys: '\u0002m', until: 'Move tab to space', timeoutMs: ACTION_TIMEOUT_MS },
      { label: 'after-move', keys: '\r', until: 'Tab moved', timeoutMs: ACTION_TIMEOUT_MS },
    ], artifactPath: '/tmp/cx7-tab-move-ui-80x24.json' });
    expect(run.exitCode).toBe(0);
    const beforeScreen = run.frames.find(frame => frame.label === 'before-move')!.screen;
    const pickerScreen = run.frames.find(frame => frame.label === 'choose-space')!.screen;
    const afterScreen = run.frames.find(frame => frame.label === 'after-move')!.screen;
    expect(beforeScreen.split('\n')[0]).not.toContain('TARGET');
    expect(pickerScreen).toContain('> target-space');
    expect(afterScreen.split('\n')[0]).toContain('TARGET');
    expect(afterScreen).toContain('Tab moved');
    const after = JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { pane: string; workspace: string; ptyId: string }[] };
    expect(after.panes.find(p => p.pane === selected.pane)).toMatchObject({ workspace: 'target-space', ptyId: selected.ptyId });
  } finally {
    if (original === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = original;
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
