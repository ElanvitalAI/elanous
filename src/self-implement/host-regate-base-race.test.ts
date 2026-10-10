import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { runHostRegate, type HostRegateDeps } from './host-regate.js';

const HEAD = 'a'.repeat(40);
const BASE_A = 'b'.repeat(40);
const BASE_B = 'c'.repeat(40);
const PR_VIEW = 'gh pr view 42 --json headRefOid,baseRefName,baseRefOid,state,isDraft';
const BASE_FETCH = 'git fetch origin refs/heads/main';
const HEAD_FETCH = 'git fetch origin refs/pull/42/head';
const input = { prNumber: 42, headCommit: HEAD, repoRoot: '/repo' };

function fixture(views: string[], fetchedBase: string, fetchedHead = HEAD) {
  const calls: string[] = [];
  const events: string[] = [];
  let lastFetch = '';
  let viewReads = 0;
  let measured = 0;
  const deps: HostRegateDeps = {
    acquire: async () => () => {},
    makeTemp: () => '/tmp/regate-base-race-fixture',
    removeTemp: () => {},
    interference: async () => { measured++; return { passed: false, detail: 'stopped after base measurement' }; },
    log: (event) => { events.push(event); },
    command: (bin, args) => {
      const call = `${bin} ${args.join(' ')}`;
      calls.push(call);
      if (call === PR_VIEW) {
        const baseRefOid = views[Math.min(viewReads++, views.length - 1)];
        return { status: 0, stdout: JSON.stringify({ headRefOid: HEAD, baseRefName: 'main', baseRefOid, state: 'OPEN', isDraft: false }), stderr: '' };
      }
      if (call === BASE_FETCH || call === HEAD_FETCH) lastFetch = call;
      let stdout = '';
      if (call === 'git rev-parse FETCH_HEAD') stdout = lastFetch === BASE_FETCH ? fetchedBase : fetchedHead;
      if (call === 'git rev-parse HEAD') stdout = fetchedBase;
      if (call === 'git rev-parse HEAD^1') stdout = fetchedBase;
      if (call === 'git rev-parse HEAD^2') stdout = HEAD;
      if (call === `git merge-base ${fetchedBase} ${HEAD}`) stdout = BASE_A;
      if (call === `git diff --name-only ${BASE_A} ${HEAD}`) stdout = 'src/feature.test.ts\n';
      return { status: 0, stdout, stderr: '' };
    },
  };
  return { deps, calls, events, measured: () => measured };
}

function retryLog() {
  const entries: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const original = debug.log;
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
    entries.push({ category, event, data });
  }) as typeof original);
  return { entries, restore: () => spy.mockRestore() };
}

const retries = (entries: ReturnType<typeof retryLog>['entries']) => entries.filter(({ category, event }) => category === 'harness.host-regate' && event === 'base-moved-retry');

