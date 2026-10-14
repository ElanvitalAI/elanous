import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, checklistDevVersion } from '../release-loop/checklist.js';
import { appendRunLedgerEntry, loadRunLedger, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { GoalAskStore } from '../self-implement/goal-ask-store.js';
import { GoalRunStore, goalRunDbPath } from '../self-implement/goal-run-store.js';
import { runHostRegate } from '../self-implement/host-regate.js';
import type { LogStoreRow } from '../mss/logging/log-store.js';
import { readTaskCard, writeTaskCards, type TaskCard } from '../task-agent/task-hand.js';
import { rejudgeCandidates } from '../task-agent/rejudge-on-head.js';
import { adoptExistingPr, adoptedRunTerminal } from '../task-agent/adopt-pr.js';
import type { BoardNode } from '../task-agent/board.js';
import { defaultTaskLauncher, ELANOUS_CLI_ENTRY, registerTasksCommands, spawnDetachedConfirmed, taskLauncherArgv, type DetachedSpawn, type TasksCliDeps } from './tasks-cli.js';

const token = 'secret-acp-token-sentinel';
test('tasks adopt-pr binds an existing OPEN PR once without relaunch and queues head rejudge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-adopt-pr-'));
  try {
    const path = join(dir, 'cards.json');
    const card: TaskCard = { id: 'ta-20261013-adopt', text: 'existing', checklistId: 'EXPORT-CHECK-PWA-DEPS', status: 'launched', runId: 'run-stopped', createdAt: '2026-10-13T00:00:00Z', history: [] };
    writeTaskCards(path, [card]);
    let launched = 0;
    const deps: TasksCliDeps = {
      taskStatePath: path, registerSink: async () => {}, taskLauncher: async () => { launched++; },
      releaseVersions: () => ['0.2.26'],
      adoptRunTerminal: () => true,
      adoptChecklist: (version) => ({ version, released: '', dev: '', items: version === '0.2.26' ? [{ id: card.checklistId!, title: 'work', status: 'yellow', updatedAt: '', updatedBy: '' }] : [], history: [] }),
      adoptPrView: () => ({ number: 26619, url: 'https://github.com/ElanvitalAI/elanous/pull/26619', state: 'OPEN', baseRefName: 'main', headRefOid: 'a'.repeat(40) }),
    };
    const first = await run(['tasks', 'adopt-pr', '26619', '--card', card.id, '--json'], deps);
    const second = await run(['tasks', 'adopt-pr', '26619', '--card', card.id, '--json'], deps);
    expect(first.code ?? 0).toBe(0);
    expect(JSON.parse(first.lines[0]!).changed).toBe(true);
    expect(JSON.parse(second.lines[0]!).changed).toBe(false);
    const bound = readTaskCard(card.id, path)!;
    writeTaskCards(path, [{ ...bound, status: 'done' }]);
    const afterClose = await run(['tasks', 'adopt-pr', '26619', '--card', card.id], deps);
    expect(afterClose.code).toBe(1);
    expect(afterClose.lines[0]).toContain('이미 닫힌 입양 카드');
    writeTaskCards(path, [bound]);
    expect(bound.pr).toEqual({ number: 26619, url: 'https://github.com/ElanvitalAI/elanous/pull/26619' });
    expect(bound.checklistVersion).toBe('0.2.26');
    expect(bound.history.filter((item) => item.event === 'pr-adopted')).toHaveLength(1);
    expect(rejudgeCandidates({ [card.id]: bound })).toEqual([card.id]);
    expect(launched).toBe(0);
    const tick = await run(['tasks', 'rejudge', '--all'], { ...deps, rejudge: { liveMoves: new Set(),
      live: { repoCandidates: () => [{ source: 'host', cwd: dir }], prHead: async () => ({ head: 'a'.repeat(40), state: 'OPEN', url: bound.pr && typeof bound.pr === 'object' ? bound.pr.url! : '', branch: 'feature' }) },
    } });
    expect(tick.lines.some((line) => line.includes(`${card.id}\tPR #26619`) && line.includes('would-review'))).toBe(true);
    expect(launched).toBe(0);
    const ambiguousDir = mkdtempSync(join(tmpdir(), 'ta-adopt-ambiguous-'));
    try {
      const ambiguousPath = join(ambiguousDir, 'cards.json');
      writeTaskCards(ambiguousPath, [card]);
      const ambiguous = await run(['tasks', 'adopt-pr', '26619', '--card', card.id], {
        ...deps, taskStatePath: ambiguousPath,
        adoptChecklist: (version) => ({ version, released: '', dev: '', items: [{ id: card.checklistId!, title: 'work', status: 'yellow', updatedAt: '', updatedBy: '' }], history: [] }),
      });
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.lines[0]).toContain('--version 지정');
      expect(readTaskCard(card.id, ambiguousPath)?.pr).toBeUndefined();
    } finally { rmSync(ambiguousDir, { recursive: true, force: true }); }
    const completed = await run(['tasks', 'adopt-pr', '26619', '--card', card.id, '--version', '0.2.26'], {
      ...deps, adoptChecklist: (version) => ({ version, released: '', dev: '', items: [{ id: card.checklistId!, title: 'work', status: 'green', updatedAt: '', updatedBy: '' }], history: [] }),
    });
    expect(completed.code).toBe(1);
    expect(completed.lines[0]).toContain('이미 완료된 칸');
    const pendingDir = mkdtempSync(join(tmpdir(), 'ta-adopt-pending-'));
    try {
      const pendingPath = join(pendingDir, 'cards.json');
      writeTaskCards(pendingPath, [{ ...card, runId: undefined, launchId: 'tl-pending' }]);
      const pending = await run(['tasks', 'adopt-pr', '26619', '--card', card.id, '--version', '0.2.26'],
        { ...deps, taskStatePath: pendingPath, adoptRunTerminal: undefined });
      expect(pending.code).toBe(1);
      expect(pending.lines[0]).toContain('런 종결·PR 근거가 없다');
      expect(readTaskCard(card.id, pendingPath)?.pr).toBeUndefined();
    } finally { rmSync(pendingDir, { recursive: true, force: true }); }
    const closed = await run(['tasks', 'adopt-pr', '26619', '--card', card.id], { ...deps, adoptPrView: () => ({ ...deps.adoptPrView!(26619, ''), state: 'CLOSED' }) });
    expect(closed.code).toBe(1);
    const wrongVersion = await run(['tasks', 'adopt-pr', '26619', '--card', card.id, '--version', '0.2.27'], {
      ...deps, adoptChecklist: (version) => ({ version, released: '', dev: '', items: [{ id: card.checklistId!, title: 'work', status: 'yellow', updatedAt: '', updatedBy: '' }], history: [] }),
    });
    expect(wrongVersion.code).toBe(1);
    expect(wrongVersion.lines[0]).toContain('판이 다르다');
    const raced = await run(['tasks', 'adopt-pr', '26619', '--card', card.id], { ...deps,
      adoptRunTerminal: () => {
        const disk = JSON.parse(readFileSync(path, 'utf8'));
        disk.tasks[card.id].runId = 'run-new';
        writeFileSync(path, JSON.stringify(disk));
        return true;
      },
    });
    expect(raced.code).toBe(1);
    expect(raced.lines[0]).toContain('런 식별자가 바뀌었다');
    writeTaskCards(path, [bound]);
    const movedCell = await run(['tasks', 'adopt-pr', '26619', '--card', card.id], { ...deps,
      adoptRunTerminal: () => {
        const disk = JSON.parse(readFileSync(path, 'utf8'));
        disk.tasks[card.id].checklistId = 'OTHER-CELL';
        writeFileSync(path, JSON.stringify(disk));
        return true;
      },
    });
    expect(movedCell.code).toBe(1);
    expect(movedCell.lines[0]).toContain('카드 칸·판이 바뀌었다');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('new-card PR adoption pins the selected checklist version and rejects a second PR binding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-adopt-version-'));
  try {
    const path = join(dir, 'cards.json');
    const pr = { number: 80, url: 'https://github.com/ElanvitalAI/elanous/pull/80', state: 'OPEN', baseRefName: 'main', headRefOid: 'b'.repeat(40) };
    const result = adoptExistingPr({ pr, repo: 'ElanvitalAI/elanous', statePath: path, checklist: { version: '0.2.26', id: 'CELL', title: 'work', status: 'yellow' } });
    expect(result.card.checklistVersion).toBe('0.2.26');
    expect(result.card.status).toBe('launched');
    expect(() => adoptExistingPr({ pr, repo: 'ElanvitalAI/elanous', statePath: path, checklist: { version: '0.2.26', id: 'CELL', title: 'work', status: 'yellow' } })).toThrow('이미 카드');
    expect(() => adoptExistingPr({ pr, repo: 'another/repo', statePath: path, checklist: { version: '0.2.26', id: 'CELL', title: 'work', status: 'yellow' } })).toThrow('OPEN/main');
    const second: TaskCard = { id: 'ta-second', text: 'same cell', checklistId: 'CELL', createdAt: '2026-10-13T00:00:00Z', status: 'launched', history: [] };
    writeTaskCards(path, [result.card, second]);
    expect(() => adoptExistingPr({ pr: { ...pr, number: 81, url: pr.url.replace('/80', '/81') }, repo: 'ElanvitalAI/elanous', statePath: path,
      cardId: second.id, version: '0.2.26', observedRun: {} })).toThrow('이미 TA 착지 후보');
    writeFileSync(path, JSON.stringify({ tasks: { [second.id]: second } }));
    expect(() => adoptExistingPr({ pr: { ...pr, number: 82, url: pr.url.replace('/80', '/82') }, repo: 'ElanvitalAI/elanous', statePath: path,
      checklist: { version: '0.2.26', id: 'CELL', title: 'work', status: 'yellow' } })).toThrow('--card로 그 카드를 선택');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tasks adopt-pr promotes a registry-bound PR only with terminal proof and the same URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-adopt-bound-'));
  try {
    const path = join(dir, 'cards.json');
    const url = 'https://github.com/ElanvitalAI/elanous/pull/26619';
    const card: TaskCard = { id: 'ta-registry-bound', text: 'existing', checklistId: 'CELL', status: 'launched',
      runId: 'run-parent', createdAt: '2026-10-13T00:00:00Z', history: [], pr: { number: 26619, url } };
    writeTaskCards(path, [card]);
    const ledgerDir = join(dir, 'run-ledger');
    appendRunLedgerEntry({ runId: 'run-parent', event: 'pod-child-run', data: { childRunId: 'run-child' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-child', event: 'pr-opened', data: { number: 26619, url } }, ledgerDir);
    const deps: TasksCliDeps = { taskStatePath: path, registerSink: async () => {},
      releaseVersions: () => ['0.2.26'],
      adoptRunTerminal: (card, pr, _load, allowUnlinked) => adoptedRunTerminal(card, pr,
        (id) => loadRunLedger(id, ledgerDir), allowUnlinked),
      adoptChecklist: (version) => ({ version, released: '', dev: '', items: version === '0.2.26'
        ? [{ id: 'CELL', title: 'work', status: 'yellow', updatedAt: '', updatedBy: '' }] : [], history: [] }),
      adoptPrView: () => ({ number: 26619, url, state: 'OPEN', baseRefName: 'main', headRefOid: 'a'.repeat(40) }),
    };
    const pending = await run(['tasks', 'adopt-pr', '26619', '--card', card.id], deps);
    expect(pending.code).toBe(1);
    expect(readTaskCard(card.id, path)?.taLand).toBeUndefined();
    appendRunLedgerEntry({ runId: 'run-child', event: 'run-status', data: { runStatus: 'completed' } }, ledgerDir);
    const promoted = await run(['tasks', 'adopt-pr', '26619', '--card', card.id, '--json'], deps);
    expect(promoted.code ?? 0).toBe(0);
    expect(JSON.parse(promoted.lines[0]!).changed).toBe(true);
    const bound = readTaskCard(card.id, path)!;
    expect(bound.taLand).toBe(true);
    expect(bound.adoptedPr?.pr).toBe(26619);
    expect(rejudgeCandidates({ [card.id]: bound })).toEqual([card.id]);
    writeTaskCards(path, [{ ...card, pr: { number: 26619, url: `${url}/wrong` } }]);
    const wrongUrl = await run(['tasks', 'adopt-pr', '26619', '--card', card.id], deps);
    expect(wrongUrl.code).toBe(1);
    expect(readTaskCard(card.id, path)?.taLand).toBeUndefined();
    writeTaskCards(path, [card]);
    const racedBinding = await run(['tasks', 'adopt-pr', '26619', '--card', card.id], { ...deps,
      adoptRunTerminal: () => {
        writeTaskCards(path, [{ ...card, pr: { number: 26620, url: url.replace('26619', '26620') } }]);
        return true;
      },
    });
    expect(racedBinding.code).toBe(1);
    expect(readTaskCard(card.id, path)?.taLand).toBeUndefined();
    writeTaskCards(path, [card]);
    rmSync(ledgerDir, { recursive: true, force: true });
    appendRunLedgerEntry({ runId: 'run-parent', event: 'pod-child-run', data: { childRunId: 'run-child' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-child', event: 'run-status', data: { runStatus: 'completed' } }, ledgerDir);
    const unlinked = await run(['tasks', 'adopt-pr', '26619', '--card', card.id, '--unlinked-terminal'], deps);
    expect(unlinked.code).toBe(1);
    expect(unlinked.lines[0]).toContain('--unlinked-terminal');
    expect(readTaskCard(card.id, path)?.taLand).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('adoption of a launched run requires the exact child PR and terminal status', () => {
  const pr = { number: 80, url: 'https://github.com/ElanvitalAI/elanous/pull/80', state: 'OPEN', baseRefName: 'main', headRefOid: 'b'.repeat(40) };
  const card: TaskCard = { id: 'ta-running', text: 'work', checklistId: 'CELL', createdAt: '2026-10-13T00:00:00Z', status: 'launched', history: [], runId: 'run-parent' };
  const parent: RunLedgerEntry[] = [{ runId: 'run-parent', timestamp: '', event: 'pod-child-run', data: { childRunId: 'run-child' } }];
  const child: RunLedgerEntry[] = [{ runId: 'run-child', timestamp: '', event: 'pr-opened', data: { number: 80, url: pr.url } }];
  const load = (id: string) => id === 'run-parent' ? parent : child;
  expect(adoptedRunTerminal(card, pr, load as Parameters<typeof adoptedRunTerminal>[2])).toBe(false);
  expect(adoptedRunTerminal({ ...card, runId: undefined, launchId: 'tl-pending' }, pr, load as Parameters<typeof adoptedRunTerminal>[2])).toBe(false);
  child.push({ runId: 'run-child', timestamp: '', event: 'run-status', data: { runStatus: 'completed' } });
  expect(adoptedRunTerminal(card, pr, load as Parameters<typeof adoptedRunTerminal>[2])).toBe(true);
  expect(adoptedRunTerminal(card, { ...pr, number: 81, url: pr.url.replace('/80', '/81') }, load as Parameters<typeof adoptedRunTerminal>[2])).toBe(false);
  child.push({ runId: 'run-child', timestamp: '', event: 'run-status', data: { runStatus: 'running' } });
  expect(adoptedRunTerminal(card, pr, load as Parameters<typeof adoptedRunTerminal>[2])).toBe(false);
  child.splice(0, child.length, { runId: 'run-child', timestamp: '', event: 'run-status', data: { runStatus: 'completed' } },
    { runId: 'run-child', timestamp: '', event: 'pr-opened', data: { number: 80, url: pr.url } });
  expect(adoptedRunTerminal(card, pr, load as Parameters<typeof adoptedRunTerminal>[2])).toBe(false);
  child.splice(0, child.length, { runId: 'run-child', timestamp: '', event: 'run-status', data: { runStatus: 'completed' } });
  expect(adoptedRunTerminal(card, pr, load as Parameters<typeof adoptedRunTerminal>[2])).toBe(false);
  expect(adoptedRunTerminal(card, pr, load as Parameters<typeof adoptedRunTerminal>[2], true)).toBe(true);
  child.push({ runId: 'run-child', timestamp: '', event: 'run-status', data: { runStatus: 'running' } });
  expect(adoptedRunTerminal(card, pr, load as Parameters<typeof adoptedRunTerminal>[2], true)).toBe(false);
  const siblingParent: RunLedgerEntry[] = [...parent, { runId: 'run-parent', timestamp: '', event: 'pod-child-run', data: { childRunId: 'run-sibling' } }];
  const stoppedChild: RunLedgerEntry[] = [{ runId: 'run-child', timestamp: '', event: 'pr-opened', data: { number: 80, url: pr.url } },
    { runId: 'run-child', timestamp: '', event: 'run-status', data: { runStatus: 'completed' } }];
  const runningSibling: RunLedgerEntry[] = [{ runId: 'run-sibling', timestamp: '', event: 'pr-opened', data: { number: 80, url: pr.url } },
    { runId: 'run-sibling', timestamp: '', event: 'run-status', data: { runStatus: 'running' } }];
  const siblings = (id: string) => id === 'run-parent' ? siblingParent : id === 'run-child' ? stoppedChild : runningSibling;
  expect(adoptedRunTerminal(card, pr, siblings as Parameters<typeof adoptedRunTerminal>[2])).toBe(false);
  runningSibling[1] = { runId: 'run-sibling', timestamp: '', event: 'run-status', data: { runStatus: 'completed' } };
  expect(adoptedRunTerminal(card, pr, siblings as Parameters<typeof adoptedRunTerminal>[2])).toBe(false);
});
const tasks = [
  { id: 'low', title: 'Low task', status: 'backlog', priority: 'low', createdAt: 1, approval: { state: 'pending' }, generatedBy: { kind: 'external', provider: 'linear', ref: 'L-1' } },
  { id: 'urgent', title: 'Urgent task', status: 'backlog', priority: 'urgent', createdAt: 4, approval: { state: 'pending' }, generatedBy: { kind: 'external', provider: 'linear', ref: 'L-4' } },
  { id: 'medium', title: 'Medium task', status: 'ready', priority: 'medium', createdAt: 3, approval: { state: 'approved' }, generatedBy: { kind: 'external', provider: 'github', ref: 'G-3' } },
  { id: 'high', title: 'High task', status: 'backlog', priority: 'high', createdAt: 2, approval: { state: 'pending' }, generatedBy: { kind: 'external', provider: 'linear', ref: 'L-2' } },
];

function nexus() {
  const requests: Array<{ path: string; method: string; authorization: string | null }> = [];
  const fetchNexus = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push({ path: url.pathname, method, authorization: new Headers(init?.headers).get('Authorization') });
    if (url.pathname === '/v1/tasks') return Response.json({ summary: { total: 4 }, tasks: tasks.map(({ id, title, priority, status, createdAt }) => ({ id, title, priority, status, createdAt })) });
    const id = decodeURIComponent(url.pathname.slice('/v1/tasks/'.length).replace(/\/approve$/, ''));
    if (method === 'POST' && id === 'b') return Response.json({ error: 'conflict', reason: 'not pending' }, { status: 409 });
    const task = tasks.find((row) => row.id === id);
    if (!task) return Response.json({ error: 'not_found' }, { status: 404 });
    if (method === 'POST') return Response.json({ taskId: id, status: 'ready', approval: { state: 'approved' } });
    return Response.json({ task, executions: [], events: [] });
  };
  return { requests, fetchNexus: fetchNexus as typeof fetch };
}

async function run(args: string[], deps: TasksCliDeps, readRealGoalLedgers = false): Promise<{ lines: string[]; code: number | undefined }> {
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, {
    ...(args.includes('cover') && !readRealGoalLedgers ? { coverGoalAsks: () => [], coverGoalRuns: () => [] } : {}),
    ...deps, output: (line) => lines.push(line),
  });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', ...args]);
    return { lines, code: process.exitCode };
  } finally { process.exitCode = previous ?? 0; }
}

test('tasks cover --json reads two filtered log sources and measures land without inventing other denominators', async () => {
  const queries: Array<{ exactCategories?: string[]; events?: string[]; sinceMs?: number; untilMs?: number }> = [];
  const since = '2026-10-01T00:00:00Z';
  const until = '2026-10-08T00:00:00Z';
  const result = await run(['tasks', 'cover', '--since', since, '--until', until, '--json'], {
    coverLogs: (query) => {
      queries.push(query);
      const payloads = query.events?.[0] === 'action'
        ? [{ kind: 'land', result: 'done', taskId: 'ta-land' }, { kind: 'review', result: 'done' }, { kind: 'review', result: 'done' }, { kind: 'land', result: 'failed' }]
        : query.events?.[0] === 'step' ? [...Array.from({ length: 4 }, () => ({ step: 'merge', ok: true })), { step: 'merge', ok: false }] : [];
      return payloads.map((data) => ({ category: query.exactCategories![0], event: query.events![0], data: JSON.stringify(data) }) as LogStoreRow);
    },
  });
  expect(result.code ?? 0).toBe(0);
  expect(queries.map((query) => [query.exactCategories, query.events, query.sinceMs, query.untilMs])).toEqual([
    [['task-agent'], ['action'], Date.parse(since), Date.parse(until)],
    [['pr.land'], ['step'], Date.parse(since), Date.parse(until)],
    [['task-agent'], ['live-move'], Date.parse(since), Date.parse(until)],
    [['task-agent.land-order'], ['appended'], Date.parse(since), Date.parse(until)],
  ]);
  expect(JSON.parse(result.lines[0]!).rows).toContainEqual({ verb: 'land', byTaskAgent: 1, total: 4, observedActions: 2, ratio: 0.25, state: 'measured', liveActions: 2, shadowActions: 0, stewardTransition: 'observed' });
  expect(JSON.parse(result.lines[0]!).rows[1]).toEqual({ verb: 'review', byTaskAgent: 2, total: null, observedActions: 2, ratio: null, state: 'no-denominator', liveActions: 2, shadowActions: 0, stewardTransition: 'unmeasured' });
  expect(JSON.parse(result.lines[0]!).sevenVerbs.verbs[4]).toEqual({ verb: '저작', source: 'goal-ask+goal-run', liveDone: 0, shadow: 0, state: 'none' });
});

test('tasks cover reads prod by default and includes test stores only by explicit flag', async () => {
  const scopes: boolean[] = [];
  const coverLogs: NonNullable<TasksCliDeps['coverLogs']> = (query, includeTest) => {
    scopes.push(includeTest === true);
    const category = query.exactCategories![0]!;
    const event = query.events![0]!;
    const data = event === 'action' ? { kind: 'land', result: 'done', taskId: 'ta-land' } : { step: 'merge', ok: true };
    const row = { category, event, data: JSON.stringify(data) } as LogStoreRow;
    return event === 'action' || event === 'step' ? includeTest ? [row, row] : [row] : [];
  };
  const prod = await run(['tasks', 'cover', '--json'], { coverLogs });
  const withTest = await run(['tasks', 'cover', '--include-test', '--json'], { coverLogs });
  expect(scopes).toEqual([false, false, false, false, true, true, true, true]);
  expect(JSON.parse(prod.lines[0]!).rows[0]).toMatchObject({ byTaskAgent: 1, total: 1, state: 'measured' });
  expect(JSON.parse(withTest.lines[0]!).rows[0]).toMatchObject({ byTaskAgent: 1, total: 2, state: 'measured' });
});

test('tasks cover counts prod live-move and land-order attempts without treating skipped moves as landings', async () => {
  const card = 'ta-20261012-44c03a';
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query, includeTest) => {
      expect(includeTest).toBe(false);
      const category = query.exactCategories?.[0];
      const event = query.events?.[0];
      const data = category === 'task-agent' && event === 'live-move'
        ? { kind: 'land', card, executed: false, ok: true, live: true }
        : category === 'task-agent.land-order' && event === 'appended'
          ? { pr: 26931, head: '8fac058df29caa79aa57d1319a93106ff059cf57' }
          : null;
      return data === null ? [] : [{ category, event, data: JSON.stringify(data) } as LogStoreRow];
    },
  });
  const body = JSON.parse(result.lines[0]!);
  expect(body.landSignals).toEqual({ liveMoveEvents: 1, executedLiveMoves: 0, landOrderEvents: 1 });
  expect(body.rows[0]).toMatchObject({ byTaskAgent: 0, total: 0, state: 'no-denominator' });
});

test('tasks cover counts the successful land executor event in the measured numerator', async () => {
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => {
      const category = query.exactCategories?.[0];
      const event = query.events?.[0];
      const data = category === 'task-agent' && event === 'live-move'
        ? { kind: 'land', card: 'ta-20261012-44c03a', executed: true, ok: true }
        : category === 'pr.land' && event === 'step' ? { step: 'merge', ok: true } : null;
      return data === null ? [] : [{ category, event, data: JSON.stringify(data) } as LogStoreRow];
    },
  });
  const body = JSON.parse(result.lines[0]!);
  expect(body.rows[0]).toMatchObject({ byTaskAgent: 1, total: 1, ratio: 1, state: 'measured', observedActions: 0, liveActions: 0 });
  expect(body.sevenVerbs.verbs[1]).toMatchObject({ verb: '착지', liveDone: 1, state: 'live' });
  expect(body.landSignals).toEqual({ liveMoveEvents: 1, executedLiveMoves: 1, landOrderEvents: 0 });
});

