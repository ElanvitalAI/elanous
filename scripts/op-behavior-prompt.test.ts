import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a reused isolated fixture yields identical assembled prompt snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'op-prompt-stable-test-'));
  try {
    const fixture = join(root, 'fixture'), state = join(root, 'state');
    mkdirSync(fixture); mkdirSync(state);
    const run = (output: string) => Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, 'op-behavior-prompt.ts'), output, 'gpt-6.1-terra', fixture],
      env: { ...process.env, ELANOUS_STATE_DIR: state, ELANOUS_SKIP_LOGIN_ENV: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    const a = join(root, 'a.txt'), b = join(root, 'b.txt');
    const first = run(a), second = run(b);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(readFileSync(a, 'utf8')).toBe(readFileSync(b, 'utf8'));
    const role = join(fixture, 'home', 'elanous-hq', 'seats', 'OP', 'AGENTS.local.md');
    writeFileSync(role, 'different fixture\n');
    expect(run(join(root, 'c.txt')).exitCode).not.toBe(0);
    expect(readFileSync(role, 'utf8')).toBe('different fixture\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
