#!/usr/bin/env bun
/**
 * 공개 내보내기 E1 — `release/public-export.yaml` 로 private 원본에서 공개 트리를 만든다 ⊕ 유출 검사.
 * 설계: 내부 문서 `RFC-private-source-public-export-2026-09-24` §ⓓ
 *
 *   bun scripts/public-export.ts --list                 # 내보낼 파일 목록(수)
 *   bun scripts/public-export.ts --leak-check [--json] [--all] [--path <prefix>]
 *                                                       # 내보낼 파일의 사적 흔적 — 있으면 rc=1
 *     ⛔ 목록은 기본 상한(텍스트 20 · JSON 200)에서 잘린다 — 잘리면 «잘렸다»를 말한다(`truncated` · 남은 수).
 *        자기 파일을 찾으려면 `--path <prefix>` 로 좁히거나 `--all` 로 전부 본다. «목록에 없다» ≠ «없다».
 *     표지 = LEAK_MARKERS(줄 단위 흔적 · 문서 링크는 private 에 «실재»하는 이름만) — rc 는 이것만 센다.
 *     참고 = `runtime-path-outside-export`(공개 코드가 공개본에 없는 경로를 쥔다) — rc 에 안 센다 · 판정은 public-export-test-run 의 exportOnly=0.
 *   bun scripts/public-export.ts --out <dir>            # 트리 복사 ⊕ replace 적용 ⊕ 유출 검사(있으면 rc=1 · 복사는 한다)
 *
 * ⛔ 목록 밖은 «전부» private 에 남는다 — 이 스크립트가 무엇을 «더» 넣는 일은 없다.
 * ⛔ 원천은 `git ls-files`(추적 파일)다 — 작업 트리의 untracked·ignored 는 원리상 안 간다.
 */
import { computeSkillBoundaries, filterFilesBySkillVerdict, type SkillVerdict } from './skill-boundary.js';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { userInfo } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import ts from 'typescript';
import { parse } from 'yaml';
import { spawnSyncText } from '../src/util/spawn-sync-output.js';

export interface ExportTransform {
  readonly id: string;
  readonly pattern: string;
  readonly replacement: string;
  readonly files: readonly string[];
  readonly where: 'comment' | 'markdown' | 'any';
}

export interface ExportConfig {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly replace: Readonly<Record<string, string>>;
  readonly transforms?: readonly ExportTransform[];
  /** `skills/<name>/` 를 스킬 경계 판정(scripts/skill-boundary.ts)으로 거른다 — 손으로 적은 목록 대신 «파생». */
  readonly skills?: SkillVerdict;
}

export interface LeakHit { readonly marker: string; readonly file: string; readonly line: number; readonly text: string }

/**
 * `absolute-home-path` — «내보내는 사람»의 홈 경로만 문다(`/Users/<나>/` · `/home/<나>/`).
 * 🩸 2026-09-24: 종전 패턴(`/(Users|home)/<아무 이름>/`)은 539건 중 244건이 시험 픽스처(`~/` · `~/` …)였다 —
 *    가짜 경로는 유출이 아니다. 계정 이름은 `ELANOUS_LEAK_HOME_USER` 로 바꿀 수 있고, 모르면 종전처럼 넓게 문다(«모른다»를 «깨끗하다»로 안 읽는다).
 */
