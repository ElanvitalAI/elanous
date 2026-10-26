import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { debug } from '../debug/log.js';
import { recordRunExit } from '../harness/harness-incidents.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, checklistDevVersion } from '../release-loop/checklist.js';
import { appendRunLedgerEntry, loadRunLedger, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { GoalAskStore } from '../self-implement/goal-ask-store.js';
import { GoalRunStore, goalRunDbPath } from '../self-implement/goal-run-store.js';
import { runHostRegate } from '../self-implement/host-regate.js';
import type { LogStoreRow } from '../mss/logging/log-store.js';
import { readTaskCard, writeTaskCards, type TaskCard } from '../task-agent/task-hand.js';
import { readMapRun } from '../task-agent/map-run-ledger.js';
import { rejudgeCandidates } from '../task-agent/rejudge-on-head.js';
import { reviewResultPath } from '../task-agent/review-result-capture.js';
import { repairReviewDigest } from '../task-agent/repair-review.js';
import { remoteLedgerMirrorDir } from '../task-agent/parent-host.js';
import { adoptExistingPr, adoptedRunTerminal } from '../task-agent/adopt-pr.js';
import { cardsBoard, type BoardNode } from '../task-agent/board.js';
import { resetUserConfig } from '../user-config.js';
import { defaultTaskLauncher, ELANOUS_CLI_ENTRY, greenCloseDeclaredPaths, podParentLaunchSelectors, readTaskOutcomeModelSize, readTaskOutcomes, registerTasksCommands, spawnDetachedConfirmed, taskLauncherArgv, type DetachedSpawn, type TaskDoctorReport, type TaskOutcomeRow, type TasksCliDeps } from './tasks-cli.js';

test('Pod in-place worktree opt-in reaches the remote parent without forwarding unrelated HQ env', () => {
  expect(podParentLaunchSelectors({}, { ELANOUS_POD_INPLACE_WORKTREE: '1', ELANOUS_POD_MEMORY_TIER: 'high', SECRET_TOKEN: 'private' }))
    .toEqual({ ELANOUS_POD_INPLACE_WORKTREE: '1', ELANOUS_POD_MEMORY_TIER: 'high' });
  expect(podParentLaunchSelectors({}, { ELANOUS_POD_INPLACE_WORKTREE: 'yes' })).toEqual({ ELANOUS_POD_INPLACE_WORKTREE: '0' });
  expect(podParentLaunchSelectors({}, {})).toEqual({});
});

test('green close current checklist scope cannot be narrowed by an old TA card', () => {
  expect(greenCloseDeclaredPaths('대상 경로: src/one.ts · src/two.ts\n완료 경계 코드: 둘 다', ['src/one.ts']))
    .toEqual(['src/one.ts', 'src/two.ts']);
  expect(greenCloseDeclaredPaths('완료 경계 코드: 누락', ['src/one.ts'])).toEqual([]);
});

const token = 'secret-acp-token-sentinel';
test('saturated and unknown parent capacity reports measured reasons without remote launch', async () => {
  const events: Array<{ host: string; gaps: string[] }> = [];
  const off = debug.registerSink({ name: 'capacity-refusal-cli-test', emit: (rec) => {
    if (rec.category === 'task-agent' && rec.event === 'parent-host-fallback') events.push(rec.data as { host: string; gaps: string[] });
  } });
  const calls: string[] = [];
  const ssh = (host: string, script: string) => {
    calls.push(`${host}:${script}`);
    if (host === 'unknown') return { status: 255, stdout: '', stderr: 'timeout' };
    return { status: 0, stdout: '__ELANOUS_PARENT_CAPACITY__4\n'
      + Array.from({ length: 10 }, (_, i) => JSON.stringify({ category: 'pod-lease', event: 'admit-by-usage', data: { runId: `waiting-${i}`, recommended: 0 } })).join('\n') + '\n'
      + '__ELANOUS_PARENT_APPROVALS__\n__ELANOUS_PARENT_LOAD__0.000\n__ELANOUS_PARENT_LOAD__cores=4\n', stderr: '' };
  };
  const spawn: DetachedSpawn = () => ({ pid: 7, once(event: string, listener: () => void) { if (event === 'spawn') queueMicrotask(listener); return this; }, removeListener() { return this; }, unref() {} } as unknown as ReturnType<DetachedSpawn>);
  try {
    const result = await defaultTaskLauncher(['harness', 'say', 'goal'], undefined, { runId: 'run-capacity-refused', launchId: 'tl-capacity-refused', env: { ELANOUS_RUN_ID: 'run-capacity-refused' } }, {
      parentHost: [{ host: 'measured', cwd: '/repo', approvalCapacity: 14 }, { host: 'unknown', cwd: '/repo', approvalCapacity: 14 }],
      ssh, spawn, earlyExitWindowMs: 0, launchHoldActive: () => false, notice: () => {},
    });
    expect(result).toEqual({ runId: 'run-capacity-refused' });
    expect(events).toContainEqual(expect.objectContaining({ host: 'measured', gaps: ['capacity-unavailable · host active=4 waiting=10 limit=14 headroom=0'] }));
    expect(events).toContainEqual(expect.objectContaining({ host: 'unknown', gaps: ['capacity-unavailable · measurement=unknown'] }));
    expect(calls.every((call) => !call.includes('nohup'))).toBe(true);
  } finally { off(); }
});
test('tasks repair-outcomes reads repair-result in the card ledger, not rejudge decisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-repair-outcomes-'));
  try {
    const statePath = join(dir, 'cards.json');
    const card: TaskCard = { id: 'ta-repair-1', text: 'fix', createdAt: '2026-10-20T00:00:00Z', status: 'launched',
      history: [
        { at: '2026-10-21T13:10:00Z', event: 'rejudge-on-head', effect: 'repair-applied' },
        { at: '2026-10-21T13:11:00Z', event: 'repair-result', pr: 30001, head: 'a'.repeat(40), runId: 'repair-run-1', effect: 'applied' },
      ] };
    writeTaskCards(statePath, [card]);
    const result = await run(['tasks', 'repair-outcomes', '--since', '2026-10-21T13:00:00Z', '--until', '2026-10-21T14:00:00Z', '--json'], { taskStatePath: statePath });
    expect(result.code ?? 0).toBe(0);
    expect(JSON.parse(result.lines[0]!)).toEqual({ applied: 1, failed: 0, unconfirmed: 0, results: 1, cards: 1, missingRunId: 0, unknownEffect: 0 });
    const invalid = await run(['tasks', 'repair-outcomes', '--since', '2026-10-21T14:00:00Z', '--until', '2026-10-21T13:00:00Z'], { taskStatePath: statePath });
    expect(invalid.code).toBe(1);
    expect(invalid.lines[0]).toContain('순서가 맞는 ISO');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const withDoneBoundary = (text: string): string => `${text}\n완료 경계 코드: src/cli/tasks-cli.ts 의 카드 발사\n완료 경계 실물: 지정한 체크리스트 칸이 한 번 발사된다\n완료 경계 증거 명령: bun test src/cli/tasks-cli.test.ts`;
test('tasks rejudge --all launches at most three new repairs and leaves two for the next tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-repair-tick-cap-'));
  setElanousConfigDir(dir);
  try {
    const statePath = join(dir, 'cards.json');
    const head = 'a'.repeat(40);
    const cards: TaskCard[] = [];
    for (let n = 1; n <= 5; n++) {
      const id = `ta-cap-${n}`;
      const pr = 300 + n;
      const resultPath = reviewResultPath(statePath, id, pr, head);
      const review = JSON.stringify({ pr: String(pr), verdict: 'fail', mustFix: ['fix the assertion'], shouldFix: [],
        reviewed: true, reviewRoute: 'api', headCommit: head });
      mkdirSync(join(dir, 'review-results'), { recursive: true });
      mkdirSync(join(resultPath, '..'), { recursive: true });
      writeFileSync(resultPath, review);
      cards.push({ id, text: 'fix', seat: 'TC', status: 'launched', runId: `run-cap-${n}`,
        createdAt: new Date().toISOString(), pr: { number: pr, url: `https://github.com/o/r/pull/${pr}` },
        reviewRequests: [{ pr, head, at: '2026-10-15T00:01:00Z', resultPath }],
        history: [{ at: '2026-10-15T00:02:00Z', event: 'live-move-result', kind: 'review', pr, head,
          verdict: 'fail', reviewed: true, mustFix: 1, reviewRoute: 'api', resultPath,
          reviewSha256: repairReviewDigest(review), effect: 'review result captured' }] });
    }
    writeTaskCards(statePath, cards);
    const launched: number[] = [];
    const result = await run(['tasks', 'rejudge', '--all', '--json'], {
      taskStatePath: statePath, registerSink: async () => {},
      rejudge: { liveMoves: new Set(['narrow-relaunch']), requestRepair: async (request) => { launched.push(request.pr); },
        live: { repoCandidates: () => [{ source: 'host', cwd: dir }],
          prHead: async (pr) => ({ head, state: 'OPEN', url: `https://github.com/o/r/pull/${pr}`, branch: 'feature' }) } },
    });
    expect(result.code ?? 0).toBe(0);
    const repair = JSON.parse(result.lines[0]!) as Array<{ step: string; decision: string; reason: string }>;
    expect(repair.filter((row) => row.step === 'repair' && row.decision === 'repair-requested')).toHaveLength(3);
    const capped = repair.filter((row) => row.step === 'repair' && row.decision === 'would-repair');
    expect(capped).toHaveLength(2);
    expect(capped.every((row) => row.reason.includes('상한 3') && row.reason.includes('다음 틱'))).toBe(true);
    expect(launched).toHaveLength(3);
    expect(cards.filter((card) => readTaskCard(card.id, statePath)?.repairs?.[0]?.status === 'requested')).toHaveLength(3);
  } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
test('tasks adopt-pr binds an existing OPEN PR once without relaunch and queues head rejudge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-adopt-pr-'));
  try {
    const path = join(dir, 'cards.json');
    const card: TaskCard = { id: 'ta-20261013-adopt', text: 'existing', checklistId: 'EXPORT-CHECK-PWA-DEPS', status: 'launched', runId: 'run-stopped', createdAt: new Date().toISOString(), history: [] };
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

test('tasks adopt-pr --rebind atomically moves a failed old-version PR to a new checklist card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-adopt-rebind-'));
  try {
    const path = join(dir, 'cards.json');
    const url = 'https://github.com/ElanvitalAI/elanous/pull/31230';
    const old: TaskCard = { id: 'ta-old-version', text: 'old cell', checklistId: 'OLD-CELL', checklistVersion: '0.2.36',
      status: 'failed', taLand: true, runId: 'run-old', createdAt: '2026-10-22T00:00:00Z',
      pr: { number: 31230, url }, adoptedPr: { pr: 31230, url, head: 'a'.repeat(40), at: '2026-10-22T01:00:00Z' },
      history: [{ at: '2026-10-22T01:00:00Z', event: 'pr-adopted', pr: 31230, head: 'a'.repeat(40), detail: 'original binding' }] };
    writeTaskCards(path, [old]);
    let launches = 0;
    const deps: TasksCliDeps = {
      taskStatePath: path, registerSink: async () => {}, taskLauncher: async () => { launches++; },
      adoptPrView: () => ({ number: 31230, url, state: 'OPEN', baseRefName: 'main', headRefOid: 'b'.repeat(40) }),
      adoptChecklist: (version) => ({ version, released: '', dev: '', items: version === '0.2.39'
        ? [{ id: 'ADOPT-PR-CROSS-VERSION', title: 'new target', status: 'yellow', updatedAt: '', updatedBy: '' }] : [], history: [] }),
    };
    const result = await run(['tasks', 'adopt-pr', '31230', '--checklist', 'ADOPT-PR-CROSS-VERSION', '--version', '0.2.39', '--rebind', '--json'], deps);
    expect(result.code ?? 0).toBe(0);
    const output = JSON.parse(result.lines[0]!) as { card: string; previousCard: string; pr: number; created: boolean; changed: boolean };
    expect(output).toMatchObject({ previousCard: old.id, pr: 31230, created: true, changed: true });
    const released = readTaskCard(old.id, path)!;
    expect(released.status).toBe('failed');
    expect(released.pr).toBeUndefined();
    expect(released.adoptedPr).toBeUndefined();
    expect(released.taLand).toBeUndefined();
    expect(released.history[0]).toEqual(old.history[0]);
    expect(released.history.at(-1)).toMatchObject({ event: 'pr-rebound-out', pr: 31230, head: 'b'.repeat(40) });
    expect(released.history.at(-1)?.detail).toContain(output.card);
    const adopted = readTaskCard(output.card, path)!;
    expect(adopted).toMatchObject({ checklistId: 'ADOPT-PR-CROSS-VERSION', checklistVersion: '0.2.39', status: 'launched', taLand: true,
      pr: { number: 31230, url }, adoptedPr: { pr: 31230, url, head: 'b'.repeat(40) } });
    expect(adopted.history[0]).toMatchObject({ event: 'pr-adopted', pr: 31230, head: 'b'.repeat(40) });
    expect(launches).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tasks adopt-pr --rebind refuses a live old-card run without exact terminal PR evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-adopt-rebind-live-'));
  try {
    const path = join(dir, 'cards.json');
    const url = 'https://github.com/ElanvitalAI/elanous/pull/31230';
    const old: TaskCard = { id: 'ta-old-live', text: 'old cell', checklistId: 'OLD-CELL', checklistVersion: '0.2.36',
      status: 'launched', taLand: true, runId: 'run-old', createdAt: '2026-10-22T00:00:00Z', history: [], pr: { number: 31230, url } };
    writeTaskCards(path, [old]);
    const result = await run(['tasks', 'adopt-pr', '31230', '--checklist', 'ADOPT-PR-CROSS-VERSION', '--version', '0.2.39', '--rebind'], {
      taskStatePath: path, registerSink: async () => {}, adoptRunTerminal: () => false,
      adoptPrView: () => ({ number: 31230, url, state: 'OPEN', baseRefName: 'main', headRefOid: 'b'.repeat(40) }),
      adoptChecklist: (version) => ({ version, released: '', dev: '', items: [{ id: 'ADOPT-PR-CROSS-VERSION', title: 'new target', status: 'yellow', updatedAt: '', updatedBy: '' }], history: [] }),
    });
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain('원본 런 종결·정확한 PR 근거가 없다');
    expect(readTaskCard(old.id, path)).toEqual(old);
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
    handOpenPrRun: () => ({ status: 0, stdout: '[]' }),
    handOriginRepo: () => 'ElanvitalAI/elanous',
    ...deps, output: (line) => lines.push(line),
  });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', ...args]);
    return { lines, code: process.exitCode };
  } finally { process.exitCode = previous ?? 0; }
}

