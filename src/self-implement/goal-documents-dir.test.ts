import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { writeAuthoredGoal, type GoalAuthorDeps } from './goal-author.js';
import { resolveGoalDocumentsDir, type GoalDocumentsDirReason } from './goal-documents-dir.js';
import { queryFederatedUnfinishedRunLedgers, queryUnfinishedRunLedgers } from './run-ledger.js';
import type { UserConfig } from '../user-config/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryGitRepository(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'goal-documents-dir-')));
  temporaryDirectories.push(directory);
  execFileSync('git', ['init'], { cwd: directory, stdio: 'ignore' });
  return directory;
}

function configWithGoalsDir(goalsDir: string | undefined): UserConfig {
  return { raw: goalsDir === undefined ? {} : { harness: { goalsDir } } } as UserConfig;
}

function resolution(
  repoRoot: string,
  goalsDir: string | undefined,
  events: Array<{ category: string; event: string; data: unknown }>,
) {
  return resolveGoalDocumentsDir(repoRoot, {
    readConfig: () => configWithGoalsDir(goalsDir),
    log: (category, event, data) => { events.push({ category, event, data }); },
  });
}

describe('resolveGoalDocumentsDir', () => {
  test('selects config, an existing docs/goals, then .elanous/goals, and logs a distinct reason for each', () => {
    const empty = temporaryGitRepository();
    const existing = temporaryGitRepository();
    mkdirSync(join(existing, 'docs', 'goals'), { recursive: true });
    const configured = temporaryGitRepository();
    const events: Array<{ category: string; event: string; data: unknown }> = [];

    const emptyResolution = resolution(empty, undefined, events);
    const existingResolution = resolution(existing, undefined, events);
    const configuredResolution = resolution(configured, 'custom/goals', events);

    expect(emptyResolution).toEqual({ directory: join(empty, '.elanous', 'goals'), reason: 'default-dot-elanous' });
    expect(existingResolution).toEqual({ directory: join(existing, 'docs', 'goals'), reason: 'existing-docs-goals' });
    expect(configuredResolution).toEqual({ directory: join(configured, 'custom', 'goals'), reason: 'config' });
    expect(existsSync(join(empty, 'docs', 'goals'))).toBe(false);
    expect(new Set(events.map((event) => (event.data as { reason: GoalDocumentsDirReason }).reason))).toEqual(
      new Set(['default-dot-elanous', 'existing-docs-goals', 'config']),
    );
    for (const event of events) {
      expect(event.category).toBe('harness.goals-dir');
      expect(event.event).toBe('resolved');
    }
  });

  test('ignores an absolute, empty, or repository-escaping configured path', () => {
    const repo = temporaryGitRepository();
    for (const goalsDir of ['/tmp/outside', '', '   ', '../outside']) {
      expect(resolution(repo, goalsDir, []).reason).toBe('default-dot-elanous');
    }
  });

  test('logs the resolution through debug.log by default', () => {
    const repo = temporaryGitRepository();
    const logged: unknown[] = [];
    const original = debug.log.bind(debug);
    debug.log = ((category: string, event: string, data?: unknown) => {
      if (category === 'harness.goals-dir' && event === 'resolved') logged.push(data);
    }) as typeof debug.log;
    try {
      const resolved = resolveGoalDocumentsDir(repo, { readConfig: () => configWithGoalsDir(undefined) });
      expect(resolved.reason).toBe('default-dot-elanous');
      expect(logged).toEqual([{ repoRoot: repo, directory: join(repo, '.elanous', 'goals'), reason: 'default-dot-elanous', excluded: 'added' }]);   // UX 13: 사용자 저장소 로컬 무시 목록
    } finally {
      debug.log = original;
    }
  });
});

describe('goal document directory callers', () => {
  const deps: GoalAuthorDeps = {
    ground: async () => ({
      grounded: false, context: '', files: [], persistentEvidence: [],
      codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], documentMatches: [],
      searchTerms: [], genericSearchScope: false, refFacts: [], ptyFacts: [],
    }),
    enhance: async (raw) => ({ original: raw, checklist: ['write the goal'], verbatimPreserved: true }),
    slugFn: async () => 'goal-documents-dir',
  };

  test('writeAuthoredGoal writes under .elanous/goals and does not create docs/goals', async () => {
    const repo = temporaryGitRepository();
    const authored = await writeAuthoredGoal('Write the goal beside the repository, not into docs.', repo, deps, {
      now: () => new Date('2026-09-24T00:00:00Z'),
    });

    expect(authored.path.startsWith(`${join(repo, '.elanous', 'goals')}/`)).toBe(true);
    expect(existsSync(authored.path)).toBe(true);
    expect(existsSync(join(repo, 'docs', 'goals'))).toBe(false);
    expect(readFileSync(authored.path, 'utf8')).toContain('Write the goal beside the repository, not into docs.');
  });

  test('keeps writing under docs/goals when that directory already exists', async () => {
    const repo = temporaryGitRepository();
    mkdirSync(join(repo, 'docs', 'goals'), { recursive: true });
    const authored = await writeAuthoredGoal('Keep the existing ledger.', repo, deps, {
      now: () => new Date('2026-09-24T00:00:00Z'),
    });

    expect(authored.path.startsWith(`${join(repo, 'docs', 'goals')}/`)).toBe(true);
    expect(existsSync(authored.path)).toBe(true);
  });

  test('queryUnfinishedRunLedgers and queryFederatedUnfinishedRunLedgers default to the same resolver', () => {
    const repo = temporaryGitRepository();
    const previous = process.cwd();
    try {
      process.chdir(repo);
      const single = queryUnfinishedRunLedgers({ dir: join(repo, 'missing-ledger'), list: () => [] });
      const federated = queryFederatedUnfinishedRunLedgers({ ledgerDirectories: [], list: () => [] });
      expect(single.goalsDirectory).toBe(join(repo, '.elanous', 'goals'));
      expect(federated.goalsDirectory).toBe(join(repo, '.elanous', 'goals'));
    } finally {
      process.chdir(previous);
    }
  });

  test('an explicit goalsDir override still wins over the resolver', () => {
    const repo = temporaryGitRepository();
    const override = join(repo, 'explicit-goals');
    const previous = process.cwd();
    try {
      process.chdir(repo);
      expect(queryUnfinishedRunLedgers({ dir: join(repo, 'missing-ledger'), goalsDir: override, list: () => [] }).goalsDirectory).toBe(resolve(override));
      expect(queryFederatedUnfinishedRunLedgers({ ledgerDirectories: [], goalsDir: override, list: () => [] }).goalsDirectory).toBe(resolve(override));
    } finally {
      process.chdir(previous);
    }
  });
});
