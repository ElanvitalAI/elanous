import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { debug } from '../debug/log.js';
import { installHarnessCliCommand } from '../harness/harness-cli-command.js';
import { archiveGoals } from './goal-archive.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goal-archive-test-'));
  roots.push(root);
  const repoRoot = join(root, 'repo');
  const stateRoot = join(root, 'state');
  mkdirSync(join(repoRoot, 'docs', 'goals'), { recursive: true });
  mkdirSync(join(stateRoot, 'run-ledger'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  git('init', '-q');
  const runPaths = new Map<string, string>();
  const goal = (name: string, runs: string, tracked = true) => {
    const path = join(repoRoot, 'docs', 'goals', `GOAL-${name}.md`);
    const body = `Build ${name}\n- GoalId: 0123456789abcdef\n\n## 실행 기록\n${runs}`;
    writeFileSync(path, body);
    for (const match of runs.matchAll(/^- runId: ([^\r\n]+)/gm)) runPaths.set(match[1]!, path);
    if (tracked) git('add', '--', `docs/goals/GOAL-${name}.md`);
    return { path, body };
  };
  const block = (runId: string, stage: string, outcome: string, date = '2026-09-10T00:00:00Z') =>
    `- runId: ${runId}\n  stage: ${stage}\n  outcome: ${outcome}\n  prNumber: 44\n  completedAt: ${date}\n`;
  const ledger = (runId: string, status: string, recordedPath?: string) => {
    const goalFile = recordedPath ?? runPaths.get(runId);
    if (!goalFile) throw new Error(`fixture has no goal document for ${runId}`);
    writeFileSync(join(stateRoot, 'run-ledger', `${runId}.jsonl`), [
      { timestamp: '2026-09-09T00:00:00Z', runId, goalId: '0123456789abcdef', event: 'start', data: { goalFile, targetRoot: repoRoot } },
      { timestamp: '2026-09-10T00:00:00Z', runId, goalId: '0123456789abcdef', event: 'run-status', data: { runStatus: status } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  };
  return { root, repoRoot, stateRoot, git, goal, block, ledger };
}

test('preview is write-free, only terminal last execution with matching ledger and tracked clean document qualifies', () => {
  const f = fixture();
  const finished = f.goal('finished', f.block('run-old', 'merged', 'completed') + f.block('run-new', 'merged', 'completed'));
  f.ledger('run-new', 'completed');
  f.goal('running', f.block('run-running', 'merged', 'completed')); f.ledger('run-running', 'running');
  f.goal('latest-running', f.block('run-earlier', 'merged', 'completed') + f.block('run-live', 'running', 'pending'));
  f.ledger('run-live', 'running');
  f.goal('missing', f.block('run-missing', 'merged', 'completed'));
  f.goal('untracked', f.block('run-untracked', 'merged', 'completed'), false); f.ledger('run-untracked', 'completed');
  f.goal('undocumented', '');
  f.goal('contradiction', f.block('run-contradiction', 'merged', 'completed')); f.ledger('run-contradiction', 'failed');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const result = archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, before: '2026-10-01' });
  expect(log).toHaveBeenCalledWith('harness.goal', 'archive', { candidates: 1, applied: 0, skipped: result.skipped });
  log.mockRestore();
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({ runId: 'run-new', outcome: 'merged', pr: 44 });
  expect(result.applied).toEqual([]);
  expect(result.filesForPr).toEqual(['docs/goals/GOAL-finished.md']);
  expect(result.skipped).toMatchObject({ untracked: 1, 'no-execution-record': 1, 'missing-ledger': 1, unfinished: 1, 'running-or-unconfirmed': 1, 'status-mismatch': 1 });
  expect(existsSync(join(f.stateRoot, 'goal-archive'))).toBe(false);
  expect(readFileSync(finished.path, 'utf8')).toBe(finished.body);
  expect(f.git('status', '--porcelain')).toBe('?? docs/goals/GOAL-untracked.md');
  expect(archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, before: '2026-09-10' }).candidates).toEqual([]);
  expect(() => archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, before: '2026-02-30' })).toThrow('valid YYYY-MM-DD');
});

