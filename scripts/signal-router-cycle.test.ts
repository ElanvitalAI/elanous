import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';
import { auditCronFlags } from './cron-flag-audit.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = new URL('./signal-router-cycle.ts', import.meta.url).pathname;
const scriptPath = 'scripts/signal-router-cycle.ts';

function runSignalRouterCycle(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
}

describe('signal router cycle flags', () => {
  const contract = { boolean: ['--live'], valued: [] } as const;

  it('recognizes only the supported --live boolean flag', () => {
    expect(unknownCronFlag(['--live'], contract)).toBeUndefined();
    expect(unknownCronFlag([], contract)).toBeUndefined();
    expect(unknownCronFlag(['--livey'], contract)).toBe('--livey');
  });

  it('rejects an unknown flag before router work begins with one clean stderr line', () => {
    const result = runSignalRouterCycle('--livey');
    const stderrLines = result.stderr.split('\n').filter((line) => line.trim().length > 0);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(stderrLines).toEqual(['⛔ 모르는 플래그: --livey']);
    expect(result.stderr).not.toMatch(/^\s*at /m);
    expect(result.stderr).not.toContain('error: ');
    expect(result.stderr).not.toContain('signal-router-cycle.ts:');
  });

  it('wires the shared guard before cron setup and preserves the live branch', () => {
    const source = readFileSync(script, 'utf8');
    const guard = "unknownCronFlag(process.argv, { boolean: ['--live'], valued: [] })";

    expect(source).toContain("import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';");
    expect(source).toContain(guard);
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('ensureCronNodePath();'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('registerStandaloneLogSink('));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('new SignalPool()'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('runRouter(pool, LIVE ? { send: sendOutbound }'));
    expect(source).toContain("const LIVE = process.argv.includes('--live');");
    expect(source).not.toContain('if (import.meta.main)');
    expect(source).not.toMatch(/export\s+function/);
  });

  it('is recognized as guarded by the cron flag audit', () => {
    const source = readFileSync(script, 'utf8');
    const result = auditCronFlags([`5 8 * * * bun ${scriptPath} --live`], {
      sourceFor: (path) => path === scriptPath ? source : null,
    });

    expect(result.guardAudit.guardedScripts).toEqual([scriptPath]);
    expect(result.guardAudit.unguardedScripts).toEqual([]);
  });
});
