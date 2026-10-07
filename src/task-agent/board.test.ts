import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerTasksCommands, type TasksCliDeps } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, checklistDevVersion, setItem } from '../release-loop/checklist.js';
import { cardsBoard, countBoardTasks, mergeBoards, releasePackBoard, type BoardNode } from './board.js';
import { handTask, readTaskCard, type TaskCard } from './task-hand.js';

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
    const { lines, code } = await cli(['task', 'hand', 'first', '--project', 'p1', '--target', target, '--completion', 'artifact', '--goal', 'g1', '--milestone', 'm1', '--json'], { taskStatePath: path });
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
