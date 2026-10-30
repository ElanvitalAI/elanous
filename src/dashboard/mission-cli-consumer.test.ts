import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMissionOutStore } from '../agent-mission/mission-out.js';
import { cancelClassicMissionCli, startClassicMissionCli } from './mission-cli-consumer.js';
import { TaskNotificationQueue } from '../agent/task-notification.js';
import { enqueueClassicSidetabMissionCompletion } from './classic-sidetab-mission-job.js';
import { createAgentWake, formatAgentWakePrompt } from './input/agent-wake.js';

const MISSION_ID = '123e4567-e89b-42d3-a456-426614174000';

test('installed eln mission run/status JSON contracts used by the sidetab consumer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'classic-mission-cli-contract-'));
  try {
    const fakeBin = join(root, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    chmodSync(join(fakeBin, 'codex'), 0o755);
    const env = {
      ...process.env,
      HOME: join(root, 'home'),
      ELANOUS_CONFIG_DIR: join(root, 'config'),
      ELANOUS_STATE_DIR: root,
      ELANOUS_FAST_ROUTER: '0',
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    };
    const run = spawnSync('eln', ['mission', 'run', '--agent', 'codex', '--prompt', 'contract probe', '--out', join(root, 'run.md'), '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 20_000,
    });
    expect(run.status).toBe(0);
    const launched = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(launched).toMatchObject({ status: 'running', artifacts: [] });
    expect(launched.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(launched.missionId).toBe(launched.id);
    const runId = String(launched.missionId);
    spawnSync('eln', ['mission', 'cancel', runId, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });

    // #33200's real installed `mission status --json` output is the consumer's
    // done contract; seed a completed record, then read it through that CLI.
    const store = createMissionOutStore(root, { id: () => MISSION_ID });
    const record = store.create({ agent: 'codex', prompt: 'done contract', cwd: root,
      outputPath: join(root, 'done.tmp'), targetOutputPath: join(root, 'done.md') });
    writeFileSync(record.outputPath, 'validated answer');
    await store.complete(MISSION_ID);
    const status = spawnSync('eln', ['mission', 'status', MISSION_ID, '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 10_000,
    });
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      id: MISSION_ID, missionId: MISSION_ID, status: 'done',
      body: 'validated answer', result: 'validated answer', artifacts: [record.targetOutputPath],
    });

    // Exercise the consumer's default runCli too: its actual spawn target is
    // `eln`, and the installed run response must be accepted as running.
    const previous = {
      HOME: process.env.HOME,
      ELANOUS_CONFIG_DIR: process.env.ELANOUS_CONFIG_DIR,
      ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR,
      ELANOUS_FAST_ROUTER: process.env.ELANOUS_FAST_ROUTER,
      PATH: process.env.PATH,
    };
    process.env.HOME = env.HOME;
    process.env.ELANOUS_CONFIG_DIR = env.ELANOUS_CONFIG_DIR;
    process.env.ELANOUS_STATE_DIR = env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_FAST_ROUTER = env.ELANOUS_FAST_ROUTER;
    process.env.PATH = env.PATH;
    try {
      const started = await startClassicMissionCli({ agent: 'codex', prompt: 'consumer uses installed eln' });
      expect(started).toMatchObject({ ok: true, status: 'running', interactionId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
      if ('completion' in started) {
        await expect(started.completion).resolves.toMatchObject({ ok: false, status: 'failed', interactionId: started.interactionId });
      }
    } finally {
      for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
        const value = previous[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);

test('classic sidetab consumes the final mission result for the same mission id', async () => {
  const seen: string[] = [];
  let outputPath = '';
  let statusRead = 0;
  const started = await startClassicMissionCli({
    agent: 'codex',
    prompt: 'Write a tiny status utility.',
    onInteractionId: id => seen.push(id),
  }, {
    now: () => 1,
    delay: async () => {},
    runCli: async args => {
      if (args[0] === 'mission' && args[1] === 'run') {
        outputPath = args[args.indexOf('--out') + 1]!;
        return { code: 0, stdout: JSON.stringify({ missionId: MISSION_ID, status: 'running' }), stderr: '' };
      }
      if (args[0] === 'mission' && args[1] === 'status') {
        statusRead += 1;
        if (statusRead === 1) {
          return {
            code: 0,
            stdout: JSON.stringify({ missionId: MISSION_ID, status: 'running' }),
            stderr: '',
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            missionId: MISSION_ID,
            status: 'done',
              result: `The utility is complete. ${outputPath}`,
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected mock Codex CLI call: ${args.join(' ')}`);
    },
  });
  if (!('completion' in started)) throw new Error('mission did not start independently');
  const result = await started.completion;

  expect(seen).toEqual([MISSION_ID]);
  expect(result).toMatchObject({
    ok: true,
    status: 'completed',
    interactionId: MISSION_ID,
    content: `The utility is complete. ${outputPath}`,
  });
  expect(result.path).toBe(outputPath);
});

test('explicit mission cancellation reaches the parent once through the job completion notification', async () => {
  const queue = new TaskNotificationQueue();
  let cancelled = false;
  const runCli = async (args: string[]) => {
    if (args[1] === 'run') return { code: 0, stdout: JSON.stringify({ missionId: MISSION_ID, status: 'running' }), stderr: '' };
    if (args[1] === 'status') return {
      code: 0,
      stdout: JSON.stringify({ missionId: MISSION_ID, status: cancelled ? 'cancelled' : 'running' }),
      stderr: '',
    };
    if (args[1] === 'cancel') {
      cancelled = true;
      return { code: 0, stdout: JSON.stringify({ missionId: MISSION_ID, status: 'cancelled', cancelled: true }), stderr: '' };
    }
    throw new Error(`unexpected mock CLI call: ${args.join(' ')}`);
  };
  const started = await startClassicMissionCli({ agent: 'codex', prompt: 'Run until explicitly cancelled.' }, { runCli, delay: async () => new Promise(resolve => setTimeout(resolve, 1)) });
  if (!('completion' in started)) throw new Error('mission did not start independently');
  enqueueClassicSidetabMissionCompletion(started, 'codex', notification => queue.enqueue(notification));
  expect(await cancelClassicMissionCli(MISSION_ID, runCli)).toBe(true);
  const result = await started.completion;
  expect(result).toMatchObject({ ok: false, status: 'cancelled', interactionId: MISSION_ID });
  expect(queue.drain()).toMatchObject([{ taskId: MISSION_ID, state: 'aborted' }]);
  expect(queue.drain()).toEqual([]);
});

test('completion enqueue failure is attempted once and cannot trigger a duplicate fallback enqueue', async () => {
  let enqueueCalls = 0;
  const job = {
    ok: true as const,
    status: 'running' as const,
    interactionId: MISSION_ID,
    path: '/private/result.md',
    startedAt: 1,
    completion: Promise.resolve({ ok: true, status: 'completed' as const, interactionId: MISSION_ID, path: '/private/result.md', content: 'Done.' }),
  };
  enqueueClassicSidetabMissionCompletion(job, 'codex', () => {
    enqueueCalls += 1;
    throw new Error('queue unavailable');
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(enqueueCalls).toBe(1);
});

test('failed mission details redact the internal result path before parent notification', async () => {
  const path = '/private/mission/result.md';
  const notifications: Array<{ output: string }> = [];
  const job = {
    ok: true as const,
    status: 'running' as const,
    interactionId: MISSION_ID,
    path,
    startedAt: 1,
    completion: Promise.resolve({ ok: false, status: 'failed' as const, interactionId: MISSION_ID, path, error: `Unable to read ${path}` }),
  };
  enqueueClassicSidetabMissionCompletion(job, 'codex', notification => notifications.push(notification), () => 2);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(JSON.parse(notifications[0]!.output)).toEqual({
    status: 'error', body: 'Unable to read [internal result]', artifacts: [], id: MISSION_ID,
  });
});

test('parent continues after sidetab starts; late completion arrives once as a judgment event', async () => {
  const queue = new TaskNotificationQueue();
  let releaseFirstStatus!: () => void;
  let signalFirstStatus!: () => void;
  const firstStatusStarted = new Promise<void>(resolve => { signalFirstStatus = resolve; });
  const firstStatusGate = new Promise<void>(resolve => { releaseFirstStatus = resolve; });
  const parentTurns = ['tool dispatch returned running'];
  const openedInputs: string[] = [];
  let statusRead = 0;
  const started = await startClassicMissionCli({ agent: 'codex', prompt: 'Fix the issue.' }, {
    now: () => 100,
    delay: async () => {},
    runCli: async args => {
      if (args[1] === 'run') return { code: 0, stdout: JSON.stringify({ missionId: MISSION_ID, status: 'running' }), stderr: '' };
      if (args[1] === 'status') {
        statusRead += 1;
        if (statusRead === 1) {
          signalFirstStatus();
          await firstStatusGate;
          return { code: 0, stdout: JSON.stringify({ missionId: MISSION_ID, status: 'running' }), stderr: '' };
        }
        return {
          code: 0,
          stdout: JSON.stringify({ missionId: MISSION_ID, status: 'completed', result: 'Patch ready.' }),
          stderr: '',
        };
      }
      throw new Error(`unexpected mock CLI call: ${args.join(' ')}`);
    },
  });

  expect(started).toMatchObject({ ok: true, status: 'running', interactionId: MISSION_ID });
  if (!('completion' in started)) throw new Error('mission did not start independently');
  await firstStatusStarted;
  parentTurns.push('original conversation takes another turn');
  expect(parentTurns).toHaveLength(2);
  expect(queue.size).toBe(0);

  const wake = createAgentWake({
    subscribe: listener => queue.onEnqueue(listener),
    notify: () => {},
    openTurn: {
      startTurnIfIdle: input => { openedInputs.push(input); return { opened: true, turnId: 'reflection-1' }; },
      getCwd: () => '/Users/user/elanous-hq/seats/OPC',
      isPending: taskId => queue.has(taskId),
      detectSeat: () => ({ seat: 'OPC', source: 'cwd' }),
    },
  });
  enqueueClassicSidetabMissionCompletion(started, 'codex', notification => queue.enqueue(notification), () => 200);
  releaseFirstStatus();
  await started.completion;

  const notification = queue.drain();
  expect(notification).toHaveLength(1);
  expect(notification[0]).toMatchObject({ taskId: MISSION_ID, agentName: 'Codex', label: 'sidetab mission', state: 'done' });
  expect(JSON.parse(notification[0]!.output)).toEqual({ status: 'done', body: 'Patch ready.', artifacts: [], id: MISSION_ID });
  const expectedPrompt = formatAgentWakePrompt(notification[0]!);
  expect(openedInputs).toEqual([expectedPrompt]);
  expect(expectedPrompt).toContain('원래 요청과 대조해 수용·부분 수용·기각');
  expect(expectedPrompt).not.toMatch(/\[자동 재개\] 위임 끝:/u);
  parentTurns.push('parent judged the late result exactly once');
  expect(parentTurns).toHaveLength(3);
  wake.dispose();
  queue.clear();
});
