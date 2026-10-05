#!/usr/bin/env bun
/** Machine-measured suggestions only; MK judges and merges the exposure ledger. */
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { debug } from '../src/debug/log.js';
import { BRAND_RULES_UNMEASURED, checkBrand } from './brand/check.js';
import { checkCommands, extractElanousCommands, type HelpRunner } from './docs-cli-check.js';
import { scanLeaks } from './public-export.js';

const DOCS = 'release/public/docs';
const LEDGER = 'release/public/expose-rubric.yaml';
const KEYS = ['reproducible', 'confidential', 'brand'] as const;
type Criterion = { status: 'pass' | 'fail' | 'n/a'; reason: string };
type Suggestion = { path: string; criteria: Record<(typeof KEYS)[number], Criterion> };

function unmeasured(error: unknown): Criterion {
  const detail = error instanceof Error ? error.message : String(error);
  return { status: 'n/a', reason: `측정 불가: ${detail.split(/\r?\n/)[0] || '알 수 없는 오류'}` };
}

function measure(run: () => Criterion): Criterion {
  try { return run(); } catch (error) { return unmeasured(error); }
}

/** Files are repository-relative paths (or absolute paths within root); the ledger is never read or written. */
export function suggestExposeRubric(root: string, files?: readonly string[], help?: HelpRunner, rulesPath?: string): Suggestion[] {
  const names = files ?? readdirSync(join(root, DOCS)).filter((name) => name.endsWith('.md')).map((name) => `${DOCS}/${name}`);
  const paths = [...new Set(names.map((name) => relative(root, resolve(root, name)).split(sep).join('/')))];
  if (paths.some((path) => !/^release\/public\/docs\/[^/]+\.md$/.test(path))) throw new Error('문서 경로는 release/public/docs/*.md 이어야 합니다');
  type HelpResult = ReturnType<HelpRunner> & { failure?: string };
  let helpRuns = 0;
  const rootHelp: (args: string[]) => HelpResult = help ?? ((args) => {
    helpRuns++;
    const result = spawnSync('bun', ['bin/elanous.mjs', '--test', ...args, '--help'], {
      cwd: resolve(import.meta.dir, '..'), encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' },
    });
    const error = result.error as NodeJS.ErrnoException | undefined;
    return {
      ok: result.status === 0 && !error,
      out: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      failure: error?.code === 'ETIMEDOUT' ? 'timeout'
        : error ? error.message
        : result.status !== 0 ? `exit ${result.status ?? 'unknown'}` : undefined,
    };
  });
  const helpCache = new Map<string, { ok: true; out: string } | { ok: false; reason: string }>();
  let helpFailures = 0;
  const checkedHelp: HelpRunner = (args) => {
    const key = args.join(' ');
    let cached = helpCache.get(key);
    if (!cached) {
      const runOnce = (): { ok: true; out: string } | { ok: false; reason: string } => {
        try {
          const result = rootHelp(args);
          if (result.ok && result.out.trim()) return { ok: true, out: result.out };
          helpFailures++;
          return { ok: false, reason: result.failure ?? (result.out.trim() ? '실행 실패' : '빈 출력') };
        } catch (error) {
          helpFailures++;
          return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
      };
      cached = runOnce();
      if (!cached.ok) cached = runOnce();
      helpCache.set(key, cached);
    }
    if (!cached.ok) throw new Error(`elanous ${key ? `${key} ` : ''}--help 실패(${cached.reason.split(/\r?\n/)[0] || '알 수 없는 오류'})`);
    return cached;
  };
  const results = paths.sort().map((path): Suggestion => {
    const absolute = join(root, path);
    let text: string;
    try { text = readFileSync(absolute, 'utf8'); }
    catch (error) {
      const failed = unmeasured(error);
      return { path, criteria: { reproducible: failed, confidential: failed, brand: failed } };
    }
    const brand = measure(() => {
      const result = checkBrand('public-docs', [absolute], rulesPath);
      if (result.missing) return { status: 'n/a', reason: result.message ?? BRAND_RULES_UNMEASURED };
      if (result.files !== 1 || result.rules === 0) return unmeasured('브랜드 규칙 없음 또는 파일 검사 실패');
      const ids = [...new Set(result.findings.map((finding) => finding.id))].slice(0, 3);
      return ids.length
        ? { status: 'fail', reason: `브랜드 규칙: ${ids.join(', ')}` }
        : { status: 'pass', reason: '브랜드 규칙 위반 없음' };
    });
    const reproducible = measure(() => {
      const refs = extractElanousCommands(path, text);
      if (!refs.length) return { status: 'n/a', reason: '문서에 elanous 명령 없음' };
      const findings = checkCommands(refs, checkedHelp);
      const unable = findings.find((finding) => finding.kind === 'unmeasured');
      if (unable) return unmeasured(unable.detail);
      const missing = [...new Set(findings.map((finding) => finding.detail))].slice(0, 3);
      return missing.length
        ? { status: 'fail', reason: `없는 명령: ${missing.join(', ')}` }
        : { status: 'pass', reason: `명령 ${refs.length}개 모두 --help 에 있음` };
    });
    const confidential = measure(() => {
      const hits = scanLeaks(root, [path], undefined, new Map([[path, text]]));
      const markers = [...new Set(hits.map((hit) => hit.marker))].slice(0, 3);
      return markers.length
        ? { status: 'fail', reason: `누출 표식: ${markers.join(', ')}` }
        : { status: 'pass', reason: '누출 표식 없음' };
    });
    // 브랜드 규칙이 없으면 브랜드만 «측정 불가» — 따로 잰 재현성·누출 결과는 덮어쓰지 않는다.
    return { path, criteria: { reproducible, confidential, brand } };
  });
  const statuses = results.flatMap((item) => KEYS.map((key) => item.criteria[key].status));
  debug.log('expose.rubric', 'suggested', {
    docs: results.length, pass: statuses.filter((status) => status === 'pass').length,
    fail: statuses.filter((status) => status === 'fail').length,
    unmeasured: statuses.filter((status) => status === 'n/a').length,
    helpRuns, helpFailures,
  });
  return results;
}

export function run(argv: readonly string[], root = process.cwd(), help?: HelpRunner): number {
  const json = argv.includes('--json');
  let files: string[] | undefined;
  let out: string | undefined;
  let rulesPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') continue;
    if (arg === '--yaml-patch') {
      out = argv[++i];
      if (!out || out.startsWith('--')) throw new Error('--yaml-patch 에 출력 경로가 필요합니다');
    } else if (arg === '--rules') {
      rulesPath = argv[++i];
      if (!rulesPath || rulesPath.startsWith('--')) throw new Error('--rules 에 규칙 경로가 필요합니다');
    } else if (arg === '--files') {
      files = [];
      while (argv[i + 1] && !argv[i + 1]!.startsWith('--')) files.push(argv[++i]!);
      if (!files.length) throw new Error('--files 에 문서 경로가 필요합니다');
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  const results = suggestExposeRubric(root, files, help, rulesPath);
  if (out) {
    const target = resolve(root, out);
    const ledger = resolve(root, LEDGER);
    if (target === ledger || realpathOrSelf(target) === realpathOrSelf(ledger) || sameFile(target, ledger)) throw new Error('원장 파일은 덮어쓸 수 없습니다');
    writeFileSync(target, stringify({ entries: results }));
  }
  if (json) console.log(JSON.stringify(results));
  else {
    for (const { path, criteria } of results) console.log(`${path} · ${KEYS.map((key) => `${key} ${criteria[key].status}${criteria[key].status === 'fail' ? `(${criteria[key].reason.split(': ').slice(1).join(': ') || criteria[key].reason})` : criteria[key].reason === BRAND_RULES_UNMEASURED ? `(${criteria[key].reason})` : ''}`).join(' · ')}`);
    const statuses = results.flatMap((item) => KEYS.map((key) => item.criteria[key].status));
    console.log(`합계 문서 ${results.length} · pass ${statuses.filter((status) => status === 'pass').length} · fail ${statuses.filter((status) => status === 'fail').length} · n/a ${statuses.filter((status) => status === 'n/a').length} · maturity/value/evidence/support 사람 판정 (MK)`);
  }
  return 0;
}

function realpathOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function sameFile(target: string, ledger: string): boolean {
  const a = statSync(target, { throwIfNoEntry: false });
  const b = statSync(ledger, { throwIfNoEntry: false });
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}

if (import.meta.main) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
