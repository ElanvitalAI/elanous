import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { effectiveRootTuiEntry, extractRootTuiEntry } from './root-tui-entry.js';
import { simCli } from '../ux-sim/in-process-cli.js';

test('root TUI flag accepts either side of resume and other launch flags', () => {
  expect(extractRootTuiEntry(['--tui', 'next', '--resume', 'session']).args).toEqual(['--resume', 'session']);
  expect(extractRootTuiEntry(['--resume', 'session', '--tui', 'next'])).toEqual({
    args: ['--resume', 'session'], entry: 'next', explicit: true,
  });
  expect(extractRootTuiEntry(['--name', 'desk', '--tui=classic'])).toEqual({
    args: ['--name', 'desk'], entry: 'classic', explicit: true,
  });
});

test('local root launch defaults to classic; next stays explicit', () => {
  expect(extractRootTuiEntry([])).toEqual({ args: [], entry: 'classic', explicit: false });
  expect(extractRootTuiEntry(['--'])).toEqual({ args: ['--'], entry: 'classic', explicit: false });
  expect(extractRootTuiEntry(['--tui', 'next'])).toEqual({ args: [], entry: 'next', explicit: true });
  expect(extractRootTuiEntry(['--tui=next'])).toEqual({ args: [], entry: 'next', explicit: true });
  expect(extractRootTuiEntry(['--tui', 'classic'])).toEqual({ args: [], entry: 'classic', explicit: true });
  expect(extractRootTuiEntry(['--resume', 'session'])).toEqual({
    args: ['--resume', 'session'], entry: 'classic', explicit: false,
  });
  expect(extractRootTuiEntry(['--legacy'])).toEqual({ args: [], entry: 'classic', explicit: true });
  expect(extractRootTuiEntry(['--resume', 'session', '--legacy'])).toEqual({
    args: ['--resume', 'session'], entry: 'classic', explicit: true,
  });
});

test('subcommand TUI option remains with its subcommand', () => {
  expect(extractRootTuiEntry(['nexus', 'run', '--tui'])).toEqual({
    args: ['nexus', 'run', '--tui'], entry: 'classic', explicit: false,
  });
  expect(extractRootTuiEntry(['--', '--tui', 'next'])).toEqual({
    args: ['--', '--tui', 'next'], entry: 'classic', explicit: false,
  });
  expect(extractRootTuiEntry(['--tui', 'wrong']).error).toContain('expects classic or next');
});

test('bare root -r does not consume a following subcommand', () => {
  expect(extractRootTuiEntry(['-r', 'nexus', '--tui', 'classic'])).toEqual({
    args: ['-r', 'nexus', '--tui', 'classic'], entry: 'classic', explicit: false,
  });
  expect(extractRootTuiEntry(['-r', '--tui', 'next'])).toEqual({
    args: ['-r'], entry: 'next', explicit: true,
  });
});

test('bare remote entry keeps the dashboard transport', () => {
  expect(effectiveRootTuiEntry(extractRootTuiEntry([]), true)).toBe('classic');
  expect(effectiveRootTuiEntry(extractRootTuiEntry([]), false)).toBe('classic');
  expect(effectiveRootTuiEntry(extractRootTuiEntry(['--tui', 'next']), false)).toBe('next');
  expect(effectiveRootTuiEntry(extractRootTuiEntry(['--tui', 'next']), true)).toBe('next');
  expect(effectiveRootTuiEntry(extractRootTuiEntry(['--legacy']), true)).toBe('classic');
});

test('isolated remote root explains its classic TUI before attempting a non-TTY launch', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'elanous-remote-classic-notice-'));
  try {
    const result = await simCli([], {
      mode: 'spawn', stateRoot: root, allowPaths: [[]],
      env: {
        ELANOUS_REMOTE: 'ws://127.0.0.1:9/v1/acp',
        ELANOUS_NO_AUTH: '1',
        ELANOUS_SKIP_LOGIN_ENV: '1',
      },
    });
    const notice = '기본 TUI는 classic입니다. next는 --tui next로 열 수 있습니다. 원격 next TUI는 지원하지 않습니다.';
    expect(result.stdout).toContain(notice);
    expect(result.stdout.split(notice)).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('conflicting root TUI selectors are rejected in either order', () => {
  expect(extractRootTuiEntry(['--legacy', '--tui', 'next']).error).toContain('choose only one');
  expect(extractRootTuiEntry(['--tui', 'next', '--legacy']).error).toContain('choose only one');
});
