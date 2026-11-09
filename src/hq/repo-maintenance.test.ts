import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHqRepoMaintenanceSchedule, REPO_MAINTENANCE_SCHEDULE_COMMAND } from './repo-maintenance-schedule.js';
import { REF_EXPIRY_CONCURRENCY_WARNING } from './repo-maintenance.js';
import { buildRefExpiryPlan, maintainHqRepo, repoCapAlerts, MAX_REPO_PACKS, MAX_REPO_REFS, REPO_MAINTENANCE_CRON, REPO_REPACK_TIMEOUT_MS, parseOpenPrRefsJson, parseQueuedTrainRefsTsv, parseReflogUpdatedAt, parseWorktreeRefs, type GitRunner, type RefRow } from './repo-maintenance.js';

const OID = 'a'.repeat(40);
const NOW = 1_800_000_000_000;

function refs(): RefRow[] {
  return [
    { name: 'refs/remotes/origin/main', oid: OID },
    { name: 'refs/remotes/origin/merged', oid: 'b'.repeat(40) },
    { name: 'refs/remotes/origin/open-pr', oid: 'c'.repeat(40) },
    { name: 'refs/heads/active-run', oid: 'd'.repeat(40) },
    { name: 'refs/train-manager/pr/35526', oid: 'e'.repeat(40) },
    { name: 'refs/train-manager/pr/35527', oid: 'f'.repeat(40) },
    { name: 'refs/train-manager/pr/35528', oid: '1'.repeat(40) },
  ];
}

function protection() {
  return {
    openPrRefs: new Set(['refs/remotes/origin/open-pr']),
    queuedTrainRefs: new Set(['refs/train-manager/pr/35526']),
    activeWorktreeRefs: { refs: new Set(['refs/heads/active-run']), oids: new Set(['d'.repeat(40)]) },
    refUpdatedAt: new Map([
      ['refs/remotes/origin/merged', NOW - 48 * 60 * 60 * 1000],
      ['refs/train-manager/pr/35526', NOW - 48 * 60 * 60 * 1000],
      ['refs/train-manager/pr/35527', NOW - 48 * 60 * 60 * 1000],
      ['refs/train-manager/pr/35528', NOW - 2 * 60 * 60 * 1000],
    ]),
  };
}

test('an absent or malformed reflog cannot invent a train-ref age', () => {
  expect(parseReflogUpdatedAt(null)).toBeNull();
  expect(parseReflogUpdatedAt('')).toBeNull();
  expect(parseReflogUpdatedAt('not a reflog timestamp')).toBeNull();
  expect(parseReflogUpdatedAt('a'.repeat(40) + ' ' + 'b'.repeat(40) + ' Name <name@example.test> ' + Math.floor(NOW / 1000) + ' +0000\tupdate\n')).toBe(NOW);
  expect(parseReflogUpdatedAt('garbage ' + Math.floor(NOW / 1000) + ' +0000\tupdate\n')).toBeNull();
  expect(parseReflogUpdatedAt('a'.repeat(41) + ' ' + 'b'.repeat(41) + ' Name <name@example.test> ' + Math.floor(NOW / 1000) + ' +0000\tupdate\n')).toBeNull();
  expect(parseReflogUpdatedAt('a'.repeat(40) + ' ' + 'b'.repeat(40) + ' Name <name@example.test> ' + Math.floor(NOW / 1000) + ' +9999\tupdate\n')).toBeNull();
  expect(parseReflogUpdatedAt('a'.repeat(40) + ' ' + 'b'.repeat(40) + ' Name <name@example.test> ' + Math.floor(NOW / 1000) + ' +0000\tupdate\n', 'c'.repeat(40))).toBeNull();
  expect(parseReflogUpdatedAt('a'.repeat(40) + ' ' + 'b'.repeat(40) + ' Name <name@example.test> invalid +0000\tupdate\n')).toBeNull();
});


