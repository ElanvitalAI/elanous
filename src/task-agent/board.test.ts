import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerTasksCommands, type TasksCliDeps } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, checklistDevVersion, setItem } from '../release-loop/checklist.js';
import { startNexusHttpServer } from '../nexus/api/http-server.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';
import { cardsBoard, countBoardTasks, mergeBoards, releasePackBoard, taskAgentBoard, type BoardNode, type TaskAgentBoardResponse } from './board.js';
import { handTask, readTaskCard, type TaskCard } from './task-hand.js';
import { buildRunProgressRows, type RunningRunAssessment, type RunningRunsResult, type RunningRunStatus } from '../self-implement/running-runs.js';

const dirs: string[] = [];
function tempDir(prefix: string): string { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; }
afterEach(() => { resetElanousConfigDir(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function cli(args: string[], deps: TasksCliDeps): Promise<{ lines: string[]; code: number | string | undefined }> {
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, { registerSink: async () => true, releaseBoard: () => [], ...deps, output: (line) => lines.push(line) });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', ...args]);
    return { lines, code: process.exitCode };
  } finally { process.exitCode = previous ?? 0; }
}

const card = (id: string, over: Partial<TaskCard> = {}): TaskCard => ({ id, text: `task ${id}`, createdAt: '2026-10-07T00:00:00.000Z', status: 'handed', history: [], ...over });

const RUNS_NOW = Date.parse('2026-10-12T02:30:00.000Z');

/** 완전 관측을 기본으로 하는 관측 결과 fixture — over 로 부분 관측(count `{ count: null, lowerBound }` 꼴 · unreadable)으로 갈아끼운다. */
function runsObservation(over: Partial<RunningRunsResult> = {}): RunningRunsResult {
  const entries = over.entries ?? [];
  const counts: Record<RunningRunStatus, number> = over.counts ?? { running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 };
  const scope = { runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: false } as const;
  const base: RunningRunsResult = {
    completeness: 'complete', count: 0, unreadable: [],
    entries, counts, total: entries.length, countedStatuses: ['running', 'probable-running'],
    quantities: {
      counts: { value: counts, population: 'all assessed runs', observation: scope },
      total: { value: entries.length, population: 'all assessed runs', observation: scope },
      entries: { value: entries.length, population: 'all assessed runs', observation: scope },
      running: { value: counts.running + counts['probable-running'], population: 'assessed runs whose status is in countedStatuses', observation: scope },
    },
    observation: scope,
    ledger: { ledgerDirectories: [], unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 },
    pty: { unreadable: [], observedRefCount: 0, withoutRunIdCount: 0, notCountedRefCount: 0 },
    phases: { targetCount: 0, readableTargetCount: 0, unreadableTargetCount: 0, unreadableTargets: [], discardedNonStageEventCount: 0 },
  };
  return { ...base, ...over };
}

function runEntry(runId: string, over: Partial<RunningRunAssessment> = {}): RunningRunAssessment {
  return {
    runId, status: 'probable-running', presence: 'ledger-live-pty-not-observed', reason: 'ledger-without-live-pty',
    lifecycle: 'live', lastActivityTimestamp: '2026-10-12T02:00:00.000Z',
    phaseObservation: 'not-observed', lastPhase: null, lastPhaseObservedAt: null,
    ptyUpdatedAt: null, ledgerDirectories: [], ptyRefs: [],
    ...over,
  };
}

function ledgerHash(root: string): string {
  const hash = createHash('sha256');
  const dir = join(root, 'release');
  // 원장 내용 = features.sqlite ⊕ -wal. -shm 은 SQLite 의 WAL 색인(공유 메모리)이라 읽기만 해도 바뀐다 — 원장이 아니다.
  for (const name of readdirSync(dir).sort()) if (name === 'features.sqlite' || name === 'features.sqlite-wal') hash.update(name).update(readFileSync(join(dir, name)));
  return hash.digest('hex');
}

describe('보드 일반형 — 프로젝트 › 목표 › 이정표 › 과제 (RFC-loop-agent-map §A4b①)', () => {
  test('task board --project p1 --json → p1 › g1 › m1 › 과제 2 · 무소속 과제는 p1 아래 안 나온다 · board 관측', async () => {
    const path = join(tempDir('task-board-'), 'task-agent-actions.json');
    const project = { id: 'p1', target: '/tmp' };
    writeFileSync(path, JSON.stringify({ landingDay: '2026-10-07', tasks: {
      'ta-a': card('ta-a', { project, goal: 'g1', milestone: 'm1', completion: 'research-report' }),
      'ta-b': card('ta-b', { project, goal: 'g1', milestone: 'm1' }),
      'ta-c': card('ta-c'),
    } }));
    const releaseReads = { n: 0 };
    const other = await cli(['task', 'board', '--project', 'p1', '--json'], { taskStatePath: path, releaseBoard: () => { releaseReads.n++; throw new Error('ledger unreadable'); } });
    expect(other.code ?? 0).toBe(0);
    expect(releaseReads.n).toBe(0);
    const pack = await cli(['task', 'board', '--project', 'elanous', '--json'], { taskStatePath: path, releaseBoard: () => { releaseReads.n++; throw new Error('ledger unreadable'); } });
    expect([pack.code, releaseReads.n]).toEqual([1, 1]);
    const events: unknown[] = [];
    const off = debug.registerSink({ name: 'task-board-capture', emit: (record) => { if (record.category === 'task-agent' && record.event === 'board') events.push(record.data); } });
    try {
      const { lines, code } = await cli(['task', 'board', '--project', 'p1', '--json'], { taskStatePath: path });
      expect(code ?? 0).toBe(0);
      const board = JSON.parse(lines[0]!) as BoardNode[];
      expect(board).toMatchObject([{ level: 'project', id: 'p1', status: 'open', children: [{ level: 'goal', id: 'g1', parent: 'p1', children: [{ level: 'milestone', id: 'm1', parent: 'g1', children: [
        { level: 'task', id: 'ta-a', title: 'task ta-a', status: 'open', completion: 'research-report', parent: 'm1' },
        { level: 'task', id: 'ta-b', title: 'task ta-b', status: 'open', parent: 'm1' },
      ] }] }] }]);
      expect(board).toHaveLength(1);
      expect(lines[0]).not.toContain('ta-c');
      expect(events).toContainEqual(expect.objectContaining({ projects: 1, tasks: 2 }));
    } finally { off(); }
    const all = cardsBoard(path);
    expect(all.map((node) => node.id)).toEqual(['p1', '']);
    expect(all[1]).toMatchObject({ unassigned: true, title: '무소속', children: [{ level: 'task', id: 'ta-c' }] });
  });

  test('실제 프로젝트 id 가 «unassigned» 여도 무소속 카드와 섞이지 않는다 · --project 로 무소속을 고를 수 없다', async () => {
    const path = join(tempDir('task-board-collide-'), 'task-agent-actions.json');
    writeFileSync(path, JSON.stringify({ tasks: {
      'ta-real': card('ta-real', { project: { id: 'unassigned', target: '/tmp' } }),
      'ta-none': card('ta-none'),
    } }));
    const named = JSON.parse((await cli(['task', 'board', '--project', 'unassigned', '--json'], { taskStatePath: path })).lines[0]!) as BoardNode[];
    expect(named).toHaveLength(1);
    expect(named[0]!.children!.map((node) => node.id)).toEqual(['ta-real']);
    expect(JSON.parse((await cli(['task', 'board', '--project', '', '--json'], { taskStatePath: path })).lines[0]!)).toEqual([]);
  });

  test('무소속 카드의 목표·이정표도 부모 참조를 갖는다(무소속 id 는 빈 문자열)', () => {
    const path = join(tempDir('task-board-orphan-'), 'task-agent-actions.json');
    writeFileSync(path, JSON.stringify({ tasks: { 'ta-o': card('ta-o', { goal: 'g9', milestone: 'm9' }) } }));
    expect(cardsBoard(path)).toMatchObject([{ id: '', unassigned: true, children: [{ level: 'goal', id: 'g9', parent: '', children: [{ level: 'milestone', id: 'm9', parent: 'g9', children: [{ id: 'ta-o', parent: 'm9' }] }] }] }]);
  });

  test('카드의 이정표가 현재 판과 같으면 체크리스트 판과 한 이정표로 합친다(실제 임시 원장)', async () => {
    const root = tempDir('task-board-merge-ledger-');
    setElanousConfigDir(root);
    addItem('9.9.9', { id: 'K1', title: 'cell' });
    setItem('9.9.9', 'K1', { status: 'green' }, 'TC');
    const path = join(root, 'task-agent-actions.json');
    writeFileSync(path, JSON.stringify({ tasks: { 'ta-m': card('ta-m', { project: { id: 'elanous', target: '/tmp' }, milestone: '9.9.9' }) } }));
    const { lines } = await cli(['task', 'board', '--project', 'elanous', '--json'], { taskStatePath: path, releaseBoard: () => releasePackBoard('9.9.9', root) });
    const board = JSON.parse(lines[0]!) as BoardNode[];
    expect(board).toHaveLength(1);
    const milestones = board[0]!.children!.filter((node) => node.level === 'milestone' && node.id === '9.9.9');
    expect(milestones).toHaveLength(1);
    expect(milestones[0]!.children!.map((node) => node.id)).toEqual(['ta-m', 'K1']);
    expect(milestones[0]!.status).toBe('open');
  });

  test('CLI 기본 경로는 현재 판 체크리스트를 같은 elanous 프로젝트에 합친다(임시 원장 · 읽기만)', async () => {
    const root = tempDir('task-board-cli-ledger-');
    setElanousConfigDir(root);
    const version = checklistDevVersion();
    addItem(version, { id: 'K1', title: 'internal cell' });
    const path = join(root, 'task-agent-actions.json');
    writeFileSync(path, JSON.stringify({ tasks: { 'ta-own': card('ta-own', { project: { id: 'elanous', target: '/tmp' } }) } }));
    const before = ledgerHash(root);
    const { lines, code } = await cli(['task', 'board', '--project', 'elanous', '--json'], { taskStatePath: path, releaseBoard: undefined });
    expect(code ?? 0).toBe(0);
    const board = JSON.parse(lines[0]!) as BoardNode[];
    expect(board).toHaveLength(1);
    expect(board[0]!.children).toContainEqual(expect.objectContaining({ level: 'task', id: 'ta-own' }));
    expect(board[0]!.children).toContainEqual(expect.objectContaining({ level: 'milestone', id: version, children: [expect.objectContaining({ id: 'K1', status: 'open' })] }));
    expect(ledgerHash(root)).toBe(before);
  });

  test('task hand --goal/--milestone 은 카드에 싣고 보드로 읽힌다 · 안 주면 카드에 칸이 없다', async () => {
    const path = join(tempDir('task-board-hand-'), 'task-agent-actions.json');
    const target = tempDir('task-board-target-');
    execFileSync('git', ['init', '-q', target]);
    const { lines, code } = await cli(['task', 'hand', 'first', '--project', 'p1', '--target', target, '--completion', 'code-pr', '--goal', 'g1', '--milestone', 'm1', '--json'], { taskStatePath: path });
    expect(code ?? 0).toBe(0);
    const id = JSON.parse(lines[0]!).card.id as string;
    expect(readTaskCard(id, path)).toMatchObject({ project: { id: 'p1', target }, goal: 'g1', milestone: 'm1' });
    const plain = await handTask({ text: 'plain', statePath: path });
    expect('goal' in plain.card || 'milestone' in plain.card).toBe(false);
    expect(cardsBoard(path)).toMatchObject([{ id: 'p1', children: [{ id: 'g1', children: [{ id: 'm1', children: [{ id }] }] }] }, { id: '', unassigned: true }]);
    for (const bad of ['', '  ', 'g\tx', 'm\ny', 'c1\u0085']) {
      const rejected = await cli(['task', 'hand', 'bad', '--goal', bad], { taskStatePath: path });
      expect(rejected.code).toBe(1);
      expect(rejected.lines.join('\n')).toContain('--goal');
    }
    await expect(handTask({ text: 'bad', milestone: ' ', statePath: path })).rejects.toThrow('--milestone');
    const mission = await cli(['task', 'hand', '--mission', '- a\n- b', '--goal', 'g1'], { taskStatePath: path });
    expect(mission.code).toBe(1);
  });

  test('releasePackBoard — 칸 3(green·yellow·red) → done·open·blocked · 원장 파일 해시가 읽기 전후 같다', () => {
    const root = tempDir('task-board-ledger-');
    setElanousConfigDir(root);
    for (const [id, status] of [['GREEN', 'green'], ['YELLOW', 'yellow'], ['RED', 'red']] as const) {
      addItem('9.9.9', { id, title: id });
      setItem('9.9.9', id, { status }, 'TC');
    }
    const before = ledgerHash(root);
    const board = releasePackBoard('9.9.9', root);
    expect(board).toMatchObject([{ level: 'project', id: 'elanous', status: 'blocked', children: [{ level: 'milestone', id: '9.9.9', parent: 'elanous', children: [
      { level: 'task', id: 'GREEN', status: 'done' }, { level: 'task', id: 'YELLOW', status: 'open' }, { level: 'task', id: 'RED', status: 'blocked' },
    ] }] }]);
    expect(ledgerHash(root)).toBe(before);
    expect(releasePackBoard('9.9.9', tempDir('task-board-empty-'))).toEqual([]);
  });

  test('taskAgentBoard — 카드마다 runId·PR·마지막 상태·종료 이유가 붙고 progress.rows 는 주입 관측을 buildRunProgressRows 그대로 싣는다(ledger 와는 runId 로만 짝짓는다 · 새 칸 0) · 원장은 바이트 그대로', () => {
    const path = join(tempDir('task-board-ledger-facts-'), 'task-agent-actions.json');
    const project = { id: 'p1', target: '/tmp' };
    writeFileSync(path, JSON.stringify({ tasks: {
      'ta-run': card('ta-run', { project, status: 'launched', runId: 'run-1', pr: { number: 77, url: 'https://x/pull/77' },
        history: [{ at: 't1', event: 'run-bound', runId: 'run-1' }, { at: 't2', event: 'live-move', kind: 'review' }] }),
      'ta-dead': card('ta-dead', { project, status: 'failed', runId: 'run-2', pr: 5,
        history: [{ at: 't3', event: 'failed', detail: 'failed/needs-owner — exit 1 · pod-failure' }, { at: 't4', event: 'hand-move', detail: 'noise' }] }),
      'ta-closed': card('ta-closed', { project, status: 'failed', history: [{ at: 't5', event: 'closed-by-hand', detail: 'd', reason: '중복 카드' }] }),
      'ta-new': card('ta-new', { project }),
    } }));
    const before = readFileSync(path, 'utf8');
    const observation = runsObservation({
      entries: [runEntry('run-1', { status: 'running', presence: 'ledger-live-and-pty-observed', reason: 'ledger-live-and-pty-alive', lastPhase: 'review', lastPhaseObservedAt: '2026-10-12T02:10:00.000Z', phaseObservation: 'observed' })],
      counts: { running: 1, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 },
      count: 1,
    });
    const response = taskAgentBoard(path, { runningRuns: () => observation, nowMs: RUNS_NOW });
    expect(response.progress).toEqual({ rows: buildRunProgressRows(observation, RUNS_NOW), partial: false, lowerBound: null });
    expect(response.progress!.rows[0]).toMatchObject({ runId: 'run-1', status: 'running', lastPhase: 'review', elapsedMs: 30 * 60_000, phaseObservation: 'observed' });
    expect(readFileSync(path, 'utf8')).toBe(before);
    const tasks = Object.fromEntries(response.board[0]!.children!.map((node) => [node.id, node.ledger]));
    expect(tasks['ta-run']).toEqual({ runId: 'run-1', pr: 77, lastStatus: 'launched', lastEvent: { at: 't1', event: 'run-bound', detail: null }, exitReason: null });
    expect(tasks['ta-dead']).toEqual({ runId: 'run-2', pr: 5, lastStatus: 'failed',
      lastEvent: { at: 't3', event: 'failed', detail: 'failed/needs-owner — exit 1 · pod-failure' }, exitReason: 'failed/needs-owner — exit 1 · pod-failure' });
    expect(tasks['ta-closed']).toMatchObject({ runId: null, pr: null, exitReason: '중복 카드' });
    expect(tasks['ta-new']).toEqual({ runId: null, pr: null, lastStatus: 'handed', lastEvent: null, exitReason: null });
  });

  test('bound terminal PR distinguishes merged and closed; stale marker does not close a rebound card', () => {
    const path = join(tempDir('task-board-terminal-'), 'task-agent-actions.json');
    const url = 'https://github.com/o/r/pull/30';
    const merged = { pr: 30, url, head: 'a'.repeat(40), state: 'MERGED' as const, at: '2026-10-13T01:00:00.000Z' };
    const partial = { pr: 30, head: merged.head, at: merged.at, outcome: 'partial' as const, evidence: ['slice landed'], remaining: ['live check'] };
    writeFileSync(path, JSON.stringify({ tasks: {
      merged: card('merged', { status: 'launched', pr: { number: 30, url }, prTerminal: merged, postLand: partial }),
      closed: card('closed', { status: 'launched', pr: { number: 31, url: 'https://github.com/o/r/pull/31' },
        prTerminal: { ...merged, pr: 31, url: 'https://github.com/o/r/pull/31', state: 'CLOSED' } }),
      rebound: card('rebound', { status: 'launched', pr: { number: 32, url: 'https://github.com/o/r/pull/32' }, prTerminal: merged }),
      crossRepo: card('crossRepo', { status: 'launched', pr: { number: 30, url: 'https://github.com/other/repo/pull/30' },
        prTerminal: merged, postLand: partial }),
    } }));
    const tasks = cardsBoard(path, { ledger: true })[0]!.children!;
    expect(tasks.map((item) => [item.id, item.status])).toEqual([['merged', 'done'], ['closed', 'blocked'], ['rebound', 'open'], ['crossRepo', 'open']]);
    expect(tasks[0]?.ledger).toMatchObject({ prTerminal: merged, postLand: partial });
    expect(tasks[2]?.ledger?.prTerminal).toBeUndefined();
    expect(tasks[3]?.ledger?.postLand).toBeUndefined();
  });

  test('progress — 부분 관측(count `{ count: null, lowerBound }` 꼴 · unreadable)이면 partial=true·lowerBound=최소 수 · 완전 관측이면 partial=false·lowerBound=null', () => {
    const path = join(tempDir('task-board-progress-partial-'), 'task-agent-actions.json');
    writeFileSync(path, JSON.stringify({ tasks: { 'ta-run': card('ta-run', { project: { id: 'p1', target: '/tmp' }, runId: 'run-1' }) } }));
    const unreadable = [{ dir: '/led/unread', reason: 'unreadable-ledger' }] as const;
    const objectCount = runsObservation({
      completeness: 'partial',
      count: { count: null, lowerBound: 1, unreadable },
      unreadable,
      entries: [runEntry('run-1')],
      counts: { running: 0, 'probable-running': 1, 'ended-unclosed': 0, unknown: 0 },
    });
    expect(taskAgentBoard(path, { runningRuns: () => objectCount, nowMs: RUNS_NOW }).progress)
      .toEqual({ rows: buildRunProgressRows(objectCount, RUNS_NOW), partial: true, lowerBound: 1 });
    const unreadableOnly = runsObservation({
      count: 1,
      unreadable,
      entries: [runEntry('run-1', { status: 'running', presence: 'ledger-live-and-pty-observed', reason: 'ledger-live-and-pty-alive' })],
      counts: { running: 1, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 },
    });
    expect(taskAgentBoard(path, { runningRuns: () => unreadableOnly, nowMs: RUNS_NOW }).progress)
      .toEqual({ rows: buildRunProgressRows(unreadableOnly, RUNS_NOW), partial: true, lowerBound: 1 });
    const complete = runsObservation({ entries: [runEntry('run-1')], counts: { running: 0, 'probable-running': 1, 'ended-unclosed': 0, unknown: 0 }, count: 1 });
    expect(taskAgentBoard(path, { runningRuns: () => complete, nowMs: RUNS_NOW }).progress)
      .toEqual({ rows: buildRunProgressRows(complete, RUNS_NOW), partial: false, lowerBound: null });
  });

  test('관측 함수가 던지면 progress=null · 보드는 그대로 · task-agent board-progress-unavailable 관측 로그를 남긴다(0을 «없다»로 쓰지 않는다)', () => {
    const path = join(tempDir('task-board-progress-unavailable-'), 'task-agent-actions.json');
    writeFileSync(path, JSON.stringify({ tasks: { 'ta-x': card('ta-x', { project: { id: 'p1', target: '/tmp' }, runId: 'run-x' }) } }));
    const unavailable: unknown[] = [];
    const off = debug.registerSink({ name: 'task-board-progress-capture', emit: (record) => { if (record.category === 'task-agent' && record.event === 'board-progress-unavailable') unavailable.push(record.data); } });
    try {
      const response = taskAgentBoard(path, { runningRuns: () => { throw new Error('progress query failed'); } });
      expect(response.progress).toBeNull();
      expect(response.board).toEqual(cardsBoard(path, { ledger: true }));
      expect(unavailable).toContainEqual(expect.objectContaining({ error: 'progress query failed' }));
    } finally { off(); }
  });

  test('taskAgentBoard — 원장이 없으면 빈 보드 · 파일도 만들지 않는다 · CLI 기본 트리는 ledger 칸이 없다', () => {
    const dir = tempDir('task-board-no-ledger-');
    const path = join(dir, 'task-agent-actions.json');
    expect(taskAgentBoard(path, { runningRuns: () => runsObservation() })).toEqual({ board: [], progress: { rows: [], partial: false, lowerBound: null } });
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(path, JSON.stringify({ tasks: { 'ta-a': card('ta-a', { runId: 'r' }) } }));
    expect(JSON.stringify(cardsBoard(path))).not.toContain('ledger');
  });

  test('GET /api/task-agent/board — 인증 필수(401) · 읽기 전용(405) · 원장 없음=빈 보드 · 손상=503', async () => {
    const dir = tempDir('task-board-http-');
    const path = join(dir, 'task-agent-actions.json');
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const server = startNexusHttpServer({
      state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
      metaApi: { bearerToken: 'test-token', noAuth: false }, taskAgentStatePath: path,
      startPort: 45000 + Math.floor(Math.random() * 2000),
    });
    const headers = { authorization: 'Bearer test-token', 'sec-fetch-site': 'cross-site' };
    const url = `${server.url}/api/task-agent/board`;
    try {
      const anonymous = await fetch(url, { headers: { 'sec-fetch-site': 'cross-site' } });
      expect(anonymous.status).toBe(401);
      expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).toBe(405);
      const empty = await fetch(url, { headers });
      const emptyBody = await empty.json() as TaskAgentBoardResponse;
      expect(empty.status).toBe(200);
      expect(emptyBody.board).toEqual([]);
      // 기본 응답은 진전 관측을 돌리지 않는다(동기 수 초 · 데몬 루프 보호) — progress=null 이고 호스트 원장을 읽지 않는다.
      expect(emptyBody.progress).toBeNull();
      writeFileSync(path, JSON.stringify({ tasks: { 'ta-h': card('ta-h', { project: { id: 'p1', target: '/tmp' }, status: 'launched', runId: 'run-h', pr: 9 }) } }));
      const body = await (await fetch(url, { headers })).json() as TaskAgentBoardResponse;
      expect(body.board[0]!.children![0]).toMatchObject({ id: 'ta-h', ledger: { runId: 'run-h', pr: 9, lastStatus: 'launched', exitReason: null } });
      expect(body.progress).toBeNull();
      writeFileSync(path, '{broken');
      const broken = await fetch(url, { headers });
      expect([broken.status, await broken.json()]).toEqual([503, { error: 'task-agent-ledger-unreadable' }]);
    } finally { server.stop(); }
  });

  test('두 어댑터를 합치면 같은 프로젝트 id 는 한 노드 · 입력은 바뀌지 않는다', () => {
    const cards: BoardNode[] = [{ level: 'project', id: 'elanous', title: 'elanous', status: 'done', children: [{ level: 'task', id: 'ta-x', title: 'x', status: 'done', parent: 'elanous' }] }];
    const pack: BoardNode[] = [{ level: 'project', id: 'elanous', title: 'elanous (내부 팩)', status: 'open', children: [{ level: 'milestone', id: '0.2.19', title: '판 0.2.19', status: 'open', parent: 'elanous', children: [{ level: 'task', id: 'K1', title: 'k', status: 'open', parent: '0.2.19' }] }] }];
    const merged = mergeBoards(cards, pack);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe('open');
    expect(merged[0]!.children!.map((node) => node.id)).toEqual(['ta-x', '0.2.19']);
    expect(countBoardTasks(merged)).toBe(2);
    expect(cards[0]!.children).toHaveLength(1);
    expect(cards[0]!.status).toBe('done');
  });
});

describe('progress 는 요청할 때만 · completeness 를 따른다 (UX 수확 리뷰 should-fix)', () => {
  test('주입도 withProgress 도 없으면 관측을 돌리지 않고 progress=null', () => {
    const path = join(tempDir('task-board-progress-off-'), 'task-agent-actions.json');
    expect(taskAgentBoard(path)).toEqual({ board: [], progress: null });
    expect(taskAgentBoard(path, { withProgress: false })).toEqual({ board: [], progress: null });
  });

  test('completeness=partial 이면 count·unreadable 이 없어도 partial=true', () => {
    const path = join(tempDir('task-board-progress-completeness-'), 'task-agent-actions.json');
    const observation = { ...runsObservation(), completeness: 'partial' as const };
    expect(taskAgentBoard(path, { runningRuns: () => observation, nowMs: RUNS_NOW }).progress?.partial).toBe(true);
  });
});