test('tasks cover does not assert a land ratio when live-move source is unreadable or bounded', async () => {
  const row = (category: string, event: string, data: object) =>
    ({ category, event, data: JSON.stringify(data) }) as LogStoreRow;
  const read = (bounded: boolean) => run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => {
      const category = query.exactCategories![0]!;
      const event = query.events![0]!;
      if (event === 'live-move') {
        if (!bounded) throw new Error('store unreadable');
        return { rows: [row(category, event, { kind: 'land', card: 'ta-land', executed: true, ok: true })],
          limitReached: true, unreadableStores: 0, storesRead: 1 };
      }
      return event === 'step' ? [row(category, event, { step: 'merge', ok: true })] : [];
    },
  });
  for (const bounded of [false, true]) {
    const body = JSON.parse((await read(bounded)).lines[0]!);
    expect(body.rows[0]).toMatchObject({ byTaskAgent: null, total: 1, ratio: null, state: 'unreadable' });
    expect(body.sevenVerbs.verbs[1]).toMatchObject({ liveDone: null, state: 'unreadable' });
    expect(body.limitReached).toBe(bounded);
  }
});

test('tasks cover marks a successful live-move without card identity unreadable', async () => {
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => {
      const category = query.exactCategories![0]!;
      const event = query.events![0]!;
      const data = event === 'live-move' ? { kind: 'land', executed: true, ok: true }
        : event === 'step' ? { step: 'merge', ok: true } : null;
      return data === null ? [] : [{ category, event, data: JSON.stringify(data) } as LogStoreRow];
    },
  });
  const body = JSON.parse(result.lines[0]!);
  expect(body.rows[0]).toMatchObject({ byTaskAgent: null, total: 1, state: 'unreadable', ratio: null });
  expect(body.sevenVerbs.verbs[1]).toMatchObject({ liveDone: null, state: 'unreadable' });
});

