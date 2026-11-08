import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { POD_MEMORY_STAGE_NAMES, podMemorySamplerScript, podMemoryStageToolWrappersScript, selectPodMemoryTier, summarizePodMemoryByStage } from './pod-memory-policy.js';
import type { GoalType } from '../self-implement/goal-author.js';
import type { PodMemoryTier } from '../task-orchestrator/surfaces/self-implement-pod.js';

function withFakeBinFirst(fakeBin: string, script: string): string {
  return `PATH=${JSON.stringify(fakeBin)}:"$PATH"\n${script}`;
}

describe('harness Pod memory tier policy', () => {
  test.each(['research', 'document'] as const)('%s without --pod-memory defaults to lite', (goalType) => {
    expect(selectPodMemoryTier(goalType, undefined)).toEqual({ tier: 'lite', reason: 'goal-type-default' });
    expect(selectPodMemoryTier(goalType, undefined, 'high')).toEqual({ tier: 'lite', reason: 'goal-type-default' });
  });

  test.each(['implement', 'operate'] as const)('%s without --pod-memory retains the existing tier', (goalType) => {
    expect(selectPodMemoryTier(goalType, undefined)).toEqual({ tier: 'standard', reason: 'existing-tier' });
    expect(selectPodMemoryTier(goalType, undefined, 'high')).toEqual({ tier: 'high', reason: 'existing-tier' });
  });

  test('explicit --pod-memory preserves each tier for every goal type', () => {
    for (const goalType of ['research', 'document', 'implement', 'operate'] as GoalType[]) {
      for (const tier of ['lite', 'standard', 'high'] as PodMemoryTier[]) {
        expect(selectPodMemoryTier(goalType, tier, 'high')).toEqual({ tier, reason: 'explicit-option' });
      }
    }
  });
});

