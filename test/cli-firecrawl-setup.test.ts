// RFC #2161 FU A6-real P5 (2026-05-11) — firecrawl setup CLI tests.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFirecrawlSetup } from '../src/cli/firecrawl-setup.js';
import { resetUserConfig } from '../src/user-config.js';
import { scriptedIO } from '../src/onboarding.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';

const maskedIO = (lines: string[]) => { const io = scriptedIO(lines); return { ...io, askSecret: io.ask }; };

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'firecrawl-setup-'));
  setElanousConfigDir(tmpDir);
  delete process.env.FIRECRAWL_API_KEY;
  resetUserConfig();
});

afterEach(() => {
  resetElanousConfigDir();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FIRECRAWL_API_KEY;
  resetUserConfig();
});

describe('runFirecrawlSetup', () => {
  test('non-interactive: --api-key persists when CLI present', async () => {
    let captured = '';
    const output: string[] = [];
    const result = await runFirecrawlSetup({
      io: maskedIO([]),
      apiKeyInline: 'fc-test-key-1234567890',
      cliProbeFn: () => true,
      patchFn: (k) => { captured = k; },
      readExistingFn: () => ({ apiKey: '' }),
      out: { log: (message) => output.push(message), error: () => { /* silent */ } },
    });
    expect(result.exitCode).toBe(0);
    expect(result.keyWritten).toBe(true);
    expect(result.cliPresent).toBe(true);
    expect(captured).toBe('fc-test-key-1234567890');
    expect(output).toContain('  Used by: website crawl tool · model discovery');
  });

  test('non-interactive: --api-key persists even when CLI absent (deferred install path)', async () => {
    let captured = '';
    const result = await runFirecrawlSetup({
      io: maskedIO([]),
      apiKeyInline: 'fc-test-key-1234567890',
      cliProbeFn: () => false,
      patchFn: (k) => { captured = k; },
      readExistingFn: () => ({ apiKey: '' }),
      out: { log: () => { /* silent */ }, error: () => { /* silent */ } },
    });
    expect(result.exitCode).toBe(0);
    expect(result.keyWritten).toBe(true);
    expect(result.cliPresent).toBe(false);
    expect(captured).toBe('fc-test-key-1234567890');
  });

  test('interactive: prompts and persists entered key', async () => {
    let captured = '';
    const output: string[] = [];
    const result = await runFirecrawlSetup({
      io: maskedIO(['fc-interactive-key-9876']),
      cliProbeFn: () => true,
      patchFn: (k) => { captured = k; },
      readExistingFn: () => ({ apiKey: '' }),
      out: { log: (message) => output.push(message), error: () => { /* silent */ } },
    });
    expect(result.exitCode).toBe(0);
    expect(result.keyWritten).toBe(true);
    expect(captured).toBe('fc-interactive-key-9876');
    expect(output).toContain('  Used by: website crawl tool · model discovery');
  });

  test('interactive: empty input with existing key keeps existing', async () => {
    let captured = '';
    const result = await runFirecrawlSetup({
      io: maskedIO(['']),
      cliProbeFn: () => true,
      patchFn: (k) => { captured = k; },
      readExistingFn: () => ({ apiKey: 'existing-fc-key-abcdef' }),
      out: { log: () => { /* silent */ }, error: () => { /* silent */ } },
    });
    expect(result.exitCode).toBe(0);
    expect(result.keyWritten).toBe(true);
    expect(captured).toBe('existing-fc-key-abcdef');
  });

  test('interactive: re-prompts on too-short key, then accepts a valid one', async () => {
    let captured = '';
    const result = await runFirecrawlSetup({
      io: maskedIO(['short', 'fc-properly-sized-key-3210']),
      cliProbeFn: () => true,
      patchFn: (k) => { captured = k; },
      readExistingFn: () => ({ apiKey: '' }),
      out: { log: () => { /* silent */ }, error: () => { /* silent */ } },
    });
    expect(result.exitCode).toBe(0);
    expect(captured).toBe('fc-properly-sized-key-3210');
  });

  test('non-interactive: empty inline key + no existing → exit 1', async () => {
    const result = await runFirecrawlSetup({
      io: maskedIO(['', '', '']),  // would also fail interactively
      cliProbeFn: () => true,
      patchFn: () => { throw new Error('should not patch'); },
      readExistingFn: () => ({ apiKey: '' }),
      out: { log: () => { /* silent */ }, error: () => { /* silent */ } },
    });
    expect(result.exitCode).toBe(1);
    expect(result.keyWritten).toBe(false);
  });
});
