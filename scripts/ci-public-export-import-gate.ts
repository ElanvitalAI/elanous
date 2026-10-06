/**
 * Public export import guard — a file the public export includes must not statically import
 * a module the export excludes. 0.2.15 shipped that break: src/decisions/proact-meter.ts
 * imported src/directives/directive-index (exclude `src/directives/directive-index*`) and the
 * export-check PWA build failed.
 *
 *   bun scripts/ci-public-export-import-gate.ts --changed-files a b …   # exit 1 on a hit · 0 when clean
 *
 * Only string-literal specifiers are resolved. Non-literal specifiers (createRequire with a
 * concatenated string, and the like) are counted as unseen — this check cannot see them.
 * The public PWA build itself stays on the release export-check run; it is not run here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
type ExportSelectors = {
  loadExportConfig: (root: string, file?: string) => { readonly include: readonly string[]; readonly exclude: readonly string[]; readonly replace: Readonly<Record<string, string>> };
  selectExportFiles: (tracked: readonly string[], config: { readonly include: readonly string[]; readonly exclude: readonly string[]; readonly replace: Readonly<Record<string, string>> }) => string[];
};

/**
 * scripts/public-export.ts `loadExportConfig` (line 123) and `selectExportFiles` (line 140).
 * Imported on call, not at load: that module imports typescript, and a tree that has not
 * installed it must still be able to load this gate and report why it could not measure.
 */
async function exportSelectors(): Promise<ExportSelectors> {
  return import('./public-export.js');
}

export interface ExportImportHit {
  readonly file: string;
  readonly line: number;
  readonly target: string;
}

export interface ExportImportCheck {
  readonly measured: boolean;
  readonly hits: readonly ExportImportHit[];
  readonly unseen: number;
  readonly detail?: string;
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const FROM_CLAUSE = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"\n;]*?\s+from\s+)?(['"])([^'"\n]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g;
const NON_LITERAL_IMPORT = /\b(?:import|require|createRequire)\s*\(\s*(?!['"`])/g;

function trackedFiles(root: string): string[] | undefined {
  const run = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf-8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) return undefined;
  return String(run.stdout).split('\0').filter(Boolean);
}

/** Specifier resolved against the importer's directory, then mapped onto a repo-relative path. */
function resolveSpecifier(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const raw = posix.normalize(posix.join(posix.dirname(importer), specifier));
  return raw.startsWith('../') ? undefined : raw;
}

function candidatePaths(resolved: string): string[] {
  const ext = posix.extname(resolved);
  const bases = ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs'
    ? [resolved.slice(0, -ext.length) + '.ts', resolved.slice(0, -ext.length) + '.tsx', resolved]
    : [resolved];
  const out: string[] = [];
  for (const base of bases) {
    out.push(base);
    if (!posix.extname(base)) {
      out.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`);
      out.push(posix.join(base, 'index.ts'), posix.join(base, 'index.tsx'), posix.join(base, 'index.js'));
    }
  }
  return out;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Changed files that the public manifest includes, scanned for a literal import of a tracked
 * module that the same manifest leaves out. `unseen` counts non-literal import/require calls.
 */
export async function exportImportCheck(changedFiles: readonly string[], root: string): Promise<ExportImportCheck> {
  const tracked = trackedFiles(root);
  if (!tracked) return { measured: false, hits: [], unseen: 0, detail: 'git ls-files 실패' };
  let included: Set<string>;
  try {
    const { loadExportConfig, selectExportFiles } = await exportSelectors();
    included = new Set(selectExportFiles(tracked, loadExportConfig(root)));
  } catch (error) {
    return { measured: false, hits: [], unseen: 0, detail: error instanceof Error ? error.message : '매니페스트를 못 읽었다' };
  }
  const trackedSet = new Set(tracked);
  const hits: ExportImportHit[] = [];
  let unseen = 0;
  for (const file of changedFiles) {
    if (!included.has(file) || !CODE_FILE.test(file)) continue;
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    let text: string;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const seen = new Set<string>();
    const consider = (index: number, specifier: string) => {
      const resolvedSpec = resolveSpecifier(file, specifier);
      if (!resolvedSpec) return;
      const target = candidatePaths(resolvedSpec).find((candidate) => trackedSet.has(candidate));
      if (!target || included.has(target)) return;
      const key = `${index}\0${target}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ file, line: lineOf(text, index), target });
    };
    for (const pattern of [FROM_CLAUSE, DYNAMIC_IMPORT]) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) consider(match.index ?? 0, match[2] ?? '');
    }
    NON_LITERAL_IMPORT.lastIndex = 0;
    unseen += [...text.matchAll(NON_LITERAL_IMPORT)].length;
  }
  return { measured: true, hits, unseen };
}

/** Gate form: 1 on a hit, 0 when clean. An unmeasured check blocks only when a changed file is included. */
export async function runPublicExportImportGate(io: { args: readonly string[]; cwd: string; log: (line: string) => void; error: (line: string) => void }): Promise<number> {
  const at = io.args.indexOf('--changed-files');
  const files = at >= 0 ? io.args.slice(at + 1).filter((arg) => !arg.startsWith('--')) : [];
  if (files.length === 0) return 0;
  let result: ExportImportCheck;
  try { result = await exportImportCheck(files, io.cwd); }
  catch { result = { measured: false, hits: [], unseen: 0, detail: '검사 실행 실패' }; }
  if (!result.measured) {
    let publicFiles = files;
    try {
      const { loadExportConfig, selectExportFiles } = await exportSelectors();
      publicFiles = selectExportFiles(files, loadExportConfig(io.cwd));
    } catch { publicFiles = files; }
    if (publicFiles.length === 0) { io.log('⚠ public-export-import: 못 쟀다 — 공개 대상 변경 없음'); return 0; }
    io.error(`✗ public-export-import: 못 쟀다 — 막는다(${result.detail ?? '?'})`);
    return 1;
  }
  if (result.unseen > 0) io.log(`⚠ public-export-import: 비리터럴 지정자 ${result.unseen}곳은 못 봄`);
  if (result.hits.length === 0) return 0;
  io.error(`✗ public-export-import: 공개 파일이 공개 내보내기에서 제외된 모듈을 import 한다 (${result.hits.length}곳) — 공개본 빌드가 여기서 깨진다:`);
  for (const hit of result.hits) io.error(`   ${hit.file}:${hit.line} → ${hit.target}`);
  return 1;
}

if (import.meta.main) {
  process.exit(await runPublicExportImportGate({ args: process.argv.slice(2), cwd: resolve(import.meta.dir, '..'), log: console.log, error: console.error }));
}
