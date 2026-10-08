// TUI-BOOT-60 (10-08): an interactive login shell ignores SIGTERM, so a SIGTERM timeout never ended
// the env capture — a stale pyenv rehash lock (60 s wait in every `zsh -l -i`) held the TUI boot ~65 s.
// The fake shell below ignores TERM and sleeps far past the 3 s timeout, then prints a valid env.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetCapturedEnvForTesting, runPrintenvCapture, warmCapturedEnv } from './shell-env-bootstrap.js';

const dirs: string[] = [];
afterEach(() => {
  resetCapturedEnvForTesting();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function termIgnoringShell(): string {
  const dir = mkdtempSync(join(tmpdir(), 'env-timeout-'));
  dirs.push(dir);
  const shell = join(dir, 'sh'); // basename must be a known POSIX shell
  writeFileSync(shell, "#!/bin/sh\ntrap '' TERM\nsleep 12\nexec /usr/bin/printenv\n");
  chmodSync(shell, 0o755);
  return shell;
}

async function withShell<T>(shell: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.SHELL;
  process.env.SHELL = shell;
  try { return await fn(); } finally { process.env.SHELL = saved; }
}

test('sync capture gives up at the timeout even when the shell ignores SIGTERM', async () => {
  const shell = termIgnoringShell();
  const t0 = Date.now();
  const got = await withShell(shell, () => runPrintenvCapture());
  expect(got).toBeNull();
  expect(Date.now() - t0).toBeLessThan(8_000);
}, 20_000);

test('async warm gives up at the timeout even when the shell ignores SIGTERM', async () => {
  const shell = termIgnoringShell();
  const t0 = Date.now();
  const ok = await withShell(shell, () => warmCapturedEnv());
  expect(ok).toBe(false);
  expect(Date.now() - t0).toBeLessThan(8_000);
}, 20_000);
