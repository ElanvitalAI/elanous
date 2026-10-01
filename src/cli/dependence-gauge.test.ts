import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import {
  attributeDependence, dependenceWindow, formatDependenceReport, measureDependence, readChangeCommits, readRunExecutions, readSeatRegistry, registerDependenceCommand,
  type DependenceGaugeDeps,
} from './dependence-gauge.js';

const now = () => new Date('2026-10-01T00:00:00.000Z');
/** git's `%cI` spells UTC as `+00:00` on older git and `Z` on newer git (2.54) — compare the instant. */
const asInstants = (rows: readonly { at?: string; runtime?: string }[]) =>
  rows.map(row => ({ ...row, at: row.at === undefined ? undefined : new Date(row.at).toISOString() }));
const positions = () => ({ observations: [
  { track: 'OP', runtime: 'claude-code' }, { track: 'MK', runtime: 'elanous' },
  { track: 'TC' }, { track: 'UX', runtime: 'claude-code' },
] });
const deps: DependenceGaugeDeps = {
  now, readPositions: positions,
  readExecutions: () => ({ observations: [
    { at: '2026-09-30T12:00:00Z', track: 'OP' },
    { at: '2026-09-30T12:00:00Z', track: 'OP', runtime: 'elanous', agent: 'claude-code' },
    { at: '2026-09-30T12:00:00Z', track: 'MK', agent: 'claude-code' },
    { at: '2026-09-30T12:00:00Z', track: 'TC' },
    { at: '2026-09-30T12:00:00Z', runtime: 'codex' },
    { at: '2026-09-23T00:00:00Z', runtime: 'elanous' },
    { at: '2026-10-02T00:00:00Z', runtime: 'elanous' },
  ] }),
  readChanges: () => ({ observations: [
    { at: '2026-09-30T23:59:59.999Z', runtime: 'claude-code' },
    { at: '2026-09-24T00:00:00Z', agent: 'elanous' },
    { at: '2026-09-30T00:00:00Z' },
  ] }),
  readDecisions: () => ({ observations: [], unmeasurable: 'decision actor cannot be identified' }),
};

