import { expect, test } from 'bun:test';
import { join } from 'node:path';

const cli = join(import.meta.dir, '..', 'bin', 'elanous.mjs');

function run(args: string[]) {
  return Bun.spawnSync([process.execPath, cli, '--test', ...args], {
    env: { ...process.env, ELANOUS_REMOTE: '', ELANOUS_RESUME_SESSION: '' },
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
}

test('root --rich is rejected by the actual CLI before dashboard boot or help', () => {
  for (const args of [['--rich'], ['--rich', '--help']]) {
    const result = run(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('elanous: --rich is no longer supported by the dashboard');
    expect(result.stdout.toString()).not.toContain('Usage:');
  }
});
