/**
 * DEAD-EXPORT-PREGATE — 새 export 중 비시험 호출처가 0 인 것을 경고만 한다.
 * 게이트 status 는 바꾸지 않는다(칸: 처음엔 경고만).
 *
 *   bun scripts/dead-export-warn.ts --base <sha> --head <sha>
 *   stdout: JSON { status: 'WARN'|'CLEAN'|'UNMEASURED', warnings: [{file,line,name}],
 *                  unmeasured: [{file,line,name,reason}] }
 *   status: 경고가 있으면 WARN. 없고 무명 star 재수출(`export * from '…'`)이 있으면
 *   UNMEASURED(조용한 CLEAN 금지). default 형태는 unmeasured 에 기록만 한다(경고도 status 변경도 없음).
 */
import { spawnSync } from 'node:child_process';

export interface DeadExportWarning {
  file: string;
  line: number;
  name: string;
}

/** 측정 불가 형태(default·별칭 없는 star). 경고는 아니지만 조용한 CLEAN 을 막는다. */
export type UnmeasuredExportReason = 'default-export' | 'anonymous-star-reexport';

export interface DeadExportUnmeasured {
  file: string;
  line: number;
  /** default 심볼 이름(무명이면 'default'), 별칭 없는 star 는 '*'. */
  name: string;
  reason: UnmeasuredExportReason;
}

export interface DeadExportReport {
  status: 'WARN' | 'CLEAN' | 'UNMEASURED';
  warnings: DeadExportWarning[];
  unmeasured: DeadExportUnmeasured[];
  reason?: string;
  /** ⭐ 출처 키(#38412 r5): 이 리포트가 어느 base…head(PR) 에 대해 측정됐는지.
   *  읽는 쪽(review-context-pack)이 현재 리뷰 head 와 대조해 낡은 리포트 재사용 오염을 막는다. */
  base?: string;
  head?: string;
  pr?: string;
}

const EXPORT_CLAUSE_RE = /^export\s*\{([^}]*)\}/;
const EXPORT_STAR_RE = /^export\s*\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*from\s*['"]/;
// default 뒤 선언형이면 심볼명을, 아니면 표현식이므로 'default' 로 기록한다.
const EXPORT_DEFAULT_RE =
  /^export\s+default\b(?:\s+(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*))?/;
const EXPORT_DECLARATION_RE = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|const|class|let|var|enum|type|interface)\s+([A-Za-z_$][\w$]*)/;

export interface ExportNamesInLine {
  /** 죽었는지 측정할 수 있는, 외부에 보이는 이름들. */
  measurable: string[];
  /** 형태는 인식했으나 측정 불가(default·별칭 없는 star). */
  recognizedUnmeasurable: boolean;
  /** 측정 불가 형태의 심볼(default 선언명 또는 'default', 별칭 없는 star 는 '*'). 측정 가능 형태면 없음. */
  unmeasuredName?: string;
}

/**
 * 한 줄의 export 형태를 분류한다.
 * - `export { a, b as c } [from '…']` → 외부에 보이는 이름 a, c(지역 별칭 b 가 아니라).
 * - `export declare function x()` / `export declare const y` → declare 없는 형태와 동일하게 수집.
 * - `export default function/class 이름` → 인식은 하되 경고 대상에서 제외한다. 소비자가 임의
 *   별칭으로 import 하므로 이름 토큰 사용 검색은 오탐이다(«인식했으나 측정 불가»).
 *   심볼명(무명 표현식이면 'default')은 unmeasuredName 으로 돌려 리포트에 기록한다.
 * - `export * from '…'` → 인식은 하되 로컬에 귀속될 이름이 없어 경고할 이름이 없다.
 *   (`export * as ns from '…'` 는 별칭 ns 가 외부 이름이므로 측정한다.)
 */
