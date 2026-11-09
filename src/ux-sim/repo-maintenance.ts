import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintainHqRepo, type GitRunner, type RefRow } from '../hq/repo-maintenance.js';

const NOW = 1_800_000_000_000;
const oid = (char: string) => char.repeat(40);

export interface RepoMaintenanceSimResult {
  pass: boolean;
  dryRunCandidates: string[];
  appliedDeletions: string[];
  preservedRefs: string[];
  packs: [number, number];
  commandOrder: string[];
  fakeBoundary: string[];
  staleUpdateRefRejected: boolean;
  staleRefPreserved: boolean;
  expiredRefAbsentAfterApply: boolean;
  maintenanceDisabledBeforeMeasurement: boolean;
}

export function maintenanceSetupPrecedesWork(calls: string[]): boolean {
  const measurements = calls.flatMap((call, index) => call.includes('count-objects -v') ? [index] : []);
  if (measurements.length < 2) return false;
  const dryRunMeasurement = measurements[0]!;
  const applyMeasurement = measurements[1]!;
  const gcDisable = calls.findIndex((call, index) => index > dryRunMeasurement && call.endsWith('config --local --replace-all gc.auto 0'));
  const maintenanceDisable = calls.findIndex((call, index) => index > dryRunMeasurement && call.endsWith('config --local --replace-all maintenance.auto false'));
  const firstCompaction = calls.findIndex((call, index) => index > dryRunMeasurement && /(?:pack-refs --all|repack --geometric=2)/.test(call));
  const firstWork = Math.min(applyMeasurement, firstCompaction < 0 ? Number.POSITIVE_INFINITY : firstCompaction);
  return gcDisable >= 0 && maintenanceDisable >= 0
    && gcDisable < firstWork && maintenanceDisable < firstWork;
}

