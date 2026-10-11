// DRAFT-LINEAGE-ONE-1 — the real GitHub draft-sweep adapter stops a superseded live run (`--apply` only) through its
// run stop (here injected in place of `harness stop`), with the run id read from this PR's own run-ledger owner.
import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { githubDraftSweepAdapters, type DraftSweepStopRun } from './harness-cli-command.js';
import { runDraftSweep } from '../self-dev/draft-sweep.js';
import { appendRunLedgerEntry, runLedgerDir } from '../self-implement/run-ledger.js';

// The real adapter reads the run ledger, the running-run table and logs.db like production (seconds under load).
setDefaultTimeout(60_000);

const OLD = { number: 30, branch: 'self-impl/goalid-abc123-first-words-11111111-raaaaaa', created: '2026-10-04T20:00:00Z', head: 'h30' };
const NEW = { number: 31, branch: 'self-impl/goalid-abc123-other-words-22222222-rbbbbbb', created: '2026-10-04T22:00:00Z', head: 'h31' };
const pull = (pr: typeof OLD) => ({
  number: pr.number, draft: true, state: 'open', title: `attempt ${pr.number}`, body: null,
  head: { ref: pr.branch, sha: pr.head }, base: { ref: 'main' }, labels: [],
  created_at: pr.created, updated_at: '2026-10-04T23:30:00Z', merged_at: null, merge_commit_sha: null,
});

function fakeGh(calls: string[]) {
  return (args: string[]): string => {
    calls.push(args.join(' '));
    if (args[0] === 'pr') return '';   // pr edit / pr close
    if (args[0] !== 'api') throw new Error(`unexpected gh ${args.join(' ')}`);
    if (args[1] === 'graphql') throw new Error('GraphQL unavailable');
    const endpoint = args[1]!;
    if (/pulls\?state=open.*&page=1$/.test(endpoint)) return JSON.stringify([pull(OLD), pull(NEW)]);
    if (/pulls\?state=(open|closed).*&page=\d+$/.test(endpoint)) return '[]';
    if (/\/pulls\/\d+\/files\?per_page=100&page=1$/.test(endpoint)) return JSON.stringify([{ filename: 'src/x.ts' }]);
    if (/\/issues\/\d+\/comments\?per_page=100&page=1$/.test(endpoint)) return '[]';
    if (/\/pulls\/\d+\/reviews\?per_page=100$/.test(endpoint)) return '[]';
    if (/\/pulls\/\d+\/commits\?per_page=100&page=1$/.test(endpoint)) return '[]';
    let match: RegExpExecArray | null;
    if ((match = /\/pulls\/(\d+)$/.exec(endpoint))) return JSON.stringify({ head: { sha: `h${match[1]}` } });
    if (/\/commits\/\w+\/status$/.test(endpoint)) return JSON.stringify({ state: 'success' });
    if (/\/commits\/\w+\/check-runs\?per_page=100$/.test(endpoint)) return JSON.stringify({ check_runs: [] });
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
}
// Both attempts still have their worktree (= live branches); the repository matches the sweep target.
const git = (live: string[]) => (_cwd: string, args: string[]) => ({ status: 0, stderr: '',
  stdout: args[0] === 'config' ? 'https://github.com/my/repo.git\n'
    : ['worktree /tmp/main', 'branch refs/heads/main', ...live.flatMap((branch, i) => [`worktree /tmp/w${i}`, `branch refs/heads/${branch}`])].join('\n') + '\n' });

let stateDir = '';
let previous: string | undefined;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'draft-sweep-lineage-stop-'));
  previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = stateDir;
  const dir = runLedgerDir(stateDir);
  appendRunLedgerEntry({ runId: 'run-old-1111', event: 'pr-opened', timestamp: '2026-10-04T20:05:00Z', data: { number: OLD.number, url: `https://github.com/my/repo/pull/${OLD.number}` } }, dir);
  appendRunLedgerEntry({ runId: 'run-new-2222', event: 'pr-opened', timestamp: '2026-10-04T22:05:00Z', data: { number: NEW.number, url: `https://github.com/my/repo/pull/${NEW.number}` } }, dir);
});
afterEach(() => {
  if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
  rmSync(stateDir, { recursive: true, force: true });
});

