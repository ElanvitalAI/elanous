#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { getUserConfig } from '../../src/user-config.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../../src/instance/resolve.js';
import { getElanousConfigDirOverride } from '../../src/elanous-config-dir.js';
import { baselineCommit } from './gate-node.js';
import { diffFailures, junitFailures } from './gate-diff.js';
import { finishNode, readGraphContext, runCommand, type CommandResult, type CommandRunner, type GraphContext } from './node-verdict.js';

const sha = /^[a-f0-9]{7,40}$/i;
const testFile = /\.test\.tsx?$/;
const hostName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export interface MacSmokeDeps {
  context?: GraphContext;
  configHost?: () => unknown;
  baseline?: (version: string) => string;
  changedFiles?: (baseline: string, commit: string) => string[];
  findImporters?: (sources: string[], commit: string) => string[];
  repo?: string;
}

export interface MacSmokeResult extends Record<string, unknown> {
  outcome: 'ok' | 'fail' | 'error';
  verdict: 'pass' | 'fail';
  summary: string;
  files: number;
  newFailures: number;
  preexisting: number;
  smoke: 'pass' | 'fail' | 'unmeasured' | 'skipped';
}

function requireOk(result: CommandResult, stage: string): string {
  if (result.status !== 0) throw new Error(`${stage} 실패`);
  return result.stdout;
}

function names(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function safeFile(file: string): boolean {
  return !file.startsWith('/') && !file.split('/').includes('..') && /^[\w./@+-]+$/.test(file);
}

function changedTests(run: CommandRunner, repo: string, base: string, cut: string): string[] {
  return names(requireOk(run('git', ['diff', '--name-only', '-z', `${base}..${cut}`], repo), '변경 파일 조회'));
}

function importers(run: CommandRunner, repo: string, sources: string[], commit: string): string[] {
  const picked = new Set<string>();
  for (const source of sources) {
    const stem = source.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, '');
    const directoryIndex = basename(stem) === 'index' ? posix.dirname(stem) : undefined;
    const search = run('git', ['grep', '-l', '-z', '-F', '-e', basename(stem), '-e', source, '-e', stem, ...(directoryIndex ? ['-e', directoryIndex] : []), commit, '--', '*.test.ts', '*.test.tsx'], repo);
    // git grep returns 1 for no matches; other errors mean the selection could not be measured.
    if (search.status !== 0 && search.status !== 1) throw new Error('시험 import 검색 실패');
    for (const entry of names(search.stdout)) {
      if (!entry.startsWith(`${commit}:`)) throw new Error('시험 import 경로 측정 불가');
      const file = entry.slice(commit.length + 1);
      if (!safeFile(file) || !testFile.test(file)) throw new Error('시험 import 경로 측정 불가');
      const contents = requireOk(run('git', ['show', `${commit}:${file}`], repo), '컷 시험 읽기');
      if (contents.includes(source)) { picked.add(file); continue; }
      for (const match of contents.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\()\s*['"]([^'"]+)['"]/g)) {
        const spec = match[1]!;
        const target = spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), spec)) : spec.replace(/^@\//, '');
        const targetStem = target.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, '');
        if (target === source || targetStem === stem || (directoryIndex && targetStem === directoryIndex)) { picked.add(file); break; }
      }
    }
  }
  return [...picked];
}

