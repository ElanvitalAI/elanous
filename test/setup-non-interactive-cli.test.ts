import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');

describe('setup --non-interactive CLI', () => {
  test('reports credential steps without prompting or writing a config in an isolated home', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'setup-cli-state-'));
    try {
      const proc = Bun.spawn(['bun', 'bin/elanous.mjs', '--test', 'setup', '--non-interactive'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: stateRoot,
          XDG_CONFIG_HOME: join(stateRoot, 'config'),
          ELANOUS_STATE_DIR: join(stateRoot, 'state'),
          ELANOUS_SUPPRESS_XDG_WARNING: '1',
          PATH: process.env.PATH ?? '',
        },
        stdin: new TextEncoder().encode('should not be consumed\n'),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stdout).toContain('Setup: LLM credential steps');
      expect(stdout).toContain('Non-interactive: no questions were asked and no configuration was written.');
      expect(stderr).not.toContain('unknown option');
      expect(existsSync(join(stateRoot, '.elanous-test', 'config.json'))).toBe(false);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // src/cli/setup-cli.ts declares only --non-interactive; answer-file --config is no longer a supported setup option.
  test.each(['missing', 'malformed'] as const)('rejects the retired --config answer-file option (%s)', async (kind) => {
    const stateRoot = mkdtempSync(join(repoRoot, '.setup-cli-answer-'));
    try {
      const answerFilePath = join(stateRoot, 'answers.json');
      if (kind === 'malformed') writeFileSync(answerFilePath, '{not json}');
      const proc = Bun.spawn(['bun', 'bin/elanous.mjs', '--test', 'setup', '--non-interactive', '--config', answerFilePath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: stateRoot,
          XDG_CONFIG_HOME: join(stateRoot, 'config'),
          ELANOUS_STATE_DIR: join(stateRoot, 'state'),
          ELANOUS_SUPPRESS_XDG_WARNING: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(`${stdout}\n${stderr}`).toContain("unknown option '--config'");
      expect(existsSync(join(stateRoot, '.elanous-test', 'config.json'))).toBe(false);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
