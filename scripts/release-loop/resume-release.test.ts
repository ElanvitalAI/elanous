import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { acquireOpSeatFlock, opSeatFlockPath, resyncTickWithReleaseProbe } from '../../src/steward/resync-tick.js';
import { resumeReleaseRun } from './resume-release.js';

const SHA = 'a'.repeat(40);
const VERSION = '0.2.19';

function writeFailedRun(root: string, runId = 'r'): { statePath: string; original: string } {
  const statePath = join(root, 'graph-runs', 'release-loop', `${runId}.json`);
  mkdirSync(join(root, 'graph-runs', 'release-loop'), { recursive: true });
  const state = {
    graphId: 'release-loop', runId, status: 'failed',
    input: { version: VERSION, branchCut: true },
    path: ['version-release', 'gate', 'tui', 'failed'],
    nodes: [
      { nodeId: 'version-release', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }) },
      { nodeId: 'gate', ok: true, exit: 0, executed: true, output: '{"outcome":"ok"}' },
      { nodeId: 'tui', ok: false, exit: 1, executed: true, output: '{"outcome":"fail"}' },
      { nodeId: 'failed', ok: true, exit: 0, executed: false },
    ],
    executed: 3, dryRun: false, statePath,
  };
  writeFileSync(statePath, JSON.stringify(state));
  return { statePath, original: readFileSync(statePath, 'utf8') };
}

function gitStub(args: string[]): string {
  if (args[0] === 'ls-remote') return `${SHA}\trefs/heads/release/${VERSION}`;
  if (args[0] === 'rev-parse') return SHA;
  return '';
}

