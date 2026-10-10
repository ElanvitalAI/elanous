import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { registerTasksCommands, spawnDetachedConfirmed, type DetachedSpawn } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { draftTaskOwner, handTask, launchArgs, parseChildLlm, resolveHandText, readTaskAgentState, readTaskCard, TASK_CARD_LABEL, taskCardLabelContext, TaskAgentStateError, type TaskCard, type TaskLaunchContext } from './task-hand.js';

test('only a unique launched code-PR card owns the PR or its opening run', () => {
  const base: TaskCard = { id: 'ta-one', text: 'draft', createdAt: '2026-10-10T00:00:00Z',
    status: 'launched', history: [], seat: 'UX', runId: 'parent', runChildId: 'child', pr: { number: 19 } };
  expect(draftTaskOwner([base], { number: 19 })).toBe(base);
  expect(draftTaskOwner([base], { number: 20, runId: 'child' })).toBe(base);
  expect(draftTaskOwner([base], { number: 20, runId: 'parent' })).toBe(base);
  expect(draftTaskOwner([{ ...base, runId: undefined }], { number: 19 })?.seat).toBe('UX');
  expect(draftTaskOwner([base, { ...base, id: 'ta-two' }], { number: 19 })).toBeUndefined();
  expect(draftTaskOwner([{ ...base, status: 'failed' }], { number: 19 })).toBeUndefined();
  expect(draftTaskOwner([{ ...base, completion: 'research-report' }], { number: 19 })).toBeUndefined();
  expect(draftTaskOwner([{ ...base, seat: undefined }], { number: 19 })).toBeUndefined();
});

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

