import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = new URL('./retro-cycle.ts', import.meta.url).pathname;

function runRetro(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'retro-cycle-test-'));
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

describe('retro cycle flags', () => {
  it('recognizes only the supported injected argv while consuming the period value', () => {
    const contract = {
      boolean: ['--collect-only'],
      valued: ['--period'],
    } as const;

    expect(unknownCronFlag(['--period', 'monthly', '--collect-only'], contract)).toBeUndefined();
    expect(unknownCronFlag(['--collect-onlyy'], contract)).toBe('--collect-onlyy');
    expect(unknownCronFlag(['--period', '--collect-only'], { boolean: ['--collect-only'], valued: [] })).toBe('--period');
  });

  it('rejects an unknown flag before the retro cycle starts', () => {
    const result = runRetro('--collect-onlyy');
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('⛔ 모르는 플래그: --collect-onlyy');
    expect(output).not.toContain('retro weekly:');
  });

  // ⛔ 이 PR 이 «고친 것»이 바로 이 성질이다 — 초안은 모듈 최상위 `throw` 라 크론 로그로
  //   스택 트레이스가 샜다. 「거부한다」만 물면 그 회귀를 «못 잡는다».
  it('rejects with exactly one clean stderr line and no stack frames', () => {
    const result = runRetro('--collect-onlyy');
    const stderrLines = result.stderr.split('\n').filter((line) => line.trim().length > 0);

    expect(stderrLines).toEqual(['⛔ 모르는 플래그: --collect-onlyy']);
    expect(result.stderr).not.toMatch(/^\s*at /m);
    expect(result.stderr).not.toContain('error: ');
    expect(result.stderr).not.toContain('retro-cycle.ts:');
  });

  it('places the shared guard before period parsing and retro side effects', () => {
    const source = readFileSync(script, 'utf8');
    const guard = "unknownCronFlag(process.argv, { boolean: ['--collect-only'], valued: ['--period'] })";

    expect(source).toContain("import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';");
    expect(source).toContain(guard);
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf("const pIdx = process.argv.indexOf('--period');"));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('mkdirSync(REPORT_DIR'));
  });

  it('preserves the default weekly fallback and monthly parsing in the top-level argv contract', () => {
    const source = readFileSync(script, 'utf8');

    expect(source).toContain("const period = (pIdx >= 0 ? process.argv[pIdx + 1] : 'weekly') as RetroPeriod;");
    expect(source).toContain("if (!['weekly', 'monthly', 'quarterly', 'annual'].includes(period))");
  });
});
