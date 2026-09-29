import { expect, test } from 'bun:test';
import { getApprovalGate, startApprovalGate } from './merge-approvals-gate';
import { handleMergeApprovals, IDEA_APPROVAL_LABEL } from './merge-approvals';

const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const baseSha = 'c'.repeat(40);
const nextBase = 'd'.repeat(40);
const gateInput = (prNumber: number, headSha = sha, repo = 'o/r', baseShaValue = baseSha) => ({ prNumber, headSha, repoRoot: '/install', repo, baseSha: baseShaValue });
const currentPr = async (input: ReturnType<typeof gateInput>) => ({ headSha: input.headSha, baseSha: input.baseSha });
const base = 'http://localhost/v1/approvals/merges/973';
const pr = (headRefOid = sha) => ({
  number: 973, title: 'Idea', url: 'https://github.com/o/r/pull/973', headRefOid,
  baseRefName: 'main', baseRefOid: baseSha, isDraft: false, mergeable: 'MERGEABLE', additions: 1, deletions: 0,
  changedFiles: 1, files: [], body: '', createdAt: '', state: 'OPEN',
  labels: [{ name: IDEA_APPROVAL_LABEL }], statusCheckRollup: [],
});
const settled = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); for (let i = 0; i < 6; i++) await Promise.resolve(); };

function endpoint(headRefOid = sha, authorize = true) {
  const calls: string[][] = [];
  const deps: import('./merge-approvals').MergeApprovalsDeps = {
    repo: () => 'o/r', installSource: () => '/install', authorize: () => authorize, baseTip: async () => baseSha,
    gh: (args: string[]) => {
      calls.push(args);
      return { ok: true, stdout: args[1] === 'view' ? JSON.stringify(pr(headRefOid)) : '', stderr: '', code: 0 };
    },
  };
  const post = (action: 'check' | 'merge', headSha = headRefOid) => handleMergeApprovals(new Request(`${base}/${action}`, {
    method: 'POST', body: JSON.stringify({ headSha }),
  }), deps);
  return { calls, deps, post };
}

test('same PR and SHA checks once while running and passed; changed SHA checks again without blocking request', async () => {
  let calls = 0;
  let finish!: (result: { passed: boolean; failures: []; os: string }) => void;
  const runHostRegate = () => { calls++; return new Promise<{ passed: boolean; failures: []; os: string }>((resolve) => { finish = resolve; }); };
  const input = gateInput(981);
  expect(startApprovalGate(input, { runHostRegate, readPr: currentPr }).status).toBe('running');
  expect(startApprovalGate(input, { runHostRegate, readPr: currentPr }).status).toBe('running');
  await settled();
  expect(calls).toBe(1);
  finish({ passed: true, failures: [], os: 'linux' });
  await settled();
  expect(getApprovalGate(981, sha, 'o/r', baseSha, '/install')).toMatchObject({ status: 'passed', os: 'linux', finishedAt: expect.any(String) });
  startApprovalGate(input, { runHostRegate, readPr: currentPr });
  expect(calls).toBe(1);
  expect(getApprovalGate(981, nextSha, 'o/r', baseSha, '/install').status).toBe('none');
  startApprovalGate({ ...input, headSha: nextSha }, { runHostRegate, readPr: currentPr });
  await settled();
  expect(calls).toBe(2);
  finish({ passed: true, failures: [], os: 'linux' });
  await settled();
});

test('a passed head is scoped to both repository and checked base commit', async () => {
  let calls = 0;
  const deps = { readPr: currentPr, runHostRegate: async () => { calls++; return { passed: true, failures: [], os: 'linux' }; } };
  startApprovalGate(gateInput(984), deps);
  await settled();
  expect(getApprovalGate(984, sha, 'o/r', baseSha, '/install').status).toBe('passed');
  expect(getApprovalGate(984, sha, 'o/r', baseSha, '/other-install').status).toBe('none');
  expect(getApprovalGate(984, sha, 'another/repo', baseSha, '/install').status).toBe('none');
  expect(getApprovalGate(984, sha, 'o/r', nextBase, '/install').status).toBe('none');
  startApprovalGate(gateInput(984, sha, 'another/repo'), deps);
  startApprovalGate(gateInput(984, sha, 'o/r', nextBase), deps);
  startApprovalGate({ ...gateInput(984), repoRoot: '/other-install' }, deps);
  await settled();
  expect(calls).toBe(4);
  expect(getApprovalGate(984, sha, 'o/r', baseSha, '/other-install').status).toBe('passed');
  expect(getApprovalGate(984, sha, 'another/repo', baseSha, '/install').status).toBe('passed');
  expect(getApprovalGate(984, sha, 'o/r', nextBase, '/install').status).toBe('passed');
});

