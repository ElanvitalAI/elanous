// V1-PCH — rerun existing PWA chat gap tests by document slot, once per release.
//
//   bun scripts/pch-regress.ts [--only PCH-1,PCH-5] [--json]
//
// ⛔ Not under `bun test`: this release runner itself invokes bun test in apps/pwa, one slot at a time;
// putting it in the test gate would recursively run the PWA tests instead of testing the runner with a fake executor.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PCH_REGRESS_MAP } from './lib/pch-regress-map.js';

export type TestExecution = { status: number | null; stdout: string; stderr: string; error?: Error };
export type TestExecutor = (files: readonly string[], cwd: string) => TestExecution;
export type PchResult = { id: string; files: readonly string[]; status: 'pass' | 'fail' | '시험 없음'; failure: string };

const PWA_DIR = join(import.meta.dir, '..', 'apps', 'pwa');

export const runBunTests: TestExecutor = (files, cwd) => {
  const result = spawnSync('bun', ['test', ...files], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) };
};

function firstFailure(output: string): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => /^\(fail\)\s|^[✗✘❌]\s/.test(line))
    ?? lines.find((line) => /^error:/i.test(line))
    ?? lines.find((line) => /^# Unhandled error/i.test(line))
    ?? lines.find(Boolean)
    ?? 'bun test 종료 오류 (출력 없음)';
}

export function runPchRegress(
  args: readonly string[],
  executor: TestExecutor = runBunTests,
  map: Readonly<Record<string, readonly string[]>> = PCH_REGRESS_MAP,
  depsInstalled: () => boolean = () => existsSync(join(PWA_DIR, 'node_modules', 'react')),
): { results: PchResult[]; exitCode: number; output: string } {
  let only: Set<string> | null = null;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') json = true;
    else if (args[index] === '--only' && args[index + 1] && !args[index + 1]!.startsWith('--')) {
      only = new Set(args[++index]!.split(',').map((id) => id.trim()).filter(Boolean));
    } else return { results: [], exitCode: 2, output: `pch-regress: 알 수 없거나 값이 없는 옵션: ${args[index]}` };
  }
  const unknown = [...(only ?? [])].filter((id) => !(id in map));
  if (unknown.length) return { results: [], exitCode: 2, output: `pch-regress: 없는 칸: ${unknown.join(', ')}` };
  const entries = Object.entries(map).filter(([id]) => !only || only.has(id));
  if (!entries.length) return { results: [], exitCode: 2, output: 'pch-regress: 고른 칸이 없다 (--only 확인)' };

  // Without apps/pwa deps every slot fails on `Cannot find package 'react'` — an environment gap, not a regression.
  if (entries.some(([, files]) => files.length) && !depsInstalled()) {
    return { results: [], exitCode: 2, output: 'pch-regress: apps/pwa 의존성이 없다 (node_modules/react) — 먼저 `cd apps/pwa && bun install`' };
  }
  const results: PchResult[] = [];
  for (const [id, files] of entries) {
    if (!files.length) {
      results.push({ id, files, status: '시험 없음', failure: '' });
      continue;
    }
    try {
      const run = executor(files, PWA_DIR);
      const output = `${run.stderr}\n${run.stdout}`;
      const completed = /\bRan [1-9]\d* tests? across\b/.test(output);
      const passed = /^[ \t]*[1-9]\d* pass\b/m.test(output);
      const status = run.status === 0 && completed && passed && !run.error ? 'pass' : 'fail';
      results.push({ id, files, status, failure: status === 'fail' ? (run.error?.message ?? (run.status === 0 && !passed ? '통과한 시험 없음 (0 pass)' : firstFailure(output))) : '' });
    } catch (error) {
      results.push({ id, files, status: 'fail', failure: String(error) });
    }
  }
  const fail = results.filter((row) => row.status === 'fail').length;
  const output = json
    ? JSON.stringify({ results, pass: results.filter((row) => row.status === 'pass').length, fail, noTests: results.filter((row) => row.status === '시험 없음').length })
    : [
      '| 칸 | 파일 수 | 시험 파일 | 결과 | 실패한 시험 이름 첫 줄 |',
      '|---|---:|---|---|---|',
      ...results.map((row) => `| ${row.id} | ${row.files.length} | ${row.files.join(', ') || '—'} | ${row.status} | ${row.failure.replace(/\|/g, '\\|')} |`),
      `pch-regress: pass ${results.length - fail - results.filter((row) => row.status === '시험 없음').length} · fail ${fail} · 시험 없음 ${results.filter((row) => row.status === '시험 없음').length}`,
    ].join('\n');
  return { results, exitCode: fail ? 1 : 0, output };
}

if (import.meta.main) {
  const result = runPchRegress(process.argv.slice(2));
  (result.exitCode === 2 ? console.error : console.log)(result.output);
  process.exitCode = result.exitCode;
}