test('tasks cover treats missing or invalid live-move outcome as unreadable', async () => {
  for (const move of [
    { kind: 'land', card: 'ta-land', executed: true },
    { kind: 'land', card: 'ta-land', executed: true, ok: 'unknown' },
    { kind: 'land', card: 'ta-land', ok: true },
    { kind: 'land', card: 'ta-land', executed: false },
    { kind: 'land', executed: false, ok: true },
    { kind: 'land', executed: true, ok: false },
    { card: 'ta-land', executed: true, ok: true },
  ]) {
    const result = await run(['tasks', 'cover', '--json'], {
      coverLogs: (query) => {
        const category = query.exactCategories![0]!;
        const event = query.events![0]!;
        const data = event === 'live-move' ? move : event === 'step' ? { step: 'merge', ok: true } : null;
        return data === null ? [] : [{ category, event, data: JSON.stringify(data) } as LogStoreRow];
      },
    });
    const body = JSON.parse(result.lines[0]!);
    expect(body.rows[0]).toMatchObject({ byTaskAgent: null, total: 1, state: 'unreadable', ratio: null });
    expect(body.landSignals.liveMoveEvents).toBeNull();
  }
});

test('tasks cover does not drop invalid JSON from its land-move source', async () => {
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => {
      const category = query.exactCategories![0]!;
      const event = query.events![0]!;
      return event === 'live-move' ? [{ category, event, data: '{broken' } as LogStoreRow]
        : event === 'step' ? [{ category, event, data: JSON.stringify({ step: 'merge', ok: true }) } as LogStoreRow] : [];
    },
  });
  expect(JSON.parse(result.lines[0]!).rows[0]).toMatchObject({ byTaskAgent: null, total: 1, state: 'unreadable' });
});

test('tasks cover marks incomplete or corrupt land-action records unreadable', async () => {
  for (const data of [
    JSON.stringify({ kind: 'land', taskId: 'ta-land' }),
    JSON.stringify({ kind: 'land', result: 'done' }),
    '{broken',
  ]) {
    const result = await run(['tasks', 'cover', '--json'], {
      coverLogs: (query) => {
        const category = query.exactCategories![0]!;
        const event = query.events![0]!;
        return event === 'action' ? [{ category, event, data } as LogStoreRow]
          : event === 'step' ? [{ category, event, data: JSON.stringify({ step: 'merge', ok: true }) } as LogStoreRow] : [];
      },
    });
    expect(JSON.parse(result.lines[0]!).rows[0]).toMatchObject({ byTaskAgent: null, total: 1, state: 'unreadable' });
  }
});

test('tasks cover does not use a malformed merge-step denominator', async () => {
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => {
      const category = query.exactCategories![0]!;
      const event = query.events![0]!;
      return event === 'step' ? [{ category, event, data: '{broken' } as LogStoreRow] : [];
    },
  });
  expect(JSON.parse(result.lines[0]!).rows[0]).toMatchObject({ byTaskAgent: 0, total: null, state: 'unreadable' });
});

test('tasks cover --lines uses the one-line formatter on the read-only observation path', async () => {
  const queries: string[] = [];
  const result = await run(['tasks', 'cover', '--lines'], { coverImplementCardRuns: () => [], coverImplementRunMerges: () => new Map(), coverLogs: (query) => {
    queries.push(query.exactCategories![0]!);
    const data = query.events?.[0] === 'action'
      ? [{ kind: 'land', result: 'done', taskId: 'ta-land' }, { kind: 'land', result: 'shadow' }, { kind: 'review', result: 'shadow' }]
      : query.events?.[0] === 'step' ? [{ step: 'merge', ok: true }, { step: 'merge', ok: true }] : [];
    return data.map((item) => ({ category: query.exactCategories![0], event: query.events![0], data: JSON.stringify(item) }) as LogStoreRow);
  } });
  expect(result.code ?? 0).toBe(0);
  expect(queries).toEqual(['task-agent', 'pr.land', 'task-agent', 'task-agent.land-order']);
  expect(result.lines).toEqual([
    'land: TA 1/2 (50.0%) · live 1 · shadow 1 · steward-transition observed',
    'review: TA 0/- (-) · live 0 · shadow 1 · steward-transition unmeasured',
    'retry: TA 0/- (-) · live 0 · shadow 0 · steward-transition unmeasured',
    'green: TA 0/- (-) · live 0 · shadow 0 · steward-transition unmeasured',
    '7동사 live 1/7 · 출처 없음 정리',
    '착지 시도 관측: live-move 0 · 집행 0 · land-order 0 (병합 수와 별개)',
  ]);
});

test('tasks cover reports unreadable sources and rejects an inverted window without querying', async () => {
  const result = await run(['tasks', 'cover'], { coverLogs: (query) => {
    if (query.exactCategories?.[0] === 'pr.land') throw new Error('unavailable');
    return [];
  } });
  expect(result.lines).toContain('land\t0\t-\t-\tunreadable\t0');
  const unknown = await run(['tasks', 'cover'], { coverLogs: (query) => {
    if (query.exactCategories?.[0] === 'task-agent') throw new Error('unavailable');
    return [];
  } });
  expect(unknown.lines).toContain('land\t-\t0\t-\tunreadable\t-');
  expect(unknown.lines).toContain('review\t-\t-\t-\tunreadable\t-');
  const unknownJson = await run(['tasks', 'cover', '--json'], { coverLogs: (query) => {
    if (query.exactCategories?.[0] === 'task-agent') throw new Error('unavailable');
    return [];
  } });
  expect(JSON.parse(unknownJson.lines[0]!).rows[0]).toMatchObject({ byTaskAgent: null, observedActions: null, state: 'unreadable' });
  expect(result.lines[0]).toBe('동사\t대신\t전체\t비율\t상태\t관측 사건');
  let calls = 0;
  const invalid = await run(['tasks', 'cover', '--since', '2026-10-09T00:00:00Z', '--until', '2026-10-08T00:00:00Z'], {
    coverLogs: () => { calls++; return []; },
  });
  expect(invalid.code).toBe(1);
  expect(calls).toBe(0);
});

test('tasks cover --json keeps a single JSON result and declares when a source reaches its query bound', async () => {
  const action = { category: 'task-agent', event: 'action', data: JSON.stringify({ kind: 'review', result: 'done' }) } as LogStoreRow;
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => query.exactCategories?.[0] === 'task-agent' ? Array(100_000).fill(action) : [],
  });
  expect(result.lines).toHaveLength(1);
  const body = JSON.parse(result.lines[0]!);
  expect(body.limitReached).toBe(true);
  expect(body.warning).toContain('상한 100000 도달');
  expect(body.rows[0]).toMatchObject({ verb: 'land', state: 'unreadable', ratio: null });
  expect(body.rows[1]).toMatchObject({ verb: 'review', byTaskAgent: null, total: null, observedActions: null, state: 'unreadable' });
});

test('tasks cover marks land unknown when a bounded merge query has successful merges', async () => {
  const action = { category: 'task-agent', event: 'action', data: JSON.stringify({ kind: 'land', result: 'done', taskId: 'ta-land' }) } as LogStoreRow;
  const merge = { category: 'pr.land', event: 'step', data: JSON.stringify({ step: 'merge', ok: true }) } as LogStoreRow;
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => query.exactCategories?.[0] === 'task-agent' ? [action] : Array(100_000).fill(merge),
  });
  const body = JSON.parse(result.lines[0]!);
  expect(body.limitReached).toBe(true);
  expect(body.rows[0]).toMatchObject({ verb: 'land', byTaskAgent: 1, total: null, ratio: null, state: 'unreadable' });
});

test('tasks cover --json takes a federated read and says how many stores it could not read', async () => {
  const action = { category: 'task-agent', event: 'action', data: JSON.stringify({ kind: 'land', result: 'done', taskId: 'ta-land' }) } as LogStoreRow;
  const merge = { category: 'pr.land', event: 'step', data: JSON.stringify({ step: 'merge', ok: true }) } as LogStoreRow;
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => ({
      rows: query.exactCategories?.[0] === 'task-agent' ? [action] : [merge, merge, merge, merge],
      limitReached: false, unreadableStores: 2, storesRead: 5,
    }),
  });
  const body = JSON.parse(result.lines[0]!);
  expect(body.rows[0]).toEqual({ verb: 'land', byTaskAgent: 1, total: 4, observedActions: 1, ratio: 0.25, state: 'measured', liveActions: 1, shadowActions: 0, stewardTransition: 'observed' });
  expect(body.unreadableStores).toBe(2);
  expect(body.storeWarning).toContain('2개를 못 읽었다');
});

test('tasks cover --json includes the seven-verb live measurement', async () => {
  const action = (kind: string, result: string) => ({ category: 'task-agent', event: 'action', data: JSON.stringify({ kind, result, ...(kind === 'land' ? { taskId: 'ta-land' } : {}) }) }) as LogStoreRow;
  const merge = { category: 'pr.land', event: 'step', data: JSON.stringify({ step: 'merge', ok: true }) } as LogStoreRow;
  const result = await run(['tasks', 'cover', '--json'], {
    coverImplementCardRuns: () => [], coverImplementRunMerges: () => new Map(),
    coverLogs: (query) => query.exactCategories?.[0] === 'task-agent'
      ? [action('review', 'done'), action('land', 'done'), action('retry', 'shadow')]
      : [merge],
  });
  const body = JSON.parse(result.lines[0]!);
  expect(body.sevenVerbs).toEqual({
    verbs: [
      { verb: '리뷰', source: 'review', liveDone: 1, shadow: 0, state: 'live' },
      { verb: '착지', source: 'land', liveDone: 1, shadow: 0, state: 'live' },
      { verb: '수리', source: 'retry', liveDone: 0, shadow: 1, state: 'shadow-only' },
      { verb: '검증', source: 'green', liveDone: 0, shadow: 0, state: 'none' },
      { verb: '저작', source: 'goal-ask+goal-run', liveDone: 0, shadow: 0, state: 'none' },
      { verb: '구현', source: 'card-run+merged', liveDone: 0, shadow: 0, state: 'none' },
      { verb: '정리', source: null, liveDone: null, shadow: null, state: 'no-source' },
    ],
    liveVerbs: 2,
    measuredVerbs: 6,
  });
});