test('MAPREDUCE-FANOUT 첫 조각으로 읽기 전용 tasks map dry-run CLI 뼈대와 집중 시험을 구현한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-map-dry-run-'));
  const inventoryPath = join(dir, 'inventory.json');
  const statePath = join(dir, 'cards.json');
  const items = [
    { id: 'task-a', text: 'first goal' },
    { id: 'task-b', text: 'second goal' },
    { id: 'task-c', text: 'third goal' },
  ];
  let launches = 0;
  let checklistWrites = 0;
  try {
    writeFileSync(inventoryPath, JSON.stringify(items));
    const full = await run(['tasks', 'map', 'dry-run', '--inventory', inventoryPath, '--json'], {
      taskStatePath: statePath, taskLauncher: () => { launches++; },
      greenSweepWrite: (() => { checklistWrites++; throw new Error('dry-run wrote checklist'); }) as unknown as TasksCliDeps['greenSweepWrite'],
    });
    expect(full.code ?? 0).toBe(0);
    const plan = JSON.parse(full.lines[0]!);
    expect(plan.mode).toBe('dry-run');
    expect(plan.status).toBe('planned');
    expect(plan.rows.map((row: { id: string }) => row.id)).toEqual(['task-a', 'task-b', 'task-c']);
    expect(plan.effects).toEqual({ launched: false, pullRequestWrites: false, checklistWrites: false, autoMerge: false });
    expect(new Set(plan.rows.map((row: { orchestrationId: string }) => row.orchestrationId)).size).toBe(3);
    expect(launches).toBe(0);
    expect(checklistWrites).toBe(0);
    expect(existsSync(statePath)).toBe(false);

    for (const invalid of [items.slice(0, 2), [items[0], items[1], { id: 'task-a', text: 'duplicate' }]]) {
      writeFileSync(inventoryPath, JSON.stringify(invalid));
      const held = await run(['tasks', 'map', 'dry-run', '--inventory', inventoryPath, '--json'], {
        taskStatePath: statePath, taskLauncher: () => { launches++; },
        greenSweepWrite: (() => { checklistWrites++; }) as unknown as TasksCliDeps['greenSweepWrite'],
      });
      expect(held.code).toBe(1);
      expect(JSON.parse(held.lines[0]!).status).toBe('HOLD');
      expect(JSON.parse(held.lines[0]!).rows).toEqual([]);
    }
    expect(launches).toBe(0);
    expect(checklistWrites).toBe(0);
    expect(existsSync(statePath)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tasks map parent command uses the map-run backend and --reduce reads five rows without launching', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-map-adapter-'));
  const sha = 'a'.repeat(40);
  let inventoryReads = 0;
  let launches = 0;
  let checklistWrites = 0;
  const deps: TasksCliDeps = { mapRoot: dir,
    mapInventorySource: async (_recipe, _source, limit) => {
      inventoryReads++;
      expect(limit).toBe(5);
      return { items: Array.from({ length: 5 }, (_, index) => ({ id: `cell-${index + 1}`, text: `verify cell-${index + 1}` })),
        complete: true, snapshotTime: '2026-10-24T00:00:00Z', snapshotRef: 'fixture-0.2.37',
        recipeSha: sha, mainSha: sha, checklistSnapshotPath: join(dir, 'checklist.json'),
        requestedPool: 'cold-job', selectedPool: null, imageCommit: null };
    },
    taskLauncher: () => { launches++; },
    greenSweepWrite: (() => { checklistWrites++; }) as unknown as TasksCliDeps['greenSweepWrite'],
  };
  try {
    const mapped = await run(['tasks', 'map', '--recipe', 'green-close', '--from', 'landed-but-yellow',
      '--limit', '5', '--concurrency', '2', '--dry-run', '--json'], deps);
    expect(mapped.code ?? 0).toBe(0);
    const result = JSON.parse(mapped.lines[0]!);
    expect(result).toMatchObject({ status: 'preview-only', expected: 5, observed: 5, dryRun: true,
      launched: 0, writes: 0 });
    expect(result.markdown.match(/^\| cell-\d \|/gm)).toHaveLength(5);
    expect(inventoryReads).toBe(1);
    expect(launches).toBe(0);
    expect(checklistWrites).toBe(0);
    const reduced = await run(['tasks', 'map', '--reduce', result.mapRunId, '--json'], deps);
    expect(reduced.code ?? 0).toBe(0);
    expect(JSON.parse(reduced.lines[0]!).markdown.match(/^\| cell-\d \|/gm)).toHaveLength(5);
    expect(inventoryReads).toBe(1);
    const conflictingReduce = await run(['tasks', 'map', '--reduce', result.mapRunId, '--dry-run', '--json'], deps);
    expect(conflictingReduce.code).toBe(1);
    expect(JSON.parse(conflictingReduce.lines[0]!)).toMatchObject({ status: 'HOLD', reason: 'reduce-options-conflict' });
    const conflictingModes = await run(['tasks', 'map', '--recipe', 'green-close', '--from', 'landed-but-yellow',
      '--limit', '5', '--live', '--dry-run', '--json'], deps);
    expect(conflictingModes.code).toBe(1);
    expect(JSON.parse(conflictingModes.lines[0]!)).toMatchObject({ status: 'HOLD', reason: 'live-dry-run-conflict' });
    expect(inventoryReads).toBe(1);
    const live = await run(['tasks', 'map', '--recipe', 'green-close', '--from', 'landed-but-yellow',
      '--limit', '5', '--live', '--json'], deps);
    expect(live.code ?? 0).toBe(0);
    expect(JSON.parse(live.lines[0]!)).toMatchObject({ status: 'host-graph-run', expected: 5, observed: 5,
      attempted: 5, externalWrites: 0 });
    expect(JSON.parse(live.lines[0]!).markdown).toContain('recipe-input-missing');
    expect(inventoryReads).toBe(2);
    const invalidSource = await run(['tasks', 'map', '--recipe', 'green-close', '--from', 'typo', '--json'], deps);
    expect(invalidSource.code).toBe(1);
    expect(JSON.parse(invalidSource.lines[0]!)).toMatchObject({ status: 'HOLD', reason: 'source-invalid', launched: 0 });
    const invalidLimit = await run(['tasks', 'map', '--recipe', 'green-close', '--from', 'landed-but-yellow',
      '--limit', '1001', '--json'], deps);
    expect(invalidLimit.code).toBe(1);
    expect(JSON.parse(invalidLimit.lines[0]!)).toMatchObject({ status: 'HOLD', reason: 'limit-out-of-range: 1..1000' });
    const failedRead = await run(['tasks', 'map', '--recipe', 'green-close', '--from', 'landed-but-yellow', '--json'], {
      ...deps, mapInventorySource: async () => { throw new Error('inventory-read-failed'); },
    });
    expect(failedRead.code).toBe(1);
    expect(JSON.parse(failedRead.lines[0]!)).toMatchObject({ status: 'HOLD', reason: 'inventory-read-failed', launched: 0 });
    expect(inventoryReads).toBe(2);
    expect(launches).toBe(0);
    expect(checklistWrites).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tasks map --live runs one real read-only draft graph in an isolated state root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-map-host-live-'));
  setElanousConfigDir(dir);
  const sha = 'a'.repeat(40);
  const headOid = 'b'.repeat(40);
  try {
    const result = await run(['tasks', 'map', '--recipe', 'draft-close', '--from', 'drafts',
      '--ids', 'pr-123,pr-999', '--limit', '2', '--concurrency', '2', '--live', '--json'], {
      mapRoot: dir,
      mapInventorySource: async (_recipe, _source, _limit, mapRunId) => {
        const snapshotTime = '2026-10-24T01:00:00Z';
        const item = { pr: 123, headOid, repository: 'example/repo', state: 'open', isDraft: true,
          labels: ['elanous:running'], branch: 'fixture', title: 'protected fixture', body: '',
          createdAt: '2026-10-23T01:00:00Z', changedFiles: [], changedFilesComplete: true,
          latestFileChanges: {}, openDraftsComplete: true, mergedTwinsComplete: false };
        return { items: [{ id: 'pr-123', text: item.title,
          graphInput: { mapRunId, snapshotTime, inventoryComplete: true,
            inventory: { complete: true, snapshotTime, mainSha: sha, items: [item] }, mainSha: sha, item } }],
          complete: true, snapshotTime, snapshotRef: 'fixture@protected-draft', recipeSha: sha,
          mainSha: sha, checklistSnapshotPath: null, requestedPool: 'node-b', selectedPool: 'node-b', imageCommit: null };
      },
    });
    expect(result.code ?? 0).toBe(0);
    const output = JSON.parse(result.lines[0]!);
    expect(output).toMatchObject({ status: 'host-graph-run', expected: 2, observed: 2, attempted: 2, externalWrites: 0 });
    const stored = readMapRun(output.mapRunId, dir);
    expect(stored.rows).toHaveLength(2);
    const draftRow = stored.rows.find((row) => row.itemId === 'pr-123');
    const absentRow = stored.rows.find((row) => row.itemId === 'pr-999');
    expect(draftRow).toMatchObject({ itemId: 'pr-123', kind: 'hold',
      result: { transport: 'host-graph-run' } });
    expect(absentRow).toMatchObject({ itemId: 'pr-999', kind: 'hold', reason: 'requested-id-not-in-eligible-inventory' });
    expect(draftRow?.result?.cardId).toMatch(/^map-card-/);
    expect(draftRow?.podJob).toBeUndefined();
  } finally { resetElanousConfigDir(); rmSync(dir, { recursive: true, force: true }); }
});

test('tasks map --ids selects only requested inventory IDs and records absent IDs as HOLD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-map-ids-'));
  const sha = 'a'.repeat(40);
  let receivedLimit: number | undefined = 0;
  const deps: TasksCliDeps = { mapRoot: dir, mapInventorySource: async (_recipe, _source, limit) => {
    receivedLimit = limit;
    return { items: [{ id: 'OTHER', text: 'other' }, { id: 'TARGET', text: 'target' }],
      complete: true, snapshotTime: '2026-10-24T00:00:00Z', snapshotRef: 'fixture',
      recipeSha: sha, mainSha: sha, checklistSnapshotPath: join(dir, 'checklist.json'),
      requestedPool: 'node-b', selectedPool: null, imageCommit: null };
  } };
  try {
    const mapped = await run(['tasks', 'map', '--recipe', 'green-close', '--from', 'landed-but-yellow',
      '--ids', 'TARGET,MISSING', '--live', '--json'], deps);
    expect(mapped.code ?? 0).toBe(0);
    const output = JSON.parse(mapped.lines[0]!);
    expect(output).toMatchObject({ expected: 2, observed: 2, status: 'host-graph-run' });
    expect(receivedLimit).toBeUndefined();
    const stored = readMapRun(output.mapRunId, dir);
    expect(stored.start.itemIds).toEqual(['TARGET', 'MISSING']);
    expect(stored.rows.map((row) => [row.itemId, row.reason])).toEqual([
      ['TARGET', 'recipe-input-missing'], ['MISSING', 'requested-id-not-in-eligible-inventory'],
    ]);
    for (const csv of ['TARGET,TARGET', 'TARGET,', Array.from({ length: 11 }, (_, i) => `ID${i}`).join(',')]) {
      const invalid = await run(['tasks', 'map', '--recipe', 'green-close', '--from', 'landed-but-yellow',
        '--ids', csv, '--live', '--json'], deps);
      expect(invalid.code).toBe(1);
      expect(JSON.parse(invalid.lines[0]!)).toMatchObject({ status: 'HOLD', reason: 'map-ids-invalid-or-duplicate: max 10' });
    }
    const shortLimit = await run(['tasks', 'map', '--recipe', 'green-close', '--from', 'landed-but-yellow',
      '--ids', 'TARGET,MISSING', '--limit', '1', '--json'], deps);
    expect(JSON.parse(shortLimit.lines[0]!)).toMatchObject({ status: 'HOLD', reason: 'map-ids-exceed-limit' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tasks green-sweep defaults to dry-run and --apply writes only after main E1/E2 checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'green-sweep-live-write-'));
  const sha = 'a'.repeat(40);
  const item = { id: 'CELL', title: '대상 경로: src/task-agent/green-sweep.ts\n- 완료 경계 증거 명령: bun test src/task-agent/green-sweep.test.ts',
    status: 'yellow' as const, evidence: '판정: green\nPR #123 merged', updatedAt: '2026-10-24T00:00:00Z', updatedBy: 'test' };
  const writes: unknown[][] = [];
  const evidenceCalls: string[][] = [];
  const baseDeps: TasksCliDeps = {
    greenSweepChecklist: () => ({ version: '0.2.37', released: '0.2.36', dev: '0.2.37-dev.0', items: [item], history: [] }),
    taskStatePath: join(dir, 'empty-task-state.json'),
    greenSweepRun: (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'git remote get-url origin') return { status: 0, stdout: 'https://github.com/example/repo.git' };
      if (key === 'git rev-parse origin/main' || key === 'git rev-parse HEAD') return { status: 0, stdout: sha };
      if (key === 'git ls-remote origin refs/heads/main') return { status: 0, stdout: `${sha}\trefs/heads/main` };
      if (key === 'git status --porcelain --untracked-files=all') return { status: 0, stdout: '' };
      if (key === 'gh pr view 123 --json number,state,mergeCommit,url')
        return { status: 0, stdout: JSON.stringify({ number: 123, state: 'MERGED', mergeCommit: { oid: sha }, url: 'https://github.com/example/repo/pull/123' }) };
      if (key === `git merge-base --is-ancestor ${sha} origin/main`) return { status: 0, stdout: '' };
      throw new Error(`unexpected command: ${key}`);
    },
    greenSweepEvidenceRun: (args) => { evidenceCalls.push(args); return { status: 0, stdout: '13 pass' }; },
    greenSweepWrite: (...args) => { writes.push(args); return { version: '0.2.37', released: '0.2.36', dev: '0.2.37-dev.0', items: [item], history: [] }; },
  };
  try {
    writeFileSync(join(dir, 'traffic.json'), JSON.stringify({ hold: [] }));
    const dryRun = await run(['tasks', 'green-sweep', '--version', '0.2.37', '--cell', 'CELL', '--traffic', join(dir, 'traffic.json'), '--json'], baseDeps);
    expect(dryRun.code ?? 0).toBe(0);
    expect(JSON.parse(dryRun.lines[0]!).dryRun).toBe(true);
    expect(evidenceCalls).toEqual([]);
    expect(writes).toEqual([]);

    const applied = await run(['tasks', 'green-sweep', '--version', '0.2.37', '--cell', 'CELL', '--traffic', join(dir, 'traffic.json'), '--apply', '--json'], baseDeps);
    expect(applied.code ?? 0).toBe(0);
    const result = JSON.parse(applied.lines[0]!);
    expect(result).toMatchObject({ dryRun: false, e2: 'main-clean', writes: [{ cell: 'CELL', written: true }] });
    expect(evidenceCalls).toEqual([['src/task-agent/green-sweep.test.ts']]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[2]).toMatchObject({ status: 'green' });
    expect((writes[0]?.[2] as { evidence: string }).evidence).toContain('판정: green');

    const e2Failed = await run(['tasks', 'green-sweep', '--version', '0.2.37', '--cell', 'CELL', '--traffic', join(dir, 'traffic.json'), '--apply', '--json'], {
      ...baseDeps, greenSweepEvidenceRun: () => ({ status: 1, stdout: 'fixture failure' }),
    });
    expect(e2Failed.lines).toHaveLength(1);
    expect(JSON.parse(e2Failed.lines[0]!)).toMatchObject({ e2: 'failed', writes: [{ cell: 'CELL', written: false, reason: 'main-evidence-not-passed' }], e2Failure: 'E2 failed · CELL · rc=1 · fixture failure' });
    expect(writes).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
}, 30000); // 10만 행 goal_ask 삽입이 pod 부하에 따라 5s 기본 상한을 넘는다.

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
    const inlinedEvents = events.filter((event) => event.event === 'goal-file-inlined');
    expect(inlinedEvents).toHaveLength(1);
    expect(inlinedEvents[0]).toMatchObject({ event: 'goal-file-inlined', data: { path, chars: sentence.length, sha256: createHash('sha256').update(sentence).digest('hex') } });
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
    { id: 'cell-1', level: 'task', title: withDoneBoundary('대상 경로: src/thing.ts\n구현 계약 그대로'), status: 'open' },
  ] }];
  const launcherCalls: string[][] = [];
  const deps: TasksCliDeps = {
    taskStatePath: join(dir, 'cards.json'), registerSink: async () => true, releaseBoard: () => releaseBoard,
    taskLauncher: (args) => { launcherCalls.push(args); },
  };

  const omitted = await run(['tasks', 'hand', '--checklist', 'cell-1', '--live', '--json'], deps);
  expect(omitted.code ?? 0).toBe(0);
  expect(JSON.parse(omitted.lines[0]!).move.command.at(-1)).toBe(withDoneBoundary('대상 경로: src/thing.ts\n구현 계약 그대로'));
  expect(launcherCalls).toHaveLength(1);
  expect(launcherCalls[0]!.at(-1)).toBe(withDoneBoundary('대상 경로: src/thing.ts\n구현 계약 그대로'));

  const valid = await run(['tasks', 'hand', withDoneBoundary('대상 경로: src/supplied.ts\n세부'), '--checklist', 'cell-1', '--live', '--json'], deps);
  expect(valid.code ?? 0).toBe(0);
  expect(JSON.parse(valid.lines[0]!).move.command.at(-1)).toBe(withDoneBoundary('대상 경로: src/supplied.ts\n세부'));
  expect(launcherCalls[1]!.at(-1)).toBe(withDoneBoundary('대상 경로: src/supplied.ts\n세부'));

  const invalid = await run(['tasks', 'hand', '임의의 문면', '--checklist', 'cell-1', '--live'], deps);
  expect(invalid.code).toBe(1);
  expect(invalid.lines).toEqual(['칸 문면을 쓰려면 문면 인자를 빼라']);
  expect(launcherCalls).toHaveLength(2);
  expect(launcherCalls[0]!.at(-1)).toBe(withDoneBoundary('대상 경로: src/thing.ts\n구현 계약 그대로'));

  const project = await run(['tasks', 'hand', '--checklist', 'project', '--live'], deps);
  expect(project.code).toBe(1);
  expect(project.lines).toEqual(['체크리스트 칸 없음: project']);
  expect(launcherCalls).toHaveLength(2);
  const projectWithText = await run(['tasks', 'hand', '대상 경로: src/thing.ts', '--checklist', 'project', '--live'], deps);
  expect(projectWithText.code).toBe(1);
  expect(projectWithText.lines).toEqual(['체크리스트 칸 없음: project']);
  expect(launcherCalls).toHaveLength(2);
});

