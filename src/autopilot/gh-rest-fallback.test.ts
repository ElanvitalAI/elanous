import { describe, expect, it, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { makePrManager, type CmdResult, type CmdRunner } from './pr-manager.js';
import { withGhRestFallback } from './gh-rest-fallback.js';

const limit = { ok: false, out: '', err: 'GraphQL: API rate limit already exceeded for user ID 19355785.' };
const url = 'https://github.com/o/r/pull/17';
const sha = 'a'.repeat(40);

function fake(failure: CmdResult = limit) {
  const calls: string[][] = [];
  const options: Array<{ cwd?: string } | undefined> = [];
  const run: CmdRunner = (cmd, args, opts) => {
    const call = [cmd, ...args];
    calls.push(call);
    options.push(opts);
    if (cmd === 'git' && args[0] === 'remote') return { ok: true, out: 'git@github.com:o/r.git' };
    if (cmd === 'gh' && args[0] === 'pr') return failure;
    if (cmd === 'gh' && args[0] === 'api') {
      const path = args.find((a) => a.startsWith('repos/')) ?? '';
      if (path.includes('/pulls?')) return { ok: true, out: '[]' };
      if (path === 'repos/o/r') return { ok: true, out: JSON.stringify({ default_branch: 'main' }) };
      if (path.endsWith('/pulls') && args.includes('POST')) return { ok: true, out: JSON.stringify({ html_url: url }) };
      if (path.endsWith('/merge')) return { ok: true, out: JSON.stringify({ merged: true }) };
      if (path.includes('/issues/') && args.includes('POST')) return { ok: true, out: JSON.stringify({ id: 42 }) };
      if (args.includes('PATCH')) return { ok: true, out: JSON.stringify({ html_url: url }) };
      if (args.includes('DELETE')) return { ok: true, out: '' };
      return { ok: true, out: JSON.stringify({
        state: 'open', draft: false, merged_at: null, mergeable: null, mergeable_state: 'clean',
        base: { ref: 'main' }, head: { sha, ref: 'feature/x', repo: { full_name: 'o/r' } },
      }) };
    }
    return { ok: true, out: '' };
  };
  return { run, calls, options };
}

describe('GraphQL secondary-limit REST fallback', () => {
  it('manager lookup → new PR → squash merge keeps the original outcome contracts and pins head sha', () => {
    const { run, calls, options } = fake();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const manager = makePrManager(run);
      expect(manager.findPrForBranchOutcome('feature/x', '/wt')).toEqual({ status: 'ok EMPTY', url: null });
      expect(manager.upsertPr({ branch: 'feature/x', worktreePath: '/wt', base: 'main', title: 'title', body: 'body', commitMessage: 'commit' }))
        .toEqual({ ok: true, url, reused: false });
      expect(manager.mergePrOutcome(url)).toEqual({ ok: true, kind: 'merge-exit-0' });
      expect(calls).toContainEqual(['gh', 'api', 'repos/o/r/pulls?head=o%3Afeature%2Fx&state=open']);
      expect(calls).toContainEqual(['gh', 'api', '--method', 'POST', 'repos/o/r/pulls', '-f', 'head=feature/x', '-f', 'title=title', '-f', 'body=body', '-f', 'base=main']);
      expect(calls).toContainEqual(['gh', 'api', '--method', 'PUT', 'repos/o/r/pulls/17/merge', '-f', 'merge_method=squash', '-f', `sha=${sha}`]);
      expect(calls.some((call) => call[0] === 'gh' && call[1] === 'repo')).toBe(false);
      expect(calls.filter((call) => call[0] === 'gh' && call[1] === 'api').every((call) => !call.includes('graphql'))).toBe(true);
      expect(options[calls.findIndex((call) => call[0] === 'gh' && call[1] === 'api' && call[2]?.startsWith('repos/o/r/pulls?'))]).toEqual({ cwd: '/wt' });
      expect(log).toHaveBeenCalledWith('autopilot.pr', 'rest-fallback', { sub: 'merge', ok: true });
      expect(stderr).toHaveBeenCalledWith('[gh] REST 폴백: pr merge\n');
    } finally { stderr.mockRestore(); log.mockRestore(); }
  });

  it('view field mappings and jq shapes, edit and comment retain gh pr outputs', () => {
    const { run, calls } = fake();
    const wrapped = withGhRestFallback(run);
    expect(wrapped('gh', ['pr', 'view', url, '--json', 'state,isDraft,mergeable,baseRefName,mergeStateStatus,headRefName,headRepository']))
      .toEqual({ ok: true, out: JSON.stringify({ state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN', baseRefName: 'main', mergeStateStatus: 'CLEAN', headRefName: 'feature/x', headRepository: { nameWithOwner: 'o/r' } }) });
    expect(wrapped('gh', ['pr', 'view', '17', '--json', 'isDraft', '-q', '.isDraft'])).toEqual({ ok: true, out: 'false' });
    expect(wrapped('gh', ['pr', 'view', '17', '--json', 'headRepository', '-q', '.headRepository']))
      .toEqual({ ok: true, out: '{"nameWithOwner":"o/r"}' });
    expect(wrapped('gh', ['pr', 'list', '--head', 'feature/x', '--state', 'open', '--json', 'url'])).toEqual({ ok: true, out: '[]' });
    expect(wrapped('gh', ['pr', 'edit', url, '--title', 'new title', '--body', 'new body', '--base', 'release/1']))
      .toEqual({ ok: true, out: '' });
    expect(calls).toContainEqual(['gh', 'api', '--method', 'PATCH', 'repos/o/r/pulls/17', '-f', 'title=new title', '-f', 'body=new body', '-f', 'base=release/1']);
    expect(wrapped('gh', ['pr', 'create', '--head', 'feature/x', '--title', 't', '--body', 'b', '--draft']))
      .toEqual({ ok: true, out: url });
    expect(calls).toContainEqual(['gh', 'api', 'repos/o/r']);
    expect(calls).toContainEqual(['gh', 'api', '--method', 'POST', 'repos/o/r/pulls', '-f', 'head=feature/x', '-f', 'title=t', '-f', 'body=b', '-f', 'base=main', '-F', 'draft=true']);
    expect(wrapped('gh', ['pr', 'comment', '17', '--body', 'message'])).toEqual({ ok: true, out: '' });
    expect(calls).toContainEqual(['gh', 'api', '--method', 'POST', 'repos/o/r/issues/17/comments', '-f', 'body=message']);
  });

  it('missing REST fields and malformed REST responses fail closed without fabricating an output', () => {
    const { run, calls } = fake();
    const missing: CmdRunner = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === 'api' && args.includes('repos/o/r/pulls/17')) return { ok: true, out: '{"state":"open"}' };
      return run(cmd, args, opts);
    };
    expect(withGhRestFallback(missing)('gh', ['pr', 'view', '17', '--json', 'isDraft'])).toBe(limit);
    const malformed: CmdRunner = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === 'api' && args[1]?.startsWith('repos/o/r/pulls?')) return { ok: true, out: '{' };
      return run(cmd, args, opts);
    };
    expect(withGhRestFallback(malformed)('gh', ['pr', 'list', '--head', 'x', '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""'])).toBe(limit);
    expect(calls.some((call) => call[0] === 'gh' && call[1] === 'api' && call.includes('POST'))).toBe(false);
  });

  it('plain pr list without --json preserves its original failure and does not call REST', () => {
    const { run, calls } = fake();
    const original = withGhRestFallback(run)('gh', ['pr', 'list', '--head', 'feature/x', '--state', 'open']);
    expect(original).toBe(limit);
    expect(calls).toEqual([['gh', 'pr', 'list', '--head', 'feature/x', '--state', 'open']]);
  });

  it('unsupported fields/ready/labels and non-limit failures preserve the original result', () => {
    const f = fake();
    const wrapped = withGhRestFallback(f.run);
    expect(wrapped('gh', ['pr', 'ready', '17'])).toBe(limit);
    expect(wrapped('gh', ['pr', 'view', '17', '--json', 'reviewDecision'])).toBe(limit);
    expect(wrapped('gh', ['pr', 'create', '--head', 'x', '--title', 't', '--body', 'b', '--label', 'a'])).toBe(limit);
    expect(wrapped('gh', ['pr', 'edit', '17', '--title', 't', '--body', 'b', '--add-label', 'a'])).toBe(limit);
    expect(f.calls.filter((call) => call[0] === 'gh' && call[1] === 'api')).toHaveLength(0);
    const forbidden = { ok: false, out: 'HTTP 404', err: 'GraphQL: not found' };
    const nonLimit = fake(forbidden);
    expect(withGhRestFallback(nonLimit.run)('gh', ['pr', 'list', '--head', 'x', '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""'])).toBe(forbidden);
    expect(nonLimit.calls).toHaveLength(1);
    const manager = makePrManager(nonLimit.run);
    expect(manager.findPrForBranchOutcome('x')).toEqual({ status: 'FAILED', url: null });
    expect(nonLimit.calls.filter((call) => call[0] === 'gh' && call[1] === 'api')).toHaveLength(0);
  });
});
