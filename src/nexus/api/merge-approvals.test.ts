import { describe, expect, test } from 'bun:test';
import { handleMergeApprovals, IDEA_APPROVAL_LABEL, type MergeApprovalsDeps } from './merge-approvals';

const base = 'http://localhost/v1/approvals/merges';
const pr = (number: number, changes: Record<string, unknown> = {}) => ({
  number, title: `Idea ${number}`, url: `https://github.com/o/r/pull/${number}`, headRefOid: 'aaa',
  baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', additions: 10, deletions: 2,
  changedFiles: 2, files: [{ path: 'src/a.ts' }, { path: 'test/a.ts' }],
  body: 'Details\n\n- 한 줄: 사람이 읽을 한 줄 요약', createdAt: '2026-09-27T00:00:00Z', state: 'OPEN',
  labels: [{ name: IDEA_APPROVAL_LABEL }], statusCheckRollup: [{ conclusion: 'SUCCESS' }], ...changes,
});

function fixture(options: { authorize?: boolean; repo?: string; rows?: Array<ReturnType<typeof pr>> } = {}) {
  const calls: string[][] = [];
  const rows = options.rows ?? [pr(1), pr(2, { statusCheckRollup: [{ conclusion: 'FAILURE' }] }), pr(3, { baseRefName: 'feature/x' })];
  const deps: MergeApprovalsDeps = {
    repo: () => options.repo ?? 'o/r', authorize: () => options.authorize ?? true,
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

  test('a PR with no GitHub checks at all can merge — the harness gate lives in the PR body, not in GitHub checks', async () => {
    const f = fixture({ rows: [pr(1, { statusCheckRollup: [] })] });
    const response = await f.post(1, 'aaa');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ merged: true, number: 1 });
    expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(1);
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