describe('host regate: PR base moves between view and fetch', () => {
  test('re-reads and fetches after one mismatch; only the matched B is measured', async () => {
    const { deps, calls, measured } = fixture([BASE_A, BASE_B], BASE_B);
    const log = retryLog();
    try {
      const before = Date.now();
      const result = await runHostRegate(input, deps);
      expect(Date.now() - before).toBeGreaterThanOrEqual(950);
      expect(result.failures).toEqual([{ step: 'test-interference', detail: 'stopped after base measurement' }]);
      expect(measured()).toBe(1);
      expect(calls.slice(0, 8)).toEqual([PR_VIEW, BASE_FETCH, 'git rev-parse FETCH_HEAD', PR_VIEW, BASE_FETCH, 'git rev-parse FETCH_HEAD', HEAD_FETCH, 'git rev-parse FETCH_HEAD']);
      expect(calls).toContain(`git worktree add --detach /tmp/regate-base-race-fixture ${BASE_B}`);
      expect(calls).toContain(`git merge-base ${BASE_B} ${HEAD}`);
      expect(calls).not.toContain(`git worktree add --detach /tmp/regate-base-race-fixture ${BASE_A}`);
      expect(retries(log.entries)).toEqual([{ category: 'harness.host-regate', event: 'base-moved-retry', data: { pr: 42, attempt: 1, checked: BASE_A, fetched: BASE_B } }]);
    } finally { log.restore(); }
  });

  test('REGATE-STALE-BASE: three mismatches measure on the fetched tip and record the stale PR base instead of failing', async () => {
    const { deps, calls, events, measured } = fixture([BASE_A], BASE_B);
    const log = retryLog();
    try {
      const before = Date.now();
      const result = await runHostRegate(input, deps);
      expect(Date.now() - before).toBeGreaterThanOrEqual(1950);
      // The fixture's interference stops after the base measurement — reaching it proves the stale base no longer fails the regate.
      expect(result).toMatchObject({ passed: false, failures: [{ step: 'test-interference' }] });
      expect(result.failures.some((failure) => failure.detail.includes('fetched PR base differs'))).toBe(false);
      expect(events).not.toContain('unmeasured');
      expect(calls.filter((call) => call === PR_VIEW)).toHaveLength(3);
      expect(calls.filter((call) => call === BASE_FETCH)).toHaveLength(3);
      expect(calls).toContain(HEAD_FETCH);
      expect(calls).toContain(`git worktree add --detach /tmp/regate-base-race-fixture ${BASE_B}`);
      expect(measured()).toBe(1);
      expect(retries(log.entries)).toEqual([1, 2, 3].map((attempt) => ({ category: 'harness.host-regate', event: 'base-moved-retry', data: { pr: 42, attempt, checked: BASE_A, fetched: BASE_B } })));
      expect(log.entries.filter(({ category, event }) => category === 'harness.host-regate' && event === 'base-stale'))
        .toEqual([{ category: 'harness.host-regate', event: 'base-stale', data: { pr: 42, prBaseRefOidInitial: BASE_A, prBaseRefOid: BASE_A, fetched: BASE_B, candidateBase: BASE_B } }]);
    } finally { log.restore(); }
  });

  test('REGATE-STALE-BASE: a PR base that changes during the re-reads (A → C, fetched B) keeps the initial A in the observation', async () => {
    const BASE_C = 'd'.repeat(40);
    const { deps, calls, measured } = fixture([BASE_A, BASE_C], BASE_B);
    const log = retryLog();
    try {
      await runHostRegate(input, deps);
      expect(measured()).toBe(1);
      expect(calls).toContain(`git worktree add --detach /tmp/regate-base-race-fixture ${BASE_B}`);
      expect(log.entries.filter(({ event }) => event === 'base-stale').map(({ data }) => data))
        .toEqual([{ pr: 42, prBaseRefOidInitial: BASE_A, prBaseRefOid: BASE_C, fetched: BASE_B, candidateBase: BASE_B }]);
    } finally { log.restore(); }
  });

  test('matching base preserves the initial call order and mismatched head fails immediately', async () => {
    const { deps, calls, events, measured } = fixture([BASE_A], BASE_A, BASE_B);
    const log = retryLog();
    try {
      const result = await runHostRegate(input, deps);
      expect(result).toMatchObject({ passed: false, failures: [{ step: 'worktree', detail: 'Error: fetched PR head differs from checked SHA' }] });
      expect(events).toContain('unmeasured');
      expect(calls.slice(0, 5)).toEqual([PR_VIEW, BASE_FETCH, 'git rev-parse FETCH_HEAD', HEAD_FETCH, 'git rev-parse FETCH_HEAD']);
      expect(calls.filter((call) => call === PR_VIEW)).toHaveLength(1);
      expect(calls.some((call) => call.startsWith('git worktree add'))).toBe(false);
      expect(measured()).toBe(0);
      expect(retries(log.entries)).toEqual([]);
    } finally { log.restore(); }
  });

  test('verifyOnly still measures the fetched tip without base retries', async () => {
    const { deps, calls, measured } = fixture([BASE_A], BASE_B);
    const log = retryLog();
    try {
      const result = await runHostRegate({ ...input, verifyOnly: true }, deps);
      expect(result).toMatchObject({ status: 'failed', baseCommit: BASE_B, failures: [{ step: 'test-interference' }] });
      expect(measured()).toBe(1);
      expect(calls.slice(0, 5)).toEqual([PR_VIEW, BASE_FETCH, 'git rev-parse FETCH_HEAD', HEAD_FETCH, 'git rev-parse FETCH_HEAD']);
      expect(calls).toContain(`git worktree add --detach /tmp/regate-base-race-fixture ${BASE_B}`);
      expect(retries(log.entries)).toEqual([]);
    } finally { log.restore(); }
  });
});
