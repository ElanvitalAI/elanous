import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePrManager, type CmdRunner } from './pr-manager.js';
import { cardIdFromBody, guardNewPr, hasCardMarker } from '../pr-tool/census.js';
import { podGitPushGuardScript } from '../task-orchestrator/surfaces/self-implement-pod.js';

const head40 = /^[0-9a-f]{40}$/;
setDefaultTimeout(30_000);

function fixture(conflict: boolean, ambiguousExisting = false, moveRemoteHead = false, moveAtPush = false,
  raceNewBranch = false,
  existingNewBranch = false, runId?: string) {
  const root = mkdtempSync(join(tmpdir(), 'same-cell-pr-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '--bare', '--initial-branch=main', bare);
  git('clone', bare, work);
  const inWork = (...args: string[]) => git('-C', work, ...args);
  inWork('config', 'user.name', 'Same Cell Test');
  inWork('config', 'user.email', 'same-cell@example.test');
  writeFileSync(join(work, 'shared.txt'), 'base\n');
  inWork('add', '.'); inWork('commit', '-m', 'base'); inWork('push', 'origin', 'main');
  inWork('checkout', '-b', 'old-branch');
  writeFileSync(join(work, conflict ? 'shared.txt' : 'old.txt'), 'old\n');
  inWork('add', '.'); inWork('commit', '-m', 'old PR'); inWork('push', 'origin', 'old-branch');
  const oldHead = inWork('rev-parse', 'HEAD');
  const mainHead = inWork('rev-parse', 'main');
  expect(oldHead).toMatch(head40);
  inWork('checkout', 'main'); inWork('checkout', '-b', 'new-branch');
  if (runId) {
    const install = spawnSync('sh', ['-c', podGitPushGuardScript(runId)],
      { cwd: work, env: { ...process.env, HOME: root }, encoding: 'utf8' });
    if (install.status !== 0) throw new Error(`install Pod push guard: ${install.stderr}`);
    inWork('config', 'core.hooksPath', join(root, '.elanous-git-hooks'));
  }
  if (existingNewBranch) git('--git-dir', bare, 'update-ref', 'refs/heads/new-branch', mainHead);
  writeFileSync(join(work, conflict ? 'shared.txt' : 'new.txt'), 'new\n');
  const body = '칸: PR-SAME-CELL-REUSE\n카드: ta-integration';
  const oldBody = ambiguousExisting ? `${body}\n카드: ta-other` : body;
  const url = 'https://github.com/o/r/pull/7';
  const calls: string[][] = [];
  let remoteReads = 0;
  const run: CmdRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') {
      if (args.includes('ls-remote') && args.includes('refs/heads/old-branch')) {
        remoteReads++;
        if (moveRemoteHead && remoteReads === 2)
          git('--git-dir', bare, 'update-ref', 'refs/heads/old-branch', mainHead);
      }
      if (moveAtPush && args.includes('push') && args.some(arg => arg.startsWith('--force-with-lease=')))
        git('--git-dir', bare, 'update-ref', 'refs/heads/old-branch', mainHead);
      const r = spawnSync('git', args, { cwd: work, encoding: 'utf8' });
      return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') return { ok: true, out: 'o/r' };
    if (cmd === 'gh' && args[0] === 'api' && args.includes('POST')) {
      const ref = args.find(arg => arg.startsWith('ref='))?.slice(4);
      const sha = args.find(arg => arg.startsWith('sha='))?.slice(4);
      if (!ref || !sha) return { ok: false, out: '', err: 'bad ref request' };
      if (raceNewBranch) git('--git-dir', bare, 'update-ref', ref, mainHead);
      const created = spawnSync('git', ['--git-dir', bare, 'update-ref', ref, sha, '0'.repeat(40)], { encoding: 'utf8' });
      return { ok: created.status === 0, out: '', err: created.stderr.trim() };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: oldHead,
        headRefName: 'old-branch', body: oldBody,
        isCrossRepository: false, isDraft: true, labels: [{ name: 'elanous:running' }], url }) };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') return { ok: true, out: 'https://github.com/o/r/pull/8' };
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'edit') return { ok: true, out: '' };
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const guard = () => guardNewPr({ files: [conflict ? 'shared.txt' : 'new.txt'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-integration',
    ...(ambiguousExisting ? { boundPrNumber: 7 } : {}) }, {
    status: 'checked', prs: [{ number: 7, headRefName: 'old-branch', title: 'old', draft: true,
      updatedAt: '2026-10-19T00:00:00Z', headSha: oldHead, labels: [], files: [conflict ? 'shared.txt' : 'old.txt'],
      seat: null, cellId: 'PR-SAME-CELL-REUSE', cardId: cardIdFromBody(oldBody), cardMarkerPresent: hasCardMarker(oldBody) }],
  });
  const deliver = () => makePrManager(run, guard).upsertPr({ branch: 'new-branch', worktreePath: work,
    title: 'new work', body, commitMessage: 'new work', base: 'main', ...(runId ? { runId } : {}) });
  return { root, work, oldHead, mainHead, calls, deliver, inWork, url };
}

