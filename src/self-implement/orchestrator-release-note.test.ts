import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MergedReleaseNoteWriteError, runSelfImplement, type SelfImplementSeams } from './orchestrator.js';
import { seams } from './test-seams.js';
import { readReleaseNotes, releaseNotesDir, writeReleaseNote } from '../release-loop/release-note.js';

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
