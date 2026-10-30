import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { LogStore } from '../mss/logging/log-store.js';
import { createMissionOutStore, createProcessAgentRunner, registerMissionOutCommand, renderMissionAgentInstructions } from './mission-out.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'mission-out-'));
  roots.push(root);
  return root;
};

test('mission reply appends ordered progress and final events under the instance state root', async () => {
  const root = makeRoot();
  const emitted: unknown[] = [];
  let tick = 0;
  const store = createMissionOutStore(root, {
    id: () => '12345678-1234-4234-8234-123456789abc',
    now: () => new Date(Date.UTC(2026, 9, 29, 0, 0, tick++)),
    emit: (event) => emitted.push(event),
  });
  const record = store.create({ agent: 'codex', prompt: 'do work', cwd: '/repo', outputPath: '/tmp/result.tmp', targetOutputPath: '/tmp/result.md' });
  const first = await store.reply(record.missionId, 'progress');
  const final = await store.reply(record.missionId, 'answer', true);
  expect([first.sequence, final.sequence]).toEqual([1, 2]);
  expect(store.replies(record.missionId)).toEqual([first, final]);
  expect(emitted).toEqual([first]);
  expect(store.read(record.missionId)).toMatchObject({ status: 'running', doneReceived: true, pendingFinalReply: 'answer' });
  expect(store.read(record.missionId)?.result).toBeUndefined();
  await expect(store.reply(record.missionId, 'second final', true)).rejects.toThrow('최종 답변이 이미 제출됐습니다');
  await expect(store.reply(record.missionId, 'progress after final')).rejects.toThrow('최종 답변이 이미 제출됐습니다');
  writeFileSync(record.outputPath, 'validated answer');
  expect(await store.complete(record.missionId)).toMatchObject({ status: 'completed', result: 'answer' });
  expect(emitted).toEqual([first, final]);
  await expect(store.reply(record.missionId, 'late')).rejects.toThrow('실행 중이 아닙니다');
  expect(store.replies(record.missionId).filter((event) => event.done)).toHaveLength(1);
});

test('cancel is terminal and reply fails closed afterward', async () => {
  const store = createMissionOutStore(makeRoot(), { id: () => '12345678-1234-4234-8234-123456789abc' });
  const record = store.create({ agent: 'claude', prompt: 'do work', cwd: '/repo', outputPath: '/tmp/result.tmp', targetOutputPath: '/tmp/result.md' });
  expect(await store.cancel(record.missionId)).toMatchObject({ record: { status: 'cancelled' }, transitioned: true });
  await expect(store.reply(record.missionId, 'too late')).rejects.toThrow('실행 중이 아닙니다');
});

test('cancel that wins the state lock prevents result publication', async () => {
  const root = makeRoot();
  const store = createMissionOutStore(root);
  const record = store.create({ agent: 'codex', prompt: 'do work', cwd: root, outputPath: join(root, 'result.tmp'), targetOutputPath: join(root, 'result.md') });
  writeFileSync(record.outputPath, 'private result');
  await store.cancel(record.missionId);
  expect(await store.complete(record.missionId)).toMatchObject({ status: 'cancelled' });
  expect(existsSync(record.targetOutputPath)).toBe(false);
  expect(existsSync(record.outputPath)).toBe(true);
});

test('completion that wins the state lock makes a later cancel a no-op', async () => {
  const root = makeRoot();
  const store = createMissionOutStore(root);
  const record = store.create({ agent: 'codex', prompt: 'do work', cwd: root, outputPath: join(root, 'result.tmp'), targetOutputPath: join(root, 'result.md') });
  writeFileSync(record.outputPath, 'public result');
  const [completed, cancelled] = await Promise.all([store.complete(record.missionId), store.cancel(record.missionId)]);
  expect(completed.status).toBe('completed');
  expect(cancelled).toMatchObject({ transitioned: false, record: { status: 'completed' } });
  expect(existsSync(record.targetOutputPath)).toBe(true);
  expect(existsSync(record.outputPath)).toBe(false);
});

