import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { HAND_RESPONSE_ACTIONS, planHandResponseAction, runDetachedHandResponseCommand, runHandResponseNode } from './hand-response-node.js';
import type { GraphContext } from './node-verdict.js';

function context(nodeId: string, nodeInput: Record<string, unknown> = {}, outputs: GraphContext['outputs'] = {}): GraphContext {
  return { graphId: 'release-loop', nodeId, runId: 'sim-run', input: { version: '0.3.7', previousVersion: '0.3.6' }, nodeInput, outputs };
}

const approved = (action: string, extra: Record<string, unknown> = {}) => ({ apply: true, approvedAction: action, ...extra });

test('recipes register each new RLA response node without changing release-loop wiring', () => {
  const recipes = parseYaml(readFileSync(new URL('../../graphs/release/recipes.yaml', import.meta.url), 'utf8')) as Record<string, { command?: string }>;
  const graph = readFileSync(new URL('../../graphs/release/release-loop.yaml', import.meta.url), 'utf8');
  for (const action of HAND_RESPONSE_ACTIONS) {
    expect(recipes[action]?.command).toBe(`bun scripts/release-loop/hand-response-node.ts ${action}`);
  }
  expect(graph).not.toContain('rla-release-autostart');
  expect(graph).not.toContain('rla-cloud-join');
});

test('mutating response actions are plan-only until matching approval is in graph node input', () => {
  const action = 'rla-cloud-join';
  const plan = planHandResponseAction(action, context(action, { host: 'aws1' }), { ELANOUS_HQ_OP_TOOLS_DIR: '/hq/op-tools' });
  expect(plan).toMatchObject({ command: 'zsh', args: ['/hq/op-tools/cloud-join.sh', 'aws1', '--dry-run'], mutatesState: true, approved: false });
  const applied = planHandResponseAction(action, context(action, approved(action, { host: 'aws1' })), { ELANOUS_HQ_OP_TOOLS_DIR: '/hq/op-tools' });
  expect(applied).toMatchObject({ command: 'zsh', args: ['/hq/op-tools/cloud-join.sh', 'aws1'], mutatesState: true, approved: true });
});

test('release auto-start and recover map to their existing guarded CLI operations', () => {
  expect(planHandResponseAction('rla-release-autostart', context('rla-release-autostart', approved('rla-release-autostart'))))
    .toMatchObject({ command: 'eln', args: ['release', 'auto-start', '--apply', '--json'] });
  expect(planHandResponseAction('rla-release-recover', context('rla-release-recover', approved('rla-release-recover', {
    runId: 'release-loop/4d9738ae-91a2-4a75-b9ef-15453696a613', pickShas: ['0123456789abcdef0123456789abcdef01234567'],
  }))).args).toEqual(['release', 'recover', '--run', 'release-loop/4d9738ae-91a2-4a75-b9ef-15453696a613',
    '--pick', '0123456789abcdef0123456789abcdef01234567', '--json']);
});

test('worker restart uses the named K-OP-147 script path and bounded worker environment', () => {
  const plan = planHandResponseAction('rla-train-worker-restart', context('rla-train-worker-restart', approved('rla-train-worker-restart', {
    host: 'aws1', slot: '2', stopAt: '202611080700',
  })), { ELANOUS_HQ_OP_TOOLS_DIR: '/hq/op-tools' });
  expect(plan.command).toBe('perl');
  expect(plan.args).toEqual(['-e', 'setpgrp(0,0); exec @ARGV', 'zsh', '/hq/op-tools/train-auto-loop.sh']);
  expect(plan).toMatchObject({ detached: true });
  expect(plan.env).toMatchObject({ HOST: 'aws1', TRAIN_SLOT: '2', TRAIN_WORKER_MODE: '1', STOP_AT: '202611080700', RETRY_HOST: 'aws1' });
});

test('rehearsal retry preserves the failed stamp under a reason suffix before ticking', () => {
  const plan = planHandResponseAction('rla-rehearsal-retry', context('rla-rehearsal-retry', approved('rla-rehearsal-retry', {
    version: '0.3.7', step: 'hard-5h', reason: 'pod-member-missing',
  })), { ELANOUS_STATE_DIR: '/tmp/test-state' });
  expect(plan.archiveStamp).toEqual({
    source: '/tmp/test-state/release/0.3.7/rehearsal/hard-5h.json',
    destination: '/tmp/test-state/release/0.3.7/rehearsal/hard-5h.json.pod-member-missing',
  });
  expect(plan.args).toEqual(['release', 'rehearsal', 'tick', '--apply', '--json']);
});

