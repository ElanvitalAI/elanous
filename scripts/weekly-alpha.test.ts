import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { main } from './weekly-alpha.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = new URL('./weekly-alpha.ts', import.meta.url).pathname;

function runWeeklyAlpha(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
}

describe('weekly alpha flags', () => {
  it('rejects an injected unknown flag before the report builder runs', async () => {
    let buildCalls = 0;
    const errors: string[] = [];
    const exits: number[] = [];

    await main(['--collect-onlyy'], {
      buildWeeklyAlphaReport: async () => {
        buildCalls += 1;
        throw new Error('report builder must not run');
      },
      error: (message: unknown) => errors.push(String(message)),
      exit: ((code?: number) => { exits.push(code ?? 0); }) as typeof process.exit,
    });

    expect(buildCalls).toBe(0);
    expect(errors).toEqual(['⛔ 모르는 플래그: --collect-onlyy']);
    expect(exits).toEqual([1]);
  });

  it('accepts positional arguments and collect-only through the injected argv path', async () => {
    const builds: string[] = [];
    const report = { report: 'weekly report', savedPath: '/tmp/weekly.md', narrated: true };

    await main(['weekly'], {
      buildWeeklyAlphaReport: async () => {
        builds.push('positional');
        return report;
      },
      ensureCronNodePath: () => {},
      sendOutbound: () => true,
    });
    await main(['--collect-only'], {
      buildWeeklyAlphaReport: async () => {
        builds.push('collect-only');
        return report;
      },
      ensureCronNodePath: () => {},
      sendOutbound: () => true,
    });

    expect(builds).toEqual(['positional', 'collect-only']);
  });

  it('rejects an unknown flag before the weekly report starts on the real argv path', () => {
    const result = runWeeklyAlpha('--collect-onlyy');
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('⛔ 모르는 플래그: --collect-onlyy');
    expect(output).not.toContain('[weekly-alpha] narrated=');
  });

  it('rejects with exactly one clean stderr line and no stack frames', () => {
    const result = runWeeklyAlpha('--collect-onlyy');
    const stderrLines = result.stderr.split('\n').filter((line) => line.trim().length > 0);

    expect(stderrLines).toEqual(['⛔ 모르는 플래그: --collect-onlyy']);
    expect(result.stderr).not.toMatch(/^\s*at /m);
    expect(result.stderr).not.toContain('error: ');
    expect(result.stderr).not.toContain('weekly-alpha.ts:');
  });
});