/** Exercise the production HQ maintenance path; only Git/host facts are injected. */
export function simRepoMaintenance(options: { updateRefNoop?: boolean } = {}): RepoMaintenanceSimResult {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-repo-maintenance-'));
  mkdirSync(join(root, 'repo.git'));
  mkdirSync(join(root, 'seat-state', 'OP'), { recursive: true });
  const fakeBoundary: string[] = [];
  const calls: string[] = [];
  let packs = 4_471;
  const refs: RefRow[] = [
    { name: 'refs/remotes/origin/main', oid: oid('a') },
    { name: 'refs/remotes/origin/merged-old', oid: oid('b') },
    { name: 'refs/remotes/origin/open-pr', oid: oid('c') },
    { name: 'refs/heads/live-run', oid: oid('d') },
    { name: 'refs/train-manager/pr/queued', oid: oid('e') },
    { name: 'refs/train-manager/pr/expired', oid: oid('f') },
  ];
  let raceNextDelete = false;
  const run: GitRunner = (_repo, args, _timeout, input) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'true', stderr: '' };
    if (args[0] === 'remote') return { status: 0, stdout: 'https://github.com/example/elanous-agent.git', stderr: '' };
    if (args[0] === 'for-each-ref' && args.some((arg) => arg.startsWith('--merged='))) {
      return { status: 0, stdout: 'refs/remotes/origin/main\nrefs/remotes/origin/merged-old', stderr: '' };
    }
    if (args[0] === 'for-each-ref') {
      return { status: 0, stdout: refs.map((ref) => `${ref.name}\t${ref.oid}`).join('\n'), stderr: '' };
    }
    if (args[0] === 'count-objects') return { status: 0, stdout: `packs: ${packs}`, stderr: '' };
    if (args.includes('fetch')) { fakeBoundary.push('origin-fetch-dry-run'); return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'update-ref' && input) {
      fakeBoundary.push('atomic-ref-update');
      if (options.updateRefNoop) return { status: 0, stdout: '', stderr: '' };
      const deletes = input.split('\n').flatMap((line) => {
        const match = /^delete (\S+) (\S+)$/.exec(line);
        return match ? [{ name: match[1], expected: match[2] }] : [];
      });
      if (raceNextDelete) {
        raceNextDelete = false;
        const target = refs.find((ref) => ref.name === deletes[0]?.name);
        if (target) target.oid = oid('9');
      }
      // `git update-ref --stdin` is a CAS transaction: stale expected OIDs
      // reject the whole transaction and leave every ref untouched.
      if (deletes.some(({ name, expected }) => refs.find((ref) => ref.name === name)?.oid !== expected))
        return { status: 1, stdout: '', stderr: 'cannot lock ref: expected old OID does not match' };
      for (const { name } of deletes) {
        const index = refs.findIndex((ref) => ref.name === name);
        if (index >= 0) refs.splice(index, 1);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'repack') packs = 4;
    return { status: 0, stdout: '', stderr: '' };
  };
  const deps = {
    git: run,
    now: () => NOW,
    openPrRefs: () => new Set(['refs/remotes/origin/open-pr']),
    queuedTrainRefs: () => new Set(['refs/train-manager/pr/queued']),
    activeWorktreeRefs: () => ({ refs: new Set(['refs/heads/live-run']), oids: new Set([oid('d')]) }),
    readRefLogText: (_repo: string, ref: string) => {
      const refRow = refs.find((candidate) => candidate.name === ref);
      if (!refRow) return null;
      const old = Math.floor((NOW - 48 * 60 * 60 * 1000) / 1000);
      return `${oid('1')} ${refRow.oid} Sim <sim@example.test> ${old} +0000\tupdate\n`;
    },
  };
  try {
    const dryRun = maintainHqRepo({ root }, deps);
    const applied = maintainHqRepo({ root, apply: true, expireRefs: true }, deps);
    const expectedDryRunCandidates = ['refs/remotes/origin/merged-old', 'refs/train-manager/pr/expired'];
    const preservedRefs = ['refs/remotes/origin/main', 'refs/remotes/origin/open-pr', 'refs/heads/live-run', 'refs/train-manager/pr/queued'];
    const appliedDeletions = applied.maintenance.deletedRefs;
    const expiredRefAbsentAfterApply = !refs.some((candidate) => candidate.name === 'refs/train-manager/pr/expired');
    const commandOrder = calls.filter((call) => ['config ', 'pack-refs ', 'repack ', 'commit-graph ', 'worktree prune', 'update-ref '].some((prefix) => call.startsWith(prefix)) || call.includes(' fetch '));
    const compactionOrder = [
      'pack-refs --all',
      'repack --geometric=2 -d --write-midx --keep-unreachable',
      'commit-graph write --reachable',
      'worktree prune',
    ];
    const compactionIndexes = compactionOrder.map((command) => commandOrder.indexOf(command));
    const maintenanceDisabledBeforeMeasurement = maintenanceSetupPrecedesWork(calls);
    const pass = JSON.stringify(dryRun.refExpiryPlan.candidates.map((candidate) => candidate.ref)) === JSON.stringify(expectedDryRunCandidates)
      && appliedDeletions.length === 1 && appliedDeletions[0] === 'refs/train-manager/pr/expired'
      && expiredRefAbsentAfterApply
      && preservedRefs.every((ref) => refs.some((candidate) => candidate.name === ref))
      && applied.before.packs === 4_471 && applied.after.packs === 4
      && applied.maintenance.nice === 10;
    let staleUpdateRefRejected = false;
    let staleRefPreserved = false;
    if (expiredRefAbsentAfterApply) {
      refs.push({ name: 'refs/train-manager/pr/expired', oid: oid('f') });
      raceNextDelete = true;
      try { maintainHqRepo({ root, apply: true, expireRefs: true }, deps); }
      catch (error) { staleUpdateRefRejected = String(error).includes('expected old OID does not match'); }
      staleRefPreserved = refs.some((ref) => ref.name === 'refs/train-manager/pr/expired' && ref.oid === oid('9'));
    }
    const fullPass = pass && compactionOrder.every((command) => commandOrder.includes(command))
      && compactionIndexes.every((index, i) => i === 0 || compactionIndexes[i - 1] < index)
      && maintenanceDisabledBeforeMeasurement
      && staleUpdateRefRejected && staleRefPreserved;
    return { pass: fullPass, dryRunCandidates: dryRun.refExpiryPlan.candidates.map((candidate) => candidate.ref),
      appliedDeletions, preservedRefs, packs: [applied.before.packs, applied.after.packs], commandOrder, fakeBoundary,
      staleUpdateRefRejected, staleRefPreserved, expiredRefAbsentAfterApply, maintenanceDisabledBeforeMeasurement };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
