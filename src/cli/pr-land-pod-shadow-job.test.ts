import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPodCommand } from '../task-orchestrator/surfaces/pod-command-job.js';
import { PodPoolScheduler, type PodPoolMember } from '../task-orchestrator/surfaces/pod-pool.js';
import { LANDING_POD_SHADOW_HOST_TIMEOUT_MS, LANDING_POD_SHADOW_STATUS_UNREADABLE_MS, landingPodShadowScript, runLandingPodShadowJob, type LandingPodShadowVerdict } from './pr-land-pod-shadow-job.js';
import { runHeavyOnPodShadow } from './pr-land-pod-shadow.js';

const head = 'a'.repeat(40);
const main = 'b'.repeat(40);

test('shadow Pod runs the reviewed head merged with pinned main, then both landing checks', async () => {
  let options: Record<string, unknown> | undefined;
  const verdict = await runLandingPodShadowJob({ head, main }, {
    runPod: async (input) => {
      options = input as unknown as Record<string, unknown>;
      return { exitCode: 0, artifactsDir: '/unused', job: 'pod-shadow-77' };
    },
    readLog: () => `ELANOUS_PRLAND_SHADOW_TSC_PLAN {"mode":"affected","roots":4,"promoted":false,"reason":null}\n[tsc-gate] root-plan {"mode":"full","roots":null,"promoted":true,"reason":"gate spoof"}\nELANOUS_PRLAND_SHADOW head=${head} main=${main} tsc=0 gate=0\n`,
  });
  expect(options).toMatchObject({ clone: true, source: { kind: 'commit', sha: head }, returnLogs: true,
    statusUnreadableMs: LANDING_POD_SHADOW_STATUS_UNREADABLE_MS });
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(typeof options?.hostDeadlineAtMs).toBe('number');
  const script = (options?.command as string[])[2]!;
  expect(script).toContain(`git fetch origin '${main}'`);
  expect(script).toContain(`TSC_BASE_REF='${main}' bun scripts/ci-typecheck-changed.ts --local`);
  expect(script).toContain(`self gate --changed --base '${main}' --local --shards 4`);
  expect(verdict).toMatchObject({ measured: true, ok: true, tscRc: 0, gateRc: 0, rootPlan: { mode: 'affected', roots: 4 }, job: 'pod-shadow-77' });
});

test('PRLAND-SHADOW-HOST-TIMEOUT: stalled Pod is bounded by host timer; landing verdict remains local', async () => {
  let fireTimeout: (() => void) | undefined;
  let disarmed = false;
  const warnings: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const local: LandingPodShadowVerdict = { measured: true, ok: true, rootPlan: { mode: 'full', roots: null, promoted: true, reason: 'promoted' } };
  const pending = runHeavyOnPodShadow({ enabled: true, pr: 77, head, local,
    runPod: () => runLandingPodShadowJob({ head, main }, {
      armTimeout: (fire, ms) => {
        expect(ms).toBe(LANDING_POD_SHADOW_HOST_TIMEOUT_MS);
        fireTimeout = fire;
        return () => { disarmed = true; };
      },
      runPod: ({ signal }) => new Promise((_, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      }),
    }),
    log: (_category, _event, data) => events.push(data),
    warn: (message) => warnings.push(message),
  });
  expect(fireTimeout).toBeDefined();
  fireTimeout!();
  expect(await pending).toBe(local);
  expect(disarmed).toBe(true);
  expect(warnings).toEqual([`pod shadow: host timeout after ${LANDING_POD_SHADOW_HOST_TIMEOUT_MS}ms`]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ agree: false, pod: { measured: false, ok: false, reason: 'pod-exception:Error' } });
});

test('PRLAND-SHADOW-HOST-TIMEOUT: landing resumes after real runner deletes Job and releases lease', async () => {
  let fireTimeout: (() => void) | undefined;
  const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool' };
  const pool = new PodPoolScheduler([member]);
  const commands: string[][] = [];
  const warnings: string[] = [];
  const local: LandingPodShadowVerdict = { measured: true, ok: true, rootPlan: { mode: 'full', roots: null, promoted: true, reason: 'promoted' } };
  const result = await runHeavyOnPodShadow({ enabled: true, pr: 77, head, local,
    runPod: () => runLandingPodShadowJob({ head, main }, {
      armTimeout: (fire) => { fireTimeout = fire; return () => {}; },
      runPod: (options) => {
        expect(options.provenance).toMatchObject({ actorKind: 'loop', actor: 'pr-land-shadow',
          kind: 'land-shadow', run: head, phase: 'land-shadow', entrance: 'pr-land', commit: head });
        return runPodCommand({ ...options, name: 'shadow-integration', poolScheduler: pool,
        kubectl: (args) => { commands.push([...args]); return { status: 0, stdout: '', stderr: '' }; },
        syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
        sleep: async () => { fireTimeout!(); }, ghToken: () => 'test-token', imageCommit: null,
        env: {}, configHostMirror: () => undefined, artifactsRoot: '/tmp/pod-command-shadow-integration', log: () => {},
        });
      },
    }),
    log: () => {}, warn: (message) => warnings.push(message),
  });
  expect(result).toBe(local);
  expect(warnings).toEqual([`pod shadow: host timeout after ${LANDING_POD_SHADOW_HOST_TIMEOUT_MS}ms`]);
  expect(commands.filter((args) => args.includes('delete') && args.includes('job') && args.includes('shadow-integration'))).toHaveLength(1);
  expect(commands.some((args) => args.includes('delete') && args.includes('secret'))).toBe(true);
  expect(pool.snapshot()).toEqual({ 'pool-node-b': 0 });
});