// Collection proof comes from bun's junit file (one top-level <testsuite file=…> per collected file):
// non-TTY bun prints no per-file headers when everything passes, so stdout cannot prove which files ran (10-03 real run).
export function testFailures(result: CommandResult, junit: string | null, selected: string[]): string[] {
  const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const summary = /Ran \d+ tests? across (\d+) files?/.exec(output);
  if (junit === null || result.status === null || !summary || Number(summary[1]) !== selected.length) throw new Error('시험 결과 측정 불가');
  const observed = new Set<string>();
  let depth = 0;
  for (const match of junit.matchAll(/<(\/?)testsuite\b([^>]*?)(\/?)>/g)) {
    const [, closing, attrs, selfClosing] = match;
    if (closing) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) {
      const file = /\bfile="([^"]*)"/.exec(attrs!)?.[1] ?? /\bname="([^"]*)"/.exec(attrs!)?.[1];
      if (file) observed.add(file.replace(/^\.\//, ''));
    }
    if (!selfClosing) depth += 1;
  }
  const failures = junitFailures(junit);
  if (observed.size !== selected.length || selected.some((file) => !observed.has(file))
    || (result.status !== 0 && failures.length === 0)) {
    throw new Error('시험 결과 측정 불가');
  }
  return failures;
}

export function runMacSmoke(run: CommandRunner = runCommand, deps: MacSmokeDeps = {}): MacSmokeResult {
  const start = Date.now();
  let version = '';
  let host = '';
  let files = 0;
  let newFailures = 0;
  let preexisting = 0;
  let smoke: MacSmokeResult['smoke'] = 'unmeasured';
  let result: MacSmokeResult;
  let work: string | undefined;
  let cutCreated = false;
  let baseCreated = false;
  let remote = '';
  let remoteAttempt = false;
  const repo = resolve(deps.repo ?? process.cwd());
  const command = (cmd: string, args: string[], cwd: string, timeoutMs?: number): CommandResult => host === 'local'
    ? run(cmd, args, cwd, timeoutMs)
    : run('ssh', [host, `PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; export PATH; cd ${quote(cwd)} && ${[cmd, ...args].map(quote).join(' ')}`], undefined, timeoutMs);
  try {
    const context = deps.context ?? readGraphContext();
    version = context.input.version;
    const configured = context.input.macSmokeHost ?? (deps.configHost ?? (() => (getUserConfig().raw.release as { macSmoke?: { host?: unknown } } | undefined)?.macSmoke?.host))();
    if (configured === undefined || configured === null || configured === '') {
      smoke = 'skipped';
      result = { outcome: 'ok', verdict: 'pass', summary: 'macOS 대상 없음 — 건너뜀', files, newFailures, preexisting, smoke };
    } else {
      if (typeof configured !== 'string' || !hostName.test(configured)) throw new Error('macSmokeHost 호스트 이름이 유효하지 않음');
      host = configured;
      const commit = context.input.commit ?? context.outputs['version-release']?.commit;
      if (typeof commit !== 'string' || !sha.test(commit)) throw new Error('컷 커밋 없음 또는 유효하지 않음 — 측정 불가');
      const platform = host === 'local' ? run('uname', ['-s'], repo) : run('ssh', [host, 'uname -s'], repo);
      if (requireOk(platform, '호스트 플랫폼 확인').trim() !== 'Darwin') throw new Error('macOS 호스트 아님 — 측정 불가');
      const instance = effectiveInstanceRoot();
      const root = getElanousConfigDirOverride() ? instance : releaseLedgerRoot();
      const base = (deps.baseline ?? ((v) => baselineCommit(existsSync(join(root, 'release', v, 'release.json')) ? root : instance, v)))(context.input.previousVersion);
      if (!sha.test(base)) throw new Error('지난 판 커밋 측정 불가');
      const changed = (deps.changedFiles ?? ((b, c) => changedTests(run, repo, b, c)))(base, commit);
      if (!changed.every(safeFile)) throw new Error('변경 파일 경로 측정 불가');
      const sources = changed.filter((file) => /\.(?:tsx?|jsx?|mjs|cjs)$/.test(file) && !testFile.test(file));
      const candidates = [...new Set([...changed.filter((file) => testFile.test(file)), ...(deps.findImporters ?? ((paths, revision) => importers(run, repo, paths, revision)))(sources, commit)])].sort();
      if (!candidates.every(safeFile)) throw new Error('시험 파일 경로 측정 불가');
      const cutFiles = new Set(requireOk(run('git', ['ls-tree', '-r', '--name-only', '-z', commit], repo), '컷 파일 조회').split('\0'));
      const selected = candidates.filter((file) => cutFiles.has(file));
      const clipped = Math.max(0, selected.length - 200);
      const tests = selected.slice(0, 200);
      files = tests.length;
      const baseFiles = new Set(requireOk(run('git', ['ls-tree', '-r', '--name-only', '-z', base], repo), '기준 파일 조회').split('\0'));
      work = mkdtempSync(join(tmpdir(), 'release-mac-smoke-'));
      let source = repo;
      if (host !== 'local') {
        remoteAttempt = true;
        remote = requireOk(run('ssh', [host, 'mktemp -d /tmp/release-mac-smoke-XXXXXXXX'], repo), '호스트 연결').trim();
        if (!/^\/tmp\/release-mac-smoke-[\w-]+$/.test(remote)) throw new Error('원격 임시 경로 측정 불가');
        requireOk(command('git', ['init', '--bare', `${remote}/mirror.git`], remote), '원격 저장소 생성');
        for (const revision of new Set([commit, base])) {
          requireOk(run('git', ['push', `${host}:${remote}/mirror.git`, `${revision}:refs/heads/mac-smoke-${revision}`], repo), '원격 커밋 전송');
        }
        requireOk(command('git', ['clone', '-q', '--no-checkout', `${remote}/mirror.git`, `${remote}/repo`], remote), '원격 복제');
        source = `${remote}/repo`;
      }
      const cutTree = host === 'local' ? join(work, 'cut') : `${remote}/cut`;
      requireOk(command('git', ['-C', source, 'worktree', 'add', '--detach', cutTree, commit], source), '체크아웃');
      cutCreated = true;
      requireOk(command('bun', ['install'], cutTree), '설치');
      const execute = (tree: string, paths: string[]): string[] => {
        const failures: string[] = [];
        for (let i = 0; i < paths.length; i += 50) {
          const batch = paths.slice(i, i + 50);
          const report = `.mac-smoke-junit-${i}.xml`;
          // `./` makes each path exact — bare paths are substring filters and also run same-named copies (10-03 nested worktrees).
          const tested = command('bun', ['test', '--reporter=junit', `--reporter-outfile=${report}`, ...batch.map((file) => `./${file}`)], tree, 1_200_000);
          const xml = command('cat', [report], tree);
          failures.push(...testFailures(tested, xml.status === 0 ? xml.stdout : null, batch));
        }
        return failures;
      };
      const cutFailures = execute(cutTree, tests);
      const versionSmoke = command('bun', ['bin/elanous.mjs', '--test', '--version'], cutTree);
      const scheduleSmoke = command('bun', ['bin/elanous.mjs', '--test', 'release', 'schedule', 'list', '--json'], cutTree);
      smoke = versionSmoke.status === 0 && scheduleSmoke.status === 0 ? 'pass' : 'fail';
      let baselineFailures: string[] = [];
      if (cutFailures.length) {
        const baseTree = host === 'local' ? join(work, 'base') : `${remote}/base`;
        requireOk(command('git', ['-C', source, 'worktree', 'add', '--detach', baseTree, base], source), '기준 체크아웃');
        baseCreated = true;
        requireOk(command('bun', ['install'], baseTree), '기준 설치');
        baselineFailures = execute(baseTree, tests.filter((file) => baseFiles.has(file)));
      }
      const delta = diffFailures(cutFailures, baselineFailures);
      newFailures = delta.newFailures.length;
      preexisting = delta.common.length;
      const outcome = newFailures || smoke !== 'pass' ? 'fail' : 'ok';
      result = { outcome, verdict: outcome === 'ok' ? 'pass' : 'fail', files, newFailures, preexisting, smoke,
        summary: `macOS ${outcome} · 새 실패 ${newFailures} · 기존 실패 ${preexisting} · 스모크 ${smoke}${clipped ? ` · 잘림 ${clipped}` : ''}${newFailures ? ` · ${delta.newFailures.slice(0, 5).map((id) => id.split(' > ')[0]).join(', ')}` : ''}` };
    }
  } catch {
    result = { outcome: 'error', verdict: 'fail', summary: 'macOS 측정 불가 (연결·체크아웃·설치·시험 결과 확인 필요)', files, newFailures, preexisting, smoke };
  } finally {
    if (remoteAttempt && remote) {
      try {
        const cleanup = run('ssh', [host, `rm -rf -- ${quote(remote)}`]);
        if (cleanup.status !== 0) result = { outcome: 'error', verdict: 'fail', summary: 'macOS 측정 불가 (임시 작업 정리 실패)', files, newFailures, preexisting, smoke };
      } catch { result = { outcome: 'error', verdict: 'fail', summary: 'macOS 측정 불가 (임시 작업 정리 실패)', files, newFailures, preexisting, smoke }; }
    }
    if (work) {
      if (host === 'local') {
        for (const tree of [cutCreated && 'cut', baseCreated && 'base'].filter((name): name is string => Boolean(name))) {
          try {
            const removed = run('git', ['worktree', 'remove', '--force', join(work, tree)], repo);
            if (removed.status !== 0) result = { outcome: 'error', verdict: 'fail', summary: 'macOS 측정 불가 (임시 작업 정리 실패)', files, newFailures, preexisting, smoke };
          } catch { result = { outcome: 'error', verdict: 'fail', summary: 'macOS 측정 불가 (임시 작업 정리 실패)', files, newFailures, preexisting, smoke }; }
        }
      }
      try { rmSync(work, { recursive: true, force: true }); }
      catch { result = { outcome: 'error', verdict: 'fail', summary: 'macOS 측정 불가 (임시 작업 정리 실패)', files, newFailures, preexisting, smoke }; }
    }
    debug.log('release-loop.mac-smoke', 'judged', { version, host, files, newFailures, smoke, outcome: result!.outcome, ms: Date.now() - start });
  }
  return result!;
}

if (import.meta.main) {
  let version = '';
  try { version = readGraphContext().input.version; process.exitCode = finishNode('mac-smoke', version, runMacSmoke()); }
  catch { process.exitCode = finishNode('mac-smoke', version, { outcome: 'error', verdict: 'fail', summary: 'macOS 측정 불가' }); }
}
