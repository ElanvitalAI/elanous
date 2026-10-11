import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  appendBenchLedger, BENCH_LABEL, benchArmBranchForBase, benchArmName, benchIdFromBase, benchLedgerPath, ensureBenchBase,
  nextBenchRound, parseBenchArmBranch, parseBenchSpec, readBenchLedger, type BenchGitRun, type BenchLedgerRow,
} from './bench.js';
import { registerBenchCommands } from '../cli/bench-cli.js';
import { installHarnessCliCommand } from '../harness/harness-cli-command.js';
import { planDevPipeline, toSelfImplementOptions } from '../self-dev/dev-pipeline.js';
import type { SelfImplementSeams } from '../self-implement/orchestrator.js';
import { defaultSeams } from '../self-implement/seams.js';
import { debug } from '../debug/log.js';
import type { PrManager } from '../autopilot/pr-manager.js';
import { codeRevision } from '../version/code-revision.js';
import { podOrchestrateArgs } from '../harness/harness-pod-dispatch.js';
import { ELANOUS_ENTRY_SCRIPT } from '../self-implement/seams.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** 원격을 흉내 내는 git 실행기 — 시험은 실제 원격에 push 하지 않는다. */
function fakeGit(remote: Map<string, string>, originMain = SHA) {
  const calls: string[][] = [];
  const run: BenchGitRun = (args) => {
    calls.push([...args]);
    if (args[0] === 'ls-remote') {
      const ref = args.at(-1)!;
      const sha = remote.get(ref);
      return sha ? { status: 0, stdout: `${sha}\t${ref}\n`, stderr: '' } : { status: 2, stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-parse') {
      const rev = args.at(-1)!.replace(/\^\{commit\}$/, '');
      return { status: 0, stdout: `${rev === 'origin/main' ? originMain : rev.padEnd(40, '0')}\n`, stderr: '' };
    }
    if (args[0] === 'push') {
      const [sha, ref] = args.at(-1)!.split(':');
      remote.set(ref!, sha!);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('BENCH-ISOLATED-ARMS ① --bench 기준선 고정', () => {
  test('spec 파싱 — id[:sha] · 잘못된 꼴은 거부', () => {
    expect(parseBenchSpec('night-1011')).toEqual({ id: 'night-1011' });
    expect(parseBenchSpec(`x:${SHA.toUpperCase()}`)).toEqual({ id: 'x', sha: SHA });
    for (const bad of ['', 'a/b', 'base', 'x:', 'x:zzz', '-x']) expect(() => parseBenchSpec(bad)).toThrow();
  });

  test('없는 가지는 만들고(push 1회) · 있는 가지는 sha 일치 확인(push 0) · 불일치는 거부', () => {
    const remote = new Map<string, string>();
    const first = fakeGit(remote);
    expect(ensureBenchBase({ id: 'x', sha: SHA }, first.run)).toEqual({ id: 'x', branch: 'bench/x/base', sha: SHA, created: true });
    expect(first.calls.filter((c) => c[0] === 'push')).toEqual([['push', 'origin', `${SHA}:refs/heads/bench/x/base`]]);

    const again = fakeGit(remote);
    expect(ensureBenchBase({ id: 'x', sha: SHA.slice(0, 12) }, again.run)).toMatchObject({ sha: SHA, created: false });
    expect(again.calls.some((c) => c[0] === 'push')).toBe(false);

    const mismatch = fakeGit(remote);
    expect(() => ensureBenchBase({ id: 'x', sha: OTHER }, mismatch.run)).toThrow(/다르다/);
    expect(mismatch.calls.some((c) => c[0] === 'push')).toBe(false);
  });

  test('sha 생략 — 없으면 발사 시점 origin/main · 있으면 그 가지 sha 를 따른다', () => {
    const remote = new Map<string, string>();
    expect(ensureBenchBase({ id: 'y' }, fakeGit(remote, OTHER).run)).toMatchObject({ sha: OTHER, created: true });
    expect(ensureBenchBase({ id: 'y' }, fakeGit(remote, SHA).run)).toMatchObject({ sha: OTHER, created: false });
  });

  test('ls-remote 실패(rc≠0,2)는 「없다」로 읽지 않는다 — push 0', () => {
    const calls: string[][] = [];
    const run: BenchGitRun = (args) => { calls.push([...args]); return { status: 128, stdout: '', stderr: 'fatal: network' }; };
    expect(() => ensureBenchBase({ id: 'z', sha: SHA }, run)).toThrow(/못 읽었다/);
    expect(calls.some((c) => c[0] === 'push')).toBe(false);
  });
});

describe('BENCH-ISOLATED-ARMS ② 팔 가지 · base · 라벨', () => {
  test('base 이름이 벤치 표지다 — 아니면 undefined(동작 불변)', () => {
    expect(benchIdFromBase('bench/x/base')).toBe('x');
    expect(benchIdFromBase('origin/bench/x/base')).toBe('x');
    for (const other of ['main', 'origin/main', 'bench/base-night-abc', 'bench/x/glm', undefined]) expect(benchIdFromBase(other)).toBeNull();
    expect(parseBenchArmBranch('bench/x/glm-5.3-abc123')).toEqual({ id: 'x', arm: 'glm-5.3-abc123' });
    expect(parseBenchArmBranch('bench/x/base')).toBeNull();
    expect(benchArmName('openrouter/z-ai/glm-5.3-flash', 'run-1a2b3c4d')).toBe('glm-5.3-flash-1a2b3c');
    expect(benchArmName(undefined, undefined)).toBe('default');
    expect(benchArmBranchForBase('main', 'x', 'run-1')).toBeUndefined();
  });

  test('dev pipeline 어댑터 — 벤치 base 면 branchName=bench/<id>/<arm> · 아니면 branchName 없음', () => {
    const IN = { text: '기능' } as const;
    const SELF = { kind: 'self' } as const;
    const childLlm = { provider: 'openrouter', model: 'openrouter/anthropic/claude-sonnet-5.5', source: 'flag' as const };
    const prev = process.env.ELANOUS_RUN_ID;
    process.env.ELANOUS_RUN_ID = 'run-feedbe-0000';
    try {
      const bench = toSelfImplementOptions('기능', planDevPipeline({ input: IN, executor: SELF, completion: 'pr', base: 'bench/x/base', self: { childLlm } } as never), {} as SelfImplementSeams);
      expect(bench.base).toBe('bench/x/base');
      expect(bench.branchName).toBe('bench/x/claude-sonnet-5.5-feedbe');
      const plain = toSelfImplementOptions('기능', planDevPipeline({ input: IN, executor: SELF, completion: 'pr', base: 'main', self: { childLlm } } as never), {} as SelfImplementSeams);
      expect(plain.branchName).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = prev;
    }
  });

  function repoWithOrigin(branches: readonly string[]): string {
    const root = tmp('bench-seam-');
    const origin = join(root, 'origin.git');
    const wt = join(root, 'wt');
    const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', wt]);
    g(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    g(wt, 'remote', 'add', 'origin', origin);
    g(wt, 'push', '-q', 'origin', 'main');
    for (const b of branches) g(wt, 'push', '-q', 'origin', `HEAD:refs/heads/${b}`);
    g(wt, 'fetch', '-q', 'origin');
    return wt;
  }

  test('openPr — PR base=bench/<id>/base 이면 라벨 elanous:bench 를 더한다 · main base 는 라벨 불변', async () => {
    const wt = repoWithOrigin(['bench/x/base']);
    const seen: Array<{ base?: string; labels?: readonly string[] }> = [];
    const prManager = { upsertPr: (input: { base?: string; labels?: readonly string[] }) => { seen.push({ base: input.base, labels: input.labels }); return { ok: true, url: 'https://github.com/o/r/pull/7' }; } } as unknown as PrManager;
    const seams = defaultSeams({ prManager });
    await seams.openPr!({ title: 't', body: 'b', head: 'bench/x/glm', base: 'bench/x/base', cwd: wt, labels: ['elanous:harness'] } as never);
    await seams.openPr!({ title: 't', body: 'b', head: 'self-impl/y', base: 'main', cwd: wt, labels: ['elanous:harness'] } as never);
    expect(seen[0]).toEqual({ base: 'bench/x/base', labels: ['elanous:harness', BENCH_LABEL] });
    expect(seen[1]).toEqual({ base: 'main', labels: ['elanous:harness'] });
  });

  test('③ mergeMain — 벤치 팔 가지면 main 동기화 0회 ⊕ 관측 bench/main-sync-skipped', async () => {
    const wt = repoWithOrigin([]);
    execFileSync('git', ['checkout', '-q', '-b', 'bench/x/glm-abc123'], { cwd: wt });
    const log = spyOn(debug, 'log');
    try {
      const result = await defaultSeams().mergeMain!(wt, 'origin/main');
      expect(result.status).toBe('up-to-date');
      const skipped = log.mock.calls.filter(([category, event]) => category === 'bench' && event === 'main-sync-skipped');
      expect(skipped.length).toBe(1);
      expect(skipped[0]![2]).toMatchObject({ benchId: 'x', mergeTarget: 'origin/main', source: 'branch' });
      expect(log.mock.calls.some(([category]) => category === 'self-dev.merge')).toBe(false);
    } finally { log.mockRestore(); }
  });

  test('⑤ mergeMain — 벤치가 아니면 관측 없이 기존 정합 경로', async () => {
    const wt = repoWithOrigin([]);
    const log = spyOn(debug, 'log');
    try {
      await defaultSeams().mergeMain!(wt, 'origin/main');
      expect(log.mock.calls.some(([category]) => category === 'bench')).toBe(false);
    } finally { log.mockRestore(); }
  });
});

describe('BENCH-ISOLATED-ARMS ④ 원장 · bench ls', () => {
  const row = (over: Partial<BenchLedgerRow> = {}): BenchLedgerRow => ({
    ts: '2026-10-11T00:00:00.000Z', event: 'launched', benchId: 'x', baseBranch: 'bench/x/base', baseSha: SHA,
    imageCommit: 'c'.repeat(12), parentCodeCommit: null, childLlmProvider: 'openrouter', childLlmModel: 'm', round: 1, ...over,
  });

  test('라운드 = 같은 모델의 launched 줄 수 + 1', () => {
    expect(nextBenchRound([row(), row({ event: 'finished' }), row({ childLlmModel: 'other' })], 'm')).toBe(2);
    expect(nextBenchRound([], null)).toBe(1);
  });

  test('bench ls <id> 가 원장 줄을 읽는다 (--json · 사람 표기)', async () => {
    const dir = tmp('bench-ledger-');
    appendBenchLedger(row(), dir);
    appendBenchLedger(row({ event: 'finished', exitCode: 0 }), dir);
    const lines: string[] = [];
    const program = new Command().exitOverride();
    registerBenchCommands(program, { configDir: () => dir, write: (l) => lines.push(l) });
    await program.parseAsync(['node', 'elanous', 'bench', 'ls', 'x', '--json']);
    expect(JSON.parse(lines[0]!)).toEqual(readBenchLedger('x', dir));
    await program.parseAsync(['node', 'elanous', 'bench', 'ls', 'x']);
    expect(lines[1]).toContain('bench x: 2줄');
    expect(lines[1]).toContain(`base=${SHA.slice(0, 12)} parent=unknown image=cccccccccccc child=openrouter/m`);
    expect(lines[1]).toContain('rc=0');
  });
});

describe('BENCH-ISOLATED-ARMS harness ask --bench (CLI 배선)', () => {
  function install(ask: (file: string, opts: { base?: string }) => Promise<void>, bench: { git: BenchGitRun; configDir: string }) {
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask, say: async () => {},
      bench: { ...bench, imageCommit: () => 'd'.repeat(12) } });
    return program;
  }

  test('④ --bench x:<sha> → ask 가 base=bench/x/base 를 받고 원장에 다섯 칸(launched ⊕ finished)', async () => {
    const dir = tmp('bench-cli-');
    const goal = join(dir, 'goal.md');
    writeFileSync(goal, '대상 경로: src/x.ts\n');
    const remote = new Map<string, string>();
    const git = fakeGit(remote);
    const bases: Array<string | undefined> = [];
    const program = install(async (_f, opts) => { bases.push(opts.base); }, { git: git.run, configDir: dir });
    const oldExit = process.exitCode;
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--bench', `x:${SHA}`, '--substrate', 'local', '--no-queue',
        '--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/z-ai/glm-5.3']);
      expect(bases).toEqual(['bench/x/base']);
      expect(remote.get('refs/heads/bench/x/base')).toBe(SHA);
      const rows = readBenchLedger('x', dir);
      expect(rows.map((r) => r.event)).toEqual(['launched', 'finished']);
      expect(rows[0]).toMatchObject({ benchId: 'x', baseSha: SHA, parentCodeCommit: codeRevision() ?? null, imageCommit: 'd'.repeat(12), childLlmModel: 'openrouter/z-ai/glm-5.3', round: 1, substrate: 'local' });
    } finally { process.exitCode = oldExit ?? 0; }
  });

  test('불일치 sha 는 발사 0 · --bench 와 --base 동시는 rc 2', async () => {
    const dir = tmp('bench-cli-');
    const goal = join(dir, 'goal.md');
    writeFileSync(goal, '대상 경로: src/x.ts\n');
    const remote = new Map([['refs/heads/bench/x/base', OTHER]]);
    let calls = 0;
    const program = install(async () => { calls += 1; }, { git: fakeGit(remote).run, configDir: dir });
    const oldExit = process.exitCode;
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--bench', `x:${SHA}`, '--substrate', 'local', '--no-queue']);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--bench', 'x', '--base', 'main', '--substrate', 'local', '--no-queue']);
      expect(process.exitCode).toBe(2);
      expect(calls).toBe(0);
      expect(existsSync(benchLedgerPath('x', dir))).toBe(false);
    } finally { err.mockRestore(); process.exitCode = oldExit ?? 0; }
  });

  test('옛 base sha 여도 부모 발사 코드는 «지금» 코드 — cwd 불변 · base 는 PR base/작업 가지 출발점에만 · 원장 parentCodeCommit ≠ baseSha', async () => {
    const dir = tmp('bench-cli-');
    const goal = join(dir, 'goal.md');
    writeFileSync(goal, '대상 경로: src/x.ts\n');
    const oldSha = '0123456789ab'.padEnd(40, '0');
    const remote = new Map<string, string>();
    const seen: Array<{ cwd: string; base?: string }> = [];
    const program = new Command().exitOverride();
    // codeCommit 은 주입하지 않는다 — 기본(codeRevision · 코드 자신의 위치)을 문다.
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', say: async () => {},
      ask: async (_f, opts) => { seen.push({ cwd: process.cwd(), base: opts.base }); },
      bench: { git: fakeGit(remote).run, configDir: dir, imageCommit: () => null } });
    const before = process.cwd();
    await program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--bench', `x:${oldSha}`, '--substrate', 'local', '--no-queue']);
    expect(seen).toEqual([{ cwd: before, base: 'bench/x/base' }]);
    expect(remote.get('refs/heads/bench/x/base')).toBe(oldSha);
    const [launched] = readBenchLedger('x', dir);
    expect(launched!.baseSha).toBe(oldSha);
    expect(launched!.parentCodeCommit ?? null).toBe(codeRevision() ?? null);
    expect(launched!.parentCodeCommit).not.toBe(oldSha);
    // Pod 경로도 같다 — 발사 스크립트는 지금 코드의 진입점이고, 벤치는 `--base bench/x/base` 한 쌍으로만 실린다(sha·트리 경로 없음).
    const args = podOrchestrateArgs({ entrance: 'cli-harness-ask', input: goal, base: 'bench/x/base' }, goal);
    expect(args[0]).toBe(ELANOUS_ENTRY_SCRIPT);
    expect(args.slice(args.indexOf('--base'), args.indexOf('--base') + 2)).toEqual(['--base', 'bench/x/base']);
    expect(args.some((a) => a.includes(oldSha.slice(0, 12)))).toBe(false);
  });

  test('⑤ --bench 없으면 base 그대로 · git 0회 · 원장 없음', async () => {
    const dir = tmp('bench-cli-');
    const goal = join(dir, 'goal.md');
    writeFileSync(goal, '대상 경로: src/x.ts\n');
    const git = fakeGit(new Map());
    const bases: Array<string | undefined> = [];
    const program = install(async (_f, opts) => { bases.push(opts.base); }, { git: git.run, configDir: dir });
    await program.parseAsync(['node', 'elanous', 'harness', 'ask', goal, '--base', 'main', '--substrate', 'local', '--no-queue']);
    expect(bases).toEqual(['main']);
    expect(git.calls).toEqual([]);
    expect(existsSync(join(dir, 'bench'))).toBe(false);
  });
});