export function exportNamesInLine(line: string): ExportNamesInLine {
  const trimmed = line.trim();
  const def = EXPORT_DEFAULT_RE.exec(trimmed);
  if (def) return { measurable: [], recognizedUnmeasurable: true, unmeasuredName: def[1] ?? 'default' };
  const star = EXPORT_STAR_RE.exec(trimmed);
  if (star) {
    return star[1]
      ? { measurable: [star[1]], recognizedUnmeasurable: false }
      : { measurable: [], recognizedUnmeasurable: true, unmeasuredName: '*' };
  }
  const clause = EXPORT_CLAUSE_RE.exec(trimmed);
  if (clause) {
    const measurable: string[] = [];
    for (const rawSpec of clause[1]!.split(',')) {
      const spec = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(rawSpec.trim());
      if (spec) measurable.push(spec[2] ?? spec[1]!);
    }
    return { measurable, recognizedUnmeasurable: false };
  }
  const decl = EXPORT_DECLARATION_RE.exec(trimmed);
  if (decl) return { measurable: [decl[1]!], recognizedUnmeasurable: false };
  return { measurable: [], recognizedUnmeasurable: false };
}
const SOURCE_RE = /^(?:src|scripts|apps|plugins|skills)\/.*\.(?:ts|tsx|js|mjs|cjs)$/;

export function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)\/|\.test\.|\.spec\./.test(path);
}

const EXPORT_CLAUSE_START_RE = /^export\s*\{/;

export interface AddedExportNamesResult {
  measurable: Array<{ name: string; line: number }>;
  unmeasured: Array<{ name: string; line: number; reason: UnmeasuredExportReason }>;
}

/**
 * diff 의 추가 줄에서 export 이름을 뽑는다. `export {\n a,\n b as c\n} from '…'` 처럼
 * 여러 줄에 걸친 export 절은 한 줄씩 보면 절대 인식되지 않으므로, `export {` 로 시작해
 * 아직 `}` 를 만나지 않은 추가 줄은 라인 누적기에 쌓았다가 절이 닫히는 순간
 * 합쳐서 파싱하고 이름들은 절이 시작한 줄 번호로 보고한다.
 * 측정 불가 형태(default·별칭 없는 star)도 줄·심볼과 함께 모은다(경고 없는 조용한 CLEAN 방지).
 */
export function scanAddedExports(diffText: string, file: string): AddedExportNamesResult {
  const measurable: Array<{ name: string; line: number }> = [];
  const unmeasured: Array<{ name: string; line: number; reason: UnmeasuredExportReason }> = [];
  let newLine = 0;
  let inHunk = false;
  let clauseLines: string[] | null = null;
  let clauseStartLine = 0;
  const collect = (text: string, line: number): void => {
    if (isTestPath(file)) return;
    const names = exportNamesInLine(text);
    for (const name of names.measurable) {
      measurable.push({ name, line });
    }
    if (names.recognizedUnmeasurable && names.unmeasuredName) {
      unmeasured.push({
        name: names.unmeasuredName,
        line,
        reason: names.unmeasuredName === '*' ? 'anonymous-star-reexport' : 'default-export',
      });
    }
  };
  for (const raw of diffText.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]) - 1;
      inHunk = true;
      clauseLines = null;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      newLine += 1;
      const text = raw.slice(1);
      if (clauseLines) {
        clauseLines.push(text);
        if (text.includes('}')) {
          const joined = clauseLines.join('\n');
          const line = clauseStartLine;
          clauseLines = null;
          collect(joined, line);
        }
        continue;
      }
      const trimmed = text.trim();
      if (EXPORT_CLAUSE_START_RE.test(trimmed) && !trimmed.includes('}')) {
        clauseLines = [trimmed];
        clauseStartLine = newLine;
        continue;
      }
      collect(text, newLine);
      continue;
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) continue;
    if (raw.startsWith('\\')) continue;
    newLine += 1;
  }
  return { measurable, unmeasured };
}

export function addedExportNames(diffText: string, file: string): Array<{ name: string; line: number }> {
  return scanAddedExports(diffText, file).measurable;
}

