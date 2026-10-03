import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = new URL('./dart-disclosure-alert.ts', import.meta.url).pathname;

function runDartAlert(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
}

describe('DART disclosure alert flags', () => {
  const contract = { boolean: ['--to-pool'], valued: [] } as const;

  it('recognizes only the supported --to-pool boolean flag', () => {
    expect(unknownCronFlag(['--to-pool'], contract)).toBeUndefined();
    expect(unknownCronFlag(['--to-pooly'], contract)).toBe('--to-pooly');
  });

  it('rejects an unknown flag before disclosure collection or outbound work begins', () => {
    const result = runDartAlert('--to-pooly');
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(result.stderr.split('\n').filter((line) => line.trim().length > 0))
      .toEqual(['⛔ 모르는 플래그: --to-pooly']);
    expect(result.stdout).toBe('');
    expect(output).not.toContain('신규 공시 없음');
    expect(output).not.toContain('완료:');
  });

  it('does not leak a top-level error stack when rejecting an unknown flag', () => {
    const result = runDartAlert('--to-pooly');

    expect(result.stderr).not.toMatch(/^\s*at /m);
    expect(result.stderr).not.toContain('error: ');
    expect(result.stderr).not.toContain('dart-disclosure-alert.ts:');
  });

  it('wires the shared guard before path setup and all disclosure side effects', () => {
    const source = readFileSync(script, 'utf8');
    const guard = "unknownCronFlag(process.argv, { boolean: ['--to-pool'], valued: [] })";

    expect(source).toContain("import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';");
    expect(source).toContain(guard);
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('ensureCronNodePath();'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('new SignalPool()'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('const seen = loadSeen();'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('await fetchDisclosures('));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('sendOutbound(msg, \'alert\')'));
    expect(source).not.toMatch(/throw new Error\([^\n]*모르는 플래그/);
  });

  it('preserves the --to-pool branch', () => {
    const source = readFileSync(script, 'utf8');

    expect(source).toContain("const TO_POOL = process.argv.includes('--to-pool');");
    expect(source).toContain('if (TO_POOL && pool)');
  });
});