test('real git merges the old PR head and advances its branch without force or a second PR', () => {
  const f = fixture(false);
  try {
    expect(f.deliver()).toEqual({ ok: true, url: f.url, reused: true });
    const newHead = f.inWork('ls-remote', '--exit-code', 'origin', 'refs/heads/old-branch').split('\t')[0]!;
    expect(newHead).not.toBe(f.oldHead);
    expect(f.inWork('merge-base', '--is-ancestor', f.oldHead, newHead)).toBe('');
    expect(f.inWork('show', `${newHead}:old.txt`)).toBe('old');
    expect(f.inWork('show', `${newHead}:new.txt`)).toBe('new');
    expect(f.calls.filter(call => call[0] === 'git' && call.includes('push'))).toEqual([
      ['git', '-C', f.work, 'push', `--force-with-lease=refs/heads/old-branch:${f.oldHead}`, 'origin', 'HEAD:refs/heads/old-branch'],
    ]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('a bound PR with conflicting card markers is refused before any push', () => {
  const f = fixture(false, true);
  try {
    expect(f.deliver()).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('same-cell') });
    expect(f.calls.some(call => call[0] === 'git' && call.includes('push'))).toBe(false);
    expect(f.inWork('ls-remote', '--exit-code', 'origin', 'refs/heads/old-branch').split('\t')[0]).toBe(f.oldHead);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('real Git remote head movement between reads refuses without overwriting the PR branch', () => {
  const f = fixture(false, false, true);
  try {
    expect(f.deliver()).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('remote head changed before push') });
    expect(f.inWork('ls-remote', '--exit-code', 'origin', 'refs/heads/old-branch').split('\t')[0]).toBe(f.mainHead);
    expect(f.calls.some(call => call[0] === 'git' && call.includes('push'))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('exact-head lease rejects a remote move after the final read and before push', () => {
  const f = fixture(false, false, false, true);
  try {
    expect(f.deliver()).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('fast-forward push refused') });
    expect(f.inWork('ls-remote', '--exit-code', 'origin', 'refs/heads/old-branch').split('\t')[0]).toBe(f.mainHead);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('real git merge conflict opens a new draft and returns the new card PR', () => {
  const f = fixture(true, false, false, false, false, false, 'run-a1b2c3d4-1111-2222-3333-444444444444');
  try {
    expect(f.deliver()).toEqual({ ok: true, url: 'https://github.com/o/r/pull/8', reused: false, supersededPr: 7 });
    expect(f.inWork('ls-remote', '--exit-code', 'origin', 'refs/heads/old-branch').split('\t')[0]).toBe(f.oldHead);
    expect(f.inWork('ls-remote', '--exit-code', 'origin', 'refs/heads/new-branch').split('\t')[0]).toBe(f.inWork('rev-parse', 'HEAD'));
    const pushes = f.calls.filter(call => call[0] === 'git' && call.includes('push'));
    expect(pushes).toHaveLength(2);
    expect(pushes[0]![5]).toMatch(/^HEAD:refs\/heads\/self-impl\/pr-create-ra1b2c3-[0-9a-f-]+$/);
    expect(pushes[1]![5]).toBe(`:${pushes[0]![5]!.slice(5)}`);
    expect(f.calls.some(call => call[0] === 'gh' && call[1] === 'api' && call.includes('POST'))).toBe(true);
    const create = f.calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')!;
    expect(create).toContain('--draft');
    expect(create[create.indexOf('--body') + 1]).toContain('카드: ta-integration\n\nSupersedes: #7');
    expect(f.calls.some(call => call[0] === 'gh' && call[1] === 'pr' && (call[2] === 'edit' || call[2] === 'close'))).toBe(false);
    expect(f.inWork('status', '--porcelain')).toBe('');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('same-cell reuse without a run id fails before any push', () => {
  const f = fixture(true);
  try {
    expect(f.deliver()).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('run id required') });
    expect(f.calls.some(call => call[0] === 'git' && call.includes('push'))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('an existing fast-forwardable new branch is refused without changing that branch', () => {
  const f = fixture(true, false, false, false, false, true);
  try {
    expect(f.deliver()).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('new run branch already exists') });
    expect(f.inWork('ls-remote', '--exit-code', 'origin', 'refs/heads/new-branch').split('\t')[0]).toBe(f.mainHead);
    expect(f.calls.some(call => call[0] === 'git' && call.includes('push'))).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('a branch created after the remote precheck loses the atomic create race without being overwritten', () => {
  const f = fixture(true, false, false, false, true, false, 'run-a1b2c3d4-1111-2222-3333-444444444444');
  try {
    expect(f.deliver()).toMatchObject({ ok: false, reason: 'guard', detail: expect.stringContaining('new run branch create refused') });
    expect(f.inWork('ls-remote', '--exit-code', 'origin', 'refs/heads/new-branch').split('\t')[0]).toBe(f.mainHead);
    expect(f.calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create')).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
