import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPriorDraftFindings, goalTitleFromTargetGoalFile, type PriorDraftPr } from './prior-draft-findings.js';
import { runSelfImplement, type ReviewDiffContext } from './orchestrator.js';
import { format } from '../agent-substrate/pr-comment-meta.js';
import { seams as testSeams } from './test-seams.js';

const now = new Date().toISOString();
const base = { title: '같은 골', state: 'OPEN', isDraft: true, createdAt: now, mergedAt: null } as const;
const reviewer = (run: string, round: number, items: string[]) => ({
  body: `<!-- elanous-pr-comment v1 role=reviewer round=${round} run=${run} -->\nRound ${round}: reviewer requested ${items.length} must-fix change(s).\n${items.map((item) => `- ${item}`).join('\n')}`,
  created_at: now,
});

describe('collectPriorDraftFindings', () => {
  test('relative goal H1 comes only from the target worktree, even when cwd has a same-named goal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prior-findings-title-'));
    const target = join(root, 'target');
    const other = join(root, 'other');
    const path = 'docs/goals/GOAL-same.md';
    const originalCwd = process.cwd();
    mkdirSync(join(target, 'docs/goals'), { recursive: true });
    mkdirSync(join(other, 'docs/goals'), { recursive: true });
    writeFileSync(join(target, path), '# 같은 골\n');
    writeFileSync(join(other, path), '# 다른 골\n');
    try {
      process.chdir(other);
      const goalTitle = goalTitleFromTargetGoalFile(path, target);
      expect(goalTitle).toBe('같은 골');
      expect(await collectPriorDraftFindings({
        goalTitle: goalTitle!, currentRunId: 'run-new', repoPath: target,
        listPrs: () => [{ ...base, number: 21457 }, { ...base, number: 21599, title: '다른 골' }],
        listComments: () => [reviewer('run-old', 1, ['압축 헤더 결함'])],
      })).toEqual([{ pr: 21457, runId: 'run-old', round: 1, items: ['압축 헤더 결함'] }]);
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('orchestrator loads the target worktree H1 once and carries its findings to every review round', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prior-findings-rounds-'));
    const target = join(root, 'target');
    const other = join(root, 'other');
    const path = 'docs/goals/GOAL-same.md';
    const originalCwd = process.cwd();
    mkdirSync(join(target, 'docs/goals'), { recursive: true });
    mkdirSync(join(other, 'docs/goals'), { recursive: true });
    writeFileSync(join(target, path), '# 같은 골\n');
    writeFileSync(join(other, path), '# 다른 골\n');
    const titles: string[] = [];
    const contexts: ReviewDiffContext[] = [];
    try {
      process.chdir(other);
      await runSelfImplement({
        feature: '같은 골', goalFile: path, runId: 'run-new', memory: false, maxReworkRounds: 1,
        writeGoalExecutionRecord: () => {}, writeGoalRunRecord: () => {},
        seams: testSeams({
          createWorktree: async ({ branch }) => ({ path: target, branch }),
          collectPriorDraftFindings: async ({ goalTitle }) => {
            titles.push(goalTitle);
            return [{ pr: 21457, runId: 'run-old', round: 1, items: ['압축 헤더 결함'] }];
          },
          reviewDiff: async (_cwd, context) => {
            contexts.push(context!);
            return { verdict: contexts.length === 1 ? 'fail' : 'pass', mustFix: contexts.length === 1 ? ['review retry'] : [], shouldFix: [], summary: 'review', reviewed: true };
          },
        }),
      });
      expect(titles).toEqual(['같은 골']);
      expect(contexts.length).toBe(2);
      expect(contexts.map((context) => context.priorRunFindings)).toEqual(Array(2).fill([{ pr: 21457, runId: 'run-old', round: 1, items: ['압축 헤더 결함'] }]));
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unavailable target goal never substitutes the same relative path from cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'prior-findings-missing-title-'));
    const target = join(root, 'target');
    const other = join(root, 'other');
    const path = 'docs/goals/GOAL-same.md';
    const originalCwd = process.cwd();
    mkdirSync(target);
    mkdirSync(join(other, 'docs/goals'), { recursive: true });
    writeFileSync(join(other, path), '# 다른 골\n');
    try {
      process.chdir(other);
      expect(goalTitleFromTargetGoalFile(path, target)).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('same-title older draft only; current run and other title excluded', async () => {
    const prs: PriorDraftPr[] = [
      { ...base, number: 21457 },
      { ...base, number: 21504 },
      { ...base, number: 21599, title: '다른 골' },
    ];
    const calls: number[] = [];
    const results = await collectPriorDraftFindings({
      goalTitle: '같은 골', currentRunId: 'run-new', listPrs: () => prs,
      listComments: (pr) => {
        calls.push(pr);
        return pr === 21457
          ? [reviewer('run-old', 1, ['프록시가 압축 응답 헤더를 그대로 넘긴다', '응답 헤더를 조정해야 한다'])]
          : [reviewer('run-new', 0, ['현재 런'])];
      },
    });
    expect(results).toEqual([{ pr: 21457, runId: 'run-old', round: 1, items: ['프록시가 압축 응답 헤더를 그대로 넘긴다', '응답 헤더를 조정해야 한다'] }]);
    expect(calls).toEqual([21457, 21504]);
  });

  test('last reviewer only; closed unmerged is included while merged, old and open ready are excluded', async () => {
    const results = await collectPriorDraftFindings({
      goalTitle: '같은 골', currentRunId: 'run-new',
      listPrs: () => [
        { ...base, number: 1, state: 'CLOSED', isDraft: false, closedAt: now },
        { ...base, number: 2, state: 'MERGED', mergedAt: now },
        { ...base, number: 3, createdAt: '2020-01-01T00:00:00Z' },
        { ...base, number: 4, isDraft: false },
      ],
      listComments: (pr) => pr === 3
        ? [{ ...reviewer('run-old', 2, ['stale']), created_at: '2020-01-01T00:00:00Z' }]
        : [reviewer('run-old', 0, ['obsolete']), reviewer('run-old', 2, ['latest'])],
    });
    expect(results).toEqual([{ pr: 1, runId: 'run-old', round: 2, items: ['latest'] }]);
  });

  test('status history uses its last reviewer record and preserves the parent comment timestamp and id', async () => {
    const old = '2020-01-01T00:00:00Z';
    const early = reviewer('run-old', 0, ['early']);
    const latest = reviewer('run-old', 2, ['latest status finding']);
    const status = `<!-- elanous:run-status -->\n<details>\n<summary>Round history</summary>\n\n${early.body}\n\n${latest.body}\n</details>`;
    const results = await collectPriorDraftFindings({
      goalTitle: '같은 골', currentRunId: 'run-new',
      listPrs: () => [{ ...base, number: 1, createdAt: old }, { ...base, number: 2, createdAt: old }],
      listComments: (pr) => pr === 1
        ? [{ body: status, created_at: now, id: 101 }, { ...reviewer('run-old', 3, ['older comment']), created_at: now, id: 100 }]
        : [{ body: status, created_at: old, id: 101 }],
    });
    expect(results).toEqual([{ pr: 1, runId: 'run-old', round: 2, items: ['latest status finding'] }]);
  });

  test('current run inside status history excludes the entire draft', async () => {
    const status = `<!-- elanous:run-status -->\n<details>\n<summary>Round history</summary>\n\n${reviewer('run-old', 0, ['old']).body}\n\n${format({ role: 'author', run: 'run-new', round: 1 })}\nRound 1: changed\n</details>`;
    expect(await collectPriorDraftFindings({
      goalTitle: '같은 골', currentRunId: 'run-new',
      listPrs: () => [{ ...base, number: 1 }],
      listComments: () => [{ body: status, created_at: now, id: 42 }],
    })).toEqual([]);
  });

  test('caps items to 300 characters and twelve overall, with only must-fix bullets after the heading', async () => {
    const results = await collectPriorDraftFindings({
      goalTitle: '같은 골', currentRunId: 'run-new',
      listPrs: () => [{ ...base, number: 10 }, { ...base, number: 11 }],
      listComments: () => [reviewer('run-old', 1, Array.from({ length: 9 }, () => 'x'.repeat(350)))],
    });
    expect(results.map((finding) => finding.items.length)).toEqual([9, 3]);
    expect(results[0]!.items[0]).toHaveLength(300);
  });

  test('declared count and section boundary: «0 must-fix» and later discussion lists are never read as findings', async () => {
    const body = (head: string) => ({
      body: `<!-- elanous-pr-comment v1 role=reviewer round=2 run=run-old -->\n${head}\n\n- 토론: 이름을 바꾸면 좋겠다\n- 토론: 문서 한 줄`,
      created_at: now,
    });
    const zero = await collectPriorDraftFindings({
      goalTitle: '같은 골', currentRunId: 'run-new',
      listPrs: () => [{ ...base, number: 30 }],
      listComments: () => [body('Round 2: reviewer requested 0 must-fix change(s).')],
    });
    expect(zero).toEqual([]);
    const one = await collectPriorDraftFindings({
      goalTitle: '같은 골', currentRunId: 'run-new',
      listPrs: () => [{ ...base, number: 31 }],
      listComments: () => [{
        body: '<!-- elanous-pr-comment v1 role=reviewer round=2 run=run-old -->\nRound 2: reviewer requested 1 must-fix change(s).\n\n- 진짜 지적\n\n**Should-fix**\n- 권고일 뿐',
        created_at: now,
      }],
    });
    expect(one).toEqual([{ pr: 31, runId: 'run-old', round: 2, items: ['진짜 지적'] }]);
  });

  test('one PR comment lookup failure retains findings from other PRs', async () => {
    const results = await collectPriorDraftFindings({
      goalTitle: '같은 골', currentRunId: 'run-new',
      listPrs: () => [{ ...base, number: 1 }, { ...base, number: 2 }, { ...base, number: 3 }],
      listComments: (pr) => {
        if (pr === 2) throw new Error('offline');
        return [reviewer('run-old', 1, [`finding ${pr}`])];
      },
    });
    expect(results).toEqual([
      { pr: 1, runId: 'run-old', round: 1, items: ['finding 1'] },
      { pr: 3, runId: 'run-old', round: 1, items: ['finding 3'] },
    ]);
  });

  test('old open draft with a recent reviewer comment remains eligible; stale activity does not', async () => {
    const old = '2020-01-01T00:00:00Z';
    const results = await collectPriorDraftFindings({
      goalTitle: '같은 골', currentRunId: 'run-new',
      listPrs: () => [{ ...base, number: 1, createdAt: old }, { ...base, number: 2, createdAt: old }],
      listComments: (pr) => [{ ...reviewer('run-old', 1, [`finding ${pr}`]), created_at: pr === 1 ? now : old }],
    });
    expect(results).toEqual([{ pr: 1, runId: 'run-old', round: 1, items: ['finding 1'] }]);
  });

  test('recent non-review comment keeps an old open draft eligible for its last reviewer finding', async () => {
    const old = '2020-01-01T00:00:00Z';
    const results = await collectPriorDraftFindings({
      goalTitle: '같은 골', currentRunId: 'run-new',
      listPrs: () => [{ ...base, number: 1, createdAt: old }],
      listComments: () => [
        { ...reviewer('run-old', 1, ['old reviewer finding']), created_at: old },
        { body: 'Recent discussion', created_at: now },
      ],
    });
    expect(results).toEqual([{ pr: 1, runId: 'run-old', round: 1, items: ['old reviewer finding'] }]);
  });

  test('default gh lookups target the supplied repository even when process cwd belongs to another repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prior-findings-gh-'));
    const target = join(root, 'target');
    const other = join(root, 'other');
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const originalCapture = process.env.GH_CAPTURE_FILE;
    mkdirSync(target);
    mkdirSync(other);
    const log = join(root, 'gh-calls.jsonl');
    const gh = join(root, 'gh');
    writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CAPTURE_FILE, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify({ nameWithOwner: process.cwd().endsWith('/target') ? 'owner/target' : 'owner/other' }));
} else if (args[0] === 'pr' && args[1] === 'list' && args.includes('--repo') && args[args.indexOf('--repo') + 1] === 'owner/target') {
  console.log(JSON.stringify([{ number: 21457, title: '같은 골', state: 'OPEN', isDraft: true, createdAt: '${now}', mergedAt: null }]));
} else if (args[0] === 'api' && args[1] === 'repos/owner/target/issues/21457/comments') {
  console.log(JSON.stringify([[{ body: ${JSON.stringify(reviewer('run-old', 1, ['압축 헤더 결함']).body)}, created_at: '${now}' }]]));
} else { process.exit(1); }
`);
    chmodSync(gh, 0o755);
    try {
      process.env.PATH = `${root}:${originalPath ?? ''}`;
      process.env.GH_CAPTURE_FILE = log;
      process.chdir(other);
      expect(await collectPriorDraftFindings({ goalTitle: '같은 골', currentRunId: 'run-new', repoPath: target }))
        .toEqual([{ pr: 21457, runId: 'run-old', round: 1, items: ['압축 헤더 결함'] }]);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { cwd: string; args: string[] });
      expect(calls).toHaveLength(3);
      // macOS tmpdir is a symlink (/var → /private/var); the child reports the resolved path.
      expect(calls.every((call) => call.cwd === realpathSync(target))).toBe(true);
      expect(calls[1]!.args).toContain('--repo');
      expect(calls[1]!.args[calls[1]!.args.indexOf('--repo') + 1]).toBe('owner/target');
      expect(calls[2]!.args[1]).toBe('repos/owner/target/issues/21457/comments');
    } finally {
      process.chdir(originalCwd);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalCapture === undefined) delete process.env.GH_CAPTURE_FILE;
      else process.env.GH_CAPTURE_FILE = originalCapture;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('lookup failure returns an empty list without blocking review', async () => {
    expect(await collectPriorDraftFindings({ goalTitle: '같은 골', currentRunId: 'run-new', listPrs: () => { throw new Error('offline'); } })).toEqual([]);
    expect(await collectPriorDraftFindings({ goalTitle: '같은 골', currentRunId: 'run-new', listPrs: () => [{ ...base, number: 1 }], listComments: () => { throw new Error('offline'); } })).toEqual([]);
  });
});