test('tasks hand reuses one OPEN PR for its release cell and fails closed on an incomplete or ambiguous census', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-hand-open-pr-'));
  const version = checklistDevVersion();
  const cell = 'LAUNCH-SKIP-OPEN-PR';
  const title = withDoneBoundary('대상 경로: src/cli/tasks-cli.ts\n기존 PR 수확');
  const statePath = join(dir, 'cards.json');
  let launched = 0;
  const censusArgs: string[][] = [];
  const row = (number: number) => ({ number, body: `칸: ${cell}` });
  const base: TasksCliDeps = {
    taskStatePath: statePath, registerSink: async () => true,
    releaseBoard: () => [{ id: 'project', level: 'project', title: 'Project', status: 'open', children: [
      { id: cell, level: 'task', title, status: 'open' },
    ] }],
    adoptChecklist: (foundVersion) => ({ version: foundVersion, released: '', dev: '', items: [{ id: cell, title, status: 'yellow', updatedAt: '', updatedBy: '' }], history: [] }),
    adoptPrView: () => ({ number: 30262, url: 'https://github.com/ElanvitalAI/elanous/pull/30262', state: 'OPEN', baseRefName: 'main', headRefOid: 'a'.repeat(40) }),
    taskLauncher: () => { launched++; },
    handOriginRepo: () => 'ElanvitalAI/elanous',
  };
  try {
    for (const result of [
      { status: 1, stdout: '' },
      { status: 0, stdout: JSON.stringify([row(30262), row(30263)]) },
      { status: 0, stdout: JSON.stringify(Array.from({ length: 500 }, (_, n) => row(n + 1))) },
    ]) {
      const denied = await run(['tasks', 'hand', '--checklist', cell, '--version', version, '--live', '--json'],
        { ...base, handOpenPrRun: (_command, args) => { censusArgs.push(args); return result; } });
      expect(denied.code).toBe(1);
      expect(denied.lines.join('\n')).toContain('구현 발사 0');
      expect(existsSync(statePath)).toBe(false);
      expect(launched).toBe(0);
    }
    const wrongNumber = await run(['tasks', 'hand', '--checklist', cell, '--version', version, '--live'], {
      ...base, handOpenPrRun: () => ({ status: 0, stdout: JSON.stringify([row(30262)]) }),
      adoptPrView: () => ({ number: 30263, url: 'https://github.com/ElanvitalAI/elanous/pull/30263', state: 'OPEN', baseRefName: 'main', headRefOid: 'a'.repeat(40) }),
    });
    expect(wrongNumber.code).toBe(1);
    expect(wrongNumber.lines.join('\n')).toContain('조회 PR 번호가 다르다');
    expect(existsSync(statePath)).toBe(false);
    const doneCell = await run(['tasks', 'hand', '--checklist', cell, '--version', version, '--live'], {
      ...base, handOpenPrRun: () => ({ status: 0, stdout: JSON.stringify([row(30262)]) }),
      adoptChecklist: (foundVersion) => ({ version: foundVersion, released: '', dev: '', items: [{ id: cell, title, status: 'green', updatedAt: '', updatedBy: '' }], history: [] }),
    });
    expect(doneCell.code).toBe(1);
    expect(doneCell.lines.join('\n')).toContain('입양할 미완 칸 없음');
    expect(existsSync(statePath)).toBe(false);
    expect(launched).toBe(0);
    const adopted = await run(['tasks', 'hand', '--checklist', cell, '--version', version, '--live', '--json'],
      { ...base, handOpenPrRun: (_command, args) => { censusArgs.push(args); return { status: 0, stdout: JSON.stringify([row(30262)]) }; } });
    expect(adopted.code ?? 0).toBe(0);
    const response = JSON.parse(adopted.lines[0]!);
    expect(response).toMatchObject({ pr: 30262, head: 'a'.repeat(40), launched: false });
    expect(readTaskCard(response.card, statePath)?.pr).toEqual({ number: 30262, url: 'https://github.com/ElanvitalAI/elanous/pull/30262' });
    expect(censusArgs.every((args) => args.includes('--repo') && args[args.indexOf('--repo') + 1] === 'ElanvitalAI/elanous')).toBe(true);
    expect(launched).toBe(0);
    const alreadyBound = await run(['tasks', 'hand', '--checklist', cell, '--version', version, '--live', '--json'],
      { ...base, handOpenPrRun: () => ({ status: 0, stdout: JSON.stringify([row(30262)]) }) });
    expect(alreadyBound.code ?? 0).toBe(0);
    expect(JSON.parse(alreadyBound.lines[0]!)).toMatchObject({ card: response.card, pr: 30262, launched: false });
    expect(launched).toBe(0);
    const noMatch = await run(['tasks', 'hand', '--checklist', cell, '--version', version, '--live', '--json'], {
      ...base, taskStatePath: join(dir, 'empty-match-cards.json'),
      handOpenPrRun: () => ({ status: 0, stdout: '[]' }),
    });
    expect(noMatch.code ?? 0).toBe(0);
    expect(JSON.parse(noMatch.lines[0]!).launched).toBe(true);
    expect(launched).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('task hand --checklist reads the current release cell through the default board', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-default-checklist-'));
  const title = withDoneBoundary('대상 경로: src/real.ts\n현재 판 칸 원문');
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
  const title = withDoneBoundary('대상 경로: src/later-release.ts\n다음 판 칸 원문');
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
}, 30000); // checklist 원장 조회가 pod 부하에 따라 5s 기본 상한을 넘는다.

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
      ...(version === later || version === latest ? [{ id: 'NEXT', level: 'task' as const, title: withDoneBoundary(`대상 경로: src/${version}.ts`), status: 'open' as const }] : []),
    ] }],
    taskLauncher: (args) => { launches.push(args); },
  };
  try {
    const next = await run(['tasks', 'hand', '--checklist', 'NEXT', '--live', '--json'], deps);
    expect(next.code ?? 0).toBe(0);
    expect(JSON.parse(next.lines[0]!).card.text).toBe(withDoneBoundary(`대상 경로: src/${later}.ts`));
    expect(launches[0]!.at(-1)).toBe(withDoneBoundary(`대상 경로: src/${later}.ts`));
    expect(warnings.some((line) => line.includes(`가장 가까운 판 ${later}`))).toBe(true);
    const pinned = await run(['tasks', 'hand', '--checklist', 'NEXT', '--version', latest, '--live', '--json'], deps);
    expect(pinned.code ?? 0).toBe(0);
    expect(JSON.parse(pinned.lines[0]!).card.text).toBe(withDoneBoundary(`대상 경로: src/${latest}.ts`));
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
        { id: 'DUP', level: 'task', title: withDoneBoundary(`대상 경로: src/${version}.ts`), status: 'open' },
      ] }],
      taskLauncher: () => {},
    });
    expect(result.code ?? 0).toBe(0);
    expect(JSON.parse(result.lines[0]!).card.text).toBe(withDoneBoundary(`대상 경로: src/${current}.ts`));
    expect(warnings.some((line) => line.includes(`가장 가까운 판 ${current}`))).toBe(true);
  } finally { console.error = originalError; }
});

test('task hand keeps the current board available and ignores a broken unrelated release board', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-broken-release-'));
  const current = checklistDevVersion();
  const [major, minor, patch] = current.split('.').map(Number);
  const unrelated = `${major}.${minor}.${patch! + 1}`;
  const title = withDoneBoundary('대상 경로: src/current.ts');
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
  const title = withDoneBoundary('기존 칸 문면\n둘째 줄 그대로');
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
  expect(command?.commands.map((entry) => entry.name())).toEqual(['work-order', 'green-sweep', 'cover', 'repair-outcomes', 'outcomes', 'doctor', 'list', 'map', 'hand', 'tag', 'hand-move', 'live-verified', 'close', 'parents', 'adopt-pr', 'adopt-runs', 'board', 'advance', 'show', 'rejudge', 'regate-run', 'repair-run', 'approve']);
  expect(command?.commands.find((entry) => entry.name() === 'map')?.commands.map((entry) => entry.name())).toEqual(['dry-run']);
  expect(command?.commands.find((entry) => entry.name() === 'work-order')?.commands.map((entry) => entry.name())).toEqual(['build']);
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

test('live checklist hand sends its slot through the production detached launcher environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-slot-launch-'));
  const releaseBoard: BoardNode[] = [{ id: 'project', level: 'project', title: 'Project', status: 'open', children: [
    { id: 'TA-DRAFT-NO-LEFTOVER', level: 'task', title: withDoneBoundary('대상 경로: src/example.ts'), status: 'open' },
  ] }];
  const seen: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const fakeSpawn = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    seen.push({ command, args, env: options.env });
    const handlers: Record<string, () => void> = {};
    setTimeout(() => handlers.spawn?.(), 0);
    return { pid: 1, once: (event: string, fn: () => void) => { handlers[event] = fn; }, removeListener: () => undefined, unref: () => undefined };
  }) as unknown as DetachedSpawn;
  try {
    const result = await run(['tasks', 'hand', '--checklist', 'TA-DRAFT-NO-LEFTOVER', '--live', '--json'], {
      taskStatePath: join(dir, 'cards.json'), registerSink: async () => true, releaseBoard: () => releaseBoard,
      taskLauncher: (args, cwd, context) => defaultTaskLauncher(args, cwd, context,
        { parentHost: null, spawn: fakeSpawn, earlyExitWindowMs: 0 }),
    });
    expect(result.code ?? 0).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.args[0]).toBe(ELANOUS_CLI_ENTRY);
    expect(seen[0]!.env?.ELANOUS_POD_SLOT_ID).toBe('TA-DRAFT-NO-LEFTOVER');
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

// ⛔ R7(2026-10-16): context 가 있으면 원격 부모 경로가 가짜 spawn 보다 먼저 돈다 — 시험은 `parentHost: null` 로 원격을 끈다
// (비우면 운영 `taskAgent.parentHost` 로 진짜 ssh 발사가 나갔다 · 호스트 재게이트 실사고).
const launchContext = (runId: string) => ({ runId, launchId: 'tl-test', env: { ELANOUS_RUN_ID: runId } });

test('STOP-RECORD launch-failed: a child that exits nonzero right after launch writes exactly one stop line and throws', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const written: RunLedgerEntry[] = [];
  const longTail = `error: unknown command 'tick.ts'\n${Array.from({ length: 40 }, (_, i) => `    at frame${i} (x.ts:${i})`).join('\n')}`;
  const { spawn, stdio } = exitingSpawn(2, longTail);
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0001'),
    { parentHost: null, spawn, stderrDir, earlyExitWindowMs: 1_000, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow('rc=2');
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
    { parentHost: null, spawn: exitingSpawn(null).spawn, stderrDir, earlyExitWindowMs: 50, writeStop: (entry) => { written.push(entry); } });
  expect(alive).toEqual({ runId: 'run-launchok-0001' });
  const clean = await defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchok-0002'),
    { parentHost: null, spawn: exitingSpawn(0).spawn, stderrDir, earlyExitWindowMs: 1_000, writeStop: (entry) => { written.push(entry); } });
  expect(clean).toEqual({ runId: 'run-launchok-0002' });
  expect(written).toHaveLength(0);
});

test('STOP-RECORD launch-failed: no stderr still records rc only', async () => {
  const written: RunLedgerEntry[] = [];
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0002'),
    { parentHost: null, spawn: exitingSpawn(7).spawn, stderrDir: mkdtempSync(join(tmpdir(), 'tasks-cli-launch-')), earlyExitWindowMs: 1_000, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow();
  expect(written.map((entry) => entry.data.cause)).toEqual(['child rc=7']);
});

test('STOP-RECORD launch-failed: a rerun truncates the old stderr and an existing stop is not duplicated (review must-fix)', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  writeFileSync(join(stderrDir, 'run-launchfail-0003.stderr'), 'stale error from the previous attempt\n');
  const written: RunLedgerEntry[] = [];
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0003'),
    { parentHost: null, spawn: exitingSpawn(3, 'fresh error\n').spawn, stderrDir, earlyExitWindowMs: 1_000, hasStop: () => false, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow('fresh error');
  expect(written.map((entry) => entry.data.cause)).toEqual(['child rc=3: fresh error']);
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0004'),
    { parentHost: null, spawn: exitingSpawn(3, 'boom\n').spawn, stderrDir, earlyExitWindowMs: 1_000, hasStop: () => true, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow('rc=3');
  expect(written).toHaveLength(1);
});

test('STOP-RECORD launch-failed: through task hand --live the card is launch-failed, not launched', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const taskStatePath = join(mkdtempSync(join(tmpdir(), 'tasks-cli-card-')), 'task-agent-actions.json');
  const written: RunLedgerEntry[] = [];
  const result = await run(['task', 'hand', 'ship it', '--live'], {
    taskStatePath, registerSink: async () => true,
    taskLauncher: (args, cwd, context) => defaultTaskLauncher(args, cwd, context,
      { parentHost: null, spawn: exitingSpawn(2, 'error: bad argv\n').spawn, stderrDir, earlyExitWindowMs: 1_000, hasStop: () => false, writeStop: (entry) => { written.push(entry); } }),
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

test('CARD-GOAL-BODY-EXPOSE — tasks show --json includes bounded authored-goal evidence and section flags', async () => {
  const taskStatePath = join(mkdtempSync(join(tmpdir(), 'tasks-card-goal-')), 'task-agent-actions.json');
  const goalBody = [
    '# Goal',
    '## TDD Plan',
    'Write a failing test first.',
    '## 완료 경계',
    'Focused test passes.',
    '[KNOWHOW-PACK v1 ids=K-MK-01]',
    'x'.repeat(9_000),
  ].join('\n');
  writeFileSync(taskStatePath, JSON.stringify({ tasks: { 'ta-goal-proof': {
    id: 'ta-goal-proof', text: 'implement goal', goalId: 'a'.repeat(16), runId: 'run-goal-proof',
    createdAt: '2026-10-25T00:00:00.000Z', status: 'launched', history: [],
  } } }));
  const result = await run(['tasks', 'show', 'ta-goal-proof', '--json'], {
    taskStatePath, registerSink: async () => true,
    cardGoalDocument: (goalId) => goalId === 'a'.repeat(16) ? { goalFile: 'docs/goals/GOAL-proof.md', goalBody } : null,
  });
  const json = JSON.parse(result.lines[0] ?? '{}');
  expect(json).toMatchObject({
    goalFile: 'docs/goals/GOAL-proof.md', hasTddPlan: true, hasBoundary: true, knowhowInjected: true,
  });
  expect(json.goalBody).toContain('## TDD Plan');
  expect(json.goalBody.length).toBeLessThan(goalBody.length);
  expect(json.goalBody).toContain('[KNOWHOW-PACK v1 ids=K-MK-01]');
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
  mkdirSync(join(dir, 'apps/pwa/node_modules'), { recursive: true });
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
    id: 'ta-rj', text: 'x', createdAt: new Date().toISOString(), status: 'launched', pr: { number: 30, url: 'https://github.com/o/r/pull/30' },
    reviewRequests: [{ pr: 30, head: a, at: '2026-10-11T00:10:00.000Z' }], history: [],
  } } }));
  const result = await run(['tasks', 'rejudge', '--all'], { taskStatePath, registerSink: async () => true, rejudge: {
    liveMoves: new Set(),
    live: { repoCandidates: () => [{ source: 'host', cwd: '/repo' }], prHead: async () => ({ head: a, state: 'OPEN', url: 'https://github.com/o/r/pull/30' }) },
  } });
  expect(result.lines).toEqual([`ta-rj\tPR #30\t${a.slice(0, 12)}→${a.slice(0, 12)}\ttarget\thead-unchanged\tPR #30 head is still the judged head`]);
});

