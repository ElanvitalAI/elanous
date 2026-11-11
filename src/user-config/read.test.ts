import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const FRESH_PROCESS_TIMEOUT_MS = 30_000; // Source: bound fresh-process reader checks against hangs while allowing Bun startup.

describe('user-config reader module entrypoint', () => {
  test('internal reader import without the façade fails with an explicit initialization error', () => {
    const readerPath = resolve(import.meta.dir, 'read.ts');
    const script = `const { getUserConfig } = await import(${JSON.stringify(readerPath)}); try { getUserConfig(); } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }`;
    const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_SUPPRESS_XDG_WARNING: '1' };
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: resolve(import.meta.dir, '../..'),
      env,
      encoding: 'utf8',
      timeout: FRESH_PROCESS_TIMEOUT_MS,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('user-config reader has not been initialized');
  });

  test('reader-first import initializes and reads the active config in a fresh process', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'user-config-reader-first-'));
    try {
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ llm: { provider: 'grok' } }));
      const readerPath = resolve(import.meta.dir, 'reader.ts');
      const script = `const { getUserConfig } = await import(${JSON.stringify(readerPath)}); console.log(getUserConfig().llm.provider);`;
      const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_STATE_DIR: stateDir, ELANOUS_SUPPRESS_XDG_WARNING: '1' };
      delete env.ELANOUS_CONFIG_DIR;
      delete env.ELANOUS_LLM_PROVIDER;
      delete env.ELANOUS_ESCALATE_PROVIDER;
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: resolve(import.meta.dir, '../..'),
        env,
        encoding: 'utf8',
        timeout: FRESH_PROCESS_TIMEOUT_MS,
      });
      // Source: a successful subprocess exit is the contract for the reader-first smoke test.
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim()).toBe('grok');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
