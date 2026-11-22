import { afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHarnessCliCommand } from './harness-cli-command.js';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

function goalFile(body: string, name = 'GOAL-x.md'): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-intake-lint-'));
  temporary.push(dir);
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

async function runAsk(path: string): Promise<{ asks: number; errors: string[]; exitCode: typeof process.exitCode }> {
  let asks = 0;
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, {
    registerSink: async () => {},
    resolveSurface: async () => 'harness',
    ask: async () => { asks += 1; },
    launchGate: { readBudget: async () => ({ action: 'proceed', reasons: ['within budget'] }), activeRuns: () => [] },
  });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'ask', path, '--substrate', 'local', '--seat', 'TC', '--no-queue']);
  } finally { console.error = original; }
  return { asks, errors, exitCode: process.exitCode };
}

describe('harness ask intake lint', () => {
  test('goal without the five-field contract is refused before launch, nonzero exit', async () => {
    const result = await runAsk(goalFile('# 골\n\n## PROBLEM\n본문\n'));
    expect(result.asks).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.errors).toEqual([
      'harness ask: 골 계약 칸이 빠졌다 (5/5) — `## 골 계약` 절에 아래 칸을 채운 뒤 다시 쏜다',
      '  ### 완료선',
      '  기본: - M1: <요청 한 줄> · 증거: 시험',
      '  ### 범위 밖=FU',
      '  기본: - 없음',
      '  ### 검증 예산',
      '  기본: - 원격 1 · pregate 1',
      '  ### 판정',
      '  기본: - 등급: T1 · 판정자: 1 · 보안: 불필요',
      '  ### 라운드 상한',
      '  기본: - r3/r5',
    ]);
  });

  test('goal with all five fields is launched', async () => {
    const result = await runAsk(goalFile([
      '# 골', '', '## 골 계약', '', '### 완료선', '- M1: 된다 · 증거: 시험', '', '### 범위 밖=FU', '- 없음', '',
      '### 검증 예산', '- 원격 1 · pregate 1', '', '### 판정', '- 등급: T1 · 판정자: 1 · 보안: 불필요', '', '### 라운드 상한', '- r3/r5', '',
    ].join('\n')));
    expect(result.errors).toEqual([]);
    expect(result.asks).toBe(1);
  });

  test('ask-file (not a GOAL-*.md goal document) is not linted — the author fills the defaults', async () => {
    const result = await runAsk(goalFile('한 줄 요청\n', 'request.ask'));
    expect(result.errors).toEqual([]);
    expect(result.asks).toBe(1);
  });
});
