import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GoalAskStore } from './goal-ask-store.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const directories: string[] = [];
const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const BIN = resolve(REPO_ROOT, 'bin/elanous.mjs');
const document = '- RootIntent: CLI goal asks\n';

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStateDir(): string {
  const stateDir = mkdtempSync(join(tmpdir(), 'goal-ask-cli-'));
  directories.push(stateDir);
  return stateDir;
}

function runGoalAsks(stateDir: string, args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, BIN, 'self', 'goal-asks', ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('self goal-asks --text', () => {
  test('filters ask and goal-file text through the deployed CLI while preserving human and JSON output', () => {
    const stateDir = createStateDir();
    const databasePath = join(stateDir, 'self-implement', 'goal-runs.db');
    const store = new GoalAskStore(databasePath);
    try {
      expect(store.insert({
        authorRunId: 'author-ask-match',
        goalFile: 'docs/goals/plain.md',
        ask: 'Needle appears in this ask',
        document: `${document}- GoalId: 0123456789abcdef\n`,
      })).toBe(true);
      expect(store.insert({
        authorRunId: 'author-file-match',
        goalFile: 'docs/goals/needle-path.md',
        ask: 'ordinary ask',
        document: `${document}- GoalId: fedcba9876543210\n`,
      })).toBe(true);
      expect(store.insert({
        authorRunId: 'author-non-match',
        goalFile: 'docs/goals/other.md',
        ask: 'unrelated text',
        document: `${document}- GoalId: 0011223344556677\n`,
      })).toBe(true);
    } finally {
      store.close();
    }

    const human = runGoalAsks(stateDir, ['--text', 'NEEDLE', '--limit', '10']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout.toString()).toContain('author run author-ask-match');
    expect(human.stdout.toString()).toContain('author run author-file-match');
    expect(human.stdout.toString()).not.toContain('author run author-non-match');
    expect(human.stdout.toString()).toContain('file: docs/goals/needle-path.md');
    expect(human.stdout.toString()).toContain('ask: Needle appears in this ask');

    const json = runGoalAsks(stateDir, ['--goal', '0123456789abcdef', '--text', 'needle', '--limit', '10', '--json']);
    expect(json.exitCode).toBe(0);
    expect(json.stdout.toString().trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        authorRunId: 'author-ask-match',
        goalId: '0123456789abcdef',
        ask: 'Needle appears in this ask',
        goalFile: 'docs/goals/plain.md',
      }),
    ]);

    const noMatch = runGoalAsks(stateDir, ['--text', 'zzz-no-such-text-zzz', '--limit', '10']);
    expect(noMatch.exitCode).toBe(0);
    expect(noMatch.stdout.toString()).toContain('기록 없음');
  }, 60_000);
});