export function homeUserPattern(user: string | undefined = process.env.ELANOUS_LEAK_HOME_USER ?? currentUserName()): RegExp {
  const name = (user ?? '').trim();
  if (!name) return /\/(?:Users|home)\/[A-Za-z0-9._-]+\//u;
  return new RegExp(`/(?:Users|home)/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'u');
}

function currentUserName(): string | undefined {
  try { return userInfo().username; } catch { return undefined; }
}

/** 사적 흔적 표지 — RFC §C 의 다섯. ⛔ 새 표지는 여기에만 더한다. */
export const LEAK_MARKERS: ReadonlyArray<{ readonly marker: string; readonly pattern: RegExp }> = [
  { marker: 'absolute-home-path', pattern: homeUserPattern() },
  { marker: 'pilot-tree', pattern: /source\/pilot\b/u },
  { marker: 'ceo-mark', pattern: /\u{1F451}/u },   // 왕관 기호 — 이스케이프로 적어 이 줄이 스스로 걸리지 않게
  // ⛔ D2(`#20105`) 뒤 옛 계획 문서는 `docs/archive/<YYYY-MM>/PLAN-…` 에 있다 — 중간 경로를 허용해야 «안 보여서 0»이 안 된다.
  { marker: 'plan-doc-link', pattern: /docs\/(?:[^\s'"`)]*\/)?PLAN-/u },
  { marker: 'handoff-doc-link', pattern: /HANDOFF-/u },
  // ⭐ 2026-09-25(대표 확인 «공개해도 될 만큼 클린징 됐나») — 검사기 «밖»에서 실제 유출이 나왔다:
  //   제3자 실명·휴대폰 번호(행사 템플릿) · 소유자 실명(Xcode 파일 머리). 형태로 무는 표식 둘을 더한다.
  //   ⛔ 이름·IP·호스트 같은 «값»은 여기 적지 않는다(적으면 이 파일이 유출이다) — 저장소 밖 개인 치환표가 맡는다(loadPrivateRedactions).
  { marker: 'kr-mobile-phone', pattern: /\b01[016789]-(?!0000-)\d{3,4}-\d{4}\b/u },   // 010-0000-xxxx 는 자리표
  { marker: 'xcode-author-header', pattern: /^\s*\/\/\s+Created by \S/u },
];

/** 개인 치환표 — 저장소 «밖»(기본 `~/.elanous/export-redactions.tsv` · env `ELANOUS_EXPORT_REDACTIONS`).
 *  한 줄 = `실제값<TAB>자리표`(# 주석 · 빈 줄 무시). 내보낼 때 모든 텍스트 파일에서 치환하고, 치환 «뒤»에 실제값이 남으면 유출로 센다.
 *  ⛔ 표가 없으면 «깨끗하다»가 아니라 «못 봤다» — `null` 을 돌려주고 run() 이 rc=1 로 막는다(`--no-private-list` 로만 넘어간다). */
export interface PrivateRedaction { readonly from: string; readonly to: string }
export function privateRedactionsPath(): string {
  return process.env.ELANOUS_EXPORT_REDACTIONS?.trim() || join(homedir(), '.elanous', 'export-redactions.tsv');
}
export function loadPrivateRedactions(path = privateRedactionsPath()): PrivateRedaction[] | null {
  if (!existsSync(path)) return null;
  const out: PrivateRedaction[] = [];
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [from, to] = raw.split('\t');
    if (from?.trim() && to !== undefined) out.push({ from: from.trim(), to: to.trim() });
  }
  // 긴 것부터 — `mbp.tail….ts.net` 이 `tail….ts.net` 보다 먼저 바뀌어야 한다.
  return out.sort((a, b) => b.from.length - a.from.length);
}
function escapeRegExp(v: string): string { return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** 값 경계 — 영숫자 값은 앞뒤가 영숫자가 아닐 때만(예: `node-b` 이 `msb10` 을 물지 않게). */
function redactionPattern(from: string): RegExp {
  const pre = /^[A-Za-z0-9]/.test(from) ? '(?<![A-Za-z0-9])' : '';
  const post = /[A-Za-z0-9]$/.test(from) ? '(?![A-Za-z0-9])' : '';
  return new RegExp(`${pre}${escapeRegExp(from)}${post}`, 'gu');
}
export function applyPrivateRedactions(contents: ReadonlyMap<string, string>, redactions: readonly PrivateRedaction[]): { contents: Map<string, string>; files: number; places: number } {
  const result = new Map(contents);
  let files = 0; let places = 0;
  for (const [file, text] of result) {
    if (text.includes('\u0000')) continue;
    let out = text; let changed = 0;
    for (const r of redactions) out = out.replace(redactionPattern(r.from), () => { changed++; return r.to; });
    if (changed) { result.set(file, out); files++; places += changed; }
  }
  return { contents: result, files, places };
}
export function privateIdentifierMarkers(redactions: readonly PrivateRedaction[]): Array<{ marker: string; pattern: RegExp }> {
  return redactions.map((r) => ({ marker: 'private-identifier', pattern: new RegExp(redactionPattern(r.from).source, 'u') }));
}

export const DEFAULT_EXPORT_CONFIG = 'release/public-export.yaml';

/** 매니페스트 하나 = 내보내기 대상 하나(공개 코어 · 앱 · …). `transformsFrom` 은 다른 매니페스트의
 *  변환 규칙을 «그대로» 쓴다 — 규칙을 두 벌 적으면 한쪽만 늙는다. */
export function loadExportConfig(root: string, file = DEFAULT_EXPORT_CONFIG): ExportConfig {
  const raw = parse(readFileSync(join(root, file), 'utf8')) as (Partial<ExportConfig> & { transformsFrom?: string }) | null;
  const inherited = raw?.transformsFrom ? loadExportConfig(root, raw.transformsFrom).transforms ?? [] : [];
  return {
    include: raw?.include ?? [],
    exclude: raw?.exclude ?? [],
    replace: raw?.replace ?? {},
    transforms: [...inherited, ...(raw?.transforms ?? [])],
    ...(raw?.skills === 'core' || raw?.skills === 'addon' ? { skills: raw.skills } : {}),
  };
}

function matches(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}

/** 추적 파일 중 include 에 걸리고 exclude 에 안 걸리는 것. replace 의 «대상» 경로는 원본판을 빼고 공개판으로 바꾼다. */
export function selectExportFiles(tracked: readonly string[], config: ExportConfig): string[] {
  const replaced = new Set(Object.keys(config.replace));
  return tracked.filter((path) => matches(path, config.include) && !matches(path, config.exclude) && !replaced.has(path));
}

function commentRanges(file: string, text: string): Array<[number, number]> {
  if (/\.md$/i.test(file)) return [[0, text.length]];
  if (/\.(?:ts|tsx|js|mjs|cjs|kt|kts|swift|java)$/i.test(file)) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
    const ranges: Array<[number, number]> = [];
    const templates: number[] = [];
    let braces = 0;
    let previous: ts.SyntaxKind | undefined;
    const regexStartsAfter = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.EqualsToken, ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.OpenBracketToken,
      ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.ColonToken,
      ts.SyntaxKind.ReturnKeyword, ts.SyntaxKind.ThrowKeyword, ts.SyntaxKind.CaseKeyword,
      ts.SyntaxKind.EqualsGreaterThanToken, ts.SyntaxKind.QuestionToken, ts.SyntaxKind.ExclamationToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
    ]);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if ((token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) &&
          (previous === undefined || regexStartsAfter.has(previous))) token = scanner.reScanSlashToken();
      if (token === ts.SyntaxKind.CloseBraceToken && templates.at(-1) === braces) {
        token = scanner.reScanTemplateToken(false);
        templates.pop();
      }
      if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
        ranges.push([scanner.getTokenPos(), scanner.getTextPos()]);
      } else if (token === ts.SyntaxKind.TemplateHead || token === ts.SyntaxKind.TemplateMiddle) {
        templates.push(braces);
      } else if (token === ts.SyntaxKind.OpenBraceToken) {
        braces++;
      } else if (token === ts.SyntaxKind.CloseBraceToken) {
        braces--;
      }
      if (token !== ts.SyntaxKind.WhitespaceTrivia && token !== ts.SyntaxKind.NewLineTrivia &&
          token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) previous = token;
    }
    return ranges;
  }
  if (/\.(?:sh|py|yaml|yml)$/i.test(file)) {
    const ranges: Array<[number, number]> = [];
    let start = 0;
    for (const line of text.split('\n')) {
      let quote: '"' | "'" | undefined;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '\\' && quote === '"') { i++; continue; }
        if (char === quote) quote = undefined;
        else if (!quote && (char === '"' || char === "'")) quote = char;
        else if (!quote && char === '#') { ranges.push([start + i, start + line.length]); break; }
      }
      start += line.length + 1;
    }
    return ranges;
  }
  return [];
}