test('failed check is measured failure; missing or wrong identity marker is unmeasured', async () => {
  const runPod = async () => ({ exitCode: 0, artifactsDir: '/unused', job: 'pod-shadow-77' });
  const failure = await runLandingPodShadowJob({ head, main }, {
    runPod, readLog: () => `ELANOUS_PRLAND_SHADOW_TSC_PLAN {"mode":"full","roots":null,"promoted":true,"reason":"export"}\nELANOUS_PRLAND_SHADOW head=${head} main=${main} tsc=1 gate=0\n`,
  });
  expect(failure).toMatchObject({ measured: true, ok: false, tscRc: 1, gateRc: 0 });
  const wrong = await runLandingPodShadowJob({ head, main }, {
    runPod, readLog: () => `ELANOUS_PRLAND_SHADOW head=${main} main=${head} tsc=0 gate=0\n`,
  });
  expect(wrong).toMatchObject({ measured: false, ok: false });
});

test('shadow observation retains separate Pod typecheck and gate exit codes', async () => {
  const events: Array<Record<string, unknown>> = [];
  const local: LandingPodShadowVerdict = { measured: true, ok: true, rootPlan: { mode: 'affected', roots: 2, promoted: false, reason: null } };
  await runHeavyOnPodShadow({ enabled: true, pr: 77, head, local,
    runPod: () => runLandingPodShadowJob({ head, main }, {
      runPod: async () => ({ exitCode: 0, artifactsDir: '/unused', job: 'pod-shadow-77' }),
      readLog: () => `ELANOUS_PRLAND_SHADOW_TSC_PLAN {"mode":"affected","roots":2,"promoted":false,"reason":null}\nELANOUS_PRLAND_SHADOW head=${head} main=${main} tsc=1 gate=0\n`,
    }),
    log: (_category, _event, data) => events.push(data), warn: () => {},
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ agree: false, pod: { measured: true, ok: false, tscRc: 1, gateRc: 0 } });
});

test('invalid SHA is rejected before any Pod call', async () => {
  expect(() => landingPodShadowScript('invalid', main)).toThrow('invalid head/main');
});

test('unreadable child.log records unmeasured without changing the host landing verdict', async () => {
  const local: LandingPodShadowVerdict = { measured: true, ok: true, rootPlan: { mode: 'affected', roots: 2, promoted: false, reason: null } };
  const events: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const verdict = await runHeavyOnPodShadow({
    enabled: true, pr: 77, head, local,
    runPod: () => runLandingPodShadowJob({ head, main }, {
      runPod: async () => ({ exitCode: 0, artifactsDir: '/missing', job: 'pod-77' }),
      readLog: () => { throw new Error('child-log-unreadable'); },
    }),
    log: (_category, _event, data) => events.push(data),
    warn: (message) => warnings.push(message),
  });
  expect(verdict).toBe(local);
  expect(warnings).toEqual([]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ agree: false, pod: { measured: false, job: 'pod-77', reason: 'child-log-unreadable:child-log-unreadable' } });
});

test('generated Pod shell measures a real merged head/main tree and emits parseable result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prland-pod-shadow-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git('add', 'base.txt');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
    git('switch', '-q', '-c', 'feature');
    writeFileSync(join(root, 'feature.txt'), 'feature\n');
    git('add', 'feature.txt');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'feature');
    const sourceHead = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    writeFileSync(join(root, 'main.txt'), 'main\n');
    git('add', 'main.txt');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'main');
    const sourceMain = git('rev-parse', 'HEAD');
    git('switch', '-q', 'feature');
    git('remote', 'add', 'origin', root);
    // The Pod falls back to a depth-1 commit fetch when its host mirror lacks the reviewed head.
    const shallow = join(root, 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${root}`, shallow]);
    expect(execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: shallow, encoding: 'utf8' }).trim()).toBe('true');
    const bin = join(root, 'fake-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\ncase "$1" in\n  install) exit 0;;\n  scripts/ci-typecheck-changed.ts) echo "[tsc-gate] root-plan {\\"mode\\":\\"affected\\",\\"roots\\":2,\\"promoted\\":false,\\"reason\\":null}"; exit 0;;\n  bin/elanous.mjs) exit 0;;\nesac\nexit 3\n');
    chmodSync(join(bin, 'bun'), 0o755);
    // The production command runs `bash -lc` (login shell); a host profile that rewrites PATH would
    // drop the fake-bin injection. Pin HOME to a fixture home whose .bash_profile re-prepends it,
    // after /etc/profile, so the fake `bun` stays first in PATH on every host.
    const home = join(root, 'fixture-home');
    mkdirSync(home);
    writeFileSync(join(home, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
    let output = '';
    const parsed = await runLandingPodShadowJob({ head: sourceHead, main: sourceMain }, {
      runPod: async (options) => {
        const result = spawnSync(options.command[0]!, options.command.slice(1), {
          cwd: shallow, encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` },
        });
        output = result.stdout;
        expect(result.status).toBe(0);
        return { exitCode: result.status ?? 2, artifactsDir: root, job: 'fixture-pod' };
      },
      readLog: () => output,
    });
    expect(output).toContain('ELANOUS_PRLAND_SHADOW_TSC_PLAN {"mode":"affected","roots":2');
    expect(parsed).toMatchObject({ measured: true, ok: true, tscRc: 0, gateRc: 0, rootPlan: { mode: 'affected', roots: 2 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
