import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTasksCommands, spawnDetachedConfirmed, type DetachedSpawn } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { handTask, launchArgs, readTaskAgentState, readTaskCard, TaskAgentStateError } from './task-hand.js';

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'task-hand-')), 'task-agent-actions.json');
}

async function cli(args: string[], deps: Parameters<typeof registerTasksCommands>[1]): Promise<{ lines: string[]; code: number | string | undefined }> {
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, { registerSink: async () => true, ...deps, output: (line) => lines.push(line) });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', ...args]);
    return { lines, code: process.exitCode };
  } finally { process.exitCode = previous ?? 0; }
}

test('shadow hand → 카드 1장 · 명령에 --merge-by-host · launcher 안 불림 · 기존 칸 보존', async () => {
  const path = statePath();
  writeFileSync(path, JSON.stringify({ landingDay: '2026-10-06', landingsToday: 2, failureCounts: { k: 1 } }));
  let launched = 0;
  const { lines, code } = await cli(['task', 'hand', 'fix the widget', '--seat', 'TC', '--checklist', 'CELL-1'], { taskStatePath: path, taskLauncher: () => { launched++; } });
  expect(code).toBeFalsy();
  expect(launched).toBe(0);
  expect(lines.join('\n')).toContain('--merge-by-host');
  expect(lines.join('\n')).toContain('--seat TC --substrate pod');
  const disk = JSON.parse(readFileSync(path, 'utf8'));
  expect(disk).toMatchObject({ landingDay: '2026-10-06', landingsToday: 2, failureCounts: { k: 1 } });
  const cards = Object.values(disk.tasks) as Array<Record<string, unknown>>;
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ text: 'fix the widget', seat: 'TC', checklistId: 'CELL-1', status: 'handed', history: [] });
  expect(String(cards[0]!.id)).toStartWith('ta-');
  expect(typeof cards[0]!.createdAt).toBe('string');
});