export interface TransformCount { readonly id: string; readonly files: number; readonly places: number }

/** Apply configured rules only to exported text; file selection and replacement destinations are unchanged. */
export function transformExportFiles(contents: ReadonlyMap<string, string>, config: ExportConfig, exportedFiles: readonly string[]): { contents: Map<string, string>; counts: TransformCount[] } {
  const result = new Map(contents);
  const exported = new Set([...exportedFiles, ...Object.keys(config.replace)]);
  const counts: TransformCount[] = [];
  for (const rule of config.transforms ?? []) {
    const pattern = new RegExp(rule.pattern, 'gu');
    let files = 0;
    let places = 0;
    for (const [file, text] of result) {
      if (!matches(file, rule.files) || text.includes('\u0000')) continue;
      const ranges = rule.where === 'any' ? [[0, text.length]] : rule.where === 'markdown' ? (/\.md$/i.test(file) ? [[0, text.length]] : []) : commentRanges(file, text);
      let changed = 0;
      let output = text;
      for (const [from, to] of ranges.reverse()) {
        const segment = text.slice(from, to);
        const replaced = segment.replace(pattern, (match, ...args: unknown[]) => {
          const last = args.at(-1);
          const groups = typeof last === 'object' && last !== null ? last as Record<string, string> : undefined;
          if (groups?.path && exported.has(groups.path)) return match;
          const replacement = groups
            ? rule.replacement.replace(/\$<([^>]+)>/gu, (token, key: string) => groups[key] ?? token)
            : rule.replacement;
          if (match === replacement) return match;
          changed++;
          return replacement;
        });
        output = output.slice(0, from) + replaced + output.slice(to);
      }
      if (changed) { result.set(file, output); files++; places += changed; }
    }
    counts.push({ id: rule.id, files, places });
  }
  return { contents: result, counts };
}

