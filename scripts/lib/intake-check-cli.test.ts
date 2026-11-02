import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIntakeCheckInvocation } from './intake-check-cli.js';

test('checkout uses its Bun entrypoint and inherits the caller universe without forcing --test', () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-check-checkout-'));
  try {
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: /tmp/fake-worktree');
    writeFileSync(join(root, 'bin', 'elanous.mjs'), '');
    expect(buildIntakeCheckInvocation(['사실 A'], root)).toEqual({
      command: 'bun',
      args: [join(root, 'bin', 'elanous.mjs'), 'intake', 'check', '--fact', '사실 A', '--json'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed package uses eln and never asks --test to resolve a git tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-check-installed-'));
  try {
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin', 'elanous.mjs'), '');
    expect(buildIntakeCheckInvocation(['사실 A', '사실 B'], root)).toEqual({
      command: 'eln',
      args: ['intake', 'check', '--fact', '사실 A', '--fact', '사실 B', '--json'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
