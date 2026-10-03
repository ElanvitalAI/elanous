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

describe('elanous pod lease status', () => {
  const pods = Array.from({ length: 10 }, (_, i) => ({
    metadata: { namespace: 'elanous-test', name: `harness-${i}`, labels: { 'elanous.job': 'harness-job' } }, status: { phase: 'Running' },
    spec: { nodeName: 'node-1', containers: [{ resources: { limits: { memory: i < 6 ? '16Gi' : '32Gi' }, requests: { memory: i < 6 ? '16Gi' : '32Gi' } } }] },
  }));
  const kubectl = (args: readonly string[]) => ({ status: 0, stderr: '', stdout: args.includes('nodes')
    ? JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '263471132Ki', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] } }] })
    : args.includes('jobs') ? JSON.stringify({ items: [{ metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' } } }] })
      : JSON.stringify({ items: pods }) });
  const runStatus = async (json: boolean) => {
    const cap = capture();
    const program = new Command();
    program.exitOverride();
    registerPodCommands(program, { io: cap.io, kubectl, accounts: () => 10, perAccount: () => 4, poolSpec: () => 'node-b:20' });
    await program.parseAsync(['pod', 'lease', 'status', ...(json ? ['--json'] : [])], { from: 'user' });
    return cap;
  };
  test('--json and table agree on measurements and recommendation', async () => {
    const json = await runStatus(true);
    const table = await runStatus(false);
    const data = JSON.parse(json.lines[0]!);
    expect(json.code()).toBe(0);
    expect(table.code()).toBe(0);
    expect(data.members[0]).toMatchObject({ running: 10, pending: 0, capacity: 20 });
    expect(data).toMatchObject({ recommended: 1, limitedBy: 'memory', capacitySlots: 10, memorySlots: 1 });
    expect(table.lines.join('\n')).toContain('권장 지금 1 개 더 (limitedBy=memory)');
    expect(table.lines.join('\n')).toContain('224.0Gi/251.3Gi');
    expect(data.placeableSlots).toBe(1);
    expect(table.lines.join('\n')).toContain(`배치 가능 ${data.placeableSlots} 칸`);
  });
  test('explicit pool spec wins; all kubectl probes are reads', async () => {
    const calls: string[][] = [];
    const cap = capture(); const program = new Command(); program.exitOverride();
    registerPodCommands(program, {
      io: cap.io, accounts: () => 10, perAccount: () => 4,
      poolSpec: (explicit) => explicit ?? 'wrong:2',
      kubectl: (args) => { calls.push([...args]); return kubectl(args); },
    });
    await program.parseAsync(['pod', 'lease', 'status', '--pool', 'node-b:20', '--json'], { from: 'user' });
    expect(JSON.parse(cap.lines[0]!).pool).toBe('node-b:20');
    expect(calls).toHaveLength(3);
    expect(calls.find((args) => args.includes('pods'))).toContain('--all-namespaces');
    expect(calls.every((args) => args[0] === '--context' && args[1] === 'node-b' && args[2] === '--request-timeout=10s' && args.includes('get'))).toBe(true);
  });
  test('foreign Pod reservation is reflected in both JSON and the table', async () => {
    const foreign = { metadata: { namespace: 'system', name: 'foreign', labels: {} }, status: { phase: 'Running' },
      spec: { nodeName: 'node-1', containers: [{ resources: { requests: { memory: '16Gi' } } }] } };
    const occupied = (args: readonly string[]) => args.includes('pods')
      ? { status: 0, stderr: '', stdout: JSON.stringify({ items: [foreign, ...pods] }) } : kubectl(args);
    const render = async (json: boolean) => {
      const cap = capture(); const program = new Command(); program.exitOverride();
      registerPodCommands(program, { io: cap.io, kubectl: occupied, accounts: () => 10, perAccount: () => 4, poolSpec: () => 'node-b:20' });
      await program.parseAsync(['pod', 'lease', 'status', ...(json ? ['--json'] : [])], { from: 'user' });
      expect(cap.code()).toBe(0);
      return cap.lines.join('\n');
    };
    const data = JSON.parse(await render(true));
    expect(data).toMatchObject({ recommended: 0, limitedBy: 'memory', running: 10, memorySlots: 1, placeableSlots: 0 });
    expect(await render(false)).toContain('권장 지금 0 개 더 (limitedBy=memory)');
  });
  test('account read failure is unknown, not zero accounts — and does not block the recommendation (accounts are observed only)', async () => {
    const cap = capture(); const program = new Command(); program.exitOverride();
    registerPodCommands(program, { io: cap.io, kubectl, poolSpec: () => 'node-b:20', accounts: () => { throw new Error('store locked'); } });
    await program.parseAsync(['pod', 'lease', 'status', '--json'], { from: 'user' });
    expect(cap.code()).toBe(0);
    const out = JSON.parse(cap.lines[0]!);
    expect(out).toMatchObject({ accounts: null, accountSlots: null });
    expect(out.recommended).not.toBeNull();
  });
  test('unreachable cluster exits 0 and says unknown (not zero)', async () => {
    const cap = capture(); const program = new Command(); program.exitOverride();
    registerPodCommands(program, { io: cap.io, accounts: () => 0, poolSpec: () => 'node-b:20', kubectl: () => ({ status: 1, stdout: '', stderr: 'timeout' }) });
    await program.parseAsync(['pod', 'lease', 'status', '--json'], { from: 'user' });
    expect(cap.code()).toBe(0);
    expect(JSON.parse(cap.lines[0]!)).toMatchObject({ recommended: null, reason: expect.stringContaining('측정 불가: cluster') });
  });
});

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
