/**
 * Public export leak check on changed files (LEAK1) — the same check `release prepare` fails on:
 * manifest transforms and private redactions applied, then the leak markers. A hit here fails the next prepare
 * (0.2.7: one test title), so `pr land` and the harness policy gates run it before landing.
 *
 *   bun scripts/ci-public-export-leak-gate.ts --changed-files a b …   # exit 1 on a hit · 0 when clean
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { stringify } from 'yaml';
import { computeSkillBoundaries, filterFilesBySkillVerdict } from './skill-boundary.js';
import { loadExportConfig, privateRedactionsPath, selectExportFiles } from './public-export.js';

export interface ExportLeakCheck {
  readonly measured: boolean;
  readonly hits: ReadonlyArray<{ readonly file: string; readonly line: number; readonly marker: string }>;
  readonly detail?: string;
}

/** Changed source paths that the public manifest would export; unknown skill boundaries remain in scope. */
export function publicExportChangedFiles(changedFiles: readonly string[], root: string): string[] {
  const config = loadExportConfig(root);
  const selected = [...new Set([
    ...selectExportFiles(changedFiles, config),
    ...changedFiles.filter((file) => Object.values(config.replace).includes(file)),
  ])];
  if (!config.skills || !selected.some((file) => file.startsWith('skills/'))) return selected;
  try {
    const boundary = computeSkillBoundaries(root);
    if (boundary.errors.length) return selected;
    return filterFilesBySkillVerdict(selected, boundary, config.skills);
  } catch { return selected; }
}

export function exportLeakCheck(changedFiles: readonly string[], root: string, spawn: typeof spawnSync = spawnSync): ExportLeakCheck {
  const script = join(root, 'scripts', 'public-export.ts');
  if (!existsSync(script)) return { measured: false, hits: [], detail: 'scripts/public-export.ts 없음' };
  // Without the private table (a Pod, a fresh machine) the markers still run; private identifiers are not checked.
  const privateList = existsSync(privateRedactionsPath()) ? [] : ['--no-private-list'];
  const args = ['--leak-check', '--json', '--all', ...privateList, '--files', ...changedFiles];
  const run = (flags: string[]) => spawn('bun', [script, ...flags], { cwd: root, encoding: 'utf-8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  const initial = run(args);
  if (initial.status !== 2) return measuredLeaks(initial);

  const hits = [...String(initial.stderr).matchAll(/^⛔ skill boundary: ([^:\r\n]+):[^\r\n]*$/gm)]
    .map((match) => ({ file: `skills/${match[1]}/SKILL.md`, line: 1, marker: 'skill-boundary' }));
  if (!hits.length || !String(initial.stderr).trim().split(/\r?\n/).every((line) => /^⛔ skill boundary: [^:\r\n]+:[^\r\n]*$/.test(line))) {
    return { measured: false, hits: [], detail: 'rc=2' };
  }

  // The exporter stops before scanning any changed file on a boundary error. Re-run its
  // same transforms and leak check with only boundary selection disabled; retain the boundary hits.
  let dir: string | undefined;
  try {
    const config = loadExportConfig(root);
    dir = mkdtempSync(join(tmpdir(), 'public-export-leak-'));
    const configPath = join(dir, 'export.yaml');
    writeFileSync(configPath, stringify({ ...config, skills: undefined }));
    const measured = measuredLeaks(run(['--config', relative(root, configPath), ...args]));
    return { ...measured, hits: [...hits, ...measured.hits] };
  } catch {
    return { measured: false, hits, detail: 'skill boundary 뒤 재검사 실패' };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function measuredLeaks(r: ReturnType<typeof spawnSync>): ExportLeakCheck {
  if (r.status !== 0 && r.status !== 1) return { measured: false, hits: [], detail: `rc=${r.status ?? r.signal}` };
  try {
    const parsed: unknown = JSON.parse(String(r.stdout).trim().split('\n').at(-1) ?? '');
    if (!parsed || typeof parsed !== 'object' || !('hits' in parsed) || !Array.isArray(parsed.hits)
      || parsed.hits.some((h: unknown) => !h || typeof h !== 'object'
        || typeof (h as { file?: unknown }).file !== 'string'
        || typeof (h as { line?: unknown }).line !== 'number'
        || typeof (h as { marker?: unknown }).marker !== 'string')) throw new Error('invalid hits');
    return { measured: true, hits: parsed.hits.map((h: { file: string; line: number; marker: string }) => ({ file: h.file, line: h.line, marker: h.marker })) };
  } catch { return { measured: false, hits: [], detail: 'JSON 을 못 읽었다' }; }
}

/** Gate form for the harness policy gates: 1 on a hit, 0 when clean (said in a line). */
export function runPublicExportLeakGate(io: { args: readonly string[]; cwd: string; log: (line: string) => void; error: (line: string) => void }): number {
  const at = io.args.indexOf('--changed-files');
  const files = at >= 0 ? io.args.slice(at + 1).filter((a) => !a.startsWith('--')) : [];
  if (files.length === 0) return 0;
  let result: ExportLeakCheck;
  try { result = exportLeakCheck(files, io.cwd); }
  catch { result = { measured: false, hits: [], detail: '검사 실행 실패' }; }
  if (!result.measured) {
    let publicFiles: string[];
    try { publicFiles = publicExportChangedFiles(files, io.cwd); }
    catch { publicFiles = files; }
    if (publicFiles.length === 0) { io.log('⚠ public-export-leak: 못 쟀다 — 공개 대상 변경 없음'); return 0; }
    io.error(`✗ public-export-leak: 못 쟀다 — 막는다(${result.detail ?? '?'})`);
    return 1;
  }
  const hits = result.hits.filter((hit) => hit.marker !== 'skill-boundary' || files.includes(hit.file));
  if (hits.length === 0) return 0;
  io.error(`✗ public-export-leak: 바뀐 파일 ${hits.length}곳이 공개본에 사적 흔적을 싣는다 — 다음 release prepare 가 여기서 실패한다:`);
  for (const h of hits) io.error(`   ${h.file}:${h.line} · ${h.marker}`);
  io.error('   그 줄에서 표식·홈 경로·내부 문서 이름을 빼라(주석이면 공개본 변환이 지우는지 bun scripts/public-export.ts --leak-check --files <파일> 로 확인).');
  return 1;
}

if (import.meta.main) {
  process.exit(runPublicExportLeakGate({ args: process.argv.slice(2), cwd: resolve(import.meta.dir, '..'), log: console.log, error: console.error }));
}