test('resolveHandText classifies paths with injected IO, trims only for metadata and rejects invalid files', () => {
  const cwd = '/some/working/directory';
  const carried = '대상 경로: a\n현재 계약: b';
  const seen: string[] = [];
  const deps = {
    cwd,
    stat: (path: string) => {
      seen.push(path);
      if (path.endsWith('/folder')) return { isFile: () => false, isDirectory: () => true };
      if (path.endsWith('/other.bin') || path.endsWith('/GOAL.MARKDOWN') || path.endsWith('/empty.txt') || path.endsWith('/unreadable.md') || path.endsWith('/vanished.md') || path.endsWith('/moved.md')) return { isFile: () => true, isDirectory: () => false };
      if (path.includes('/other.bin/')) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      if (path.endsWith('/locked.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    readFile: (path: string, encoding: 'utf8') => {
      expect(encoding).toBe('utf8');
      if (path.endsWith('/unreadable.md')) throw new Error('EACCES');
      if (path.endsWith('/vanished.md')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (path.endsWith('/moved.md')) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      return path.endsWith('/empty.txt') ? ' \n  ' : `${carried}\n`;
    },
  };
  const inlined = resolveHandText('GOAL.MARKDOWN', deps);
  expect(inlined).toEqual({ kind: 'inlined', path: resolve(cwd, 'GOAL.MARKDOWN'), text: `${carried}\n`, chars: carried.length, sha256: createHash('sha256').update(carried).digest('hex') });
  expect(resolveHandText('other.bin', deps)).toMatchObject({ kind: 'inlined', path: resolve(cwd, 'other.bin') });
  expect(resolveHandText('missing.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'missing.md'), reason: '없다' });
  expect(resolveHandText('other.bin/goal.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'other.bin/goal.md'), reason: '없다' });
  expect(resolveHandText('vanished.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'vanished.md'), reason: '없다' });
  expect(resolveHandText('moved.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'moved.md'), reason: '없다' });
  expect(resolveHandText('locked.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'locked.md'), reason: '읽기 실패' });
  expect(resolveHandText('folder', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'folder'), reason: '디렉터리' });
  expect(resolveHandText('unreadable.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'unreadable.md'), reason: '읽기 실패' });
  expect(resolveHandText('empty.txt', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'empty.txt'), reason: '비었다' });
  expect(resolveHandText('fix-login', deps)).toEqual({ kind: 'unchanged', text: 'fix-login' });
  expect(resolveHandText('보고서 정리해 줘', deps)).toEqual({ kind: 'unchanged', text: '보고서 정리해 줘' });
  expect(resolveHandText('first\nsecond.md', deps)).toEqual({ kind: 'unchanged', text: 'first\nsecond.md' });
  expect(seen).not.toContain(resolve(cwd, 'first\nsecond.md'));
});

test('Pod 카드 라벨 맥락은 원장 id 그대로이며 카드·원장·발사 명령은 변경하지 않는다', async () => {
  const path = statePath();
  const { card, move } = await handTask({ id: 'ta-20261009-abc123', text: 'ship it', statePath: path });
  const before = readFileSync(path, 'utf8');
  const snapshot = structuredClone(card);
  expect(TASK_CARD_LABEL).toBe('elanous.task-card');
  expect(taskCardLabelContext(card)).toEqual({ cardId: card.id, labels: { 'elanous.task-card': card.id } });
  expect(card).toEqual(snapshot);
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(JSON.parse(before).tasks[card.id]).toEqual(snapshot);
  expect(move.command).toEqual(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'ship it']);
});

test('live handTask 는 카드 라벨 맥락을 기존 launcher 호출에 싣고 명령·cwd·런 연결을 보존한다', async () => {
  const path = statePath();
  const target = mkdtempSync(join(tmpdir(), 'task-hand-label-target-'));
  const calls: Array<{ args: string[]; cwd?: string; context?: TaskLaunchContext }> = [];
  const result = await handTask({
    id: 'ta-20261009-label01', text: '  write report  ', completion: 'research-report',
    project: { id: 'p1', target }, seat: 'TC', live: true, statePath: path,
    launcher: (args, cwd, context) => { calls.push({ args, cwd, context }); return { runId: context!.runId }; },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual(['harness', 'say', '--seat', 'TC', '--substrate', 'pod', '--merge-by-host', 'write report']);
  expect(calls[0]!.cwd).toBe(target);
  expect(calls[0]!.context).toMatchObject({
    cardLabelContext: { cardId: result.card.id, labels: { [TASK_CARD_LABEL]: result.card.id } },
    env: { ELANOUS_RUN_ID: calls[0]!.context!.runId },
  });
  expect(calls[0]!.context!.launchId).toStartWith('tl-');
  expect(result).toMatchObject({ mode: 'live', launched: true, cwd: target, move: { kind: 'launch', command: calls[0]!.args }, card: { status: 'launched', runId: calls[0]!.context!.runId, launchId: calls[0]!.context!.launchId } });
  expect(readTaskCard(result.card.id, path)).toEqual(result.card);
  expect(Object.hasOwn(result.card, 'cardLabelContext')).toBe(false);
});

test('Pod 카드 라벨 맥락은 유효하지 않은 id 를 변형·충돌시키지 않고 거부한다', () => {
  for (const id of ['other-1', 'ta-a b', 'ta-a/b', 'ta-a.', `ta-${'x'.repeat(61)}`]) {
    expect(() => taskCardLabelContext({ id })).toThrow('Pod 라벨에 쓸 수 없는 과제 카드 id');
  }
  expect(taskCardLabelContext({ id: `ta-${'x'.repeat(60)}` }).labels[TASK_CARD_LABEL]).toHaveLength(63);
});

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
  expect(Object.hasOwn(out, 'cwd')).toBe(false);
  expect(Object.hasOwn(out.card, 'project')).toBe(false);
  expect(Object.hasOwn(out.card, 'completion')).toBe(false);
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

test('비git 프로젝트 보고서 대상은 절대 경로로 저장하고 live launcher 에 cwd 를 전달한다', async () => {
  const target = mkdtempSync(join(tmpdir(), 'task-hand-project-'));
  const path = statePath();
  const args = ['task', 'hand', '보고서', '--project', 'p1', '--target', target, '--completion', 'research-report', '--json'];
  const shadow = await cli(args, { taskStatePath: path });
  expect(shadow.code ?? 0).toBe(0);
  const result = JSON.parse(shadow.lines[0]!);
  expect(result.card.project).toEqual({ id: 'p1', target });
  expect(result.card.completion).toBe('research-report');
  expect(result.cwd).toBe(target);
  expect(readTaskCard(result.card.id, path)?.project?.target).toBe(target);
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const live = await cli([...args, '--live'], { taskStatePath: path, taskLauncher: (command, cwd) => { calls.push({ args: command, cwd }); } });
  expect(live.code ?? 0).toBe(0);
  expect(calls).toEqual([{ args: ['harness', 'say', '--substrate', 'pod', '--merge-by-host', '보고서'], cwd: target }]);
  expect(JSON.parse(live.lines[0]!).cwd).toBe(target);
  const relativeTarget = relative(process.cwd(), target);
  const normalized = await cli(['task', 'hand', '보고서', '--project', 'p1', '--target', relativeTarget, '--completion', 'research-report', '--json'], { taskStatePath: path });
  expect(JSON.parse(normalized.lines[0]!).card.project.target).toBe(target);
});

test('비git code-pr 및 없는 디렉터리는 카드 기록 전에 거부한다', async () => {
  const target = mkdtempSync(join(tmpdir(), 'task-hand-project-'));
  const path = statePath();
  const denied = await cli(['task', 'hand', '보고서', '--project', 'p1', '--target', target, '--completion', 'code-pr', '--json'], { taskStatePath: path });
  expect(denied.code).toBe(1);
  expect(denied.lines).toEqual([`코드 종결은 git 대상이 필요 — --completion 을 고르거나 git init: ${target}`]);
  // completion 생략 = code-pr — 비git 대상이면 같은 거부(PR 병합을 영영 기다리는 카드를 만들지 않는다).
  const implicit = await cli(['task', 'hand', '보고서', '--project', 'p1', '--target', target], { taskStatePath: path });
  expect(implicit.code).toBe(1);
  expect(implicit.lines.join('\n')).toContain('git');
  const missing = await cli(['task', 'hand', '보고서', '--project', 'p1', '--target', join(target, 'absent'), '--completion', 'research-report', '--json'], { taskStatePath: path });
  expect(missing.code).toBe(1);
  expect(missing.lines.join('\n')).toContain('대상 디렉터리가 없습니다');
  expect(readTaskAgentState(path)).toEqual({});
});

test('프로젝트 handed 관측은 id 와 git 여부를 남긴다', async () => {
  const target = mkdtempSync(join(tmpdir(), 'task-hand-project-'));
  const events: Array<{ category: string; event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'task-project-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } });
  try {
    await handTask({ text: '보고서', project: { id: 'p1', target }, completion: 'research-report', statePath: statePath() });
    expect(events.find((entry) => entry.event === 'handed')?.data).toMatchObject({ projectId: 'p1', targetIsGit: false });
  } finally { off(); }
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
    expect(events[0]!.data).toMatchObject({ taskId: id, seat: 'OP', mode: 'shadow', projectId: null, targetIsGit: null });
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

test('--completion <kind> 는 카드에 종결 종류를 싣고 모르는 값은 exit 1 · 안 주면 카드에 칸이 없다 (§A4b③)', async () => {
  const path = statePath();
  const { lines, code } = await cli(['task', 'hand', 'x', '--completion', 'artifact', '--json'], { taskStatePath: path });
  expect(code).toBeFalsy();
  expect(JSON.parse(lines[0]!).card.completion).toBe('artifact');
  const plain = await cli(['task', 'hand', 'y', '--json'], { taskStatePath: path });
  expect('completion' in JSON.parse(plain.lines[0]!).card).toBe(false);
  const previous = process.exitCode;
  let thrown: unknown;
  try { await cli(['task', 'hand', 'z', '--completion', 'bogus'], { taskStatePath: path }); } catch (error) { thrown = error; } finally { process.exitCode = previous ?? 0; }
  expect((thrown as { exitCode?: number })?.exitCode).toBe(1);
  expect(Object.keys(readTaskAgentState<{ tasks: Record<string, unknown> }>(path).tasks)).toHaveLength(2);
  await expect(handTask({ text: 'w', completion: 'bogus' as never, statePath: path })).rejects.toThrow('종결 종류');
  const mission = await cli(['task', 'hand', '--mission', '- a\n- b', '--completion', 'artifact'], { taskStatePath: path });
  expect(mission.code).toBe(1);
});

test('TA-LIVE-LAND-2: task hand --ta-land --live writes card taLand and launches with ELANOUS_TA_LAND=1 (command unchanged)', async () => {
  const path = statePath();
  const calls: Array<{ args: string[]; context?: TaskLaunchContext }> = [];
  const { lines, code } = await cli(['task', 'hand', 'ship it', '--ta-land', '--live'], {
    taskStatePath: path,
    taskLauncher: (args, _cwd, context) => { calls.push({ args, context }); return { runId: context!.runId }; },
  });
  expect(code).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'ship it']);
  expect(calls[0]!.context!.env).toEqual({ ELANOUS_RUN_ID: calls[0]!.context!.runId, ELANOUS_TA_LAND: '1' });
  const cards = Object.values(readTaskAgentState<{ tasks: Record<string, { taLand?: boolean; runId?: string }> }>(path).tasks);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ taLand: true, runId: calls[0]!.context!.runId });
  expect(lines.join('\n')).toContain('ELANOUS_TA_LAND=1');
});

test('TA-LIVE-LAND-2: without --ta-land the card has no taLand and the launch env carries only the run id', async () => {
  const path = statePath();
  const calls: Array<{ context?: TaskLaunchContext }> = [];
  const { code } = await cli(['task', 'hand', 'ship it', '--live'], {
    taskStatePath: path,
    taskLauncher: (_args, _cwd, context) => { calls.push({ context }); return { runId: context!.runId }; },
  });
  expect(code).toBe(0);
  expect(calls[0]!.context!.env).toEqual({ ELANOUS_RUN_ID: calls[0]!.context!.runId });
  const cards = Object.values(readTaskAgentState<{ tasks: Record<string, { taLand?: boolean }> }>(path).tasks);
  expect(Object.hasOwn(cards[0]!, 'taLand')).toBe(false);
});

test('TA-LIVE-LAND-2: --ta-land is refused with --mission (pieces keep today\'s launch)', async () => {
  const { lines, code } = await cli(['task', 'hand', '--mission', '- a\n- b', '--ta-land'], { taskStatePath: statePath() });
  expect(code).toBe(1);
  expect(lines.join('\n')).toContain('--ta-land');
});

test('TASKS-HAND-CHILD-LLM: without --child-llm the command line and card are byte-identical to today', async () => {
  const path = statePath();
  const calls: string[][] = [];
  const { lines, code } = await cli(['task', 'hand', 'ship it', '--seat', 'UX', '--live', '--json'], {
    taskStatePath: path,
    taskLauncher: (args, _cwd, context) => { calls.push(args); return { runId: context!.runId }; },
  });
  expect(code).toBe(0);
  expect(calls).toEqual([['harness', 'say', '--seat', 'UX', '--substrate', 'pod', '--merge-by-host', 'ship it']]);
  const card = JSON.parse(lines[0]!).card as TaskCard;
  expect(Object.hasOwn(card, 'childLlm')).toBe(false);
  // 저장된 카드 직렬화 전체를 기능 도입 전 모양과 비교한다(동적 id·시각·런 id 만 정규화 · 키 순서까지).
  const stored = JSON.parse(readFileSync(path, 'utf8')).tasks[card.id] as TaskCard;
  const normalized = JSON.stringify(stored)
    .replaceAll(card.id, '<ID>').replaceAll(stored.runId!, '<RUN>').replaceAll(stored.launchId!, '<LAUNCH>')
    .replaceAll(stored.createdAt, '<T>').replaceAll(stored.history[0]!.at, '<T>');
  expect(normalized).toBe(JSON.stringify({
    id: '<ID>', text: 'ship it', seat: 'UX', createdAt: '<T>', status: 'launched', history: [
      { at: '<T>', event: 'launch', detail: 'harness say --seat UX --substrate pod --merge-by-host ship it' },
      { at: '<T>', event: 'run-bound', detail: '<RUN>', runId: '<RUN>' },
    ], runId: '<RUN>', launchId: '<LAUNCH>',
  }));
  expect(launchArgs({ text: 'x' })).toEqual(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'x']);
});

test('TASKS-HAND-CHILD-LLM: --child-llm grok/grok-4.7 passes --child-llm-provider/--child-llm-model, records card ⊕ observation', async () => {
  const path = statePath();
  const calls: string[][] = [];
  const events: Array<{ event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'child-llm-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } });
  try {
    const { lines, code } = await cli(['task', 'hand', 'ship it', '--child-llm', 'grok/grok-4.7', '--child-llm-effort', 'high', '--live', '--json'], {
      taskStatePath: path,
      taskLauncher: (args, _cwd, context) => { calls.push(args); return { runId: context!.runId }; },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([['harness', 'say', '--substrate', 'pod', '--merge-by-host', '--child-llm-provider', 'grok', '--child-llm-model', 'grok-4.7', '--child-llm-effort', 'high', 'ship it']]);
    const id = JSON.parse(lines[0]!).card.id as string;
    expect(readTaskCard(id, path)?.childLlm).toEqual({ provider: 'grok', model: 'grok-4.7', effort: 'high' });
    expect(events.find((e) => e.event === 'child-llm')?.data).toMatchObject({ taskId: id, input: 'grok/grok-4.7', provider: 'grok', model: 'grok-4.7', effort: 'high', mode: 'live' });
  } finally { off(); }
});

test('TASKS-HAND-CHILD-LLM: split on the first / only · openrouter keeps the full id as model', () => {
  expect(parseChildLlm('grok/grok-4.7')).toEqual({ provider: 'grok', model: 'grok-4.7' });
  expect(parseChildLlm('local/qwen/qwen3-coder')).toEqual({ provider: 'local', model: 'qwen/qwen3-coder' });
  expect(parseChildLlm('openrouter/z-ai/glm-5.3')).toEqual({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' });
  expect(parseChildLlm('openrouter/openrouter/z-ai/glm-5.3')).toEqual({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' });
  expect(launchArgs({ text: 'x', childLlm: parseChildLlm('openrouter/z-ai/glm-5.3') }))
    .toEqual(['harness', 'say', '--substrate', 'pod', '--merge-by-host', '--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/z-ai/glm-5.3', 'x']);
});

test('TASKS-HAND-CHILD-LLM: bad values are rejected and nothing is launched or written', async () => {
  for (const bad of ['grok', '/grok-4.7', 'grok/', '/', '', 'grok/ grok-4.7', ' grok/grok-4.7 ', 'grok/grok-4.7\n', 'grok/grok\u00074.7']) expect(() => parseChildLlm(bad)).toThrow('--child-llm');
  for (const bad of ['', ' high', 'high\n']) expect(() => parseChildLlm('grok/grok-4.7', bad)).toThrow('--child-llm-effort');
  const path = statePath();
  const calls: string[][] = [];
  const launcher = (args: string[]) => { calls.push(args); };
  for (const args of [['--child-llm', 'grok'], ['--child-llm', 'grok/'], ['--child-llm-effort', 'high'], ['--child-llm', 'grok/grok-4.7', '--child-llm-effort', ' ']]) {
    const { lines, code } = await cli(['task', 'hand', 'ship it', ...args, '--live'], { taskStatePath: path, taskLauncher: launcher });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('--child-llm');
  }
  expect(calls).toHaveLength(0);
  expect(readTaskAgentState<{ tasks?: Record<string, unknown> }>(path).tasks ?? {}).toEqual({});
  for (const extra of [['--child-llm', 'grok/grok-4.7'], ['--child-llm-effort', 'high']]) {
    const mission = await cli(['task', 'hand', '--mission', '- a\n- b', ...extra, '--live'], { taskStatePath: path, taskLauncher: launcher });
    expect(mission.code).toBe(1);
    expect(mission.lines.join('\n')).toContain('--child-llm');
  }
  expect(calls).toHaveLength(0);
  expect(readTaskAgentState<{ tasks?: Record<string, unknown> }>(path).tasks ?? {}).toEqual({});
});

test('TASKS-HAND-CHILD-LLM: --goal-file style path text ⊕ --child-llm coexist — file body inlined, card childLlm, flags before the body', async () => {
  const path = statePath();
  const goal = join(mkdtempSync(join(tmpdir(), 'task-hand-goal-')), 'GOAL-x.md');
  writeFileSync(goal, '# 골\n본문 한 줄\n');
  const calls: string[][] = [];
  const { lines, code } = await cli(['task', 'hand', goal, '--child-llm', 'openrouter/z-ai/glm-5.3', '--live', '--json'], {
    taskStatePath: path,
    taskLauncher: (args, _cwd, context) => { calls.push(args); return { runId: context!.runId }; },
  });
  expect(code).toBe(0);
  expect(calls).toEqual([['harness', 'say', '--substrate', 'pod', '--merge-by-host', '--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/z-ai/glm-5.3', readFileSync(goal, 'utf8').trim()]]);
  const card = readTaskCard(JSON.parse(lines[0]!).card.id, path)!;
  expect(card.text).toContain('본문 한 줄');
  expect(card.childLlm).toEqual({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' });
});