test('tasks rejudge --all applies configured card age limit while explicit card lookup remains available', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-cli-age-limit-'));
  const taskStatePath = join(root, 'cards.json');
  const head = 'a'.repeat(40);
  const id = 'ta-age-80h';
  const url = 'https://github.com/o/r/pull/30';
  setElanousConfigDir(root);
  try {
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ taskAgent: { rejudgeMaxAgeHours: 96 } }));
    resetUserConfig();
    const firstMtimeMs = statSync(configPath).mtimeMs;
    writeTaskCards(taskStatePath, [{ id, text: 'old card', createdAt: new Date(Date.now() - 80 * 3_600_000).toISOString(),
      status: 'launched', pr: { number: 30, url }, reviewRequests: [{ pr: 30, head, at: new Date().toISOString() }], history: [] }]);
    const deps: TasksCliDeps = { taskStatePath, registerSink: async () => true, rejudge: { liveMoves: new Set(),
      prFiles: async () => ['src/feature.ts'], live: { repoCandidates: () => [{ source: 'host', cwd: root }],
        prHead: async () => ({ head, state: 'OPEN', url }) } } };
    const configured = await run(['tasks', 'rejudge', '--all', '--json'], deps);
    expect(JSON.parse(configured.lines[0]!)?.[0]?.decision).toBe('head-unchanged');
    writeFileSync(configPath, JSON.stringify({ taskAgent: { rejudgeMaxAgeHours: 72 } }));
    // 재작성이 첫 쓰기와 같은 mtime 으로 떨어져도(getUserConfig 는 mtime 으로만 캐시를 무효화한다)
    // 새 나이 제한이 읽혀야 한다는 계약을 고정 시각으로 재현하고, 캐시를 떨궈 결정적으로 만든다.
    utimesSync(configPath, firstMtimeMs / 1000, firstMtimeMs / 1000);
    resetUserConfig();
    const capped = await run(['tasks', 'rejudge', '--all', '--json'], deps);
    expect(JSON.parse(capped.lines[0]!)).toEqual([]);
    const explicit = await run(['tasks', 'rejudge', id, '--json'], deps);
    expect(JSON.parse(explicit.lines[0]!)?.[0]?.decision).toBe('head-unchanged');
  } finally { resetElanousConfigDir(); resetUserConfig(); rmSync(root, { recursive: true, force: true }); }
});

