import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { auditCronFlags } from './cron-flag-audit.js';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = new URL('./x-breaking-alert.ts', import.meta.url).pathname;

function runBreakingAlert(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
}

describe('X breaking alert flags', () => {
  const contract = { boolean: ['--collect-only'], valued: [] } as const;

  it('recognizes only the supported --collect-only boolean flag', () => {
    expect(unknownCronFlag([], contract)).toBeUndefined();
    expect(unknownCronFlag(['--collect-only'], contract)).toBeUndefined();
    expect(unknownCronFlag(['--collect-onlyy'], contract)).toBe('--collect-onlyy');
  });

  it('rejects an unknown flag before collection, database, or outbound work begins', () => {
    const result = runBreakingAlert('--collect-onlyy');

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.split('\n').filter((line) => line.trim().length > 0))
      .toEqual(['⛔ 모르는 플래그: --collect-onlyy']);
  });

  it('does not leak a top-level error stack when rejecting an unknown flag', () => {
    const result = runBreakingAlert('--collect-onlyy');

    expect(result.stderr).not.toMatch(/^\s*at /m);
    expect(result.stderr).not.toContain('error: ');
    expect(result.stderr).not.toContain('x-breaking-alert.ts:');
  });

  it('wires the shared guard before cron setup and breaking-alert side effects', () => {
    const source = readFileSync(script, 'utf8');
    const guard = "unknownCronFlag(process.argv.slice(2), { boolean: ['--collect-only'], valued: [] })";

    expect(source).toContain("import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';");
    expect(source).toContain(guard);
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('ensureCronNodePath();'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf("const COLLECT_ONLY = process.argv.includes('--collect-only');"));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('const db = openSignalsDb();'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf("sendOutbound(msg, 'alert')"));
    expect(source).not.toMatch(/throw new Error\([^\n]*모르는 플래그/);
    expect(source).not.toContain('if (import.meta.main)');
  });

  it('preserves the existing --collect-only branch', () => {
    const source = readFileSync(script, 'utf8');

    expect(source).toContain("const COLLECT_ONLY = process.argv.includes('--collect-only');");
    expect(source).toContain('if (COLLECT_ONLY)');
  });

  it('is recognized as guarded by the cron flag audit', () => {
    const source = readFileSync(script, 'utf8');
    const result = auditCronFlags(['*/15 * * * * bun scripts/x-breaking-alert.ts --collect-only'], {
      sourceFor: (path) => path === 'scripts/x-breaking-alert.ts' ? source : null,
    });

    expect(result.guardAudit.guardedScripts).toEqual(['scripts/x-breaking-alert.ts']);
    expect(result.guardAudit.unguardedScripts).toEqual([]);
  });
});
