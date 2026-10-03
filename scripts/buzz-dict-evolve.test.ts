import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditCronFlags } from './cron-flag-audit.js';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = new URL('./buzz-dict-evolve.ts', import.meta.url).pathname;

function runBuzzDictEvolve(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'buzz-dict-evolve-test-'));
  try {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('buzz dict evolve flags', () => {
  it('recognizes only the supported injected argv contract', () => {
    const contract = { boolean: ['--collect-only'], valued: [] } as const;

    expect(unknownCronFlag([], contract)).toBeUndefined();
    expect(unknownCronFlag(['--collect-only'], contract)).toBeUndefined();
    expect(unknownCronFlag(['--collect-onlyy'], contract)).toBe('--collect-onlyy');
  });

  it('rejects an unknown flag before buzz dictionary evolution starts', () => {
    const result = runBuzzDictEvolve('--collect-onlyy');
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('⛔ 모르는 플래그: --collect-onlyy');
    expect(output).not.toContain('=== dict-evolve 시작 ===');
  });

  it('rejects with exactly one clean stderr line and no stack frames', () => {
    const result = runBuzzDictEvolve('--collect-onlyy');
    const stderrLines = result.stderr.split('\n').filter((line) => line.trim().length > 0);

    expect(stderrLines).toEqual(['⛔ 모르는 플래그: --collect-onlyy']);
    expect(result.stderr).not.toMatch(/^\s*at /m);
    expect(result.stderr).not.toContain('error: ');
    expect(result.stderr).not.toContain('buzz-dict-evolve.ts:');
  });

  it('places the shared guard before cron setup and dictionary side effects', () => {
    const source = readFileSync(script, 'utf8');
    const guard = "unknownCronFlag(process.argv, { boolean: ['--collect-only'], valued: [] })";

    expect(source).toContain("import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';");
    expect(source).toContain(guard);
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('ensureCronNodePath();'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf("log('=== dict-evolve 시작 ===')"));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('const db = openBuzzDb();'));
  });

  it('preserves the collect-only outbound suppression branch', () => {
    const source = readFileSync(script, 'utf8');

    expect(source).toContain("if (process.argv.includes('--collect-only')) log(`collect-only — 사전 ${added}건 반영·발송 skip`);");
  });

  it('is recognized as guarded by the cron flag audit', () => {
    const source = readFileSync(script, 'utf8');
    const result = auditCronFlags(['0 6 * * 1 bun scripts/buzz-dict-evolve.ts --collect-only'], {
      sourceFor: (path) => path === 'scripts/buzz-dict-evolve.ts' ? source : null,
    });

    expect(result.guardAudit.guardedScripts).toEqual(['scripts/buzz-dict-evolve.ts']);
    expect(result.guardAudit.unguardedScripts).toEqual([]);
  });
});