describe('read-only dependence gauge', () => {
  test('explicit runtime > agent > position; absent evidence remains unknown', () => {
    const seat = new Map([['OP', 'claude-code' as const]]);
    expect(attributeDependence({ track: 'OP', runtime: 'elanous', agent: 'codex' }, seat)).toBe('elanous');
    expect(attributeDependence({ track: 'OP', actor: 'claude-code', runtime: 'elanous' }, seat)).toBe('claude-code');
    expect(attributeDependence({ track: 'OP', agent: 'codex' }, seat)).toBe('other');
    expect(attributeDependence({ track: 'OP' }, seat)).toBe('claude-code');
    expect(attributeDependence({ track: 'missing' }, seat)).toBe('unknown');
    expect(attributeDependence({ track: 'OP', runtime: 'unknown' }, seat)).toBe('unknown');
  });

  test('all four axes have coverage, and decisions are visibly unmeasurable rather than zero dependence', () => {
    const report = measureDependence(deps);
    expect(report.axes.positions).toMatchObject({ status: 'measured', total: 4, covered: 3, claudeCode: 2, elanous: 1, other: 0, unknown: 1 });
    expect(report.axes.executions).toMatchObject({ status: 'measured', total: 5, covered: 4, claudeCode: 2, elanous: 1, other: 1, unknown: 1 });
    expect(report.axes.changes).toMatchObject({ status: 'measured', total: 3, covered: 2, claudeCode: 1, elanous: 1, unknown: 1 });
    expect(report.axes.decisions).toMatchObject({ status: 'unmeasurable', total: 0, covered: 0, reason: 'decision actor cannot be identified' });
    for (const row of Object.values(report.axes)) expect(row.covered + row.unknown).toBe(row.total);
  });

  test('undated and invalid-date records are visible but excluded from every window denominator', () => {
    const withUndated: DependenceGaugeDeps = { ...deps, readExecutions: () => ({ observations: [
      { at: '2026-09-30T12:00:00Z', runtime: 'elanous' },
      { runtime: 'claude-code' }, { at: '2026-02-30T12:00:00Z', runtime: 'claude-code' },
      { at: '2026-09-23T00:00:00Z', runtime: 'claude-code' },
    ] }), readChanges: () => ({ observations: [
      { at: '2026-09-30T12:00:00Z', runtime: 'elanous' }, { runtime: 'claude-code' }, { at: 'invalid', runtime: 'claude-code' },
    ] }) };
    for (const since of ['2026-09-30', '2026-09-29']) {
      const report = measureDependence(withUndated, { since, until: '2026-09-30' });
      for (const axis of ['executions', 'changes'] as const) {
        expect(report.axes[axis]).toMatchObject({ total: 1, covered: 1, elanous: 1, claudeCode: 0, unknown: 0, undated: 2 });
        expect(formatDependenceReport(report)).toContain(`${axis}: measured · coverage 1/1 · claude-code 0 · elanous 1 · other 0 · unknown 0 · undated 2`);
        expect(JSON.parse(JSON.stringify(report)).axes[axis].undated).toBe(2);
      }
    }
  });

  test('inclusive UTC date window and lookback anchored at until; invalid and reversed ranges fail', () => {
    expect(dependenceWindow('7d', '2026-09-30', now())).toEqual({ since: '2026-09-23T23:59:59.999Z', until: '2026-09-30T23:59:59.999Z' });
    expect(measureDependence(deps, { since: '2026-09-30', until: '2026-09-30' }).axes.executions.total).toBe(5);
    expect(() => dependenceWindow('2026-02-30', undefined, now())).toThrow('invalid --since');
    expect(() => dependenceWindow('2026-02-30T12:00:00Z', undefined, now())).toThrow('invalid --since');
    expect(() => dependenceWindow('7d', '2026-02-30T12:00:00Z', now())).toThrow('invalid --until');
    expect(() => dependenceWindow('2026-10-03', '2026-09-30', now())).toThrow('start must be at or before');
    expect(() => dependenceWindow('7d', 'nonsense', now())).toThrow('invalid --until');
  });

  test('human and JSON CLI output show each axis including unknown and unmeasurable', async () => {
    const report = measureDependence(deps);
    const human = formatDependenceReport(report);
    expect(human).toContain('positions: measured');
    expect(human).toContain('coverage 3/4');
    expect(human).toContain('unknown 1');
    expect(human).toContain('decisions: unmeasurable (decision actor cannot be identified)');
    const lines: string[] = [];
    const cmd = new Command();
    const self = cmd.command('self');
    registerDependenceCommand(self, { ...deps, out: { log: line => lines.push(line) } });
    await cmd.parseAsync(['node', 'elanous', 'self', 'dependence', '--since', '7d', '--until', '2026-09-30', '--json']);
    expect(lines).toHaveLength(1);
    const json = JSON.parse(lines[0]!);
    expect(json).toMatchObject({ since: '2026-09-23T23:59:59.999Z', until: '2026-09-30T23:59:59.999Z' });
    expect(Object.keys(json.axes)).toEqual(['positions', 'executions', 'changes', 'decisions']);
    expect(json.axes.decisions.status).toBe('unmeasurable');
    expect(json.axes.executions.unknown).toBe(1);
  });

  test('current seat registry contains the four roles, not the legacy unowned track', () => {
    const source = readSeatRegistry();
    expect(source.unmeasurable).toBeUndefined();
    expect(source.observations.map(row => row.track)).toEqual(['OP', 'MK', 'TC', 'UX']);
  });

  test('reads actual run-ledger records once per run and never mistakes provider for runtime', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dependence-ledgers-'));
    try {
      writeFileSync(join(directory, 'run-a.jsonl'), [
        { timestamp: '2026-09-30T12:00:00Z', runId: 'run-a', event: 'run-origin', data: { provider: 'anthropic', runtime: 'elanous' } },
        { timestamp: '2026-09-30T13:00:00Z', runId: 'run-a', event: 'ended', data: {} },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      writeFileSync(join(directory, 'run-b.jsonl'), JSON.stringify({ timestamp: '2026-09-30T14:00:00Z', event: 'run-origin', data: { provider: 'anthropic' } }) + '\n');
      writeFileSync(join(directory, 'run-c.jsonl'), JSON.stringify({ event: 'run-origin', data: { runtime: 'claude-code' } }) + '\n');
      const source = readRunExecutions(directory);
      expect(source.observations).toEqual([
        { at: '2026-09-30T12:00:00Z', runtime: 'elanous', agent: undefined, track: undefined },
        { at: '2026-09-30T14:00:00Z', runtime: undefined, agent: undefined, track: undefined },
        { at: undefined, runtime: 'claude-code', agent: undefined, track: undefined },
      ]);
      expect(measureDependence({ ...deps, readExecutions: () => source }).axes.executions).toMatchObject({ total: 2, covered: 1, unknown: 1, undated: 1 });
      expect(readFileSync(join(directory, 'run-a.jsonl'), 'utf8')).toContain('"event":"run-origin"');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('git filtering and observed time both use committer date when author and committer differ', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dependence-commit-dates-'));
    try {
      const git = (...args: string[]) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', env: {
          ...process.env, GIT_AUTHOR_NAME: 'Author', GIT_AUTHOR_EMAIL: 'author@example.test',
          GIT_COMMITTER_NAME: 'Committer', GIT_COMMITTER_EMAIL: 'committer@example.test',
          GIT_AUTHOR_DATE: '2020-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-30T12:00:00Z',
        } });
        if (result.status !== 0) throw new Error(result.stderr);
      };
      git('init', '-q');
      writeFileSync(join(directory, 'file'), 'change');
      git('add', 'file');
      git('commit', '-qm', 'Executed-By: elanous');
      // The reader walks main's landing line (`origin/main --first-parent`), as in the real repo.
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      const source = readChangeCommits({ since: '2026-09-30T00:00:00Z', until: '2026-09-30T23:59:59Z' }, directory);
      expect(asInstants(source.observations)).toEqual([{ at: '2026-09-30T12:00:00.000Z', runtime: 'elanous' }]);
      expect(measureDependence({ ...deps, readChanges: () => source }, { since: '2026-09-30', until: '2026-09-30' }).axes.changes)
        .toMatchObject({ total: 1, covered: 1, elanous: 1, undated: 0 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('date inversion does not hide an in-window ancestor behind an out-of-window commit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dependence-inverted-dates-'));
    try {
      const git = (args: string[], date: string) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', env: {
          ...process.env, GIT_AUTHOR_NAME: 'Author', GIT_AUTHOR_EMAIL: 'author@example.test',
          GIT_COMMITTER_NAME: 'Committer', GIT_COMMITTER_EMAIL: 'committer@example.test',
          GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
        } });
        if (result.status !== 0) throw new Error(result.stderr);
      };
      git(['init', '-q'], '2026-09-30T00:00:00Z');
      for (const [index, date, actor] of [
        ['1', '2026-09-30T10:00:00Z', 'elanous'],
        ['2', '2020-01-01T10:00:00Z', 'other'],
        ['3', '2026-09-30T11:00:00Z', 'claude-code'],
      ]) {
        writeFileSync(join(directory, 'file'), index);
        git(['add', 'file'], date);
        git(['commit', '-qm', `Executed-By: ${actor}`], date);
      }
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], '2026-09-30T00:00:00Z');
      const source = readChangeCommits({ since: '2026-09-30T00:00:00Z', until: '2026-09-30T23:59:59Z' }, directory);
      expect(asInstants(source.observations)).toEqual([
        { at: '2026-09-30T11:00:00.000Z', runtime: 'claude-code' },
        { at: '2026-09-30T10:00:00.000Z', runtime: 'elanous' },
      ]);
      expect(measureDependence({ ...deps, readChanges: () => source }, { since: '2026-09-30', until: '2026-09-30' }).axes.changes)
        .toMatchObject({ total: 2, covered: 2, claudeCode: 1, elanous: 1 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('reads commit trailers but does not attribute git author to an executor', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dependence-git-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Claude Code', GIT_AUTHOR_EMAIL: 'claude@example.test', GIT_COMMITTER_NAME: 'Claude Code', GIT_COMMITTER_EMAIL: 'claude@example.test', GIT_AUTHOR_DATE: '2026-09-30T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-30T12:00:00Z' } });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    try {
      git('init', '-q');
      writeFileSync(join(directory, 'file'), 'before');
      git('add', 'file');
      git('commit', '-qm', 'plain commit');
      writeFileSync(join(directory, 'file'), 'after');
      git('add', 'file');
      git('commit', '-qm', 'explicit actor\n\nExecuted-By: elanous');
      writeFileSync(join(directory, 'file'), 'final');
      git('add', 'file');
      git('commit', '-qm', 'spaced runtime\n\nRuntime: Claude Code');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      const source = readChangeCommits({ since: '2026-09-30T00:00:00Z', until: '2026-09-30T23:59:59Z' }, directory);
      expect(source.observations).toHaveLength(3);
      expect(source.observations.some(row => row.runtime === 'Claude Code')).toBe(true);
      expect(measureDependence({ ...deps, readChanges: () => source }).axes.changes).toMatchObject({ total: 3, covered: 2, elanous: 1, claudeCode: 1, other: 0, unknown: 1 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('absent run-ledger is unmeasurable with reason and no invented denominator', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dependence-missing-ledger-'));
    try {
      const report = measureDependence({ ...deps, readExecutions: () => readRunExecutions(join(directory, 'not-present')) });
      expect(report.axes.executions).toMatchObject({ status: 'unmeasurable', reason: 'run-ledger directory absent', total: 0, covered: 0 });
      expect(formatDependenceReport(report)).toContain('executions: unmeasurable (run-ledger directory absent)');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

test('changes are attributed from Co-Authored-By trailers (harness > codex > Claude), author is never used', async () => {
  const { runtimeFromCoAuthors } = await import('./dependence-gauge.js');
  expect(runtimeFromCoAuthors('x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')).toBe('claude-code');
  expect(runtimeFromCoAuthors('x\n\nCo-authored-by: elanous pod child <noreply@anthropic.com>\nCo-Authored-By: Claude Opus 5.5 <n@a>')).toBe('elanous');
  expect(runtimeFromCoAuthors('x\n\nCo-authored-by: Codex <codex@openai.com>')).toBe('codex');
  expect(runtimeFromCoAuthors('x\n\nSigned-off-by: someone')).toBeUndefined();
});
