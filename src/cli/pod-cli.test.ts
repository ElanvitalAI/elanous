import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { POD_COMMAND_DEADLINE_SECONDS, registerPodCommands } from './pod-cli.js';
import type { RunPodCommandOptions } from '../task-orchestrator/surfaces/pod-command-job.js';

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  let code: number | null = null;
  return {
    lines, errors,
    io: {
      log: (line: string) => { lines.push(line); },
      error: (line: string) => { errors.push(line); },
      exit: (n: number) => { code = n; },
    },
    code: () => code,
  };
}

describe('elanous pod run', () => {
  test('도움말은 deadline 생략 시 기존 Pod Job 상한을 적는다', () => {
    const program = new Command();
    program.exitOverride();
    registerPodCommands(program, { io: capture().io, run: async () => ({ exitCode: 0, artifactsDir: '/a', job: 'j' }) });
    expect(POD_COMMAND_DEADLINE_SECONDS).toBe(10_800);
    const help = program.commands.find((c) => c.name() === 'pod')!.commands.find((c) => c.name() === 'run')!.description();
    expect(help).toContain(String(POD_COMMAND_DEADLINE_SECONDS));
  });

  test('가짜 kubectl: echo hi · 산출 조각 · rc 3 → 경로 출력 · exit 3 · Secret 정리 한 번', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-cli-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const kubectl = join(bin, 'kubectl');
    const trace = join(dir, 'kubectl-args');
    writeFileSync(kubectl, `#!/bin/bash
set -e
printf '%s\\n' "$*" >> ${JSON.stringify(trace)}
joined="$*"
if [[ "$joined" == *"current-context"* ]]; then echo "pool-node-b"; exit 0; fi
if [[ "$joined" == apply* || "$joined" == *' apply '* ]]; then cat >/dev/null; exit 0; fi
if [[ "$joined" == *"containerStatuses"* ]]; then echo "3"; exit 0; fi
if [[ "$joined" == *"jsonpath={.status.conditions"* ]]; then echo "Complete"; exit 0; fi
if [[ "$joined" == *"logs"* ]]; then
  printf '%s\\n' 'ELANOUS_POD_ARTIFACT bm90ZQ 1/1 H4sIAAAAAAAAA3NJLElUyMlXyEmsVAgBAKz3x+0NAAAA'
  exit 0
fi
exit 0
`);
    chmodSync(kubectl, 0o755);
    const seen: RunPodCommandOptions[] = [];
    const cap = capture();
    const program = new Command();
    program.exitOverride();
    const prev = process.argv;
    process.argv = ['bun', 'elanous', 'pod', 'run', '--', 'echo', 'hi'];
    try {
      registerPodCommands(program, {
        io: cap.io,
        run: async (options) => {
          seen.push(options);
          const { runPodCommand } = await import('../task-orchestrator/surfaces/pod-command-job.js');
          return runPodCommand({
            ...options,
            name: 'cmdcli1',
            namespace: 'elanous-test',
            artifactsRoot: join(dir, 'artifacts'),
            sleep: async () => {},
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
            kubectl: (args, input) => {
              const r = spawnSync(kubectl, [...args], { encoding: 'utf8', input });
              return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
            },
          });
        },
      });
      await program.parseAsync(['pod', 'run', '--', 'echo', 'hi'], { from: 'user' });
    } finally {
      process.argv = prev;
    }
    expect(seen[0]?.command).toEqual(['echo', 'hi']);
    expect(seen[0]?.deadlineSeconds).toBeUndefined();
    expect(cap.lines).toEqual([join(dir, 'artifacts', 'cmdcli1')]);
    expect(cap.code()).toBe(3);
    const traceText = (await Bun.file(trace).text());
    expect(traceText.split('\n').filter((line) => line.includes('delete') && line.includes('secret'))).toHaveLength(1);
  });

  test('--deadline 생략은 runPodCommand 에 초를 넘기지 않는다', async () => {
    const cap = capture();
    const seen: RunPodCommandOptions[] = [];
    const program = new Command();
    program.exitOverride();
    const prev = process.argv;
    process.argv = ['bun', 'elanous', 'pod', 'run', '--skill', 'yt-vault', '--llm', 'grok', '--', 'echo', 'hi'];
    try {
      registerPodCommands(program, {
        io: cap.io,
        run: async (options) => {
          seen.push(options);
          return { exitCode: 0, artifactsDir: '/artifacts/job', job: 'job' };
        },
      });
      await program.parseAsync(['pod', 'run', '--skill', 'yt-vault', '--llm', 'grok', '--', 'echo', 'hi'], { from: 'user' });
    } finally {
      process.argv = prev;
    }
    expect(seen[0]).toMatchObject({ command: ['echo', 'hi'], skills: ['yt-vault'], llm: 'grok' });
    expect(seen[0]?.deadlineSeconds).toBeUndefined();
    expect(cap.lines).toEqual(['/artifacts/job']);
    expect(cap.code()).toBe(0);
  });
});