/**
 * 문서 링크 두 표지가 «실재» 이름만 세게 하는 이름 집합 — private 원본에 추적되는데 공개본엔 «없는» `HANDOFF-*`·`PLAN-*` 문서.
 * 🩸 2026-09-25(대표 결정 · 권고대로): 남은 문서 링크 ~70 은 거의 전부 문서 큐레이션·링크 린트 시험의 «지어낸» 이름
 *    (`내부 문서` · `PLAN-live.md`)이었다 — 아무것도 드러내지 않는데 자가 세서 rc=0 에 영영 못 닿았다.
 *    ⇒ 이 집합을 주면 줄 속 `HANDOFF-…`·`PLAN-…` 토큰이 여기 있는 이름(확장자 유무 둘 다)일 때만 센다. 공개되는 문서로의 링크는 유출이 아니다.
 */
export function privateDocNames(tracked: readonly string[], exported: readonly string[]): Set<string> {
  const out = new Set(exported);
  const names = new Set<string>();
  for (const file of tracked) {
    const base = posix.basename(file);
    if (out.has(file) || !/^(?:HANDOFF|PLAN)-/u.test(base)) continue;
    names.add(base);
    names.add(base.replace(/\.md$/u, ''));
  }
  return names;
}

const DOC_NAME_TOKEN = /(?:HANDOFF|PLAN)-[A-Za-z0-9._-]+/gu;

function namesRealDoc(line: string, realDocNames: ReadonlySet<string>): boolean {
  for (const m of line.matchAll(DOC_NAME_TOKEN)) {
    const token = m[0].replace(/[.]+$/u, '');
    if (realDocNames.has(token) || realDocNames.has(`${token}.md`)) return true;
  }
  return false;
}