test('Pod absolute paths and repository-relative suffixes corroborate runId and goalId, not the host root', () => {
  const f = fixture();
  f.goal('pod', f.block('run-pod', 'merged', 'completed'));
  f.ledger('run-pod', 'completed', '/var/pods/other-worktree/docs/goals/GOAL-pod.md');
  f.goal('suffix', f.block('run-suffix', 'merged', 'completed'));
  f.ledger('run-suffix', 'completed', 'docs/goals/GOAL-suffix.md');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const result = archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot });
  expect(result.candidates.map((entry) => [entry.runId, entry.source])).toEqual([['run-pod', 'ledger'], ['run-suffix', 'ledger']]);
  expect(result.skipped['ledger-goal-mismatch'] ?? 0).toBe(0);
  expect(f.git('status', '--porcelain')).toBe('');
});

test('a ledger file containing another runId cannot authorize a matching goal, even with document trust', () => {
  const f = fixture();
  const goal = f.goal('wrong-run', f.block('run-expected', 'merged', 'completed'));
  f.ledger('run-expected', 'completed');
  const ledgerPath = join(f.stateRoot, 'run-ledger', 'run-expected.jsonl');
  writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replaceAll('run-expected', 'run-foreign'));
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const result = archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, trustDocRecord: true, apply: true });
  expect(result.candidates).toEqual([]);
  expect(result.applied).toEqual([]);
  expect(result.skipped['ledger-run-id-mismatch']).toBe(1);
  expect(readFileSync(goal.path, 'utf8')).toBe(goal.body);
  expect(existsSync(join(f.stateRoot, 'goal-archive', 'index.jsonl'))).toBe(false);
  expect(f.git('status', '--porcelain')).toBe('');
});

test('missing ledger remains excluded by default, preview counts opt-in addition and opt-in indexes document provenance without repository writes', async () => {
  const f = fixture();
  const doc = f.goal('doc-only', f.block('run-doc-only', 'merged', 'merged'));
  const abandoned = f.goal('abandoned-doc', f.block('run-abandoned-doc', 'gate-failed', 'abandoned'));
  f.goal('no-record', '');
  f.goal('no-stage', '- runId: run-no-stage\n  outcome: abandoned\n  completedAt: 2026-09-10T00:00:00Z\n');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', goalArchive: { repoRoot: f.repoRoot, stateRoot: f.stateRoot } });
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: string) => { lines.push(line); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'goal', 'archive']);
    const preview = JSON.parse(lines.at(-1)!);
    expect(preview.candidates).toEqual([]);
    expect(preview.skipped).toMatchObject({ 'missing-ledger': 2, 'no-execution-record': 1, unfinished: 1 });
    expect(preview.trustDocRecordAdds).toBe(2);
    expect(existsSync(join(f.stateRoot, 'goal-archive'))).toBe(false);
    await program.parseAsync(['node', 'elanous', 'harness', 'goal', 'archive', '--trust-doc-record', '--apply']);
    const applied = JSON.parse(lines.at(-1)!);
    expect(applied.applied).toHaveLength(2);
    expect(applied.applied.map((entry: { runId: string; source: string; outcome: string }) => [entry.runId, entry.source, entry.outcome]))
      .toEqual([['run-abandoned-doc', 'doc-record', 'abandoned'], ['run-doc-only', 'doc-record', 'merged']]);
    expect(applied.skipped).toMatchObject({ 'no-execution-record': 1, unfinished: 1 });
    expect(readFileSync(join(f.stateRoot, 'goal-archive', 'index.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual(applied.applied);
    expect(readFileSync(doc.path, 'utf8')).toBe(doc.body);
    expect(readFileSync(abandoned.path, 'utf8')).toBe(abandoned.body);
    expect(f.git('status', '--porcelain')).toBe('');
  } finally { console.log = original; }
});

test('preview leaves even a stale Git index and state root byte-for-byte untouched', () => {
  const f = fixture();
  f.goal('stale', f.block('run-stale', 'merged', 'completed')); f.ledger('run-stale', 'completed');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const index = join(f.repoRoot, '.git', 'index');
  const before = readFileSync(index);
  utimesSync(index, new Date(1_000), new Date(1_000));
  const staleTime = statSync(index).mtimeMs;
  expect(archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot }).candidates).toHaveLength(1);
  expect(readFileSync(index).equals(before)).toBe(true);
  expect(statSync(index).mtimeMs).toBe(staleTime);
  expect(existsSync(join(f.repoRoot, '.git', 'index.lock'))).toBe(false);
  expect(readdirSync(f.stateRoot)).toEqual(['run-ledger']);
});