test('tasks cover joins bound card runs to merged run-ledger events for the 구현 verb', async () => {
  const action = (kind: string, result: string) => ({ category: 'task-agent', event: 'action', data: JSON.stringify({ kind, result, ...(kind === 'land' ? { taskId: 'ta-land' } : {}) }) }) as LogStoreRow;
  const merge = { category: 'pr.land', event: 'step', data: JSON.stringify({ step: 'merge', ok: true }) } as LogStoreRow;
  const coverLogs: NonNullable<TasksCliDeps['coverLogs']> = (query) => query.exactCategories?.[0] === 'task-agent'
    ? [action('review', 'done')]
    : [merge];
  const deps: TasksCliDeps = {
    coverLogs,
    coverImplementCardRuns: () => [
      { cardId: 'c-merged', runId: 'run-merged' },
      { cardId: 'c-merged', runId: 'run-merged' },
      { cardId: 'c-failed', runId: 'run-failed' },
      { cardId: 'c-child', runId: 'run-parent', runChildId: 'run-child' },
    ],
    coverImplementRunMerges: () => new Map([
      ['run-merged', { merged: true }],
      ['run-child', { merged: true }],
      ['run-failed', { merged: false }],
      ['run-unrelated', { merged: true }],
    ]),
  };
  const result = await run(['tasks', 'cover', '--json'], deps);
  const body = JSON.parse(result.lines[0]!);
  expect(body.sevenVerbs.verbs[5]).toEqual({ verb: '구현', source: 'card-run+merged', liveDone: 2, shadow: 0, state: 'live' });
  expect(body.sevenVerbs.measuredVerbs).toBe(6);
  expect(body.sevenVerbs.liveVerbs).toBe(2);
  const lines = await run(['tasks', 'cover', '--lines'], deps);
  expect(lines.lines).toContain('7동사 live 2/7 · 출처 없음 정리');
  // 런 원장을 못 읽으면 구현만 unreadable — 전체 liveVerbs 는 null(0 으로 읽히지 않게).
  const unreadable = await run(['tasks', 'cover', '--json'], { ...deps, coverImplementRunMerges: () => null });
  expect(JSON.parse(unreadable.lines[0]!).sevenVerbs.verbs[5]).toEqual({ verb: '구현', source: 'card-run+merged', liveDone: null, shadow: null, state: 'unreadable' });
  expect(JSON.parse(unreadable.lines[0]!).sevenVerbs.liveVerbs).toBeNull();
  const unreadableLines = await run(['tasks', 'cover', '--lines'], { ...deps, coverImplementRunMerges: () => null });
  expect(unreadableLines.lines).toContain('7동사 live -/7 · 못 잼(구현 카드·런 원장 null·절단) · 출처 없음 정리');
  // 카드 원장을 못 읽어도 같은 unreadable — 심 하나만 주어진 반쪽 배선도 못 읽은 것이다.
  const cardsUnreadable = await run(['tasks', 'cover', '--json'], { ...deps, coverImplementCardRuns: () => null });
  expect(JSON.parse(cardsUnreadable.lines[0]!).sevenVerbs.verbs[5]).toMatchObject({ source: 'card-run+merged', liveDone: null, state: 'unreadable' });
  // 심이 던지면 null 로 못 읽은 것이다(측정이 깨지지 않게).
  const thrown = await run(['tasks', 'cover', '--json'], { ...deps, coverImplementRunMerges: () => { throw new Error('ledger unreadable'); } });
  expect(JSON.parse(thrown.lines[0]!).sevenVerbs.verbs[5]).toMatchObject({ source: 'card-run+merged', liveDone: null, state: 'unreadable' });
});

test('tasks cover default 구현 readers join physical task-agent-actions.json and run ledgers in the merge window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cover-implement-ledgers-'));
  const statePath = join(root, 'task-agent-actions.json');
  const ledgerDir = join(root, 'run-ledger');
  const mirrorDir = join(root, 'remote-parents', 'pod-1', 'run-ledger');
  mkdirSync(ledgerDir);
  mkdirSync(mirrorDir, { recursive: true });
  const runId = (suffix: string) => `run-00000000-0000-4000-8000-0000000000${suffix}`;
  const merged = runId('01');
  const failed = runId('02');
  const child = runId('03');
  const outside = runId('04');
  const unrelated = runId('05');
  const parent = runId('06');
  const split = runId('07');
  const card = (id: string, boundRun: string, boundChild?: string): TaskCard => ({
    id, text: id, createdAt: '2026-10-01T00:00:00.000Z', status: 'launched', history: [],
    runId: boundRun, ...(boundChild ? { runChildId: boundChild } : {}),
  });
  const writeLedger = (id: string, timestamp: string, succeeded: boolean, directory = ledgerDir) =>
    writeFileSync(join(directory, `${id}.jsonl`), `${JSON.stringify({ timestamp, runId: id, event: 'merged', data: { merged: succeeded } })}\n`);
  try {
    writeTaskCards(statePath, [
      card('ta-merged', merged), card('ta-failed', failed),
      card('ta-child', parent, child), card('ta-outside', outside), card('ta-split', split),
    ]);
    writeLedger(merged, '2026-10-11T10:00:00.000Z', true);
    writeLedger(failed, '2026-10-11T10:00:00.000Z', false);
    writeFileSync(join(ledgerDir, `${parent}.jsonl`),
      `${JSON.stringify({ timestamp: '2026-10-10T10:00:00.000Z', runId: parent, event: 'start', data: {} })}\n`);
    writeLedger(child, '2026-10-11T11:00:00.000Z', true);
    writeLedger(outside, '2026-10-13T10:00:00.000Z', true);
    writeLedger(unrelated, '2026-10-11T10:00:00.000Z', true);
    writeFileSync(join(ledgerDir, `${split}.jsonl`),
      `${JSON.stringify({ timestamp: '2026-10-10T09:00:00.000Z', runId: split, event: 'start', data: {} })}\n`);
    writeLedger(split, '2026-10-11T12:00:00.000Z', true, mirrorDir);
    const deps: TasksCliDeps = {
      taskStatePath: statePath,
      coverLogs: () => [],
    };
    // No coverImplementCardRuns or coverImplementRunMerges seam is supplied.
    const observed = await run(['tasks', 'cover', '--since', '2026-10-10T00:00:00Z', '--until', '2026-10-12T00:00:00Z', '--json'], deps);
    expect(observed.code ?? 0).toBe(0);
    const live = JSON.parse(observed.lines[0]!).sevenVerbs;
    expect(live.verbs[5]).toEqual({ verb: '구현', source: 'card-run+merged', liveDone: 3, shadow: 0, state: 'live' });
    expect(live.measuredVerbs).toBe(6);

    writeFileSync(join(ledgerDir, `${child}.jsonl`), '{broken}\n');
    const unreadable = await run(['tasks', 'cover', '--json'], deps);
    expect(JSON.parse(unreadable.lines[0]!).sevenVerbs.verbs[5]).toMatchObject({
      source: 'card-run+merged', liveDone: null, state: 'unreadable',
    });
    expect(JSON.parse(unreadable.lines[0]!).sevenVerbs.liveVerbs).toBeNull();
    rmSync(join(ledgerDir, `${child}.jsonl`));
    const missingRun = await run(['tasks', 'cover', '--json'], deps);
    expect(JSON.parse(missingRun.lines[0]!).sevenVerbs.verbs[5]).toMatchObject({
      source: 'card-run+merged', liveDone: null, state: 'unreadable',
    });
    rmSync(statePath);
    const missingCards = await run(['tasks', 'cover', '--json'], deps);
    expect(JSON.parse(missingCards.lines[0]!).sevenVerbs.verbs[5]).toMatchObject({
      source: 'card-run+merged', liveDone: null, state: 'unreadable',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tasks cover joins authored goal provenance to merged goal records inside the window', async () => {
  const since = '2026-10-10T00:00:00Z';
  const until = '2026-10-12T00:00:00Z';
  const asks = [
    { authorRunId: 'a1', goalId: 'g1', createdAt: '2026-10-01T00:00:00Z' },
    { authorRunId: 'a2', goalId: 'g2', createdAt: since },
    { authorRunId: 'a3', goalId: 'g3', createdAt: since },
  ];
  const runs = [
    { goalId: 'g1', stage: 'merged', outcome: 'completed', startedAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-11T00:00:00Z' },
    { goalId: 'g2', stage: 'failed', outcome: 'abandoned', startedAt: since, completedAt: '2026-10-11T00:00:00Z' },
    { goalId: 'g3', stage: 'merged', outcome: 'completed', startedAt: since, completedAt: '2026-10-13T00:00:00Z' },
  ];
  const coverLogs: NonNullable<TasksCliDeps['coverLogs']> = (query) => query.exactCategories?.[0] === 'task-agent'
    ? ['review', 'land', 'retry', 'green'].map((kind) => ({ category: 'task-agent', event: 'action', data: JSON.stringify({ kind, result: 'done', taskId: 'ta-land' }) } as LogStoreRow))
    : [];
  const deps = { coverLogs, coverGoalAsks: () => asks, coverGoalRuns: () => runs,
    coverImplementCardRuns: () => [], coverImplementRunMerges: () => new Map() };
  const result = await run(['tasks', 'cover', '--json', '--since', since, '--until', until], deps);
  const body = JSON.parse(result.lines[0]!);
  expect(body.sevenVerbs.verbs[4]).toEqual({ verb: '저작', source: 'goal-ask+goal-run', liveDone: 1, shadow: 0, state: 'live' });
  expect(body.sevenVerbs.liveVerbs).toBe(5);
  expect(body.rows[1]).toMatchObject({ verb: 'review', byTaskAgent: 1 });
  const lines = await run(['tasks', 'cover', '--lines', '--since', since, '--until', until], deps);
  expect(lines.lines.at(-2)).toBe('7동사 live 5/7 · 출처 없음 정리');
  const dangling = await run(['tasks', 'cover', '--json', '--since', since], { ...deps, coverGoalAsks: () => asks.filter((ask) => ask.goalId === 'g2') });
  expect(JSON.parse(dangling.lines[0]!).sevenVerbs.verbs[4]).toMatchObject({ liveDone: 0, state: 'none' });
  const missingRun = await run(['tasks', 'cover', '--json', '--since', since], { ...deps, coverGoalRuns: () => [] });
  expect(JSON.parse(missingRun.lines[0]!).sevenVerbs.verbs[4]).toMatchObject({ liveDone: 0, state: 'none' });
  const lateMerge = await run(['tasks', 'cover', '--json', '--since', since, '--until', until], {
    ...deps, coverGoalAsks: () => asks.filter((ask) => ask.goalId === 'g3'),
  });
  expect(JSON.parse(lateMerge.lines[0]!).sevenVerbs.verbs[4]).toMatchObject({ liveDone: 0, state: 'none' });
  const undatedMerge = await run(['tasks', 'cover', '--json', '--since', since, '--until', until], {
    ...deps, coverGoalRuns: () => [{ goalId: 'g1', stage: 'merged', outcome: 'completed', startedAt: since }],
  });
  expect(JSON.parse(undatedMerge.lines[0]!).sevenVerbs.verbs[4]).toMatchObject({ liveDone: null, state: 'unreadable' });
  const unrelatedUndated = await run(['tasks', 'cover', '--json', '--since', since, '--until', until], {
    ...deps, coverGoalRuns: () => [...runs, { goalId: 'unrelated', stage: 'merged', outcome: 'completed', startedAt: since }],
  });
  expect(JSON.parse(unrelatedUndated.lines[0]!).sevenVerbs.verbs[4]).toMatchObject({ liveDone: 1, state: 'live' });
  for (const broken of [{ coverGoalAsks: () => null }, { coverGoalRuns: () => { throw new Error('unreadable'); } }]) {
    const unknown = await run(['tasks', 'cover', '--json'], { ...deps, ...broken });
    expect(JSON.parse(unknown.lines[0]!).sevenVerbs).toMatchObject({ liveVerbs: null, verbs: expect.arrayContaining([{ verb: '저작', source: 'goal-ask+goal-run', liveDone: null, shadow: null, state: 'unreadable' }]) });
  }
});

test('tasks cover default reader joins persisted authoring and completed merged goal records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cover-goal-ledgers-'));
  const goalId = '0123456789abcdef';
  const goalFile = join(dir, 'GOAL-test.md');
  const document = `# Goal\n- GoalId: ${goalId}\n`;
  writeFileSync(goalFile, document);
  setElanousConfigDir(dir);
  try {
    const path = goalRunDbPath();
    const asks = new GoalAskStore(path);
    try {
      expect(asks.insert({ authorRunId: 'author-real', goalFile, ask: 'write goal', document })).toBe(true);
    } finally { asks.close(); }
    const goals = new GoalRunStore(path);
    try {
      goals.insert(goalFile, {
        runId: 'run-real', stage: 'merged', outcome: 'completed', ok: true,
        startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-11T00:00:00Z', rounds: 1,
      }, goalId);
    } finally { goals.close(); }
    const result = await run(['tasks', 'cover', '--json', '--since', '2026-10-10T00:00:00Z', '--until', '2026-10-12T00:00:00Z'], {
      coverLogs: () => [],
    }, true);
    expect(result.code ?? 0).toBe(0);
    expect(JSON.parse(result.lines[0]!).sevenVerbs.verbs[4]).toEqual({
      verb: '저작', source: 'goal-ask+goal-run', liveDone: 1, shadow: 0, state: 'live',
    });
  } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
});

