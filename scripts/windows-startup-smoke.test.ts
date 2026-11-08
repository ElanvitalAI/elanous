import { afterAll, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordWishBenchmarkSample, WINDOWS_WISH_LEDGER_MUTEX_SDDL, windowsWishLedgerMutexName } from '../src/intake-plane/wish-benchmark-ledger.js';

const stateDir = mkdtempSync(join(tmpdir(), 'elanous-windows-startup-'));
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

test.if(process.platform === 'win32')('Windows CLI startup smoke: help and WSL setup plan do not load POSIX libc', () => {
  const entry = join(import.meta.dir, '..', 'bin', 'elanous.mjs');
  for (const args of [['--help'], ['machine', 'setup', 'plan', '--platform', 'wsl']]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir, ELANOUS_CONFIG_DIR: stateDir },
    });
    expect(result.error?.message).toBeUndefined();
    expect(result.status, `${args.join(' ')} stderr: ${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('libc.so.6');
  }
});

test.if(process.platform === 'win32')('Windows global mutex serializes concurrent writers and rejects a linked ledger file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-windows-linked-ledger-'));
  const bench = join(root, 'bench');
  mkdirSync(bench);
  const originalStateDir = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    expect(windowsWishLedgerMutexName(root)).toStartWith('Global\\');
    expect(WINDOWS_WISH_LEDGER_MUTEX_SDDL).toContain('(A;;0x00100001;;;AU)');
    expect(WINDOWS_WISH_LEDGER_MUTEX_SDDL).toContain('S:(ML;;NW;;;LW)');
    const ledgerPath = join(bench, 'goal-bench-requirements.jsonl');
    const externalLedger = join(root, 'external-ledger.jsonl');
    writeFileSync(externalLedger, 'leave unchanged\n');
    linkSync(externalLedger, ledgerPath);
    expect(() => recordWishBenchmarkSample({ cardId: 'linked-ledger', at: '2026-01-01T00:00:00Z', surface: 'windows', text: 'x' }))
      .toThrow('Unsafe wish benchmark file');
    expect(readFileSync(externalLedger, 'utf8')).toBe('leave unchanged\n');
    rmSync(ledgerPath);
    const modulePath = new URL('../src/intake-plane/wish-benchmark-ledger.ts', import.meta.url).href;
    const child = () => new Promise<void>((resolve, reject) => {
      const writer = spawn(process.execPath, ['-e', `import { recordWishBenchmarkSample } from ${JSON.stringify(modulePath)}; recordWishBenchmarkSample({ cardId: 'dedupe', at: '2026-01-01T00:00:00Z', surface: 'windows', text: 'x' });`], {
        env: { ...process.env, ELANOUS_STATE_DIR: root }, stdio: 'ignore',
      });
      writer.once('error', reject);
      writer.once('exit', code => code === 0 ? resolve() : reject(new Error(`Windows ledger writer exited ${code}`)));
    });
    await Promise.all(Array.from({ length: 8 }, child));
    expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = originalStateDir;
    rmSync(root, { recursive: true, force: true });
  }
});