test('separate completion and cancel processes publish exactly one terminal outcome', async () => {
  const root = makeRoot();
  const id = '12345678-1234-4234-8234-123456789abc';
  const store = createMissionOutStore(root, { id: () => id });
  const record = store.create({ agent: 'codex', prompt: 'do work', cwd: root, outputPath: join(root, 'race.tmp'), targetOutputPath: join(root, 'race.md') });
  writeFileSync(record.outputPath, 'race result');
  const barrier = join(root, 'start');
  const projectRoot = resolve(import.meta.dir, '../..');
  const childScript = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { createMissionOutStore } from './src/agent-mission/mission-out.js';",
    'const { MISSION_RACE_ACTION: action, MISSION_RACE_ROOT: root, MISSION_RACE_ID: id, MISSION_RACE_BARRIER: barrier, MISSION_RACE_READY: ready } = process.env;',
    "writeFileSync(ready, 'ready');",
    'while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 5));',
    'const store = createMissionOutStore(root);',
    "const result = action === 'complete' ? await store.complete(id) : await store.cancel(id);",
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const startChild = (action: 'complete' | 'cancel') => {
    const ready = join(root, `${action}.ready`);
    const child = spawn(process.execPath, ['-e', childScript], {
      cwd: projectRoot,
      env: { HOME: root, PATH: process.env.PATH ?? '', MISSION_RACE_ACTION: action, MISSION_RACE_ROOT: root, MISSION_RACE_ID: id, MISSION_RACE_BARRIER: barrier, MISSION_RACE_READY: ready },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveClose) => child.once('close', (code) => resolveClose({ code, stdout, stderr })));
    return { ready, closed };
  };
  const completion = startChild('complete');
  const cancellation = startChild('cancel');
  const readyDeadline = Date.now() + 8_000;
  while (Date.now() < readyDeadline && (!existsSync(completion.ready) || !existsSync(cancellation.ready))) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  expect(existsSync(completion.ready) && existsSync(cancellation.ready)).toBe(true);
  writeFileSync(barrier, 'go');
  const outcomes = await Promise.all([completion.closed, cancellation.closed]);
  expect(outcomes.map((outcome) => outcome.code)).toEqual([0, 0]);
  const final = store.read(id)!;
  expect(['completed', 'cancelled']).toContain(final.status);
  expect(existsSync(record.targetOutputPath)).toBe(final.status === 'completed');
  expect(existsSync(record.outputPath)).toBe(final.status === 'cancelled');
});

test('mission reply fails closed on a stale lock and reports its stale state', async () => {
  const root = makeRoot();
  const id = '12345678-1234-4234-8234-123456789abc';
  const store = createMissionOutStore(root, { id: () => id });
  store.create({ agent: 'codex', prompt: 'do work', cwd: '/repo', outputPath: '/tmp/result.tmp', targetOutputPath: '/tmp/result.md' });
  const lockPath = join(root, 'agent-missions', `${id}.replies.jsonl.lock`);
  writeFileSync(lockPath, '2147483647\n');
  const stale = new Date(0);
  utimesSync(lockPath, stale, stale);
  await expect(store.reply(id, 'must not write')).rejects.toThrow('자동 회수하지 않았습니다');
  expect(store.lockStale(id)).toBe(true);
  expect(readFileSync(lockPath, 'utf8')).toBe('2147483647\n');
  expect(store.replies(id)).toEqual([]);
});