test('tasks cover default reader marks a bounded authoring ledger unreadable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cover-bounded-ledger-'));
  setElanousConfigDir(dir);
  try {
    const path = goalRunDbPath();
    new GoalAskStore(path).close();
    const db = new Database(path);
    try {
      db.run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100001)
        INSERT INTO goal_ask (author_run_id, goal_id, goal_file, ask, created_at)
        SELECT 'author-' || x, 'goal-' || x, 'goal.md', 'ask', '2026-10-11T00:00:00Z' FROM n`);
    } finally { db.close(); }
    const result = await run(['tasks', 'cover', '--json'], { coverLogs: () => [] }, true);
    expect(result.code ?? 0).toBe(0);
    const body = JSON.parse(result.lines[0]!);
    expect(body.limitReached).toBe(true);
    expect(body.sevenVerbs.verbs[4]).toMatchObject({ liveDone: null, state: 'unreadable' });
  } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
});

test('tasks cover --by-card reads the injected card ledger inside the window; without the flag it never calls coverCards', async () => {
  const logs = (query: { exactCategories?: string[]; events?: string[] }) => {
    const payloads = query.exactCategories?.[0] === 'task-agent'
      ? [{ kind: 'review', result: 'done', taskId: 'c1' }, { kind: 'review', result: 'done', taskId: 'c1' }, { kind: 'review', result: 'done', taskId: 'c2' }, { kind: 'review', result: 'done', taskId: 'old' }]
      : [{ step: 'merge', ok: true }];
    return payloads.map((data) => ({ category: query.exactCategories![0], event: query.events![0], data: JSON.stringify(data) }) as LogStoreRow);
  };
  let calls = 0;
  const coverCards = () => {
    calls++;
    return [
      { id: 'c1', createdAt: '2026-10-05T00:00:00.000Z' }, { id: 'c2', createdAt: '2026-10-06T00:00:00.000Z' },
      { id: 'c3', createdAt: '2026-10-07T00:00:00.000Z' }, { id: 'old', createdAt: '2026-09-01T00:00:00.000Z' },
    ];
  };
  const withFlag = await run(['tasks', 'cover', '--by-card', '--json', '--since', '2026-10-01T00:00:00Z'], { coverLogs: logs, coverCards });
  expect(calls).toBe(1);
  expect(JSON.parse(withFlag.lines[0]!).rows[1]).toMatchObject({ verb: 'review', byTaskAgent: 2, total: 3, state: 'measured' });
  expect(JSON.parse(withFlag.lines[0]!).rows[0]).toMatchObject({ verb: 'land', total: 1 });
  const unreadable = await run(['tasks', 'cover', '--by-card', '--json'], { coverLogs: logs, coverCards: () => null });
  expect(JSON.parse(unreadable.lines[0]!).rows[1]).toMatchObject({ verb: 'review', byTaskAgent: null, total: null, state: 'unreadable' });
  calls = 0;
  const plain = await run(['tasks', 'cover', '--json'], { coverLogs: logs, coverCards });
  expect(calls).toBe(0);
  expect(JSON.parse(plain.lines[0]!).rows[1]).toMatchObject({ verb: 'review', total: null, state: 'no-denominator' });
});

test('tasks cover --by-card default reader uses the TA card ledger (ta- ids) — the same ids the task-agent action log carries', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'tasks-cli-cover-ta-')), 'task-agent-actions.json');
  const card = (id: string, createdAt: string): TaskCard => ({ id, text: id, createdAt, status: 'launched', history: [] });
  writeTaskCards(statePath, [card('ta-20261005-aaaaaa', '2026-10-05T00:00:00.000Z'), card('ta-20261006-bbbbbb', '2026-10-06T00:00:00.000Z'), card('ta-20260901-cccccc', '2026-09-01T00:00:00.000Z')]);
  const logs = (query: { exactCategories?: string[]; events?: string[] }) => {
    const payloads = query.exactCategories?.[0] === 'task-agent'
      ? [{ kind: 'review', result: 'done', taskId: 'ta-20261005-aaaaaa' }, { kind: 'review', result: 'done', taskId: 'ta-20260901-cccccc' }]
      : [{ step: 'merge', ok: true }];
    return payloads.map((data) => ({ category: query.exactCategories![0], event: query.events![0], data: JSON.stringify(data) }) as LogStoreRow);
  };
  const out = await run(['tasks', 'cover', '--by-card', '--json', '--since', '2026-10-01T00:00:00Z'], { coverLogs: logs, taskStatePath: statePath });
  expect(JSON.parse(out.lines[0]!).rows[1]).toMatchObject({ verb: 'review', byTaskAgent: 1, total: 2, state: 'measured' });
});

test('task hand inlines a relative multiline goal file and logs the carried sentence exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-goal-'));
  const path = join(dir, 'goal.MD');
  const state = join(dir, 'cards.json');
  const sentence = '대상 경로: src/a.ts\n현재 계약: preserve the text';
  writeFileSync(path, `${sentence}\n`);
  const events: Array<{ event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'goal-file-capture', emit: (rec) => { if (rec.category === 'task-agent.hand') events.push(rec); } });
  try {
    const result = await run(['task', 'hand', relative(process.cwd(), path), '--json'], { taskStatePath: state, registerSink: async () => true });
    expect(result.code ?? 0).toBe(0);
    const output = JSON.parse(result.lines[0]!);
    const commandText = output.move.command.at(-1) as string;
    expect(commandText).toBe(sentence);
    expect(createHash('sha256').update(commandText).digest('hex')).toBe(createHash('sha256').update(sentence).digest('hex'));
    expect(output.card.text).toBe(sentence);
    expect(Object.values(JSON.parse(readFileSync(state, 'utf8')).tasks)).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'goal-file-inlined', data: { path, chars: sentence.length, sha256: createHash('sha256').update(sentence).digest('hex') } });
  } finally { off(); }
});

test('task hand rejects missing, directory, unreadable and empty goal files without writing or launching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-reject-'));
  const paths = [join(dir, 'missing.md'), join(dir, 'folder'), join(dir, 'empty.txt')];
  mkdirSync(paths[1]!);
  writeFileSync(paths[2]!, ' \n ');
  const reasons = ['없다', '디렉터리', '비었다'];
  const events: Array<{ event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'goal-file-reject-capture', emit: (rec) => { if (rec.category === 'task-agent.hand') events.push(rec); } });
  try {
    for (const [index, path] of paths.entries()) {
      const state = join(dir, `cards-${index}.json`);
      let launches = 0;
      const result = await run(['task', 'hand', path, '--live'], { taskStatePath: state, registerSink: async () => true, taskLauncher: () => { launches++; } });
      expect(result.code).toBe(1);
      expect(result.lines.join('\n')).toContain(path);
      expect(result.lines.join('\n')).toContain(reasons[index]!);
      expect(launches).toBe(0);
      expect(existsSync(state) ? Object.keys(JSON.parse(readFileSync(state, 'utf8')).tasks ?? {}) : []).toHaveLength(0);
    }
    expect(events).toHaveLength(paths.length);
    for (const [index, path] of paths.entries()) expect(events[index]).toMatchObject({ event: 'goal-file-rejected', data: { path, reason: reasons[index] } });
  } finally { off(); }
});

test('task hand --checklist uses the unchanged cell title when text is omitted and rejects non-path text before launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-checklist-hand-'));
  const releaseBoard: BoardNode[] = [{ id: 'project', level: 'project', title: 'Project', status: 'open', children: [
    { id: 'cell-1', level: 'task', title: '대상 경로: src/thing.ts\n구현 계약 그대로', status: 'open' },
  ] }];
  const launcherCalls: string[][] = [];
  const deps: TasksCliDeps = {
    taskStatePath: join(dir, 'cards.json'), registerSink: async () => true, releaseBoard: () => releaseBoard,
    taskLauncher: (args) => { launcherCalls.push(args); },
  };

  const omitted = await run(['tasks', 'hand', '--checklist', 'cell-1', '--live', '--json'], deps);
  expect(omitted.code ?? 0).toBe(0);
  expect(JSON.parse(omitted.lines[0]!).move.command.at(-1)).toBe('대상 경로: src/thing.ts\n구현 계약 그대로');
  expect(launcherCalls).toHaveLength(1);
  expect(launcherCalls[0]!.at(-1)).toBe('대상 경로: src/thing.ts\n구현 계약 그대로');

  const valid = await run(['tasks', 'hand', '대상 경로: src/supplied.ts\n세부', '--checklist', 'cell-1', '--live', '--json'], deps);
  expect(valid.code ?? 0).toBe(0);
  expect(JSON.parse(valid.lines[0]!).move.command.at(-1)).toBe('대상 경로: src/supplied.ts\n세부');
  expect(launcherCalls[1]!.at(-1)).toBe('대상 경로: src/supplied.ts\n세부');

  const invalid = await run(['tasks', 'hand', '임의의 문면', '--checklist', 'cell-1', '--live'], deps);
  expect(invalid.code).toBe(1);
  expect(invalid.lines).toEqual(['칸 문면을 쓰려면 문면 인자를 빼라']);
  expect(launcherCalls).toHaveLength(2);
  expect(launcherCalls[0]!.at(-1)).toBe('대상 경로: src/thing.ts\n구현 계약 그대로');

  const project = await run(['tasks', 'hand', '--checklist', 'project', '--live'], deps);
  expect(project.code).toBe(1);
  expect(project.lines).toEqual(['체크리스트 칸 없음: project']);
  expect(launcherCalls).toHaveLength(2);
  const projectWithText = await run(['tasks', 'hand', '대상 경로: src/thing.ts', '--checklist', 'project', '--live'], deps);
  expect(projectWithText.code).toBe(1);
  expect(projectWithText.lines).toEqual(['체크리스트 칸 없음: project']);
  expect(launcherCalls).toHaveLength(2);
});

test('task hand --checklist reads the current release cell through the default board', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-default-checklist-'));
  const title = '대상 경로: src/real.ts\n현재 판 칸 원문';
  setElanousConfigDir(dir);
  try {
    addItem(checklistDevVersion(), { id: 'MK-DEFAULT-BOARD', title });
    const launcherCalls: string[][] = [];
    const result = await run(['tasks', 'hand', '--checklist', 'MK-DEFAULT-BOARD', '--live', '--json'], {
      taskStatePath: join(dir, 'cards.json'), registerSink: async () => true,
      taskLauncher: (args) => { launcherCalls.push(args); },
    });
    expect(result.code ?? 0).toBe(0);
    expect(launcherCalls).toHaveLength(1);
    expect(launcherCalls[0]!.at(-1)).toBe(title);
    expect(JSON.parse(result.lines[0]!).card.text).toBe(title);
  } finally { resetElanousConfigDir(); }
});

test('task hand default board finds an unreleased later version from the isolated checklist ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-later-checklist-'));
  const title = '대상 경로: src/later-release.ts\n다음 판 칸 원문';
  const [major, minor, patch] = checklistDevVersion().split('.').map(Number);
  const later = `${major}.${minor}.${patch! + 1}`;
  setElanousConfigDir(dir);
  try {
    addItem(later, { id: 'MK-LATER-BOARD', title });
    const launches: string[][] = [];
    const result = await run(['tasks', 'hand', '--checklist', 'MK-LATER-BOARD', '--live', '--json'], {
      taskStatePath: join(dir, 'cards.json'), registerSink: async () => true,
      taskLauncher: (args) => { launches.push(args); },
    });
    expect(result.code ?? 0).toBe(0);
    expect(JSON.parse(result.lines[0]!).card.text).toBe(title);
    expect(launches).toHaveLength(1);
  } finally { resetElanousConfigDir(); }
});

test('task hand finds a later open release cell, prefers the nearest duplicate, and allows --version to pin it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-any-version-'));
  const current = checklistDevVersion();
  const [major, minor, patch] = current.split('.').map(Number);
  const later = `${major}.${minor}.${patch! + 1}`;
  const latest = `${major}.${minor}.${patch! + 2}`;
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  const launches: string[][] = [];
  const deps: TasksCliDeps = {
    taskStatePath: join(dir, 'cards.json'), registerSink: async () => true,
    releaseVersions: () => [latest, current, later],
    releaseBoard: (version) => [{ id: 'project', level: 'project', title: 'Project', status: 'open', children: [
      ...(version === later || version === latest ? [{ id: 'NEXT', level: 'task' as const, title: `대상 경로: src/${version}.ts`, status: 'open' as const }] : []),
    ] }],
    taskLauncher: (args) => { launches.push(args); },
  };
  try {
    const next = await run(['tasks', 'hand', '--checklist', 'NEXT', '--live', '--json'], deps);
    expect(next.code ?? 0).toBe(0);
    expect(JSON.parse(next.lines[0]!).card.text).toBe(`대상 경로: src/${later}.ts`);
    expect(launches[0]!.at(-1)).toBe(`대상 경로: src/${later}.ts`);
    expect(warnings.some((line) => line.includes(`가장 가까운 판 ${later}`))).toBe(true);
    const pinned = await run(['tasks', 'hand', '--checklist', 'NEXT', '--version', latest, '--live', '--json'], deps);
    expect(pinned.code ?? 0).toBe(0);
    expect(JSON.parse(pinned.lines[0]!).card.text).toBe(`대상 경로: src/${latest}.ts`);
    const missing = await run(['tasks', 'hand', '--checklist', 'ABSENT', '--live'], deps);
    expect(missing.code).toBe(1);
    expect(missing.lines).toEqual(['체크리스트 칸 없음: ABSENT']);
    expect(launches).toHaveLength(2);
    const invalid = await run(['tasks', 'hand', '--checklist', 'NEXT', '--version', '../bad', '--live'], deps);
    expect(invalid.code).toBe(1);
    expect(launches).toHaveLength(2);
    const unbound = await run(['tasks', 'hand', 'text', '--version', latest, '--live'], deps);
    expect(unbound.code).toBe(1);
    expect(unbound.lines).toEqual(['--version 은 --checklist 와 함께 준다']);
  } finally { console.error = originalError; }
});

test('task hand prefers the current release cell over an older unreleased duplicate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-current-first-'));
  const current = checklistDevVersion();
  const [major, minor, patch] = current.split('.').map(Number);
  const older = `${major}.${minor}.${patch! - 1}`;
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const result = await run(['tasks', 'hand', '--checklist', 'DUP', '--live', '--json'], {
      taskStatePath: join(dir, 'cards.json'), registerSink: async () => true,
      releaseVersions: () => [older, current],
      releaseBoard: (version) => [{ id: 'project', level: 'project', title: 'Project', status: 'open', children: [
        { id: 'DUP', level: 'task', title: `대상 경로: src/${version}.ts`, status: 'open' },
      ] }],
      taskLauncher: () => {},
    });
    expect(result.code ?? 0).toBe(0);
    expect(JSON.parse(result.lines[0]!).card.text).toBe(`대상 경로: src/${current}.ts`);
    expect(warnings.some((line) => line.includes(`가장 가까운 판 ${current}`))).toBe(true);
  } finally { console.error = originalError; }
});

test('task hand keeps the current board available and ignores a broken unrelated release board', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-broken-release-'));
  const current = checklistDevVersion();
  const [major, minor, patch] = current.split('.').map(Number);
  const unrelated = `${major}.${minor}.${patch! + 1}`;
  const title = '대상 경로: src/current.ts';
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const result = await run(['tasks', 'hand', '--checklist', 'CURRENT', '--live', '--json'], {
      taskStatePath: join(dir, 'cards.json'), registerSink: async () => true,
      releaseVersions: () => [unrelated],
      releaseBoard: (version) => {
        if (version === unrelated) throw new Error('broken ledger');
        return [{ id: 'project', level: 'project', title: 'Project', status: 'open', children: [
          { id: 'CURRENT', level: 'task', title, status: 'open' },
        ] }];
      },
      taskLauncher: () => {},
    });
    expect(result.code ?? 0).toBe(0);
    expect(JSON.parse(result.lines[0]!).card.text).toBe(title);
    expect(warnings.some((line) => line.includes(`${unrelated} 읽기 실패`))).toBe(true);
    const pinned = await run(['tasks', 'hand', '--checklist', 'CURRENT', '--version', unrelated, '--live'], {
      taskStatePath: join(dir, 'other-cards.json'), registerSink: async () => true,
      releaseBoard: () => { throw new Error('broken ledger'); }, taskLauncher: () => {},
    });
    expect(pinned.code).toBe(1);
    expect(pinned.lines).toEqual([`체크리스트 판 읽기 실패: ${unrelated}`]);
  } finally { console.error = originalError; }
});

test('task hand --checklist passes a non-path cell title unchanged when text is omitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-non-path-title-'));
  const title = '기존 칸 문면\n둘째 줄 그대로';
  const launcherCalls: string[][] = [];
  const result = await run(['tasks', 'hand', '--checklist', 'cell-no-path', '--live', '--json'], {
    taskStatePath: join(dir, 'cards.json'), registerSink: async () => true,
    releaseBoard: () => [{ id: 'project', level: 'project', title: 'Project', status: 'open', children: [
      { id: 'cell-no-path', level: 'task', title, status: 'open' },
    ] }],
    taskLauncher: (args) => { launcherCalls.push(args); },
  });
  expect(result.code ?? 0).toBe(0);
  expect(launcherCalls).toHaveLength(1);
  expect(launcherCalls[0]!.at(-1)).toBe(title);
  expect(JSON.parse(result.lines[0]!).card.text).toBe(title);
});

test('task hand preserves ordinary text and --mission without attempting to inline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-plain-'));
  for (const text of ['fix-login', '보고서 정리해 줘']) {
    const result = await run(['task', 'hand', text, '--json'], { taskStatePath: join(dir, `${text}.json`), registerSink: async () => true });
    expect(result.code ?? 0).toBe(0);
    expect(JSON.parse(result.lines[0]!).move.command.at(-1)).toBe(text);
  }
  const mission = await run(['task', 'hand', '--mission', '- first.md\n- second.md', '--json'], { taskStatePath: join(dir, 'mission.json'), registerSink: async () => true });
  expect(mission.code ?? 0).toBe(0);
  expect(JSON.parse(mission.lines[0]!).mission.text).toBe('- first.md\n- second.md');
});

test('separate process task hand --json inlines goal file in an isolated shadow universe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-process-'));
  const path = join(dir, 'goal.md');
  const sentence = '대상 경로: src/a.ts\n현재 계약: keep original behavior';
  writeFileSync(path, `${sentence}\n`);
  const child = Bun.spawn([process.execPath, 'bin/elanous.mjs', `--test=${dir}`, 'task', 'hand', path, '--json'], {
    cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit === 0 ? 'exit 0' : `exit ${exit}: ${stderr.slice(0, 1200)}; stdout: ${stdout.slice(0, 400)}`).toBe('exit 0');
  const commandText = JSON.parse(stdout.trim()).move.command.at(-1) as string;
  expect(commandText.length).toBe(sentence.length);
  expect(createHash('sha256').update(commandText).digest('hex')).toBe(createHash('sha256').update(sentence).digest('hex'));
}, 120_000);

test('task hand requires project id and target together', async () => {
  const result = await run(['task', 'hand', '보고서', '--project', 'p1'], { registerSink: async () => true });
  expect(result.code).toBe(1);
  expect(result.lines.join('\n')).toContain('--target');
});

test('detached launcher keeps original options without cwd and sets cwd when supplied', async () => {
  const target = mkdtempSync(join(tmpdir(), 'tasks-cli-target-'));
  const options: Array<{ detached: true; stdio: 'ignore'; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  const spawn: DetachedSpawn = (_command, _args, opts) => {
    options.push(opts);
    const listeners: Record<string, Array<(...args: never[]) => void>> = {};
    const child = {
      pid: 123,
      once(event: 'spawn' | 'error', listener: (...args: never[]) => void) {
        (listeners[event] ??= []).push(listener);
        if (event === 'spawn') queueMicrotask(() => listener());
      },
      removeListener() {},
      unref() {},
    };
    return child;
  };
  await spawnDetachedConfirmed(spawn, 'bun', ['x']);
  await spawnDetachedConfirmed(spawn, 'bun', ['x'], 2_000, target);
  expect(options).toEqual([{ detached: true, stdio: 'ignore' }, { detached: true, stdio: 'ignore', cwd: target }]);
  // TA-CARD-RUN-LINK: env 를 주면 부모 환경 위에 얹는다(런 id 상속).
  await spawnDetachedConfirmed(spawn, 'bun', ['x'], 2_000, undefined, { ELANOUS_RUN_ID: 'run-test-1234' });
  expect(options[2]!.env?.ELANOUS_RUN_ID).toBe('run-test-1234');
  expect(options[2]!.env?.PATH).toBe(process.env.PATH);
});

test('list sorts urgent > high > medium > low and fetches real approval/source through authenticated details', async () => {
  const server = nexus();
  const result = await run(['tasks', 'list'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: token, fetch: server.fetchNexus });
  expect(result.code ?? 0).toBe(0);
  expect(result.lines[0]).toBe('id\t우선순위\t상태\t승인\t출처\t제목');
  expect(result.lines.slice(1).map((line) => line.split('\t')[0])).toEqual(['urgent', 'high', 'medium', 'low']);
  expect(result.lines[1]).toContain('pending\tlinear:L-4\tUrgent task');
  expect(result.lines[3]).toContain('approved\tgithub:G-3\tMedium task');
  expect(server.requests.map((req) => req.path)).toEqual(['/v1/tasks', '/v1/tasks/low', '/v1/tasks/urgent', '/v1/tasks/medium', '/v1/tasks/high']);
  expect(server.requests.every((req) => req.authorization === `Bearer ${token}`)).toBe(true);
  expect(result.lines.join('\n')).not.toContain(token);
});

test('tasks with equal priority sort by creation time before id', async () => {
  const server = nexus();
  const earlier = { ...tasks[3]!, id: 'older-high', title: 'Older high', createdAt: 0 };
  const result = await run(['tasks', 'list', '--json'], {
    baseUrl: 'http://127.0.0.1:31415', bearerToken: token,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/tasks')) {
        return Response.json({ tasks: [...tasks.map(({ id, status }) => ({ id, status })), { id: earlier.id, status: earlier.status }] });
      }
      if (String(input).endsWith('/v1/tasks/older-high')) return Response.json({ task: earlier });
      return server.fetchNexus(input, init);
    }) as typeof fetch,
  });
  expect(JSON.parse(result.lines[0]!).map((task: { id: string }) => task.id)).toEqual(['urgent', 'older-high', 'high', 'medium', 'low']);
});

test('status/provider filters and JSON show preserve the full detail payload', async () => {
  const server = nexus();
  const deps = { baseUrl: 'http://127.0.0.1:31415', bearerToken: token, fetch: server.fetchNexus };
  const filtered = await run(['task', 'list', '--status', 'backlog', '--provider', 'linear', '--json'], deps);
  expect(JSON.parse(filtered.lines[0]!).map((task: { id: string }) => task.id)).toEqual(['urgent', 'high', 'low']);
  const shown = await run(['tasks', 'show', 'urgent', '--json'], deps);
  expect(JSON.parse(shown.lines[0]!)).toMatchObject({ task: { id: 'urgent', priority: 'urgent', approval: { state: 'pending' } }, executions: [], events: [] });
  expect(filtered.lines.concat(shown.lines).join('\n')).not.toContain(token);
});

test('approve a b sends both POST requests and 409 prints failed with exit 1, without leaking token', async () => {
  const server = nexus();
  const result = await run(['tasks', 'approve', 'a', 'b'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: token, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/a/approve')) {
      server.requests.push({ path: '/v1/tasks/a/approve', method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('Authorization') });
      return Response.json({ taskId: 'a', status: 'ready', approval: { state: 'approved' } });
    }
    return server.fetchNexus(input, init);
  }) as unknown as typeof fetch });
  expect(result.lines).toEqual(['a\tapproved', 'b\tfailed HTTP 409']);
  expect(result.code).toBe(1);
  expect(server.requests).toEqual([
    { path: '/v1/tasks/a/approve', method: 'POST', authorization: `Bearer ${token}` },
    { path: '/v1/tasks/b/approve', method: 'POST', authorization: `Bearer ${token}` },
  ]);
  expect(result.lines.join('\n')).not.toContain(token);
});

test('token strings in task fields or remote errors never reach output', async () => {
  const server = nexus();
  const output = await run(['tasks', 'list'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: token, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await server.fetchNexus(input, init);
    if (String(input).endsWith('/v1/tasks/low')) return Response.json({ task: { ...tasks[0], title: `contains ${token}` } });
    return response;
  }) as typeof fetch });
  expect(output.lines.join('\n')).not.toContain(token);
  const error = await run(['tasks', 'approve', 'a'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: token, fetch: (async () => Response.json({ error: token }, { status: 503 })) as unknown as typeof fetch });
  expect(error.lines).toEqual(['a\tfailed HTTP 503']);
  expect(error.lines.join('\n')).not.toContain(token);
});

test('unavailable nexus exits 2; fetch exceptions never disclose credentials', async () => {
  const unavailable = await run(['tasks', 'list'], { bearerToken: token, baseUrl: '', fetch: (async () => { throw new Error('should not fetch'); }) as unknown as typeof fetch });
  expect(unavailable).toEqual({ lines: ['넥서스가 안 떠 있다 — `elanous nexus run`'], code: 2 });
  const thrown = await run(['tasks', 'show', 'a'], { bearerToken: token, baseUrl: 'http://127.0.0.1:31415', fetch: (async () => { throw new Error(`failed with ${token}`); }) as unknown as typeof fetch });
  expect(thrown).toEqual({ lines: ['넥서스가 안 떠 있다 — `elanous nexus run`'], code: 2 });
});

test('index wires tasks instead of the retirement stub, and scheduler stays retired', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  expect(source).toContain('registerTasksCommands(program);');
  expect(source).not.toContain(".command('task [args...]')");
  expect(source).toContain(".command('scheduler [args...]')");
  const program = new Command().name('elanous');
  registerTasksCommands(program);
  const command = program.commands.find((entry) => entry.name() === 'tasks');
  expect(command?.aliases()).toContain('task');
  expect(command?.commands.map((entry) => entry.name())).toEqual(['green-sweep', 'cover', 'list', 'hand', 'hand-move', 'live-verified', 'close', 'parents', 'adopt-pr', 'adopt-runs', 'board', 'advance', 'show', 'rejudge', 'regate-run', 'repair-run', 'approve']);
});

test('tasks hand-move — 카드 history 에 손으로 쓴 한 줄을 남긴다 · 모르는 kind 는 원장을 건드리지 않는다', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'tasks-cli-handmove-')), 'task-agent-actions.json');
  const seed: TaskCard = { id: 'card-hm', text: '칸 하나', createdAt: '2026-10-11T00:00:00.000Z', status: 'handed',
    history: [{ at: '2026-10-11T00:00:00.000Z', event: 'hand', detail: '넘김' }] };
  writeTaskCards(statePath, [seed]);
  const ok = await run(['tasks', 'hand-move', 'card-hm', '--kind', 'split', '--by', 'OP', '--detail', '한 런에 안 끝나 조각만 남겼다', '--pr', '13045'], { taskStatePath: statePath });
  expect(ok.code ?? 0).toBe(0);
  expect(ok.lines).toEqual(['card-hm\thand-move\tsplit\tOP\t한 런에 안 끝나 조각만 남겼다\tpr 13045']);
  const card = readTaskCard('card-hm', statePath)!;
  expect(card.history.length).toBe(2);
  expect(card.history[0]).toEqual(seed.history[0]);
  expect(card.history[1]).toMatchObject({ event: 'hand-move', kind: 'split', by: 'OP', detail: '한 런에 안 끝나 조각만 남겼다', pr: 13045 });
  const bad = await run(['tasks', 'hand-move', 'card-hm', '--kind', 'wing-it', '--by', 'OP', '--detail', 'x'], { taskStatePath: statePath });
  expect(bad.code).toBe(1);
  expect(bad.lines.join('\n')).toContain('wing-it');
  expect(readTaskCard('card-hm', statePath)!.history.length).toBe(2);
});

test('tasks close — 카드를 failed 로 닫고 사유를 history 에 남긴다 · 없는 카드 id 는 exit 1 로 거부하고 원장을 건드리지 않는다', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'tasks-cli-close-')), 'task-agent-actions.json');
  const seed: TaskCard = { id: 'ta-close', text: '칸 하나', createdAt: '2026-10-11T00:00:00.000Z', status: 'launched',
    history: [{ at: '2026-10-11T00:00:00.000Z', event: 'launch', detail: '발사' }] };
  writeTaskCards(statePath, [seed]);
  const ok = await run(['tasks', 'close', 'ta-close', '--reason', '다른 골로 대체됨', '--by', 'OP'], { taskStatePath: statePath });
  expect(ok.code ?? 0).toBe(0);
  expect(ok.lines).toEqual(['ta-close\tfailed\tclosed-by-hand\tOP\t다른 골로 대체됨']);
  const card = readTaskCard('ta-close', statePath)!;
  expect(card.status).toBe('failed');
  expect(card.history.length).toBe(2);
  expect(card.history[0]).toEqual(seed.history[0]);
  expect(card.history[1]).toMatchObject({ event: 'closed-by-hand', kind: 'closed-by-hand', reason: '다른 골로 대체됨', by: 'OP' });
  const before = readFileSync(statePath, 'utf8');
  const again = await run(['tasks', 'close', 'ta-close', '--reason', '다시', '--json'], { taskStatePath: statePath });
  expect(JSON.parse(again.lines.at(-1)!)).toEqual({ id: 'ta-close', from: 'failed', to: 'failed', reason: '다른 골로 대체됨', already: true });
  expect(readTaskCard('ta-close', statePath)!.history.length).toBe(2);
  const unknown = await run(['tasks', 'close', 'ta-nope', '--reason', 'x'], { taskStatePath: statePath });
  expect(unknown.code).toBe(1);
  expect(unknown.lines.join('\n')).toContain('ta-nope');
  expect(readFileSync(statePath, 'utf8')).toBe(before);
  const blank = await run(['tasks', 'close', 'ta-close', '--reason', '   '], { taskStatePath: statePath });
  expect(blank.code).toBe(1);
  expect(readFileSync(statePath, 'utf8')).toBe(before);
});

test('an isolated universe without an acp-token still lists — no Authorization header is sent', async () => {
  const server = nexus();
  const result = await run(['tasks', 'list'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: '', fetch: server.fetchNexus });
  expect(result.code ?? 0).toBe(0);
  expect(result.lines.slice(1).map((line) => line.split('\t')[0])).toEqual(['urgent', 'high', 'medium', 'low']);
  expect(server.requests.every((req) => req.authorization === null)).toBe(true);
});

test('real detached spawn: the env handed by the launcher reaches the child (ELANOUS_RUN_ID inheritance)', async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const out = join(mkdtempSync(join(tmpdir(), 'tasks-cli-env-')), 'env.txt');
  await spawnDetachedConfirmed(spawn as unknown as DetachedSpawn, process.execPath,
    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.ELANOUS_RUN_ID ?? '')`], 2_000, undefined, { ELANOUS_RUN_ID: 'run-inherit-check-1234' });
  const deadline = Date.now() + 10_000;
  while (!existsSync(out) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  expect(readFileSync(out, 'utf8')).toBe('run-inherit-check-1234');
});