test('apply copies and indexes only eligible tracked goals and lists them for a human PR; the repository is untouched', () => {
  const f = fixture();
  const a = f.goal('abandoned', f.block('run-a', 'gate-failed', 'abandoned')); f.ledger('run-a', 'failed');
  const b = f.goal('superseded', f.block('run-b', 'pr-declined', 'superseded')); f.ledger('run-b', 'cancelled');
  const running = f.goal('running', f.block('run-c', 'merged', 'completed')); f.ledger('run-c', 'running');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const before = f.git('rev-parse', 'HEAD');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const result = archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, apply: true });
  expect(log).toHaveBeenCalledWith('harness.goal', 'archive', { candidates: 2, applied: 2, skipped: result.skipped });
  log.mockRestore();
  expect(result.applied).toHaveLength(2);
  expect(result.candidates).toHaveLength(2);
  expect(result.filesForPr).toEqual(['docs/goals/GOAL-abandoned.md', 'docs/goals/GOAL-superseded.md']);
  for (const entry of result.applied) expect(readFileSync(entry.archivePath, 'utf8')).toBe(entry.runId === 'run-a' ? a.body : b.body);
  const index = join(f.stateRoot, 'goal-archive', 'index.jsonl');
  expect(readFileSync(index, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual(result.applied);
  expect(readFileSync(a.path, 'utf8')).toBe(a.body); expect(readFileSync(b.path, 'utf8')).toBe(b.body);
  expect(readFileSync(running.path, 'utf8')).toBe(running.body);
  expect(readdirSync(join(f.stateRoot, 'goal-archive', '2026-09'))).toHaveLength(2);
  expect(f.git('status', '--porcelain')).toBe('');
  expect(f.git('rev-parse', 'HEAD')).toBe(before);
  const again = archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, apply: true });
  expect(again.applied).toEqual([]);
  expect(again.skipped['already-indexed']).toBe(2);
  expect(readFileSync(index, 'utf8').trim().split('\n')).toHaveLength(2);
});

test('running after an earlier terminal status, dirty tracked files and duplicate archive destinations are left intact', () => {
  const f = fixture();
  const resumed = f.goal('resumed', f.block('run-resumed', 'merged', 'completed'));
  f.ledger('run-resumed', 'completed');
  const ledgerPath = join(f.stateRoot, 'run-ledger', 'run-resumed.jsonl');
  writeFileSync(ledgerPath, `${readFileSync(ledgerPath, 'utf8')}${JSON.stringify({ runId: 'run-resumed', goalId: '0123456789abcdef', event: 'start', data: { goalFile: resumed.path, targetRoot: f.repoRoot } })}\n`);
  const dirty = f.goal('dirty', f.block('run-dirty', 'merged', 'completed')); f.ledger('run-dirty', 'completed');
  const duplicate = f.goal('duplicate', f.block('run-duplicate', 'merged', 'completed')); f.ledger('run-duplicate', 'completed');
  const relocated = f.goal('relocated', f.block('run-relocated', 'merged', 'completed')); f.ledger('run-relocated', 'completed');
  const active = f.goal('active', f.block('run-finished', 'merged', 'completed')); f.ledger('run-finished', 'completed');
  const activeRunId = 'run-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const activeLedger = join(f.stateRoot, 'run-ledger', `${activeRunId}.jsonl`);
  writeFileSync(activeLedger, `${JSON.stringify({ runId: activeRunId, goalId: '0123456789abcdef', timestamp: '2026-09-11T00:00:00Z', event: 'start', data: { goalFile: active.path, targetRoot: f.repoRoot } })}\n`);
  const relocatedLedger = join(f.stateRoot, 'run-ledger', 'run-relocated.jsonl');
  writeFileSync(relocatedLedger, readFileSync(relocatedLedger, 'utf8').replace(relocated.path, 'docs/goals/GOAL-someone-else.md'));
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  writeFileSync(dirty.path, `${dirty.body}local edit\n`);
  mkdirSync(join(f.stateRoot, 'goal-archive', '2026-09'), { recursive: true });
  writeFileSync(join(f.stateRoot, 'goal-archive', '2026-09', 'GOAL-duplicate.md'), 'prior content');
  const result = archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, apply: true });
  expect(result.candidates).toEqual([]);
  expect(result.skipped).toMatchObject({ 'running-or-unconfirmed': 1, dirty: 1, 'archive-collision': 1, 'ledger-goal-mismatch': 1, 'active-goal-run': 1 });
  expect(readFileSync(resumed.path, 'utf8')).toBe(resumed.body);
  expect(readFileSync(dirty.path, 'utf8')).toBe(`${dirty.body}local edit\n`);
  expect(readFileSync(duplicate.path, 'utf8')).toBe(duplicate.body);
  expect(readFileSync(relocated.path, 'utf8')).toBe(relocated.body);
  expect(readFileSync(active.path, 'utf8')).toBe(active.body);
  expect(existsSync(join(f.stateRoot, 'goal-archive', 'index.jsonl'))).toBe(false);
});

