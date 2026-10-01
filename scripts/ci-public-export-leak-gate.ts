/**
 * Public export leak check on changed files (LEAK1) — the same check `release prepare` fails on:
 * manifest transforms and private redactions applied, then the leak markers. A hit here fails the next prepare
 * (0.2.7: one test title), so `pr land` and the harness policy gates run it before landing.
 *
 *   bun scripts/ci-public-export-leak-gate.ts --changed-files a b …   # exit 1 on a hit · 0 when clean or not measurable
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { privateRedactionsPath } from './public-export.js';

export interface ExportLeakCheck {
  readonly measured: boolean;
  readonly hits: ReadonlyArray<{ readonly file: string; readonly line: number; readonly marker: string }>;
  readonly detail?: string;
}

export function exportLeakCheck(changedFiles: readonly string[], root: string): ExportLeakCheck {
  const script = join(root, 'scripts', 'public-export.ts');
  if (!existsSync(script)) return { measured: false, hits: [], detail: 'scripts/public-export.ts 없음' };
  // Without the private table (a Pod, a fresh machine) the markers still run; private identifiers are not checked.
  const privateList = existsSync(privateRedactionsPath()) ? [] : ['--no-private-list'];
  const r = spawnSync('bun', [script, '--leak-check', '--json', '--all', ...privateList, '--files', ...changedFiles], { cwd: root, encoding: 'utf-8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) return { measured: false, hits: [], detail: `rc=${r.status ?? r.signal}` };
  try {
    const parsed = JSON.parse(String(r.stdout).trim().split('\n').at(-1) ?? '') as { hits?: Array<{ file: string; line: number; marker: string }> };
    return { measured: true, hits: (parsed.hits ?? []).map((h) => ({ file: h.file, line: h.line, marker: h.marker })) };
  } catch { return { measured: false, hits: [], detail: 'JSON 을 못 읽었다' }; }
}

/** Gate form for the harness policy gates: 1 on a hit, 0 when clean or not measurable (said in a line). */
export function runPublicExportLeakGate(io: { args: readonly string[]; cwd: string; log: (line: string) => void; error: (line: string) => void }): number {
  const at = io.args.indexOf('--changed-files');
  const files = at >= 0 ? io.args.slice(at + 1).filter((a) => !a.startsWith('--')) : [];
  if (files.length === 0) return 0;
  const result = exportLeakCheck(files, io.cwd);
  if (!result.measured) { io.log(`⚠ public-export-leak: 못 쟀다(${result.detail ?? '?'})`); return 0; }
  if (result.hits.length === 0) return 0;
  io.error(`✗ public-export-leak: 바뀐 파일 ${result.hits.length}곳이 공개본에 사적 흔적을 싣는다 — 다음 release prepare 가 여기서 실패한다:`);
  for (const h of result.hits) io.error(`   ${h.file}:${h.line}  ${h.marker}`);
  io.error('   그 줄에서 표식·홈 경로·내부 문서 이름을 빼라(주석이면 공개본 변환이 지우는지 bun scripts/public-export.ts --leak-check --files <파일> 로 확인).');
  return 1;
}

if (import.meta.main) {
  process.exit(runPublicExportLeakGate({ args: process.argv.slice(2), cwd: resolve(import.meta.dir, '..'), log: console.log, error: console.error }));
}
