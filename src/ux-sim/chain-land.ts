/** SIM-CHAIN-LAND runs the production queue end to end; only GitHub and remote gate responses are simulated. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { enqueueL8ShadowQueue, runL8ShadowQueue, statusL8ShadowQueue, type L8ShadowQueueDeps, type L8ShadowVerdict } from '../self-implement/l8-merge-queue.js';
import type { GateRemoteRunner, GateRemoteSettings } from '../self-implement/gate-remote.js';
import { createFakeGh } from './fake-gh.js';
import { createFakeExecutableDevice, type FakeExecutableDevice, type FakeBinCall } from './fake-bin.js';

export type ChainGateOutcome = 'pass' | 'fail' | 'unmeasured';
export type ChainLandInput = {
  readonly prNumbers: readonly number[];
  /** One external gate-host result per production integrated-gate attempt. */
  readonly gateOutcomes: readonly ChainGateOutcome[];
  readonly staleLock?: boolean;
  /** Require the production queue fixture to carry the world-verified retest commit. */
  readonly expectedHead?: string;
  /** Invoke the real queue on subsequent ticks until every enqueued PR has a receipt or a gate blocks it. */
  readonly drainQueue?: boolean;
};
export type ChainLandResult = {
  readonly enqueued: number[];
  readonly head: string;
  readonly headReceipts: { number: number; head: string }[];
  readonly pending: number[];
  readonly gateRuns: { host: string; outcome: ChainGateOutcome }[];
  readonly verdicts: L8ShadowVerdict[];
  /** The exact production disposition returned by runL8ShadowQueue (null when no item could be processed). */
  readonly disposition: L8ShadowVerdict | null;
  readonly ghCalls: FakeBinCall[];
  readonly integrationCalls: number;
  readonly lock: 'acquired' | 'stale';
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeFile(root: string, path: string, value: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function createGitFixture(root: string, prNumbers: readonly number[]): { cwd: string; head: string; files: string[] } {
  const remote = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const cwd = join(root, 'checkout');
  execFileSync('git', ['init', '--quiet', '--bare', remote]);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', seed]);
  git(seed, 'config', 'user.name', 'SIM-CHAIN-LAND');
  git(seed, 'config', 'user.email', 'sim-chain-land@localhost');
  writeFile(seed, 'src/feature.ts', 'export const feature = 0;\n');
  writeFile(seed, 'test/feature.test.ts', "import { expect, test } from 'bun:test';\nimport { feature } from '../src/feature.js';\ntest('feature', () => expect(feature).toBe(1));\n");
  git(seed, 'add', '.');
  execFileSync('git', ['commit', '-qm', 'main baseline'], { cwd: seed,
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-05T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-05T00:00:00Z' } });
  const base = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-qb', 'queued-change');
  writeFile(seed, 'src/feature.ts', 'export const feature = 1;\n');
  git(seed, 'add', '.');
  execFileSync('git', ['commit', '-qm', 'queued feature'], { cwd: seed,
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-05T00:00:01Z', GIT_COMMITTER_DATE: '2026-11-05T00:00:01Z' } });
  const head = git(seed, 'rev-parse', 'HEAD');
  const files = git(seed, 'diff', '--name-only', `${base}...${head}`).split('\n').filter(Boolean);
  for (const number of prNumbers) git(seed, 'push', '-q', 'origin', `HEAD:refs/pull/${number}/head`);
  execFileSync('git', ['clone', '--quiet', remote, cwd]);
  return { cwd, head, files };
}

function makeGhAndBin(prNumbers: readonly number[], head: string, files: string[]): { bins: FakeExecutableDevice; dispose: () => void } {
  const timestamp = '2026-11-05T00:00:00Z';
  const fakeGh = createFakeGh({ prs: prNumbers.map((number) => ({
    number, title: `SIM-CHAIN-LAND #${number}`, branch: `sim/chain-${number}`, head,
    createdAt: timestamp, updatedAt: timestamp, files,
  })), repository: 'elanous/sim-chain-land' });
  const fields = 'headRefOid,baseRefName,state,isDraft,isCrossRepository,files';
  const ghView = fakeGh.api(['pr', 'view', String(prNumbers[0]), '--json', fields]);
  const bins = createFakeExecutableDevice({ gh: { stdout: `${ghView}\n` } });
  return { bins, dispose: () => bins.cleanup() };
}

/** Invoke enqueueL8ShadowQueue, then runL8ShadowQueue itself against real temporary Git remotes/worktrees. */
export async function simulateChainLand(input: ChainLandInput): Promise<ChainLandResult> {
  if (!input.prNumbers.length) throw new Error('PR numbers must be non-empty');
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-chain-land-'));
  let ghDevice: ReturnType<typeof makeGhAndBin> | undefined;
  try {
    const fixture = createGitFixture(root, input.prNumbers);
    if (input.expectedHead && fixture.head !== input.expectedHead) throw new Error(`production queue head differs from world retest: ${fixture.head}`);
    ghDevice = makeGhAndBin(input.prNumbers, fixture.head, fixture.files);
    let integrationCalls = 0;
    const command: NonNullable<L8ShadowQueueDeps['command']> = (bin, args, cwd) => {
      if (bin === 'gh') {
        const result = ghDevice!.bins.run('gh', args, { cwd });
        return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error ?? '' };
      }
      if (bin === 'git' && args.some((arg) => arg === 'merge-tree' || arg === 'commit-tree')) integrationCalls++;
      const result = spawnSync(bin, [...args], { cwd, encoding: 'utf8', timeout: 60_000 });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
    };
    const gateRuns: ChainLandResult['gateRuns'][number][] = [];
    let gateAttempts = 0;
    const gateSettings: GateRemoteSettings = {
      enabled: true, host: 'node-b', mirror: join(root, 'gate-mirror.git'), loadThreshold: 20,
      hostCap: 2, hostCaps: {}, slotWaitSeconds: 0,
    };
    const gateRunner: GateRemoteRunner = {
      local(bin, args, cwd) {
        if (bin === 'git' && args[0] === 'push' && args.some((arg) => arg.startsWith('node-b:'))) {
          return { rc: 0, stdout: '', stderr: '' };
        }
        const result = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 60_000 });
        return { rc: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
      },
      ssh(host) {
        const outcome = input.gateOutcomes[gateAttempts++] ?? 'unmeasured';
        gateRuns.push({ host, outcome });
        return outcome === 'unmeasured'
          ? { rc: 255, stdout: '', stderr: 'injected remote gate unavailable' }
          : { rc: 0, stdout: '', stderr: `\n__GATE_REMOTE_RC=${outcome === 'pass' ? 0 : 1}\n` };
      },
    };
    const deps: L8ShadowQueueDeps = {
      command,
      rulesPreflight: async () => ({ outcome: 'pass', detail: 'simulation rules preflight passed' }),
      lock: { waitMs: 0 },
      observeEnqueue: () => {},
      observe: () => {},
      trainGateRunner: gateRunner,
      trainGateSettings: gateSettings,
    };
    const enqueued: number[] = [];
    for (const number of input.prNumbers) {
      await enqueueL8ShadowQueue(fixture.cwd, number, deps);
      enqueued.push(number);
    }
    const gitDir = resolve(fixture.cwd, git(fixture.cwd, 'rev-parse', '--git-common-dir'));
    const staleLockDir = join(gitDir, 'elanous-l8-merge-queue');
    if (input.staleLock) mkdirSync(staleLockDir);

    let lock: ChainLandResult['lock'] = 'acquired';
    let disposition: L8ShadowVerdict | null = null;
    try {
      let attempts = 0;
      do {
        const next = await runL8ShadowQueue(fixture.cwd, deps);
        if (next) disposition = next;
        attempts++;
        const snapshot = await statusL8ShadowQueue(fixture.cwd, deps);
        if (!input.drainQueue || snapshot.pending.length === 0 || attempts >= input.prNumbers.length || next?.verdict !== 'pass') break;
      } while (true);
    }
    catch (error) {
      if (!input.staleLock || !String(error).includes('merge queue occupied')) throw error;
      lock = 'stale';
      disposition = null;
    }
    if (input.staleLock) rmSync(staleLockDir, { recursive: true, force: true });
    const state = await statusL8ShadowQueue(fixture.cwd, deps);
    return {
      enqueued,
      head: fixture.head,
      headReceipts: input.prNumbers.map((number) => ({ number, head: fixture.head })),
      pending: state.pending.map(({ number }) => number),
      gateRuns,
      verdicts: state.verdicts,
      disposition,
      ghCalls: ghDevice!.bins.calls(),
      integrationCalls,
      lock,
    };
  } finally {
    ghDevice?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}
