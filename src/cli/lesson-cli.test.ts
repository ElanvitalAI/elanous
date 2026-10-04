import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { registerLessonCommands } from './lesson-cli.js';
import { LessonLedger } from '../lessons/lesson-ledger.js';

const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'lesson-cli-')));

test('Commander add/recur/candidates --json round-trip, find/show and actor identity', () => {
  const stateDir = root();
  const lines: string[] = [];
  const program = new Command();
  registerLessonCommands(program, { stateDir, now: () => new Date('2026-10-04T00:00:00Z') }, { log: line => lines.push(line) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['lesson', ...args], { from: 'user' }); return lines[0]!; };
  const before = process.env.AI_AGENT;
  const exitCode = process.exitCode;
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    delete process.env.AI_AGENT;
    const add = ['add', 'L1', '--incident', 'worktree collision', '--cause', 'shared state', '--remedy', 'use isolation', '--owner', 'TC', '--source', 'PR#1'];
    expect(run(...add)).toBeUndefined();
    expect(stderr).toHaveBeenLastCalledWith('lesson add: --by or AI_AGENT is required\n');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(run(...add, '--by', 'UX')).toContain('L1 · open · 1회');
    process.env.AI_AGENT = 'TC';
    expect(run('recur', 'L1', '--source', 'PR#2', '--note', 'again')).toContain('L1 · candidate · 2회');
    expect(JSON.parse(run('candidates', '--json'))).toMatchObject([{ id: 'L1', status: 'candidate', occurrence_count: 2 }]);
    expect(JSON.parse(run('find', 'WORKTREE', '--json'))).toMatchObject([{ id: 'L1', occurrence_count: 2 }]);
    expect(JSON.parse(run('show', 'L1', '--json'))).toMatchObject({ occurrences: [{ source: 'PR#1' }, { source: 'PR#2', note: 'again' }],
      history: [{ by: 'UX', event: 'add' }, { by: 'TC', event: 'recur' }] });
    expect(run('promote', 'L1', '--rule', '.rules/20-repo/rule.md')).toBeUndefined();
    expect(stderr).toHaveBeenLastCalledWith('lesson promote: disproof is required to promote a lesson\n');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(run('enforce', 'L1', '--enforced-by', 'src/cli/lesson-cli.test.ts')).toContain('L1 · enforced');
    expect(new LessonLedger({ stateDir }).get('L1').status).toBe('enforced');
    expect(JSON.parse(run('candidates', '--json'))).toEqual([]);
  } finally {
    stderr.mockRestore();
    process.exitCode = exitCode;
    if (before === undefined) delete process.env.AI_AGENT; else process.env.AI_AGENT = before;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('import --json previews an isolated repository without writing; --apply uses actor and stays idempotent', () => {
  const repo = root();
  const stateDir = root();
  const lines: string[] = [];
  const program = new Command();
  registerLessonCommands(program, { stateDir }, { log: line => lines.push(line) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['lesson', ...args], { from: 'user' }); return lines[0]; };
  const beforeCwd = process.cwd();
  const beforeActor = process.env.AI_AGENT;
  const exitCode = process.exitCode;
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'INCIDENT-sample-2026-10-04.md'), '# INCIDENT — 사고\n\n## 원인\n공유 상태.\n\n## 교훈\n격리한다.\n');
    writeFileSync(join(repo, 'docs', 'FINDING-empty-2026-10-04.md'), '# FINDING — 빈 문서\n');
    writeFileSync(join(repo, 'docs', 'FINDING-cause-only-2026-10-04.md'), '# FINDING — 원인만\n\n## 원인\n우연.\n');
    process.chdir(repo);
    delete process.env.AI_AGENT;
    expect(run('import', '--json')).toBeUndefined();
    expect(stderr).toHaveBeenLastCalledWith('lesson import: --by or AI_AGENT is required\n');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const preview = JSON.parse(run('import', '--json', '--by', 'TC')!);
    expect(preview).toMatchObject({ files: 3, items: [{ cause: '우연.', remedy: '' },
      { cause: '공유 상태.', remedy: '격리한다.' }],
      skipped: [{ reason: 'missing cause and remedy' }], emptyCause: 0, emptyRemedy: 1, written: 0 });
    const sampleId = preview.items[1].id;
    expect(sampleId).toStartWith('sample-2026-10-04-');
    expect(() => new LessonLedger({ stateDir }).get(sampleId)).toThrow('lesson not found');
    expect(run('import', '--apply', '--json')).toBeUndefined();
    expect(stderr).toHaveBeenLastCalledWith('lesson import: --by or AI_AGENT is required\n');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    process.env.AI_AGENT = 'TC';
    expect(JSON.parse(run('import', '--apply', '--json')!).written).toBe(2);
    expect(JSON.parse(run('import', '--apply', '--json')!)).toMatchObject({ items: [], written: 0 });
    expect(new LessonLedger({ stateDir }).get(sampleId)).toMatchObject({ owner: 'TC', occurrence_count: 1, history: [{ by: 'TC', event: 'add' }] });
  } finally {
    stderr.mockRestore();
    process.exitCode = exitCode;
    process.chdir(beforeCwd);
    if (beforeActor === undefined) delete process.env.AI_AGENT; else process.env.AI_AGENT = beforeActor;
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('page renders an isolated ledger in-process, emits the returned JSON, and skips an empty ledger', async () => {
  const stateDir = root();
  const emptyStateDir = root();
  const out = join(stateDir, 'handbook.md');
  const lines: string[] = [];
  const program = new Command();
  registerLessonCommands(program, { stateDir }, { log: line => lines.push(line) });
  const emptyProgram = new Command();
  registerLessonCommands(emptyProgram, { stateDir: emptyStateDir }, { log: line => lines.push(line) });
  const ledger = new LessonLedger({ stateDir, now: () => new Date('2026-10-05T00:00:00Z') });
  try {
    for (const [id, enforcedBy] of [['open', undefined], ['enforced', '.rules/check.md']] as const) {
      ledger.add({ id, incident: `사고 ${id}`, cause: '공유 상태', remedy: '격리한다', owner: 'TC', source: `PR#${id}`,
        ...(enforcedBy ? { enforcedBy } : {}) });
    }
    await program.parseAsync(['lesson', 'page', '--out', out], { from: 'user' });
    expect(lines).toEqual([`교훈 페이지: ${out} · 총 2 · 강제 자리 없음 1`]);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf8')).toContain('총 2 · candidate 0 · open 1 · enforced 1 · promoted 0 · 강제 자리 없음 1');
    lines.length = 0;
    await program.parseAsync(['lesson', 'page', '--out', out, '--json'], { from: 'user' });
    expect(JSON.parse(lines[0]!)).toEqual({ total: 2,
      byStatus: { candidate: 0, open: 1, enforced: 1, promoted: 0 }, unenforced: 1, out });
    lines.length = 0;
    await emptyProgram.parseAsync(['lesson', 'page', '--out', join(emptyStateDir, 'empty.md')], { from: 'user' });
    expect(lines).toEqual(['교훈 페이지: 건너뜀(원장 비어 있음)']);
    expect(existsSync(join(emptyStateDir, 'empty.md'))).toBe(false);
    lines.length = 0;
    await emptyProgram.parseAsync(['lesson', 'page', '--json'], { from: 'user' });
    expect(lines).toEqual(['{"skipped":"empty-ledger"}']);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(emptyStateDir, { recursive: true, force: true });
  }
});

test('real CLI lesson page renders from the isolated state directory and reports unreadable ledgers', () => {
  const isolation = root();
  const stateDir = join(isolation, 'state');
  const out = join(isolation, 'handbook.md');
  mkdirSync(stateDir);
  const run = (dir: string, ...args: string[]) => spawnSync('bun',
    ['bin/elanous.mjs', '--test', '--config-dir', dir, 'lesson', 'page', ...args], {
      cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, ELANOUS_STATE_DIR: dir, ELANOUS_CONFIG_DIR: dir, ELANOUS_SUPPRESS_XDG_WARNING: '1' },
    });
  try {
    const ledger = new LessonLedger({ stateDir });
    ledger.add({ id: 'one', incident: 'incident', cause: 'cause', remedy: 'remedy', owner: 'TC', source: 'PR#1' });
    ledger.add({ id: 'two', incident: 'incident', cause: 'cause', remedy: 'remedy', owner: 'TC', source: 'PR#2', enforcedBy: '.rules/check.md' });
    const result = run(stateDir, '--out', out);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`교훈 페이지: ${out} · 총 2 · 강제 자리 없음 1\n`);
    expect(existsSync(out)).toBe(true);
    const blocked = join(isolation, 'blocked-state');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'lessons'), 'occupied');
    const failed = run(blocked, '--out', join(isolation, 'unused.md'));
    expect(failed.error).toBeUndefined();
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toMatch(/^lesson page: [^\n]+\n$/);
    expect(failed.stderr).toContain('lessons');
  } finally { rmSync(isolation, { recursive: true, force: true }); }
}, 180_000);

