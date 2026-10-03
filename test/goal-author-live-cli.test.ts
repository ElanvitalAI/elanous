import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const directories: string[] = [];
const liveAuthoringAvailable = process.env.ELANOUS_GOAL_AUTHOR_LIVE_TEST === '1';
const liveTest = liveAuthoringAvailable ? test : test.skip;

const canonicalGoal = (): string => `## PROBLEM
problem

## WHAT TO BUILD
build

## ACCEPTANCE CRITERIA
criteria

## REQUIRED EVIDENCE
- [proof] present

## TRACED PATHS
paths

## SCOPE BOUNDARY
short

## 답하지 못하는 것
none

## 불변식
invariants

## 판정 신호
signals
`;

function fixture(document: string): { root: string; goal: string } {
  const root = mkdtempSync(join(tmpdir(), 'goal-author-live-'));
  directories.push(root);
  mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', '--quiet'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '--quiet', '-m', 'fixture'], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  });
  const goal = join(root, 'GOAL-lint.txt');
  writeFileSync(goal, document);
  return { root, goal };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('self author output inspection', () => {
  liveTest('reports all inspection values for a first authoring without --supersedes', () => {
    const { root } = fixture(canonicalGoal());
    const result = spawnSync(process.execPath, ['bin/elanous.mjs', '--test', 'self', 'author', '--cwd', root, 'Implement src/example.ts inspection.', '판정 신호: 조건 = first authoring; 관측 = standard output and error; 기대 = inspection values are printed'], {
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_STATE_DIR: join(tmpdir(), `goal-author-output-state-${crypto.randomUUID()}`) },
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('"tracedPathMissing"');
    expect(output).toContain('"tracedPathOutside"');
    expect(output).toContain('"unansweredClarification"');
    expect(output).toContain('"unverifiable"');
    expect(output).toContain('"requestedCriteria"');
    expect(output).toContain('"contradiction"');
    expect(output).toContain('decision signal: extracted=true · condition=true · observation=true · expected=true');
    expect(output).toMatch(/(?:ERROR|WARN) \[[^\]]+\]/);
  }, 180_000);
});
