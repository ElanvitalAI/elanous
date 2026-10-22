import { expect, test } from 'bun:test';
import { effectiveRootTuiEntry, extractRootTuiEntry } from './root-tui-entry.js';

test('root TUI flag accepts either side of resume and other launch flags', () => {
  expect(extractRootTuiEntry(['--tui', 'next', '--resume', 'session']).args).toEqual(['--resume', 'session']);
  expect(extractRootTuiEntry(['--resume', 'session', '--tui', 'next'])).toEqual({
    args: ['--resume', 'session'], entry: 'next', explicit: true,
  });
  expect(extractRootTuiEntry(['--name', 'desk', '--tui=classic'])).toEqual({
    args: ['--name', 'desk'], entry: 'classic', explicit: true,
  });
});

test('bare launch defaults to classic; next opens only via --tui next', () => {
  expect(extractRootTuiEntry([])).toEqual({ args: [], entry: 'classic', explicit: false });
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

test('conflicting root TUI selectors are rejected in either order', () => {
  expect(extractRootTuiEntry(['--legacy', '--tui', 'next']).error).toContain('choose only one');
  expect(extractRootTuiEntry(['--tui', 'next', '--legacy']).error).toContain('choose only one');
});
