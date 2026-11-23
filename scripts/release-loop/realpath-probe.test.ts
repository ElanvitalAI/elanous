import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRealpathProbe } from './realpath-probe.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// The cut tree runs the real docker/harness/build.sh — only the external tools (docker/registry, uname) are mocked.
const REAL_BUILD_SH = readFileSync(join(import.meta.dir, '..', '..', 'docker', 'harness', 'build.sh'), 'utf8');
// build.sh packs the PWA via the real scripts/lib/pack-pwa-output.ts (#38418) — the cut tree must carry that file too, or the real pack stage exits 61.
const REAL_PACK_PWA_OUTPUT = readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'lib', 'pack-pwa-output.ts'), 'utf8');

type CutOpts = { buildBody?: string; pwa?: boolean; depsOut?: string; uname?: string; inspectOut?: string };

/** A real git repo whose cut tree carries the files the prebuild child reads — the real build.sh unless a body is injected for a probe-mapping test. */
function cutTree(opts: CutOpts = {}): { repo: string; commit: string; bin: string } {
  const repo = mkdtempSync(join(tmpdir(), 'realpath-probe-repo-')); roots.push(repo);
  const write = (rel: string, body: string) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), body); };
  write('package.json', JSON.stringify({ name: 'elanous-harness', version: '0.3.29' }, null, 2) + '\n');
  // bun pm pack parses bun.lock — an empty lockfile fails with InvalidLockfile, so the cut tree carries the minimal lockfile bun accepts.
  write('bun.lock', '{\n  "lockfileVersion": 1,\n  "configVersion": 1,\n  "workspaces": { "": { "name": "elanous-harness", "dependencies": {}, "devDependencies": {} } },\n  "packages": {}\n}\n');
  write('.bun-version', '1.3.0\n');
  write('docker/harness/Dockerfile', 'FROM ubuntu:24.04\n');
  write('docker/harness/build.sh', opts.buildBody ? `#!/bin/bash\n${opts.buildBody}\n` : REAL_BUILD_SH);
  write('scripts/install.sh', '#!/bin/sh\n');
  write('scripts/lib/pack-pwa-output.ts', REAL_PACK_PWA_OUTPUT);
  write('src/task-orchestrator/surfaces/pod-gate-deps.ts', `console.log(${JSON.stringify(opts.depsOut ?? 'staged digest=abcdefabcdef')});\n`);
  write('src/task-orchestrator/surfaces/pod-skills.ts', "console.log('staged digest=none');\n");
  if (opts.pwa !== false) write('apps/pwa/out/index.html', '<html>packed by the real build.sh\n');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'cut');
  const commit = git('rev-parse', 'HEAD').stdout.trim();
  const bin = mkdtempSync(join(tmpdir(), 'realpath-probe-bin-')); roots.push(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
case "$1 $2" in
  "pull ubuntu:24.04") exit 0 ;;
  "image inspect") echo "${opts.inspectOut ?? `ubuntu@sha256:${'a'.repeat(64)}`}"; exit 0 ;;
  "inspect k3d-elanous-registry") exit 0 ;;
esac
echo "unexpected docker $*" >&2; exit 99
`);
  chmodSync(join(bin, 'docker'), 0o755);
  if (opts.uname) { writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho ${opts.uname}\n`); chmodSync(join(bin, 'uname'), 0o755); }
  return { repo, commit, bin };
}

function probeWithPath(cut: { repo: string; commit: string; bin: string }) {
  const prior = process.env.PATH;
  const priorLock = process.env.ELANOUS_BUILD_PACK_LOCK_DIR;
  // The real build.sh packs under a lock — keep the test's lock in a private dir so it never touches a real build's lock.
  const lockDir = mkdtempSync(join(tmpdir(), 'realpath-probe-lock-')); roots.push(lockDir);
  try {
    process.env.PATH = `${cut.bin}:${prior}`;
    process.env.ELANOUS_BUILD_PACK_LOCK_DIR = lockDir;
    return runRealpathProbe({ checkout: cut.repo, commit: cut.commit, version: '0.3.29', runId: 'hard-probe-test', pool: 'k3d-probe:1' });
  } finally {
    process.env.PATH = prior;
    if (priorLock === undefined) delete process.env.ELANOUS_BUILD_PACK_LOCK_DIR;
    else process.env.ELANOUS_BUILD_PACK_LOCK_DIR = priorLock;
  }
}