test('--live 는 주입한 launcher 를 한 번 부르고 카드를 launched 로', async () => {
  const path = statePath();
  const calls: string[][] = [];
  const { lines } = await cli(['task', 'hand', 'ship it', '--live', '--json'], { taskStatePath: path, taskLauncher: (args) => { calls.push(args); } });
  expect(calls).toEqual([['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'ship it']]);
  const out = JSON.parse(lines[0]!);
  expect(out).toMatchObject({ mode: 'live', launched: true });
  expect(readTaskCard(out.card.id, path)?.status).toBe('launched');
});

test('task show <ta-id> 는 카드와 다음 수를 보이고 넥서스를 부르지 않는다', async () => {
  const path = statePath();
  const { card } = await handTask({ text: 'write the report', seat: 'MK', statePath: path });
  let fetched = 0;
  const { lines, code } = await cli(['task', 'show', card.id], {
    taskStatePath: path,
    baseUrl: 'http://127.0.0.1:1',
    fetch: (async () => { fetched++; return Response.json({}); }) as unknown as typeof fetch,
  });
  expect(code).toBeFalsy();
  expect(fetched).toBe(0);
  expect(lines[0]).toContain(card.id);
  expect(lines[0]).toContain('write the report');
  expect(lines[1]).toContain('다음 수: launch');
  expect(lines[1]).toContain(launchArgs(card).slice(0, 4).join(' '));
  const missing = await cli(['task', 'show', 'ta-nope'], { taskStatePath: path });
  expect(missing.code).toBe(1);
});

test('빈 과제는 거부한다', async () => {
  await expect(handTask({ text: '  ', statePath: statePath() })).rejects.toThrow();
});

test('손상된 상태 파일 → task hand 는 실패하고 파일을 덮어쓰지 않는다 (ENOENT 만 빈 상태)', async () => {
  for (const corrupted of ['{"failureCounts": {"k": 3}, "tasks": {', '[1,2]', 'null']) {
    const path = statePath();
    writeFileSync(path, corrupted);
    let launched = 0;
    const { lines, code } = await cli(['task', 'hand', 'fix it', '--live'], { taskStatePath: path, taskLauncher: () => { launched++; } });
    expect(code).toBe(1);
    expect(launched).toBe(0);
    expect(lines.join('\n')).toContain('덮어쓰지 않고 멈춘다');
    expect(readFileSync(path, 'utf8')).toBe(corrupted);
    expect(() => readTaskAgentState(path)).toThrow(TaskAgentStateError);
    const show = await cli(['task', 'show', 'ta-x'], { taskStatePath: path });
    expect(show.code).toBe(1);
  }
  expect(readTaskAgentState(join(mkdtempSync(join(tmpdir(), 'task-hand-')), 'missing.json'))).toEqual({});
});

function fakeSpawn(behavior: 'spawn' | 'error' | 'silent', pid?: number): DetachedSpawn & { unrefs: number } {
  const fake = Object.assign(((_command: string, _args: string[]) => {
    const child = Object.assign(new EventEmitter(), { pid, unref: () => { fake.unrefs++; } });
    queueMicrotask(() => {
      if (behavior === 'spawn') child.emit('spawn');
      if (behavior === 'error') child.emit('error', Object.assign(new Error('spawn /nope ENOENT'), { code: 'ENOENT' }));
    });
    return child;
  }) as unknown as DetachedSpawn, { unrefs: 0 });
  return fake;
}

test('발사기: spawn 이벤트면 성공 · error 면 던진다 · 둘 다 없고 pid 없으면 시간 초과', async () => {
  const ok = fakeSpawn('spawn', 42);
  await spawnDetachedConfirmed(ok, 'node', ['x']);
  expect(ok.unrefs).toBe(1);
  await expect(spawnDetachedConfirmed(fakeSpawn('error'), 'node', ['x'])).rejects.toThrow('ENOENT');
  await expect(spawnDetachedConfirmed(fakeSpawn('silent'), 'node', ['x'], 20)).rejects.toThrow('시간 초과');
  await spawnDetachedConfirmed(fakeSpawn('silent', 7), 'node', ['x'], 20);
});

test('--live 발사 error → 카드 launch-failed(사유) · exit 1 · launched 아님', async () => {
  const path = statePath();
  const { lines, code } = await cli(['task', 'hand', 'ship it', '--live'], {
    taskStatePath: path,
    taskLauncher: (args) => spawnDetachedConfirmed(fakeSpawn('error'), 'node', args),
  });
  expect(code).toBe(1);
  expect(lines.join('\n')).toContain('launch-failed');
  const cards = Object.values(JSON.parse(readFileSync(path, 'utf8')).tasks) as Array<{ status: string; history: Array<{ event: string; detail?: string }> }>;
  expect(cards).toHaveLength(1);
  expect(cards[0]!.status).toBe('launch-failed');
  expect(cards[0]!.history[0]).toMatchObject({ event: 'launch-failed' });
  expect(cards[0]!.history[0]!.detail).toContain('ENOENT');
});

test('TASK-AGENT 관측 — hand·show 는 task-agent 싱크를 등록하고 그 싱크가 handed 를 받는다', async () => {
  const path = statePath();
  const surfaces: string[] = [];
  const events: Array<{ category: string; event: string; data?: unknown }> = [];
  const offs: Array<() => void> = [];
  // 실 logs.db 대신 같은 자리(debug.registerSink)에 붙는 포획 싱크를 주입한다.
  const registerSink = async (surface: string) => {
    surfaces.push(surface);
    offs.push(debug.registerSink({ name: 'task-agent-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } }));
    return true;
  };
  try {
    const { lines } = await cli(['task', 'hand', 'observe me', '--seat', 'OP', '--json'], { taskStatePath: path, registerSink });
    const id = JSON.parse(lines[0]!).card.id as string;
    expect(surfaces).toEqual(['task-agent']);
    expect(events.map((e) => e.event)).toEqual(['handed']);
    expect(events[0]!.data).toMatchObject({ taskId: id, seat: 'OP', mode: 'shadow' });
    await cli(['task', 'show', id], { taskStatePath: path, registerSink });
    expect(surfaces).toEqual(['task-agent', 'task-agent']);
  } finally { for (const off of offs) off(); }
});

test('TASK-AGENT 관측 — 싱크 등록이 실패해도 과제 넘기기는 돈다(fail-open)', async () => {
  const path = statePath();
  const { lines, code } = await cli(['task', 'hand', 'still works', '--json'], { taskStatePath: path, registerSink: async () => { throw new Error('sink down'); } });
  expect(code).toBeFalsy();
  expect(readTaskCard(JSON.parse(lines[0]!).card.id, path)?.status).toBe('handed');
});