test('malformed protection source payloads fail closed', () => {
  expect(parseOpenPrRefsJson('[{"headRefName":"feature/login"}]')).toEqual(new Set(['refs/remotes/origin/feature/login']));
  expect(parseOpenPrRefsJson('[{"headRefName":""}]')).toBeNull();
  expect(parseOpenPrRefsJson('[{"headRefName":"bad..name"}]')).toBeNull();
  expect(parseOpenPrRefsJson('[{"headRefName":7}]')).toBeNull();
  expect(parseQueuedTrainRefsTsv('35526\t' + 'a'.repeat(40) + '\tqueued\t/var/tmp/run\n')).toEqual(new Set(['refs/train-manager/pr/35526']));
  expect(parseQueuedTrainRefsTsv('35526\tshort\tqueued\tMVP-A\n')).toBeNull();
  expect(parseQueuedTrainRefsTsv('35526\t' + 'a'.repeat(40) + '\tqueued\n')).toBeNull();
  expect(parseQueuedTrainRefsTsv('35526\t' + 'a'.repeat(40) + '\t\t\n')).toBeNull();
  expect(parseQueuedTrainRefsTsv('35526\t' + 'a'.repeat(40) + '\tqueued\tMVP-A\n35526\t' + 'b'.repeat(40) + '\tqueued\tMVP-B')).toBeNull();
});

test('worktree parser rejects empty, truncated, and malformed successful output', () => {
  expect(parseWorktreeRefs('')).toBeNull();
  expect(parseWorktreeRefs('garbage')).toBeNull();
  expect(parseWorktreeRefs(`worktree /tmp/run\nHEAD ${OID}\nbranch refs/heads/run\nunknown field`)).toBeNull();
  expect(parseWorktreeRefs('worktree /tmp/run\nHEAD deadbeef\nbranch refs/heads/run')).toBeNull();
  expect(parseWorktreeRefs('worktree /tmp/run\nHEAD ' + 'a'.repeat(41) + '\nbranch refs/heads/run')).toBeNull();
  expect(parseWorktreeRefs('worktree /tmp/run\nHEAD ' + OID + '\nbranch refs/heads/bad..name')).toBeNull();
  expect(parseWorktreeRefs('worktree /tmp/bare\nbare\n')).toEqual({ refs: new Set(), oids: new Set() });
  expect(parseWorktreeRefs(`worktree /tmp/run\nHEAD ${OID}\nbranch refs/heads/run\n`)).toEqual({
    refs: new Set(['refs/heads/run']), oids: new Set([OID]),
  });
});

test('expiry plan protects open PR, queued and active refs; only merged or expired refs are candidates', () => {
  const result = buildRefExpiryPlan({ refs: refs(), mergedRefs: new Set(['refs/remotes/origin/main', 'refs/remotes/origin/merged']),
    ...protection(), nowMs: NOW });
  expect(result.applied).toBe(false);
  expect(result.candidates).toEqual([
    { ref: 'refs/remotes/origin/merged', reason: 'merged-origin-branch-older-than-24h' },
    { ref: 'refs/train-manager/pr/35527', reason: 'train-ref-older-than-24h' },
  ]);
  expect(result.protectedRefs).toEqual(['refs/heads/active-run', 'refs/remotes/origin/main', 'refs/remotes/origin/open-pr', 'refs/train-manager/pr/35526']);
  expect(result.keptRefs).toEqual(['refs/train-manager/pr/35528']);
  expect(result.warnings).toEqual([]);
});

test('unavailable protection sources fail closed for their ref namespaces', () => {
  const result = buildRefExpiryPlan({ refs: refs(), mergedRefs: new Set(['refs/remotes/origin/main', 'refs/remotes/origin/merged']),
    openPrRefs: null, queuedTrainRefs: null, activeWorktreeRefs: null, refUpdatedAt: new Map(), nowMs: NOW });
  expect(result.candidates).toEqual([]);
  expect(result.protectedRefs).toHaveLength(refs().length);
  expect(result.warnings).toContain('active-worktrees-unavailable: all refs protected');
  expect(result.warnings).toContain('open-pr-heads-unavailable: all origin refs protected');
  expect(result.warnings).toContain('train-queue-unavailable: all train-manager refs protected');
  expect(result.warnings).toContain('train-ref-age-unavailable: refs/train-manager/pr/35526');
  expect(result.warnings).toContain('origin-ref-age-unavailable: refs/remotes/origin/merged');
});