/** Real git against the temporary OP seat (hermetic: no system/global config, identity passed inline). */
function seatGit(seat: string, ...args: string[]): string {
  const out = spawnSync('git', ['-c', 'user.name=seat-test', '-c', 'user.email=seat-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: seat, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: seat, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

/** One OP-seat mutation as the real paths do it — work file, index, HEAD — recording when it entered and left. */
async function mutateSeat(seat: string, label: string, spans: Array<{ label: string; enter: number; exit: number }>, hold?: Promise<void>): Promise<string> {
  const enter = performance.now();
  writeFileSync(join(seat, 'workfile'), `work-${label}\n`);
  seatGit(seat, 'add', 'workfile');
  seatGit(seat, 'commit', '-q', '-m', label);
  if (hold) await hold;
  spans.push({ label, enter, exit: performance.now() });
  return seatGit(seat, 'rev-parse', 'HEAD');
}

test('out-of-window manual resume and resync started together serialize on one OP-seat flock over a real git seat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resume-resync-flock-'));
  setElanousConfigDir(root);
  const seat = join(root, 'op-seat');
  mkdirSync(seat, { recursive: true });
  seatGit(seat, 'init', '-q');
  writeFileSync(join(seat, 'workfile'), 'work-v1\n');
  seatGit(seat, 'add', 'workfile');
  seatGit(seat, 'commit', '-q', '-m', 'base');
  const base = seatGit(seat, 'rev-parse', 'HEAD');
  const { statePath, original } = writeFailedRun(root);
  try {
    const spans: Array<{ label: string; enter: number; exit: number }> = [];
    let resumeHead = '';
    let resyncHead = '';
    let resumeEntered = false;
    let resyncEntered = false;
    let releaseResume!: () => void;
    const resumeHeld = new Promise<void>((resolve) => { releaseResume = resolve; });
    // No injected root on either side: both resolve the lock through the shared OP-seat root (here the --config-dir universe).
    const resume = resumeReleaseRun({ runId: 'r', from: 'tui' }, {
      git: gitStub,
      isAncestor: () => true,
      graph: async () => {
        resumeEntered = true;
        resumeHead = await mutateSeat(seat, 'resume', spans, resumeHeld);
        return { status: 'done', runId: 'r' } as never;
      },
    });
    while (!resumeEntered) await Bun.sleep(5);
    const resync = resyncTickWithReleaseProbe(async () => {
      resyncEntered = true;
      resyncHead = await mutateSeat(seat, 'resync', spans);
      return { candidates: 1, tried: 1, saved: 1, savedRatio: 1 };
    }, () => {}, join(root, 'steward', 'resync-pending.json'), () => 'idle', () => 'outside');
    await Bun.sleep(150);
    // While resume holds the lock, resync has not entered and the seat shows exactly resume's commit with a clean index.
    expect(resyncEntered).toBe(false);
    expect(seatGit(seat, 'log', '--format=%s')).toBe('resume\nbase');
    expect(seatGit(seat, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(seat, 'workfile'), 'utf8')).toBe('work-resume\n');
    releaseResume();
    const [resumed, resynced] = await Promise.all([resume, resync]);
    expect(resumed.state.status).toBe('done');
    expect(resynced.decision).toBe('ran');
    // The critical sections never overlapped: resync entered only after resume left.
    expect(spans.map((span) => span.label)).toEqual(['resume', 'resync']);
    expect(spans[1]!.enter).toBeGreaterThanOrEqual(spans[0]!.exit);
    // Final git state: linear history base → resume → resync, HEAD = resync's commit, index and work tree clean.
    expect(seatGit(seat, 'rev-parse', `${resumeHead}^`)).toBe(base);
    expect(seatGit(seat, 'rev-parse', `${resyncHead}^`)).toBe(resumeHead);
    expect(seatGit(seat, 'rev-parse', 'HEAD')).toBe(resyncHead);
    expect(seatGit(seat, 'log', '--format=%s')).toBe('resync\nresume\nbase');
    expect(seatGit(seat, 'diff', '--cached', '--name-only')).toBe('');
    expect(seatGit(seat, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(seat, 'workfile'), 'utf8')).toBe('work-resync\n');
    const after = await acquireOpSeatFlock(undefined, 1_000);
    expect(after.path).toBe(opSeatFlockPath(root));
    after.release();
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ graphId: 'release-loop', runId: 'r' });
    expect(original.length).toBeGreaterThan(0);
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a resume with an injected ledger root different from the OP-seat root still excludes a default-root resync', async () => {
  const seatRoot = mkdtempSync(join(tmpdir(), 'resume-seat-'));
  const ledger = mkdtempSync(join(tmpdir(), 'resume-ledger-'));
  setElanousConfigDir(seatRoot);
  writeFailedRun(ledger);
  try {
    let resumeEntered = false;
    let resyncEntered = false;
    let releaseResume!: () => void;
    const resumeHeld = new Promise<void>((resolve) => { releaseResume = resolve; });
    const resume = resumeReleaseRun({ runId: 'r', from: 'tui' }, {
      root: ledger,
      git: gitStub,
      isAncestor: () => true,
      graph: async () => { resumeEntered = true; await resumeHeld; return { status: 'done', runId: 'r' } as never; },
    });
    while (!resumeEntered) await Bun.sleep(5);
    // The lock lives at the OP-seat root, not under the injected ledger root.
    await expect(acquireOpSeatFlock(undefined, 60)).rejects.toThrow('OP seat flock timed out');
    const resync = resyncTickWithReleaseProbe(async () => { resyncEntered = true; return { candidates: 0, tried: 0, saved: 0, savedRatio: null }; },
      () => {}, join(seatRoot, 'steward', 'resync-pending.json'), () => 'idle', () => 'outside');
    await Bun.sleep(100);
    expect(resyncEntered).toBe(false);
    releaseResume();
    const [resumed, resynced] = await Promise.all([resume, resync]);
    expect(resumed.state.status).toBe('done');
    expect(resynced.decision).toBe('ran');
    expect(resyncEntered).toBe(true);
    expect(existsSync(join(ledger, 'steward', 'op-seat.flock'))).toBe(false);
  } finally {
    resetElanousConfigDir();
    rmSync(seatRoot, { recursive: true, force: true });
    rmSync(ledger, { recursive: true, force: true });
  }
});