test('concurrent mission replies serialize sequence and append order', async () => {
  const root = makeRoot();
  const id = '12345678-1234-4234-8234-123456789abc';
  const store = createMissionOutStore(root, { id: () => id });
  store.create({ agent: 'codex', prompt: 'do work', cwd: '/repo', outputPath: '/tmp/result.tmp', targetOutputPath: '/tmp/result.md' });
  const events = await Promise.all(Array.from({ length: 8 }, (_, index) => store.reply(id, `progress-${index}`)));
  expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(store.replies(id).map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test('agent discovery instructions identify progress and final push commands', () => {
  const missionId = '12345678-1234-4234-8234-123456789abc';
  const storeRoot = '/tmp/isolated mission store';
  const instructions = renderMissionAgentInstructions(missionId, storeRoot);
  expect(instructions).toContain(`eln --config-dir '${storeRoot}' mission reply --mission ${missionId} "<message>"`);
  expect(instructions).toContain(`eln --config-dir '${storeRoot}' mission reply --mission ${missionId} --done "<final answer>"`);
  expect(instructions).toContain(`eln --config-dir '${storeRoot}' mission status ${missionId} --json`);
});

test('mission reply accepts explicit mission ID without inherited context in test and prod roots', async () => {
  const originalContext = process.env.ELANOUS_MISSION_CONTEXT;
  const originalStateDir = process.env.ELANOUS_STATE_DIR;
  delete process.env.ELANOUS_MISSION_CONTEXT;
  delete process.env.ELANOUS_STATE_DIR;
  const roots = [
    { universe: 'test', root: makeRoot() },
    { universe: 'prod', root: join(makeRoot(), 'home', '.elanous') },
  ];
  try {
    for (const [index, { root }] of roots.entries()) {
      const id = `12345678-1234-4234-8234-123456789ab${index}`;
      const store = createMissionOutStore(root, { id: () => id });
      store.create({ agent: 'codex', prompt: 'do work', cwd: '/repo', outputPath: join(root, 'result.tmp'), targetOutputPath: join(root, 'result.md') });
      const output: string[] = [];
      const cli = new Command();
      cli.exitOverride();
      cli.option('--config-dir <dir>');
      registerMissionOutCommand(cli, { stateRoot: () => root, write: (line) => output.push(line), error: (line) => output.push(line) });
      await cli.parseAsync(['node', 'eln', '--config-dir', root, 'mission', 'reply', '--mission', id, 'child reply']);
      expect(JSON.parse(output[0]!)).toMatchObject({ missionId: id, accepted: true, sequence: 1, done: false });
      expect(store.replies(id)).toMatchObject([{ missionId: id, text: 'child reply', done: false }]);
    }
  } finally {
    if (originalContext === undefined) delete process.env.ELANOUS_MISSION_CONTEXT;
    else process.env.ELANOUS_MISSION_CONTEXT = originalContext;
    if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = originalStateDir;
  }
});

test('reply message format reserves ask, answer, and correct without rejecting extension kinds', async () => {
  const store = createMissionOutStore(makeRoot(), { id: () => '12345678-1234-4234-8234-123456789abc' });
  const record = store.create({ agent: 'codex', prompt: 'do work', cwd: '/repo', outputPath: '/tmp/result.tmp', targetOutputPath: '/tmp/result.md' });
  const ask = await store.reply(record.missionId, 'Which base?', false, { kind: 'ask', defaults: 'main', deadline: '2026-10-30T00:00:00Z' });
  const answer = await store.reply(record.missionId, 'Use main.', false, { kind: 'answer' });
  await expect(store.reply(record.missionId, 'Change scope.', false, { kind: 'correct', scope: 'src/agent-mission' })).rejects.toThrow('scope, stop, priority 가 필요');
  const correction = await store.reply(record.missionId, 'Stop and narrow to the CLI.', false, { kind: 'correct', scope: 'src/agent-mission', stop: true, priority: 'P0' });
  const extension = await store.reply(record.missionId, 'Future extension.', false, { kind: 'future-kind' });
  expect(ask).toMatchObject({ kind: 'ask', defaults: 'main', deadline: '2026-10-30T00:00:00Z' });
  expect(answer.kind).toBe('answer');
  expect(correction).toMatchObject({ kind: 'correct', scope: 'src/agent-mission', stop: true, priority: 'P0' });
  expect(extension.kind).toBe('future-kind');
});

test('stateless CLI accepts two agent replies and status returns both pushed events', async () => {
  const root = makeRoot();
  const id = '12345678-1234-4234-8234-123456789abc';
  const store = createMissionOutStore(root, { id: () => id });
  store.create({ agent: 'codex', prompt: 'do work', cwd: '/repo', outputPath: '/tmp/result.tmp', targetOutputPath: '/tmp/result.md' });
  const output: string[] = [];
  const cli = new Command();
  cli.exitOverride();
  registerMissionOutCommand(cli, { stateRoot: () => root, write: (line) => output.push(line), error: (line) => output.push(line) });
  await cli.parseAsync(['node', 'eln', 'mission', 'reply', id, 'halfway']);
  await cli.parseAsync(['node', 'eln', 'mission', 'reply', id, '--done', 'finished']);
  writeFileSync(store.read(id)!.outputPath, 'validated output');
  await store.complete(id);
  await cli.parseAsync(['node', 'eln', 'mission', 'status', id, '--json']);
  const status = JSON.parse(output.at(-1)!);
  expect(status).toMatchObject({ id, missionId: id, status: 'done', body: 'finished', artifacts: [store.read(id)!.targetOutputPath], result: 'finished' });
  expect(status.replies.map((event: { sequence: number; text: string; done: boolean }) => [event.sequence, event.text, event.done]))
    .toEqual([[1, 'halfway', false], [2, 'finished', true]]);
});

test('mission reply uses the matching mission context store before the CLI default root', async () => {
  const defaultRoot = makeRoot();
  const missionRoot = makeRoot();
  const id = '12345678-1234-4234-8234-123456789abc';
  const unrelatedId = '22345678-1234-4234-8234-123456789abc';
  const missionStore = createMissionOutStore(missionRoot, { id: () => id });
  const defaultStore = createMissionOutStore(defaultRoot, { id: () => unrelatedId });
  missionStore.create({ agent: 'codex', prompt: 'do work', cwd: '/repo', outputPath: '/tmp/result.tmp', targetOutputPath: '/tmp/result.md' });
  defaultStore.create({ agent: 'codex', prompt: 'other work', cwd: '/repo', outputPath: '/tmp/other.tmp', targetOutputPath: '/tmp/other.md' });
  const originalContext = process.env.ELANOUS_MISSION_CONTEXT;
  process.env.ELANOUS_MISSION_CONTEXT = JSON.stringify({ missionId: id, storeRoot: missionRoot });
  const output: string[] = [];
  const cli = new Command();
  cli.exitOverride();
  registerMissionOutCommand(cli, { stateRoot: () => defaultRoot, emit: () => {}, write: (line) => output.push(line), error: (line) => output.push(line) });
  try {
    await cli.parseAsync(['node', 'eln', 'mission', 'reply', id, '--done', 'reply in mission universe']);
    expect(JSON.parse(output[0]!)).toMatchObject({ missionId: id, accepted: true, sequence: 1, done: true });
    expect(missionStore.replies(id)).toMatchObject([{ missionId: id, text: 'reply in mission universe', done: true }]);
    expect(missionStore.read(id)).toMatchObject({ status: 'running', doneReceived: true });
    expect(defaultStore.read(id)).toBeNull();
    await cli.parseAsync(['node', 'eln', 'mission', 'reply', unrelatedId, '--done', 'reply in default universe']);
    expect(JSON.parse(output[1]!)).toMatchObject({ missionId: unrelatedId, accepted: true, done: true });
    expect(defaultStore.read(unrelatedId)).toMatchObject({ status: 'running', doneReceived: true });
  } finally {
    if (originalContext === undefined) delete process.env.ELANOUS_MISSION_CONTEXT;
    else process.env.ELANOUS_MISSION_CONTEXT = originalContext;
  }
});

test('run usage is available before required run options are provided', async () => {
  const output: string[] = [];
  const cli = new Command();
  cli.exitOverride();
  registerMissionOutCommand(cli, { stateRoot: makeRoot, write: (line) => output.push(line) });
  await cli.parseAsync(['node', 'eln', 'mission', 'run', '--usage']);
  expect(JSON.parse(output[0])).toMatchObject({ args: [], flags: expect.arrayContaining(['--agent codex|claude', '--out <path>']) });
});

test('process runner captures spawn errors while the pid state write is pending', async () => {
  const root = makeRoot();
  const store = createMissionOutStore(root);
  const record = store.create({ agent: 'codex', prompt: 'do work', cwd: root, outputPath: join(root, 'result.tmp'), targetOutputPath: join(root, 'result.md') });
  const fakeSpawn = (() => {
    const child = Object.assign(new EventEmitter(), { pid: 1234, stderr: new PassThrough(), stdin: { end: () => undefined } });
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    return child;
  }) as typeof spawn;
  await expect(createProcessAgentRunner(root, fakeSpawn)(record, 'prompt')).rejects.toThrow('spawn ENOENT');
});

test('agent subprocess receives a paired mission ID and store root', async () => {
  const root = makeRoot();
  const store = createMissionOutStore(root, { id: () => '12345678-1234-4234-8234-123456789abc' });
  const record = store.create({ agent: 'codex', prompt: 'do work', cwd: root, outputPath: join(root, 'result.tmp'), targetOutputPath: join(root, 'result.md') });
  let childEnv: NodeJS.ProcessEnv | undefined;
  const fakeSpawn = ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    childEnv = options.env;
    const child = Object.assign(new EventEmitter(), { pid: 1234, stderr: new PassThrough(), stdin: { end: () => undefined } });
    queueMicrotask(() => child.emit('close', 0));
    return child;
  }) as typeof spawn;
  await expect(createProcessAgentRunner(root, fakeSpawn)(record, 'prompt')).resolves.toEqual({ code: 0, stderr: '' });
  expect(childEnv?.ELANOUS_STATE_DIR).toBe(root);
  expect(childEnv?.ELANOUS_STATE_DIR_SOURCE).toBeTruthy();
  expect(JSON.parse(childEnv?.ELANOUS_MISSION_CONTEXT ?? '{}')).toEqual({ missionId: record.missionId, storeRoot: root });
});

test('real run CLI exposes progress/final and fails closed when the agent omits its output file', async () => {
  const root = makeRoot();
  const fakeBin = join(root, 'bin');
  const fakeCodex = join(fakeBin, 'codex');
  const fakeEln = join(fakeBin, 'eln');
  const cliEntry = resolve(import.meta.dir, '../../bin/elanous.mjs');
  mkdirSync(fakeBin, { recursive: true });
  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const runProcess = (args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
  const readStatus = async (missionId: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> => {
    const result = await runProcess(['mission', 'status', missionId, '--json'], env);
    if (result.code !== 0) throw new Error(result.stderr || `status exited ${String(result.code)}`);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const waitForStatus = async (missionId: string, env: NodeJS.ProcessEnv, terminal: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const value = await readStatus(missionId, env);
      if (value.status === terminal) return value;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error(`미션이 ${terminal} 상태가 되지 않았습니다`);
  };
  const waitForProgress = async (missionId: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const value = await readStatus(missionId, env);
      if ((value.replies as Array<{ text: string }>).some((event) => event.text === 'working')) return value;
      if (value.status !== 'running') throw new Error(`progress 전에 미션 종료: ${JSON.stringify(value)}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw new Error('미션 진행 답변이 관측되지 않았습니다');
  };
  const target = join(root, 'result.md');
  const fakeCodexScript = [
    '#!/bin/sh',
    'output=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output-last-message" ]; then shift; output="$1"; fi',
    '  shift',
    'done',
    'prompt=$(cat)',
    'mission_id=$(printf "%s\\n" "$prompt" | sed -n \'s/.*mission reply --mission \\([0-9a-f-][0-9a-f-]*\\).*/\\1/p\' | head -1)',
    'store_root=$(printf "%s\\n" "$prompt" | sed -n "s/.*eln --config-dir \'\\(.*\\)\' mission reply --mission.*/\\1/p" | head -1)',
    'env -u ELANOUS_STATE_DIR -u ELANOUS_MISSION_CONTEXT -u ELANOUS_STATE_DIR_SOURCE eln --config-dir "$store_root" mission reply --mission "$mission_id" "working"',
    'sleep 3',
    'case "$prompt" in *missing-output*) env -u ELANOUS_STATE_DIR -u ELANOUS_MISSION_CONTEXT -u ELANOUS_STATE_DIR_SOURCE eln --config-dir "$store_root" mission reply --mission "$mission_id" --done "hidden final"; exit 0;; esac',
    'env -u ELANOUS_STATE_DIR -u ELANOUS_MISSION_CONTEXT -u ELANOUS_STATE_DIR_SOURCE eln --config-dir "$store_root" mission reply --mission "$mission_id" --done "final answer"',
    'printf %s "validated output" > "$output"',
  ].join('\n');
  writeFileSync(fakeCodex, fakeCodexScript, { mode: 0o755 });
  chmodSync(fakeCodex, 0o755);
  writeFileSync(fakeEln, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliEntry)} "$@"\n`, { mode: 0o755 });
  chmodSync(fakeEln, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, 'home'),
    ELANOUS_CONFIG_DIR: join(root, 'config'),
    ELANOUS_STATE_DIR: root,
    NODE_ENV: 'production',
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    ELANOUS_FAST_ROUTER: '0',
  };

  const launched = await runProcess(['mission', 'run', '--agent', 'codex', '--prompt', 'normal', '--out', target, '--json'], env);
  expect(launched.code).toBe(0);
  const missionId = (JSON.parse(launched.stdout) as { missionId: string }).missionId;
  const running = await readStatus(missionId, env);
  expect(running.status).toBe('running');
  const withProgress = await waitForProgress(missionId, env);
  expect(withProgress.status).toBe('running');
  const completed = await waitForStatus(missionId, env, 'done');
  expect(completed).toMatchObject({ id: missionId, missionId, status: 'done', body: 'final answer', artifacts: [target], result: 'final answer' });
  expect((completed.replies as Array<{ text: string; done: boolean }>).map((event) => [event.text, event.done]))
    .toEqual([['working', false], ['final answer', true]]);
  const logs = LogStore.openReadOnly(join(root, 'logs', 'logs.db'));
  try {
    const finalRows = logs.query({ exactCategories: ['agent-mission'], events: ['reply'], limit: 100 })
      .map((row) => JSON.parse(row.data ?? 'null') as { missionId?: string; done?: boolean; text?: string });
    expect(finalRows).toContainEqual(expect.objectContaining({ missionId, done: true, text: 'final answer' }));
  } finally { logs.close(); }

  const missing = await runProcess(['mission', 'run', '--agent', 'codex', '--prompt', 'missing-output', '--out', join(root, 'missing.md'), '--json'], env);
  expect(missing.code).toBe(0);
  const missingId = (JSON.parse(missing.stdout) as { missionId: string }).missionId;
  const missingRunning = await readStatus(missingId, env);
  expect(missingRunning.status).toBe('running');
  expect((missingRunning.replies as Array<{ done: boolean }>).some((event) => event.done)).toBe(false);
  const failed = await waitForStatus(missingId, env, 'failed');
  expect(failed).not.toHaveProperty('result');
  expect((failed.replies as Array<{ done: boolean }>).some((event) => event.done)).toBe(false);

}, 30_000);