export function scanLeaks(root: string, files: readonly string[], markers = LEAK_MARKERS, contents?: ReadonlyMap<string, string>, realDocNames?: ReadonlySet<string>): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const file of files) {
    let text: string;
    try { text = contents?.get(file) ?? readFileSync(join(root, file), 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue; // 바이너리
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      for (const { marker, pattern } of markers) {
        const checked = contents && (marker === 'plan-doc-link' || marker === 'handoff-doc-link')
          ? line.replace(/내부 문서 `[^`]+`/gu, '') : line;
        if (!pattern.test(checked)) continue;
        if (realDocNames && (marker === 'plan-doc-link' || marker === 'handoff-doc-link') && !namesRealDoc(checked, realDocNames)) continue;
        hits.push({ marker, file, line: index + 1, text: line.trim().slice(0, 160) });
      }
    });
  }
  return hits;
}

/**
 * 🆕 `runtime-path-outside-export` — 공개되는 «코드»가 공개본에 «없는» 저장소 경로를 문자열로 쥐고 있다.
 * 계기: `docs/graph-templates/**` 가 허용 목록에서 빠져 공개본 영상 라인이 실행 중에 죽을 뻔했다(🅣 · `#20098`).
 * 후보 = 따옴표 안의 `a/b[/c…]` ⊕ `join(…)` 의 리터럴 조각(`'..'`·`'.'` 은 버림). 주석 줄은 안 본다.
 * 판정 = 후보가 추적 파일인데 내보내지 않거나, 추적 디렉토리인데 그 아래 내보내는 파일이 «하나도» 없다.
 * ⛔ 정적 판정이라 «읽는가»가 아니라 «쥐고 있는가»를 잰다 — 안내 문구 속 경로도 걸린다.
 * ⭐ 2026-09-25(대표 결정 · 권고대로): 이 표지는 «참고»다 — `leaks`·rc 에 안 센다(`advisory` 로 따로 낸다).
 *    «실제로 깨지나»의 판정은 `bun scripts/public-export-test-run.ts --json` 의 `exportOnly=0` 이 맡는다
 *    (공개본에서만 깨지던 63건이 0 이 된 뒤에도 이 자는 109 를 셌다 — 쥐고만 있고 안 깨지는 경로다).
 */
export const RUNTIME_PATH_JUDGE = 'bun scripts/public-export-test-run.ts --json → exportOnly=0';
const RUNTIME_CODE = /\.(ts|tsx|js|mjs|cjs|sh|py)$/;
const PATH_LITERAL = /['"`]((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\/?)['"`]/g;
const JOIN_CALL = /join\(([^)]*)\)/g;
/** 저장소 뿌리를 가리키는 첫 인자 — 이것에 붙인 경로만 «저장소 경로»다. */
const REPO_ROOTED_ARG = /import\.meta|__dirname|__filename|process\.cwd\(\)|\b(?:REPO_ROOT|REPOSITORY_ROOT|PROJECT_ROOT|ROOT|HERE|repoRoot|repositoryRoot)\b/;
const TEST_FILE = /\.test\.(ts|tsx|js|mjs)$/;

export function scanRuntimePaths(root: string, files: readonly string[], tracked: readonly string[], contents?: ReadonlyMap<string, string>): LeakHit[] {
  const exported = new Set(files);
  const trackedSet = new Set(tracked);
  const dirHasExport = new Map<string, boolean>();
  for (const path of tracked) {
    for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir)) {
      dirHasExport.set(dir, (dirHasExport.get(dir) ?? false) || exported.has(path));
    }
  }
  const hits: LeakHit[] = [];
  for (const file of files) {
    if (!RUNTIME_CODE.test(file)) continue;
    let text: string;
    try { text = contents?.get(file) ?? readFileSync(join(root, file), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, index) => {
      const head = line.trim();
      if (head.startsWith('//') || head.startsWith('*') || head.startsWith('/*') || head.startsWith('#')) return;
      const candidates: string[] = [];
      // 🩸 2026-09-24(🅣 보고): 281곳 중 240곳이 시험 — `join(root, 'docs', 'goals')` 처럼 «임시 폴더»에 붙인 경로를
      //    저장소 경로로 셌다(공개본 의존이 아니다). ⇒ 시험 파일에서는 첫 인자가 저장소 뿌리가 아닌 join 과 그 안의 리터럴을 뺀다.
      //    운영 코드는 종전 그대로(엄격) — 알려진 양성 `join(HERE, '..', 'docs', 'graph-templates')` 는 계속 문다.
      const skipped: Array<[number, number]> = [];
      for (const m of line.matchAll(JOIN_CALL)) {
        const args = m[1]!;
        const first = args.split(',')[0]!.trim();
        if (TEST_FILE.test(file) && !/^['"`]/.test(first) && !REPO_ROOTED_ARG.test(first)) {
          skipped.push([m.index!, m.index! + m[0].length]);
          continue;
        }
        const segments = [...args.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!).filter((seg) => seg !== '..' && seg !== '.');
        if (segments.length >= 2) candidates.push(segments.join('/'));
      }
      for (const m of line.matchAll(PATH_LITERAL)) {
        if (skipped.some(([from, to]) => m.index! >= from && m.index! < to)) continue;
        candidates.push(m[1]!);
      }
      for (const raw of new Set(candidates)) {
        const path = raw.replace(/^\.\//, '').replace(/\/$/, '');
        const outside = trackedSet.has(path) ? !exported.has(path) : dirHasExport.get(path) === false;
        if (outside) hits.push({ marker: 'runtime-path-outside-export', file, line: index + 1, text: `${path} ← ${head.slice(0, 120)}` });
      }
    });
  }
  return hits;
}

/**
 * 내보낸 파일 중 공개본의 `.gitignore` 에 걸리는 것 — 공개 repo 에 «커밋하는 순간 조용히 빠진다».
 * 📏 2026-09-25: `log/`(앵커 없음)가 `widgets/log/widget.ts` 를 먹어, 공개본에서 `src/ux-sim` 이 불러오기부터 죽었다.
 *   원본에선 그 파일이 예전에 강제 추적돼 있어 안 보였다. ⇒ `--no-index` 로 «추적 여부와 무관하게» 규칙만 대 본다.
 */
export function gitIgnoredExportFiles(root: string, files: readonly string[]): string[] {
  if (files.length === 0) return [];
  const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root, input: files.join('\n'), encoding: 'utf8', maxBuffer: 64 << 20 });
  // rc 0 = 하나 이상 걸림 · 1 = 없음 · 그 밖 = 판정 실패(«없음»으로 읽지 않는다)
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore 실패 rc=${r.status}: ${(r.stderr ?? '').slice(0, 200)}`);
  return (r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

export function summarizeLeaks(hits: readonly LeakHit[]): Record<string, { hits: number; files: number }> {
  const out: Record<string, { hits: number; files: Set<string> }> = {};
  for (const hit of hits) {
    const bucket = out[hit.marker] ??= { hits: 0, files: new Set() };
    bucket.hits += 1;
    bucket.files.add(hit.file);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { hits: v.hits, files: v.files.size }]));
}

function trackedFiles(root: string): string[] {
  return spawnSyncText('git', ['-C', root, 'ls-files', '-z']).split('\0').filter(Boolean);
}

export function run(argv: readonly string[], root = resolve(import.meta.dir, '..')): number {
  const json = argv.includes('--json');
  const all = argv.includes('--all');
  const pathIndex = argv.indexOf('--path');
  const pathPrefix = pathIndex >= 0 ? argv[pathIndex + 1] : undefined;
  if (pathIndex >= 0 && !pathPrefix) { console.error('⛔ --path needs a prefix'); return 2; }
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && !out) { console.error('⛔ --out needs a directory'); return 2; }
  const configIndex = argv.indexOf('--config');
  const configFile = configIndex >= 0 ? argv[configIndex + 1] : DEFAULT_EXPORT_CONFIG;
  if (configIndex >= 0 && !configFile) { console.error('⛔ --config needs a manifest path'); return 2; }
  if (!existsSync(join(root, configFile!))) { console.error(`⛔ export manifest missing: ${configFile}`); return 2; }
  const config = loadExportConfig(root, configFile);
  const tracked = trackedFiles(root);
  let files = selectExportFiles(tracked, config);
  if (config.skills) {
    // ⛔ 판정하지 못한 스킬이 있으면 «코어로 흘리지 않고» 멈춘다.
    const boundary = computeSkillBoundaries(root);
    if (boundary.errors.length) {
      for (const e of boundary.errors) console.error(`⛔ skill boundary: ${e}`);
      return 2;
    }
    files = filterFilesBySkillVerdict(files, boundary, config.skills);
  }
  if (argv.includes('--list')) {
    if (json) console.log(JSON.stringify({ count: files.length, files }));
    else { for (const f of files) console.log(f); console.error(`${files.length} files`); }
    return 0;
  }
  if (out && existsSync(join(resolve(out), '.git'))) { console.error(`⛔ refusing to write into a git checkout: ${resolve(out)}`); return 2; }
  if (out || argv.includes('--leak-check')) {
    const contents = new Map<string, string>();
    for (const file of files) contents.set(file, readFileSync(join(root, file), 'utf8'));
    for (const [dest, src] of Object.entries(config.replace)) {
      if (!existsSync(join(root, src))) { console.error(`⛔ replace source missing: ${src}`); return 2; }
      contents.set(dest, readFileSync(join(root, src), 'utf8'));
    }
    const scanned = pathPrefix ? files.filter((f) => f.startsWith(pathPrefix)) : files;
    const realDocs = privateDocNames(tracked, files);
    const before = [...scanLeaks(root, scanned, LEAK_MARKERS, undefined, realDocs), ...scanRuntimePaths(root, files, tracked).filter((h) => !pathPrefix || h.file.startsWith(pathPrefix))];
    const transformedByRules = transformExportFiles(contents, config, files);
    // ⭐ 개인 치환표(저장소 밖) — 규칙 변환 «뒤»에 건다. 없으면 «못 봤다»로 막는다.
    const redactions = loadPrivateRedactions();
    const noPrivateList = argv.includes('--no-private-list');
    const redacted = redactions ? applyPrivateRedactions(transformedByRules.contents, redactions) : { contents: transformedByRules.contents, files: 0, places: 0 };
    const transformed = { contents: redacted.contents, counts: transformedByRules.counts };
    const privateRedactions = { table: privateRedactionsPath(), loaded: redactions !== null, entries: redactions?.length ?? 0, files: redacted.files, places: redacted.places };
    if (redactions) console.error(`private redactions: ${redacted.files} files · ${redacted.places} places (${redactions.length} entries · ${privateRedactionsPath()})`);
    if (!redactions) console.error(`${noPrivateList ? '⚠' : '⛔'} 개인 치환표 없음(${privateRedactionsPath()}) — 이름·IP·호스트 같은 개인 식별자를 «못 봤다»${noPrivateList ? ' (--no-private-list)' : ' · rc=1 · 넘기려면 --no-private-list'}`);
    for (const count of transformed.counts) {
      console.error(`transform ${count.id}: ${count.files} files · ${count.places} places`);
      if (count.places === 0) console.error(`⚠ transform ${count.id} changed nothing`);
    }
    if (out) {
      const target = resolve(out);
      for (const file of files) {
        mkdirSync(dirname(join(target, file)), { recursive: true });
        if (transformed.contents.get(file) === contents.get(file)) copyFileSync(join(root, file), join(target, file));
        else writeFileSync(join(target, file), transformed.contents.get(file)!);
        // ⛔ 변환해 «새로 쓴» 파일은 권한 비트를 잃는다 — 원본 모드를 옮긴다(2026-09-25: 실행 스크립트 8개가 +x 를 잃었다).
        chmodSync(join(target, file), statSync(join(root, file)).mode & 0o777);
      }
      for (const [dest, src] of Object.entries(config.replace)) {
        mkdirSync(dirname(join(target, dest)), { recursive: true });
        if (transformed.contents.get(dest) === contents.get(dest)) copyFileSync(join(root, src), join(target, dest));
        else writeFileSync(join(target, dest), transformed.contents.get(dest)!);
        chmodSync(join(target, dest), statSync(join(root, src)).mode & 0o777);
      }
      console.error(`exported ${files.length} files (+${Object.keys(config.replace).length} replaced) → ${target}`);
    }
    const hits = [
      ...gitIgnoredExportFiles(root, files).filter((f) => !pathPrefix || f.startsWith(pathPrefix)).map((file) => ({ marker: 'export-gitignored', file, line: 0, text: '공개본 .gitignore 에 걸린다 — 커밋하면 사라진다' })),
      ...scanLeaks(root, scanned, LEAK_MARKERS, transformed.contents, realDocs),
      ...(redactions ? scanLeaks(root, scanned, privateIdentifierMarkers(redactions), transformed.contents, realDocs) : []),
      ...(!redactions && !noPrivateList ? [{ marker: 'private-identifiers-unchecked', file: privateRedactionsPath(), line: 0, text: 'private redaction list missing' }] : []),
    ];
    const advisory = scanRuntimePaths(root, files, tracked, transformed.contents).filter((h) => !pathPrefix || h.file.startsWith(pathPrefix));
    const summary = summarizeLeaks(hits);
    const advisorySummary = summarizeLeaks(advisory);
    const beforeSummary = summarizeLeaks(before);
    const limit = all ? hits.length : (json ? 200 : 20);
    const shown = hits.slice(0, limit);
    const truncated = shown.length < hits.length;
    if (json) {
      console.log(JSON.stringify({
        files: scanned.length, leaks: hits.length, summary, before: { leaks: before.length, summary: beforeSummary }, transforms: transformed.counts, privateRedactions,
        shownHits: shown.length, truncated, omittedHits: hits.length - shown.length,
        ...(pathPrefix ? { pathPrefix } : {}), hits: shown,
        advisory: { hits: advisory.length, summary: advisorySummary, judge: RUNTIME_PATH_JUDGE, items: all ? advisory : advisory.slice(0, limit) },
      }));
    } else {
      console.log(`before transform — ${before.length} hits · ${JSON.stringify(beforeSummary)}`);
      console.log(`leak check — ${scanned.length} files${pathPrefix ? ` under ${pathPrefix}` : ''} · ${hits.length} hits`);
      for (const [marker, s] of Object.entries(summary)) console.log(`  ${marker.padEnd(20)} ${String(s.files).padStart(5)} files  ${String(s.hits).padStart(6)} lines`);
      for (const hit of shown) console.log(`  ${hit.marker}  ${hit.file}:${hit.line}  ${hit.text}`);
      if (truncated) console.log(`  … ${hits.length - shown.length} more hits not shown — use --all, or narrow with --path <prefix> (⛔ «not in this list» ≠ «no leak»)`);
      if (advisory.length) console.log(`advisory (not counted) — runtime-path-outside-export ${advisory.length} lines · ${advisorySummary['runtime-path-outside-export']?.files ?? 0} files · judge = ${RUNTIME_PATH_JUDGE}`);
    }
    return hits.length > 0 ? 1 : 0;
  }
  console.error('usage: bun scripts/public-export.ts [--config release/<target>-export.yaml] --list | --leak-check | --out <dir>  [--json]');
  return 2;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