test('tasks rejudge --all requests at most one review across remote cards in one tick', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-cli-review-tick-'));
  const statePath = join(root, 'task-agent-actions.json');
  const head = 'a'.repeat(40);
  const cards: TaskCard[] = [30, 31].map((pr) => ({ id: `ta-review-${pr}`, text: 'review', createdAt: new Date().toISOString(),
    status: 'launched', taLand: true, runId: `run-${pr}`, runChildId: `child-${pr}`,
    parentHost: { host: 'node-b' }, pr: { number: pr, url: `https://github.com/o/r/pull/${pr}` }, history: [] }));
  writeTaskCards(statePath, cards);
  const requested: number[] = [];
  try {
    const result = await run(['tasks', 'rejudge', '--all', '--json'], {
      taskStatePath: statePath, registerSink: async () => true, remoteLedgerMirror: () => {},
      rejudge: { liveMoves: new Set(['review']), remoteRunTerminal: () => true,
        live: { repoCandidates: () => [{ source: 'host', cwd: root }],
          prHead: async (pr) => ({ head, state: 'OPEN', url: `https://github.com/o/r/pull/${pr}` }),
          requestReview: async (pr) => { requested.push(pr); } } },
    });
    const outcomes = JSON.parse(result.lines[0]!) as Array<{ decision: string }>;
    expect(requested).toEqual([30]);
    expect(outcomes.map((row) => row.decision)).toContain('tick-cap');
    expect(readTaskCard('ta-review-31', statePath)?.reviewRequests).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tasks rejudge --all queues one exact-head mf0 card and caps the next land attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-cli-land-tick-'));
  const statePath = join(root, 'task-agent-actions.json');
  const head = 'a'.repeat(40);
  const cards: TaskCard[] = [30, 31].map((pr) => {
    const id = `ta-land-${pr}`;
    const resultPath = reviewResultPath(statePath, id, pr, head);
    mkdirSync(join(resultPath, '..'), { recursive: true });
    writeFileSync(resultPath, JSON.stringify({ pr: String(pr), headCommit: head, verdict: 'pass', mustFix: [],
      shouldFix: [], reviewed: true, reviewRoute: 'api' }));
    return { id, text: 'land', createdAt: new Date(Date.now() - (31 - pr) * 60_000).toISOString(), status: 'launched', taLand: true,
      pr: { number: pr, url: `https://github.com/o/r/pull/${pr}` },
      reviewRequests: [{ pr, head, at: new Date().toISOString(), resultPath }],
      history: [{ at: new Date().toISOString(), event: 'live-move-result', kind: 'review', pr, head,
        verdict: 'pass', reviewed: true, mustFix: 0, resultPath, effect: 'review result captured' }] };
  });
  writeTaskCards(statePath, cards);
  const queued: number[] = [];
  try {
    const result = await run(['tasks', 'rejudge', '--all', '--json'], { taskStatePath: statePath, registerSink: async () => true,
      rejudge: { liveMoves: new Set(['propose-land']), prFiles: async () => ['src/feature.ts'],
        live: { repoCandidates: () => [{ source: 'host', cwd: root }],
          prHead: async (pr) => ({ head, state: 'OPEN', branch: 'feature', url: `https://github.com/o/r/pull/${pr}` }),
          landPrHead: async (pr) => ({ head, state: 'OPEN', branch: 'feature', isDraft: false, url: `https://github.com/o/r/pull/${pr}` }),
          landQueueConfig: { command: '/ops/land-enqueue.sh', remote: 'node-b' },
          landWorktree: { localHead: () => head, localBranch: () => 'feature' },
          queueLanding: async ({ pr }) => { queued.push(pr); return { status: 0, stdout: `OK #${pr} queued` }; } } },
    });
    const outcomes = JSON.parse(result.lines[0]!) as Array<{ card: string; step: string; decision: string }>;
    expect(queued).toEqual([31]);
    expect(outcomes.some((row) => row.card === 'ta-land-30' && row.step === 'land' && row.decision === 'tick-cap')).toBe(true);
    expect(readTaskCard('ta-land-30', statePath)?.landAttempts ?? []).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tasks rejudge --all bounds mf0 head probes and does not promote stale-head or wrong-URL reviews', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-cli-head-priority-'));
  const statePath = join(root, 'cards.json');
  const head = 'a'.repeat(40);
  const stale = 'b'.repeat(40);
  const cards: TaskCard[] = [40, 41, 42, 43, 44].map((pr) => {
    const at = new Date(Date.now() - (44 - pr) * 60_000).toISOString();
    return { id: `ta-probe-${pr}`, text: 'reviewed', createdAt: at, status: 'launched',
      pr: { number: pr, url: `https://github.com/o/r/pull/${pr}` }, reviewRequests: [{ pr, head, at }],
      history: pr === 44 ? [] : [{ at, event: 'live-move-result', kind: 'review', pr, head, verdict: 'pass', reviewed: true,
        mustFix: 0, effect: 'review result captured' }] };
  });
  writeTaskCards(statePath, cards);
  const probes: number[] = [];
  let judging = false;
  try {
    const result = await run(['tasks', 'rejudge', '--all', '--json'], { taskStatePath: statePath, registerSink: async () => true,
      rejudge: { liveMoves: new Set(), prFiles: async () => { judging = true; return ['src/feature.ts']; },
        live: { repoCandidates: () => [{ source: 'host', cwd: root }], prHead: async (pr) => {
          if (!judging) probes.push(pr);
          return { head: pr === 42 ? stale : head, state: 'OPEN',
            url: `https://github.com/o/r/pull/${pr === 43 ? 999 : pr}` };
        } } },
    });
    const outcomes = JSON.parse(result.lines[0]!) as Array<{ card: string }>;
    // Newest card 44 has no mf0; only 43/42 are probed, 41/40 never pre-probed.
    // 43 has a wrong URL, 42 has a stale head, so card 44 remains first by age.
    expect(probes).toEqual([43, 42, 44]);
    expect(outcomes[0]?.card).toBe('ta-probe-44');
    expect(new Set(outcomes.map((row) => row.card)).size).toBe(5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tasks rejudge --all selects a formerly unbound remote parent after HQ mirror PR binding', async () => {
  const { remoteLedgerMirrorDir } = await import('../task-agent/parent-host.js');
  const root = mkdtempSync(join(tmpdir(), 'tasks-cli-remote-rejudge-'));
  const taskStatePath = join(root, 'task-agent-actions.json');
  const parent = 'run-11111111-1111-4111-8111-111111111111';
  const child = 'run-22222222-2222-4222-8222-222222222222';
  const url = 'https://github.com/o/r/pull/30';
  const dir = remoteLedgerMirrorDir(root, 'node-b');
  const parentRow = { runId: parent, event: 'pod-child-run', data: { childRunId: child } };
  const childPr = { runId: child, event: 'pr-opened', data: { number: 30, url } };
  const remote = new Map([[parent, JSON.stringify(parentRow) + '\n'], [child, JSON.stringify(childPr) + '\n']]);
  const pulled: string[] = [];
  const ssh = (_host: string, script: string, _timeoutMs: number) => {
    const id = [parent, child].find((runId) => script.includes(`${runId}.jsonl`));
    if (id) pulled.push(id);
    return { status: id ? 0 : 1, stdout: id ? remote.get(id)! : '', stderr: id ? '' : 'unknown run' };
  };
  writeFileSync(taskStatePath, JSON.stringify({ tasks: { 'ta-remote': {
    id: 'ta-remote', text: 'repair', createdAt: new Date().toISOString(), status: 'launched', taLand: true,
    runId: parent, parentHost: { host: 'node-b' }, history: [],
  } } }));
  const deps: TasksCliDeps = { taskStatePath, registerSink: async () => true,
    cardRunEvidence: { ssh }, remoteLedgerMirror: () => {}, rejudge: { liveMoves: new Set(['review']), remoteRunTerminal: () => true,
      live: { repoCandidates: () => [{ source: 'host', cwd: '/repo' }], prHead: async () => ({ head: 'a'.repeat(40), state: 'OPEN', url }),
        requestReview: async () => {} } } };
  const incomplete = await run(['tasks', 'rejudge', '--all'], deps);
  expect(incomplete.lines).toEqual([]);
  expect((JSON.parse(readFileSync(taskStatePath, 'utf8')) as { tasks: Record<string, { pr?: unknown }> }).tasks['ta-remote']?.pr).toBeUndefined();
  expect(pulled).toEqual([parent, child]);
  expect(existsSync(join(dir, `${parent}.jsonl`))).toBe(true);
  expect(existsSync(join(dir, `${child}.jsonl`))).toBe(true);
  remote.set(child, [childPr,
    { runId: child, event: 'run-status', data: { runStatus: 'completed' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const result = await run(['tasks', 'rejudge', '--all'], deps);
  expect(result.lines.some(line => line.startsWith('ta-remote\tPR #30\t') && line.includes('\treview-requested\t'))).toBe(true);
  expect(readFileSync(join(dir, `${child}.jsonl`), 'utf8')).toContain('"runStatus":"completed"');
  expect((JSON.parse(readFileSync(taskStatePath, 'utf8')) as { tasks: Record<string, { pr?: { number: number }; runChildId?: string }> }).tasks['ta-remote'])
    .toMatchObject({ pr: { number: 30 }, runChildId: child });
});

test('TA-CARD-OUTCOMES-CLI — tasks outcomes --since 24h --json 은 카드·PR 종결 사실과 원문 부재를 센다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-outcomes-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    const ledgerDir = join(dir, 'run-ledger');
    const now = Date.parse('2026-10-21T02:00:00.000Z');
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const url = 'https://github.com/ElanvitalAI/elanous/pull/123';
    const urlRecovered = 'https://github.com/ElanvitalAI/elanous/pull/456';
    writeTaskCards(statePath, [
      { id: 'ta-out-pr', text: 'PR 성공', seat: 'TC', checklistId: 'CELL-PR', status: 'launched',
        runId: 'run-out-a', createdAt: ago(30), pr: { number: 123, url },
        prTerminal: { pr: 123, url, head: 'a'.repeat(40), state: 'MERGED', at: ago(2) },
        history: [
          { at: ago(6), event: 'live-move', kind: 'land', executed: true, ok: true, detail: 'land executed' },
          { at: ago(5), event: 'postland', detail: 'MERGED #123 · 칸 green' },
        ] },
      // 종료 시각은 «종결 사건 줄»이 정한다 — 창 밖 run-bound(30시간 전)가 아니라 1시간 전 실패 줄이 종료 시각이다.
      { id: 'ta-out-samecell', text: 'same-cell 거부', seat: 'TC', checklistId: 'CELL-SAME', status: 'failed',
        runId: 'run-out-b', parentHost: { host: 'node-b' }, createdAt: ago(30),
        history: [{ at: ago(30), event: 'run-bound', runId: 'run-out-b' }, { at: ago(1), event: 'failed' }] },
      { id: 'ta-out-noprogress', text: 'no-progress', seat: 'TC', checklistId: 'CELL-NP', status: 'failed',
        runId: 'run-out-c', createdAt: ago(30),
        history: [{ at: ago(3), event: 'pr-bound', runId: 'run-out-c' }, { at: ago(1.5), event: 'failed' }] },
      // 자식 런에서 오류 뒤 재시도가 이겨 PR 이 종결됐다 — 오류 원문은 이 행의 종결 사유가 아니다.
      { id: 'ta-out-recovered', text: '재시도 종결', seat: 'TC', checklistId: 'CELL-REC', status: 'launched',
        runId: 'run-out-d', createdAt: ago(30), pr: { number: 456, url: urlRecovered },
        prTerminal: { pr: 456, url: urlRecovered, head: 'b'.repeat(40), state: 'MERGED', at: ago(2.5) },
        history: [{ at: ago(6), event: 'failed', detail: 'same-cell 가드 — 초판은 중단됐다' }] },
      // 이미 끝났다는 후보만으로 24시간 창의 «종결»로 올리지 않는다.
      { id: 'ta-out-candidate', text: '후보', seat: 'TC', checklistId: 'CELL-CAND', status: 'failed',
        runId: 'run-out-candidate', createdAt: ago(40), history: [
          { at: ago(30), event: 'failed', detail: '옛 실패' },
          { at: ago(0.5), event: 'already-done-candidate', detail: '검토 후보' },
        ] },
      // 카드 상태만 성공으로 바뀌고 성공 종료 사건/PR 종결이 없다면 과거 실패 시각을 재사용하지 않는다.
      { id: 'ta-out-stale-success', text: '종결 시각 모름', seat: 'TC', checklistId: 'CELL-STALE', status: 'done',
        createdAt: ago(30), history: [{ at: ago(1), event: 'failed', detail: '과거 실패' }] },
      // 실패했지만 종결 줄이 없다 — 끝나기 전 사건(run-bound)을 종료 시각으로 단정하지 않고 undatedCards 로 센다.
      { id: 'ta-out-undated', text: '시각 모름', seat: 'TC', checklistId: 'CELL-UD', status: 'failed',
        runId: 'run-out-e', createdAt: ago(30), history: [{ at: ago(0.5), event: 'run-bound', runId: 'run-out-e' }] },
      // 현재 실패 상태와 마지막 종결 사건이 성공이면 그 성공 시각에 실패를 집계하지 않는다.
      { id: 'ta-out-mismatch', text: '상태 사건 불일치', seat: 'TC', checklistId: 'CELL-MISMATCH', status: 'failed',
        createdAt: ago(30), history: [{ at: ago(0.5), event: 'postland', detail: '과거 성공' }] },
      // 최근 24시간 창의 상한은 지금이다. 미래 사건은 결과에 들어가지 않는다.
      { id: 'ta-out-future', text: '미래 사건', seat: 'TC', checklistId: 'CELL-FUTURE', status: 'failed',
        createdAt: ago(30), history: [{ at: new Date(now + 3_600_000).toISOString(), event: 'failed' }] },
    ]);
    appendRunLedgerEntry({ runId: 'run-out-a', event: 'pod-child-run', data: { childRunId: 'run-out-a-child' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-out-a-child', event: 'pr-opened', data: { number: 123, url } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-out-a-child', event: 'run-status', data: { runStatus: 'completed' } }, ledgerDir);
    const remoteLedgerDir = remoteLedgerMirrorDir(dir, 'node-b');
    appendRunLedgerEntry({ runId: 'run-out-b', event: 'pod-child-run', data: { childRunId: 'run-out-b-child' } }, remoteLedgerDir);
    appendRunLedgerEntry({ runId: 'run-out-b-child', event: 'child-error', data: { error: 'runs stopped: same-cell 가드 — 카드 ta-other 가 CELL-SAME 을 이미 잡고 있다' } }, remoteLedgerDir);
    appendRunLedgerEntry({ runId: 'run-out-c', event: 'pod-child-run', data: { childRunId: 'run-out-c-child' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-out-c-child', event: 'pr-open-failed', data: { error: 'no-progress: 구현 자식이 세 번 연속 같은 파일만 고쳤다' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-out-d', event: 'pod-child-run', data: { childRunId: 'run-out-d-child' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-out-d-child', event: 'pr-open-failed', data: { error: 'same-cell 가드 — 초판은 중단됐다' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-out-d-child', event: 'pr-opened', data: { number: 456, url: urlRecovered } }, ledgerDir);
    const result = await run(['tasks', 'outcomes', '--since', '24h', '--json'], { taskStatePath: statePath, registerSink: async () => {}, outcomesNow: () => now });
    expect(result.code ?? 0).toBe(0);
    const body = JSON.parse(result.lines[0]!);
    expect(body.rows).toMatchObject([
      { cell: 'CELL-SAME', card: 'ta-out-samecell', runId: 'run-out-b', childRunId: 'run-out-b-child', host: 'node-b',
        endedAt: ago(1), cardStatus: 'failed', pr: null,
        reason: 'runs stopped: same-cell 가드 — 카드 ta-other 가 CELL-SAME 을 이미 잡고 있다', reasonFrom: 'child-ledger:child-error' },
      { cell: 'CELL-NP', card: 'ta-out-noprogress', runId: 'run-out-c', childRunId: 'run-out-c-child', host: null,
        endedAt: ago(1.5), cardStatus: 'failed', pr: null,
        reason: 'no-progress: 구현 자식이 세 번 연속 같은 파일만 고쳤다', reasonFrom: 'child-ledger:pr-open-failed' },
      { cell: 'CELL-PR', card: 'ta-out-pr', runId: 'run-out-a', childRunId: 'run-out-a-child', host: null,
        endedAt: ago(2), cardStatus: 'launched', pr: { number: 123, state: 'MERGED' },
        reason: null, reasonFrom: null },
      { cell: 'CELL-REC', card: 'ta-out-recovered', runId: 'run-out-d', childRunId: 'run-out-d-child', host: null,
        endedAt: ago(2.5), cardStatus: 'launched', pr: { number: 456, state: 'MERGED' }, reason: null, reasonFrom: null },
    ]);
    expect(body.aggregate).toMatchObject({ cards: 4, cardTerminals: 2, prTerminals: 2, failedCardTerminals: 2, missingReason: 0 });
    expect(body.since).toBe(ago(24));
    expect(body.until).toBe(new Date(now).toISOString());
    expect(body.limitReached).toBe(false);
    expect(body.stopReason).toBeNull();
    expect(body.childLedgerObserved).toBe(true);
    expect(body.reasonObserved).toBe(true);
    expect(body.undatedCards).toBe(3);
    expect(body.openCards).toBe(0);
    // board 는 원시 카드 이력을, outcomes 는 검증된 자식 런 결속의 오류 꼬리를 각각 읽는다.
    const flat = (nodes: BoardNode[]): BoardNode[] => nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
    const board = flat(cardsBoard(statePath, { ledger: true }));
    const merged = board.find((node) => node.id === 'ta-out-pr');
    expect(merged?.status).toBe('done');
    expect(merged?.ledger?.lastEvent?.detail).toBe('MERGED #123 · 칸 green');
    expect(merged?.ledger?.pr).toBe(123);
    // 관측 줄만 남은 카드는 board 와 outcomes 모두 사유를 지어내지 않는다.
    expect(board.find((node) => node.id === 'ta-out-samecell')?.ledger?.exitReason).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tasks outcomes 은 «원문 없음» 수를 세고, 페이지 상한에서 stopReason 을 붙여 절단을 숨기지 않는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-outcomes-bound-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    const now = Date.parse('2026-10-21T02:00:00.000Z');
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    writeTaskCards(statePath, [
      { id: 'ta-out-quiet-a', text: 'a', checklistId: 'CELL-A', status: 'failed', createdAt: ago(30),
        history: [{ at: ago(0.5), event: 'run-bound' }, { at: ago(0.25), event: 'failed' }] },
      { id: 'ta-out-quiet-b', text: 'b', checklistId: 'CELL-B', status: 'launch-failed', createdAt: ago(30),
        history: [{ at: ago(1), event: 'launch-failed' }] },
      { id: 'ta-out-open', text: 'c', checklistId: 'CELL-C', status: 'launched', createdAt: ago(30),
        history: [{ at: ago(3), event: 'launch' }] },
    ]);
    const deps: TasksCliDeps = { taskStatePath: statePath, registerSink: async () => {}, outcomesNow: () => now };
    const full = JSON.parse((await run(['tasks', 'outcomes', '--since', '2026-10-21T00:00:00Z', '--json'], deps)).lines[0]!);
    expect(full.rows.map((row: { card: string }) => row.card)).toEqual(['ta-out-quiet-a', 'ta-out-quiet-b']);
    expect(full.rows.every((row: { reason: string | null }) => row.reason === null)).toBe(true);
    expect(full.aggregate).toMatchObject({ cards: 2, cardTerminals: 2, prTerminals: 0, missingReason: 2, reasons: [] });
    expect(full.openCards).toBe(1);
    expect(full.undatedCards).toBe(0);
    const bounded = JSON.parse((await run(['tasks', 'outcomes', '--since', '2026-10-21T00:00:00Z', '--json'], { ...deps, outcomesLimit: 1 })).lines[0]!);
    expect(bounded.rows).toHaveLength(1);
    expect(bounded.limitReached).toBe(true);
    expect(bounded.stopReason).toBe('page-limit');
    expect(bounded.warning).toContain('상한 1');
    expect(bounded.aggregate).toMatchObject({ cards: 1, cardTerminals: 1, prTerminals: 0, missingReason: 1, reasons: [] });
    expect(bounded.childLedgerObserved).toBe(false);
    const inverted = await run(['tasks', 'outcomes', '--since', '2026-10-21T00:00:00Z', '--until', '2026-10-20T00:00:00Z'], deps);
    expect(inverted.code).toBe(1);
    expect(JSON.parse(inverted.lines[0]!)).toEqual({ error: '--since 가 --until 보다 늦다' });
    const notATime = await run(['tasks', 'outcomes', '--since', 'yesterday'], deps);
    expect(notATime.code).toBe(1);
    expect(JSON.parse(notATime.lines[0]!).error).toContain('--since');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TA-CARD-OUTCOMES-LIVE — 실물 CLI 프로세스가 --test 우주의 세 카드를 세 행·집계·종료 코드로 보고한다', async () => {
  // 주입 의존성 없이 생산 진입점 그대로 굴린다: bun bin/elanous.mjs --test=<우주> tasks outcomes --since 24h --json
  const universe = mkdtempSync(join(tmpdir(), 'ta-outcomes-live-universe-'));
  try {
    // --test=<우주> 는 그 우주 디렉터리를 인스턴스 루트로 삼는다 — 카드 상태는 루트의 task-agent-actions.json.
    const statePath = join(universe, 'task-agent-actions.json');
    const now = Date.now();
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    writeTaskCards(statePath, [
      { id: 'ta-live-failed', text: '실패', seat: 'TC', checklistId: 'CELL-LIVE-FAIL', status: 'failed', createdAt: ago(30),
        history: [{ at: ago(30), event: 'run-bound' }, { at: ago(0.5), event: 'failed', detail: 'same-cell 가드 — 자식 런 실패\u001b[31m' }] },
      { id: 'ta-live-merged', text: '종결', seat: 'TC', checklistId: 'CELL-LIVE-MERGE', status: 'launched', createdAt: ago(30),
        pr: { number: 777, url: 'https://github.com/ElanvitalAI/elanous/pull/777' },
        prTerminal: { pr: 777, url: 'https://github.com/ElanvitalAI/elanous/pull/777', head: 'c'.repeat(40), state: 'MERGED', at: ago(1) },
        history: [{ at: ago(1.5), event: 'postland', detail: 'MERGED #777 · 칸 green' }] },
      { id: 'ta-live-noprogress', text: '진척 없음', seat: 'TC', checklistId: 'CELL-LIVE-NP', status: 'failed', createdAt: ago(30),
        runChildId: 'run-live-noprogress-child', history: [{ at: ago(2), event: 'failed' }] },
    ]);
    appendRunLedgerEntry({ runId: 'run-live-noprogress-child', event: 'pr-open-failed',
      data: { error: 'no-progress: 변경 없이 종료' } }, join(universe, 'run-ledger'));
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.ELANOUS_CONFIG_DIR;
    delete env.ELANOUS_STATE_DIR;
    const proc = Bun.spawn([process.execPath, ELANOUS_CLI_ENTRY, `--test=${universe}`, 'tasks', 'outcomes', '--since', '24h', '--json'], {
      cwd: universe, stdout: 'pipe', stderr: 'pipe', env,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout.trim());
    expect(report.rows.map((row: TaskOutcomeRow) => [row.card, row.endedAt, row.reason])).toEqual([
      ['ta-live-failed', ago(0.5), null],
      ['ta-live-merged', ago(1), null],
      ['ta-live-noprogress', ago(2), null],
    ]);
    expect(report.aggregate).toMatchObject({ cards: 3, cardTerminals: 2, prTerminals: 1, failedCardTerminals: 2, missingReason: 2, reasons: [] });
    expect(report.childLedgerObserved).toBe(false);
    expect(report.reasonObserved).toBe(false);
    expect(report.undatedCards).toBe(0);
    expect(report.stopReason).toBeNull();
  } finally { rmSync(universe, { recursive: true, force: true }); }
}, 30_000);

test('PROVE-DRAFT-PR-FAIL-1052: 증거 명령: bun test src/cli/tasks-clitestts', async () => {
  // 완료 경계 실물 — 격리 --test 우주에 PR 성공·same-cell 거부·no-progress 세 카드 ⊕ 자식 원장을 심고
  // 실물 CLI 프로세스가 세 행(칸·카드 id·runId·자식 runId·호스트·종료 시각·PR 결속·종결 사유 원문)과
  // 종결 사유별 집계·«원문 없음» 수를 정확히 내는지 재다.
  const universe = mkdtempSync(join(tmpdir(), 'ta-outcomes-reason-live-universe-'));
  try {
    const statePath = join(universe, 'task-agent-actions.json');
    const now = Date.now();
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const url = (n: number) => `https://github.com/ElanvitalAI/elanous/pull/${n}`;
    writeTaskCards(statePath, [
      // PR 성공 — 자식 원장에 종결 오류 꼬리가 없다: 종결 사유 원문 없음.
      { id: 'ta-reason-pr', text: 'PR 성공', seat: 'TC', checklistId: 'CELL-REASON-PR', status: 'launched',
        runId: 'run-reason-pr', runChildId: 'run-reason-pr-child', createdAt: ago(30),
        pr: { number: 511, url: url(511) },
        prTerminal: { pr: 511, url: url(511), head: 'a'.repeat(40), state: 'MERGED', at: ago(1) },
        history: [{ at: ago(1), event: 'postland', detail: 'MERGED #511 · 칸 green' }] },
      // same-cell 거부 — 자식 원장 child-error 꼬리가 이 행의 종결 사유 원문이다.
      { id: 'ta-reason-samecell', text: 'same-cell 거부', seat: 'TC', checklistId: 'CELL-REASON-SAME', status: 'failed',
        runId: 'run-reason-same', runChildId: 'run-reason-same-child', parentHost: { host: 'node-b' }, createdAt: ago(30),
        history: [{ at: ago(30), event: 'run-bound', runId: 'run-reason-same' }, { at: ago(2), event: 'failed' }] },
      // no-progress — 자식 원장 pr-open-failed 꼬리가 이 행의 종결 사유 원문이다.
      { id: 'ta-reason-noprogress', text: 'no-progress', seat: 'TC', checklistId: 'CELL-REASON-NP', status: 'failed',
        runId: 'run-reason-np', runChildId: 'run-reason-np-child', createdAt: ago(30),
        history: [{ at: ago(3), event: 'run-bound', runId: 'run-reason-np' }, { at: ago(1.5), event: 'failed' }] },
    ]);
    const ledgerDir = join(universe, 'run-ledger');
    appendRunLedgerEntry({ runId: 'run-reason-pr', event: 'pod-child-run', data: { childRunId: 'run-reason-pr-child' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-reason-pr-child', event: 'pr-opened', data: { number: 511, url: url(511) } }, ledgerDir);
    const remoteLedgerDir = remoteLedgerMirrorDir(universe, 'node-b');
    appendRunLedgerEntry({ runId: 'run-reason-same', event: 'pod-child-run', data: { childRunId: 'run-reason-same-child' } }, remoteLedgerDir);
    appendRunLedgerEntry({ runId: 'run-reason-same-child', event: 'child-error',
      data: { error: 'runs stopped: same-cell 가드 — 카드 ta-other 가 CELL-REASON-SAME 을 이미 잡고 있다' } }, remoteLedgerDir);
    appendRunLedgerEntry({ runId: 'run-reason-np', event: 'pod-child-run', data: { childRunId: 'run-reason-np-child' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-reason-np-child', event: 'pr-open-failed',
      data: { error: 'no-progress: 구현 자식이 세 번 연속 같은 파일만 고쳤다' } }, ledgerDir);
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.ELANOUS_CONFIG_DIR;
    delete env.ELANOUS_STATE_DIR;
    const proc = Bun.spawn([process.execPath, ELANOUS_CLI_ENTRY, `--test=${universe}`, 'tasks', 'outcomes', '--since', '24h', '--json'], {
      cwd: universe, stdout: 'pipe', stderr: 'pipe', env,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout.trim());
    expect(report.rows).toMatchObject([
      { cell: 'CELL-REASON-PR', card: 'ta-reason-pr', runId: 'run-reason-pr', childRunId: 'run-reason-pr-child',
        host: null, endedAt: ago(1), cardStatus: 'launched', pr: { number: 511, state: 'MERGED' },
        reason: null, reasonFrom: null },
      { cell: 'CELL-REASON-NP', card: 'ta-reason-noprogress', runId: 'run-reason-np', childRunId: 'run-reason-np-child',
        host: null, endedAt: ago(1.5), cardStatus: 'failed', pr: null,
        reason: 'no-progress: 구현 자식이 세 번 연속 같은 파일만 고쳤다', reasonFrom: 'child-ledger:pr-open-failed' },
      { cell: 'CELL-REASON-SAME', card: 'ta-reason-samecell', runId: 'run-reason-same', childRunId: 'run-reason-same-child',
        host: 'node-b', endedAt: ago(2), cardStatus: 'failed', pr: null,
        reason: 'runs stopped: same-cell 가드 — 카드 ta-other 가 CELL-REASON-SAME 을 이미 잡고 있다', reasonFrom: 'child-ledger:child-error' },
    ]);
    expect(report.aggregate).toMatchObject({ cards: 3, cardTerminals: 2, prTerminals: 1, failedCardTerminals: 2, missingReason: 0,
      reasons: [
        { reason: 'no-progress: 구현 자식이 세 번 연속 같은 파일만 고쳤다', count: 1 },
        { reason: 'runs stopped: same-cell 가드 — 카드 ta-other 가 CELL-REASON-SAME 을 이미 잡고 있다', count: 1 },
      ] });
    expect(report.childLedgerObserved).toBe(true);
    expect(report.reasonObserved).toBe(true);
    expect(report.undatedCards).toBe(0);
    expect(report.openCards).toBe(0);
    expect(report.stopReason).toBeNull();
  } finally { rmSync(universe, { recursive: true, force: true }); }
}, 30_000);

test('RUN-DOCTOR-RELAUNCH-PREFLIGHT L1 — 환경 실패 세 카드의 diff·hold가 relaunch/harvest/human을 가른다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-doctor-l1-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    const traffic = join(dir, 'traffic.json');
    writeFileSync(traffic, JSON.stringify({ hold: [] }));
    const cards: TaskCard[] = [1, 2, 3].map((n) => ({
      id: `ta-doctor-${n}`, text: '환경 실패', checklistId: `CELL-DOCTOR-${n}`, checklistVersion: '0.2.35',
      status: 'failed', runId: `run-doctor-${n}`, runChildId: `run-child-${n}`,
      createdAt: '2026-10-21T00:00:00Z', pr: { number: 900 + n, url: `https://github.com/o/r/pull/${900 + n}` },
      history: [{ at: '2026-10-21T01:00:00Z', event: 'failed', runId: `run-doctor-${n}` }],
    }));
    writeTaskCards(statePath, cards);
    const deps: TasksCliDeps = {
      taskStatePath: statePath, doctorVersion: () => '0.2.35',
      doctorChecklist: (version) => ({ version, released: '', dev: '', history: [],
        items: cards.map((card) => ({ id: card.checklistId!, title: 'doctor fixture', status: 'yellow', updatedAt: '', updatedBy: '' })) }),
      doctorRun: (_command, args) => {
        if (args[1] === 'list') return { status: 0, stdout: '[]' };
        const number = Number(args[2]);
        const files = number === 902 ? [{ path: 'src/code.ts', additions: 1, deletions: 0 }] : [];
        return { status: 0, stdout: JSON.stringify({ number, state: 'OPEN', isDraft: true, headRefOid: 'a'.repeat(40),
          changedFiles: files.length, files }) };
      },
      doctorLedger: (id) => [{ runId: id, event: 'stop', data: { terminationReason: 'worktree add timeout after 30s' } }],
    };
    const relaunch = JSON.parse((await run(['tasks', 'doctor', 'run-doctor-1', '--traffic', traffic, '--json'], deps)).lines[0]!) as TaskDoctorReport;
    const harvest = JSON.parse((await run(['tasks', 'doctor', 'ta-doctor-2', '--traffic', traffic, '--json'], deps)).lines[0]!) as TaskDoctorReport;
    const human = JSON.parse((await run(['tasks', 'doctor', 'ta-doctor-3', '--traffic', join(dir, 'missing.json'), '--json'], deps)).lines[0]!) as TaskDoctorReport;
    expect([relaunch.nextAction, harvest.nextAction, human.nextAction]).toEqual(['relaunch', 'harvest', 'human']);
    expect(Object.values(relaunch.conditions).map((part) => part.value)).toEqual([true, true, true, true]);
    expect(harvest.conditions.noPreservedImplementation).toMatchObject({ value: false, source: 'gh:pr-902:files' });
    deps.doctorRun = (_command, args) => args[1] === 'list' ? { status: 0, stdout: '[]' }
      : { status: 0, stdout: JSON.stringify({ number: Number(args[2]), state: 'OPEN', isDraft: true,
        headRefOid: 'a'.repeat(40), changedFiles: 1,
        files: [{ path: 'docs/tools/rebuild.ts', additions: 1, deletions: 0 }] }) };
    const docsCode = JSON.parse((await run(['tasks', 'doctor', 'ta-doctor-1', '--traffic', traffic, '--json'], deps)).lines[0]!) as TaskDoctorReport;
    expect(docsCode.conditions.noPreservedImplementation.value).toBe(false);
    expect(docsCode.nextAction).toBe('harvest');
    expect(human.unknownSources).toContain(`currentYellowUnheldNoOtherPr:checklist:0.2.35:CELL-DOCTOR-3 + traffic:${join(dir, 'missing.json')} + gh:open-pr-list:cell-marker`);
    expect(relaunch).toMatchObject({ card: 'ta-doctor-1', cell: 'CELL-DOCTOR-1', childRunId: 'run-child-1',
      terminalReason: 'worktree add timeout after 30s', pr: { number: 901, draft: true, changedFiles: 0 } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('RUN-DOCTOR-RELAUNCH-PREFLIGHT L0 — --test CLI가 세 카드 fixture를 한 줄 JSON씩 판정한다', async () => {
  const universe = mkdtempSync(join(tmpdir(), 'tasks-doctor-live-'));
  try {
    setElanousConfigDir(universe);
    for (let n = 1; n <= 3; n++) addItem(checklistDevVersion(), { id: `CELL-DOCTOR-LIVE-${n}`, title: `doctor fixture ${n}`, owner: 'TC' });
    resetElanousConfigDir();
    const statePath = join(universe, 'task-agent-actions.json');
    writeTaskCards(statePath, [1, 2, 3].map((n): TaskCard => ({
      id: `ta-doctor-live-${n}`, text: 'doctor fixture', checklistId: `CELL-DOCTOR-LIVE-${n}`,
      checklistVersion: checklistDevVersion(), createdAt: '2026-10-21T00:00:00Z', status: 'failed',
      runId: `run-doctor-live-${n}`, runChildId: `run-doctor-live-child-${n}`,
      pr: { number: 910 + n, url: `https://github.com/o/r/pull/${910 + n}` },
      history: [{ at: '2026-10-21T01:00:00Z', event: 'failed', runId: `run-doctor-live-${n}` }],
    })));
    for (let n = 1; n <= 3; n++) {
      appendRunLedgerEntry({ runId: `run-doctor-live-child-${n}`, event: 'stop',
        data: { terminationReason: 'worktree add timeout after 30s' } }, join(universe, 'run-ledger'));
      appendRunLedgerEntry({ runId: `run-doctor-live-${n}`, event: 'stop',
        data: { childEvidence: {} } }, join(universe, 'run-ledger'));
    }
    const traffic = join(universe, 'traffic.json');
    writeFileSync(traffic, JSON.stringify({ hold: [] }));
    const fakeBin = join(universe, 'bin');
    mkdirSync(fakeBin);
    const fakeGh = join(fakeBin, 'gh');
    writeFileSync(fakeGh, [
      '#!/bin/sh',
      'if [ "$2" = list ]; then printf "[]\\n"; exit 0; fi',
      'case "$3" in',
      '  912) printf \'{"number":912,"state":"OPEN","isDraft":true,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","changedFiles":1,"files":[{"path":"src/doctor.ts","additions":1,"deletions":0}]}\\n\' ;;',
      '  911|913) printf \'{"number":%s,"state":"OPEN","isDraft":true,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","changedFiles":0,"files":[]}\\n\' "$3" ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'));
    chmodSync(fakeGh, 0o755);
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` } as Record<string, string | undefined>;
    delete env.ELANOUS_CONFIG_DIR;
    delete env.ELANOUS_STATE_DIR;
    const decisions: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const args = [process.execPath, ELANOUS_CLI_ENTRY, `--test=${universe}`, 'tasks', 'doctor', `ta-doctor-live-${n}`,
        '--traffic', n === 3 ? join(universe, 'unreadable.json') : traffic, '--json'];
      const child = Bun.spawn(args, { cwd: universe, env, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr).toBe(0);
      const lines = stdout.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      decisions.push((JSON.parse(lines[0]!) as TaskDoctorReport).nextAction);
    }
    expect(decisions).toEqual(['relaunch', 'harvest', 'human']);
  } finally { resetElanousConfigDir(); rmSync(universe, { recursive: true, force: true }); }
}, 30_000);

test('RUN-DOCTOR-RELAUNCH-PREFLIGHT — 카드 문면만으로 환경 원인을 추정하지 않고, 같은 칸 두 실패는 reauthor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-doctor-fence-'));
  try {
    const statePath = join(dir, 'cards.json');
    const traffic = join(dir, 'traffic.json');
    writeFileSync(traffic, JSON.stringify({ hold: [] }));
    const card = (id: string, pr: number): TaskCard => ({ id, text: 'failed', checklistId: 'CELL-FENCE',
      createdAt: '2026-10-21T00:00:00Z', status: 'failed', runId: `run-${id}`, runChildId: `child-${id}`,
      pr: { number: pr, url: `https://github.com/o/r/pull/${pr}` },
      history: [{ at: '2026-10-21T01:00:00Z', event: 'failed', runId: `run-${id}`, detail: 'worktree add timeout' }] });
    writeTaskCards(statePath, [card('ta-fence-a', 921)]);
    const deps: TasksCliDeps = { taskStatePath: statePath, doctorVersion: () => '0.2.35',
      doctorChecklist: (version) => ({ version, released: '', dev: '', history: [],
        items: [{ id: 'CELL-FENCE', title: 'doctor fixture', status: 'yellow', updatedAt: '', updatedBy: '' }] }),
      doctorRun: (_command, args) => args[1] === 'list' ? { status: 0, stdout: '[]' }
        : { status: 0, stdout: JSON.stringify({ number: Number(args[2]), state: 'OPEN', isDraft: true,
          headRefOid: 'a'.repeat(40), changedFiles: 0, files: [] }) },
      doctorLedger: () => null };
    const missing = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(missing.terminalReason).toBe('worktree add timeout');
    expect(missing.conditions.environmentFailure.value).toBe('unknown');
    expect(missing.nextAction).toBe('human');
    deps.doctorLedger = (id) => id === 'child-ta-fence-a'
      ? [{ runId: id, event: 'stop', data: { terminationReason: 'worktree add timeout' } }] : null;
    const noParent = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(noParent.conditions.environmentFailure).toMatchObject({ value: 'unknown', source: 'run-ledger:run-ta-fence-a' });
    expect(noParent.nextAction).toBe('human');
    deps.doctorLedger = (id) => id.startsWith('child-')
      ? [{ runId: id, event: 'stop', data: { scopeEscape: true } }] : null;
    const childSignalNoParent = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(childSignalNoParent.conditions.environmentFailure).toMatchObject({ value: 'unknown', source: 'run-ledger:run-ta-fence-a' });
    expect(childSignalNoParent.nextAction).toBe('human');
    deps.doctorLedger = (id) => id.startsWith('child-') ? null
      : [{ runId: id, event: 'stop', data: { childEvidence: { scopeEscape: true } } }];
    const parentSignalNoChild = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(parentSignalNoChild.conditions.environmentFailure).toMatchObject({ value: 'unknown', source: 'run-ledger:child-ta-fence-a' });
    expect(parentSignalNoChild.nextAction).toBe('human');
    writeTaskCards(statePath, [{ ...card('ta-fence-a', 921), runChildId: undefined }]);
    deps.doctorLedger = (id) => [{ runId: id, event: 'stop', data: { terminationReason: 'worktree add timeout' } }];
    const noChildId = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(noChildId.conditions.environmentFailure).toMatchObject({ value: 'unknown', source: 'card:child-run-unbound' });
    expect(noChildId.nextAction).toBe('human');
    writeTaskCards(statePath, [card('ta-fence-a', 921)]);
    deps.doctorLedger = (id) => [{ runId: id, event: 'stop', data: { terminationReason: 'stale image in unrelated cache' } }];
    const otherImage = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(otherImage.conditions.environmentFailure.value).toBe(false);
    expect(otherImage.nextAction).toBe('human');
    deps.doctorLedger = (id) => [{ runId: id, event: 'stop',
      data: { terminationReason: id.startsWith('child-') ? 'worktree add timeout' : 'unrelated provider refusal' } }];
    const conflicting = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(conflicting.conditions.environmentFailure).toMatchObject({ value: 'unknown', detail: '부모·자식 종결 사유 불일치' });
    expect(conflicting.nextAction).toBe('human');
    deps.doctorLedger = (id) => id.startsWith('child-')
      ? [{ runId: id, event: 'run-status', data: { runStatus: 'running', error: 'worktree add timeout' } }]
      : [{ runId: id, event: 'stop', data: {} }];
    const running = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(running.conditions.environmentFailure.value).toBe('unknown');
    expect(running.nextAction).toBe('human');
    deps.doctorLedger = (id) => id.startsWith('child-')
      ? [{ runId: id, event: 'pr-open-failed', data: { error: 'model catalog unknown' } },
        { runId: id, event: 'stop', data: {} }]
      : [{ runId: id, event: 'stop', data: {} }];
    const childDiagnostic = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(childDiagnostic.conditions.environmentFailure.value).toBe('unknown');
    expect(childDiagnostic.nextAction).toBe('human');
    deps.doctorLedger = (id) => id.startsWith('child-')
      ? [{ runId: id, event: 'gated', data: { passed: true, gateExecuted: true } },
        { runId: id, event: 'stop', data: { terminationReason: 'model catalog unknown' } }]
      : [{ runId: id, event: 'stop', data: { terminationReason: 'model catalog unknown' } }];
    const gateWithoutHead = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(gateWithoutHead.nextAction).toBe('relaunch');
    expect(gateWithoutHead.head).toBe('a'.repeat(40));
    expect(gateWithoutHead.lastGate).toMatchObject({ passed: true, head: null, source: 'run-ledger:child-ta-fence-a:gated' });
    deps.doctorLedger = (id) => [{ runId: id, event: 'stop', data: id === 'run-ta-fence-a'
      ? { childEvidence: { scopeEscape: true } } : { terminationReason: 'worktree add timeout' } }];
    const scopeEscape = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(scopeEscape.conditions.environmentFailure).toMatchObject({ value: false, detail: '구조화된 재저작 신호' });
    expect(scopeEscape.conditions.environmentFailure.source).toBe('run-ledger:run-ta-fence-a:stop:childEvidence.scopeEscape');
    expect(scopeEscape.nextAction).toBe('reauthor');
    deps.doctorLedger = (id) => [{ runId: id, event: 'stop', data: id.startsWith('child-')
      ? { scopeEscape: true } : {} }];
    const childScope = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(childScope.conditions.environmentFailure.source).toBe('run-ledger:child-ta-fence-a:stop:scopeEscape');
    deps.doctorLedger = (id) => [{ runId: id, event: 'stop', data: id.startsWith('child-')
      ? { childEvidence: { scopeEscape: true } } : {} }];
    const childEvidenceScope = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(childEvidenceScope.conditions.environmentFailure.source).toBe('run-ledger:child-ta-fence-a:stop:childEvidence.scopeEscape');
    deps.doctorLedger = (id) => [{ runId: id, event: 'stop', data: id.startsWith('child-')
      ? {} : { scopeEscape: true } }];
    const parentScope = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(parentScope.conditions.environmentFailure.source).toBe('run-ledger:run-ta-fence-a:stop:scopeEscape');
    deps.doctorLedger = (id) => [{ runId: id, event: 'stop', data: id.startsWith('child-')
      ? {} : { childEvidence: { supervisorVerdict: 'goal-revision-required' } } }];
    const parentVerdict = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(parentVerdict.conditions.environmentFailure.source).toBe('run-ledger:run-ta-fence-a:stop:childEvidence.supervisorVerdict');
    deps.doctorLedger = (id) => [{ runId: id, event: 'stop', data: id.startsWith('child-')
      ? { terminationReason: 'worktree add timeout', scopeEscape: false }
      : { terminationReason: 'worktree add timeout', childEvidence: { scopeEscape: true } } }];
    const conflictingScope = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(conflictingScope.conditions.environmentFailure).toMatchObject({ value: 'unknown', detail: '부모·자식 scopeEscape 신호 불일치' });
    expect(conflictingScope.nextAction).toBe('human');
    deps.doctorLedger = (id) => [{ runId: id, event: 'stop', data: { terminationReason: 'stale Pod image' } }];
    writeTaskCards(statePath, [{ ...card('ta-fence-a', 921), history: [
      { at: '2026-10-21T01:00:00Z', event: 'failed', runId: 'run-ta-fence-a' },
      { at: '2026-10-21T01:01:00Z', event: 'failed', runId: 'run-ta-fence-a' },
    ] }]);
    const duplicateFailure = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(duplicateFailure.conditions.failureRoundsBelowTwo).toMatchObject({ value: true, detail: '실패 라운드 1' });
    expect(duplicateFailure.nextAction).toBe('relaunch');
    writeTaskCards(statePath, [{ ...card('ta-fence-a', 921), history: [] }, card('ta-fence-b', 922)]);
    const repeated = JSON.parse((await run(['tasks', 'doctor', 'ta-fence-a', '--traffic', traffic], deps)).lines[0]!) as TaskDoctorReport;
    expect(repeated.conditions.failureRoundsBelowTwo.value).toBe(false);
    expect(repeated.nextAction).toBe('reauthor');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


/**
 * MODEL-SIZE-OUTCOME-MEASURE — 모델×조각 크기 칸별 성공률을 재는 fixture.
 * 카드 셋(모델 셋) × 크기 둘 · 주입 사다리 L0(주입 deps)~L1(실물 CLI 프로세스).
 */
const modelSizeUniverse = (now: number) => {
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const head = 'a'.repeat(40);
  const url = (n: number) => `https://github.com/ElanvitalAI/elanous/pull/${n}`;
  const smallText = '대상 경로: src/one.ts\n바꿀 것: 한 동작만 바꾼다';
  const largeText = '대상 경로: src/one.ts · src/two.ts · src/three.ts\n바꿀 것:\n- 첫째 동작\n- 둘째 동작';
  const small = { text: smallText, targetPaths: ['src/one.ts'] };
  const large = { text: largeText, targetPaths: ['src/one.ts', 'src/two.ts', 'src/three.ts'] };
  const childLlm = (provider: string, model: string) => ({ provider, model });
  const cards: TaskCard[] = [
    // grok × 작은 조각 — PR 착지(성공)
    { id: 'ta-ms-grok-small', ...small, seat: 'TC', checklistId: 'CELL-MS-1', status: 'launched',
      childLlm: childLlm('grok', 'grok-4.7'), tier: '중', createdAt: ago(30), pr: { number: 901, url: url(901) },
      prTerminal: { pr: 901, url: url(901), head, state: 'MERGED', at: ago(1) },
      history: [{ at: ago(6), event: 'live-move', kind: 'land', executed: true, ok: true, detail: 'land executed' },
        { at: ago(1), event: 'postland', detail: 'MERGED #901' }] },
    // grok × 큰 조각 — 수렴 실패
    { id: 'ta-ms-grok-large', ...large, seat: 'TC', checklistId: 'CELL-MS-2', status: 'failed',
      childLlm: childLlm('grok', 'grok-4.7'), tier: '중', createdAt: ago(30),
      history: [{ at: ago(30), event: 'run-bound', runId: 'run-ms-grok-large' }, { at: ago(2), event: 'failed', detail: 'no-progress' }] },
    // codex × 작은 조각 — PR 착지
    { id: 'ta-ms-codex-small', ...small, seat: 'TC', checklistId: 'CELL-MS-3', status: 'landed',
      childLlm: childLlm('codex', 'gpt-5.4'), tier: '상', createdAt: ago(30), pr: { number: 902, url: url(902) },
      prTerminal: { pr: 902, url: url(902), head, state: 'MERGED', at: ago(1.5) },
      history: [{ at: ago(1.5), event: 'postland', detail: 'MERGED #902' }] },
    // codex × 큰 조각 — PR MERGED 종결 증거로 착지. post-land partial(남은 작업)만으로는 범위 이탈로 세지 않는다.
    { id: 'ta-ms-codex-large', ...large, seat: 'TC', checklistId: 'CELL-MS-4', status: 'landed',
      childLlm: childLlm('codex', 'gpt-5.4'), tier: '상', createdAt: ago(30), pr: { number: 903, url: url(903) },
      prTerminal: { pr: 903, url: url(903), head, state: 'MERGED', at: ago(2) },
      postLand: { pr: 903, head, at: ago(2), outcome: 'partial', evidence: [], remaining: ['남은 칸'] },
      history: [{ at: ago(2), event: 'postland', detail: 'MERGED #903 · 칸 yellow' }] },
    // claude × 작은 조각 — 수렴 실패
    { id: 'ta-ms-claude-small', ...small, seat: 'TC', checklistId: 'CELL-MS-5', status: 'launch-failed',
      childLlm: childLlm('claude', 'opus-4.6'), tier: '특', createdAt: ago(30),
      history: [{ at: ago(3), event: 'launch-failed', detail: 'child rc=2' }] },
    // claude × 큰 조각 — 결과 줄 없음(PR 은 닫혔지만 종결 사건 줄이 없다)
    { id: 'ta-ms-claude-large', ...large, seat: 'TC', checklistId: 'CELL-MS-6', status: 'launched',
      childLlm: childLlm('claude', 'opus-4.6'), tier: '특', createdAt: ago(30), pr: { number: 904, url: url(904) },
      prTerminal: { pr: 904, url: url(904), head, state: 'CLOSED', at: ago(2.5) }, history: [] },
    // 실제 범위 이탈 증거 — hand-move(trim-scope)로 범위를 잘랐다(관측된 사실). MERGED 증거가 있어도 범위 이탈로 분류한다.
    { id: 'ta-ms-codex-trim-scope', ...small, seat: 'TC', checklistId: 'CELL-MS-8', status: 'launched',
      childLlm: childLlm('codex', 'gpt-5.4'), tier: '상', createdAt: ago(28), pr: { number: 905, url: url(905) },
      prTerminal: { pr: 905, url: url(905), head, state: 'MERGED', at: ago(2) },
      history: [{ at: ago(2), event: 'postland', detail: 'MERGED #905' },
        { at: ago(2), event: 'hand-move', kind: 'trim-scope', executed: true, ok: true, detail: '범위를 잘라 남은 칸을 버렸다' }] },
    // 카드 상태가 done 이어도 PR 종결 증거(pr ⊕ 원장 prTerminal)가 없으면 착지로 단정하지 않는다.
    { id: 'ta-ms-claude-done-no-evidence', ...small, seat: 'TC', checklistId: 'CELL-MS-9', status: 'done',
      childLlm: childLlm('claude', 'opus-4.6'), tier: '특', createdAt: ago(22), pr: { number: 906, url: url(906) },
      prTerminal: { pr: 906, url: url(906), head, state: 'CLOSED', at: ago(2) }, history: [] },
    // 모델만 못 읽고 등급·크기는 읽히는 카드 — 그 칸의 unknown 수는 0 이 아니라 1 로 센다.
    { id: 'ta-ms-model-unknown', ...small, seat: 'TC', checklistId: 'CELL-MS-10', status: 'failed', tier: '중',
      createdAt: ago(20), history: [{ at: ago(4), event: 'failed', detail: '자식 모델 기록 없음' }] },
    // 모델·등급·바꿀 동작을 못 읽은 카드 — «0» 이 아니라 unknown 으로 센다.
    { id: 'ta-ms-unknown', text: '대상 경로: src/one.ts\n경계: 이 카드는 옛 원장이라 모델·등급·바꿀 동작 칸이 없다',
      targetPaths: ['src/one.ts'], seat: 'TC', checklistId: 'CELL-MS-7', status: 'failed', createdAt: ago(30),
      history: [{ at: ago(4), event: 'failed', detail: '옛 원장' }] },
  ];
  return { cards, ago, childLlm, smallText, largeText };
};

test('MODEL-SIZE-OUTCOME-MEASURE — outcomes --by model,size 는 카드마다 모델·등급·크기·결과를 묶고 칸별 성공률·표본·unknown 을 낸다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-outcomes-by-model-size-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    const now = Date.parse('2026-10-21T02:00:00.000Z');
    const fixture = modelSizeUniverse(now);
    writeTaskCards(statePath, fixture.cards);
    const result = await run(['tasks', 'outcomes', '--since', '24h', '--by', 'model,size', '--json'],
      { taskStatePath: statePath, registerSink: async () => {}, outcomesNow: () => now });
    expect(result.code ?? 0).toBe(0);
    const body = JSON.parse(result.lines[0]!);
    const by = body.byModelSize;
    expect(by.dimensions).toEqual(['model', 'size']);
    expect(by.samples).toBe(10);
    // 카드마다 자식 모델 · 등급 · 조각 크기(대상 경로 수 · 바꿀 동작 수) · 결과
    const card = (id: string) => by.cards.find((row: { card: string }) => row.card === id);
    expect(card('ta-ms-grok-small')).toEqual({ card: 'ta-ms-grok-small', model: 'grok/grok-4.7', tier: '중',
      size: { targetPaths: 1, behaviors: 1 }, result: 'landed' });
    expect(card('ta-ms-grok-large')).toEqual({ card: 'ta-ms-grok-large', model: 'grok/grok-4.7', tier: '중',
      size: { targetPaths: 3, behaviors: 2 }, result: 'convergence-failure' });
    expect(card('ta-ms-codex-small')).toMatchObject({ model: 'codex/gpt-5.4', tier: '상', size: { targetPaths: 1, behaviors: 1 }, result: 'landed' });
    expect(card('ta-ms-codex-large')).toMatchObject({ model: 'codex/gpt-5.4', tier: '상', size: { targetPaths: 3, behaviors: 2 }, result: 'landed' });
    // 범위 이탈은 partial 대리 신호가 아니라 hand-move(trim-scope) 관측으로만 분류한다.
    expect(card('ta-ms-codex-trim-scope')).toMatchObject({ model: 'codex/gpt-5.4', tier: '상', size: { targetPaths: 1, behaviors: 1 }, result: 'scope-escape' });
    // done 상태 + PR 종결 증거 없음 → 착지로 단정하지 않는다.
    expect(card('ta-ms-claude-done-no-evidence')).toMatchObject({ model: 'claude/opus-4.6', tier: '특', size: { targetPaths: 1, behaviors: 1 }, result: 'no-result-line' });
    // 모델만 못 읽어도 등급·크기는 읽은 그대로 낸다.
    expect(card('ta-ms-model-unknown')).toEqual({ card: 'ta-ms-model-unknown', model: 'unknown', tier: '중',
      size: { targetPaths: 1, behaviors: 1 }, result: 'convergence-failure' });
    expect(card('ta-ms-claude-small')).toMatchObject({ model: 'claude/opus-4.6', tier: '특', size: { targetPaths: 1, behaviors: 1 }, result: 'convergence-failure' });
    expect(card('ta-ms-claude-large')).toMatchObject({ model: 'claude/opus-4.6', tier: '특', size: { targetPaths: 3, behaviors: 2 }, result: 'no-result-line' });
    // 못 읽은 값은 unknown — 0 이나 빈 크기로 지어내지 않는다.
    expect(card('ta-ms-unknown')).toEqual({ card: 'ta-ms-unknown', model: 'unknown', tier: 'unknown',
      size: { targetPaths: 1, behaviors: 'unknown' }, result: 'convergence-failure' });
    expect(by.unknown).toEqual({ model: 2, tier: 1, size: 1 });
    // 모델×크기 칸별 성공률 · 표본 수 · unknown 수
    const cell = (model: string, size: string) => by.cells.find((row: { model: string; size: string }) => row.model === model && row.size === size);
    expect(cell('grok/grok-4.7', 'paths=1·behaviors=1')).toEqual({ model: 'grok/grok-4.7', size: 'paths=1·behaviors=1',
      samples: 1, landed: 1, successRate: 1, unknown: 0,
      results: { landed: 1, 'scope-escape': 0, 'convergence-failure': 0, 'no-result-line': 0 } });
    expect(cell('grok/grok-4.7', 'paths=3·behaviors=2')).toEqual({ model: 'grok/grok-4.7', size: 'paths=3·behaviors=2',
      samples: 1, landed: 0, successRate: 0, unknown: 0,
      results: { landed: 0, 'scope-escape': 0, 'convergence-failure': 1, 'no-result-line': 0 } });
    expect(cell('codex/gpt-5.4', 'paths=3·behaviors=2')).toEqual({ model: 'codex/gpt-5.4', size: 'paths=3·behaviors=2',
      samples: 1, landed: 1, successRate: 1, unknown: 0,
      results: { landed: 1, 'scope-escape': 0, 'convergence-failure': 0, 'no-result-line': 0 } });
    // 모델만 unknown 인 카드의 칸 — unknown 수는 1(한 축이라도 못 읽으면 unknown).
    expect(cell('unknown', 'paths=1·behaviors=1')).toEqual({ model: 'unknown', size: 'paths=1·behaviors=1',
      samples: 1, landed: 0, successRate: 0, unknown: 1,
      results: { landed: 0, 'scope-escape': 0, 'convergence-failure': 1, 'no-result-line': 0 } });
    expect(cell('unknown', 'unknown')).toEqual({ model: 'unknown', size: 'unknown', samples: 1, landed: 0,
      successRate: 0, unknown: 1,
      results: { landed: 0, 'scope-escape': 0, 'convergence-failure': 1, 'no-result-line': 0 } });
    expect(by.cells).toHaveLength(8);
    expect(by.limitReached).toBe(false);
    // 보존: --by 없이는 지금 JSON 그대로 — byModelSize 칸이 생기지 않는다.
    const plain = JSON.parse((await run(['tasks', 'outcomes', '--since', '24h', '--json'],
      { taskStatePath: statePath, registerSink: async () => {}, outcomesNow: () => now })).lines[0]!);
    expect(plain.byModelSize).toBeUndefined();
    expect(plain.aggregate).toEqual(body.aggregate);
    expect(plain.rows).toEqual(body.rows);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MODEL-SIZE-OUTCOME-MEASURE — --by 는 model,size 외 값을 거부하고 아무것도 지어내지 않는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-outcomes-by-reject-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    writeTaskCards(statePath, []);
    for (const value of ['model', 'tier,size', 'model,size,tier']) {
      const result = await run(['tasks', 'outcomes', '--by', value, '--json'], { taskStatePath: statePath, registerSink: async () => {} });
      expect(result.code).toBe(1);
      expect(JSON.parse(result.lines[0]!).error).toContain('--by');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MODEL-SIZE-OUTCOME-MEASURE 실물 — --test 우주의 실물 CLI 프로세스가 outcomes --by model,size 원문을 낸다', async () => {
  const universe = mkdtempSync(join(tmpdir(), 'ta-model-size-live-universe-'));
  try {
    const statePath = join(universe, 'task-agent-actions.json');
    const now = Date.now();
    const fixture = modelSizeUniverse(now);
    writeTaskCards(statePath, fixture.cards);
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.ELANOUS_CONFIG_DIR;
    delete env.ELANOUS_STATE_DIR;
    const proc = Bun.spawn([process.execPath, ELANOUS_CLI_ENTRY, `--test=${universe}`, 'tasks', 'outcomes', '--since', '24h', '--by', 'model,size', '--json'], {
      cwd: universe, stdout: 'pipe', stderr: 'pipe', env,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code, stderr).toBe(0);
    const by = JSON.parse(stdout.trim()).byModelSize;
    expect(by.samples).toBe(10);
    expect(by.unknown).toEqual({ model: 2, tier: 1, size: 1 });
    expect(by.cells).toContainEqual({ model: 'grok/grok-4.7', size: 'paths=1·behaviors=1', samples: 1, landed: 1,
      successRate: 1, unknown: 0, results: { landed: 1, 'scope-escape': 0, 'convergence-failure': 0, 'no-result-line': 0 } });
    expect(by.cells).toContainEqual({ model: 'codex/gpt-5.4', size: 'paths=3·behaviors=2', samples: 1, landed: 1,
      successRate: 1, unknown: 0, results: { landed: 1, 'scope-escape': 0, 'convergence-failure': 0, 'no-result-line': 0 } });
  } finally { rmSync(universe, { recursive: true, force: true }); }
}, 30_000);

test('TA-CARD-OUTCOMES-MANUAL — closed-by-hand는 landed-by-hand의 명시적 종결 시각이다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-outcomes-manual-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    const now = Date.parse('2026-10-21T02:00:00.000Z');
    const closedAt = new Date(now - 3_600_000).toISOString();
    writeTaskCards(statePath, [{ id: 'ta-manual-landed', text: '손 착지', checklistId: 'CELL-MANUAL',
      status: 'landed-by-hand', createdAt: new Date(now - 30 * 3_600_000).toISOString(),
      history: [{ at: closedAt, event: 'closed-by-hand', reason: '  손 착지\n확인\t완료  ' }] }]);
    const body = JSON.parse((await run(['tasks', 'outcomes', '--since', '24h', '--json'], {
      taskStatePath: statePath, registerSink: async () => {}, outcomesNow: () => now,
    })).lines[0]!);
    expect(body.rows).toMatchObject([{ card: 'ta-manual-landed', endedAt: closedAt,
      reason: null, reasonFrom: null }]);
    expect(body.aggregate).toMatchObject({ cards: 1, cardTerminals: 1, prTerminals: 0, failedCardTerminals: 0, reasons: [], missingReason: 0 });
    expect(body.undatedCards).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TA-CARD-OUTCOMES-PR-CHRONOLOGY — 재결속 전후 사건은 시각만 세고 사유는 모두 미측정한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-outcomes-pr-chronology-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    const now = Date.parse('2026-10-21T02:00:00.000Z');
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const url = 'https://github.com/ElanvitalAI/elanous/pull/789';
    const mergedUrl = 'https://github.com/ElanvitalAI/elanous/pull/790';
    writeTaskCards(statePath, [{ id: 'ta-old-failure', text: '옛 실패', checklistId: 'CELL-OLD',
      status: 'failed', createdAt: ago(30), pr: { number: 789, url },
      prTerminal: { pr: 789, url, head: 'd'.repeat(40), state: 'CLOSED', at: ago(1) },
      history: [{ at: ago(3), event: 'failed', detail: '  과거 실패 원문  ' }] },
    { id: 'ta-new-failure', text: '새 실패', checklistId: 'CELL-NEW',
      status: 'failed', createdAt: ago(30), pr: { number: 790, url: mergedUrl },
      prTerminal: { pr: 790, url: mergedUrl, head: 'e'.repeat(40), state: 'MERGED', at: ago(3) },
      history: [{ at: ago(1), event: 'failed', detail: '  병합 뒤 실패  ' }] },
    { id: 'ta-space-reason', text: '공백 원문', checklistId: 'CELL-SPACE',
      status: 'failed', createdAt: ago(30), history: [{ at: ago(0.5), event: 'failed', detail: ' \n\t ' }] }]);
    const body = JSON.parse((await run(['tasks', 'outcomes', '--since', '24h', '--json'], {
      taskStatePath: statePath, registerSink: async () => {}, outcomesNow: () => now,
    })).lines[0]!);
    expect(body.rows.find((row: TaskOutcomeRow) => row.card === 'ta-old-failure' && row.terminalKind === 'pr')).toMatchObject({
      endedAt: ago(1), pr: { number: 789, state: 'CLOSED' }, reason: null, reasonFrom: null });
    expect(body.rows.find((row: TaskOutcomeRow) => row.card === 'ta-new-failure' && row.terminalKind === 'card')).toMatchObject({
      endedAt: ago(1), pr: { number: 790, state: 'MERGED' }, reason: null, reasonFrom: null });
    expect(body.rows.find((row: TaskOutcomeRow) => row.card === 'ta-space-reason')).toMatchObject({
      endedAt: ago(0.5), reason: null, reasonFrom: null });
    expect(body.aggregate).toMatchObject({ cards: 3, cardTerminals: 3, prTerminals: 2, failedCardTerminals: 3, reasons: [], missingReason: 3 });
    expect(body.overlapCardIds).toEqual(['ta-new-failure', 'ta-old-failure']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TA-OUTCOMES-TERMINAL-REASON 실물 두 건 — 옛 손종결 카드의 오늘 PR 닫힘과 launched 카드의 오늘 PR 병합은 카드 종단이 아니다', async () => {
  const universe = mkdtempSync(join(tmpdir(), 'ta-outcomes-terminal-universe-'));
  try {
    const statePath = join(universe, 'task-agent-actions.json');
    const url = (n: number) => `https://github.com/ElanvitalAI/elanous/pull/${n}`;
    const closedAt = '2026-10-20T06:00:00.000Z';
    const prClosedAt = '2026-10-22T07:00:00.000Z';
    const prMergedAt = '2026-10-22T08:00:00.000Z';
    writeTaskCards(statePath, [
      { id: 'ta-closed-pr-later', text: '손종결 뒤 PR 닫힘', status: 'landed-by-hand', createdAt: '2026-10-19T00:00:00.000Z',
        runId: 'run-terminal-old', runChildId: 'run-terminal-old-child', pr: { number: 920, url: url(920) },
        prTerminal: { pr: 920, url: url(920), head: 'a'.repeat(40), state: 'CLOSED', at: prClosedAt },
        history: [{ at: closedAt, event: 'closed-by-hand', reason: '손종결' }] },
      { id: 'ta-launched-pr-merged', text: '발사 뒤 PR 병합', status: 'launched', createdAt: '2026-10-20T00:00:00.000Z',
        runId: 'run-terminal-merge', runChildId: 'run-terminal-merge-child', pr: { number: 921, url: url(921) },
        prTerminal: { pr: 921, url: url(921), head: 'b'.repeat(40), state: 'MERGED', at: prMergedAt },
        history: [{ at: '2026-10-20T01:00:00.000Z', event: 'run-bound' }] },
    ]);
    const ledgerDir = join(universe, 'run-ledger');
    appendRunLedgerEntry({ runId: 'run-terminal-old', event: 'pod-child-run', data: { childRunId: 'run-terminal-old-child' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-terminal-old-child', event: 'child-error', data: { error: '원문 child-error: 오래된 손종결' } }, ledgerDir);
    recordRunExit({ runId: 'run-terminal-old', reason: 'stopped', status: 1, signal: null, at: closedAt,
      lastLines: ['원문 lastLines: 작업자가 종결'] }, universe);
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.ELANOUS_CONFIG_DIR;
    delete env.ELANOUS_STATE_DIR;
    const command = async (by?: 'card-terminal' | 'pr-terminal') => {
      const proc = Bun.spawn([process.execPath, ELANOUS_CLI_ENTRY, `--test=${universe}`, 'tasks', 'outcomes',
        '--since', '2026-10-22T00:00:00.000Z', '--until', '2026-10-22T23:59:59.999Z', ...(by ? ['--by', by] : []), '--json'],
      { cwd: universe, stdout: 'pipe', stderr: 'pipe', env });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited, stderr).toBe(0);
      return JSON.parse(stdout.trim());
    };
    const all = await command();
    expect(all.aggregate).toMatchObject({ cards: 2, cardTerminals: 0, prTerminals: 2, failedCardTerminals: 0, missingReason: 0 });
    expect(all.rows).toHaveLength(2);
    expect(all.rows.find((row: TaskOutcomeRow) => row.card === 'ta-closed-pr-later')).toMatchObject({
      terminalKind: 'pr', endedAt: prClosedAt, cardTerminalAt: closedAt, prTerminalAt: prClosedAt,
      ghTerminalAt: null, ghTerminalMissing: 'not-stored-in-card',
      countReason: `pr:CLOSED:#920@${prClosedAt}`, reason: null, reasonFrom: null,
      evidence: { childLedger: { event: 'child-error', error: '원문 child-error: 오래된 손종결' }, childLedgerMissing: null,
        lastLines: ['원문 lastLines: 작업자가 종결'], lastLinesMissing: null },
    });
    expect(all.rows.find((row: TaskOutcomeRow) => row.card === 'ta-launched-pr-merged')).toMatchObject({
      terminalKind: 'pr', endedAt: prMergedAt, cardTerminalAt: null, prTerminalAt: prMergedAt,
      ghTerminalAt: null, ghTerminalMissing: 'not-stored-in-card',
      countReason: `pr:MERGED:#921@${prMergedAt}`, reason: null,
      evidence: { childLedger: null, childLedgerMissing: 'parent-ledger-missing',
        lastLines: null, lastLinesMissing: 'run-exit-missing' },
    });
    expect((await command('card-terminal')).aggregate).toMatchObject({ cards: 0, cardTerminals: 0, prTerminals: 0 });
    expect((await command('pr-terminal')).aggregate).toMatchObject({ cards: 2, cardTerminals: 0, prTerminals: 2 });
  } finally { rmSync(universe, { recursive: true, force: true }); }
}, 30_000);

test('TA-OUTCOMES-TERMINAL-REASON 원격 — 호스트 거울의 자식 오류만 귀속하고 거울 부재는 unknown 으로 남긴다', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-outcomes-remote-reason-'));
  try {
    const statePath = join(root, 'task-agent-actions.json');
    const endedAt = '2026-10-22T09:00:00.000Z';
    const card = (id: string, runId: string, host: string): TaskCard => ({ id, text: '원격 실패', status: 'failed',
      runId, runChildId: `${runId}-child`, parentHost: { host }, createdAt: '2026-10-21T00:00:00.000Z',
      history: [{ at: endedAt, event: 'failed' }] });
    writeTaskCards(statePath, [card('ta-remote-mirrored', 'run-remote-mirrored', 'node-b'),
      card('ta-remote-unmirrored', 'run-remote-unmirrored', 'wsl')]);
    const mirror = remoteLedgerMirrorDir(root, 'node-b');
    appendRunLedgerEntry({ runId: 'run-remote-mirrored', event: 'pod-child-run',
      data: { childRunId: 'run-remote-mirrored-child' } }, mirror);
    appendRunLedgerEntry({ runId: 'run-remote-mirrored-child', event: 'child-error',
      data: { error: '원격 원문: Pod child failed' } }, mirror);
    // 로컬의 동명 원장은 원격 카드의 사유로 써서는 안 된다.
    appendRunLedgerEntry({ runId: 'run-remote-unmirrored', event: 'pod-child-run',
      data: { childRunId: 'run-remote-unmirrored-child' } }, join(root, 'run-ledger'));
    appendRunLedgerEntry({ runId: 'run-remote-unmirrored-child', event: 'child-error',
      data: { error: '잘못된 로컬 원문' } }, join(root, 'run-ledger'));
    const report = readTaskOutcomes({ sinceMs: Date.parse('2026-10-22T00:00:00.000Z'),
      untilMs: Date.parse('2026-10-22T23:59:59.999Z') }, { taskStatePath: statePath });
    expect(report.aggregate).toMatchObject({ cardTerminals: 2, prTerminals: 0, failedCardTerminals: 2,
      missingReason: 1, reasons: [{ reason: '원격 원문: Pod child failed', count: 1 }] });
    expect(report.rows.find((row) => row.card === 'ta-remote-mirrored')).toMatchObject({
      reason: '원격 원문: Pod child failed', reasonFrom: 'child-ledger:child-error',
      evidence: { childLedger: { event: 'child-error', error: '원격 원문: Pod child failed' }, childLedgerMissing: null },
    });
    expect(report.rows.find((row) => row.card === 'ta-remote-unmirrored')).toMatchObject({
      reason: null, reasonFrom: null,
      evidence: { childLedger: null, childLedgerMissing: 'remote-ledger-mirror-missing' },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MODEL-SIZE-OUTCOME-MEASURE 반례 — 실행·성공이 명시되지 않은 trim-scope 조정은 범위 이탈로 세지 않는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-outcomes-trim-exec-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    const now = Date.parse('2026-10-21T02:00:00.000Z');
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const head = 'f'.repeat(40);
    const url = (n: number) => `https://github.com/ElanvitalAI/elanous/pull/${n}`;
    const trimLine = (executed?: boolean, ok?: boolean) => ({ at: ago(2), event: 'hand-move' as const, kind: 'trim-scope',
      ...(executed === undefined ? {} : { executed }), ...(ok === undefined ? {} : { ok }), detail: '범위를 잘랐다는 기록' });
    const card = (id: string, executed?: boolean, ok?: boolean): TaskCard => ({
      id, text: '대상 경로: src/one.ts\n바꿀 것: 한 동작만 바꾼다', targetPaths: ['src/one.ts'], seat: 'TC',
      checklistId: `CELL-${id}`, status: 'launched', childLlm: { provider: 'codex', model: 'gpt-5.4' }, tier: '상',
      createdAt: ago(28), pr: { number: 931, url: url(931) },
      prTerminal: { pr: 931, url: url(931), head, state: 'MERGED', at: ago(2) },
      history: [{ at: ago(2), event: 'postland', detail: 'MERGED #931' }, trimLine(executed, ok)] });
    // 여섯 카드의 MERGED 종결 증거는 같고 trim-scope 이력의 executed·ok 만 다르다.
    writeTaskCards(statePath, [
      card('ta-trim-executed-ok', true, true),
      card('ta-trim-not-executed', false, true),
      card('ta-trim-failed', true, false),
      card('ta-trim-execution-unrecorded', undefined, true),
      card('ta-trim-result-unrecorded', true, undefined),
      card('ta-trim-both-unrecorded'),
    ]);
    const body = JSON.parse((await run(['tasks', 'outcomes', '--since', '24h', '--by', 'model,size', '--json'],
      { taskStatePath: statePath, registerSink: async () => {}, outcomesNow: () => now })).lines[0]!);
    const cell = body.byModelSize.cells.find((c: { model: string; size: string }) =>
      c.model === 'codex/gpt-5.4' && c.size === 'paths=1·behaviors=1');
    expect(cell).toMatchObject({ samples: 6, landed: 5, unknown: 0,
      results: { landed: 5, 'scope-escape': 1, 'convergence-failure': 0, 'no-result-line': 0 } });
    expect(cell.successRate).toBeCloseTo(5 / 6, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MODEL-SIZE-OUTCOME-MEASURE 반례 — «바꿀 것: 다음» 뒤에 목록이 뒤따르면 선언 줄이 아니라 목록 동작 수를 센다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-outcomes-list-pointer-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    const now = Date.parse('2026-10-21T02:00:00.000Z');
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    writeTaskCards(statePath, [{ id: 'ta-list-pointer', seat: 'TC', checklistId: 'CELL-LIST-POINTER',
      status: 'failed', childLlm: { provider: 'grok', model: 'grok-4.7' }, tier: '중', createdAt: ago(30),
      text: '대상 경로: src/one.ts\n바꿀 것: 다음\n- 첫째 동작\n- 둘째 동작', targetPaths: ['src/one.ts'],
      history: [{ at: ago(2), event: 'failed', detail: 'no-progress' }] }]);
    const body = JSON.parse((await run(['tasks', 'outcomes', '--since', '24h', '--by', 'model,size', '--json'],
      { taskStatePath: statePath, registerSink: async () => {}, outcomesNow: () => now })).lines[0]!);
    expect(body.byModelSize.cells).toContainEqual({ model: 'grok/grok-4.7', size: 'paths=1·behaviors=2', samples: 1,
      landed: 0, successRate: 0, unknown: 0,
      results: { landed: 0, 'scope-escape': 0, 'convergence-failure': 1, 'no-result-line': 0 } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MODEL-SIZE-OUTCOME-MEASURE — 명시한 바꿀 동작 없음은 0, 선언 자체가 없으면 unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-outcomes-explicit-none-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    const now = Date.parse('2026-10-21T02:00:00.000Z');
    const ended = new Date(now - 60_000).toISOString();
    const cards = ['바꿀 것: 없음', '바꿀 동작 없음', '경계만 있고 동작 선언 없음'].map((text, i): TaskCard => ({
      id: `ta-explicit-none-${i}`, text, targetPaths: ['src/one.ts'], seat: 'TC',
      checklistId: `CELL-NONE-${i}`, status: 'failed', ...(i === 1 ? {} : { tier: '하' as const }),
      childLlm: { provider: 'codex', model: 'gpt-5.4' }, createdAt: ended,
      history: [{ at: ended, event: 'failed', detail: '종료' }],
    }));
    writeTaskCards(statePath, cards);
    const body = JSON.parse((await run(['tasks', 'outcomes', '--since', '24h', '--by', 'model,size', '--json'], {
      taskStatePath: statePath, registerSink: async () => {}, outcomesNow: () => now,
    })).lines[0]!);
    const byId = (id: string) => body.byModelSize.cards.find((row: { card: string }) => row.card === id);
    expect(byId('ta-explicit-none-0').size).toEqual({ targetPaths: 1, behaviors: 0 });
    expect(byId('ta-explicit-none-1').size).toEqual({ targetPaths: 1, behaviors: 0 });
    expect(byId('ta-explicit-none-2').size).toEqual({ targetPaths: 1, behaviors: 'unknown' });
    expect(body.byModelSize.unknown.size).toBe(1);
    expect(body.byModelSize.unknown.tier).toBe(1);
    expect(body.byModelSize.cells.find((cell: { size: string }) => cell.size === 'paths=1·behaviors=0').unknown).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MODEL-SIZE-OUTCOME-MEASURE — 한 조회의 결과와 크기는 같은 카드 스냅샷을 쓴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-cli-outcomes-snapshot-'));
  try {
    const statePath = join(dir, 'task-agent-actions.json');
    const now = Date.parse('2026-10-21T02:00:00.000Z');
    const ended = new Date(now - 60_000).toISOString();
    const first: TaskCard = { id: 'ta-snapshot', text: '바꿀 것: 첫 동작', targetPaths: ['src/one.ts'],
      checklistId: 'CELL-SNAPSHOT', status: 'failed', tier: '하', childLlm: { provider: 'codex', model: 'gpt-5.4' },
      createdAt: ended, history: [{ at: ended, event: 'failed', detail: '종료' }] };
    writeTaskCards(statePath, [first]);
    const snapshot = { [first.id]: first };
    const window = { sinceMs: now - 3_600_000, untilMs: now };
    const deps = { taskStatePath: statePath };
    const report = readTaskOutcomes(window, deps, snapshot);
    writeTaskCards(statePath, [{ ...first, text: '바꿀 것: 다음\n- 첫 동작\n- 둘째 동작', targetPaths: ['src/one.ts', 'src/two.ts'] }]);
    const dimensions = readTaskOutcomeModelSize(window, deps, report, snapshot);
    expect(dimensions.cards).toMatchObject([{ card: 'ta-snapshot', size: { targetPaths: 1, behaviors: 1 }, result: 'convergence-failure' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