test('a terminal run requires its GoalId; a conflicting start path is rejected but an absent path is not identity', () => {
  const f = fixture();
  const names = ['valid-relative', 'different-id', 'missing-id', 'missing-file', 'different-file', 'missing-root', 'conflicting-id', 'conflicting-start', 'missing-document-id'];
  for (const name of names) {
    const runId = `run-${name}`;
    const goal = f.goal(name, f.block(runId, 'merged', 'completed'));
    f.ledger(runId, 'completed');
    const ledgerPath = join(f.stateRoot, 'run-ledger', `${runId}.jsonl`);
    const entries = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    if (name === 'valid-relative' || name === 'missing-root') {
      entries[0].data.goalFile = `docs/goals/GOAL-${name}.md`;
    }
    if (name === 'different-id') entries.forEach((entry) => { entry.goalId = 'fedcba9876543210'; });
    if (name === 'missing-id') entries.forEach((entry) => { delete entry.goalId; });
    if (name === 'missing-file') delete entries[0].data.goalFile;
    if (name === 'different-file') entries[0].data.goalFile = 'docs/goals/GOAL-someone-else.md';
    if (name === 'missing-root') delete entries[0].data.targetRoot;
    if (name === 'conflicting-id') entries[1].goalId = 'fedcba9876543210';
    if (name === 'conflicting-start') entries.push({ ...entries[0], data: { goalFile: 'docs/goals/GOAL-someone-else.md', targetRoot: f.repoRoot } });
    if (name === 'missing-document-id') writeFileSync(goal.path, goal.body.replace('- GoalId: 0123456789abcdef\n', ''));
    writeFileSync(ledgerPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  }
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const result = archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, apply: true });
  expect(result.applied.map((entry) => entry.originalPath)).toEqual([
    'docs/goals/GOAL-missing-file.md', 'docs/goals/GOAL-missing-root.md', 'docs/goals/GOAL-valid-relative.md',
  ]);
  expect(result.skipped).toMatchObject({ 'ledger-goal-id-mismatch': 3, 'ledger-goal-mismatch': 2, 'missing-goal-id': 1 });
  expect(f.git('diff', '--cached', '--name-only')).toBe('');
  for (const name of names) {
    expect(existsSync(join(f.repoRoot, 'docs', 'goals', `GOAL-${name}.md`))).toBe(true);
  }
});

test('copy and index failures roll back and permit retry', () => {
  for (const stage of ['copy', 'index'] as const) {
    const f = fixture();
    const goal = f.goal(stage, f.block(`run-${stage}`, 'merged', 'completed'));
    f.ledger(`run-${stage}`, 'completed');
    f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
    const archive = join(f.stateRoot, 'goal-archive');
    const index = join(archive, 'index.jsonl');
    mkdirSync(archive, { recursive: true });
    const previous = `${JSON.stringify({ originalPath: 'docs/goals/old.md' })}\n`;
    writeFileSync(index, previous);
    const writes = stage === 'copy' ? { copy: (source: string, destination: string) => {
      copyFileSync(source, destination); throw new Error('injected copy failure');
    } } : { appendIndex: (path: string, line: string) => {
      writeFileSync(path, previous + line.slice(0, 5)); throw new Error('injected index failure');
    } };
    expect(() => archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, apply: true, writes })).toThrow(`injected ${stage} failure`);
    expect(readFileSync(goal.path, 'utf8')).toBe(goal.body);
    expect(f.git('status', '--porcelain')).toBe('');
    expect(readFileSync(index, 'utf8')).toBe(previous);
    expect(existsSync(join(archive, '2026-09', `GOAL-${stage}.md`))).toBe(false);
    expect(archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, apply: true }).applied).toHaveLength(1);
  }
});