test('rehearsal retry restores its archived stamp when the tick fails', async () => {
  const action = 'rla-rehearsal-retry';
  const env = { ELANOUS_GRAPH_CONTEXT: JSON.stringify(context(action, approved(action, {
    version: '0.3.7', step: 'hard-5h', reason: 'pod-member-missing',
  }))), ELANOUS_STATE_DIR: '/tmp/test-state' };
  let restored: [string, string] | undefined;
  const priorLog = console.log;
  console.log = () => {};
  try {
    expect(await runHandResponseNode(action, env, {
      archiveStamp: (source, destination) => expect(destination).toBe(`${source}.pod-member-missing`),
      restoreStamp: (source, destination) => { restored = [source, destination]; },
      run: () => ({ status: 1, stdout: '', stderr: 'tick failed' }),
    })).toBe(1);
  } finally { console.log = priorLog; }
  expect(restored).toEqual([
    '/tmp/test-state/release/0.3.7/rehearsal/hard-5h.json',
    '/tmp/test-state/release/0.3.7/rehearsal/hard-5h.json.pod-member-missing',
  ]);
});

test('detached worker startup errors are returned as failures instead of success', async () => {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: undefined });
  child.unref = () => child;
  const fakeSpawn = (() => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const result = await runDetachedHandResponseCommand('worker', [], {}, fakeSpawn);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('spawn failed');
});

