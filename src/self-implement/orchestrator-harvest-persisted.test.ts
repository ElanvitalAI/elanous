import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHarvestPrBody, runSelfImplement, updateHarvestPrBody } from './orchestrator.js';
import { seams as baseSeams } from './test-seams.js';
import type { SelfImplementSeams } from './orchestrator.js';
import { defaultSeams } from './seams.js';
import type { PrManager } from '../autopilot/pr-manager.js';
import { loadRunLedger, runLedgerPath } from './run-ledger.js';
import { runDraftSweep } from '../self-dev/draft-sweep.js';
import { githubDraftSweepAdapters } from '../harness/harness-cli-command.js';
import { listRunLedgers } from './run-ledger.js';

const tempDirs: string[] = [];
const originalStateDir = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
});
const seams = (over: Partial<SelfImplementSeams>): SelfImplementSeams => baseSeams({
  inspectCodexRotation: (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 0 })) as SelfImplementSeams['inspectCodexRotation'],
  ...over,
});

test('failed gh harvest commands reject asynchronously without blocking the event loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f6-gh-failure-'));
  tempDirs.push(dir);
  const gh = join(dir, 'gh');
  writeFileSync(gh, '#!/bin/sh\nsleep 0.2\necho simulated-github-failure >&2\nexit 1\n');
  chmodSync(gh, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ''}`;
  try {
    for (const invoke of [
      () => readHarvestPrBody({ number: 30620, cwd: dir }),
      () => updateHarvestPrBody({ number: 30620, cwd: dir, body: 'fixture' }),
    ]) {
      let statusRecorded = false;
      const pending = invoke().catch((error: unknown) => error);
      await new Promise<void>((resolve) => setTimeout(() => { statusRecorded = true; resolve(); }, 20));
      expect(statusRecorded).toBe(true);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('simulated-github-failure');
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('failed production run persists PR body and same-universe draft sweep keeps it; running PR body stays unchanged', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'f6-harvest-state-'));
  tempDirs.push(stateDir);
  process.env.ELANOUS_STATE_DIR = stateDir;
  const artifactPath = join(stateDir, 'pr-body.md');
  const ghDir = join(stateDir, 'bin');
  const ghPath = join(ghDir, 'gh');
  const runningMarker = 'F6_IN_FLIGHT_BODY_MARKER';
  const prNumber = 30620;
  const prUrl = `https://github.com/fixture/repo/pull/${prNumber}`;
  const previousPath = process.env.PATH;
  let upsertBody: string | undefined;
  const activeRunId = `run-${crypto.randomUUID()}`;
  let editCount = 0;
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(ghPath, `#!/bin/sh
set -eu
if [ "$1 $2" = "pr view" ]; then
  printf '{"body":'; /usr/bin/python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()), end="")' '${artifactPath}'
  printf ',"state":"OPEN","isDraft":true}'
elif [ "$1 $2" = "pr edit" ]; then
  shift 3
  [ "$1" = "--body" ]
  shift
  printf '%s' "$1" > '${artifactPath}'
  printf 'edit\n' >> '${join(stateDir, 'gh-calls.log')}'
else
  echo "unexpected gh invocation: $*" >&2
  exit 2
fi
`);
  chmodSync(ghPath, 0o755);
  process.env.PATH = `${ghDir}:${previousPath ?? ''}`;
  const prManager = {
    upsertPr: (input: { body: string }) => {
      upsertBody = input.body;
      writeFileSync(artifactPath, input.body);
      return { ok: true as const, url: prUrl };
    },
  } as unknown as PrManager;
  const production = defaultSeams({ prManager });
  const result = await runSelfImplement({
    feature: 'persisted harvest failure fixture',
    runId: activeRunId,
    seams: seams({
      writeRunLedger: undefined,
      openPr: production.openPr,
      readPrBodyForHarvest: production.readPrBodyForHarvest,
      updatePrBodyForHarvest: async (input) => {
        expect(activeRunId).toBeDefined();
        const entries = loadRunLedger(activeRunId!);
        expect(entries?.filter((entry) => entry.event === 'run-status').at(-1)?.data.runStatus).toBe('failed');
        await production.updatePrBodyForHarvest!(input);
      },
      createWorktree: async () => ({ path: stateDir, branch: 'self-impl/fixture', base: 'main', headSha: 'test-head' }),
      removeWorktree: async () => {},
      implement: async () => ({ ok: false, summary: 'deliberate fixture failure' }),
      preservationHasChanges: () => true,
      readPrFiles: async () => ['fixture.ts'],
    }),
  }).finally(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  expect(upsertBody).toBeDefined();
  expect(activeRunId).toBe(result.runId);
  expect(existsSync(runLedgerPath(result.runId))).toBe(true);
  expect(loadRunLedger(result.runId)?.filter((entry) => entry.event === 'run-status').at(-1)?.data.runStatus).toBe('failed');
  expect(readFileSync(artifactPath, 'utf8')).toContain('수확보류: harvest-deferred');
  expect(readFileSync(artifactPath, 'utf8').match(/수확보류: harvest-deferred/g)).toHaveLength(1);
  expect(readFileSync(join(stateDir, 'gh-calls.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(result).toMatchObject({ stage: 'aborted', ok: false, prNumber });
  expect(existsSync(artifactPath)).toBe(true);
  const storedBody = readFileSync(artifactPath, 'utf8');
  expect(storedBody).toContain('수확보류: harvest-deferred');

  const owner = listRunLedgers().matches.find((match) => match.entries.some((entry) =>
    entry.event === 'pr-opened' && entry.data.url === prUrl && entry.data.number === prNumber));
  expect(owner?.runId).toBe(result.runId);
  const gh = (args: string[]): string => {
    if (args[0] !== 'api' || args[1] === 'graphql') throw new Error('GraphQL unavailable');
    const endpoint = args[1] ?? '';
    if (/pulls\?state=open.*&page=1$/.test(endpoint)) return JSON.stringify([{
      number: prNumber, draft: true, state: 'open', title: 'persisted harvest failure fixture',
      body: readFileSync(artifactPath, 'utf8'), head: { ref: 'self-impl/fixture', sha: 'test-head' },
      base: { ref: 'main' }, labels: [{ name: 'elanous:harvestable' }],
      created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z', merged_at: null,
    }]);
    if (/pulls\?state=(open|closed).*&page=\d+$/.test(endpoint)) return '[]';
    if (/\/pulls\/\d+\/files\?per_page=100&page=1$/.test(endpoint)) return JSON.stringify([{ filename: 'fixture.ts' }]);
    if (/\/pulls\/\d+\/reviews\?per_page=100&page=\d+$/.test(endpoint)
      || /\/pulls\/\d+\/commits\?per_page=100&page=\d+$/.test(endpoint)
      || /\/issues\/\d+\/comments\?per_page=100&page=\d+$/.test(endpoint)) return '[]';
    if (/\/pulls\/\d+$/.test(endpoint)) return JSON.stringify({ head: { sha: 'test-head' } });
    if (/\/commits\/test-head\/status$/.test(endpoint)) return JSON.stringify({ state: 'success' });
    if (/\/commits\/test-head\/check-runs\?per_page=100&page=\d+$/.test(endpoint)) return JSON.stringify({ total_count: 0, check_runs: [] });
    throw new Error(`unexpected gh endpoint: ${endpoint}`);
  };
  const git = (_cwd: string, args: string[]) => ({ status: 0, stderr: '',
    stdout: args[0] === 'config' ? 'https://github.com/fixture/repo.git\n' : 'worktree /tmp/main\nbranch refs/heads/main\n' });
  const adapters = githubDraftSweepAdapters(gh, git, stateDir);
  const drafts = await adapters.listDrafts(1, 100, 'fixture/repo');
  expect(drafts[0]?.runId).toBe(result.runId);
  expect(await adapters.getRunStatus(drafts[0]!, 'fixture/repo')).toBe('failed');
  const swept = await runDraftSweep({ repository: 'fixture/repo', adapters, now: new Date(), apply: false });
  expect(swept.complete).toBe(true);
  expect(swept.entries.find((entry) => entry.number === prNumber)).toMatchObject({ action: 'keep', reason: 'harvest-deferred' });

  // Exercise the true in-flight path: hold production orchestration after PR open, before terminal classification.
  let entered!: () => void;
  let release!: () => void;
  const atPostOpen = new Promise<void>((resolve) => { entered = resolve; });
  const waitToFinish = new Promise<void>((resolve) => { release = resolve; });
  const runningPath = join(stateDir, 'in-flight-pr-body.md');
  writeFileSync(runningPath, runningMarker);
  const inFlight = runSelfImplement({
    feature: 'in-flight body immutability fixture',
    seams: seams({
      openPr: async () => ({ url: 'https://example.invalid/pull/30621', number: 30621 }),
      readPrFiles: async () => { entered(); await waitToFinish; return ['fixture.ts']; },
      readPrBodyForHarvest: async () => ({ state: 'OPEN', isDraft: true, body: readFileSync(runningPath, 'utf8') }),
      updatePrBodyForHarvest: async ({ body }) => { writeFileSync(runningPath, body); },
    }),
  });
  try {
    await atPostOpen;
    expect(readFileSync(runningPath, 'utf8')).toBe(runningMarker);
  } finally { release(); }
  await inFlight;
  expect(readFileSync(runningPath, 'utf8')).toBe(runningMarker);
});
