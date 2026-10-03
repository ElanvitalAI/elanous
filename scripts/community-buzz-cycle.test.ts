import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const script = new URL('./community-buzz-cycle.ts', import.meta.url).pathname;

function runBuzzCycle(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  });
}

describe('community buzz cycle flags', () => {
  const contract = { boolean: ['--collect-only'], valued: [] } as const;

  it('recognizes only the supported --collect-only boolean flag', () => {
    expect(unknownCronFlag(['--collect-only'], contract)).toBeUndefined();
    expect(unknownCronFlag([], contract)).toBeUndefined();
    expect(unknownCronFlag(['--collect-onlyy'], contract)).toBe('--collect-onlyy');
  });

  it('rejects an unknown flag before any collection or outbound work begins', () => {
    const result = runBuzzCycle('--collect-onlyy');

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('⛔ 모르는 플래그: --collect-onlyy');
    // ⭐ 「그 문면이 없다」가 아니라 «아무것도 안 냈다»를 고정한다 — 수집·DB·발송 «전»에 멎는다는 뜻.
    expect(result.stdout).toBe('');
  });

  // ⛔ 이 스크립트는 모듈 «최상위»에서 argv 를 읽는다 ⇒ throw 하면 스택이 크론 로그로 샌다(`#15662`).
  it('rejects with exactly one clean stderr line and no stack frames', () => {
    const result = runBuzzCycle('--collect-onlyy');
    const stderrLines = result.stderr.split('\n').filter((line) => line.trim().length > 0);

    expect(stderrLines).toEqual(['⛔ 모르는 플래그: --collect-onlyy']);
    expect(result.stderr).not.toMatch(/^\s*at /m);
    expect(result.stderr).not.toContain('error: ');
  });

  // ⭐ 존속 기대 — 이 골이 «지우지 않았다»는 것을 고정한다.
  it('keeps the guard ahead of the collect-only branch and keeps that branch intact', () => {
    const source = readFileSync(script, 'utf8');
    const guard = "unknownCronFlag(process.argv, { boolean: ['--collect-only'], valued: [] })";

    expect(source).toContain("import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';");
    expect(source).toContain(guard);
    expect(source).toContain("const COLLECT_ONLY = process.argv.includes('--collect-only');");
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf('ensureCronNodePath()'));
    expect(source.indexOf(guard)).toBeLessThan(source.indexOf("const COLLECT_ONLY"));
  });
});