test('detached worker exits before its PID readiness marker and is reported as failure', async () => {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: 321 });
  child.unref = () => child;
  const fakeSpawn = (() => {
    queueMicrotask(() => {
      child.emit('spawn');
      queueMicrotask(() => child.emit('exit', 0, null));
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const result = await runDetachedHandResponseCommand('worker', [], {}, fakeSpawn, { timeoutMs: 100, readWorkerPid: () => '' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('worker exited before ready');
  expect(result.stderr).toContain('code=0');
});

test('detached worker reports ready only after its PID marker matches the spawned process', async () => {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: 321 });
  let unrefed = false;
  child.unref = () => { unrefed = true; return child; };
  const fakeSpawn = (() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const result = await runDetachedHandResponseCommand('worker', [], {}, fakeSpawn, {
    timeoutMs: 100,
    readWorkerPid: () => '321',
  });
  expect(result).toMatchObject({ status: 0, stdout: 'worker ready pid=321' });
  expect(unrefed).toBe(true);
});

test('detached worker PID marker read errors become a failed node result', async () => {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: 321 });
  let killed = false;
  let unrefed = false;
  child.kill = () => { killed = true; return true; };
  child.unref = () => { unrefed = true; return child; };
  const fakeSpawn = (() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const result = await runDetachedHandResponseCommand('worker', [], {}, fakeSpawn, {
    timeoutMs: 100,
    readWorkerPid: () => { throw new Error('marker disappeared'); },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('PID marker read failed');
  expect(result.stderr).toContain('marker disappeared');
  expect(killed).toBe(true);
  expect(unrefed).toBe(true);
});

test('detached worker readiness timeout terminates and unreferences the child', async () => {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: 321 });
  let killed = false;
  let unrefed = false;
  child.kill = () => { killed = true; return true; };
  child.unref = () => { unrefed = true; return child; };
  const fakeSpawn = (() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const result = await runDetachedHandResponseCommand('worker', [], {}, fakeSpawn, {
    timeoutMs: 0,
    readWorkerPid: () => '',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('readiness timeout');
  expect(killed).toBe(true);
  expect(unrefed).toBe(true);
});

test('focused verification only sends introduced test paths to aws1', () => {
  const plan = planHandResponseAction('rla-focused-verify', context('rla-focused-verify', {
    host: 'aws1', remoteCommandRoot: '/home/worker/elanous', introducedFiles: ['src/release-loop/foo.test.ts', 'scripts/release-loop/bar.test.ts'],
  }));
  expect(plan).toMatchObject({ command: 'ssh', mutatesState: false, approved: true });
  expect(plan.args).toEqual(['-o', 'BatchMode=yes', 'aws1', 'cd /home/worker/elanous && bun test -- src/release-loop/foo.test.ts scripts/release-loop/bar.test.ts']);
  expect(() => planHandResponseAction('rla-focused-verify', context('rla-focused-verify', {
    host: 'gcp2', remoteCommandRoot: '/home/worker/elanous', introducedFiles: ['src/foo.test.ts'],
  }))).toThrow('must use aws1');
  expect(() => planHandResponseAction('rla-focused-verify', context('rla-focused-verify', {
    host: 'aws1', remoteCommandRoot: '/home/worker/elanous', introducedFiles: ['src/foo.test.ts; touch /tmp/pwned'],
  }))).toThrow('safe test paths');
});

test('rail and Nexus actions are explicit-host, approval-gated, and use the prescribed launchd command', () => {
  const rail = planHandResponseAction('rla-rail-now', context('rla-rail-now', approved('rla-rail-now', { hosts: ['aws1', 'gcp2'] })), {
    ELANOUS_HQ_OP_TOOLS_DIR: '/hq/op-tools',
  });
  expect(rail).toMatchObject({ command: 'zsh', args: ['/hq/op-tools/rail-now.sh'], env: { RAIL_HOSTS: 'aws1 gcp2' }, approved: true });
  const nexus = planHandResponseAction('rla-nexus-restart', context('rla-nexus-restart', approved('rla-nexus-restart')),
    process.env, 'darwin', 501);
  expect(nexus).toMatchObject({ command: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.elanous.nexus'] });
  expect(() => planHandResponseAction('rla-nexus-restart', context('rla-nexus-restart'), process.env, 'linux', 1000)).toThrow('requires macOS');
  expect(() => planHandResponseAction('rla-nexus-build', context('rla-nexus-build', approved('rla-nexus-build')))).toThrow('only valid when static export inputs changed');
  expect(planHandResponseAction('rla-nexus-build', context('rla-nexus-build', approved('rla-nexus-build', { staticExportChanged: true }))).args)
    .toEqual(['nexus', 'build']);
});

test('simulation injects every command and never calls the real process runner', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const actions: Array<[string, Record<string, unknown>]> = [
    ['rla-release-autostart', approved('rla-release-autostart')],
    ['rla-train-worker-restart', approved('rla-train-worker-restart', { host: 'aws1', slot: '1', stopAt: '202611080700' })],
    ['rla-release-recover', approved('rla-release-recover', { runId: 'run-1', pickShas: ['0123456789abcdef0123456789abcdef01234567'] })],
    ['rla-rehearsal-retry', approved('rla-rehearsal-retry', { version: '0.3.7', step: 'hard-5h', reason: 'sim' })],
    ['rla-cloud-join', approved('rla-cloud-join', { host: 'aws1' })],
    ['rla-cloud-leave', approved('rla-cloud-leave', { host: 'aws1' })],
    ['rla-focused-verify', { host: 'aws1', remoteCommandRoot: '/tmp/checkout', introducedFiles: ['src/foo.test.ts'] }],
    ['rla-rail-now', approved('rla-rail-now', { hosts: ['aws1'] })],
    ['rla-nexus-restart', approved('rla-nexus-restart')],
    ['rla-nexus-build', approved('rla-nexus-build', { staticExportChanged: true })],
  ];
  const priorLog = console.log;
  const outputs: string[] = [];
  console.log = (line?: unknown) => outputs.push(String(line ?? ''));
  try {
    for (const [action, nodeInput] of actions) {
      const env = { ELANOUS_GRAPH_CONTEXT: JSON.stringify(context(action, nodeInput)), ELANOUS_HQ_OP_TOOLS_DIR: '/hq/op-tools', ELANOUS_STATE_DIR: '/tmp/state' };
      const code = await runHandResponseNode(action, env, {
        platform: 'darwin', uid: 501,
        archiveStamp: (source, destination) => expect(destination).toBe(`${source}.sim`),
        run: (command, args) => { calls.push({ command, args }); return { status: 0, stdout: '', stderr: '' }; },
      });
      expect(code).toBe(0);
    }
  } finally { console.log = priorLog; }
  expect(calls).toHaveLength(10);
  expect(outputs).toHaveLength(10);
  expect(outputs.every((line) => JSON.parse(line).outcome === 'ok')).toBe(true);
});

test('unapproved operations remain plan-only and malformed approval does not dispatch', async () => {
  let invoked = false;
  const action = 'rla-nexus-restart';
  const env = { ELANOUS_GRAPH_CONTEXT: JSON.stringify(context(action)) };
  const priorLog = console.log;
  console.log = () => {};
  try {
    expect(await runHandResponseNode(action, env, { platform: 'darwin', uid: 501, run: () => { invoked = true; return { status: 0, stdout: '', stderr: '' }; } })).toBe(0);
    expect(invoked).toBe(false);
  } finally { console.log = priorLog; }
  expect(() => planHandResponseAction(action, context('wrong-node', approved(action)), process.env, 'darwin', 501)).toThrow('graph node mismatch');
});