/**
 * 다중 라인 export 절(`export {` 로 시작해 닫는 `}` 가 이후 줄에 있는 경우)의
 * 끝 줄을 찾는다. 절 안의 이름들은 절 자체의 이후 줄에 다시 등장하므로, 그 범위를
 * «자기 사용» 으로 건너뛰지 않으면 다중 라인 절은 항상 사용된 것으로 오판된다.
 */
export function exportClauseEndLine(lines: string[], declLine: number): number {
  const first = lines[declLine - 1];
  const trimmedFirst = first?.trim() ?? '';
  // 첫 줄에 이름이 있어도(`export { foo,`) 절이 닫히는 줄까지 전체가 그 export 의 선언 범위다.
  // 절 내부의 이름 토큰이 호출처로 오인되지 않도록 닫는 줄까지 사용-제외 처리한다.
  // 한 줄 절(`export { a } from '…'`)은 닫는 괄호가 같은 줄에 있으니 그 줄로 끝난다.
  if (!/^export\s*\{/.test(trimmedFirst) || trimmedFirst.includes('}')) return declLine;
  for (let i = declLine; i < lines.length; i += 1) {
    if (lines[i]!.includes('}')) return i + 1;
  }
  return declLine;
}

/** 이름 토큰이 선언 줄(및 다중 라인 export 절 전체) 밖에, 시험이 아닌 파일에 있으면 운영 호출처다. */
export function hasOperationalUse(
  name: string,
  declFile: string,
  declLine: number,
  files: ReadonlyMap<string, string>,
  declEndLine = declLine,
): boolean {
  const token = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`);
  for (const [path, text] of files) {
    if (isTestPath(path)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (path === declFile && i + 1 >= declLine && i + 1 <= declEndLine) continue;
      if (token.test(lines[i]!)) return true;
    }
  }
  return false;
}

export function deadExportsInDiff(
  diffByFile: ReadonlyMap<string, string>,
  headFiles: ReadonlyMap<string, string>,
): DeadExportWarning[] {
  const warnings: DeadExportWarning[] = [];
  for (const [file, diffText] of diffByFile) {
    if (!SOURCE_RE.test(file) || isTestPath(file)) continue;
    const headText = headFiles.get(file);
    for (const item of addedExportNames(diffText, file)) {
      const endLine = headText ? exportClauseEndLine(headText.split('\n'), item.line) : item.line;
      if (!hasOperationalUse(item.name, file, item.line, headFiles, endLine)) {
        warnings.push({ file, line: item.line, name: item.name });
      }
    }
  }
  warnings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
  return warnings;
}

/** 측정 불가 export(default·별칭 없는 star)를 리포트용으로 모은다. 경고는 아니지만 명시한다. */
export function unmeasuredExportsInDiff(diffByFile: ReadonlyMap<string, string>): DeadExportUnmeasured[] {
  const found: DeadExportUnmeasured[] = [];
  for (const [file, diffText] of diffByFile) {
    if (!SOURCE_RE.test(file) || isTestPath(file)) continue;
    for (const item of scanAddedExports(diffText, file).unmeasured) {
      found.push({ file, line: item.line, name: item.name, reason: item.reason });
    }
  }
  found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
  return found;
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
}

/**
 * HEAD 커밋의 «전체» 비시험 소스 파일을 읽는다. 호출처는 변경 파일에만 있는 게 아니므로
 * 탐색 대상은 diff 파일이 아니라 HEAD 트리 전체여야 한다(오탐 방지).
 * `git ls-tree` 로 경로를 얻고 내용은 `git cat-file --batch` 1회 spawn 으로 받는다.
 * 실패하면 undefined → 상위는 UNMEASURED.
 */
function readHeadSourceFiles(head: string, cwd: string): Map<string, string> | undefined {
  // -z(널 구분자)로 경로를 받는다. 기본 출력은 core.quotePath 가 비ASCII 경로를
  // "/src/\355\230\234…" 처럼 C 인용으로 감싸는데, 그대로면 SOURCE_RE 가 실패해
  // 호출처 파일이 통째로 누락된다. -z 출력은 인용 없이 원래 경로가 온다.
  const tree = git(['ls-tree', '-r', '-z', '--name-only', head], cwd);
  if (!tree.ok) return undefined;
  const paths = tree.stdout
    .split('\0')
    .filter(Boolean)
    .filter((path) => SOURCE_RE.test(path) && !isTestPath(path));
  if (paths.length === 0) return new Map();
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd,
    input: `${paths.map((path) => `${head}:${path}`).join('\n')}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (batch.status !== 0 || !batch.stdout) return undefined;
  // cat-file --batch 프로토콜: 각 객체마다 "<oid> blob <size>\n<내용>\n". size 는 바이트 단위라
  // Buffer 위에 바이트 오프셋으로 파싱한다(문자열 인덱스는 멀티바이트 내용에서 어긋난다).
  const out = Buffer.from(batch.stdout);
  const files = new Map<string, string>();
  let offset = 0;
  for (const path of paths) {
    const headerEnd = out.indexOf(10, offset);
    if (headerEnd < 0) return undefined;
    const header = out.subarray(offset, headerEnd).toString('utf8');
    // OID 길이는 객체 형식에 따라 다르다: sha1 40자리, sha256 64자리. 둘 다 받는다.
    const blob = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
    if (!blob) return undefined;
    const size = Number(blob[2]);
    const start = headerEnd + 1;
    if (start + size > out.length) return undefined;
    files.set(path, out.subarray(start, start + size).toString('utf8'));
    offset = start + size + 1;
  }
  return files;
}

export function reportForRange(base: string, head: string, cwd = process.cwd()): DeadExportReport {
  // ⭐ 출처 키(#38412 r5): 모든 반환 경로에 base·head 를 심는다 — 읽는 쪽의 낡은 리포트 대조 키.
  const keyed = (report: DeadExportReport): DeadExportReport => ({ ...report, base, head });
  // -z 로 받는다(ls-tree 와 같은 이유: core.quotePath 가 비ASCII 경로를 인용해 SOURCE_RE 를 깨뜨린다).
  const names = git(['diff', '--name-only', '-z', '--diff-filter=AM', base, head], cwd);
  if (!names.ok) return keyed({ status: 'UNMEASURED', warnings: [], unmeasured: [], reason: 'git diff --name-only failed' });
  const diffByFile = new Map<string, string>();
  for (const file of names.stdout.split('\0').filter(Boolean)) {
    if (!SOURCE_RE.test(file) || isTestPath(file)) continue;
    const diff = git(['diff', '--unified=0', base, head, '--', file], cwd);
    if (!diff.ok) return keyed({ status: 'UNMEASURED', warnings: [], unmeasured: [], reason: `git failed for ${file}` });
    diffByFile.set(file, diff.stdout);
  }
  const headFiles = readHeadSourceFiles(head, cwd);
  if (!headFiles) return keyed({ status: 'UNMEASURED', warnings: [], unmeasured: [], reason: 'git failed for HEAD source tree' });
  const warnings = deadExportsInDiff(diffByFile, headFiles);
  const unmeasured = unmeasuredExportsInDiff(diffByFile);
  // 무명 star 재수출(`export * from '…'`)은 측정 불가 — 경고는 없어도 조용한 CLEAN 을 막는다.
  const anonymousStar = unmeasured.some((item) => item.reason === 'anonymous-star-reexport');
  return keyed({
    status: warnings.length > 0 ? 'WARN' : anonymousStar ? 'UNMEASURED' : 'CLEAN',
    warnings,
    unmeasured,
  });
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const base = arg('--base');
  const head = arg('--head');
  const pr = arg('--pr');
  if (!base || !head) {
    process.stdout.write(`${JSON.stringify({ status: 'UNMEASURED', warnings: [], unmeasured: [], reason: 'base and head required' })}\n`);
    process.exit(0);
  }
  const report = reportForRange(base, head);
  if (pr) report.pr = pr;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(0);
}