test('ORCH-LIVE-1008: the hand launcher runs the elanous CLI entry, not whatever script started this process (orchestrator tick)', async () => {
  const started = process.argv[1];
  const seen: string[][] = [];
  const fakeSpawn = ((command: string, args: string[]) => {
    seen.push([command, ...args]);
    const handlers: Record<string, () => void> = {};
    setTimeout(() => handlers.spawn?.(), 0);
    return { pid: 1, once: (event: string, fn: () => void) => { handlers[event] = fn; }, removeListener: () => undefined, unref: () => undefined };
  }) as unknown as DetachedSpawn;
  try {
    process.argv[1] = '/somewhere/src/loops/orchestrator/tick.ts';
    await defaultTaskLauncher(['harness', 'say', 'x'], undefined, undefined, { spawn: fakeSpawn });
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe(process.execPath);
    expect(seen[0]![1]).toBe(ELANOUS_CLI_ENTRY);
    expect(seen[0]![1]!.endsWith('/bin/elanous.mjs')).toBe(true);
    expect(existsSync(seen[0]![1]!)).toBe(true);
    expect(seen[0]!.slice(2)).toContain('harness');
    expect(taskLauncherArgv('/cfg', ['a'])).toEqual([ELANOUS_CLI_ENTRY, '--config-dir', '/cfg', 'a']);
  } finally { process.argv[1] = started; }
});

