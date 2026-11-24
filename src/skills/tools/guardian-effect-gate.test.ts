import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { classifyDestructive } from '../../ask-user-question/guardian.js';
import { relaxHold } from '../../shell-primitive/relax-hold.js';
import { setShellApprover } from '../../shell-primitive/runtime.js';
import { resetShellRunnerDeps, setShellRunnerDeps } from '../../shell-runner/dispatch.js';
import { createFileCaptureEngine } from '../../shell-runner/file-engine.js';
import { createShellRegistry } from '../../shell-runner/registry.js';
import { runShellRuntime } from '../../tool-runtime/run-shell-runtime.js';
import type { ToolRuntimeContext } from '../../tool-runtime/types.js';
import { dispatchNextTuiBash } from '../../tui-client/next-shell-approval.js';
import { dispatchRunShell } from './shell.js';
import { dispatchBash } from './index.js';

const forbidden = [
  { name: 'sudo', argv: ['sudo', '-n', 'true'], bash: 'sudo -n true' },
  { name: 'recursive rm', argv: ['rm', '-rf', '/tmp/guardian-simulated'], bash: 'rm -rf /tmp/guardian-simulated' },
  { name: 'force push', argv: ['git', 'push', '--force', 'origin', 'simulated'], bash: 'git push --force origin simulated' },
  { name: 'drop table', argv: ['sqlite3', ':memory:', 'DROP TABLE simulated'], bash: 'sqlite3 :memory: "DROP TABLE simulated"' },
];

// 스폰 게이트는 argv[0]을 Bun.which로 절대경로 해상한 뒤 승인을 요청한다(#39630/#39782/#39813 스폰 승인 계약).
// relax-hold 대군(data-store destruction 등)은 서명 그랜트 경로로만 승인되므로 그랜트 키가 없는 시험 호스트에서는
// 승인 질의 없이 fail-closed 거부된다(node-b 프로브 실측: asked=[] · approvalKey 'runner:denied' · outcome 'denied').
const spawnArgv = (row: { argv: string[] }): string[] => {
  const bin = Bun.which(row.argv[0] ?? '');
  return bin ? [bin, ...row.argv.slice(1)] : row.argv;
};
const askableArgv = (rows: typeof forbidden): string[][] =>
  rows.filter(row => relaxHold(row.argv, '/tmp/guardian-simulated') === null).map(row => row.argv);

function simulatedChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean;
  };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null); });
  return child;
}

afterEach(() => { resetShellRunnerDeps(); setShellApprover(null); });

test('TUI RunShell runner asks approval and spawns none of four forbidden effects', async () => {
  const actualSpawns: string[][] = [];
  const asked: string[][] = [];
  setShellRunnerDeps({ registry: createShellRegistry(), fileEngine: createFileCaptureEngine({
    spawnFn: ((command: string, args: string[]) => { actualSpawns.push([command, ...args]); return simulatedChild(); }) as never,
  }) });
  setShellApprover(async request => { asked.push(request.command); return 'deny-once'; });
  const ctx = { surface: 'tui', signal: new AbortController().signal, sessionId: 'guardian-test-universe' } as ToolRuntimeContext;
  for (const row of forbidden) {
    expect(classifyDestructive(row.argv)?.reason, row.name).toBeTruthy();
    const result = await runShellRuntime.run({ command: row.argv, mode: 'inline', approval: 'none' }, ctx);
    expect(result.outcome, row.name).toBe('denied');
  }
  expect(asked).toEqual(askableArgv(forbidden));
  expect(actualSpawns).toEqual([]);
});

test('Bash tool asks approval and spawns none of four forbidden effects', async () => {
  const actualSpawns: string[][] = [];
  const asked: string[][] = [];
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: string[]) => {
    actualSpawns.push([command, ...args]); return simulatedChild();
  }) as unknown as typeof childProcess.spawn);
  setShellApprover(async request => { asked.push(request.command); return 'deny-once'; });
  try {
    // Prove the fake is on the real dispatch boundary before any forbidden command is submitted.
    await dispatchBash({ command: 'true' }, { cwd: '/tmp/guardian-simulated', shell: 'bash', sandbox: 'off' });
    expect(spawn).toHaveBeenCalledTimes(1);
    actualSpawns.length = 0;
    for (const row of forbidden) {
      expect(classifyDestructive(['bash', '-c', row.bash])?.reason, row.name).toBeTruthy();
      const result = await dispatchBash({ command: row.bash }, { cwd: '/tmp/guardian-simulated', shell: 'bash', sandbox: 'off' });
      expect(result.exitCode, row.name).not.toBe(0);
    }
    expect(asked).toEqual(forbidden.map(row => ['bash', '-c', row.bash]));
    expect(actualSpawns).toEqual([]);
  } finally { spawn.mockRestore(); }
});