test('concurrent apply is refused during a copy failure; the retry owns its archive and index', () => {
  const f = fixture();
  const goal = f.goal('contended', f.block('run-contended', 'merged', 'completed'));
  f.ledger('run-contended', 'completed');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const options = { repoRoot: f.repoRoot, stateRoot: f.stateRoot, apply: true };
  const archive = join(f.stateRoot, 'goal-archive');
  expect(() => archiveGoals({ ...options, writes: { copy: (source, destination) => {
    expect(() => archiveGoals(options)).toThrow('EEXIST');
    copyFileSync(source, destination);
    throw new Error('injected copy failure');
  } } })).toThrow('injected copy failure');
  expect(existsSync(goal.path)).toBe(true);
  expect(existsSync(join(archive, 'index.jsonl'))).toBe(false);
  expect(existsSync(join(archive, '2026-09', 'GOAL-contended.md'))).toBe(false);
  expect(existsSync(join(archive, '.apply.lock'))).toBe(false);
  const result = archiveGoals(options);
  expect(result.applied).toHaveLength(1);
  expect(readFileSync(result.applied[0]!.archivePath, 'utf8')).toBe(goal.body);
  expect(readFileSync(join(archive, 'index.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual(result.applied);
  expect(f.git('status', '--porcelain')).toBe('');
  expect(readFileSync(goal.path, 'utf8')).toBe(goal.body);
});

test('an apply refused by another invocation lock preserves its archive, index and source', () => {
  const f = fixture();
  const goal = f.goal('locked', f.block('run-locked', 'merged', 'completed'));
  f.ledger('run-locked', 'completed');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const archive = join(f.stateRoot, 'goal-archive');
  const destination = join(archive, '2026-09', 'GOAL-locked.md');
  const index = join(archive, 'index.jsonl');
  mkdirSync(join(archive, '.apply.lock'), { recursive: true });
  mkdirSync(join(archive, '2026-09'));
  writeFileSync(destination, goal.body);
  writeFileSync(index, 'another invocation\n');
  expect(() => archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, apply: true })).toThrow('EEXIST');
  expect(() => archiveGoals({ repoRoot: f.repoRoot, stateRoot: f.stateRoot, apply: true })).toThrow(/previous run stopped mid-way[\s\S]*remove .*\.apply\.lock and retry/);
  expect(readFileSync(destination, 'utf8')).toBe(goal.body);
  expect(readFileSync(index, 'utf8')).toBe('another invocation\n');
  expect(readFileSync(goal.path, 'utf8')).toBe(goal.body);
  expect(f.git('status', '--porcelain')).toBe('');
});

test('CLI archive route previews with no write and --apply archives in a fake repo', async () => {
  const f = fixture();
  const goal = f.goal('cli', f.block('run-cli', 'merged', 'completed')); f.ledger('run-cli', 'completed');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', goalArchive: { repoRoot: f.repoRoot, stateRoot: f.stateRoot } });
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: string) => { lines.push(line); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'goal', 'archive', '--before', '2026-10-01']);
    expect(JSON.parse(lines.at(-1)!).candidates).toHaveLength(1);
    expect(existsSync(goal.path)).toBe(true);
    await program.parseAsync(['node', 'elanous', 'harness', 'goal', 'archive', '--apply']);
    const applied = JSON.parse(lines.at(-1)!);
    expect(applied.applied).toHaveLength(1);
    expect(applied.filesForPr).toEqual(['docs/goals/GOAL-cli.md']);
    expect(readFileSync(goal.path, 'utf8')).toBe(goal.body);
    expect(f.git('status', '--porcelain')).toBe('');
  } finally { console.log = original; }
});