/** A fake detached child that writes `stderr` to the fd it was handed and exits with `code` (or stays alive). */
function exitingSpawn(code: number | null, stderr = ''): { spawn: DetachedSpawn; stdio: unknown[] } {
  const stdio: unknown[] = [];
  const spawn = ((_command: string, _args: string[], options: { stdio: unknown }) => {
    stdio.push(options.stdio);
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    setTimeout(() => {
      handlers.spawn?.();
      if (code === null) return;
      const fd = (options.stdio as unknown[])[2];
      if (stderr && typeof fd === 'number') writeSync(fd, stderr);
      setTimeout(() => handlers.exit?.(code, null), 5);
    }, 0);
    return { pid: 9, once: (event: string, fn: (...args: unknown[]) => void) => { handlers[event] = fn; }, removeListener: () => undefined, unref: () => undefined };
  }) as unknown as DetachedSpawn;
  return { spawn, stdio };
}

const launchContext = (runId: string) => ({ runId, launchId: 'tl-test', env: { ELANOUS_RUN_ID: runId } });

test('STOP-RECORD launch-failed: a child that exits nonzero right after launch writes exactly one stop line and throws', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const written: RunLedgerEntry[] = [];
  const longTail = `error: unknown command 'tick.ts'\n${Array.from({ length: 40 }, (_, i) => `    at frame${i} (x.ts:${i})`).join('\n')}`;
  const { spawn, stdio } = exitingSpawn(2, longTail);
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0001'),
    { spawn, stderrDir, earlyExitWindowMs: 1_000, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow('rc=2');
  expect((stdio[0] as unknown[]).slice(0, 2)).toEqual(['ignore', 'ignore']);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ runId: 'run-launchfail-0001', event: 'stop', data: {
    class: 'launch-failed', cause: "child rc=2: error: unknown command 'tick.ts'", evidenceRef: join(stderrDir, 'run-launchfail-0001.stderr'), nextMove: expect.any(String) } });
  expect(String(written[0]!.data.cause).length).toBeLessThanOrEqual(120);
  expect(String(written[0]!.data.cause)).not.toContain('frame');
});

test('STOP-RECORD launch-failed: a child still running after the window (or exiting 0) records no stop and returns the receipt', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const written: RunLedgerEntry[] = [];
  const alive = await defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchok-0001'),
    { spawn: exitingSpawn(null).spawn, stderrDir, earlyExitWindowMs: 50, writeStop: (entry) => { written.push(entry); } });
  expect(alive).toEqual({ runId: 'run-launchok-0001' });
  const clean = await defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchok-0002'),
    { spawn: exitingSpawn(0).spawn, stderrDir, earlyExitWindowMs: 1_000, writeStop: (entry) => { written.push(entry); } });
  expect(clean).toEqual({ runId: 'run-launchok-0002' });
  expect(written).toHaveLength(0);
});

test('STOP-RECORD launch-failed: no stderr still records rc only', async () => {
  const written: RunLedgerEntry[] = [];
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0002'),
    { spawn: exitingSpawn(7).spawn, stderrDir: mkdtempSync(join(tmpdir(), 'tasks-cli-launch-')), earlyExitWindowMs: 1_000, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow();
  expect(written.map((entry) => entry.data.cause)).toEqual(['child rc=7']);
});

test('STOP-RECORD launch-failed: a rerun truncates the old stderr and an existing stop is not duplicated (review must-fix)', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  writeFileSync(join(stderrDir, 'run-launchfail-0003.stderr'), 'stale error from the previous attempt\n');
  const written: RunLedgerEntry[] = [];
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0003'),
    { spawn: exitingSpawn(3, 'fresh error\n').spawn, stderrDir, earlyExitWindowMs: 1_000, hasStop: () => false, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow('fresh error');
  expect(written.map((entry) => entry.data.cause)).toEqual(['child rc=3: fresh error']);
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0004'),
    { spawn: exitingSpawn(3, 'boom\n').spawn, stderrDir, earlyExitWindowMs: 1_000, hasStop: () => true, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow('rc=3');
  expect(written).toHaveLength(1);
});

test('STOP-RECORD launch-failed: through task hand --live the card is launch-failed, not launched', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const taskStatePath = join(mkdtempSync(join(tmpdir(), 'tasks-cli-card-')), 'task-agent-actions.json');
  const written: RunLedgerEntry[] = [];
  const result = await run(['task', 'hand', 'ship it', '--live'], {
    taskStatePath, registerSink: async () => true,
    taskLauncher: (args, cwd, context) => defaultTaskLauncher(args, cwd, context,
      { spawn: exitingSpawn(2, 'error: bad argv\n').spawn, stderrDir, earlyExitWindowMs: 1_000, hasStop: () => false, writeStop: (entry) => { written.push(entry); } }),
  });
  expect(result.code).toBe(1);
  const cards = Object.values(JSON.parse(readFileSync(taskStatePath, 'utf8')).tasks) as Array<{ status: string; history: Array<{ event: string; detail?: string }> }>;
  expect(cards).toHaveLength(1);
  expect(cards[0]!.status).toBe('launch-failed');
  expect(cards[0]!.history[0]!.detail).toContain('child rc=2: error: bad argv');
  expect(written).toHaveLength(1);
  expect(written[0]!.data).toMatchObject({ class: 'launch-failed' });
});

test('tasks adopt-runs backfills uncarded registry runs into the injected state file only', async () => {
  const { writeLaunchBinding } = await import('../harness/launch-registry.js');
  const root = mkdtempSync(join(tmpdir(), 'tasks-adopt-runs-'));
  const statePath = join(root, 'task-agent-actions.json');
  const registryDir = join(root, 'registry');
  writeLaunchBinding('run-backfill', { pid: 1, startedAt: 1, cwd: root, runsDir: join(root, 'self-dev-runs') }, registryDir);
  writeLaunchBinding('run-foreign', { pid: 1, startedAt: 1, cwd: root, runsDir: join(root, 'test', 'self-dev-runs') }, registryDir);
  const first = await run(['tasks', 'adopt-runs', '--json'], { taskStatePath: statePath, adoptRuns: { registryDir, log: () => {} } });
  expect(JSON.parse(first.lines[0] ?? '{}')).toEqual({ scanned: 2, adopted: 1, skipped: { 'universe-mismatch': 1 } });
  expect(Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).tasks)).toEqual(['ta-run-backfill']);
  const again = await run(['tasks', 'adopt-runs'], { taskStatePath: statePath, adoptRuns: { registryDir, log: () => {} } });
  expect(again.lines).toEqual(['등록부 런 2 · 카드 만듦 0 · 건너뜀 already-carded 1 · universe-mismatch 1']);
});

test('TA-LIVE-MOVE-CARD-HISTORY — tasks show <card> reads the card ledger and prints live-move lines (shadow ok = —)', async () => {
  const taskStatePath = join(mkdtempSync(join(tmpdir(), 'tasks-cli-live-move-')), 'task-agent-actions.json');
  const head = 'c'.repeat(40);
  writeFileSync(taskStatePath, JSON.stringify({ tasks: { 'ta-show-lm': {
    id: 'ta-show-lm', text: 'feature ask', createdAt: '2026-10-10T00:00:00.000Z', status: 'launched', history: [
      { at: '2026-10-10T00:00:00.000Z', event: 'launch' },
      { at: '2026-10-10T01:00:00.000Z', event: 'live-move', kind: 'review', executed: true, ok: true, executorResult: 'live', detail: 'review requested', pr: 9, head, effect: 'review requested · result not received' },
      { at: '2026-10-10T02:00:00.000Z', event: 'live-move', kind: 'propose-land', executed: false, executorResult: 'shadow', detail: 'judged\nsecond line\rthird', pr: 9, effect: 'none — shadow (not executed)' },
    ] } } }));
  const result = await run(['tasks', 'show', 'ta-show-lm'], { taskStatePath, registerSink: async () => true });
  const moves = result.lines.filter((line) => line.startsWith('수: '));
  expect(moves).toEqual([
    `수: 2026-10-10T01:00:00.000Z · review live · executed=true ok=true · PR #9 head ${head.slice(0, 12)} · 효과: review requested · result not received · review requested`,
    '수: 2026-10-10T02:00:00.000Z · propose-land shadow · executed=false ok=— · PR #9 · 효과: none — shadow (not executed) · judged\\nsecond line\\rthird',
  ]);
  expect(result.lines.some((line) => line.startsWith('다음 수: '))).toBe(true);
});

