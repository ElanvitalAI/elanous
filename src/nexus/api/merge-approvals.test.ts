import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PR_LABELS } from '../../github/pr-labels.js';
import { setUserConfigOverlay } from '../../user-config.js';
import { setInstallMetadataRootForTesting } from '../../version/code-revision.js';
import { handleMergeApprovals, IDEA_APPROVAL_LABEL, type MergeApprovalsDeps } from './merge-approvals';

const base = 'http://localhost/v1/approvals/merges';
const pr = (number: number, changes: Record<string, unknown> = {}) => ({
  number, title: `Idea ${number}`, url: `https://github.com/o/r/pull/${number}`, headRefOid: 'aaa',
  baseRefName: 'main', baseRefOid: 'c'.repeat(40), isDraft: false, mergeable: 'MERGEABLE', additions: 10, deletions: 2,
  changedFiles: 2, files: [{ path: 'src/a.ts' }, { path: 'test/a.ts' }],
  body: 'Details\n\n- 한 줄: 사람이 읽을 한 줄 요약', createdAt: '2026-09-27T00:00:00Z', state: 'OPEN',
  labels: [{ name: IDEA_APPROVAL_LABEL }], statusCheckRollup: [{ conclusion: 'SUCCESS' }], ...changes,
});

function fixture(options: { authorize?: boolean; repo?: string; rows?: Array<ReturnType<typeof pr>> } = {}) {
  const calls: string[][] = [];
  const rows = options.rows ?? [pr(1), pr(2, { statusCheckRollup: [{ conclusion: 'FAILURE' }] }), pr(3, { baseRefName: 'feature/x' })];
  const deps: MergeApprovalsDeps = {
    repo: () => options.repo ?? 'o/r', authorize: () => options.authorize ?? true,
    gate: { start: () => ({ status: 'running', failures: [] }), get: () => ({ status: 'passed', failures: [] }) },
    baseTip: async () => 'c'.repeat(40),
    gh: (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        const limitIndex = args.indexOf('--limit');
        const limit = limitIndex < 0 ? 30 : Number(args[limitIndex + 1]);
        return { ok: true, stdout: JSON.stringify(rows.slice(0, limit)), stderr: '', code: 0 };
      }
      if (args[0] === 'pr' && args[1] === 'view') return { ok: true, stdout: JSON.stringify(rows[Number(args[2]) - 1] ?? pr(4, { labels: [] })), stderr: '', code: 0 };
      if (args[0] === 'repo') return { ok: true, stdout: '{"nameWithOwner":"o/r"}', stderr: '', code: 0 };
      return { ok: true, stdout: '', stderr: '', code: 0 };
    },
  };
  const get = (path = '') => handleMergeApprovals(new Request(base + path), deps);
  const post = (number: number, headSha: string) => handleMergeApprovals(new Request(`${base}/${number}/merge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ headSha }),
  }), deps);
  return { calls, get, post, deps };
}

describe('owner-only idea merge approvals', () => {
  test('approval label comes from the PR label registry', () => {
    expect(PR_LABELS.some((label) => label.name === IDEA_APPROVAL_LABEL && label.axis === 'state')).toBe(true);
  });

  test('GET ?state=merged lists merged labelled PRs newest first in one gh call, open list unchanged', async () => {
    const f = fixture({ rows: [
      pr(7, { state: 'MERGED', mergedAt: '2026-09-27T21:25:18Z' }),
      pr(8, { state: 'MERGED', mergedAt: '2026-09-28T01:00:00Z' }),
      pr(9, { state: 'MERGED', mergedAt: '2026-09-26T01:00:00Z', labels: [] }),
    ] });
    const response = await f.get('?state=merged');
    expect(response.status).toBe(200);
    const { items } = await response.json();
    expect(items.map((item: { number: number }) => item.number)).toEqual([8, 7]);
    expect(items[1]).toMatchObject({ state: 'MERGED', mergedAt: '2026-09-27T21:25:18Z', approvalPath: '/approvals?pr=7' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toEqual(['pr', 'list', '--repo', 'o/r', '--label', IDEA_APPROVAL_LABEL, '--state', 'merged', '--limit', '30', '--json', expect.stringContaining('mergedAt')]);
  });

  test('GET lists three open labelled PRs, summary and direct link', async () => {
    const f = fixture();
    const response = await f.get();
    expect(response.status).toBe(200);
    const { items } = await response.json();
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ summary: '사람이 읽을 한 줄 요약', approvalPath: '/approvals?pr=1', headSha: 'aaa', files: ['src/a.ts', 'test/a.ts'] });
    expect(items[1].checks.failure).toBe(1);
    expect(f.calls[0]).toEqual(['pr', 'list', '--repo', 'o/r', '--label', IDEA_APPROVAL_LABEL, '--state', 'open', '--limit', '100', '--json', expect.any(String)]);
  });

  test('GET lists all 31 labelled open PRs even beyond the gh default limit', async () => {
    const f = fixture({ rows: Array.from({ length: 31 }, (_, index) => pr(index + 1)) });
    const response = await f.get();
    expect(response.status).toBe(200);
    const { items } = await response.json();
    expect(items).toHaveLength(31);
    expect(items[30]).toMatchObject({ number: 31, approvalPath: '/approvals?pr=31' });
    expect(f.calls.filter((args) => args[0] === 'pr' && args[1] === 'view')).toHaveLength(31);
  });

  test('GET grows its explicit limit when there are over 100 open labelled PRs', async () => {
    const f = fixture({ rows: Array.from({ length: 101 }, (_, index) => pr(index + 1)) });
    const { items } = await (await f.get()).json();
    expect(items).toHaveLength(101);
    expect(items[100].number).toBe(101);
    expect(f.calls.filter((args) => args[1] === 'list').map((args) => args[args.indexOf('--limit') + 1])).toEqual(['100', '200']);
  });

  test('falls back to a capped first paragraph, at most 20 files and separates check counts', async () => {
    const files = Array.from({ length: 22 }, (_, index) => ({ path: `src/file-${index}.ts` }));
    const f = fixture({ rows: [pr(1, {
      body: `${'첫 문단 '.repeat(150)}\n\n뒤 문단`, files,
      statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }],
    })] });
    const detail = await (await f.get('/1')).json();
    expect(detail.summary.length).toBe(600);
    expect(detail.summary).not.toContain('뒤 문단');
    expect(detail.files).toHaveLength(20);
    expect(detail.checks).toEqual({ success: 1, failure: 1, pending: 1 });
  });

  test('GET single PR includes state, refuses unlabelled PR', async () => {
    const f = fixture();
    expect((await f.get('/1')).status).toBe(200);
    expect((await f.get('/4')).status).toBe(404);
  });

  test('GET reports the gate for the current SHA, not a previously checked SHA', async () => {
    const f = fixture({ rows: [pr(1, { headRefOid: 'bbb' })] });
    const observed: string[] = [];
    f.deps.gate = {
      start: () => ({ status: 'running', failures: [] }),
      get: (_number, headSha) => { observed.push(headSha); return { status: headSha === 'aaa' ? 'passed' : 'none', failures: [] }; },
    };
    expect((await (await f.get('/1')).json()).gate.status).toBe('none');
    expect((await (await f.get()).json()).items[0].gate.status).toBe('none');
    expect(observed).toEqual(['bbb', 'bbb']);
    expect((await (await f.post(1, 'aaa')).json()).error).toBe('head-changed');
  });

  test('check starts only for the installed repo root and the current PR head; GET reflects its gate', async () => {
    const f = fixture();
    let input: unknown;
    f.deps.installSource = () => '/installed/source';
    f.deps.gate = {
      start: (value) => { input = value; return { status: 'running', failures: [] }; },
      get: () => ({ status: 'none', failures: [] }),
    };
    const check = (headSha: string) => handleMergeApprovals(new Request(`${base}/1/check`, {
      method: 'POST', body: JSON.stringify({ headSha }),
    }), f.deps);
    expect((await (await f.get('/1')).json()).gate.status).toBe('none');
    expect((await (await f.get()).json()).items[0].gate.status).toBe('none');
    expect((await (await check('bbb')).json()).error).toBe('head-changed');
    expect(input).toBeUndefined();
    const response = await check('aaa');
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ gate: { status: 'running', failures: [] } });
    expect(input).toEqual({ prNumber: 1, headSha: 'aaa', repoRoot: '/installed/source', repo: 'o/r', baseSha: 'c'.repeat(40) });
    f.deps.installSource = () => undefined;
    const unknown = await check('aaa');
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toEqual({ error: 'gate-repo-unknown' });
  });

  test('check refuses a selected repo different from the installed source origin', async () => {
    const f = fixture({ repo: 'other/repo' });
    f.deps.gate = undefined;
    f.deps.installSource = () => '/installed/source';
    f.deps.gitRemote = () => 'https://github.com/o/r.git';
    const response = await handleMergeApprovals(new Request(`${base}/1/check`, {
      method: 'POST', body: JSON.stringify({ headSha: 'aaa' }),
    }), f.deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'gate-repo-unknown' });
    expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
  });

  test('check keeps the existing label, open, base, SHA, checks, conflict and draft refusals', async () => {
    const cases = [
      { change: { labels: [] }, error: 'label-missing', status: 403 },
      { change: { state: 'CLOSED' }, error: 'not-open', status: 409 },
      { change: { baseRefName: 'feature' }, error: 'base-not-main', status: 409 },
      { change: { headRefOid: 'bbb' }, error: 'head-changed', status: 409 },
      { change: { statusCheckRollup: [{ conclusion: 'FAILURE' }] }, error: 'checks-failed', status: 409 },
      { change: { statusCheckRollup: [{ status: 'QUEUED' }] }, error: 'checks-pending', status: 409 },
      { change: { mergeable: 'CONFLICTING' }, error: 'conflicting', status: 409 },
      { change: { isDraft: true }, error: 'draft', status: 409 },
    ];
    for (const { change, error, status } of cases) {
      const f = fixture({ rows: [pr(1, change)] });
      f.deps.installSource = () => '/installed/source';
      const response = await handleMergeApprovals(new Request(`${base}/1/check`, {
        method: 'POST', body: JSON.stringify({ headSha: 'aaa' }),
      }), f.deps);
      expect(response.status).toBe(status);
      expect((await response.json()).error).toBe(error);
      expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
    }
  });

  test('matching head merges once with squash and match-head-commit', async () => {
    const f = fixture();
    let clockReads = 0;
    f.deps.now = () => { clockReads++; return new Date('2026-09-27T00:00:00Z'); };
    const response = await f.post(1, 'aaa');
    expect(await response.json()).toEqual({ merged: true, number: 1 });
    expect(clockReads).toBe(1);
    expect(f.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge')).toEqual([
      ['pr', 'merge', '1', '--repo', 'o/r', '--squash', '--delete-branch', '--match-head-commit', 'aaa'],
    ]);
  });

  test('main tip changed after a passed check cannot merge without the overlap rule, even with the same PR head', async () => {
    const row = pr(1);
    const f = fixture({ rows: [row] });
    let tip = 'c'.repeat(40);
    f.deps.baseTip = async () => tip;
    f.deps.gate = {
      start: () => ({ status: 'running', failures: [] }),
      get: (_number, _head, repo, baseSha) => repo === 'o/r' && baseSha === 'c'.repeat(40)
        ? { status: 'passed', failures: [] } : { status: 'none', failures: [] },
    };
    tip = 'd'.repeat(40);
    const changed = await f.post(1, 'aaa');
    expect(changed.status).toBe(409);
    expect((await changed.json()).error).toBe('gate-not-passed');
    expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
  });

  test('after main moves, a passed check still merges unless main changed one of this PR\'s files', async () => {
    const run = async (changed: string[] | null) => {
      const row = pr(1);
      const f = fixture({ rows: [row] });
      f.deps.baseTip = async () => 'd'.repeat(40);
      f.deps.gate = {
        start: () => ({ status: 'running', failures: [] }),
        get: () => ({ status: 'none', failures: [] }),
        latest: () => ({ status: 'passed', failures: [], baseSha: 'c'.repeat(40) }),
      };
      const compared: string[][] = [];
      f.deps.compareFiles = async (repo, from, to) => { compared.push([repo, from, to]); return changed; };
      const response = await f.post(1, 'aaa');
      return { response, body: await response.json(), merges: f.calls.filter((args) => args[1] === 'merge').length, compared };
    };
    const clean = await run(['docs/other.md', 'src/unrelated.ts']);
    expect(clean.body).toEqual({ merged: true, number: 1 });
    expect(clean.merges).toBe(1);
    expect(clean.compared).toEqual([['o/r', 'c'.repeat(40), 'd'.repeat(40)]]);

    const overlap = await run(['src/a.ts']);
    expect(overlap.response.status).toBe(409);
    expect(overlap.body.error).toBe('gate-stale');
    expect(overlap.body.reason).toContain('src/a.ts');
    expect(overlap.merges).toBe(0);

    const unmeasured = await run(null);
    expect(unmeasured.response.status).toBe(409);
    expect(unmeasured.body.error).toBe('gate-not-passed');
    expect(unmeasured.merges).toBe(0);
  });

  test('the card keeps showing a passed check after main moves, marked as drifted', async () => {
    const row = pr(1);
    const f = fixture({ rows: [row] });
    f.deps.gate = {
      start: () => ({ status: 'running', failures: [] }),
      get: () => ({ status: 'none', failures: [] }),
      latest: () => ({ status: 'passed', failures: [], baseSha: 'c'.repeat(40), os: 'darwin' }),
    };
    const card = await (await f.get('/1')).json();
    expect(card.gate).toMatchObject({ status: 'passed', baseDrifted: true, os: 'darwin' });
  });

  test('a failed or unmeasured check on the old base never merges after main moves', async () => {
    for (const status of ['failed', 'unmeasured', 'running'] as const) {
      const row = pr(1);
      const f = fixture({ rows: [row] });
      row.baseRefOid = 'd'.repeat(40);
      let compared = 0;
      f.deps.gate = {
        start: () => ({ status: 'running', failures: [] }),
        get: () => ({ status: 'none', failures: [] }),
        latest: () => ({ status, failures: [], baseSha: 'c'.repeat(40) }),
      };
      f.deps.compareFiles = async () => { compared++; return []; };
      const response = await f.post(1, 'aaa');
      expect(response.status).toBe(409);
      expect(compared).toBe(0);
      expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
    }
  });

  test('stale head, failing checks and non-main base each refuse without merge', async () => {
    for (const [number, head, error] of [[1, 'bbb', 'head-changed'], [2, 'aaa', 'checks-failed'], [3, 'aaa', 'base-not-main']] as const) {
      const f = fixture();
      const response = await f.post(number, head);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe(error);
      expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
    }
  });

  test('pending and unknown checks cannot merge even with zero failures', async () => {
    for (const checks of [
      [{ status: 'IN_PROGRESS' }],
      [{ conclusion: 'SUCCESS' }, { status: 'QUEUED' }],
      [{ conclusion: 'SUCCESS', status: 'IN_PROGRESS' }],
      [{ __typename: 'CheckRun', conclusion: 'SUCCESS', status: 'QUEUED' }],
      [{ conclusion: null, status: 'COMPLETED' }],
      [{ conclusion: 'NEUTRAL' }],
      [{ conclusion: 'SKIPPED' }],
    ]) {
      const f = fixture({ rows: [pr(1, { statusCheckRollup: checks })] });
      const response = await f.post(1, 'aaa');
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('checks-pending');
      expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
    }
  });

  test('a PR with no GitHub checks at all can merge after a passed host gate', async () => {
    const f = fixture({ rows: [pr(1, { statusCheckRollup: [] })] });
    const response = await f.post(1, 'aaa');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ merged: true, number: 1 });
    expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(1);
    expect(f.calls.filter((args) => args[0] === 'api')).toHaveLength(0);
  });

  test('draft merge is refused without changing draft state even when ready or undo would fail', async () => {
    const f = fixture({ rows: [pr(1, { isDraft: true })] });
    const originalGh = f.deps.gh!;
    f.deps.gh = (args) => args[1] === 'ready'
      ? { ok: false, stdout: '', stderr: 'ready or undo denied', code: 1 }
      : originalGh(args);
    const response = await f.post(1, 'aaa');
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('draft');
    expect(f.calls.filter((args) => args[1] === 'ready' || args[1] === 'merge')).toHaveLength(0);
  });

  test('owner authorization runs before any gh call, including GET', async () => {
    const f = fixture({ authorize: false });
    expect((await f.post(1, 'aaa')).status).toBe(401);
    expect((await f.get()).status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });

  test('closed and merged details remain visible; merge refuses and list excludes them', async () => {
    const rows = [pr(1, { state: 'MERGED' }), pr(2, { state: 'CLOSED' })];
    const f = fixture({ rows });
    expect((await (await f.get('/1')).json()).state).toBe('MERGED');
    expect((await (await f.get('/2')).json()).state).toBe('CLOSED');
    expect((await (await f.get()).json()).items).toHaveLength(0);
    expect((await f.post(1, 'aaa')).status).toBe(409);
    expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
  });

  test('unlabelled, conflicting and draft PRs enforce the merge boundary', async () => {
    const unlabelled = fixture({ rows: [pr(1, { labels: [] })] });
    expect((await unlabelled.post(1, 'aaa')).status).toBe(403);
    expect(unlabelled.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
    const conflicting = fixture({ rows: [pr(1, { mergeable: 'CONFLICTING' })] });
    expect((await conflicting.post(1, 'aaa')).status).toBe(409);
    expect(conflicting.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
    const draft = fixture({ rows: [pr(1, { isDraft: true })] });
    expect((await draft.post(1, 'aaa')).status).toBe(409);
    expect(draft.calls.filter((args) => args[1] === 'ready' || args[1] === 'merge')).toHaveLength(0);
  });

  test('repo override wins over config, cwd and install source', async () => {
    setUserConfigOverlay((config) => ({ ...config, intake: { ...config.intake, approvals: { repo: 'config/repo' } } }));
    try {
      const f = fixture({ repo: 'override/repo' });
      f.deps.installSource = () => { throw Error('should not read install source'); };
      expect((await f.get('/1')).status).toBe(200);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toEqual(['pr', 'view', '1', '--repo', 'override/repo', '--json', expect.any(String)]);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  test('config repo wins over cwd gh repo view and install source', async () => {
    setUserConfigOverlay((config) => ({ ...config, intake: { ...config.intake, approvals: { repo: 'config/repo' } } }));
    try {
      const f = fixture();
      f.deps.repo = () => undefined;
      f.deps.installSource = () => { throw Error('should not read install source'); };
      expect((await f.get('/1')).status).toBe(200);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toEqual(['pr', 'view', '1', '--repo', 'config/repo', '--json', expect.any(String)]);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  test('invalid higher priority repo and malformed cwd response fall back to install origin', async () => {
    const f = fixture();
    f.deps.repo = () => 'not-a-repo';
    f.deps.installSource = () => '/installed/source';
    f.deps.gitRemote = () => 'ssh://git@github.com/installed/repo.git';
    const gh = f.deps.gh!;
    f.deps.gh = (args) => args[0] === 'repo'
      ? { ok: true, stdout: '{invalid-json', stderr: '', code: 0 }
      : gh(args);
    expect((await f.get('/1')).status).toBe(200);
    expect(f.calls[0]).toEqual(['pr', 'view', '1', '--repo', 'installed/repo', '--json', expect.any(String)]);
  });

  test('invalid config and invalid cwd repo names fall through to install source', async () => {
    setUserConfigOverlay((config) => ({ ...config, intake: { ...config.intake, approvals: { repo: 'invalid-config' } } }));
    try {
      const f = fixture();
      f.deps.repo = () => undefined;
      f.deps.installSource = () => '/installed/source';
      f.deps.gitRemote = () => 'https://github.com/installed/valid.git';
      const gh = f.deps.gh!;
      f.deps.gh = (args) => args[0] === 'repo'
        ? { ok: true, stdout: '{"nameWithOwner":"invalid-cwd"}', stderr: '', code: 0 }
        : gh(args);
      expect((await f.get('/1')).status).toBe(200);
      expect(f.calls[0]).toEqual(['pr', 'view', '1', '--repo', 'installed/valid', '--json', expect.any(String)]);
    } finally {
      setUserConfigOverlay(null);
    }
  });

  test('uses install source origin when cwd gh repo view fails, then addresses PRs with that repo', async () => {
    const f = fixture();
    const source = '/installed/source';
    let remoteSource: string | undefined;
    f.deps.repo = () => undefined;
    f.deps.installSource = () => source;
    f.deps.gitRemote = (path) => { remoteSource = path; return 'git@github.com:installed/repository.git'; };
    const gh = f.deps.gh!;
    f.deps.gh = (args) => args[0] === 'repo'
      ? { ok: false, stdout: '', stderr: 'not in a git repository', code: 1 }
      : gh(args);
    expect((await f.get('/1')).status).toBe(200);
    expect(remoteSource).toBe(source);
    expect(f.calls[0]).toEqual(['pr', 'view', '1', '--repo', 'installed/repository', '--json', expect.any(String)]);
  });

  test('default gitRemote reads origin from the install source, not the daemon cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-approval-origin-'));
    try {
      expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
      expect(spawnSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/installed/real.git']).status).toBe(0);
      const f = fixture();
      f.deps.repo = () => undefined;
      f.deps.installSource = () => root;
      const gh = f.deps.gh!;
      f.deps.gh = (args) => args[0] === 'repo'
        ? { ok: false, stdout: '', stderr: '', code: 1 }
        : gh(args);
      expect((await f.get('/1')).status).toBe(200);
      expect(f.calls[0]).toEqual(['pr', 'view', '1', '--repo', 'installed/real', '--json', expect.any(String)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses the exported install metadata reader and origin remote by default when cwd repo lookup fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-approval-install-'));
    const source = join(root, 'source');
    mkdirSync(source);
    writeFileSync(join(root, 'install.json'), JSON.stringify({ source }));
    expect(spawnSync('git', ['init', '-q', source]).status).toBe(0);
    expect(spawnSync('git', ['-C', source, 'remote', 'add', 'origin', 'https://github.com/installed/reader.git']).status).toBe(0);
    setInstallMetadataRootForTesting(root);
    try {
      const f = fixture();
      f.deps.repo = () => undefined;
      const gh = f.deps.gh!;
      f.deps.gh = (args) => args[0] === 'repo'
        ? { ok: false, stdout: '', stderr: '', code: 1 }
        : gh(args);
      expect((await f.get('/1')).status).toBe(200);
      expect(f.calls[0]).toEqual(['pr', 'view', '1', '--repo', 'installed/reader', '--json', expect.any(String)]);
    } finally {
      setInstallMetadataRootForTesting(undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('prefers cwd gh repo view over install source and rejects an unrelated origin', async () => {
    const f = fixture();
    f.deps.repo = () => undefined;
    f.deps.installSource = () => { throw Error('install source must not be read'); };
    expect((await f.get('/1')).status).toBe(200);
    expect(f.calls[0]).toEqual(['repo', 'view', '--json', 'nameWithOwner']);
    expect(f.calls[1]).toEqual(['pr', 'view', '1', '--repo', 'o/r', '--json', expect.any(String)]);

    f.deps.gh = (args) => args[0] === 'repo'
      ? { ok: false, stdout: '', stderr: '', code: 1 }
      : { ok: true, stdout: '', stderr: '', code: 0 };
    f.deps.installSource = () => '/installed/source';
    f.deps.gitRemote = () => 'https://example.org/other/repository.git';
    expect((await f.get()).status).toBe(503);
  });

  test('unknown repo is 503, gh failure is 502 with capped stderr', async () => {
    const f = fixture();
    f.deps.repo = () => undefined;
    f.deps.gh = () => ({ ok: false, stdout: '', stderr: 'bad', code: 1 });
    expect((await f.get()).status).toBe(503);
    f.deps.repo = () => 'o/r';
    const result = await f.get();
    expect(result.status).toBe(502);
    expect((await result.json()).reason).toBe('bad');
    f.deps.gh = () => ({ ok: false, stdout: '', stderr: 'x'.repeat(400), code: 1 });
    expect((await (await f.get()).json()).reason).toHaveLength(300);
  });
});
