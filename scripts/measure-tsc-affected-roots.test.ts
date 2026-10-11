import { expect, test } from 'bun:test';
import { formatReport, measureAffectedRoots, parseRss, type CommandResult, type Runner } from './measure-tsc-affected-roots.js';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const error = 'src/a.ts(3,1): error TS2322: Type string is not assignable to number.';
const pr = (number: number, files = [{ path: 'src/a.ts' }]) => ({ number, mergeCommit: { oid: head }, files });
const output = (status = 0, stdout = '', stderr = ''): CommandResult => ({ status, stdout, stderr, durationMs: 120 });

function fake(options: { base?: string; head?: string; gate?: CommandResult; prs?: ReturnType<typeof pr>[]; platform?: NodeJS.Platform } = {}) {
  const calls: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  const commands: Runner = async (command, args, cwd, env) => {
    calls.push({ command, args, cwd, env });
    if (command === 'gh' && args[0] === 'api') return output(0, '1\n');
    if (command === 'gh') return output(0, JSON.stringify(args[1] === 'list' ? options.prs ?? [pr(1)] : pr(Number(args[2]))));
    if (command === 'git') return args[0] === 'rev-parse' ? output(0, `${base}\n`) : output();
    if (command === 'bun' && args[0] === 'install') return output();
    if (command === '/usr/bin/time' || command === './node_modules/.bin/tsc' || command === 'bun') {
      const target = command === '/usr/bin/time' ? args[1] : command;
      if (target === 'bun') return options.gate ?? output(0, '[tsc-gate] PASS — 변경 파일에 신규 타입 에러 없음.');
      return cwd.endsWith('/pr') && calls.some((call) => call.command === 'git' && call.args[0] === 'checkout' && call.args.at(-1) === head)
        ? output(options.head ? 2 : 0, options.head ?? '')
        : output(options.base ? 2 : 0, options.base ?? '');
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const removed: string[] = [];
  const deps = { run: commands, platform: options.platform ?? 'linux' as NodeJS.Platform, makeTemp: () => '/tmp/fake-affected', removeTemp: (path: string) => { removed.push(path); } };
  return { calls, removed, deps };
}

test('new full-program error with passing narrowed gate is missed; matching failure is same', async () => {
  const missed = fake({ head: error, gate: output(0, '[tsc-gate] PASS — 변경 파일에 신규 타입 에러 없음.') });
  const result = await measureAffectedRoots('/repo', ['--prs', '1'], missed.deps);
  expect(result.prs[0]?.verdict).toBe('missed');
  expect(result.prs[0]?.missedDiagnostics).toEqual([{ file: 'src/a.ts', code: 'TS2322', message: 'Type string is not assignable to number.' }]);
  expect(result.exitCode).toBe(1);
  expect(missed.calls.some((call) => call.command === '/usr/bin/time' && call.args.includes('bun') && call.env?.TSC_BASE_REF === base)).toBe(true);
  expect(missed.removed).toEqual(['/tmp/fake-affected']);
  const same = await measureAffectedRoots('/repo', ['--prs', '1'], fake({ head: error, gate: output(1, `[tsc-gate] FAIL — 타입 에러가 있다\n${error}`) }).deps);
  expect(same.prs[0]?.verdict).toBe('same');
  expect(same.prs[0]?.missedDiagnostics).toHaveLength(0);
  expect(same.exitCode).toBe(0);
});

test('failing gate reporting only one of two new diagnostics is missed', async () => {
  const second = 'src/b.ts(4,1): error TS2339: Property missing does not exist.';
  const report = await measureAffectedRoots('/repo', ['--prs', '1'], fake({ head: `${error}\n${second}`, gate: output(1, `[tsc-gate] FAIL — 타입 에러가 있다\n  ${error}`) }).deps);
  expect(report.prs[0]?.verdict).toBe('missed');
  expect(report.prs[0]?.missedDiagnostics).toEqual([{ file: 'src/b.ts', code: 'TS2339', message: 'Property missing does not exist.' }]);
  expect(report.summary).toMatchObject({ missed: 1, same: 0 });
  expect(report.exitCode).toBe(1);
});

test('preexisting identical error and failing gate is stricter, not missed', async () => {
  const result = await measureAffectedRoots('/repo', ['--prs', '1'], fake({ base: error, head: error, gate: output(1, `[tsc-gate] FAIL — 타입 에러가 있다\n${error}`) }).deps);
  expect(result.prs[0]?.verdict).toBe('stricter');
  expect(result.summary).toMatchObject({ missed: 0, stricter: 1 });
  expect(result.exitCode).toBe(0);
});

test('missing type definitions are unmeasured; macOS bytes are converted to MiB in the table', async () => {
  const broken = await measureAffectedRoots('/repo', ['--prs', '1'], fake({ head: "error TS2688: Cannot find type definition file for 'bun-types'." }).deps);
  expect(broken.prs[0]?.verdict).toBe('unmeasured');
  expect(broken.exitCode).toBe(2);
  const mac = fake({ platform: 'darwin' });
  const run = mac.deps.run;
  mac.deps.run = async (command, args, cwd, env) => {
    const result = await run(command, args, cwd, env);
    return command === '/usr/bin/time' ? { ...result, stderr: '        21474836480  maximum resident set size\n' } : result;
  };
  const measured = await measureAffectedRoots('/repo', ['--prs', '1'], mac.deps);
  expect(measured.prs[0]?.fullHead.rssMb).toBe(20480);
  expect(formatReport(measured)).toContain('120 / 20480');
  expect(parseRss('Maximum resident set size (kbytes): 20971520', 'linux')).toBe(20480);
  expect(parseRss('', 'linux')).toBeNull();
});

test('recent selects only TypeScript merged PRs and preserves exit summary and JSON', async () => {
  const prs = [
    { ...pr(1), mergedAt: '2026-10-09T01:00:00Z' },
    { ...pr(3, [{ path: 'README.md' }]), mergedAt: '2026-10-09T03:00:00Z' },
    { ...pr(2, [{ path: 'src/a.tsx' }]), mergedAt: '2026-10-09T02:00:00Z' },
  ];
  const f = fake({ prs });
  const report = await measureAffectedRoots('/repo', ['--recent', '2', '--json'], f.deps);
  expect(report.prs.map((row) => row.pr)).toEqual([2, 1]);
  expect(report.summary).toEqual({ missed: 0, same: 2, stricter: 0, unmeasured: 0, of: 2 });
  expect(formatReport(report).split('\n').at(-1)).toBe('missed=0 same=2 stricter=0 unmeasured=0 of 2');
  expect(JSON.parse(formatReport(report, true)).summary).toEqual(report.summary);
  expect(f.calls.find((call) => call.command === 'gh')?.args).toContain('--base');
  expect(f.calls.filter((call) => call.command === 'git' && call.args[0] === 'worktree' && call.args[1] === 'remove')).toHaveLength(2);
});

test('recent expands the merged window until enough TypeScript PRs are found', async () => {
  const f = fake();
  const run = f.deps.run;
  const seen: number[] = [];
  f.deps.run = async (command, args, cwd, env) => {
    if (command === 'gh' && args[1] === 'list') {
      const limit = Number(args[args.indexOf('--limit') + 1]);
      seen.push(limit);
      const files = Array.from({ length: 100 }, (_, i) => ({ ...pr(900 - i, [{ path: 'README.md' }]), mergedAt: `2026-10-09T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z` }));
      if (limit > 100) files.push({ ...pr(8, [{ path: 'src/a.ts' }]), mergedAt: '2026-10-09T03:00:00Z' });
      return output(0, JSON.stringify(files));
    }
    return run(command, args, cwd, env);
  };
  const report = await measureAffectedRoots('/repo', ['--recent', '1'], f.deps);
  expect(seen).toEqual([100, 200]);
  expect(report.prs.map((row) => row.pr)).toEqual([8]);
});

test('cleanup failure cannot erase a measured miss', async () => {
  const f = fake({ head: error });
  const run = f.deps.run;
  f.deps.run = async (command, args, cwd, env) => command === 'git' && args[0] === 'worktree' && args[1] === 'remove'
    ? output(1, '', 'cannot remove worktree')
    : run(command, args, cwd, env);
  const result = await measureAffectedRoots('/repo', ['--prs', '1'], f.deps);
  expect(result.prs[0]?.verdict).toBe('missed');
  expect(result.prs[0]?.reason).toContain('cleanup failed');
  expect(result.exitCode).toBe(1);
});

test('gate pass without execution evidence remains unmeasured and cannot hide a new error', async () => {
  const report = await measureAffectedRoots('/repo', ['--prs', '1'], fake({ head: error, gate: output() }).deps);
  expect(report.prs[0]?.verdict).toBe('unmeasured');
  expect(report.exitCode).toBe(2);
});

test('conflicting selection options fail before any external command runs', async () => {
  const f = fake();
  await expect(measureAffectedRoots('/repo', ['--prs', '1', '--recent', '2'], f.deps)).rejects.toThrow('invalid --recent count');
  expect(f.calls).toHaveLength(0);
});

test('unreadable timed execution and gate nonzero without diagnostics remain unmeasured; keep skips removal', async () => {
  const broken = fake({ gate: output(1, 'gate failed before tsc') });
  const result = await measureAffectedRoots('/repo', ['--prs', '1', '--keep'], broken.deps);
  expect(result.prs[0]?.verdict).toBe('unmeasured');
  expect(result.exitCode).toBe(2);
  expect(broken.removed).toEqual([]);
  expect(broken.calls.some((call) => call.command === 'git' && call.args[1] === 'remove')).toBe(false);
});

test('rebase-merged multi-commit PR is measured against the base before its first commit', async () => {
  const before = 'c'.repeat(40);
  const middle = 'd'.repeat(40);
  const earlier = 'e'.repeat(40);
  let total = '2';
  let owners: Record<string, string> = { [middle]: '7', [earlier]: '6' };
  // No listed commits are requested at all — the REST total and commit↔PR association decide (review must-fix).
  const rebased = pr(7);
  const inner = fake({ head: error, gate: output(0, '[tsc-gate] PASS — 변경 파일에 신규 타입 에러 없음.') });
  const run: Runner = async (command, args, cwd, env) => {
    if (command === 'gh' && args[0] === 'api' && args[1]?.includes('/commits/')) {
      const sha = args[1].split('/commits/')[1]!.split('/')[0]!;
      return output(0, `${owners[sha] ?? ''}\n`);
    }
    if (command === 'gh' && args[0] === 'api') return output(0, `${total}\n`);
    if (command === 'gh') { inner.calls.push({ command, args, cwd, env }); return output(0, JSON.stringify(rebased)); }
    if (command === 'git' && args[0] === 'rev-list') return output(0, `${head} ${base}\n`);
    if (command === 'git' && args[0] === 'log') throw new Error('subjects must not decide the merge method');
    if (command === 'git' && args[0] === 'rev-parse') {
      const rev = args[1];
      return output(0, `${rev === `${head}~1` ? middle : rev === `${head}~2` ? before : rev === `${head}^1` ? base : base}\n`);
    }
    return inner.deps.run(command, args, cwd, env);
  };
  const report = await measureAffectedRoots('/repo', ['--prs', '7'], { ...inner.deps, run });
  expect(report.prs[0]?.base).toBe(before);
  expect(inner.calls.some((call) => call.command === '/usr/bin/time' && call.env?.TSC_BASE_REF === before)).toBe(true);
  expect(inner.calls.some((call) => call.command === 'git' && call.args[0] === 'checkout' && call.args.at(-1) === before)).toBe(true);
  expect(report.prs[0]?.verdict).toBe('missed');
  // A squash merge: head~1 belongs to another PR (even if its subject matched) → head^1.
  owners = { [middle]: '6' };
  const squashed = await measureAffectedRoots('/repo', ['--prs', '7'], { ...inner.deps, run });
  expect(squashed.prs[0]?.base).toBe(base);
  // Three commits but only head~1 is ours (head~2 is not): the method is ambiguous → unmeasured.
  total = '3';
  owners = { [middle]: '7' };
  const ambiguous = await measureAffectedRoots('/repo', ['--prs', '7'], { ...inner.deps, run });
  expect(ambiguous.prs[0]?.verdict).toBe('unmeasured');
  expect(ambiguous.prs[0]?.reason).toContain('merge method ambiguous');
  expect(ambiguous.exitCode).toBe(2);
  // An unreadable REST commit count never falls back to head^1.
  total = '';
  const unreadable = await measureAffectedRoots('/repo', ['--prs', '7'], { ...inner.deps, run });
  expect(unreadable.prs[0]?.verdict).toBe('unmeasured');
  expect(unreadable.prs[0]?.reason).toContain('commit count unreadable');
});

test('--recent keeps PRs that only change .mts or .cts files', async () => {
  const f = fake({ prs: [{ ...pr(3, [{ path: 'src/a.mts' }]), mergedAt: '2026-10-09T00:00:00Z' } as ReturnType<typeof pr>, { ...pr(4, [{ path: 'README.md' }]), mergedAt: '2026-10-09T00:00:01Z' } as ReturnType<typeof pr>] });
  const report = await measureAffectedRoots('/repo', ['--recent', '5'], f.deps);
  expect(report.prs.map((row) => row.pr)).toEqual([3]);
});

test('--recent reads the full file list of a PR whose listed files were truncated', async () => {
  const truncated = { ...pr(5, [{ path: 'README.md' }]), changedFiles: 150, mergedAt: '2026-10-09T00:00:02Z' } as ReturnType<typeof pr>;
  const complete = { ...pr(6, [{ path: 'docs/a.md' }]), changedFiles: 1, mergedAt: '2026-10-09T00:00:01Z' } as ReturnType<typeof pr>;
  const f = fake({ prs: [truncated, complete] });
  const apiCalls: string[][] = [];
  const run: Runner = async (command, args, cwd, env) => {
    if (command === 'gh' && args[0] === 'api' && args.some((arg) => arg.endsWith('/files'))) {
      apiCalls.push(args);
      return output(0, ['README.md', ...Array.from({ length: 148 }, (_, i) => `docs/${i}.md`), 'src/late.ts'].join('\n'));
    }
    return f.deps.run(command, args, cwd, env);
  };
  const report = await measureAffectedRoots('/repo', ['--recent', '5'], { ...f.deps, run });
  expect(report.prs.map((row) => row.pr)).toEqual([5]);
  expect(apiCalls).toHaveLength(1); // the complete PR (changedFiles 1 = listed 1) is not re-read
  expect(apiCalls[0]).toContain('repos/{owner}/{repo}/pulls/5/files');
});
