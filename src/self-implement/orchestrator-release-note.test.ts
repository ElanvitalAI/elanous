import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MergedReleaseNoteWriteError, runSelfImplement, type SelfImplementSeams } from './orchestrator.js';
import { seams } from './test-seams.js';
import { readReleaseNotes, releaseNotesDir, writeReleaseNote } from '../release-loop/release-note.js';
import { debug } from '../debug/log.js';
import { defaultSeams } from './seams.js';
import { makePrManager, type CmdRunner } from '../autopilot/pr-manager.js';

const root = mkdtempSync(join(tmpdir(), 'orchestrator-release-note-'));
const previousStateDir = process.env.ELANOUS_STATE_DIR;
beforeAll(() => { process.env.ELANOUS_STATE_DIR = root; });
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  rmSync(root, { recursive: true, force: true });
});

const goalDocument = [
  '# Goal', '## 목표', 'Ship this release.', '## 릴리스 노트',
  '- 한 줄: 설정 오류를 고쳤다', '- 종류: fix', '- 문서: docs/fix.md', '- 대상: later',
  '## 경계', '이 밖은 건드리지 않는다',
].join('\n');

const review: NonNullable<Awaited<ReturnType<NonNullable<SelfImplementSeams['reviewDiff']>>>> = {
  verdict: 'pass', mustFix: [], shouldFix: [], summary: 'reviewed', reviewed: true, diffTruncated: false,
};

test('ordinary PR body renders the goal release note immediately after the implementation summary', async () => {
  const goalFile = join(root, 'goal-release.txt');
  writeFileSync(goalFile, goalDocument);
  let body = '';
  const result = await runSelfImplement({
    feature: 'release note title', goalFile, memory: false,
    writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
    seams: seams({ openPr: async (input) => { body = input.body; return { url: 'https://pr/501', number: 501 }; } }),
  });
  expect(result.stage).toBe('pr-opened');
  expect(body).toContain('## 구현 요약\nimpl\n\n## 릴리스 노트\n- 한 줄: 설정 오류를 고쳤다\n- 종류: fix\n- 문서: docs/fix.md\n- 대상: later');
  expect(body).not.toContain('mergeSha:');
  expect(body).not.toContain('mergeCommit:');
  expect(readReleaseNotes(releaseNotesDir(root)).has(501)).toBe(false);
});

test('blocked draft PR body retains the fallback when the goal has no release note', async () => {
  let body = '';
  const goalFile = join(root, 'goal-without-release-note.txt');
  writeFileSync(goalFile, '# Goal without release note\n');
  const result = await runSelfImplement({
    feature: 'unreadable release note', goalFile, memory: false, maxReworkRounds: 0,
    writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
    seams: seams({ gateResults: [false], openPr: async (input) => { body = input.body; return { url: 'https://pr/502', number: 502 }; } }),
  });
  expect(result.stage).toBe('gate-failed');
  expect(body).toContain('## 구현 요약\nimpl\n\n## 릴리스 노트\n- 한 줄: unreadable release note\n- 종류: internal\n- 문서: 없음(하니스 자동 생성)\n- 대상: next');
  expect(body).toContain('## 사람 판단 필요');
  expect(readReleaseNotes(releaseNotesDir(root)).has(502)).toBe(false);
});

test('review-budget PR body renders the release note before follow-up findings', async () => {
  const goalFile = join(root, 'goal-review-budget.txt');
  writeFileSync(goalFile, goalDocument);
  let body = '';
  const result = await runSelfImplement({
    feature: 'review budget note', goalFile, memory: false, autoMerge: true, maxReworkRounds: 0,
    writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
    seams: seams({
      reviewDiff: async () => ({ ...review, verdict: 'fail', mustFix: ['follow-up fix'] }),
      openPr: async (input) => { body = input.body; return { url: 'https://pr/507', number: 507 }; },
    }),
  });
  expect(result.stage).toBe('pr-opened');
  expect(body).toContain('## 구현 요약\nimpl\n\n## 릴리스 노트\n- 한 줄: 설정 오류를 고쳤다');
  expect(body).toContain('## Follow-up must-fix (1)\n- follow-up fix');
  expect(readReleaseNotes(releaseNotesDir(root)).has(507)).toBe(false);
});

