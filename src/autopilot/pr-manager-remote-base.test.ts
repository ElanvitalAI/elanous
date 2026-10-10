import { describe, expect, it, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { makePrManager, resolveDeliverableBase, type CmdRunner } from './pr-manager.js';

const cwd = '/wt';
const local = 'bench/x';
const remote = 'origin/bench/x';

function fakeRunner(refs: readonly string[], commitIsEmpty = false): { run: CmdRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CmdRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[2] === 'rev-parse' && args[3] === '--verify') {
      return { ok: refs.includes(args[5] ?? ''), out: '' };
    }
    if (cmd === 'git' && args[2] === 'commit' && commitIsEmpty) {
      return { ok: false, out: 'nothing to commit, working tree clean' };
    }
    if (cmd === 'git' && args[2] === 'rev-list') {
      return args[4] === `${remote}..HEAD`
        ? { ok: true, out: '2' }
        : { ok: false, out: '', err: `fatal: ambiguous argument '${args[4]}': unknown revision` };
    }
    if (cmd === 'git' && args[2] === 'diff' && args[3] === '--name-only') {
      return args[4] === `${remote}..HEAD`
        ? { ok: true, out: 'src/x.ts' }
        : { ok: false, out: '', err: 'fatal: unknown revision' };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return { ok: true, out: 'https://github.com/o/r/pull/42' };
    }
    return { ok: true, out: '' };
  };
  return { run, calls };
}

describe('explicit PR base in a Pod clone', () => {
  it('resolves a remote-only base once and observes the substitution once', () => {
    const { run, calls } = fakeRunner([remote]);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(resolveDeliverableBase(run, cwd, `  ${local}  `)).toBe(remote);
      expect(calls).toEqual([
        ['git', '-C', cwd, 'rev-parse', '--verify', '--quiet', local],
        ['git', '-C', cwd, 'rev-parse', '--verify', '--quiet', remote],
      ]);
      expect(log.mock.calls.filter(([category, event]) => category === 'autopilot.pr-manager' && event === 'base-resolved-remote'))
        .toEqual([['autopilot.pr-manager', 'base-resolved-remote', { explicit: local, resolved: remote }]]);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps an existing local base without checking the remote or logging substitution', () => {
    const { run, calls } = fakeRunner([local, remote]);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(resolveDeliverableBase(run, cwd, local)).toBe(local);
      expect(calls).toEqual([['git', '-C', cwd, 'rev-parse', '--verify', '--quiet', local]]);
      expect(log.mock.calls.filter(([, event]) => event === 'base-resolved-remote')).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps an already origin/-prefixed ref without checking or logging substitution', () => {
    const { run, calls } = fakeRunner([remote]);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(resolveDeliverableBase(run, cwd, remote)).toBe(remote);
      expect(calls).toEqual([]);
      expect(log.mock.calls.filter(([, event]) => event === 'base-resolved-remote')).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps an absent explicit base and the existing reason=base error detail', () => {
    const { run, calls } = fakeRunner([], true);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(resolveDeliverableBase(run, cwd, local)).toBe(local);
      expect(calls.slice(0, 2)).toEqual([
        ['git', '-C', cwd, 'rev-parse', '--verify', '--quiet', local],
        ['git', '-C', cwd, 'rev-parse', '--verify', '--quiet', remote],
      ]);
      expect(makePrManager(run).upsertPr({
        branch: 'feature/pr', worktreePath: cwd, title: 'Title', body: 'Body', commitMessage: 'Message', base: local,
      })).toEqual({
        ok: false, reason: 'base',
        detail: `base 비교 실패(rev-list ${local}..HEAD): fatal: ambiguous argument '${local}..HEAD': unknown revision`,
      });
      expect(calls).toContainEqual(['git', '-C', cwd, 'rev-list', '--count', `${local}..HEAD`]);
      expect(calls.some((call) => call.includes('push'))).toBe(false);
      expect(log.mock.calls.filter(([, event]) => event === 'base-resolved-remote')).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it('opens a PR with origin/bench/x for both git comparisons but bench/x for gh', () => {
    const { run, calls } = fakeRunner([remote], true);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(makePrManager(run).upsertPr({
        branch: 'feature/pr', worktreePath: cwd, title: 'Title', body: 'Body', commitMessage: 'Message', base: local,
      })).toEqual({ ok: true, url: 'https://github.com/o/r/pull/42', reused: false });
      expect(calls).toContainEqual(['git', '-C', cwd, 'rev-list', '--count', `${remote}..HEAD`]);
      expect(calls).toContainEqual(['git', '-C', cwd, 'diff', '--name-only', `${remote}..HEAD`]);
      expect(calls).toContainEqual(['git', '-C', cwd, 'push', '--force', '-u', 'origin', 'feature/pr']);
      expect(calls).toContainEqual(['gh', 'pr', 'create', '--head', 'feature/pr', '--title', 'Title', '--body', 'Body', '--base', local]);
      expect(log.mock.calls.filter(([category, event]) => category === 'autopilot.pr-manager' && event === 'base-resolved-remote'))
        .toEqual([['autopilot.pr-manager', 'base-resolved-remote', { explicit: local, resolved: remote }]]);
    } finally {
      log.mockRestore();
    }
  });
});