test('a base move while host regate runs keeps the pass on the tip it measured; a head move does not pass', async () => {
  let currentHead = sha;
  startApprovalGate(gateInput(985), {
    runHostRegate: async () => ({ passed: true, failures: [], os: 'linux', status: 'passed', baseCommit: nextBase }),
    readPr: async () => ({ headSha: currentHead, baseSha: 'f'.repeat(40) }),
  });
  await settled();
  expect(getApprovalGate(985, sha, 'o/r', nextBase, '/install')).toMatchObject({ status: 'passed', baseSha: nextBase });
  startApprovalGate(gateInput(986), {
    runHostRegate: async () => ({ passed: true, failures: [], os: 'linux', status: 'passed', baseCommit: nextBase }),
    readPr: async () => ({ headSha: currentHead, baseSha }),
  });
  currentHead = 'e'.repeat(40);
  await settled();
  expect(getApprovalGate(986, sha, 'o/r', nextBase, '/install').status).toBe('unmeasured');
});

test('failed gate retains its failure lines and a retry can pass', async () => {
  const input = gateInput(983);
  startApprovalGate(input, { runHostRegate: async () => ({ passed: false, status: 'failed', failures: [{ step: 'isolation-gate', detail: 'x'.repeat(900) }], os: 'linux' }) });
  await settled();
  expect(getApprovalGate(983, sha, 'o/r', baseSha, '/install').status).toBe('failed');
  expect(getApprovalGate(983, sha, 'o/r', baseSha, '/install').failures[0]!.length).toBe(800);
  expect(getApprovalGate(983, sha, 'o/r', baseSha, '/install').finishedAt).toBeDefined();
  startApprovalGate(input, { runHostRegate: async () => ({ passed: true, failures: [], os: 'linux' }), readPr: currentPr });
  await settled();
  expect(getApprovalGate(983, sha, 'o/r', baseSha, '/install').status).toBe('passed');
});

test('two HTTP checks for one PR head launch one host regate, then GET exposes the pass', async () => {
  const f = endpoint();
  let calls = 0;
  let finish!: (result: { passed: boolean; failures: []; os: string }) => void;
  f.deps.gate = {
    start: (input) => startApprovalGate(input, { readPr: currentPr, runHostRegate: () => {
      calls++;
      return new Promise((resolve) => { finish = resolve; });
    } }),
    get: getApprovalGate,
  };
  const first = await f.post('check');
  const second = await f.post('check');
  expect(first.status).toBe(202);
  expect((await first.json()).gate.status).toBe('running');
  expect((await second.json()).gate.status).toBe('running');
  expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
  await settled();
  expect(calls).toBe(1);
  finish({ passed: true, failures: [], os: 'linux' });
  await settled();
  const detail = await handleMergeApprovals(new Request(base), f.deps);
  expect((await detail.json()).gate).toMatchObject({ status: 'passed', os: 'linux' });
  expect((await f.post('merge')).status).toBe(200);
  expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(1);
});

test('HTTP check, GET and merge cannot reuse a pass after switching the selected repository', async () => {
  const f = endpoint(nextSha);
  let repo = 'o/r';
  f.deps.repo = () => repo;
  let calls = 0;
  f.deps.gate = {
    start: (input) => startApprovalGate(input, {
      readPr: currentPr,
      runHostRegate: async () => { calls++; return { passed: true, failures: [], os: 'linux' }; },
    }),
    get: getApprovalGate,
  };
  expect((await f.post('check')).status).toBe(202);
  await settled();
  expect((await (await handleMergeApprovals(new Request(base), f.deps)).json()).gate.status).toBe('passed');
  f.deps.installSource = () => '/other-install';
  expect((await (await handleMergeApprovals(new Request(base), f.deps)).json()).gate.status).toBe('none');
  expect((await (await f.post('merge')).json()).error).toBe('gate-not-passed');
  f.deps.installSource = () => '/install';
  repo = 'another/repo';
  expect((await (await handleMergeApprovals(new Request(base), f.deps)).json()).gate.status).toBe('none');
  const denied = await f.post('merge');
  expect(denied.status).toBe(409);
  expect((await denied.json()).error).toBe('gate-not-passed');
  expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
  expect((await f.post('check')).status).toBe(202);
  await settled();
  expect(calls).toBe(2);
  expect((await f.post('merge')).status).toBe(200);
  expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(1);
});

test('thrown host regate becomes unmeasured and failure detail is capped', async () => {
  startApprovalGate(gateInput(982), {
    runHostRegate: async () => { throw new Error('x'.repeat(900)); },
  });
  await settled();
  const gate = getApprovalGate(982, sha, 'o/r', baseSha, '/install');
  expect(gate.status).toBe('unmeasured');
  expect(gate.failures[0]).toContain('host-regate');
  expect(gate.failures[0]!.length).toBeLessThanOrEqual(800);
});

test('none, running, failed and unmeasured cannot call gh merge; check is authorized', async () => {
  const f = endpoint();
  const state: { status: 'none' | 'running' | 'failed' | 'unmeasured' | 'passed'; failures: string[] } = { status: 'none', failures: [] };
  f.deps.gate = { get: () => state, start: () => state };
  for (const status of ['none', 'running', 'failed', 'unmeasured'] as const) {
    state.status = status;
    const response = await f.post('merge');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'gate-not-passed', reason: `${status} — 검사를 먼저 돌리세요` });
  }
  expect(f.calls.filter((args) => args[1] === 'merge')).toHaveLength(0);
  const unauth = endpoint(sha, false);
  expect((await unauth.post('check')).status).toBe(401);
  expect(unauth.calls).toHaveLength(0);
});
