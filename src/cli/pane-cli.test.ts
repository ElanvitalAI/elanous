import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';
import { registerPaneCommands } from './pane-cli.js';

describe('pane list compatibility entry', () => {
  test('forwards workspace as separate arguments to the els process', async () => {
    const calls: string[][] = []; const exits: number[] = [];
    const program = new Command().exitOverride();
    registerPaneCommands(program, { run: async (args) => { calls.push([...args]); return 0; }, exit: (code) => exits.push(code), configOverride: () => undefined });
    await program.parseAsync(['node', 'eln', 'pane', 'list', '--workspace', 'w1']);
    expect(calls).toEqual([['pane', 'list', '--workspace', 'w1']]);
    expect(exits).toEqual([0]);
  });
  test('propagates the parent config override as argv without a shell', async () => {
    const calls: string[][] = []; const program = new Command().exitOverride();
    registerPaneCommands(program, { run: async (args) => { calls.push([...args]); return 0; }, exit: () => {}, configOverride: () => '/tmp/a b' });
    await program.parseAsync(['node', 'eln', 'pane', 'list']);
    expect(calls).toEqual([['--config-dir', '/tmp/a b', 'pane', 'list']]);
  });
  test('preserves a failed els exit instead of reporting an empty successful list', async () => {
    const exits: number[] = []; const program = new Command().exitOverride();
    registerPaneCommands(program, { run: async () => 7, exit: (code) => exits.push(code), configOverride: () => undefined });
    await program.parseAsync(['node', 'eln', 'pane', 'list']);
    expect(exits).toEqual([7]);
  });
  test('real child receives literal arguments and propagates its exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pane-cli-test-'));
    const oldPath = process.env.PATH; const oldCapture = process.env.PANE_TEST_CAPTURE;
    try {
      const capture = join(dir, 'args');
      writeFileSync(join(dir, 'els'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$PANE_TEST_CAPTURE"\nexit 7\n', { mode: 0o700 });
      process.env.PATH = dir; process.env.PANE_TEST_CAPTURE = capture;
      const exits: number[] = []; const program = new Command().exitOverride();
      registerPaneCommands(program, { exit: (code) => exits.push(code), configOverride: () => '/tmp/isolated config' });
      await program.parseAsync(['node', 'eln', 'pane', 'list', '--workspace', 'w;literal']);
      expect(readFileSync(capture, 'utf8')).toBe('--config-dir\n/tmp/isolated config\npane\nlist\n--workspace\nw;literal\n');
      expect(exits).toEqual([7]);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldCapture === undefined) delete process.env.PANE_TEST_CAPTURE; else process.env.PANE_TEST_CAPTURE = oldCapture;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('real CLI entry keeps the test universe when it launches els', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pane-cli-entry-'));
    try {
      const capture = join(dir, 'args');
      writeFileSync(join(dir, 'els'), '#!/bin/sh\nprintf "%s\\n" "$ELANOUS_STATE_DIR" "$@" > "$PANE_TEST_CAPTURE"\n', { mode: 0o700 });
      const child = await simCli([`--test=${dir}`, 'pane', 'list'], {
        mode: 'spawn', allowPaths: [['pane', 'list']], stateRoot: dir,
        env: { PATH: `${dir}:${process.env.PATH ?? ''}`, PANE_TEST_CAPTURE: capture, NODE_ENV: 'test' },
        // Source: .rules/30-harness/testing-gates.md §R-TST36; real CLI process probe under gate load.
        timeoutMs: 60_000,
      });
      if (child.exitCode !== 0) throw new Error(`CLI exit ${child.exitCode}: ${child.stderr}`);
      expect(readFileSync(capture, 'utf8')).toBe(`${dir}\n--config-dir\n${dir}\npane\nlist\n`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  // Source: .rules/30-harness/testing-gates.md §R-TST36; allow startup and cleanup after the child timeout.
  }, 90_000);
  test('read and literal send use els pane operations without shell interpretation', async () => {
    const calls: string[][] = []; const exits: number[] = [];
    const make = () => {
      const program = new Command().exitOverride();
      registerPaneCommands(program, { run: async (args) => { calls.push([...args]); return 0; }, exit: (code) => exits.push(code), configOverride: () => undefined });
      return program;
    };
    await make().parseAsync(['node', 'eln', 'pane', 'read', 'p:1']);
    await make().parseAsync(['node', 'eln', 'pane', 'send', 'p:1', 'literal; $(no-shell)']);
    await make().parseAsync(['node', 'eln', 'pane', 'send', 'p:1', 'run this', '--enter']);
    expect(calls).toEqual([
      ['pane', 'read', 'p:1'], ['pane', 'send-text', 'p:1', 'literal; $(no-shell)'],
      ['pane', 'run', 'p:1', 'run this'],
    ]);
    expect(exits).toEqual([0, 0, 0]);
  });
});