test('a build.sh that exits 7 names the build stage with exit 7 after clone/deps/skills/base-pull passed', () => {
  const receipt = probeWithPath(cutTree({ buildBody: 'echo "dependency layer broke" >&2; exit 7' }));
  expect(receipt.outcome).toBe('failed');
  expect(receipt.failedStage).toBe('build');
  expect(receipt.stages.map((row) => [row.stage, row.exit])).toEqual([['clone', 0], ['deps', 0], ['skills', 0], ['base-pull', 0], ['build', 7]]);
  expect(receipt.stages[4]!.reason).toContain('build.sh exited 7: dependency layer broke');
}, 60_000);

test('the real gate-layer build accepts a package archive without the optional PWA', () => {
  const receipt = probeWithPath(cutTree({ pwa: false }));
  expect(receipt.outcome).toBe('ok');
  expect(receipt.stages.find((row) => row.stage === 'pack-pwa')).toEqual({
    stage: 'pack-pwa', exit: 0, ok: true, reason: 'gate layer archive verified; PWA optional and absent',
  });
  expect(receipt.stages.at(-1)?.stage).toBe('push');
}, 120_000);

test('a successful pack child that wrote an unreadable archive still fails the gate-layer probe', () => {
  const receipt = probeWithPath(cutTree({ buildBody: 'printf "invalid archive" > "$ELANOUS_BUILD_PACK_ONLY"' }));
  expect(receipt.failedStage).toBe('pack-pwa');
  expect(receipt.stages.at(-1)?.reason).toContain('package archive unreadable');
}, 60_000);

test('a readable archive without the gate package manifest is rejected', () => {
  const receipt = probeWithPath(cutTree({ buildBody: 'mkdir package; tar -czf "$ELANOUS_BUILD_PACK_ONLY" package' }));
  expect(receipt.failedStage).toBe('pack-pwa');
  expect(receipt.stages.at(-1)?.reason).toBe('gate layer archive has no package/package.json');
}, 60_000);

test('success walks all seven stages with the real build.sh pack and the push is probed, not performed', () => {
  const receipt = probeWithPath(cutTree());
  expect(receipt.outcome).toBe('ok');
  expect(receipt.stages).toEqual([
    { stage: 'clone', exit: 0, ok: true, reason: 'ok' }, { stage: 'deps', exit: 0, ok: true, reason: 'ok' }, { stage: 'skills', exit: 0, ok: true, reason: 'ok' },
    { stage: 'base-pull', exit: 0, ok: true, reason: 'ok' }, { stage: 'build', exit: 0, ok: true, reason: 'ok' }, { stage: 'pack-pwa', exit: 0, ok: true, reason: 'ok' },
    { stage: 'push', exit: 0, ok: true, reason: 'probed: registry container present on every pool member (docker inspect), push not performed' },
  ]);
  expect(receipt.reason).toStartWith('rehearsal probe: push not performed (image ');
}, 120_000);

test('no gate pool is a visible skip, not a pass', () => {
  expect(runRealpathProbe({ checkout: '/nowhere', commit: 'a'.repeat(40), version: '0.3.29', runId: 'r', pool: undefined }))
    .toEqual({ outcome: 'skipped', reason: 'gate pool absent (release.loop.gatePodPool)', stages: [] });
});

test('Terra must 2: a deps child that exits 0 without a digest is ONE failed deps row with its real exit 0', () => {
  const receipt = probeWithPath(cutTree({ depsOut: 'staged (no digest line)' }));
  expect(receipt.outcome).toBe('failed');
  expect(receipt.failedStage).toBe('deps');
  expect(receipt.stages).toEqual([
    { stage: 'clone', exit: 0, ok: true, reason: 'ok' },
    { stage: 'deps', exit: 0, ok: false, reason: 'gate image dependency digest is unmeasured' },
  ]);
}, 60_000);

test('Terra must 2: base-pull output without a repo digest is ONE failed base-pull row (exit 0) quoting the real output', () => {
  // `docker image inspect --format '{{index .RepoDigests 0}}'` shape when the tag has no registry digest: a bare ref.
  const receipt = probeWithPath(cutTree({ uname: 'aarch64', inspectOut: 'ubuntu:24.04' }));
  expect(receipt.failedStage).toBe('base-pull');
  expect(receipt.stages.map((row) => [row.stage, row.exit, row.ok])).toEqual([['clone', 0, true], ['deps', 0, true], ['skills', 0, true], ['base-pull', 0, false]]);
  expect(receipt.stages[3]!.reason).toBe('gate runtime base output unparsed on k3d-probe: ubuntu:24.04 / aarch64');
}, 60_000);