const run = async (apply: boolean, stopRun: DraftSweepStopRun, live = [OLD.branch, NEW.branch]) => {
  const calls: string[] = [];
  const logged: Array<{ event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { if (category === 'self-dev.draft-sweep') logged.push({ event, data }); });
  try {
    const result = await runDraftSweep({ repository: 'my/repo', apply, now: new Date('2026-10-05T00:00:00Z'),
      adapters: githubDraftSweepAdapters(fakeGh(calls), git(live), '/tmp/main', undefined, stopRun) });
    return { result, writes: calls.filter((call) => call.startsWith('pr ')), logged };
  } finally { log.mockRestore(); }
};

test('--apply: the real adapter stops the older live run via harness stop, then labels and closes its draft · one observation line', async () => {
  const stopped: string[] = [];
  const { result, writes, logged } = await run(true, async (runId) => { stopped.push(runId); return { process: 'stopped', jobsDeleted: 0, scanned: true }; });
  expect(stopped).toEqual(['run-old-1111']);
  expect(result.entries.find((entry) => entry.number === OLD.number)).toMatchObject({ action: 'close', applied: true,
    reason: 'duplicate-of-open #31 (lineage goalid:abc123) · stop run run-old-1111' });
  expect(result.entries.find((entry) => entry.number === NEW.number)).toMatchObject({ action: 'keep' });
  expect(writes).toEqual([
    expect.stringMatching(/^pr edit 30 --repo my\/repo --add-label elanous:superseded/),
    expect.stringMatching(/^pr close 30 --repo my\/repo --comment Draft sweep: duplicate-of-open #31/),
  ]);
  expect(logged.filter((entry) => entry.event === 'supersede-run').map((entry) => entry.data)).toEqual([
    { number: 30, newer: 31, runId: 'run-old-1111', newerRunId: 'run-new-2222', lineageKey: 'goalid:abc123' }]);
});

test('dry-run lists the candidate (with the run it would stop) and stops nothing, writes nothing', async () => {
  const stopped: string[] = [];
  const { result, writes } = await run(false, async (runId) => { stopped.push(runId); return { process: 'stopped', jobsDeleted: 0, scanned: true }; });
  expect(result.entries.find((entry) => entry.number === OLD.number)).toMatchObject({ action: 'close', applied: false,
    reason: 'duplicate-of-open #31 (lineage goalid:abc123) · stop run run-old-1111' });
  expect(stopped).toEqual([]);
  expect(writes).toEqual([]);
});

test('an unconfirmed stop writes nothing and falls through to the existing rules · the failure is observed', async () => {
  const { result, writes, logged } = await run(true, async () => ({ process: 'unmeasured', jobsDeleted: 0, scanned: false }));
  const entry = result.entries.find((item) => item.number === OLD.number);
  expect(entry?.reason).not.toContain('lineage');
  expect(writes).toEqual([]);
  expect(logged.find((item) => item.event === 'supersede-run-failed')?.data).toMatchObject({ runId: 'run-old-1111',
    reason: expect.stringContaining('not confirmed stopped (process unmeasured · jobs 0 · scanned false)') });
  expect(logged.some((item) => item.event === 'supersede-run')).toBe(false);
});

test('a dead run whose worktree remains (absent after a full process scan) counts as stopped: the draft closes', async () => {
  const { result, writes, logged } = await run(true, async () => ({ process: 'absent', jobsDeleted: 0, scanned: true }));
  expect(result.entries.find((entry) => entry.number === OLD.number)).toMatchObject({ action: 'close', applied: true });
  expect(writes).toHaveLength(2);
  expect(logged.some((item) => item.event === 'supersede-run')).toBe(true);
});

test('a newer attempt that is not live never makes the sweep stop the older live run', async () => {
  const stopped: string[] = [];
  const { result, writes, logged } = await run(true, async (runId) => { stopped.push(runId); return { process: 'stopped', jobsDeleted: 0, scanned: true }; }, [OLD.branch]);
  expect(result.entries.find((entry) => entry.number === OLD.number)?.reason).not.toContain('lineage');
  expect(logged.find((item) => item.event === 'lineage-fall-through')?.data).toMatchObject({ number: 30, why: 'lineage-newer-run-not-live' });
  expect(stopped).toEqual([]);
  expect(writes).toEqual([]);
});