function scenario() {
  const root = mkdtempSync(join(tmpdir(), 'hq-repo-maintenance-'));
  mkdirSync(join(root, 'seat-state', 'OP'), { recursive: true });
  const calls: string[][] = [];
  const timeouts: Array<{ args: string[]; timeout: number }> = [];
  const inputs: Array<{ args: string[]; input?: string }> = [];
  const queueLockObservedDuringUpdateRef: boolean[] = [];
  let clock = NOW;
  const rows = refs().map(({ name, oid }) => `${name}\t${oid}`).join('\n');
  const git: GitRunner = (_repo, args, timeout, input) => {
    calls.push(args);
    timeouts.push({ args, timeout });
    inputs.push({ args, input });
    if (args[0] === 'update-ref') queueLockObservedDuringUpdateRef.push(existsSync(join(root, 'seat-state', 'OP', 'land-queue.tsv.lock')));
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'true\n', stderr: '' };
    if (args[0] === 'remote') return { status: 0, stdout: 'https://github.com/org/repo.git\n', stderr: '' };
    if (args[0] === 'for-each-ref' && args.includes('--merged=refs/remotes/origin/main')) {
      return { status: 0, stdout: 'refs/remotes/origin/main\nrefs/remotes/origin/merged\n', stderr: '' };
    }
    if (args[0] === 'for-each-ref') return { status: 0, stdout: `${rows}\n`, stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: `worktree /tmp/run\nHEAD ${'d'.repeat(40)}\nbranch refs/heads/active-run\n`, stderr: '' };
    if (args[0] === 'count-objects') return { status: 0, stdout: 'packs: 3\n', stderr: '' };
    if (args.includes('fetch')) { clock += 17; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  const deps = { git, now: () => clock,
    openPrRefs: () => new Set(['refs/remotes/origin/open-pr']),
    queuedTrainRefs: () => new Set(['refs/train-manager/pr/35526']),
    activeWorktreeRefs: () => ({ refs: new Set(['refs/heads/active-run']), oids: new Set(['d'.repeat(40)]) }),
    readRefLogText: (_repo: string, ref: string) => {
      const age = ref.endsWith('/35528') ? 2 : 48;
      const newOid = ref.endsWith('/35526') ? 'e'.repeat(40) : ref.endsWith('/35527') ? 'f'.repeat(40) : ref.endsWith('/35528') ? '1'.repeat(40) : 'b'.repeat(40);
      return 'a'.repeat(40) + ' ' + newOid + ' Name <name@example.test> ' + Math.floor((NOW - age * 60 * 60 * 1000) / 1000) + ' +0000\tupdate\n';
    },
  };
  return { root, calls, timeouts, inputs, queueLockObservedDuringUpdateRef, deps, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('default maintenance root resolves to the HQ bare mirror without touching it', () => {
  const s = scenario();
  try {
    const result = maintainHqRepo({}, s.deps);
    expect(result.repo.endsWith('/elanous-hq/repo.git')).toBe(true);
    expect(s.calls.some((args) => args.includes('update-ref') || args.includes('delete-ref'))).toBe(false);
  } finally { s.cleanup(); }
});

test('dry-run reports expiry candidates and measures without writing refs or running maintenance', () => {
  const s = scenario();
  try {
    const result = maintainHqRepo({ root: s.root }, s.deps);
    expect(result.outcome).toBe('dry-run');
    expect(result.refExpiryPlan.candidates).toHaveLength(2);
    expect(result.refExpiryPlan.applied).toBe(false);
    expect(result.before).toEqual({ packs: 3, refs: 7, fetchMs: 17 });
    expect(result.after).toEqual(result.before);
    expect(s.calls.some((args) => ['pack-refs', 'repack', 'commit-graph'].includes(args[0]!))).toBe(false);
    expect(s.calls.some((args) => args.includes('update-ref') || args.includes('delete-ref'))).toBe(false);
    const fetch = s.calls.find((args) => args.includes('fetch'))!;
    expect(fetch).toContain('gc.auto=0');
    expect(fetch).toContain('maintenance.auto=false');
  } finally { s.cleanup(); }
});

test('apply compacts packs and metadata only, preserving every ref and unreachable object', () => {
  const s = scenario();
  try {
    const result = maintainHqRepo({ root: s.root, apply: true }, s.deps);
    expect(result.outcome).toBe('applied');
    expect(result.refExpiryPlan.applied).toBe(false);
    expect(s.calls).toContainEqual(['config', '--local', '--replace-all', 'gc.auto', '0']);
    expect(s.calls).toContainEqual(['config', '--local', '--replace-all', 'maintenance.auto', 'false']);
    expect(s.calls).toContainEqual(['pack-refs', '--all']);
    expect(s.calls).toContainEqual(['repack', '--geometric=2', '-d', '--write-midx', '--keep-unreachable']);
    expect(s.timeouts.find(({ args }) => args[0] === 'repack')?.timeout).toBe(REPO_REPACK_TIMEOUT_MS);
    expect(REPO_REPACK_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(s.calls).toContainEqual(['commit-graph', 'write', '--reachable']);
    expect(s.calls).toContainEqual(['worktree', 'prune']);
    const fetch = s.calls.find((args) => args.includes('fetch'))!;
    expect(fetch).toContain('gc.auto=0');
    expect(fetch).toContain('maintenance.auto=false');
    expect(s.calls.some((args) => args.includes('update-ref') || args.includes('delete-ref'))).toBe(false);
    expect(s.calls.some((args) => args.includes('--prune=now'))).toBe(false);
    expect(result.maintenance).toMatchObject({ applied: true, refDeletion: false, geometricRepack: 2, writeMidx: true, keepUnreachable: true, nice: 10 });
  } finally { s.cleanup(); }
});

test('a failed repack reports newly created temporary packs and leaves them for safe inspection', () => {
  const s = scenario();
  const packDir = join(s.root, 'repo.git', 'objects', 'pack');
  const oldArtifact = join(packDir, 'tmp_pack_existing');
  const newArtifact = join(packDir, 'tmp_pack_failed-run');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(oldArtifact, 'old');
  const baseGit = s.deps.git!;
  const git: GitRunner = (repo, args, timeout, input) => {
    if (args[0] === 'repack') {
      writeFileSync(newArtifact, 'partial-pack');
      return { status: 124, stdout: '', stderr: 'timed out', signal: 'SIGTERM' };
    }
    return baseGit(repo, args, timeout, input);
  };
  try {
    expect(() => maintainHqRepo({ root: s.root, apply: true }, { ...s.deps, git }))
      .toThrow(/new temporary pack artifacts preserved for inspection: tmp_pack_failed-run \(12 bytes\).*verify writer processes/u);
    expect(existsSync(oldArtifact)).toBe(true);
    expect(existsSync(newArtifact)).toBe(true);
    expect(existsSync(join(s.root, 'repo-maintenance.lock'))).toBe(false);
  } finally { s.cleanup(); }
});

test('a failed repack that creates the initially absent pack directory reports its partial pack', () => {
  const s = scenario();
  const packDir = join(s.root, 'repo.git', 'objects', 'pack');
  const newArtifact = join(packDir, 'tmp_pack_created-on-failure');
  const baseGit = s.deps.git!;
  const git: GitRunner = (repo, args, timeout, input) => {
    if (args[0] === 'repack') {
      mkdirSync(packDir, { recursive: true });
      writeFileSync(newArtifact, 'partial-pack');
      return { status: 124, stdout: '', stderr: 'timed out', signal: 'SIGTERM' };
    }
    return baseGit(repo, args, timeout, input);
  };
  try {
    expect(() => maintainHqRepo({ root: s.root, apply: true }, { ...s.deps, git }))
      .toThrow(/new temporary pack artifacts preserved for inspection: tmp_pack_created-on-failure \(12 bytes\).*verify writer processes/u);
    expect(existsSync(newArtifact)).toBe(true);
  } finally { s.cleanup(); }
});

test('a failed artifact inventory preserves the original repack error and safe cleanup instruction', () => {
  const s = scenario();
  const packDir = join(s.root, 'repo.git', 'objects', 'pack');
  mkdirSync(packDir, { recursive: true });
  const baseGit = s.deps.git!;
  const git: GitRunner = (repo, args, timeout, input) => {
    if (args[0] === 'repack') {
      rmSync(packDir, { recursive: true });
      writeFileSync(packDir, 'inventory unavailable');
      return { status: 124, stdout: '', stderr: 'timed out', signal: 'SIGTERM' };
    }
    return baseGit(repo, args, timeout, input);
  };
  try {
    expect(() => maintainHqRepo({ root: s.root, apply: true }, { ...s.deps, git }))
      .toThrow(/failed \(SIGTERM\): timed out; repack follow-up: temporary pack inventory failed: .*ENOTDIR.*no cleanup attempted; verify writer processes/u);
  } finally { s.cleanup(); }
});


test('an existing apply lock reports how to verify and recover it', () => {
  const s = scenario();
  const lock = join(s.root, 'repo-maintenance.lock');
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 12345, hostname: 'other', startedAt: NOW }));
    expect(() => maintainHqRepo({ root: s.root, apply: true }, s.deps)).toThrow(/inspect .*owner\.json.*confirm its pid is gone/u);
    expect(s.calls.some((args) => args[0] === 'pack-refs')).toBe(false);
  } finally { s.cleanup(); }
});