test('real CLI invalid lesson input prints one line without source excerpts or ops reports', () => {
  const isolation = root();
  const stateDir = join(isolation, 'state');
  const configDir = join(isolation, 'config');
  mkdirSync(stateDir);
  mkdirSync(configDir);
  const run = (...args: string[]) => spawnSync('bun', ['bin/elanous.mjs', '--test', '--config-dir', configDir, 'lesson', ...args], {
    cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ELANOUS_STATE_DIR: stateDir, ELANOUS_CONFIG_DIR: stateDir, ELANOUS_SUPPRESS_XDG_WARNING: '1' },
  });
  try {
    for (const [args, expected] of [
      [['find', ''], 'lesson find: query is required\n'],
      [['show', 'NOPE'], 'lesson show: lesson not found: NOPE\n'],
      [['show', 'NOPE\nSECOND'], 'lesson show: lesson not found: NOPE\\nSECOND\n'],
    ] as const) {
      const result = run(...args);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toBe(expected);
      expect(result.stdout).toBe('');
      expect(result.stdout).not.toContain('function required');
      expect(result.stderr).not.toContain('function required');
      expect(result.stdout).not.toContain('보고 번호');
      expect(result.stderr).not.toContain('보고 번호');
    }
  } finally { rmSync(isolation, { recursive: true, force: true }); }
}, 180_000);

