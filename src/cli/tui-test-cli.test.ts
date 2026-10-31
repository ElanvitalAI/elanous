import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { elanousInvocation } from '../instance/spawn-elanous.js';
import { buildHeldTuiArgs, parseReadyHeldPty, pwaBuildDecision } from './tui-test-cli.js';

describe('tui test setup', () => {
  test('reuses an export, skips missing PWA by default, and builds only when requested', () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-test-pwa-'));
    const pwa = join(root, 'apps/pwa');
    try {
      mkdirSync(pwa, { recursive: true });
      expect(pwaBuildDecision(pwa)).toBe('skip');
      expect(pwaBuildDecision(pwa, true)).toBe('build');
      mkdirSync(join(pwa, 'out'), { recursive: true });
      writeFileSync(join(pwa, 'out/index.html'), '<html></html>');
      expect(pwaBuildDecision(pwa, true)).toBe('reuse');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('held TUI readiness comes from an alive same-universe PTY row with a runId', () => {
  expect(parseReadyHeldPty(JSON.stringify([
    { id: 'pty_dead0000', alive: false, runId: 'run-dead' },
    { id: 'pty_live0000', alive: true, runId: 'run-live' },
  ]))).toEqual({ id: 'pty_live0000', runId: 'run-live' });
  expect(parseReadyHeldPty(JSON.stringify([{ id: 'pty_wait0000', alive: true }]))).toBeUndefined();
});

test('held TUI uses the isolated Git worktree as its cwd', () => {
  expect(buildHeldTuiArgs('/repo/bin/elanous.mjs', '/repo/.elanous-test-tui', 120_000, '/repo/worktree')).toEqual([
    '/repo/bin/elanous.mjs', '--test', 'dev', '--elanous', '--hold', '--json', '--isolated-root', '/repo/.elanous-test-tui', '--ready-timeout-ms', '120000', '--cwd', '/repo/worktree',
  ]);
});

test('spawnElanous prepends the held TUI entry once and stamps its isolated state root', () => {
  const entry = '/repo/bin/elanous.mjs';
  const stateDir = '/repo/.elanous-test-tui';
  const heldArgs = buildHeldTuiArgs(entry, stateDir, 120_000, '/repo/worktree');
  const invocation = elanousInvocation(heldArgs.slice(1), { bin: entry, stateDir, env: {} });
  expect(invocation.args).toEqual(heldArgs);
  expect(invocation.args.filter((arg) => arg === entry)).toHaveLength(1);
  expect(invocation.env).toMatchObject({ ELANOUS_STATE_DIR: stateDir });
  expect(invocation.env.ELANOUS_STATE_DIR_SOURCE).toBeTruthy();
});