test('TA-REVIEW-RESULT-CAPTURE — tasks show <card> captures a pending review result file into a live-move-result line and prints it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-review-result-'));
  const taskStatePath = join(dir, 'task-agent-actions.json');
  const head = 'd'.repeat(40);
  const resultPath = join(dir, 'review-results', `ta-show-rr-9-${head.slice(0, 12)}.json`);
  mkdirSync(join(dir, 'review-results'), { recursive: true });
  writeFileSync(resultPath, `noise\n${JSON.stringify({ pr: '9', verdict: 'warn', mustFix: ['fix it'], reviewed: true, reviewRoute: 'acp', headCommit: head })}\n`);
  writeFileSync(taskStatePath, JSON.stringify({ tasks: { 'ta-show-rr': {
    id: 'ta-show-rr', text: 'feature ask', createdAt: '2026-10-10T00:00:00.000Z', status: 'launched',
    reviewRequests: [{ pr: 9, head, at: '2026-10-10T01:00:00.000Z', resultPath }],
    history: [{ at: '2026-10-10T00:00:00.000Z', event: 'launch' }],
  } } }));
  const result = await run(['tasks', 'show', 'ta-show-rr'], { taskStatePath, registerSink: async () => true, reviewResultNow: () => new Date('2026-10-10T01:10:00.000Z') });
  expect(result.lines.filter((line) => line.startsWith('결과: '))).toEqual([
    `결과: 2026-10-10T01:10:00.000Z · review · PR #9 head ${head.slice(0, 12)} · verdict=warn reviewed=true must-fix=1 route=acp · 효과: review result captured · verdict warn · reviewed true · must-fix 1 · `,
  ]);
  const card = JSON.parse(readFileSync(taskStatePath, 'utf8')).tasks['ta-show-rr'];
  expect(card.history.at(-1)).toMatchObject({ event: 'live-move-result', pr: 9, verdict: 'warn', mustFix: 1, resultPath });
  // 다시 봐도 한 줄.
  await run(['tasks', 'show', 'ta-show-rr'], { taskStatePath, registerSink: async () => true });
  expect(JSON.parse(readFileSync(taskStatePath, 'utf8')).tasks['ta-show-rr'].history.filter((item: { event: string }) => item.event === 'live-move-result')).toHaveLength(1);
});

test('TA-REJUDGE-ON-HEAD — tasks regate-run runs the host regate without merge and writes head · baseCommit · passed to --out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-regate-run-'));
  const outPath = join(dir, 'regate-results', 'ta-x-30-bbbbbbbbbbbb.json');
  const seen: unknown[] = [];
  const result = await run(['tasks', 'regate-run', '--card', 'ta-x', '--pr', '30', '--head', 'b'.repeat(40), '--repo', '/repo', '--out', outPath], {
    registerSink: async () => true,
    hostRegate: async (input) => { seen.push(input); return { passed: true, failures: [], os: 'darwin', status: 'passed', baseCommit: 'c'.repeat(40) }; },
    regateCompletion: false,
  });
  expect(result.code ?? 0).toBe(0);
  expect(seen).toEqual([{ prNumber: 30, headCommit: 'b'.repeat(40), repoRoot: '/repo', noMerge: true }]);
  expect(JSON.parse(readFileSync(outPath, 'utf8'))).toMatchObject({ pr: 30, head: 'b'.repeat(40), passed: true, status: 'passed', baseCommit: 'c'.repeat(40), failures: [] });
});

test('TA-LAND-AFTER-REVIEW phase ① — actual regate-run completion logs a shadow decision and executes zero live moves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-regate-shadow-'));
  const statePath = join(dir, 'task-agent-actions.json');
  const head = 'b'.repeat(40);
  const outPath = join(dir, 'regate-results', 'ta-x-30-bbbbbbbbbbbb.json');
  const reviewPath = join(dir, 'review.json');
  writeFileSync(reviewPath, JSON.stringify({ pr: '30', verdict: 'pass', mustFix: [], reviewed: true, headCommit: head }));
  writeTaskCards(statePath, [{ id: 'ta-x', text: 'x', createdAt: '2026-10-12T00:00:00Z', status: 'launched', taLand: true,
    pr: { number: 30, url: 'https://github.com/o/r/pull/30' },
    reviewRequests: [{ pr: 30, head, at: '2026-10-12T00:01:00Z', resultPath: reviewPath }],
    regates: [{ pr: 30, head, at: '2026-10-12T00:02:00Z', resultPath: outPath }],
    history: [{ at: '2026-10-12T00:01:00Z', event: 'live-move-result', kind: 'review', pr: 30, head, reviewed: true,
      verdict: 'pass', mustFix: 0, resultPath: reviewPath, effect: 'review result captured · verdict pass · reviewed true · must-fix 0' }],
  }]);
  const shadow: Array<Record<string, unknown>> = [];
  const live: string[] = [];
  const regateCalls: string[] = [];
  const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
    if (event === 'rejudge-shadow' && data && typeof data === 'object') shadow.push(data as Record<string, unknown>);
  });
  try {
    const result = await run(['tasks', 'regate-run', '--card', 'ta-x', '--pr', '30', '--head', head, '--repo', dir, '--out', outPath], {
      taskStatePath: statePath, registerSink: async () => true,
      hostRegate: (input) => runHostRegate(input, {
        command: (bin, args, cwd) => {
          const call = `${bin} ${args.join(' ')}`;
          regateCalls.push(call);
          if (/^git fetch --no-write-fetch-head origin \+refs\/heads\/main:refs\/elanous\/regate\/[^ ]+\/base$/.test(call)) return { status: 0, stdout: '', stderr: '' };
          if (/^git fetch --no-write-fetch-head origin \+refs\/pull\/30\/head:refs\/elanous\/regate\/[^ ]+\/head$/.test(call)) return { status: 0, stdout: '', stderr: '' };
          if (call === 'gh pr view 30 --json headRefOid,baseRefName,baseRefOid,state,isDraft') return {
            status: 0, stdout: JSON.stringify({ headRefOid: head, baseRefName: 'main', baseRefOid: 'c'.repeat(40), state: 'OPEN', isDraft: false }), stderr: '',
          };
          if (call === 'git rev-parse --show-toplevel') return { status: 0, stdout: cwd, stderr: '' };
          if (call === 'git rev-parse HEAD' || call === 'git rev-parse HEAD^1') return { status: 0, stdout: 'c'.repeat(40), stderr: '' };
          if (call === 'git rev-parse HEAD^2') return { status: 0, stdout: head, stderr: '' };
          if (/^git rev-parse refs\/elanous\/regate\/[^ ]+\/(base|head)$/.test(call)) return { status: 0, stdout: call.endsWith('/base') ? 'c'.repeat(40) : head, stderr: '' };
          if (call === `git merge-base ${'c'.repeat(40)} ${head}`) return { status: 0, stdout: 'd'.repeat(40), stderr: '' };
          if (call === `git diff --name-only ${'d'.repeat(40)} ${head}`) return { status: 0, stdout: 'src/feature.test.ts\n', stderr: '' };
          if (call === `git diff --find-renames --name-status -z ${'d'.repeat(40)} ${head}`) return { status: 0, stdout: 'M\0src/feature.test.ts\0', stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        },
        acquire: async () => Object.assign(() => {}, { worktree: dir }),
        interference: async () => ({ passed: true }),
        prodFreezeRoot: join(dir, 'operational-freeze'),
      }),
      rejudge: { liveMoves: new Set(['review', 'propose-land']), live: {
        repoCandidates: () => [{ source: 'host', cwd: dir }],
        prHead: async () => ({ head, state: 'OPEN', url: 'https://github.com/o/r/pull/30', branch: 'feature' }),
        requestReview: async () => { live.push('review'); },
        land: async () => { live.push('land'); return { status: 0, stdout: 'merged' }; },
      }, requestRegate: async () => { live.push('regate'); } },
    });
    expect(result.code ?? 0).toBe(0);
    expect(regateCalls.some((call) => /^git fetch --no-write-fetch-head origin \+refs\/heads\/main:refs\/elanous\/regate\/[^ ]+\/base$/.test(call))).toBe(true);
    expect(regateCalls.some((call) => /^git fetch --no-write-fetch-head origin \+refs\/pull\/30\/head:refs\/elanous\/regate\/[^ ]+\/head$/.test(call))).toBe(true);
    expect(shadow).toMatchObject([{ card: 'ta-x', head12: head.slice(0, 12), decision: 'land' }]);
    expect(live).toEqual([]);
    expect(readTaskCard('ta-x', statePath)?.landAttempts).toBeUndefined();
  } finally { log.mockRestore(); }
});

test('TA-REJUDGE-ON-HEAD — tasks rejudge --all judges each candidate card and prints step · decision', async () => {
  const taskStatePath = join(mkdtempSync(join(tmpdir(), 'tasks-cli-rejudge-')), 'task-agent-actions.json');
  const a = 'a'.repeat(40);
  writeFileSync(taskStatePath, JSON.stringify({ tasks: { 'ta-rj': {
    id: 'ta-rj', text: 'x', createdAt: '2026-10-11T00:00:00.000Z', status: 'launched', pr: { number: 30, url: 'https://github.com/o/r/pull/30' },
    reviewRequests: [{ pr: 30, head: a, at: '2026-10-11T00:10:00.000Z' }], history: [],
  } } }));
  const result = await run(['tasks', 'rejudge', '--all'], { taskStatePath, registerSink: async () => true, rejudge: {
    liveMoves: new Set(),
    live: { repoCandidates: () => [{ source: 'host', cwd: '/repo' }], prHead: async () => ({ head: a, state: 'OPEN', url: 'https://github.com/o/r/pull/30' }) },
  } });
  expect(result.lines).toEqual([`ta-rj\tPR #30\t${a.slice(0, 12)}→${a.slice(0, 12)}\ttarget\thead-unchanged\tPR #30 head is still the judged head`]);
});

test('tasks rejudge --all selects a formerly unbound remote parent after HQ mirror PR binding', async () => {
  const { remoteLedgerMirrorDir } = await import('../task-agent/parent-host.js');
  const root = mkdtempSync(join(tmpdir(), 'tasks-cli-remote-rejudge-'));
  const taskStatePath = join(root, 'task-agent-actions.json');
  const parent = 'run-11111111-1111-4111-8111-111111111111';
  const child = 'run-22222222-2222-4222-8222-222222222222';
  const url = 'https://github.com/o/r/pull/30';
  const dir = remoteLedgerMirrorDir(root, 'node-b');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${parent}.jsonl`), JSON.stringify({ runId: parent, event: 'pod-child-run', data: { childRunId: child } }) + '\n');
  const childPr = { runId: child, event: 'pr-opened', data: { number: 30, url } };
  writeFileSync(join(dir, `${child}.jsonl`), JSON.stringify(childPr) + '\n');
  writeFileSync(taskStatePath, JSON.stringify({ tasks: { 'ta-remote': {
    id: 'ta-remote', text: 'repair', createdAt: '2026-10-12T00:00:00.000Z', status: 'launched', taLand: true,
    runId: parent, parentHost: { host: 'node-b' }, history: [],
  } } }));
  const deps: TasksCliDeps = { taskStatePath, registerSink: async () => true,
    remoteLedgerMirror: () => {}, rejudge: { liveMoves: new Set(), remoteRunTerminal: () => true,
      live: { repoCandidates: () => [{ source: 'host', cwd: '/repo' }], prHead: async () => ({ head: 'a'.repeat(40), state: 'OPEN', url }) } } };
  const incomplete = await run(['tasks', 'rejudge', '--all'], deps);
  expect(incomplete.lines).toEqual([]);
  expect((JSON.parse(readFileSync(taskStatePath, 'utf8')) as { tasks: Record<string, { pr?: unknown }> }).tasks['ta-remote']?.pr).toBeUndefined();
  writeFileSync(join(dir, `${child}.jsonl`), [childPr,
    { runId: child, event: 'run-status', data: { runStatus: 'completed' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const result = await run(['tasks', 'rejudge', '--all'], deps);
  expect(result.lines.some(line => line.startsWith('ta-remote\tPR #30\t'))).toBe(true);
  expect((JSON.parse(readFileSync(taskStatePath, 'utf8')) as { tasks: Record<string, { pr?: { number: number }; runChildId?: string }> }).tasks['ta-remote'])
    .toMatchObject({ pr: { number: 30 }, runChildId: child });
});
