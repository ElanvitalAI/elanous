import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { landingPodShadowScript, runLandingPodShadowJob, type LandingPodShadowVerdict } from './pr-land-pod-shadow-job.js';
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
  expect(options).toMatchObject({ clone: true, source: { kind: 'commit', sha: head }, returnLogs: true });
  const script = (options?.command as string[])[2]!;
  expect(script).toContain(`git fetch origin '${main}'`);
  expect(script).toContain(`TSC_BASE_REF='${main}' bun scripts/ci-typecheck-changed.ts --local`);
  expect(script).toContain(`self gate --changed --base '${main}' --local --shards 4`);
  expect(verdict).toMatchObject({ measured: true, ok: true, tscRc: 0, gateRc: 0, rootPlan: { mode: 'affected', roots: 4 }, job: 'pod-shadow-77' });
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
    let output = '';
    const parsed = await runLandingPodShadowJob({ head: sourceHead, main: sourceMain }, {
      runPod: async (options) => {
        const result = spawnSync(options.command[0]!, options.command.slice(1), {
          cwd: shallow, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
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
