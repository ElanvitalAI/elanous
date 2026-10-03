import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditCronFlags } from './cron-flag-audit.js';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = new URL('./buzz-discovery.ts', import.meta.url).pathname;

function runBuzzDiscovery(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'buzz-discovery-test-'));
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

describe('buzz discovery flags', () => {
  it('recognizes only the supported injected argv contract', () => {
    const contract = { boolean: ['--to-pool'], valued: [] } as const;

    expect(unknownCronFlag([], contract)).toBeUndefined();
    expect(unknownCronFlag(['--to-pool'], contract)).toBeUndefined();
    expect(unknownCronFlag(['--to-pooly'], contract)).toBe('--to-pooly');
  });

  it('rejects an unknown flag before buzz discovery starts', () => {
    const result = runBuzzDiscovery('--to-pooly');
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('⛔ 모르는 플래그: --to-pooly');
    expect(result.stdout).toBe('');
    expect(output).not.toContain('=== buzz-discovery 시작 ===');
  });

  it('rejects with exactly one clean stderr line and no stack frames', () => {
    const result = runBuzzDiscovery('--to-pooly');
    const stderrLines = result.stderr.split('\n').filter((line) => line.trim().length > 0);

    expect(stderrLines).toEqual(['⛔ 모르는 플래그: --to-pooly']);
    expect(result.stderr).not.toMatch(/^\s*at /m);
    expect(result.stderr).not.toContain('error: ');
    expect(result.stderr).not.toContain('buzz-discovery.ts:');
  });

  it('places the shared guard before cron setup and discovery side effects', () => {
    const source = readFileSync(script, 'utf8');
    const guard = "unknownCronFlag(process.argv, { boolean: ['--to-pool'], valued: [] })";

    expect(source).toContain("import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';");
    expect(source).toContain(guard);
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('ensureCronNodePath();'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf("log('=== buzz-discovery 시작 ===')"));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('const buzzDb = openBuzzDb();'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('sendOutbound(report'));
  });

  it('preserves the to-pool and direct outbound branches', () => {
    const source = readFileSync(script, 'utf8');

    expect(source).toContain("const TO_POOL = process.argv.includes('--to-pool');");
    expect(source).toContain('if (TO_POOL) {');
    expect(source).toContain("sendOutbound(report, 'report')");
  });

  it('is recognized as guarded by the cron flag audit', () => {
    const source = readFileSync(script, 'utf8');
    const result = auditCronFlags(['0 10 * * 1-5 bun scripts/buzz-discovery.ts --to-pool'], {
      sourceFor: (path) => path === 'scripts/buzz-discovery.ts' ? source : null,
    });

    expect(result.guardAudit.guardedScripts).toEqual(['scripts/buzz-discovery.ts']);
    expect(result.guardAudit.unguardedScripts).toEqual([]);
  });
});