test('background RunShell waits before spawn and an explicit approval resumes execution', async () => {
  const spawns: string[][] = [];
  setShellRunnerDeps({ registry: createShellRegistry(), fileEngine: createFileCaptureEngine({
    spawnFn: ((command: string, args: string[]) => { spawns.push([command, ...args]); return simulatedChild(); }) as never,
  }) });
  let approve!: (decision: 'allow-once') => void;
  setShellApprover(() => new Promise(resolve => { approve = resolve; }));
  const ctx = { surface: 'tui', signal: new AbortController().signal, sessionId: 'guardian-test-universe' } as ToolRuntimeContext;
  const pending = runShellRuntime.run({ command: forbidden[0]!.argv, mode: 'bg', approval: 'none' }, ctx);
  await Bun.sleep(0);
  expect(spawns).toEqual([]);
  approve('allow-once');
  const result = await pending;
  expect(result.outcome).toBe('started');
  expect(spawns).toEqual([spawnArgv(forbidden[0]!)]);
});

test('Bash waits before spawn and preserves ordinary execution', async () => {
  const spawns: string[][] = [];
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: string[]) => {
    spawns.push([command, ...args]); return simulatedChild();
  }) as unknown as typeof childProcess.spawn);
  let approve!: (decision: 'allow-once') => void;
  setShellApprover(() => new Promise(resolve => { approve = resolve; }));
  try {
    const pending = dispatchBash({ command: forbidden[0]!.bash }, { cwd: '/tmp/guardian-simulated', shell: 'bash', sandbox: 'off' });
    await Bun.sleep(0);
    expect(spawns).toEqual([]);
    approve('allow-once');
    const allowed = await pending;
    expect(allowed.exitCode).toBe(0);
    expect(spawns).toEqual([['bash', '-c', forbidden[0]!.bash]]);
    const ordinary = await dispatchBash({ command: 'true' }, { cwd: '/tmp/guardian-simulated', shell: 'bash', sandbox: 'off' });
    expect(ordinary.exitCode).toBe(0);
    expect(spawns[1]).toEqual(['bash', '-c', 'true']);
  } finally { spawn.mockRestore(); }
});

test('Next TUI host approval is honored once at the actual runner boundary', async () => {
  const spawns: string[][] = [];
  setShellRunnerDeps({ registry: createShellRegistry(), fileEngine: createFileCaptureEngine({
    spawnFn: ((command: string, args: string[]) => { spawns.push([command, ...args]); return simulatedChild(); }) as never,
  }) });
  setShellApprover(null);
  let approvals = 0;
  const command = forbidden[0]!.argv;
  const invoke = (allow: boolean) => dispatchNextTuiBash({
    command: command.join(' '), enabled: true, requiresApproval: true,
    approve: async () => { approvals += 1; return allow; },
    dispatch: priorHumanApproval => dispatchRunShell({ command, mode: 'inline', approval: 'none' }, { priorHumanApproval }),
  });
  expect(await invoke(false)).toMatchObject({ error: expect.stringContaining('denied') });
  expect(spawns).toEqual([]);
  expect(await invoke(true)).toMatchObject({ outcome: 'exit', exitCode: 0 });
  expect(spawns).toEqual([spawnArgv(forbidden[0]!)]);
  expect(approvals).toBe(2);
});

test('missing approval channel fails closed on both tool dispatchers', async () => {
  const spawns: string[][] = [];
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: string[]) => {
    spawns.push([command, ...args]); return simulatedChild();
  }) as unknown as typeof childProcess.spawn);
  try {
    setShellRunnerDeps({ registry: createShellRegistry(), fileEngine: createFileCaptureEngine({
      spawnFn: ((command: string, args: string[]) => { spawns.push([command, ...args]); return simulatedChild(); }) as never,
    }) });
    setShellApprover(null);
    const runner = await dispatchRunShell({ command: forbidden[0]!.argv, mode: 'inline', approval: 'none' });
    expect(runner.outcome).toBe('denied');
    expect(spawns).toEqual([]);
    const bash = await dispatchBash({ command: forbidden[0]!.bash }, { cwd: '/tmp/guardian-simulated', sandbox: 'off' });
    expect(bash.exitCode).not.toBe(0);
    expect(spawns).toEqual([]);
  } finally { spawn.mockRestore(); }
});

test('late approval after turn cancellation never starts the runner or Bash', async () => {
  const spawns: string[][] = [];
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: string[]) => {
    spawns.push([command, ...args]); return simulatedChild();
  }) as unknown as typeof childProcess.spawn);
  try {
    setShellRunnerDeps({ registry: createShellRegistry(), fileEngine: createFileCaptureEngine({
      spawnFn: ((command: string, args: string[]) => { spawns.push([command, ...args]); return simulatedChild(); }) as never,
    }) });
    let approve!: (decision: 'allow-once') => void;
    setShellApprover(() => new Promise(resolve => { approve = resolve; }));
    const runnerAbort = new AbortController();
    const runnerPending = dispatchRunShell({ command: forbidden[0]!.argv, mode: 'inline' }, { signal: runnerAbort.signal });
    await Bun.sleep(0);
    runnerAbort.abort();
    approve('allow-once');
    expect((await runnerPending).outcome).toBe('aborted');
    const bashAbort = new AbortController();
    const bashPending = dispatchBash({ command: forbidden[0]!.bash }, { cwd: '/tmp/guardian-simulated', signal: bashAbort.signal });
    await Bun.sleep(0);
    bashAbort.abort();
    approve('allow-once');
    expect((await bashPending).exitCode).not.toBe(0);
    expect(spawns).toEqual([]);
  } finally { spawn.mockRestore(); }
});