test('unexpected ledger storage errors still propagate beyond the lesson action', () => {
  const isolation = root();
  const file = join(isolation, 'not-a-directory');
  writeFileSync(file, 'occupied');
  const program = new Command();
  registerLessonCommands(program, { stateDir: file });
  const exitCode = process.exitCode;
  try {
    expect(() => program.parse(['lesson', 'find', 'query'], { from: 'user' })).toThrow();
    expect(process.exitCode).toBe(exitCode);
  } finally { rmSync(isolation, { recursive: true, force: true }); }
});

test('real private command registration routes lesson under an isolated CLI instance', () => {
  const stateDir = root();
  const run = (...args: string[]) => spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'lesson', ...args], {
    cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8', timeout: 60_000,
  });
  try {
    const help = run('--help');
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('candidates');
    expect(help.stdout).toContain('import');
    const add = run('add', 'L2', '--incident', 'collision', '--cause', 'shared worktree', '--remedy', 'use isolation', '--owner', 'TC', '--source', 'PR#1', '--by', 'TC', '--disproof', 'bun test src/cli/lesson-cli.test.ts');
    expect(add.status, add.stderr).toBe(0);
    const recur = run('recur', 'L2', '--source', 'PR#2', '--by', 'TC');
    expect(recur.status, recur.stderr).toBe(0);
    const candidates = run('candidates', '--json');
    expect(candidates.status, candidates.stderr).toBe(0);
    expect(JSON.parse(candidates.stdout)).toMatchObject([{ id: 'L2', status: 'candidate', occurrence_count: 2 }]);
    const show = run('show', 'L2', '--json');
    expect(show.status, show.stderr).toBe(0);
    expect(JSON.parse(show.stdout).occurrences).toMatchObject([{ source: 'PR#1' }, { source: 'PR#2' }]);
    const promoted = run('promote', 'L2', '--rule', '.rules/20-repo/rule.md', '--by', 'TC');
    expect(promoted.status, promoted.stderr).toBe(0);
    expect(JSON.parse(run('show', 'L2', '--json').stdout).status).toBe('promoted');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
}, 180_000);