describe('Pod memory stage profile', () => {
  test('command wrappers mark explicit lifecycle phases and preserve the command exit code', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-memory-stage-wrapper-'));
    try {
      const fakeBin = join(root, 'fake-bin');
      const stageBin = join(root, 'stage-bin');
      const stageDir = join(root, 'active');
      const bunCapture = join(root, 'observed-bun-stage');
      const gitCapture = join(root, 'observed-git-stage');
      const fakeBun = join(fakeBin, 'bun');
      const fakeGit = join(fakeBin, 'git');
      mkdirSync(fakeBin);
      writeFileSync(fakeBun, '#!/usr/bin/env bash\nIFS=" " read -r marker_stage _ < "$ELANOUS_POD_MEMORY_STAGE_MARKER"\nprintf "%s:%s\\n" "$ELANOUS_POD_MEMORY_ACTIVE_STAGE" "$marker_stage" >> "$CAPTURE_BUN_STAGE"\nexit 19\n');
      chmodSync(fakeBun, 0o755);
      writeFileSync(fakeGit, '#!/usr/bin/env bash\nIFS=" " read -r marker_stage _ < "$ELANOUS_POD_MEMORY_STAGE_MARKER"\nprintf "%s:%s\\n" "$ELANOUS_POD_MEMORY_ACTIVE_STAGE" "$marker_stage" > "$CAPTURE_GIT_STAGE"\nexit 13\n');
      chmodSync(fakeGit, 0o755);
      const script = `${podMemoryStageToolWrappersScript()}\n"$ELANOUS_POD_MEMORY_STAGE_BIN/bun" --cwd repo test hidden-secret.test.ts\nbun_rc=$?\n"$ELANOUS_POD_MEMORY_STAGE_BIN/bun" build private-entry.ts\nbuild_rc=$?\n"$ELANOUS_POD_MEMORY_STAGE_BIN/git" -C repo checkout private-branch\ngit_rc=$?\nprintf 'bun_rc=%s build_rc=%s git_rc=%s\\n' "$bun_rc" "$build_rc" "$git_rc"\n[ -z "$(find "$ELANOUS_POD_MEMORY_STAGE_DIR" -type f -print -quit)" ]`;
      const run = Bun.spawnSync(['bash', '-c', withFakeBinFirst(fakeBin, script)], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ELANOUS_POD_MEMORY_STAGE_BIN: stageBin,
          ELANOUS_POD_MEMORY_STAGE_DIR: stageDir, CAPTURE_BUN_STAGE: bunCapture, CAPTURE_GIT_STAGE: gitCapture },
      });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toContain('bun_rc=19 build_rc=19 git_rc=13');
      expect(readFileSync(bunCapture, 'utf8').trim()).toBe('test:test\nbuild:build');
      expect(readFileSync(gitCapture, 'utf8').trim()).toBe('source:source');
      expect(run.stdout.toString()).not.toContain('hidden-secret');
      expect(run.stdout.toString()).not.toContain('private-branch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('command wrappers terminate children after TERM and INT and remove PID markers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-memory-stage-signal-'));
    try {
      const fakeBin = join(root, 'fake-bin');
      const stageBin = join(root, 'stage-bin');
      const stageDir = join(root, 'active');
      mkdirSync(fakeBin);
      const fakeBun = join(fakeBin, 'bun');
      writeFileSync(fakeBun, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CHILD_PID_CAPTURE!, String(process.pid));
writeFileSync(process.env.START_CAPTURE!, 'started');
const stop = (signal: string) => { writeFileSync(process.env.SIGNAL_CAPTURE!, signal); process.exit(0); };
process.on('SIGTERM', () => stop('TERM'));
process.on('SIGINT', () => stop('INT'));
setInterval(() => {}, 100);
`);
      chmodSync(fakeBun, 0o755);
      const script = podMemoryStageToolWrappersScript();
      const setup = Bun.spawnSync(['bash', '-c', withFakeBinFirst(fakeBin, script)], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ELANOUS_POD_MEMORY_STAGE_BIN: stageBin,
          ELANOUS_POD_MEMORY_STAGE_DIR: stageDir },
      });
      expect(setup.exitCode).toBe(0);
      for (const signal of ['TERM', 'INT'] as const) {
        const startedFile = join(root, `${signal}.started`);
        const signalFile = join(root, `${signal}.signal`);
        const childPidFile = join(root, `${signal}.pid`);
        const wrapper = Bun.spawn([join(stageBin, 'bun'), 'test'], {
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ELANOUS_POD_MEMORY_STAGE_BIN: stageBin,
            ELANOUS_POD_MEMORY_STAGE_DIR: stageDir, START_CAPTURE: startedFile, SIGNAL_CAPTURE: signalFile,
            CHILD_PID_CAPTURE: childPidFile, SIGNAL: signal },
          stdout: 'ignore', stderr: 'ignore',
        });
        try {
          for (let i = 0; i < 100 && !(await Bun.file(startedFile).exists()); i++) await Bun.sleep(10);
          expect(await Bun.file(startedFile).exists()).toBe(true);
          const childPid = Number(readFileSync(childPidFile, 'utf8'));
          wrapper.kill(`SIG${signal}`);
          await wrapper.exited;
          expect(readFileSync(signalFile, 'utf8')).toBe(signal);
          expect(() => process.kill(childPid, 0)).toThrow();
          expect(await Bun.file(join(stageDir, String(wrapper.pid))).exists()).toBe(false);
        } finally {
          if (wrapper.exitCode === null) wrapper.kill('SIGKILL');
          await wrapper.exited;
        }
      }
      expect(readdirSync(stageDir)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('command wrappers kill a child that ignores TERM before removing its marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-memory-stage-ignore-term-'));
    try {
      const fakeBin = join(root, 'fake-bin');
      const stageBin = join(root, 'stage-bin');
      const stageDir = join(root, 'active');
      const startedFile = join(root, 'command.started');
      const childPidFile = join(root, 'command.pid');
      mkdirSync(fakeBin);
      const fakeBun = join(fakeBin, 'bun');
      writeFileSync(fakeBun, '#!/usr/bin/env bash\ntrap \'\' TERM\nprintf "%s" "$$" > "$CHILD_PID_FILE"\nprintf started > "$START_CAPTURE"\nwhile :; do sleep 0.05; done\n');
      chmodSync(fakeBun, 0o755);
      const setup = Bun.spawnSync(['bash', '-c', withFakeBinFirst(fakeBin, podMemoryStageToolWrappersScript())], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ELANOUS_POD_MEMORY_STAGE_BIN: stageBin,
          ELANOUS_POD_MEMORY_STAGE_DIR: stageDir },
      });
      expect(setup.exitCode).toBe(0);
      const wrapper = Bun.spawn([join(stageBin, 'bun'), 'test'], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ELANOUS_POD_MEMORY_STAGE_BIN: stageBin,
          ELANOUS_POD_MEMORY_STAGE_DIR: stageDir, START_CAPTURE: startedFile, CHILD_PID_FILE: childPidFile },
        stdout: 'ignore', stderr: 'ignore',
      });
      try {
        for (let i = 0; i < 100 && !(await Bun.file(startedFile).exists()); i++) await Bun.sleep(10);
        expect(await Bun.file(startedFile).exists()).toBe(true);
        const childPid = Number(readFileSync(childPidFile, 'utf8'));
        wrapper.kill('SIGTERM');
        await wrapper.exited;
        expect(() => process.kill(childPid, 0)).toThrow();
        expect(await Bun.file(join(stageDir, String(wrapper.pid))).exists()).toBe(false);
      } finally {
        if (wrapper.exitCode === null) wrapper.kill('SIGKILL');
        await wrapper.exited;
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('command wrappers preserve the caller stdin for the real command', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-memory-stage-stdin-'));
    try {
      const fakeBin = join(root, 'fake-bin');
      const stageBin = join(root, 'stage-bin');
      mkdirSync(fakeBin);
      const fakeBun = join(fakeBin, 'bun');
      writeFileSync(fakeBun, '#!/usr/bin/env bash\nIFS= read -r line || exit 8\nprintf "stdin=%s\\n" "$line"\n');
      chmodSync(fakeBun, 0o755);
      const script = `${podMemoryStageToolWrappersScript()}\nprintf 'input-from-caller\\n' | "$ELANOUS_POD_MEMORY_STAGE_BIN/bun" stdin-test`;
      const run = Bun.spawnSync(['bash', '-c', withFakeBinFirst(fakeBin, script)], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ELANOUS_POD_MEMORY_STAGE_BIN: stageBin,
          ELANOUS_POD_MEMORY_STAGE_DIR: join(root, 'active') },
      });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toContain('stdin=input-from-caller');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('sampler keeps the child stage after its wrapper is SIGKILLed', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-memory-stage-orphan-'));
    try {
      const fakeBin = join(root, 'fake-bin');
      const stageBin = join(root, 'stage-bin');
      const stageDir = join(root, 'active');
      const fakeBun = join(fakeBin, 'bun');
      const fakePs = join(fakeBin, 'ps');
      mkdirSync(fakeBin);
      writeFileSync(fakeBun, '#!/usr/bin/env bash\nsleep 3\n');
      writeFileSync(fakePs, '#!/bin/sh\nif [ "$1" = -o ] && [ "$2" = lstart= ]; then exec /bin/ps "$@"; fi\nprintf " 512 node node\\n"\n');
      chmodSync(fakeBun, 0o755);
      chmodSync(fakePs, 0o755);
      const wrappers = podMemoryStageToolWrappersScript();
      const sampler = podMemorySamplerScript().replace('sleep 15 || break', 'break');
      const command = `${wrappers}\nprintf 'run\\n' > "$ELANOUS_POD_MEMORY_STAGE_FILE"\n"$ELANOUS_POD_MEMORY_STAGE_BIN/bun" test & wrapper_pid=$!\nmarker_file="$ELANOUS_POD_MEMORY_STAGE_DIR/$wrapper_pid"\nfor i in {1..100}; do IFS=" " read -r phase command_pid marker_start marker_state marker_time < "$marker_file"; [ "$marker_state" = active ] && break; sleep 0.01; done\n[ "$marker_state" = active ] || exit 3\nchild_pid=$command_pid\nkill -KILL "$wrapper_pid"\n${sampler}\nwait "$mem_sampler_pid"\n[ -f "$marker_file" ] || exit 6\nIFS=" " read -r phase command_pid marker_start marker_state marker_time < "$marker_file"\n[ "$command_pid" = "$child_pid" ] && [ "$marker_state" = active ] || exit 4\nkill -TERM "$command_pid" 2>/dev/null || true\nrm -f -- "$marker_file"`;
      const run = Bun.spawnSync(['bash', '-c', withFakeBinFirst(fakeBin, command)], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ELANOUS_POD_MEMORY_STAGE_BIN: stageBin,
          ELANOUS_POD_MEMORY_STAGE_DIR: stageDir, ELANOUS_POD_MEMORY_STAGE_FILE: join(root, 'stage') },
      });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toContain('stage=test');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('sampler ignores a prepared stage when SIGKILL prevents the child command from starting', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-memory-stage-prepared-'));
    try {
      const fakeBin = join(root, 'fake-bin');
      const stageBin = join(root, 'stage-bin');
      const stageDir = join(root, 'active');
      const startedFile = join(root, 'command.started');
      mkdirSync(fakeBin);
      const fakeBun = join(fakeBin, 'bun');
      writeFileSync(fakeBun, '#!/usr/bin/env bash\nprintf started > "$COMMAND_STARTED"\nread -t 3 _ || true\n');
      chmodSync(fakeBun, 0o755);
      const wrappers = podMemoryStageToolWrappersScript().replace("printf 'go\\n' >&9 || true", "sleep 0.8\n  printf 'go\\n' >&9 || true");
      const sampler = podMemorySamplerScript().replace('sleep 15 || break', 'break');
      const command = `${wrappers}\n"$ELANOUS_POD_MEMORY_STAGE_BIN/bun" test & wrapper_pid=$!\nmarker_file="$ELANOUS_POD_MEMORY_STAGE_DIR/$wrapper_pid"\nfor i in {1..100}; do IFS=" " read -r phase child_pid marker_start marker_state marker_time < "$marker_file"; [ "$marker_state" = prepared ] && break; sleep 0.01; done\n[ "$marker_state" = prepared ] || exit 3\nkill -KILL "$wrapper_pid"\n${sampler}\nwait "$mem_sampler_pid"\n[ "$stage" != test ] || exit 4\n[ ! -e "$COMMAND_STARTED" ] || exit 5`;
      const run = Bun.spawnSync(['bash', '-c', withFakeBinFirst(fakeBin, command)], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ELANOUS_POD_MEMORY_STAGE_BIN: stageBin,
          ELANOUS_POD_MEMORY_STAGE_DIR: stageDir, COMMAND_STARTED: startedFile },
      });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).not.toContain('stage=test');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('reports sampled cgroup and RSS peaks for source, install, implement, typecheck, test, and build', () => {
    const profile = summarizePodMemoryByStage([
      { at: 1, cgroupBytes: 4_000, stage: 'source', top: [
        { rssKb: 100, name: 'git', cmd: 'git clone <redacted>' },
        { rssKb: 200, name: 'bun', cmd: 'bun install <redacted>' },
        { rssKb: 300, name: 'elanous', cmd: 'elanous self implement <redacted>' },
        { rssKb: 400, name: 'tsc', cmd: 'tsc <redacted>' },
      ] },
      { at: 2, cgroupBytes: 5_000, stage: 'test', top: [
        { rssKb: 500, name: 'bun', cmd: 'bun test <redacted>' },
        { rssKb: 600, name: 'bun', cmd: 'bun run build <redacted>' },
      ] },
    ]);
    expect(profile).toEqual([
      { stage: 'source', samples: 1, cgroupSampledPeakBytes: 4_000, topProcessRssPeakKb: 1_000, coverage: 'sampled' },
      { stage: 'install', samples: 0, cgroupSampledPeakBytes: null, topProcessRssPeakKb: null, coverage: 'not-observed' },
      { stage: 'implement', samples: 0, cgroupSampledPeakBytes: null, topProcessRssPeakKb: null, coverage: 'not-observed' },
      { stage: 'typecheck', samples: 0, cgroupSampledPeakBytes: null, topProcessRssPeakKb: null, coverage: 'not-observed' },
      { stage: 'test', samples: 1, cgroupSampledPeakBytes: 5_000, topProcessRssPeakKb: 1_100, coverage: 'sampled' },
      { stage: 'build', samples: 0, cgroupSampledPeakBytes: null, topProcessRssPeakKb: null, coverage: 'not-observed' },
    ]);
  });

  test('keeps missing stages distinct from a measured zero and ignores unclassified processes', () => {
    const profile = summarizePodMemoryByStage([
      { at: 1, cgroupBytes: null, top: [{ rssKb: 0, name: 'other', cmd: '<redacted>' }] },
      { at: 2, cgroupBytes: 0, stage: 'test', top: [{ rssKb: 0, name: 'bun', cmd: 'bun test <redacted>' }] },
    ]);
    expect(profile.find(({ stage }) => stage === 'test')).toMatchObject({
      samples: 1, cgroupSampledPeakBytes: 0, topProcessRssPeakKb: 0, coverage: 'sampled',
    });
    expect(profile.find(({ stage }) => stage === 'source')).toMatchObject({
      samples: 0, cgroupSampledPeakBytes: null, topProcessRssPeakKb: null, coverage: 'not-observed',
    });
    expect(profile.map(({ stage }) => stage)).toEqual([...POD_MEMORY_STAGE_NAMES]);
  });

  test('an unavailable process list keeps RSS null while a measured empty list stays zero', () => {
    const profile = summarizePodMemoryByStage([
      { at: 1, cgroupBytes: 100, stage: 'test', top: null },
      { at: 2, cgroupBytes: 0, stage: 'build', top: [] },
    ]);
    expect(profile.find(({ stage }) => stage === 'test')).toMatchObject({
      samples: 1, cgroupSampledPeakBytes: 100, topProcessRssPeakKb: null, coverage: 'sampled',
    });
    expect(profile.find(({ stage }) => stage === 'build')).toMatchObject({
      samples: 1, cgroupSampledPeakBytes: 0, topProcessRssPeakKb: 0, coverage: 'sampled',
    });
  });
});