test('real bare mirror dry-run and apply preserve origin/main and run no expiry deletes', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-repo-real-'));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  const repo = join(root, 'repo.git');
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    git('init', '-q', '--bare', origin);
    git('init', '-q', source);
    git('-C', source, 'config', 'user.name', 'HQ Test');
    git('-C', source, 'config', 'user.email', 'hq@example.test');
    git('-C', source, 'commit', '-q', '--allow-empty', '-m', 'init');
    git('-C', source, 'branch', '-M', 'main');
    git('-C', source, 'push', '-q', origin, 'main');
    git('init', '-q', '--bare', repo);
    git('--git-dir', repo, 'remote', 'add', 'origin', origin);
    git('--git-dir', repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    git('-C', source, 'commit', '-q', '--allow-empty', '-m', 'increment-1');
    git('-C', source, 'push', '-q', origin, 'main');
    git('--git-dir', repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    git('-C', source, 'commit', '-q', '--allow-empty', '-m', 'increment-2');
    git('-C', source, 'push', '-q', origin, 'main');
    git('--git-dir', repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const head = git('--git-dir', repo, 'rev-parse', 'refs/remotes/origin/main');
    git('--git-dir', repo, 'update-ref', 'refs/train-manager/pr/35527', head);
    const orphans = ['unreachable small', 'unreachable medium '.repeat(20), 'unreachable large '.repeat(200)].map((content) =>
      spawnSync('git', ['--git-dir', repo, 'hash-object', '-w', '--stdin'], { input: content, encoding: 'utf8' }).stdout.trim());
    for (const oid of orphans) {
      const packed = spawnSync('git', ['--git-dir', repo, 'pack-objects', join(repo, 'objects', 'pack', 'pack')],
        { input: oid + '\n', encoding: 'utf8' });
      expect(packed.status).toBe(0);
      expect(packed.stdout.trim()).not.toBe('');
    }
    for (const oid of orphans) {
      git('--git-dir', repo, 'prune', '--expire=now');
      expect(git('--git-dir', repo, 'cat-file', '-e', oid)).toBe('');
    }
    const deps = { openPrRefs: () => new Set<string>(), queuedTrainRefs: () => new Set<string>(),
      activeWorktreeRefs: () => ({ refs: new Set<string>(), oids: new Set<string>() }) };
    const dryRun = maintainHqRepo({ root }, deps);
    expect(dryRun.outcome).toBe('dry-run');
    expect(dryRun.refExpiryPlan.protectedRefs).toContain('refs/train-manager/pr/35527');
    expect(dryRun.refExpiryPlan.warnings).toContain('train-ref-age-unavailable: refs/train-manager/pr/35527');
    const applied = maintainHqRepo({ root, apply: true }, deps);
    expect(applied.outcome).toBe('applied');
    expect(applied.after.packs).toBeLessThan(applied.before.packs);
    expect(git('--git-dir', repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(head);
    expect(git('--git-dir', repo, 'rev-parse', 'refs/train-manager/pr/35527')).toBe(head);
    for (const oid of orphans) expect(git('--git-dir', repo, 'cat-file', '-e', oid)).toBe('');
    expect(git('--git-dir', repo, 'config', '--local', '--get', 'gc.auto')).toBe('0');
    expect(git('--git-dir', repo, 'config', '--local', '--get', 'maintenance.auto')).toBe('false');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit expiry requires apply and deletes only freshly planned refs in one atomic CAS transaction', () => {
  const s = scenario();
  try {
    expect(() => maintainHqRepo({ root: s.root, expireRefs: true }, s.deps)).toThrow('--expire-refs requires --apply');
    expect(s.calls.some((args) => args.includes('update-ref'))).toBe(false);
    const result = maintainHqRepo({ root: s.root, apply: true, expireRefs: true }, s.deps);
    const transaction = s.inputs.find(({ args }) => args[0] === 'update-ref')?.input;
    expect(transaction).not.toContain('refs/remotes/origin/merged');
    expect(transaction).toContain('start\ndelete refs/train-manager/pr/35527 ' + 'f'.repeat(40));
    expect(transaction?.endsWith('prepare\ncommit\n')).toBe(true);
    expect(result.refExpiryPlan.applied).toBe(true);
    expect(result.maintenance.deletedRefs).toEqual(['refs/train-manager/pr/35527']);
    expect(result.refExpiryPlan.keptRefs).toContain('refs/remotes/origin/merged');
    expect(result.maintenance.refDeletion).toBe(true);
    expect(s.queueLockObservedDuringUpdateRef).toEqual([true]);
  } finally { s.cleanup(); }
});

test('expiry refuses incomplete protection evidence before maintenance or deletion', () => {
  const s = scenario();
  try {
    const deps = { ...s.deps, queuedTrainRefs: () => null };
    expect(() => maintainHqRepo({ root: s.root, apply: true, expireRefs: true }, deps)).toThrow(/train-queue-unavailable/u);
    expect(s.calls.some((args) => args[0] === 'pack-refs' || args[0] === 'update-ref')).toBe(false);
  } finally { s.cleanup(); }
});

test('maintenance cap alerts use the plan limits and schedule cadence is six hours', () => {
  expect(repoCapAlerts({ packs: MAX_REPO_PACKS, refs: MAX_REPO_REFS, fetchMs: 0 })).toEqual([]);
  expect(repoCapAlerts({ packs: MAX_REPO_PACKS + 1, refs: MAX_REPO_REFS + 1, fetchMs: 0 })).toEqual([
    { metric: 'packs', observed: MAX_REPO_PACKS + 1, limit: MAX_REPO_PACKS },
    { metric: 'refs', observed: MAX_REPO_REFS + 1, limit: MAX_REPO_REFS },
  ]);
  expect(REPO_MAINTENANCE_CRON).toBe('0 */6 * * *');
  expect(REPO_MAINTENANCE_SCHEDULE_COMMAND).toBe('nice -n 10 bun scripts/hq-repo-maintenance-cycle.ts');
  expect(REF_EXPIRY_CONCURRENCY_WARNING).toContain('default is off');
});

test('schedule installer creates one six-hour low-priority bun job and is idempotent', () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run = (file: string, args: string[]) => {
    calls.push({ file, args });
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify({ schedules: [] }), stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  };
  expect(installHqRepoMaintenanceSchedule(run, join(tmpdir(), 'hq-schedule-install-' + process.pid))).toEqual({ status: 'installed' });
  expect(calls[1]).toEqual({ file: 'eln', args: ['schedule', 'create', '--cron', '0 */6 * * *',
    '--command', 'nice -n 10 bun scripts/hq-repo-maintenance-cycle.ts', '--json'] });
  const existingRun = (_file: string, args: string[]) => args[1] === 'list'
    ? { status: 0, stdout: JSON.stringify({ schedules: [{ cron: '0 */6 * * *', enabled: true,
      command: 'nice -n 10 bun scripts/hq-repo-maintenance-cycle.ts' }] }), stderr: '' }
    : { status: 0, stdout: '{}', stderr: '' };
  expect(installHqRepoMaintenanceSchedule(existingRun, join(tmpdir(), 'hq-schedule-existing-' + process.pid))).toEqual({ status: 'already-installed' });
  const installerOnly = (_file: string, args: string[]) => args[1] === 'list'
    ? { status: 0, stdout: JSON.stringify({ schedules: [{ cron: '0 */6 * * *', enabled: true,
      command: 'false && nice -n 10 bun scripts/hq-repo-maintenance-cycle.ts' }] }), stderr: '' }
    : { status: 0, stdout: '{}', stderr: '' };
  expect(() => installHqRepoMaintenanceSchedule(installerOnly, join(tmpdir(), 'hq-schedule-invalid-' + process.pid)))
    .toThrow(/disabled, duplicate, or differently scheduled/u);
  const busyLock = join(tmpdir(), 'hq-schedule-busy-' + process.pid);
  mkdirSync(busyLock, { recursive: true });
  try {
    expect(() => installHqRepoMaintenanceSchedule(run, busyLock)).toThrow(/inspect owner\.json/u);
  } finally { rmSync(busyLock, { recursive: true, force: true }); }
});

test('expiry uses the existing queue lock and rechecks a train ref age before deletion', () => {
  const s = scenario();
  const originalRead = s.deps.readRefLogText;
  let targetReads = 0;
  const deps = { ...s.deps, readRefLogText: (repo: string, ref: string) => {
    if (ref.endsWith('/35527')) {
      targetReads += 1;
      const age = targetReads === 1 ? 48 : 1;
      return 'a'.repeat(40) + ' ' + 'f'.repeat(40) + ' Name <name@example.test> '
        + Math.floor((NOW - age * 60 * 60 * 1000) / 1000) + ' +0000\tupdate\n';
    }
    return originalRead(repo, ref);
  } };
  try {
    const result = maintainHqRepo({ root: s.root, apply: true, expireRefs: true }, deps);
    expect(result.maintenance.deletedRefs).toEqual([]);
    expect(s.calls.some((args) => args[0] === 'update-ref')).toBe(false);
    expect(s.calls.some((args) => args[0] === 'for-each-ref')).toBe(true);
    expect(s.inputs.find(({ args }) => args[0] === 'update-ref')).toBeUndefined();
    expect(s.calls).toContainEqual(['config', '--local', '--replace-all', 'gc.auto', '0']);
  } finally { s.cleanup(); }
});

test('expiry refuses when the shared land queue lock is already held', () => {
  const s = scenario();
  try {
    mkdirSync(join(s.root, 'seat-state', 'OP', 'land-queue.tsv.lock'));
    expect(() => maintainHqRepo({ root: s.root, apply: true, expireRefs: true }, s.deps)).toThrow(/land queue lock is busy/u);
    expect(s.calls.some((args) => args[0] === 'update-ref')).toBe(false);
  } finally { s.cleanup(); }
});

test('real bare expiry deletes only old train refs and leaves origin candidates untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-repo-expiry-real-'));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  const repo = join(root, 'repo.git');
  mkdirSync(join(root, 'seat-state', 'OP'), { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const updateExpiredRef = (ref: string, oid: string) => {
    const result = spawnSync('git', ['--git-dir', repo, 'update-ref', '--create-reflog', '-m', 'init', ref, oid], {
      encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '@1700000000 +0000' },
    });
    if (result.status !== 0) throw new Error(`update-ref ${ref}: ${result.stderr}`);
  };
  try {
    git('init', '-q', '--bare', origin);
    git('init', '-q', source);
    git('-C', source, 'config', 'user.name', 'HQ Test');
    git('-C', source, 'config', 'user.email', 'hq@example.test');
    git('-C', source, 'commit', '-q', '--allow-empty', '-m', 'init');
    git('-C', source, 'branch', '-M', 'main');
    git('-C', source, 'push', '-q', origin, 'main');
    git('init', '-q', '--bare', repo);
    git('--git-dir', repo, 'remote', 'add', 'origin', origin);
    git('--git-dir', repo, 'config', 'core.logAllRefUpdates', 'always');
    git('--git-dir', repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const head = git('--git-dir', repo, 'rev-parse', 'refs/remotes/origin/main');
    updateExpiredRef('refs/train-manager/pr/35527', head);
    updateExpiredRef('refs/remotes/origin/old-merged', head);
    expect(parseReflogUpdatedAt(readFileSync(join(repo, 'logs', 'refs/train-manager/pr/35527'), 'utf8'), head)).toBe(1_700_000_000_000);
    const deps = { now: () => NOW, openPrRefs: () => new Set<string>(), queuedTrainRefs: () => new Set<string>(),
      activeWorktreeRefs: () => ({ refs: new Set<string>(), oids: new Set<string>() }) };
    const result = maintainHqRepo({ root, apply: true, expireRefs: true }, deps);
    expect(result.maintenance.deletedRefs).toEqual(['refs/train-manager/pr/35527']);
    expect(result.refExpiryPlan.keptRefs).toContain('refs/remotes/origin/old-merged');
    expect(git('--git-dir', repo, 'show-ref', '--verify', '--quiet', 'refs/remotes/origin/old-merged')).toBe('');
    expect(spawnSync('git', ['--git-dir', repo, 'show-ref', '--verify', '--quiet', 'refs/train-manager/pr/35527']).status).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
