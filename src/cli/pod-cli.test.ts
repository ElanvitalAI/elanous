import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { POD_COMMAND_DEADLINE_SECONDS, registerPodCommands } from './pod-cli.js';
import { POD_HOST_LEASE_ANNOTATION } from '../task-orchestrator/surfaces/pod-lease.js';
import { podPoolHostLease, parsePodPool, PodPoolScheduler } from '../task-orchestrator/surfaces/pod-pool.js';
import { podJobName, podSelfImplementSpawn, type Kubectl } from '../task-orchestrator/surfaces/self-implement-pod.js';
import type { RunPodCommandOptions } from '../task-orchestrator/surfaces/pod-command-job.js';
import { LogStore } from '../mss/logging/log-store.js';
import { HostPoolLease, psProcessStart } from '../pod-lease/host-lease.js';

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
    : args.includes('jobs') ? JSON.stringify({ items: [{ metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' }, annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true' } } }] })
      : JSON.stringify({ items: pods }) });
  const runStatus = async (json: boolean, phase?: 'Pending') => {
    const cap = capture();
    const program = new Command();
    program.exitOverride();
    const observe = phase ? (args: readonly string[]) => args.includes('pods')
      ? { status: 0, stderr: '', stdout: JSON.stringify({ items: [{ ...pods[0], status: { phase } }, ...pods.slice(1)] }) }
      : kubectl(args) : kubectl;
    registerPodCommands(program, { io: cap.io, kubectl: observe, dns: () => 'ready', accounts: () => 10, perAccount: () => 4, poolSpec: () => 'node-b:20' });
    await program.parseAsync(['pod', 'lease', 'status', ...(json ? ['--json'] : [])], { from: 'user' });
    return cap;
  };
  test('status separates authoring reservations, waiting Jobs, and Running Pods', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-lease-status-'));
    const previous = process.env.ELANOUS_POD_LEASE_DIR;
    process.env.ELANOUS_POD_LEASE_DIR = dir;
    try {
      const host = podPoolHostLease(parsePodPool('node-b:20'));
      const authoring = host.tryReserve(() => true)!;
      const job = host.tryReserve(() => true)!;
      job.applied('waiting-job', 'node-b', 'elanous-test');
      const json = await runStatus(true);
      const table = await runStatus(false);
      expect(JSON.parse(json.lines[0]!)).toMatchObject({ reserved: 1, waitingJobs: 1, running: 10 });
      expect(table.lines.join('\n')).toContain('예약(저작 중) 1 · 대기 Job 1 · 실행 10');
      authoring(); job();
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_POD_LEASE_DIR;
      else process.env.ELANOUS_POD_LEASE_DIR = previous;
      require('node:fs').rmSync(dir, { recursive: true, force: true });
    }
  });
  test('status counts a Pending Pod and its host lease once as one waiting Job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-lease-status-'));
    const previous = process.env.ELANOUS_POD_LEASE_DIR;
    process.env.ELANOUS_POD_LEASE_DIR = dir;
    try {
      const host = podPoolHostLease(parsePodPool('node-b:20'));
      const job = host.tryReserve(() => true)!;
      job.applied('harness-job', 'node-b', 'elanous-test');
      const status = await runStatus(true, 'Pending');
      expect(JSON.parse(status.lines[0]!)).toMatchObject({ reserved: 0, waitingJobs: 1, pending: 1, running: 9 });
      job();
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_POD_LEASE_DIR;
      else process.env.ELANOUS_POD_LEASE_DIR = previous;
      require('node:fs').rmSync(dir, { recursive: true, force: true });
    }
  });
  test('same-name Pending Pod in another context cannot hide an unobserved Job lease or admit a third launch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-lease-scoped-status-'));
    const previous = process.env.ELANOUS_POD_LEASE_DIR;
    process.env.ELANOUS_POD_LEASE_DIR = dir;
    const members = parsePodPool('a:1,b:1');
    const makeLease = () => new HostPoolLease('a@,b@', { dir });
    const first = makeLease().tryReserve((n) => n < 2, true)!;
    const second = makeLease().tryReserve((n) => n < 2, true)!;
    first.applied('shared-job', 'a', 'elanous-test');
    second.applied('shared-job', 'b', 'elanous-test');
    const node = JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '64Gi', cpu: '4' }, conditions: [{ type: 'Ready', status: 'True' }] } }] });
    const pendingPod = { metadata: { namespace: 'elanous-test', name: 'waiting-a', labels: { 'elanous.substrate': 'pod', 'elanous.job': 'shared-job' } },
      status: { phase: 'Pending' }, spec: { containers: [{ resources: { requests: { memory: '4Gi' }, limits: { memory: '16Gi' } } }] } };
    const kubectl = (args: readonly string[]) => ({ status: 0, stderr: '', stdout: args.includes('nodes') ? node
      : args.includes('jobs') ? JSON.stringify({ items: [{ metadata: { name: 'shared-job', labels: { 'elanous.substrate': 'pod' } } }] })
        : JSON.stringify({ items: args[1] === 'a' ? [pendingPod] : [] }) });
    const cap = capture(); const program = new Command(); program.exitOverride();
    const poolSpec = () => 'a:1,b:1';
    try {
      registerPodCommands(program, { io: cap.io, kubectl, dns: () => 'ready', accounts: () => 0, poolSpec });
      await program.parseAsync(['pod', 'lease', 'status', '--json'], { from: 'user' });
      expect(JSON.parse(cap.lines[0]!)).toMatchObject({ pending: 1, waitingJobs: 2, reserved: 0, running: 0,
        pendingJobs: [{ context: 'a', namespace: 'elanous-test', job: 'shared-job' }] });
      const contender = new HostPoolLease('a@,b@', { dir, pid: 101, processStart: (pid) => pid === 101 ? 'contender' : psProcessStart(pid) });
      const scheduler = new PodPoolScheduler(members, { hostLease: contender, kubectl, dns: () => 'ready', pollMs: 2 });
      const controller = new AbortController();
      const third = scheduler.acquireAdmission(controller.signal).then((release) => { release(); return 'admitted'; }, (error: Error) => error.message);
      try {
        await Bun.sleep(20);
        expect(scheduler.admissionSnapshot()).toMatchObject({ active: 0, queued: 1 });
      } finally { controller.abort(); }
      expect(await third).toBe('pod lease admission aborted');
    } finally {
      first(); second();
      if (previous === undefined) delete process.env.ELANOUS_POD_LEASE_DIR;
      else process.env.ELANOUS_POD_LEASE_DIR = previous;
      require('node:fs').rmSync(dir, { recursive: true, force: true });
    }
  });
  test('actual Job apply binds the lease to its Job so Pending is one waiting Job until Running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-lease-applied-status-'));
    const previous = process.env.ELANOUS_POD_LEASE_DIR;
    process.env.ELANOUS_POD_LEASE_DIR = dir;
    const host = podPoolHostLease(parsePodPool('node-b:20'));
    const pool = new PodPoolScheduler(parsePodPool('node-b:20'), { hostLease: host, pollMs: 2, status: () => ({
      recommended: 1, accountSlots: 0, limitedBy: 'capacity', reason: null,
      capacitySlots: 20, memorySlots: 20, placeableSlots: 20, running: 9, pending: 0,
    }) });
    let appliedJob: string | undefined;
    let phase: 'Pending' | 'Running' | 'Complete' = 'Pending';
    const spawnKubectl: Kubectl = (args, input) => {
      if (args.includes('apply') && input) {
        const manifest = JSON.parse(input) as { kind: string; metadata: { name: string } };
        if (manifest.kind === 'Job') appliedJob = manifest.metadata.name;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: phase === 'Complete' ? 'Complete' : '', stderr: '' };
      if (args.includes('jsonpath={.items[*].status.phase}')) return { status: 0, stdout: phase, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const controller = new AbortController();
    let launched: ReturnType<ReturnType<typeof podSelfImplementSpawn>> | undefined;
    try {
      const spawn = podSelfImplementSpawn({ pool, kubectl: spawnKubectl, pollMs: 2, imageCommit: null,
        credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }) });
      launched = spawn({ spaceId: 'pending-actual-apply', feature: 'f', signal: controller.signal });
      for (let n = 0; n < 100 && !appliedJob; n++) await Bun.sleep(5);
      expect(appliedJob).toBe(podJobName('pending-actual-apply'));
      const expected = appliedJob!;
      for (let n = 0; n < 100 && host.live()[0]?.job !== expected; n++) await Bun.sleep(5);
      expect(host.live()).toEqual([expect.objectContaining({ stage: 'job', job: expected })]);
      const status = capture();
      const program = new Command();
      program.exitOverride();
      const observe = (args: readonly string[]) => {
        if (args.includes('nodes')) return kubectl(args);
        if (args.includes('jobs')) return { status: 0, stderr: '', stdout: JSON.stringify({ items: [{ metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' }, annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true' } } }, { metadata: { name: expected, labels: { 'elanous.substrate': 'pod' }, annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true' } } }] }) };
        if (args.includes('pods')) return { status: 0, stderr: '', stdout: JSON.stringify({ items: [{ ...pods[0], metadata: { ...pods[0]!.metadata, labels: { 'elanous.job': expected, 'elanous.substrate': 'pod' } }, status: { phase: 'Pending' } }, ...pods.slice(1).map((pod) => ({ ...pod, metadata: { ...pod.metadata, labels: { ...pod.metadata.labels, 'elanous.substrate': 'pod' } } }))] }) };
        return { status: 0, stderr: '', stdout: JSON.stringify({ items: [] }) };
      };
      registerPodCommands(program, { io: status.io, kubectl: observe, dns: () => 'ready', accounts: () => 10, perAccount: () => 4, poolSpec: () => 'node-b:20' });
      await program.parseAsync(['pod', 'lease', 'status', '--json'], { from: 'user' });
      expect(JSON.parse(status.lines[0]!)).toMatchObject({ reserved: 0, waitingJobs: 1, pending: 1, running: 9 });
      expect(host.live()).toHaveLength(1);
      phase = 'Running';
      for (let n = 0; n < 100 && host.live().length; n++) await Bun.sleep(5);
      expect(host.live()).toHaveLength(0);
      phase = 'Complete';
      expect((await launched.done).exitCode).toBe(0);
    } finally {
      controller.abort();
      phase = 'Complete';
      if (launched) await launched.done;
      if (previous === undefined) delete process.env.ELANOUS_POD_LEASE_DIR;
      else process.env.ELANOUS_POD_LEASE_DIR = previous;
      require('node:fs').rmSync(dir, { recursive: true, force: true });
    }
  });
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
  test('two Running legacy Jobs without host leases are separate and deducted from recommended N', async () => {
    const legacyPods = Array.from({ length: 2 }, (_, i) => ({
      metadata: { namespace: 'elanous-test', name: `legacy-${i}`, labels: { 'elanous.job': `legacy-job-${i}` } },
      status: { phase: 'Running' },
      spec: { nodeName: 'node-1', containers: [{ resources: { limits: { memory: '1Gi' }, requests: { memory: '1Gi' } } }] },
    }));
    const legacyKubectl = (args: readonly string[]) => args.includes('jobs')
      ? { status: 0, stderr: '', stdout: JSON.stringify({ items: [
        { metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' }, annotations: { [POD_HOST_LEASE_ANNOTATION]: 'true' } } },
        ...legacyPods.map((_, i) => ({ metadata: { name: `legacy-job-${i}`, labels: { 'elanous.substrate': 'pod' } } })),
      ] }) }
      : args.includes('pods') ? { status: 0, stderr: '', stdout: JSON.stringify({ items: [...pods, ...legacyPods] }) }
        : { status: 0, stderr: '', stdout: JSON.stringify({ items: [{ metadata: { name: 'node-1' }, status: { allocatable: { memory: '1024Gi', cpu: '32' }, conditions: [{ type: 'Ready', status: 'True' }] } }] }) };
    const render = async (json: boolean) => {
      const cap = capture(); const program = new Command(); program.exitOverride();
      registerPodCommands(program, { io: cap.io, kubectl: legacyKubectl, dns: () => 'ready', accounts: () => 10, perAccount: () => 4, poolSpec: () => 'node-b:20' });
      await program.parseAsync(['pod', 'lease', 'status', ...(json ? ['--json'] : [])], { from: 'user' });
      expect(cap.code()).toBe(0);
      return cap.lines.join('\n');
    };
    const data = JSON.parse(await render(true));
    expect(data).toMatchObject({ running: 12, pending: 0, unleasedRunning: 2, capacitySlots: 8, placeableSlots: 8, recommended: 6 });
    expect(data.members[0]).toMatchObject({ running: 12, unleasedRunning: 2 });
    const table = await render(false);
    expect(table).toContain('임대 없는 실행 2');
    expect(table).toContain('권장 지금 6 개 더 (limitedBy=capacity)');
    expect(table).toContain('권장 수에서 건강한 멤버의 임대 없는 실행 차감');
  });
  test('no --pool reports configured harness.podPool rather than current context', async () => {
    const calls: string[][] = [];
    const cap = capture(); const program = new Command(); program.exitOverride();
    registerPodCommands(program, {
      io: cap.io, dns: () => 'ready', accounts: () => 10, perAccount: () => 4,
      harnessPool: () => 'node-b:20',
      kubectl: (args) => {
        calls.push([...args]);
        if (args.includes('current-context')) return { status: 0, stdout: 'local-context', stderr: '' };
        return kubectl(args);
      },
    });
    await program.parseAsync(['pod', 'lease', 'status', '--json'], { from: 'user' });
    expect(cap.code()).toBe(0);
    expect(JSON.parse(cap.lines[0]!)).toMatchObject({ pool: 'node-b:20', members: [{ context: 'node-b', capacity: 20 }] });
    // nodes · jobs · pods ⊕ POD-ADMIT-BY-USAGE `top pods` (a read; unparseable here → limits as before).
    expect(calls).toHaveLength(4);
    expect(calls.every((args) => args[0] === '--context' && args[1] === 'node-b')).toBe(true);
    const table = capture(); const tableProgram = new Command(); tableProgram.exitOverride();
    registerPodCommands(tableProgram, { io: table.io, kubectl, dns: () => 'ready', accounts: () => 10, perAccount: () => 4, harnessPool: () => 'node-b:20' });
    await tableProgram.parseAsync(['pod', 'lease', 'status'], { from: 'user' });
    expect(table.code()).toBe(0);
    expect(table.lines[0]).toBe('풀: node-b:20');
  });
  test('explicit pool spec wins; resource probes are reads', async () => {
    const calls: string[][] = [];
    const cap = capture(); const program = new Command(); program.exitOverride();
    registerPodCommands(program, {
      io: cap.io, dns: () => 'ready', accounts: () => 10, perAccount: () => 4,
      harnessPool: () => 'wrong:2',
      kubectl: (args) => { calls.push([...args]); return kubectl(args); },
    });
    await program.parseAsync(['pod', 'lease', 'status', '--pool', 'node-b:20', '--json'], { from: 'user' });
    expect(JSON.parse(cap.lines[0]!).pool).toBe('node-b:20');
    expect(calls).toHaveLength(4);
    expect(calls.find((args) => args.includes('pods') && args.includes('get'))).toContain('--all-namespaces');
    expect(calls.find((args) => args.includes('top'))).toEqual(['--context', 'node-b', '--request-timeout=10s', '-n', 'elanous-test', 'top', 'pods', '--no-headers']);
    expect(calls.every((args) => args[0] === '--context' && args[1] === 'node-b' && args[2] === '--request-timeout=10s' && (args.includes('get') || args.includes('top')))).toBe(true);
  });
  test('foreign Pod reservation is reflected in both JSON and the table', async () => {
    const foreign = { metadata: { namespace: 'system', name: 'foreign', labels: {} }, status: { phase: 'Running' },
      spec: { nodeName: 'node-1', containers: [{ resources: { requests: { memory: '16Gi' } } }] } };
    const occupied = (args: readonly string[]) => args.includes('pods')
      ? { status: 0, stderr: '', stdout: JSON.stringify({ items: [foreign, ...pods] }) } : kubectl(args);
    const render = async (json: boolean) => {
      const cap = capture(); const program = new Command(); program.exitOverride();
      registerPodCommands(program, { io: cap.io, kubectl: occupied, dns: () => 'ready', accounts: () => 10, perAccount: () => 4, poolSpec: () => 'node-b:20' });
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
    registerPodCommands(program, { io: cap.io, kubectl, dns: () => 'ready', poolSpec: () => 'node-b:20', accounts: () => { throw new Error('store locked'); } });
    await program.parseAsync(['pod', 'lease', 'status', '--json'], { from: 'user' });
    expect(cap.code()).toBe(0);
    const out = JSON.parse(cap.lines[0]!);
    expect(out).toMatchObject({ accounts: null, accountSlots: null });
    expect(out.recommended).not.toBeNull();
  });
  test('a DNS-broken member has zero slots and reason dns in JSON and the table', async () => {
    const render = async (json: boolean) => {
      const cap = capture(); const program = new Command(); program.exitOverride();
      registerPodCommands(program, { io: cap.io, kubectl, dns: (context) => context === 'good' ? 'ready' : 'dns', accounts: () => 1, poolSpec: () => 'bad:2,good:2' });
      await program.parseAsync(['pod', 'lease', 'status', ...(json ? ['--json'] : [])], { from: 'user' });
      expect(cap.code()).toBe(0);
      return cap.lines.join('\n');
    };
    const data = JSON.parse(await render(true));
    expect(data.members.map((m: { capacity: number; reason: string | null }) => [m.capacity, m.reason])).toEqual([[0, 'dns'], [2, null]]);
    expect(data).toMatchObject({ recommended: 0, reason: 'dns' });
    expect(await render(false)).toContain('bad | 0 | 10 | 0');
    expect(await render(false)).toContain('(dns)');
  });
  test('DNS-broken member reports its unleased Running Job without deducting healthy capacity', async () => {
    const badPod = { ...pods[0]!, metadata: { ...pods[0]!.metadata, name: 'legacy-bad' } };
    const memberKubectl = (args: readonly string[]) => args.includes('jobs')
      ? { status: 0, stderr: '', stdout: JSON.stringify({ items: [{ metadata: { name: 'harness-job', labels: { 'elanous.substrate': 'pod' } } }] }) }
      : args.includes('pods') ? { status: 0, stderr: '', stdout: JSON.stringify({ items: args[1] === 'bad' ? [badPod] : [] }) } : kubectl(args);
    const render = async (json: boolean) => {
      const cap = capture(); const program = new Command(); program.exitOverride();
      registerPodCommands(program, { io: cap.io, kubectl: memberKubectl, dns: (context) => context === 'bad' ? 'dns' : 'ready', accounts: () => 1, poolSpec: () => 'bad:2,good:2' });
      await program.parseAsync(['pod', 'lease', 'status', ...(json ? ['--json'] : [])], { from: 'user' });
      expect(cap.code()).toBe(0);
      return cap.lines.join('\n');
    };
    expect(JSON.parse(await render(true))).toMatchObject({ recommended: 2, unleasedRunning: 1, members: [{ reason: 'dns', unleasedRunning: 1 }, { reason: null, unleasedRunning: 0 }] });
    const table = await render(false);
    expect(table).toContain('권장 지금 2 개 더');
    expect(table).toContain('임대 없는 실행 1');
    expect(table).toContain('권장 수에서 건강한 멤버의 임대 없는 실행 차감');
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

  test('pod run prints the directory written by its Job and returns its child logs to the launching log store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-cli-return-'));
    const store = new LogStore(join(dir, '.elanous', 'logs', 'logs.db'));
    const cap = capture();
    const program = new Command();
    program.exitOverride();
    const prev = process.argv;
    const ts = new Date().toISOString();
    const podHome = join(dir, 'pod');
    mkdirSync(podHome);
    const podLogs = new LogStore(join(podHome, '.elanous', 'logs', 'logs.db'));
    podLogs.insertBatch([{ surface: 'pod', rec: { ts, category: 'pod.command', event: 'returned-child', data: { from: 'pod' } } }]);
    podLogs.close();
    const bin = join(dir, 'elanous');
    writeFileSync(bin, `#!/bin/bash\nexec bun ${JSON.stringify(resolve('bin/elanous.mjs'))} "$@"\n`);
    chmodSync(bin, 0o755);
    process.argv = ['bun', 'elanous', 'pod', 'run', '--', 'sh', '-c', 'mkdir -p "$HOME/outbox"; printf saved > "$HOME/outbox/note.txt"; printf child-output'];
    let appliedScript = '';
    let childOutput = '';
    try {
      registerPodCommands(program, { io: cap.io, run: async (options) => {
        const { runPodCommand } = await import('../task-orchestrator/surfaces/pod-command-job.js');
        const result = await runPodCommand({ ...options, name: 'si-cmd-cli', imageCommit: null, artifactsRoot: join(dir, 'artifacts'), logStore: store,
          kubectl: (args, input) => {
            if (input) {
              const body = JSON.parse(input) as { kind: string; spec?: { template: { spec: { containers: Array<{ args: string[] }> } } } };
              if (body.kind === 'Job') {
                appliedScript = body.spec!.template.spec.containers[0]!.args[0]!;
                const ran = spawnSync('bash', ['-c', appliedScript.slice(appliedScript.indexOf('set -- '))], {
                  cwd: podHome, encoding: 'utf8',
                  env: { ...process.env, HOME: podHome, PATH: `${dir}:${process.env.PATH ?? ''}` },
                });
                expect(ran.status).toBe(0);
                childOutput = ran.stdout;
                expect(childOutput).toContain('ELANOUS_POD_ARTIFACT ' + Buffer.from('note.txt').toString('base64url'));
              }
            }
            if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
            if (args.includes('logs')) return { status: 0, stdout: childOutput, stderr: '' };
            return { status: 0, stdout: '0', stderr: '' };
          },
        });
        expect(result.artifacts).toEqual({ files: 2, names: ['note.txt', 'pod-logs/logs.jsonl'], error: null });
        return result;
      } });
      await program.parseAsync(['pod', 'run', '--', 'sh', '-c', 'mkdir -p "$HOME/outbox"; printf saved > "$HOME/outbox/note.txt"; printf child-output'], { from: 'user' });
      const path = join(dir, 'artifacts', 'si-cmd-cli');
      expect(appliedScript).toContain('elanous --test="$HOME/.elanous-test" logs --instance prod --since 12h --limit 20000 --json --json-data');
      expect(cap.lines).toEqual([path]);
      expect(cap.code()).toBe(0);
      expect(readFileSync(join(path, 'child.log'), 'utf8')).toContain('child-output');
      expect(readFileSync(join(path, 'child.log'), 'utf8')).toContain('ELANOUS_POD_ARTIFACT ' + Buffer.from('note.txt').toString('base64url'));
      expect(readFileSync(join(path, 'note.txt'), 'utf8')).toBe('saved');
      expect(readFileSync(join(path, 'pod-logs/logs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).some((entry) => entry.event === 'returned-child' && entry.data?.from === 'pod')).toBe(true);
      expect(store.query({ events: ['returned-child'] }).map(({ data }) => JSON.parse(data ?? '{}'))).toEqual([{ from: 'pod', origin: 'pod', podJob: 'si-cmd-cli' }]);
      expect(store.query({ events: ['child-output'] }).map(({ data }) => JSON.parse(data ?? '{}'))).toEqual([
        expect.objectContaining({ job: 'si-cmd-cli', origin: 'pod', podJob: 'si-cmd-cli', output: 'child-output' }),
      ]);
      const cli = spawnSync('bun', [resolve('bin/elanous.mjs'), '--test=' + join(dir, 'cli-test'), 'logs', '--instance', 'prod', '--event', 'returned-child', '--json', '--json-data'], {
        encoding: 'utf8', env: { ...process.env, HOME: dir }, cwd: process.cwd(),
      });
      expect(cli.status).toBe(0);
      expect(cli.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.event === 'returned-child')).toEqual([
        expect.objectContaining({ category: 'pod.command', event: 'returned-child', data: { from: 'pod', origin: 'pod', podJob: 'si-cmd-cli' } }),
      ]);
    } finally { process.argv = prev; store.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

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

  test('로그 조회 실패면 알린 경로와 함께 «산출 회수 못 함: <사유>» 를 출력한다', async () => {
    const cap = capture();
    const program = new Command();
    program.exitOverride();
    const prev = process.argv;
    process.argv = ['bun', 'elanous', 'pod', 'run', '--', 'echo', 'hi'];
    try {
      registerPodCommands(program, {
        io: cap.io,
        run: async () => ({ exitCode: 1, artifactsDir: '/artifacts/job', job: 'job', artifacts: { files: null, names: [], error: 'connection refused' } }),
      });
      await program.parseAsync(['pod', 'run', '--', 'echo', 'hi'], { from: 'user' });
    } finally { process.argv = prev; }
    expect(cap.lines).toEqual(['/artifacts/job']);
    expect(cap.errors).toContain('산출 회수 못 함: connection refused');
    expect(cap.code()).toBe(1);
  });
});