test('PR body without a goal file uses an empty document fallback', async () => {
  let body = '';
  await runSelfImplement({
    feature: 'fallback without goal', memory: false,
    seams: seams({ openPr: async (input) => { body = input.body; return { url: 'https://pr/508', number: 508 }; } }),
  });
  expect(body).toContain('## 구현 요약\nimpl\n\n## 릴리스 노트\n- 한 줄: fallback without goal\n- 종류: internal\n- 문서: 없음(하니스 자동 생성)\n- 대상: next');
});

test('PR body falls back if a goal file disappears after launch', async () => {
  const goalFile = join(root, 'goal-disappearing.txt');
  writeFileSync(goalFile, goalDocument);
  let body = '';
  const result = await runSelfImplement({
    feature: 'vanishing goal', goalFile, memory: false,
    writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
    seams: seams({
      gate: async () => { rmSync(goalFile); return { passed: true, log: 'ok' }; },
      openPr: async (input) => { body = input.body; return { url: 'https://pr/509', number: 509 }; },
    }),
  });
  expect(result.stage).toBe('pr-opened');
  expect(body).toContain('## 릴리스 노트\n- 한 줄: vanishing goal\n- 종류: internal\n- 문서: 없음(하니스 자동 생성)\n- 대상: next');
});

test('current goal note enters the PR and its worktree next.md once across two landings', async () => {
  const goalFile = join(root, 'goal-current.txt');
  writeFileSync(goalFile, '# Current\n## Situation\nwork\n## 릴리스 노트\n- 한 줄: New public action\n- 종류: feat\n- 문서: docs/action.md\n- 대상: next\n');
  const worktree = join(root, 'current-worktree');
  mkdirSync(join(worktree, 'release'), { recursive: true });
  const next = join(worktree, 'release', 'next.md');
  writeFileSync(next, '# Next\n\n## Feat\n\n## Fix\n');
  const bodies: string[] = [];
  for (let i = 0; i < 2; i++) {
    await runSelfImplement({ feature: 'current goal', goalFile, memory: false, writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
      seams: seams({ createWorktree: async ({ branch, base }) => ({ path: worktree, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
        openPr: async (input) => { bodies.push(input.body); expect(readFileSync(next, 'utf8')).toContain('New public action'); return { url: `https://pr/${520 + i}`, number: 520 + i }; },
      }),
    });
  }
  expect(bodies.every((body) => body.includes('## 릴리스 노트\n- 한 줄: New public action\n- 종류: feat'))).toBe(true);
  expect(readFileSync(next, 'utf8').match(/- feat — New public action\. Documentation: docs\/action.md\. Target: next\./g)).toHaveLength(1);
});

test('missing next.md blocks a public-note PR before opening, but internal and later notes need no file', async () => {
  const worktree = join(root, 'missing-next-worktree');
  mkdirSync(worktree, { recursive: true });
  let opened = 0;
  const run = (kind: 'feat' | 'fix' | 'security' | 'internal', target: 'next' | 'later') => {
    const goalFile = join(root, `missing-next-${kind}-${target}.md`);
    writeFileSync(goalFile, `# Goal\n## 릴리스 노트\n- 한 줄: A public change\n- 종류: ${kind}\n- 문서: docs/change.md\n- 대상: ${target}\n`);
    return runSelfImplement({ feature: 'missing next note', goalFile, memory: false,
      writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
      seams: seams({
        createWorktree: async ({ branch, base }) => ({ path: worktree, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
        openPr: async () => { opened++; return { url: 'https://pr/539', number: 539 }; },
      }),
    });
  };
  for (const kind of ['feat', 'fix', 'security'] as const) {
    await expect(run(kind, 'next')).rejects.toThrow('release/next.md');
    expect(opened).toBe(0);
  }
  expect((await run('internal', 'next')).stage).toBe('pr-opened');
  expect((await run('feat', 'later')).stage).toBe('pr-opened');
  expect(opened).toBe(2);
});

test('the real openPr seam commits and pushes next.md into the PR head before opening it', async () => {
  const repo = mkdtempSync(join(root, 'release-pr-repo-'));
  const remote = join(repo, 'remote.git');
  const worktree = join(repo, 'work');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  mkdirSync(worktree);
  git(repo, 'init', '--bare', '-b', 'main', remote);
  git(worktree, 'init', '-b', 'main');
  git(worktree, 'config', 'user.name', 'Release Test');
  git(worktree, 'config', 'user.email', 'release@example.test');
  mkdirSync(join(worktree, 'release'));
  writeFileSync(join(worktree, 'release', 'next.md'), '# Next\n\n## Feat\n\n## Fix\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-m', 'base');
  git(worktree, 'remote', 'add', 'origin', remote);
  git(worktree, 'push', '-u', 'origin', 'main');
  git(worktree, 'checkout', '-b', 'feature');
  writeFileSync(join(worktree, 'feature.txt'), 'implemented\n');
  const goalFile = join(repo, 'goal.md');
  writeFileSync(goalFile, '# Current\n## Situation\nwork\n## 릴리스 노트\n- 한 줄: New public action\n- 종류: feat\n- 문서: docs/action.md\n- 대상: next\n');
  const commands: string[] = [];
  let created = 0;
  const runner: CmdRunner = (cmd, args, opts) => {
    if (cmd === 'gh') {
      if (args[0] === 'pr' && args[1] === 'list') return { ok: true, out: '' };
      if (args[0] === 'pr' && args[1] === 'create') {
        created++;
        const diff = git(repo, '--git-dir', remote, 'diff', 'refs/heads/main...refs/heads/feature', '--', 'release/next.md');
        expect(diff.match(/^\+- feat — New public action\. Documentation: docs\/action\.md\. Target: next\.$/gm)).toHaveLength(1);
        expect(git(worktree, 'status', '--porcelain', '--', 'release/next.md')).toBe('');
        expect(git(repo, '--git-dir', remote, 'rev-parse', 'refs/heads/feature')).toBe(git(worktree, 'rev-parse', 'HEAD'));
        return { ok: true, out: 'https://example.test/pull/540' };
      }
      return { ok: false, out: '', err: `unexpected gh ${args.join(' ')}` };
    }
    commands.push(args.join(' '));
    const result = spawnSync(cmd, args, { cwd: opts?.cwd ?? worktree, encoding: 'utf8' });
    return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
  };
  const realOpenPr = defaultSeams({ prManager: makePrManager(runner) }).openPr;
  try {
    const result = await runSelfImplement({
      feature: 'current goal', goalFile, memory: false,
      writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
      seams: seams({
        createWorktree: async ({ base }) => ({ path: worktree, branch: 'feature', base, resolvedBase: git(worktree, 'rev-parse', 'main'), invokedHead: git(worktree, 'rev-parse', 'main') }),
        openPr: realOpenPr,
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(created).toBe(1);
    expect(commands.some((command) => command.includes(' push '))).toBe(true);
    const diff = git(worktree, 'diff', 'main...HEAD', '--', 'release/next.md');
    expect(diff.match(/^\+- feat — New public action\. Documentation: docs\/action\.md\. Target: next\.$/gm)).toHaveLength(1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('the real openPr seam: same sentence with stale documentation is rewritten in the pushed head to match the PR body', async () => {
  const repo = mkdtempSync(join(root, 'release-pr-repo-'));
  const remote = join(repo, 'remote.git');
  const worktree = join(repo, 'work');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  mkdirSync(worktree);
  git(repo, 'init', '--bare', '-b', 'main', remote);
  git(worktree, 'init', '-b', 'main');
  git(worktree, 'config', 'user.name', 'Release Test');
  git(worktree, 'config', 'user.email', 'release@example.test');
  mkdirSync(join(worktree, 'release'));
  writeFileSync(join(worktree, 'release', 'next.md'), '# Next\n\n## Feat\n\n- feat — New public action. Documentation: none. Target: next.\n\n## Fix\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-m', 'base');
  git(worktree, 'remote', 'add', 'origin', remote);
  git(worktree, 'push', '-u', 'origin', 'main');
  git(worktree, 'checkout', '-b', 'feature');
  writeFileSync(join(worktree, 'feature.txt'), 'implemented\n');
  const goalFile = join(repo, 'goal.md');
  writeFileSync(goalFile, '# Current\n## Situation\nwork\n## 릴리스 노트\n- 한 줄: New public action\n- 종류: feat\n- 문서: docs/action.md\n- 대상: next\n');
  const commands: string[] = [];
  let prBodyDocs = '';
  let created = 0;
  const runner: CmdRunner = (cmd, args, opts) => {
    if (cmd === 'gh') {
      if (args[0] === 'pr' && args[1] === 'list') return { ok: true, out: '' };
      if (args[0] === 'pr' && args[1] === 'create') {
        created++;
        const diff = git(repo, '--git-dir', remote, 'diff', 'refs/heads/main...refs/heads/feature', '--', 'release/next.md');
        expect(diff.match(/^\+- feat — New public action\. Documentation: docs\/action\.md\. Target: next\.$/gm)).toHaveLength(1);
        expect(diff.match(/^-- feat — New public action\. Documentation: none\. Target: next\.$/gm)).toHaveLength(1);
        prBodyDocs = (args.join('\n').match(/- 문서: ([^\n]+)/) ?? [])[1] ?? '';
        expect(git(worktree, 'status', '--porcelain', '--', 'release/next.md')).toBe('');
        expect(git(repo, '--git-dir', remote, 'rev-parse', 'refs/heads/feature')).toBe(git(worktree, 'rev-parse', 'HEAD'));
        return { ok: true, out: 'https://example.test/pull/541' };
      }
      return { ok: false, out: '', err: `unexpected gh ${args.join(' ')}` };
    }
    commands.push(args.join(' '));
    const result = spawnSync(cmd, args, { cwd: opts?.cwd ?? worktree, encoding: 'utf8' });
    return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
  };
  const realOpenPr = defaultSeams({ prManager: makePrManager(runner) }).openPr;
  try {
    const result = await runSelfImplement({
      feature: 'current goal', goalFile, memory: false,
      writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
      seams: seams({
        createWorktree: async ({ base }) => ({ path: worktree, branch: 'feature', base, resolvedBase: git(worktree, 'rev-parse', 'main'), invokedHead: git(worktree, 'rev-parse', 'main') }),
        openPr: realOpenPr,
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(created).toBe(1);
    expect(prBodyDocs).toBe('docs/action.md');
    expect(commands.some((command) => command.includes(' push '))).toBe(true);
    const diff = git(worktree, 'diff', 'main...HEAD', '--', 'release/next.md');
    expect(diff.match(/^\+- feat — New public action\. Documentation: docs\/action\.md\. Target: next\.$/gm)).toHaveLength(1);
    expect(diff.match(/^-- feat — New public action\. Documentation: none\. Target: next\.$/gm)).toHaveLength(1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('a shard without a goal file uses its identity note; internal and missing notes never change next.md', async () => {
  const worktree = join(root, 'shard-worktree');
  mkdirSync(join(worktree, 'release'), { recursive: true });
  const next = join(worktree, 'release', 'next.md');
  writeFileSync(next, '# Next\n\n## Feat\n\n## Fix\n');
  const records: Array<{ reason: string; shard: boolean }> = [];
  const off = debug.registerSink({ name: 'shard-note-fallback-test', emit: (record) => {
    if (record.category === 'release-note' && record.event === 'harness-fallback') records.push(record.data as { reason: string; shard: boolean });
  } });
  const bodies: string[] = [];
  const run = (feature: string) => runSelfImplement({ feature, memory: false,
    seams: seams({ createWorktree: async ({ branch, base }) => ({ path: worktree, branch, base, resolvedBase: 'a'.repeat(40), invokedHead: 'a'.repeat(40) }),
      openPr: async (input) => { bodies.push(input.body); return { url: 'https://pr/530', number: 530 }; },
    }),
  });
  try {
    const note = { line: 'Shard feature', kind: 'feat', docs: { none: '사용 설명' }, target: 'next' };
    await run(`implement shard\n\n## Shard identity\n${JSON.stringify({ shardId: 'first', totalShards: 2, position: 1, releaseNote: note })}`);
    await run(`implement shard\n\n## Shard identity\n${JSON.stringify({ shardId: 'second', totalShards: 2, position: 2, releaseNote: note })}`);
    expect(bodies.slice(0, 2).every((body) => body.includes('## 릴리스 노트\n- 한 줄: Shard feature\n- 종류: feat\n- 문서: 없음(사용 설명)'))).toBe(true);
    expect(bodies[0]).not.toContain('하니스 자동 생성');
    expect(readFileSync(next, 'utf8').match(/- feat — Shard feature/g)).toHaveLength(1);
    const prior = readFileSync(next, 'utf8');
    await run(`internal shard\n\n## Shard identity\n${JSON.stringify({ shardId: 'internal', totalShards: 1, position: 1, releaseNote: { ...note, kind: 'internal' } })}`);
    await run('missing shard\n\n## Shard identity\n{"shardId":"missing","totalShards":1,"position":1}');
    expect(bodies[2]).toContain('- 종류: internal');
    expect(bodies[3]).toContain('없음(하니스 자동 생성)');
    expect(readFileSync(next, 'utf8')).toBe(prior);
    expect(records).toEqual([expect.objectContaining({ reason: 'missing', shard: true })]);
  } finally { off(); }
});

test('a shard does not copy a parent release note outside the legacy ## 목표 boundary into its PR', async () => {
  let body = '';
  const outside = '## 릴리스 노트\n- 한 줄: Outside goal\n- 종류: feat\n- 문서: docs/outside.md\n- 대상: next\n';
  const feature = `implement shard\n\n## Shard identity\n${JSON.stringify({
    shardId: 'outside', totalShards: 1, position: 1,
    parentRequest: `${outside}\n## 목표\nwork\n## 검증\n${outside}`,
  })}`;
  await runSelfImplement({ feature, memory: false, seams: seams({
    openPr: async (input) => { body = input.body; return { url: 'https://pr/531', number: 531 }; },
  }) });
  expect(body).toContain('## 릴리스 노트\n- 한 줄: implement shard\n- 종류: internal\n- 문서: 없음(하니스 자동 생성)');
  expect(body).not.toContain('## 릴리스 노트\n- 한 줄: Outside goal');
});

test('a failed post-merge release-note write surfaces recoverable merge identity and fragment instead of a merged result', async () => {
  const number = 512;
  const goalFile = join(root, 'goal-write-failure.txt');
  writeFileSync(goalFile, goalDocument);
  const directory = releaseNotesDir(root);
  mkdirSync(dirname(directory), { recursive: true });
  writeFileSync(directory, 'not a directory');
  try {
    let mergeCalls = 0;
    let cleanupCalls = 0;
    let caught: unknown;
    try {
      await runSelfImplement({
        feature: 'failed write recovery', goalFile, memory: false, autoMerge: true,
        writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
        seams: seams({
          reviewDiff: async () => review,
          openPr: async () => ({ url: `https://pr/${number}`, number }),
          mergePr: async () => { mergeCalls++; return { merged: true, baseRefName: 'main', mergeCommit: 'b'.repeat(40) }; },
          postMergeCleanup: {
            enabled: true,
            listActiveTerminalDirectories: () => { cleanupCalls++; return { ok: true, value: [] }; },
            isWorktreeInUse: () => false,
            readWorktreePorcelain: () => '',
            resolveMainRepoRoot: () => root,
            removeWorktree: () => {},
            removeBranch: () => {},
          },
        }),
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MergedReleaseNoteWriteError);
    const failure = caught as MergedReleaseNoteWriteError;
    expect(failure.message).toContain('was merged, but its release note could not be written');
    expect(failure.cause).toBeDefined();
    expect(failure.prNumber).toBe(number);
    expect(failure.prUrl).toBe(`https://pr/${number}`);
    expect(failure.directory).toBe(directory);
    expect(failure.fragment).toEqual({
      pr: number, line: '설정 오류를 고쳤다', kind: 'fix', docs: { path: 'docs/fix.md' }, target: 'later', source: 'harness', mergeSha: 'b'.repeat(40),
    });
    expect(mergeCalls).toBe(1);
    expect(cleanupCalls).toBe(0);
    rmSync(directory);
    writeReleaseNote(failure.directory, failure.fragment);
    expect(readReleaseNotes(directory).get(number)).toEqual(failure.fragment);
    expect(mergeCalls).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('confirmed automatic merge writes a harness fragment under the effective instance root, with merge SHA only in JSON', async () => {
  const goalFile = join(root, 'goal-merge.txt');
  writeFileSync(goalFile, goalDocument);
  let body = '';
  const result = await runSelfImplement({
    feature: 'merged note title', goalFile, memory: false, autoMerge: true,
    writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
    seams: seams({ reviewDiff: async () => review,
      openPr: async (input) => { body = input.body; return { url: 'https://pr/503', number: 503 }; },
      mergePr: async () => ({ merged: true, baseRefName: 'main', mergeCommit: 'a'.repeat(40) }),
    }),
  });
  expect(result.stage).toBe('merged');
  expect(readReleaseNotes(releaseNotesDir(root)).get(503)).toEqual({
    pr: 503, line: '설정 오류를 고쳤다', kind: 'fix', docs: { path: 'docs/fix.md' }, target: 'later', source: 'harness', mergeSha: 'a'.repeat(40),
  });
  expect(readFileSync(join(releaseNotesDir(root), '503.json'), 'utf8')).toContain('"mergeSha":');
  expect(body).toContain('## 릴리스 노트');
  expect(body).not.toContain('mergeSha:');
  expect(body).not.toContain('mergeCommit:');
});

test('automatic merge records the same note rendered in its PR body even if the goal changes or disappears after PR creation', async () => {
  for (const [number, mutation] of [[510, 'change'], [511, 'delete']] as const) {
    const goalFile = join(root, `goal-mutable-${number}.txt`);
    writeFileSync(goalFile, goalDocument);
    let body = '';
    const result = await runSelfImplement({
      feature: 'stable release note', goalFile, memory: false, autoMerge: true,
      writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
      seams: seams({
        reviewDiff: async () => review,
        openPr: async (input) => {
          body = input.body;
          if (mutation === 'change') writeFileSync(goalFile, goalDocument.replace('설정 오류를 고쳤다', '나중에 바뀐 내용'));
          else rmSync(goalFile);
          return { url: `https://pr/${number}`, number };
        },
        mergePr: async () => ({ merged: true, baseRefName: 'main' }),
      }),
    });
    expect(result.stage).toBe('merged');
    const fragment = readReleaseNotes(releaseNotesDir(root)).get(number);
    expect(fragment).toEqual({
      pr: number, line: '설정 오류를 고쳤다', kind: 'fix', docs: { path: 'docs/fix.md' }, target: 'later', source: 'harness',
    });
    expect(body).toContain('## 구현 요약\nimpl\n\n## 릴리스 노트\n- 한 줄: 설정 오류를 고쳤다');
    expect(body).not.toContain('나중에 바뀐 내용');
  }
});

test('failed automatic merge never writes a fragment; successful merge without SHA preserves a higher-priority PR-body note', async () => {
  const goalFile = join(root, 'goal-merge-preserved.txt');
  writeFileSync(goalFile, goalDocument);
  const run = (number: number, merged: boolean) => runSelfImplement({
    feature: 'preserve merge notes', goalFile, memory: false, autoMerge: true,
    writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
    seams: seams({ reviewDiff: async () => review,
      openPr: async () => ({ url: `https://pr/${number}`, number }),
      mergePr: async () => ({ merged, baseRefName: 'main' }),
    }),
  });
  const failed = await run(504, false);
  expect(failed.stage).toBe('pr-opened');
  expect(readReleaseNotes(releaseNotesDir(root)).has(504)).toBe(false);
  writeReleaseNote(releaseNotesDir(root), {
    pr: 505, line: 'PR body wins', kind: 'feat', docs: { none: 'existing' }, target: 'next', source: 'pr-body',
  });
  const merged = await run(505, true);
  expect(merged.stage).toBe('merged');
  expect(readReleaseNotes(releaseNotesDir(root)).get(505)).toEqual({
    pr: 505, line: 'PR body wins', kind: 'feat', docs: { none: 'existing' }, target: 'next', source: 'pr-body',
  });
  const unprioritized = await run(506, true);
  expect(unprioritized.stage).toBe('merged');
  expect(readReleaseNotes(releaseNotesDir(root)).get(506)).toEqual({
    pr: 506, line: '설정 오류를 고쳤다', kind: 'fix', docs: { path: 'docs/fix.md' }, target: 'later', source: 'harness',
  });
});
