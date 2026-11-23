import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import type { TaskCard } from './task-hand.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { readTaskCard, writeTaskCards } from './task-card-state.js';
import { showTaskCard, taRecycleOutcomeLine } from '../cli/tasks-card-show.js';
import type { TasksCliDeps } from '../cli/tasks-cli.js';
import type { TaRecycleOutcome } from './launch-result-loop.js';
import {
  TA_LAUNCH_STAGES,
  TA_SKIP_NOTE_EVENT,
  TA_STOP_FAILED_EVENT,
  NO_PROGRESS_MS,
  NO_PROGRESS_CAUSES,
  classifyNoProgressCause,
  findStalledLaunches,
  landing20TaLine,
  launchStageOf,
  recycleStalledLaunches,
  taLaunchLine,
} from './launch-result-loop.js';
// 출처: terra r5 mustFix 3 — #39574 · export 존재/부재를 namespace 관측으로 검사한다(이름 import 는 부재 시 모듈 적재가 깨진다).
import * as launchResultLoopModule from './launch-result-loop.js';

/**
 * TA-LAUNCH-RESULT-LOOP(칸 0.3.32 · P1) — 대표 승인 TA 시범의 관측 고리.
 * 발사마다 카드 1줄(runId·칸·head·단계) ⊕ 15분 무진척 자동 회수(정확 runId stop) ⊕
 * 원인 분류(그라운딩·의존·예산·환경) skip-note ⊕ LANDING-20 «착지 N 중 TA M».
 * 완료 경계: 발사 대비 결과 관측 100% · 무진척 회수 ≤20분 · 원인 분류 원장 시험.
 */

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const AT = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();

const dirs: string[] = [];
afterEach(() => {
  resetElanousConfigDir();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function card(fields: Partial<TaskCard> & { id: string }): TaskCard {
  return {
    text: fields.text ?? '시범 칸 본문',
    status: fields.status ?? 'launched',
    history: fields.history ?? [],
    createdAt: fields.createdAt ?? AT(30 * 60_000),
    ...fields,
  } as TaskCard;
}

const hist = (rows: TaskCard['history']): TaskCard['history'] => rows;

/** 런 원장 파일에서 `event='stop'` 줄만 읽는다(교차 구간 실행 재현의 원문 대조용 · 파일 없으면 빈 목록). */
const readLedgerStopLines = (path: string): Array<Record<string, unknown>> =>
  existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === 'stop')
    : [];

test('launchStageOf — 카드 원장에서 단계를 닫힌 목록으로 판정한다(지어내지 않는다)', () => {
  expect(TA_LAUNCH_STAGES).toEqual(['handed', 'launched', 'pr', 'verdict', 'landed', 'failed', 'recycled']);
  expect(launchStageOf(card({ id: 'ta-1', status: 'handed' }))).toBe('handed');
  expect(launchStageOf(card({ id: 'ta-1', runId: 'run-1', launchId: 'tl-1' }))).toBe('launched');
  expect(launchStageOf(card({ id: 'ta-1', runId: 'run-1', pr: 39401 }))).toBe('pr');
  expect(launchStageOf(card({
    id: 'ta-1', runId: 'run-1', pr: 39401,
    prTerminal: { pr: 39401, url: 'https://example/pull/39401', head: 'a'.repeat(40), state: 'MERGED', at: AT(60_000) },
  }))).toBe('verdict');
  expect(launchStageOf(card({ id: 'ta-1', status: 'landed' }))).toBe('landed');
  expect(launchStageOf(card({ id: 'ta-1', status: 'landed-by-hand' }))).toBe('landed');
  expect(launchStageOf(card({ id: 'ta-1', status: 'done' }))).toBe('landed');
  expect(launchStageOf(card({ id: 'ta-1', status: 'failed', history: hist([{ at: AT(60_000), event: 'failed', detail: 'failed/needs-owner — x' }]) }))).toBe('failed');
  expect(launchStageOf(card({
    id: 'ta-1', runId: 'run-1', status: 'launched',
    history: hist([{ at: AT(60_000), event: TA_SKIP_NOTE_EVENT, detail: 'failed/recycled/grounding: …', runId: 'run-1' }]),
  }))).toBe('recycled');
});

test('taLaunchLine — 발사 한 줄: runId·칸·head·단계(없으면 «-» 미기록)', () => {
  expect(taLaunchLine(card({ id: 'ta-1', checklistId: 'LLM-USAGE-ALL-PROVIDERS-NONZERO', runId: 'run-1' })))
    .toBe('TA-LAUNCH runId=run-1 · 칸=LLM-USAGE-ALL-PROVIDERS-NONZERO · head=- · 단계=launched');
  expect(taLaunchLine(card({
    id: 'ta-2', checklistId: 'TA-SMALL-CELL-PILOT', runId: 'run-2', pr: 39401,
    prTerminal: { pr: 39401, url: 'https://example/pull/39401', head: 'abcdef1234567890', state: 'CLOSED', at: AT(60_000) },
  }))).toBe('TA-LAUNCH runId=run-2 · 칸=TA-SMALL-CELL-PILOT · head=abcdef123456 · 단계=verdict');
  expect(taLaunchLine(card({ id: 'ta-3', status: 'handed' }))).toBe('TA-LAUNCH runId=- · 칸=- · head=- · 단계=handed');
});

test('findStalledLaunches — 15분(상한 포함) 무진척 발사만, 회수됨·runId 없음·다른 상태는 제외', () => {
  const cards = [
    card({ id: 'ok-fresh', runId: 'r-fresh', history: hist([{ at: AT(5 * 60_000), event: 'live-move', detail: 'x' }]) }),
    card({ id: 'stale', runId: 'r-stale', history: hist([{ at: AT(16 * 60_000), event: 'live-move', detail: 'x' }]) }),
    card({ id: 'edge', runId: 'r-edge', history: hist([{ at: AT(NO_PROGRESS_MS), event: 'live-move', detail: 'x' }]) }),
    card({ id: 'recycled', runId: 'r-recycled', history: hist([{ at: AT(30 * 60_000), event: TA_SKIP_NOTE_EVENT, detail: 'failed/recycled/budget: …', runId: 'r-recycled' }]) }),
    card({ id: 'no-runid', history: hist([{ at: AT(30 * 60_000), event: 'live-move', detail: 'x' }]) }),
    card({ id: 'handed', status: 'handed', history: hist([{ at: AT(30 * 60_000), event: 'live-move', detail: 'x' }]) }),
  ];
  const stalled = findStalledLaunches(cards, NOW);
  expect(stalled.map((c) => c.id)).toEqual(['stale', 'edge']);
  // history 가 빈 카드는 createdAt 으로 무진척을 잰다.
  expect(findStalledLaunches([card({ id: 'created-only', runId: 'r-created', createdAt: AT(20 * 60_000), history: [] })], NOW).map((c) => c.id))
    .toEqual(['created-only']);
});

test('recycleStalledLaunches — 정확 runId stop 한 줄 + 원인 분류 skip-note 한 번(멱등)', () => {
  expect(NO_PROGRESS_CAUSES).toEqual(['grounding', 'dependency', 'budget', 'environment', 'unclassified']);
  const stops: Array<{ runId: string; cause: string; evidenceRef: string; nextMove: string; site?: string }> = [];
  const notes: Array<{ cardId: string; event: string; detail: string }> = [];
  const stale = card({ id: 'ta-stale', runId: 'r-stale', checklistId: 'CELL-A', history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]) });
  const fresh = card({ id: 'ta-fresh', runId: 'r-fresh', history: hist([{ at: AT(60_000), event: 'live-move', detail: 'x' }]) });
  const outcomes = recycleStalledLaunches([stale, fresh], {
    nowMs: NOW,
    recordStop: (input) => { stops.push(input); },
    appendHistory: (cardId, event, detail) => { notes.push({ cardId, event, detail }); },
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: (cardId) => (cardId === 'ta-stale' ? stale : cardId === 'ta-fresh' ? fresh : undefined),
  });
  expect(outcomes).toHaveLength(1);
  const outcome = outcomes[0]!;
  expect(outcome.cardId).toBe('ta-stale');
  expect(outcome.runId).toBe('r-stale');
  expect(outcome.cause).toBe('environment');
  expect(outcome.minutesStalled).toBe(20);
  expect(outcome.stopRecorded).toBe(true);
  expect(stops).toEqual([{
    runId: 'r-stale',
    cause: '15분 무진척 회수 — 정확 runId stop(environment)',
    evidenceRef: 'run-ledger:r-stale:stop',
    nextMove: '칸 CELL-A skip-note 확인 — 사람/판단부가 재발사 여부를 판단',
    site: 'launch-result-loop',
  }]);
  expect(notes).toEqual([{
    cardId: 'ta-stale',
    event: TA_SKIP_NOTE_EVENT,
    detail: 'failed/recycled/environment: 15분 무진척(20분) — 정확 runId r-stale stop · 재발사는 사람/판단부 몫',
  }]);
  // 멱등 — 두 번째 관측에서는 같은 runId 의 회수 노트가 있어 다시 회수하지 않는다.
  const noted = card({ id: 'ta-stale', runId: 'r-stale', checklistId: 'CELL-A', history: hist([{ at: AT(20 * 60_000), event: TA_SKIP_NOTE_EVENT, detail: 'failed/recycled/environment: …', runId: 'r-stale' }]) });
  const again = recycleStalledLaunches([noted], { nowMs: NOW, recordStop: (input) => { stops.push(input); }, appendHistory: (cardId, event, detail) => { notes.push({ cardId, event, detail }); }, readCard: () => noted });
  expect(again).toEqual([]);
  expect(stops).toHaveLength(1);
  expect(notes).toHaveLength(1);
});

test('classifyNoProgressCause — 런 stop 이유 코드를 칸 원인 닫힌 목록으로', () => {
  expect(classifyNoProgressCause('tdd-evidence-missing')).toBe('grounding');
  expect(classifyNoProgressCause('goal-only-same-cell')).toBe('grounding');
  expect(classifyNoProgressCause('merge-held-release-path')).toBe('dependency');
  expect(classifyNoProgressCause('out-of-scope-held')).toBe('dependency');
  expect(classifyNoProgressCause('decomposition-401-invalid-api-key')).toBe('budget');
  expect(classifyNoProgressCause('provider-credential-failure')).toBe('environment');
  expect(classifyNoProgressCause('no-review-provider')).toBe('environment');
  expect(classifyNoProgressCause('unknown')).toBe('unclassified');
  expect(classifyNoProgressCause('pod-vanished')).toBe('unclassified');
});

test('landing20TaLine — LANDING-20 매시 점검 «착지 N 중 TA M» 한 줄', () => {
  const cards = [
    card({ id: 'a', runId: 'r1', status: 'landed' }),
    card({ id: 'b', runId: 'r2', pr: 39401 }),
    card({ id: 'c', runId: 'r3', history: hist([{ at: AT(60_000), event: TA_SKIP_NOTE_EVENT, detail: 'failed/recycled/budget: …', runId: 'r3' }]) }),
    card({ id: 'd', runId: 'r4' }),
    card({ id: 'e', status: 'handed' }),
  ];
  expect(landing20TaLine({ landingCount: 7, cards, nowMs: NOW }))
    .toBe('착지 7 중 TA 1 · TA 발사 4 · 진행 2(launched 1·pr 1) · 회수 1');
  expect(landing20TaLine({ landingCount: 0, cards: [], nowMs: NOW })).toBe('착지 0 중 TA 0 · TA 발사 0 · 진행 0(launched 0·pr 0) · 회수 0');
});

// ── 관측 고리 배선(`eln tasks show`) — 실패 먼저: 배선 전엔 이 아래 시험이 빨강이다. ──

function showDeps(statePath: string, nowMs?: number): TasksCliDeps {
  return {
    taskStatePath: statePath,
    registerSink: async () => true, // 스텁 — 임시 config dir 에 실 standalone 싱크 등록 시도를 막는다(fail-open이지만 결정적이게)
    ...(nowMs !== undefined ? { reviewResultNow: () => new Date(nowMs) } : {}),
  } as unknown as TasksCliDeps;
}

test('tasks show — 발사 카드에 TA-LAUNCH 관측 한 줄을 렌더한다(관측 고리)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-show-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const statePath = join(root, 'task-agent-actions.json');
  writeTaskCards(statePath, [card({
    id: 'ta-show', runId: 'r-show', checklistId: 'CELL-SHOW', pr: 39401,
    createdAt: AT(60_000), history: hist([{ at: AT(60_000), event: 'live-move', detail: 'x' }]),
  })]);
  const lines: string[] = [];
  await showTaskCard('ta-show', {}, showDeps(statePath, NOW), (line) => lines.push(line));
  const taLine = lines.find((line) => line.startsWith('TA-LAUNCH '));
  expect(taLine).toBe('TA-LAUNCH runId=r-show · 칸=CELL-SHOW · head=- · 단계=pr');
  // 진척 있는 발사는 회수 대상이 아니다 — skip-note 가 붙지 않는다.
  const after = readTaskCard('ta-show', statePath);
  expect((after?.history ?? []).some((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toBe(false);
});

test('tasks show — 15분 무진척 발사를 관측에서 자동 회수한다(정확 runId stop + skip-note 한 번 · 멱등)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-recycle-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const statePath = join(root, 'task-agent-actions.json');
  const staleAt = new Date(NOW - 20 * 60_000).toISOString();
  writeTaskCards(statePath, [card({
    id: 'ta-stale-show', runId: 'r-stale-show', checklistId: 'CELL-RE', createdAt: staleAt,
    history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]),
  })]);
  const lines: string[] = [];
  await showTaskCard('ta-stale-show', {}, showDeps(statePath, NOW), (line) => lines.push(line));
  const after = readTaskCard('ta-stale-show', statePath);
  const last = after?.history.at(-1) as { event?: string; detail?: string } | undefined;
  expect(last?.event).toBe(TA_SKIP_NOTE_EVENT);
  expect(String(last?.detail)).toContain('failed/recycled/');
  expect(String(last?.detail)).toContain('r-stale-show');
  expect(lines.some((line) => line.startsWith('TA-LAUNCH ') && line.includes('단계=recycled'))).toBe(true);
  expect(lines.some((line) => line.startsWith('TA 회수'))).toBe(true);
  // 멱등 — 두 번째 관측은 다시 회수하지 않는다(skip-note 1개 유지).
  const lines2: string[] = [];
  await showTaskCard('ta-stale-show', {}, showDeps(statePath, NOW), (line) => lines2.push(line));
  const after2 = readTaskCard('ta-stale-show', statePath);
  expect((after2?.history ?? []).filter((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toHaveLength(1);
  expect(lines2.some((line) => line.startsWith('TA 회수'))).toBe(false);
});
// ── 정확 runId stop 기록 실패 경로 — 실패 먼저: 수리 전엔 이 아래 시험이 빨강이다(JUD-B HOLD 39400-8a9c06bfb0f4). ──

test('recycleStalledLaunches — 정확 runId stop 기록 실패(false) 시 영구 skip-note 금지 · 재시도 대상 유지', () => {
  const stops: Array<{ runId: string; cause: string; evidenceRef: string; nextMove: string; site?: string }> = [];
  const notes: Array<{ cardId: string; event: string; detail: string }> = [];
  const stale = card({
    id: 'ta-stopfail', runId: 'r-stopfail', checklistId: 'CELL-HF',
    history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]),
  });
  // 첫 관측 — 런 원장 stop 기록이 실패한다(기록기 예외와 동등한 false).
  const first = recycleStalledLaunches([stale], {
    nowMs: NOW,
    recordStop: (input) => { stops.push(input); return false; },
    appendHistory: (cardId, event, detail) => { notes.push({ cardId, event, detail }); },
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: () => stale,
  });
  expect(first).toHaveLength(1);
  expect(first[0]!.stopRecorded).toBe(false);
  // 영구 제외 skip-note 는 남지 않는다 — 회수 아님, 재시도 대상.
  expect(notes.filter((note) => note.event === TA_SKIP_NOTE_EVENT)).toEqual([]);
  // 대신 실패 마커 한 줄(재시도 대상임을 카드 원장에 표시).
  expect(notes).toEqual([{
    cardId: 'ta-stopfail',
    event: 'ta-stop-record-failed',
    detail: expect.stringContaining('재시도 대상 유지'),
  }]);
  // 마커는 관측 시각을 갱신한다 — 15분 뒤 재시도 가능, 그 전엔 아니다.
  const marked = card({
    ...stale,
    history: hist([...(stale.history ?? []), { at: new Date(NOW).toISOString(), event: 'ta-stop-record-failed', detail: 'stop-record-failed/environment: …', runId: 'r-stopfail' }]),
  });
  expect(findStalledLaunches([marked], NOW + 14 * 60_000)).toEqual([]);
  expect(findStalledLaunches([marked], NOW + 15 * 60_000).map((c) => c.id)).toEqual(['ta-stopfail']);
  // 두 번째 관측 — stop 기록이 성공하면 그때 정상 회수(skip-note 한 줄).
  const second = recycleStalledLaunches([marked], {
    nowMs: NOW + 15 * 60_000,
    recordStop: (input) => { stops.push(input); },
    appendHistory: (cardId, event, detail) => { notes.push({ cardId, event, detail }); },
    readCard: () => marked,
  });
  expect(second).toHaveLength(1);
  expect(second[0]!.stopRecorded).toBe(true);
  const skipNotes = notes.filter((note) => note.event === TA_SKIP_NOTE_EVENT);
  expect(skipNotes).toHaveLength(1);
  expect(skipNotes[0]!.detail.startsWith('failed/recycled/')).toBe(true);
  // 두 관측 모두 stop 을 시도했다 — 실패 1 + 성공 1(실패가 재시도를 삼키지 않는다).
  expect(stops).toHaveLength(2);
  // 회수된 카드는 이후 관측에서 다시 회수하지 않는다(멱등).
  const recycledCard = card({
    ...marked,
    history: hist([...(marked.history ?? []), { at: new Date(NOW + 15 * 60_000).toISOString(), event: TA_SKIP_NOTE_EVENT, detail: 'failed/recycled/environment: …', runId: 'r-stopfail' }]),
  });
  expect(findStalledLaunches([recycledCard], NOW + 60 * 60_000)).toEqual([]);
});
// ── 재발사·교차 갱신 회귀 — 실패 먼저: 수리 전엔 이 아래 시험이 빨강이다(JUD-B HOLD 39400-f1e737e33dd6 · OP #118908). ──

test('재발사(새 runId) 뒤 옛 runId 의 skip-note 는 새 런을 recycled 로 오표시·회수 제외하지 않는다 (JUD-B HOLD 39400-f1e737e33dd6)', () => {
  // run-A 회수 노트가 history 에 남은 채 재발사 — 새 runId B · 최근 관측 3분.
  const relaunched = card({
    id: 'ta-relaunch', runId: 'run-B', checklistId: 'CELL-RE',
    history: hist([
      { at: AT(40 * 60_000), event: TA_SKIP_NOTE_EVENT, detail: 'failed/recycled/environment: 15분 무진척(40분) — 정확 runId run-A stop · 재발사는 사람/판단부 몫', runId: 'run-A' },
      { at: AT(3 * 60_000), event: 'live-move', detail: '재발사 관측' },
    ]),
  });
  // 새 런(run-B)은 진행 중이지 회수된 것이 아니다 — 옛 run-A 노트가 단계를 훔치지 않는다.
  expect(launchStageOf(relaunched)).toBe('launched');
  // 새 런이 무진척이 되면 회수 대상 — 옛 노트가 제외하지 않는다.
  expect(findStalledLaunches([relaunched], NOW + 20 * 60_000).map((c) => c.id)).toEqual(['ta-relaunch']);
  // 회수는 새 runId 로 stop·skip-note 를 남긴다(노트에 runId 결속).
  const stops: Array<{ runId: string }> = [];
  const notes: Array<{ cardId: string; event: string; detail: string; runId?: string }> = [];
  const outcomes = recycleStalledLaunches([relaunched], {
    nowMs: NOW + 20 * 60_000,
    recordStop: (input) => { stops.push(input); },
    appendHistory: (cardId, event, detail, _atMs, runId) => { notes.push({ cardId, event, detail, runId }); },
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: () => relaunched,
  });
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]!.runId).toBe('run-B');
  expect(stops.map((stop) => stop.runId)).toEqual(['run-B']);
  expect(notes).toHaveLength(1);
  expect(notes[0]!.event).toBe(TA_SKIP_NOTE_EVENT);
  expect(notes[0]!.runId).toBe('run-B');
  // 새 노트(같은 runId)가 붙은 뒤에는 멱등 — 다시 회수하지 않는다.
  const noted = card({
    ...relaunched,
    history: hist([...(relaunched.history ?? []), { at: new Date(NOW + 20 * 60_000).toISOString(), event: TA_SKIP_NOTE_EVENT, detail: 'failed/recycled/environment: …', runId: 'run-B' }]),
  });
  expect(launchStageOf(noted)).toBe('recycled');
  expect(findStalledLaunches([noted], NOW + 60 * 60_000)).toEqual([]);
});

test('원장 추가 직전 현재 카드 재검증 — 스냅숏 뒤 runId 교체·진척·삭제·중복 회수면 옛 런의 stop·skip-note 를 건너뛴다 (JUD-B HOLD 39400-f1e737e33dd6)', () => {
  // 스냅숏 — run-A 무진척 20분(회수 직전 모습).
  const snapshot = card({ id: 'ta-swap', runId: 'run-A', checklistId: 'CELL-SWAP', history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]) });
  const stops: Array<{ runId: string }> = [];
  const notes: Array<{ cardId: string; event: string }> = [];
  const depsOf = (current: TaskCard | undefined) => ({
    nowMs: NOW,
    recordStop: (input: { runId: string }) => { stops.push(input); },
    appendHistory: (cardId: string, event: string) => { notes.push({ cardId, event }); },
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: () => current,
  });
  // ① 관측 사이 재발사 — 원장의 현재 카드는 이미 다른 runId: 옛 run-A 의 stop·노트를 새 카드에 남기지 않는다.
  const relaunched = card({ ...snapshot, runId: 'run-B', history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }, { at: AT(2 * 60_000), event: 'live-move', detail: 'y' }]) });
  expect(recycleStalledLaunches([snapshot], depsOf(relaunched))).toEqual([]);
  // ② 관측 사이 진척 — 같은 runId 지만 최근 관측이 갱신(자격 상실): 회수하지 않는다.
  const progressed = card({ ...snapshot, history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }, { at: AT(2 * 60_000), event: 'live-move', detail: 'y' }]) });
  expect(recycleStalledLaunches([snapshot], depsOf(progressed))).toEqual([]);
  // ③ 관측 사이 삭제 — 원장에 없는 카드: 노트를 만들지 않는다.
  expect(recycleStalledLaunches([snapshot], depsOf(undefined))).toEqual([]);
  // ④ 관측 사이 중복 회수 — 같은 runId 노트가 이미 붙었다: stop 을 반복하지 않는다(멱등).
  const alreadyNoted = card({ ...snapshot, history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }, { at: AT(19 * 60_000), event: TA_SKIP_NOTE_EVENT, detail: 'failed/recycled/environment: …', runId: 'run-A' }]) });
  expect(recycleStalledLaunches([snapshot], depsOf(alreadyNoted))).toEqual([]);
  expect(stops).toEqual([]);
  expect(notes).toEqual([]);
  // ⑤ 원장이 그대로면 정상 회수 — stop·skip-note 1건씩(스냅숏=원장일 때만).
  expect(recycleStalledLaunches([snapshot], depsOf(snapshot))).toHaveLength(1);
  expect(stops.map((stop) => stop.runId)).toEqual(['run-A']);
  expect(notes.map((note) => note.cardId)).toEqual(['ta-swap']);
});
// ── 원인 분류의 정본 = 런 원장 stop 기록 — 실패 먼저: 호출점 배선 전엔 이 아래 시험이 빨강이다(JUD-B #118928). ──

test('tasks show 회수 — 원인 분류는 런 원장 stop 기록(class)에서 읽는다(없으면 unknown→unclassified · JUD-B #118928)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-cause-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const statePath = join(root, 'task-agent-actions.json');
  const staleAt = new Date(NOW - 20 * 60_000).toISOString();
  writeTaskCards(statePath, [card({
    id: 'ta-cause', runId: 'r-ledger-1', checklistId: 'CELL-CAUSE', createdAt: staleAt,
    history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]),
  })]);
  // 런 원장 — 이 런이 멈춘 자리의 stop 한 줄(원인의 정본). 회수의 원인 분류는 여기서 읽는다(읽기 전용).
  mkdirSync(join(root, 'run-ledger'), { recursive: true });
  writeFileSync(join(root, 'run-ledger', 'r-ledger-1.jsonl'), `${JSON.stringify({
    timestamp: new Date(NOW - 19 * 60_000).toISOString(),
    runId: 'r-ledger-1',
    event: 'stop',
    data: {
      class: 'merge-held-release-path',
      cause: '병합 보류 — release 경로 대기',
      evidenceRef: 'run-ledger:r-ledger-1:stop',
      nextMove: 'OP 판정 대기',
      site: 'merge-hold',
    },
  })}\n`);
  const lines: string[] = [];
  await showTaskCard('ta-cause', {}, showDeps(statePath, NOW), (line) => lines.push(line));
  const after = readTaskCard('ta-cause', statePath);
  const last = after?.history.at(-1) as { event?: string; detail?: string } | undefined;
  expect(last?.event).toBe(TA_SKIP_NOTE_EVENT);
  // class 'merge-held-release-path' → 원인 'dependency' — 호출점이 provider 를 안 넘기면
  // 'unknown'→'unclassified' 가 되어 이 단언이 빨강이다(실패 먼저).
  expect(String(last?.detail)).toContain('failed/recycled/dependency');
});
// ── 재독 뒤 교차 구간 원자성 — 실패 먼저: 조건부 원자 append 전엔 이 아래 시험이 빨강이다(JUD-B #118991). ──

test('재독 통과 뒤 노트 추가 전 재발사가 끼면 — 옛 runId 의 skip-note 를 새 카드에 남기지 않는다 (JUD-B #118991)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-race-relaunch-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const statePath = join(root, 'task-agent-actions.json');
  // 디스크 정본 — 재독과 노트 추가 사이에 재발사가 낀 뒤(새 runId B · 3분 전 관측).
  writeTaskCards(statePath, [card({
    id: 'ta-race-relaunch', runId: 'run-B', checklistId: 'CELL-RACE',
    history: hist([{ at: AT(3 * 60_000), event: 'live-move', detail: '재발사 관측' }]),
  })]);
  // 스냅숏·재독은 옛 모습(runId A · 20분 무진척)을 본다 — 재독도 옛 카드를 돌려준다(교차 구간 재현).
  const staleView = card({
    id: 'ta-race-relaunch', runId: 'run-A', checklistId: 'CELL-RACE',
    history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]),
  });
  const stops: Array<{ runId: string }> = [];
  const outcomes = recycleStalledLaunches([staleView], {
    nowMs: NOW,
    recordStop: (input) => { stops.push(input); },
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: () => staleView,
    statePath,
  });
  const onDisk = readTaskCard('ta-race-relaunch', statePath);
  // 새 런(run-B) 카드에 옛 런(run-A)의 회수 노트가 붙지 않는다 — 추가는 잠금 아래 재검증을 통과해야 한다.
  expect((onDisk?.history ?? []).some((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toBe(false);
  expect(outcomes).toEqual([]);
  // stop 도 잠금 아래 재검증을 통과해야만 기록된다 — 재발사로 교체된 옛 run-A 에 stop 줄을 남기지 않는다(JUD-B #119045).
  expect(stops).toEqual([]);
});

test('재독 통과 뒤 노트 추가 전 진척(live-move)이 끼면 — skip-note 를 붙이지 않는다 (JUD-B #118991)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-race-progress-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const statePath = join(root, 'task-agent-actions.json');
  // 디스크 정본 — 같은 runId A 지만 재독 뒤 진척 관측이 끼었다(2분 전 — 회수 자격 상실).
  writeTaskCards(statePath, [card({
    id: 'ta-race-progress', runId: 'run-A', checklistId: 'CELL-RACE',
    history: hist([
      { at: AT(20 * 60_000), event: 'live-move', detail: 'x' },
      { at: AT(2 * 60_000), event: 'live-move', detail: '진척 관측' },
    ]),
  })]);
  const staleView = card({
    id: 'ta-race-progress', runId: 'run-A', checklistId: 'CELL-RACE',
    history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]),
  });
  const outcomes = recycleStalledLaunches([staleView], {
    nowMs: NOW,
    recordStop: () => { /* stop 라인은 잔여 사실 — 여기선 노트만 본다 */ },
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: () => staleView,
    statePath,
  });
  const onDisk = readTaskCard('ta-race-progress', statePath);
  expect((onDisk?.history ?? []).some((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toBe(false);
  expect(outcomes).toEqual([]);
});

test('재독 통과 뒤 다른 회수자가 먼저 skip-note 를 붙이면 — 두 번째는 중복 노트를 만들지 않는다 (JUD-B #118991)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-race-dup-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const statePath = join(root, 'task-agent-actions.json');
  // 디스크 정본 — 같은 runId A 회수를 다른 회수자가 먼저 마쳤다(skip-note runId 결속).
  writeTaskCards(statePath, [card({
    id: 'ta-race-dup', runId: 'run-A', checklistId: 'CELL-RACE',
    history: hist([
      { at: AT(20 * 60_000), event: 'live-move', detail: 'x' },
      { at: AT(19 * 60_000), event: TA_SKIP_NOTE_EVENT, detail: 'failed/recycled/environment: …', runId: 'run-A' },
    ]),
  })]);
  const staleView = card({
    id: 'ta-race-dup', runId: 'run-A', checklistId: 'CELL-RACE',
    history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]),
  });
  const outcomes = recycleStalledLaunches([staleView], {
    nowMs: NOW,
    recordStop: () => { /* 중복 stop 라인 잔여 — 노트가 멱등 관문 */ },
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: () => staleView,
    statePath,
  });
  const onDisk = readTaskCard('ta-race-dup', statePath);
  // skip-note 는 한 번만 — 추가는 잠금 아래 «이미 노트 있음» 확인을 통과해야 한다.
  expect((onDisk?.history ?? []).filter((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toHaveLength(1);
  expect(outcomes).toEqual([]);
});
// ── stop 기록의 교차 구간(실행 재현) — 실패 먼저: stop 이 잠금 밖에서 먼저 기록되던 판에는 이 아래 셋이 빨강이다(JUD-B #119045 — 옛 run stop 잔여 허용 철회). ──

test('재검증 통과 뒤 진척이 잠금 앞에 끼면 — 살아 있는 런의 런 원장에 stop 줄이 실제로 남지 않는다 (JUD-B #119045)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-stoplive-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const statePath = join(root, 'task-agent-actions.json');
  mkdirSync(join(root, 'run-ledger'), { recursive: true });
  // 디스크 정본 — 같은 runId 지만 관측이 2분 전에 갱신됐다(런은 살아 있다 · 회수 자격 상실).
  writeTaskCards(statePath, [card({
    id: 'ta-stoplive', runId: 'run-live', checklistId: 'CELL-STOPLIVE',
    history: hist([
      { at: AT(20 * 60_000), event: 'live-move', detail: 'x' },
      { at: AT(2 * 60_000), event: 'live-move', detail: '진척 관측' },
    ]),
  })]);
  // 스냅숏·잠금 밖 재검증은 옛 모습(20분 무진척) — 진척이 그 뒤에 끼었다(교차 구간 실행 재현).
  const staleView = card({
    id: 'ta-stoplive', runId: 'run-live', checklistId: 'CELL-STOPLIVE',
    history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]),
  });
  // recordStop 은 주입하지 않는다 — 기본 경로가 런 원장에 실제로 기록한다(stop 실행 경계).
  const outcomes = recycleStalledLaunches([staleView], {
    nowMs: NOW,
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: () => staleView,
    statePath,
  });
  expect(outcomes).toEqual([]);
  const onDisk = readTaskCard('ta-stoplive', statePath);
  expect((onDisk?.history ?? []).some((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toBe(false);
  // 살아 있는 런(run-live)의 원장에 stop 줄이 0개 — 잠금 밖에서 stop 을 먼저 기록하던 판에는 1개가 남아 빨강이다.
  expect(readLedgerStopLines(join(root, 'run-ledger', 'run-live.jsonl'))).toEqual([]);
});

test('같은 스냅숏으로 동시 스윕 두 번 — 런 원장 stop 줄은 정확히 1개, 카드 skip-note 도 1개 (JUD-B #119045)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-stopdup-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const statePath = join(root, 'task-agent-actions.json');
  mkdirSync(join(root, 'run-ledger'), { recursive: true });
  const staleView = card({
    id: 'ta-stopdup', runId: 'run-dup', checklistId: 'CELL-STOPDUP',
    history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]),
  });
  writeTaskCards(statePath, [staleView]);
  const deps = {
    nowMs: NOW,
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: () => staleView, // 두 스윕 모두 잠금 밖 재검증을 같은 옛 모습으로 통과시킨다(동시성 재현).
    statePath,
  };
  const first = recycleStalledLaunches([staleView], deps);
  const second = recycleStalledLaunches([staleView], deps);
  expect(first).toHaveLength(1);
  // 두 번째는 잠금 아래 «이미 노트 있음»에 밀린다 — stop 줄도 반복하지 않는다.
  expect(second).toEqual([]);
  const onDisk = readTaskCard('ta-stopdup', statePath);
  expect((onDisk?.history ?? []).filter((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toHaveLength(1);
  // 잠금 밖에서 각각 stop 을 먼저 기록하던 판에는 2개 — 정확히 1개여야 한다(중복 stop 금지).
  expect(readLedgerStopLines(join(root, 'run-ledger', 'run-dup.jsonl'))).toHaveLength(1);
});

test('재검증 통과 뒤 재발사(새 runId)가 잠금 앞에 끼면 — 옛 run-A 의 stop 줄을 런 원장에 남기지 않는다 (JUD-B #119045)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-stopold-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const statePath = join(root, 'task-agent-actions.json');
  mkdirSync(join(root, 'run-ledger'), { recursive: true });
  // 디스크 정본 — 이미 재발사됐다(새 runId B · 3분 전 관측). 옛 run-A 는 버려진 런이다.
  writeTaskCards(statePath, [card({
    id: 'ta-stopold', runId: 'run-B', checklistId: 'CELL-STOPOLD',
    history: hist([{ at: AT(3 * 60_000), event: 'live-move', detail: '재발사 관측' }]),
  })]);
  // 스냅숏·잠금 밖 재검증은 옛 run-A 무진척 20분 — 재발사가 그 뒤에 끼었다(교차 구간 실행 재현).
  const staleView = card({
    id: 'ta-stopold', runId: 'run-A', checklistId: 'CELL-STOPOLD',
    history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]),
  });
  const outcomes = recycleStalledLaunches([staleView], {
    nowMs: NOW,
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: () => staleView,
    statePath,
  }); // recordStop 기본 — 런 원장 실제 기록 경로.
  expect(outcomes).toEqual([]);
  const onDisk = readTaskCard('ta-stopold', statePath);
  expect((onDisk?.history ?? []).some((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toBe(false);
  // 옛 run-A 는 물론 새 run-B 의 원장에도 stop 줄이 없다 — 회수는 일어나지 않았다.
  expect(readLedgerStopLines(join(root, 'run-ledger', 'run-A.jsonl'))).toEqual([]);
  expect(readLedgerStopLines(join(root, 'run-ledger', 'run-B.jsonl'))).toEqual([]);
});

test('잠금 안에서 stop 기록이 실패하면 — 실패 마커만 디스크에, 원장 stop 줄은 0개, 15분 뒤 재시도 (JUD-B HOLD 8a9c06 · #119045)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-stopfail-disk-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const statePath = join(root, 'task-agent-actions.json');
  mkdirSync(join(root, 'run-ledger'), { recursive: true });
  const staleView = card({
    id: 'ta-stopfail-disk', runId: 'run-sf', checklistId: 'CELL-STOPFAIL',
    history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]),
  });
  writeTaskCards(statePath, [staleView]);
  const outcomes = recycleStalledLaunches([staleView], {
    nowMs: NOW,
    recordStop: () => false, // 런 원장 기록 실패 — 영구 skip-note 금지 · 재시도 대상 유지.
    reasonCodeFor: () => 'provider-credential-failure',
    readCard: () => staleView,
    statePath,
  });
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]!.stopRecorded).toBe(false);
  const onDisk = readTaskCard('ta-stopfail-disk', statePath);
  expect((onDisk?.history.at(-1) as { event?: string } | undefined)?.event).toBe('ta-stop-record-failed');
  // 원장에는 stop 줄이 없다 — 마커의 at 가 관측 시각을 갱신해 15분 재시도 창을 연다.
  expect(readLedgerStopLines(join(root, 'run-ledger', 'run-sf.jsonl'))).toEqual([]);
  expect(findStalledLaunches([readTaskCard('ta-stopfail-disk', statePath)!], NOW + 14 * 60_000)).toEqual([]);
  expect(findStalledLaunches([readTaskCard('ta-stopfail-disk', statePath)!], NOW + 15 * 60_000).map((c) => c.id)).toEqual(['ta-stopfail-disk']);
});

// ── RUN-STOP-ONE-LINE 재시도 통합 — 실패 먼저: 수리 전엔 이 아래 시험이 빨강이다(JUD-B #119237/#119258 · PR #39400). ──

test('recycleStalledLaunches — 죽은 프로세스의 stop 줄 뒤 별도 프로세스 재시도(정본 원장 경로)는 두 번째 stop 을 적립하지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-loop-stop-dedup-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root; // 런 원장도 같은 격리 뿌리(기록기 = 정본 recordRunStop)
  try {
    const runId = 'run-1a2b3c4d-5e6f-4789-8a0b-6c7d8e9f0a1b';
    const statePath = join(root, 'task-agent-actions.json');
    const staleAt = new Date(NOW - 31 * 60_000).toISOString();
    writeTaskCards(statePath, [card({
      id: 'ta-stop-dedup', runId, checklistId: 'CELL-RE',
      createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]),
    })]);
    // 죽은 프로세스가 남긴 stop 한 줄(카드 쓰기 전 사망 — 카드는 회수 표시 전 상태).
    const ledgerPath = join(root, 'run-ledger', `${runId}.jsonl`);
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    writeFileSync(ledgerPath, `${JSON.stringify({
      timestamp: '2026-11-21T04:43:44.698Z', runId, event: 'stop',
      data: {
        class: 'unclassified',
        cause: '15분 무진척 회수 — 정확 runId stop(unclassified)',
        evidenceRef: `run-ledger:${runId}:stop`,
        nextMove: '칸 skip-note 확인 — 사람/판정부가 재발사 여부를 판단',
      },
    })}\n`);
    // 별도 프로세스 재시도 — recordStop 주입 없이 정본 경로: 잠금 안 재검증 → recordRunStop → 런 원장.
    const outcomes = recycleStalledLaunches([readTaskCard('ta-stop-dedup', statePath)!], { nowMs: NOW, statePath });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.stopRecorded).toBe(true); // 기각 아님 — 기존 줄 반환, 15분 churn 없음
    expect(readLedgerStopLines(ledgerPath)).toHaveLength(1); // 수리 전: 재적립 → 2줄 — 빨강
    const last = readTaskCard('ta-stop-dedup', statePath)?.history.at(-1) as { event?: string; detail?: string } | undefined;
    expect(last?.event).toBe(TA_SKIP_NOTE_EVENT);
    expect(String(last?.detail)).toContain('failed/recycled/');
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
});

// ═══ FU-39400-CARD-WRITE-FAIL — 카드 쓰기 실패(EACCES) ⊕ 프로세스 사망 종단 → 재시작 1회 원장·카드 정합 ═══
// 출처: OP #119367(EACCES 시 카드 미갱신 = FU-39400-CARD-WRITE-FAIL 로 분리 — #39400 에서 고치지 않음) ·
// 승계 #124063(완료 경계: «격리 장애 주입 2종 뒤 재시작 1회 카드 정합 시험») · OP 승인 #124064 ·
// 재현 원문 15286b6d(빨강 B: chmod 444 → EACCES 가 recycleStalledLaunches 밖으로 전파 — launch-result-loop.ts:225
// updateTaskCard 호출부 무방어 / 빨강 A: «원장 stop append 뒤·카드 writeFileSync 앞» 사망 → .lock 잔존 →
// 즉시 재시도가 잠금 6초 타임아웃 throw 로 전파). #39483 MERGED 로 ta-sweep-tick.ts 충돌은 해소 —
// 수정 범위는 launch-result-loop.ts 로 최소화(조사 §56-60).

/** FU-39400 — outcome 의 cardWriteFailed 관측치(수리 전 타입에도 컴파일되는 관측 접근 — 원장은 diff 로 증명). */
const cardWriteFailedOf = (outcome: TaRecycleOutcome): boolean =>
  Boolean((outcome as unknown as Record<string, unknown>)['cardWriteFailed']);

/** FU-39400 r2(terra mustFix 2) — outcome 의 cardWriteUnknown 관측치(재독 실패 = 부착 여부 미확인 · 관측 접근). */
const cardWriteUnknownOf = (outcome: TaRecycleOutcome): boolean =>
  Boolean((outcome as unknown as Record<string, unknown>)['cardWriteUnknown']);

/** FU-39400 사망 모의 드라이버 — 15286b6d 스크래치 재현: 원장 stop append 뒤·카드 writeFileSync 앞 exit(70). */
const FU39400_DEATH_DRIVER = `
const SRC = process.env.DRIVER_SRC!;
const STATE = process.env.DRIVER_STATE!;
const NOW = Number(process.env.DRIVER_NOW);
const CARD_ID = process.env.DRIVER_CARD_ID!;
const loop = await import(SRC + '/task-agent/launch-result-loop.ts');
const runStop = await import(SRC + '/self-implement/run-stop.ts');
const cards = await import(SRC + '/task-agent/task-card-state.ts');
const card = cards.readTaskCard(CARD_ID, STATE);
if (!card) { console.error('DRIVER: CARD-NOT-FOUND'); process.exit(2); }
try {
  loop.recycleStalledLaunches([card], {
    nowMs: NOW,
    statePath: STATE,
    recordStop: (input) => {
      runStop.recordRunStop(input); // 원장 stop append — 실물 런 원장(ELANOUS_STATE_DIR=시험 격리 뿌리).
      console.error('DRIVER: process death AFTER ledger stop append, BEFORE card writeFileSync');
      process.exit(70); // 카드 writeFileSync «앞» 사망 — exit 은 finally 를 건너뛰므로 .lock 이 쥔 채 남는다.
    },
  });
  console.error('DRIVER: UNEXPECTED-SURVIVAL');
  process.exit(3);
} catch (error) {
  console.error('DRIVER: THROWN ' + String(error));
  process.exit(4);
}
`;

test('FU-39400 빨강 B — 카드 원장 쓰기 EACCES: throw 전파 대신 관측 가능한 cardWriteFailed outcome·부분 실패 격리', () => {
  const root = mkdtempSync(join(tmpdir(), 'fu39400-eacces-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root; // 런 원장도 같은 격리 뿌리(기록기 = 정본 recordRunStop — 15286b6d 빨강 B 재현)
  try {
    // EACCES 주입이 이 호스트에서 실제로 발동하는가(root 는 mode 비트를 우회한다) — 미발동 환경은 정직하게 실패.
    const probePath = join(root, 'eacces-probe.json');
    writeFileSync(probePath, '{}');
    chmodSync(probePath, 0o444);
    let probeCode: string | null = null;
    try { writeFileSync(probePath, '{"x":1}'); } catch (error) { probeCode = (error as NodeJS.ErrnoException).code ?? null; }
    if (probeCode !== 'EACCES') throw new Error(`FU-39400: EACCES 주입 미발동 환경(root 등) — probe code=${probeCode ?? 'none'}`);

    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const statePath = join(root, 'task-agent-actions.json');
    const runA = 'run-fu39400-ea01';
    const runB = 'run-fu39400-eb02';
    // 출처: 15286b6d 시드 30분 — NO_PROGRESS_MS(15분) 상한 위 회수 자격(기존 시험 «stale» 패턴).
    const staleAt = new Date(NOW - 30 * 60_000).toISOString();
    const a = card({ id: 'fu39400-eacces-a', runId: runA, checklistId: 'FU-39400-CARD-WRITE-FAIL', createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]) });
    const b = card({ id: 'fu39400-eacces-b', runId: runB, checklistId: 'FU-39400-CARD-WRITE-FAIL', createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]) });
    writeTaskCards(statePath, [a, b]);
    chmodSync(statePath, 0o444); // 출처: 15286b6d 빨강 B 재현 원문 — chmod 444 → 카드 writeFileSync EACCES
    let thrown: unknown = null;
    let outcomes: TaRecycleOutcome[] = [];
    try { outcomes = recycleStalledLaunches([a, b], { nowMs: NOW, statePath }); } catch (error) { thrown = error; }
    // 수리 전 빨강: EACCES 가 recycleStalledLaunches 밖으로 전파(launch-result-loop.ts:225 무방어).
    expect(thrown).toBe(null);
    // 부분 실패 격리 — 첫 카드 쓰기 실패가 같은 호출의 둘째 카드 회수를 태우지 않는다(2카드 주입).
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.cardId)).toEqual(['fu39400-eacces-a', 'fu39400-eacces-b']);
    expect(outcomes.every((o) => o.stopRecorded)).toBe(true); // 원장 stop 은 콜백 안에서 «이미» 기록됐다 — 관측 가능한 실패 상태
    expect(outcomes.every((o) => cardWriteFailedOf(o))).toBe(true); // 카드 skip-note 만 빠진 재조정 대상 표지(FU-39400)
    // 출처: 완료선 «원장 stop 1줄»(#124063) — 장애 주입에도 runId 별 stop 원장은 남는다.
    expect(readLedgerStopLines(join(root, 'run-ledger', `${runA}.jsonl`))).toHaveLength(1);
    expect(readLedgerStopLines(join(root, 'run-ledger', `${runB}.jsonl`))).toHaveLength(1);
    // 카드: skip-note 미부착 — hasSkipNote 미발동으로 재시도 대상 유지(다음 스윕이 원장→카드 정합).
    for (const id of ['fu39400-eacces-a', 'fu39400-eacces-b']) {
      const onDisk = readTaskCard(id, statePath);
      const notes = (onDisk?.history ?? []) as Array<{ event?: string }>;
      expect(notes.some((e) => e.event === TA_SKIP_NOTE_EVENT)).toBe(false);
    }
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
});

test('FU-39400 빨강 A — 프로세스 사망(원장 stop 뒤·카드 쓰기 앞) → 재시작 1회 원장 stop 1줄·카드 skip-note 정합', () => {
  const root = mkdtempSync(join(tmpdir(), 'fu39400-death-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const runId = 'run-fu39400-dd01';
    const cardId = 'fu39400-death';
    const statePath = join(root, 'task-agent-actions.json');
    const lockPath = `${statePath}.lock`;
    const ledgerPath = join(root, 'run-ledger', `${runId}.jsonl`);
    // 출처: 15286b6d 시드 30분 — 회수 자격.
    const staleAt = new Date(NOW - 30 * 60_000).toISOString();
    writeTaskCards(statePath, [card({ id: cardId, runId, checklistId: 'FU-39400-CARD-WRITE-FAIL', createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]) })]);
    // ① 사망 주입 — 드라이버 서브프로세스: recordStop 이 실물 원장에 stop 을 적립한 뒤 exit(70)(출처: 15286b6d 빨강 A — exit code 70).
    const driverPath = join(root, 'fu39400-death-driver.ts');
    writeFileSync(driverPath, FU39400_DEATH_DRIVER);
    const death = spawnSync(process.execPath, [driverPath], {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, DRIVER_SRC: resolve(import.meta.dir, '..'), DRIVER_STATE: statePath, DRIVER_NOW: String(NOW), DRIVER_CARD_ID: cardId, ELANOUS_STATE_DIR: root },
    });
    expect(death.status).toBe(70); // 사망 시점 계약: 원장 stop append 뒤·카드 writeFileSync 앞
    expect(String(death.stderr)).toContain('process death AFTER ledger stop append');
    // 출처: 완료선 «원장 stop 1줄»(#124063) — 사망 직후 관측: 원장에만 stop 이 남는다.
    expect(readLedgerStopLines(ledgerPath)).toHaveLength(1);
    const afterDeathNotes = (readTaskCard(cardId, statePath)?.history ?? []) as Array<{ event?: string }>;
    expect(afterDeathNotes.some((e) => e.event === TA_SKIP_NOTE_EVENT)).toBe(false); // 카드 skip-note 0 — «원장만 stop» 상태
    expect(existsSync(lockPath)).toBe(true); // 사망 보유자의 .lock 잔존(exit 은 finally 를 건너뛴다)
    // ② 재시작 직후(잠금 미경과 창) 디스크 관측 — 회수 호출 없이: 원장만 stop·카드 skip-note 0·.lock 잔존.
    // (출처: 15286b6d 부수 — 사망 보유자의 .lock 이 stale 창(file-lock.ts STALE_MS=30_000)까지 다음 회수를 지연시킨다.
    //  현재 main 의 재시도 루프(240×25ms)는 타이밍에 따라 stale 창을 넘기며 자가정합하거나 6초 타임아웃 throw —
    //  어느 쪽이든 «정합은 다음 스윕이 완료» 가 계약이므로, 여기서는 디스크 상태만 관측하고 정합은 ③이 증명한다.)
    const immediateNotes = (readTaskCard(cardId, statePath)?.history ?? []) as Array<{ event?: string }>;
    expect(immediateNotes.some((e) => e.event === TA_SKIP_NOTE_EVENT)).toBe(false); // 아직 카드 회수 표시 없음
    expect(existsSync(lockPath)).toBe(true); // 사망 보유자의 .lock 잔존(exit 은 finally 를 건너뛴다)
    // ③ stale 창 경과 뒤 재시작 1회 — 원장→카드 정합(완료선 #124063 «재시작 1회 카드 정합» 증명 · 조사 §40 «시험 0개» 몫).
    // 출처: src/storage/file-lock.ts STALE_MS=30_000 — mtime 기준 stale 판정 경과 모의.
    const staleAgo = new Date(Date.now() - 31_000);
    utimesSync(lockPath, staleAgo, staleAgo);
    const reconciled = recycleStalledLaunches([readTaskCard(cardId, statePath)!], { nowMs: NOW, statePath });
    expect(reconciled).toHaveLength(1); // 출처: 완료선 «재시작 1회 카드 정합»(#124063).
    expect(reconciled[0]!.stopRecorded).toBe(true); // 기각 아님 — appendRunStopEntryOnce 기존 줄 반환(#39400)
    expect(cardWriteFailedOf(reconciled[0]!)).toBe(false); // 정상 회수 — cardWriteFailed 아님
    let thrownRestart: unknown = null;
    try { recycleStalledLaunches([readTaskCard(cardId, statePath)!], { nowMs: NOW, statePath }); } catch (error) { thrownRestart = error; }
    expect(thrownRestart).toBe(null); // 정합 뒤 재스윕은 멱등 — throw 없이 조용히 건너뛴다
    // 핵심 정합: 원장 stop 여전히 1줄(중복 없음 — #39400 appendRunStopEntryOnce).
    expect(readLedgerStopLines(ledgerPath)).toHaveLength(1);
    const notes = (readTaskCard(cardId, statePath)?.history ?? []) as Array<{ event?: string; detail?: string; runId?: string }>;
    const skip = notes.find((e) => e.event === TA_SKIP_NOTE_EVENT);
    expect(skip?.runId).toBe(runId); // 카드 recycled skip-note 1줄 — 원장 stop 과 runId 일치(정합)
    expect(String(skip?.detail)).toContain('failed/recycled/');
    expect(existsSync(lockPath)).toBe(false); // 정합 완료 — 잠금 해제
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
  // 출처: 드라이버 서브프로세스 구동 — 5초 기본 상향.
}, 20000);

// ── FU-39400 r2 — terra mustFix 3건(RED 우선): ①catch 재독 runId 귀속 ②재독 실패 미확인 ③권한 복구 후 회수 재실행 ──

/** terra mustFix 1·3 공용 — EACCES 주입이 이 호스트에서 실제로 발동하는가(root 는 mode 비트를 우회한다). 미발동 환경은 정직하게 실패. */
function requireEaccesProbe(root: string): void {
  const probePath = join(root, 'eacces-probe.json');
  writeFileSync(probePath, '{}');
  chmodSync(probePath, 0o444);
  let probeCode: string | null = null;
  try { writeFileSync(probePath, '{"x":1}'); } catch (error) { probeCode = (error as NodeJS.ErrnoException).code ?? null; }
  if (probeCode !== 'EACCES') throw new Error(`FU-39400 r2: EACCES 주입 미발동 환경(root 등) — probe code=${probeCode ?? 'none'}`);
}

test('FU-39400 r2 terra mustFix 1 — 쓰기 실패 catch 재독 카드의 runId 불일치: 다른 런의 skip-note를 이전 런의 정상 회수로 보고하지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'fu39400-mf1-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    requireEaccesProbe(root);
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const statePath = join(root, 'task-agent-actions.json');
    const runA = 'run-mf1-a';
    const staleAt = new Date(NOW - 30 * 60_000).toISOString(); // 출처: 기존 «stale» 패턴 — NO_PROGRESS_MS 상한 위 회수 자격
    const staleView = card({ id: 'ta-mf1', runId: runA, checklistId: 'FU-39400-R2', createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]) });
    writeTaskCards(statePath, [staleView]);
    // catch 재독이 보게 될 카드 — 관측 사이 재발사(run-B) + 다른 회수자의 run-B skip-note까지 끼어든 원장 모습.
    const relaunchedNoted = card({
      id: 'ta-mf1', runId: 'run-mf1-b', checklistId: 'FU-39400-R2', createdAt: staleAt,
      history: hist([
        { at: staleAt, event: 'live-move', detail: 'x' },
        { at: AT(2 * 60_000), event: TA_SKIP_NOTE_EVENT, detail: 'failed/recycled/environment: 15분 무진척 — 정확 runId run-mf1-b stop · 재발사는 사람/판단부 몫', runId: 'run-mf1-b' },
      ]),
    });
    chmodSync(statePath, 0o444); // 카드 쓰기 EACCES — catch 경로 진입(빨강 B와 동일 주입)
    let readCalls = 0;
    const outcomes = recycleStalledLaunches([staleView], {
      nowMs: NOW,
      statePath,
      recordStop: () => { /* 원장 stop 성공 — stopRecorded=true */ },
      reasonCodeFor: () => 'provider-credential-failure',
      readCard: () => {
        readCalls += 1;
        return readCalls === 1 ? staleView : relaunchedNoted; // 사전 재검증=옛 모습(run-A) · catch 재독=재발사+회수 노트 카드(run-B)
      },
    });
    expect(readCalls).toBe(2); // 출처: terra mustFix 1 — 사전 재검증 1 + catch 재독 1
    expect(outcomes).toHaveLength(1); // 출처: terra mustFix 1 — 유일한 outcome은 이전 런(run-A)의 cardWriteFailed(정상 회수 아님)
    expect(outcomes[0]!.runId).toBe(runA);
    expect(cardWriteFailedOf(outcomes[0]!)).toBe(true); // 다른 런(run-B)의 skip-note는 run-A 회수의 증거가 아니다
    expect(cardWriteUnknownOf(outcomes[0]!)).toBe(false); // 재독 자체는 성공(카드를 봤다) — 미확인 아님
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
});

test('FU-39400 r2 terra mustFix 2 — 쓰기 실패 뒤 카드 재독이 실패하면: 미부착 단정 금지, cardWriteUnknown 미확인 보존', () => {
  const root = mkdtempSync(join(tmpdir(), 'fu39400-mf2-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    requireEaccesProbe(root);
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const statePath = join(root, 'task-agent-actions.json');
    const runId = 'run-mf2-a';
    const staleAt = new Date(NOW - 30 * 60_000).toISOString(); // 출처: 기존 «stale» 패턴 — 회수 자격
    const staleView = card({ id: 'ta-mf2', runId, checklistId: 'FU-39400-R2', createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]) });
    writeTaskCards(statePath, [staleView]);
    chmodSync(statePath, 0o444); // 카드 쓰기 EACCES
    let readCalls = 0;
    const outcomes = recycleStalledLaunches([staleView], {
      nowMs: NOW,
      statePath,
      recordStop: () => { /* 원장 stop 성공 */ },
      reasonCodeFor: () => 'provider-credential-failure',
      readCard: () => {
        readCalls += 1;
        if (readCalls === 1) return staleView; // 사전 재검증 통과
        throw new Error('Unexpected end of JSON input — 재독 실패(파서·파일 오류 재현)'); // catch 재독 실패 — 부착 여부 불명
      },
    });
    expect(readCalls).toBe(2); // 출처: terra mustFix 2 — 사전 재검증 1 + 실패한 catch 재독 1
    expect(outcomes).toHaveLength(1); // 출처: terra mustFix 2 — 재독 실패 outcome 은 폐기되지 않고 미확인 상태로 보존
    expect(outcomes[0]!.stopRecorded).toBe(true); // 원장 stop은 잠금 안에서 이미 기록됐다
    expect(cardWriteUnknownOf(outcomes[0]!)).toBe(true); // 재독 실패 = 부착 여부 «미확인» 상태 보존
    expect(cardWriteFailedOf(outcomes[0]!)).toBe(false); // cardWriteFailed(미부착 «관측»)과 구별 — 단정 금지
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
});

test('FU-39400 r2 terra mustFix 3 — 권한 복구(chmod 644) 후 회수 재실행: runId별 stop 1줄 유지 + 해당 runId skip-note 부착', () => {
  const root = mkdtempSync(join(tmpdir(), 'fu39400-mf3-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root; // 정본 recordRunStop — 실제 회수 경로(원장 실기록)
  try {
    requireEaccesProbe(root);
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const statePath = join(root, 'task-agent-actions.json');
    const runA = 'run-mf3-a';
    const runB = 'run-mf3-b';
    const staleAt = new Date(NOW - 30 * 60_000).toISOString(); // 출처: 기존 «stale» 패턴 — 회수 자격
    const a = card({ id: 'fu39400-mf3-a', runId: runA, checklistId: 'FU-39400-R2', createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]) });
    const b = card({ id: 'fu39400-mf3-b', runId: runB, checklistId: 'FU-39400-R2', createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]) });
    writeTaskCards(statePath, [a, b]);
    // ① EACCES 구간 — 기존 시험(빨강 B)이 확인하는 건 쓰기 실패 직후까니다(terra mustFix 3 지적).
    chmodSync(statePath, 0o444);
    const first = recycleStalledLaunches([a, b], { nowMs: NOW, statePath });
    expect(first).toHaveLength(2); // 출처: terra mustFix 3 전제(빨강 B 증명 상태) — EACCES 구간 2건 cardWriteFailed
    expect(first.every((o) => cardWriteFailedOf(o))).toBe(true);
    expect(readLedgerStopLines(join(root, 'run-ledger', `${runA}.jsonl`))).toHaveLength(1); // 출처: 잠금 안 기록 — 쓰기 실패 전 원장 stop
    expect(readLedgerStopLines(join(root, 'run-ledger', `${runB}.jsonl`))).toHaveLength(1);
    // ② 권한 복구 — 실제 회수 경로를 한 번 더 실행한다(기존 시험이 안 본 구간).
    chmodSync(statePath, 0o644);
    const second = recycleStalledLaunches([readTaskCard('fu39400-mf3-a', statePath)!, readTaskCard('fu39400-mf3-b', statePath)!], { nowMs: NOW, statePath });
    expect(second).toHaveLength(2); // 출처: terra mustFix 3 — 복구 후 두 카드 모두 정상 회수 관측
    expect(second.every((o) => !cardWriteFailedOf(o) && !cardWriteUnknownOf(o))).toBe(true); // 정상 회수(재조정·미확인 아님)
    expect(second.map((o) => o.runId)).toEqual([runA, runB]);
    // 각 runId의 stop이 한 줄로 유지된다 — 재실행이 둘째 줄을 적립하지 않는다(appendRunStopEntryOnce 멱급).
    expect(readLedgerStopLines(join(root, 'run-ledger', `${runA}.jsonl`))).toHaveLength(1); // 출처: terra mustFix 3 — 재실행 후에도 stop 1줄
    expect(readLedgerStopLines(join(root, 'run-ledger', `${runB}.jsonl`))).toHaveLength(1); // 출처: terra mustFix 3 — 재실행 후에도 stop 1줄
    // 카드에 해당 runId의 skip-note가 붙는다(runId 결속 · 1개씩).
    for (const [id, runId] of [['fu39400-mf3-a', runA], ['fu39400-mf3-b', runB]] as const) {
      const notes = (readTaskCard(id, statePath)?.history ?? []) as Array<{ event?: string; runId?: string }>;
      const skips = notes.filter((entry) => entry.event === TA_SKIP_NOTE_EVENT);
      expect(skips).toHaveLength(1); // 출처: terra mustFix 3 — 해당 runId skip-note 부착 1개
      expect(skips[0]!.runId).toBe(runId); // 노트는 회수된 runId에 결속
    }
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
});

// ── FU-39400 r3 — terra r2 mustFix 1: 카드 쓰기·재독 모두 실패한 분기에서 cardWriteFailedOutcome 이
// 실제 stopRecorded 값을 보존한다(원장 stop 기록까지 실패한 경우 «성공»으로 허위 보고 금지) ──

test('FU-39400 r3 terra r2 mustFix 1 — 원장 stop 기록까지 실패한 뒤 카드 쓰기·재독도 실패: 실제 stopRecorded(=false)를 보존한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'fu39400-r3-mf1-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    requireEaccesProbe(root);
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const statePath = join(root, 'task-agent-actions.json');
    const runId = 'run-r3-a';
    const staleAt = new Date(NOW - 30 * 60_000).toISOString(); // 출처: 기존 «stale» 패턴 — 회수 자격
    const staleView = card({ id: 'ta-r3', runId, checklistId: 'FU-39400-R3', createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]) });
    writeTaskCards(statePath, [staleView]);
    chmodSync(statePath, 0o444); // 카드 쓰기 EACCES — catch 경로 진입(빨강 B와 동일 주입)
    let readCalls = 0;
    const outcomes = recycleStalledLaunches([staleView], {
      nowMs: NOW,
      statePath,
      recordStop: () => false, // 출처: terra r2 mustFix 1 «실제 stop 기록도 실패한 경우» — 원장 stop 기록 실패(stopRecorded=false)
      reasonCodeFor: () => 'provider-credential-failure',
      readCard: () => {
        readCalls += 1;
        if (readCalls === 1) return staleView; // 사전 재검증 통과
        throw new Error('Unexpected end of JSON input — 재독 실패(파서·파일 오류 재현)'); // catch 재독 실패
      },
    });
    expect(readCalls).toBe(2); // 출처: 기존 mustFix 2 패턴 — 사전 재검증 1 + 실패한 catch 재독 1
    expect(outcomes).toHaveLength(1); // 재독 실패 outcome 은 폐기되지 않고 보존
    expect(outcomes[0]!.stopRecorded).toBe(false); // 출처: terra r2 mustFix 1 — 실제 원장 stop 실패를 «성공»으로 허위 보고하지 않는다
    expect(cardWriteUnknownOf(outcomes[0]!)).toBe(true); // 재독 실패 = 부착 여부 «미확인» 상태 보존
    expect(cardWriteFailedOf(outcomes[0]!)).toBe(false); // cardWriteFailed(미부착 관측)과 구별 — 단정 금지
    expect(String(outcomes[0]!.skipNote)).toContain('stop-record-failed'); // 출처: 정상 회수와 동일 규약 — stop 실패 노트로 보고(허위 skipNote 금지)
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
});

// ── FU-39400 r5 — JUD-C #129833 mustFix ①②(RED 우선): 카드 쓰기 실패/재독 불명 오표시(두 호출점) ⊕
//    stop 기록 false + 쓰기 실패 + 재독 성공에서 outcome 소멸(잠금 전 오류와 구별) ──
// 출처: JUD-C #129833(head 758150648e9b) — launch-result-loop.ts:235-244,255-278 · ta-sweep-tick.ts:129-136 ·
// tasks-card-show.ts:196-199. 기존 false 시험(r3)은 재독 throw 만 검사 — 재독 «성공» 갈래가 비어 있다.

/** FU-39400 r5(JUD-C #129833) — outcome 의 stopAttempted 관측치(잠금 안 stop 시도 여부 · 관측 접근). */
const stopAttemptedOf = (outcome: TaRecycleOutcome): boolean | undefined =>
  (outcome as unknown as Record<string, unknown>)['stopAttempted'] as boolean | undefined;

test('FU-39400 r5b terra mustFix 4·1 — tasks show: 잠금 획득 실패(결정적 EISDIR·root 무관) 회수는 skip-note=칸 history 로 오표시하지 않고 stop «시도 안 함»을 구분한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fu39400-r5-show-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const statePath = join(root, 'task-agent-actions.json');
    const staleAt = new Date(NOW - 30 * 60_000).toISOString(); // 출처: 기존 «stale» 패턴 — NO_PROGRESS_MS 상한 위 회수 자격
    writeTaskCards(statePath, [card({
      id: 'ta-r5-show', runId: 'run-r5-show', checklistId: 'FU-39400-R5', createdAt: staleAt,
      history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]),
    })]);
    // 출처: terra r5 mustFix 4 — #39574 · chmod 444 EACCES 주입은 root 처럼 mode 비트를 우회하는 환경에서 의도적으로
    // 실패한다. `${statePath}.lock` 경로에 디렉터리를 놓으면 .lock 생성(openSync 'wx') 은 항상 EEXIST 이고
    // stale 회수 unlink(디렉터리) 도 항상 실패해 잠금 획득 실패(타임아웃 throw)가 root 에서도 결정적이다
    // (src/storage/file-lock.ts acquireLockSync · 시뮬 S4 — 15286b6d chmod 555 대체).
    mkdirSync(`${statePath}.lock`);
    const lockStaleAgo = new Date(Date.now() - 31_000); // 출처: src/storage/file-lock.ts STALE_MS=30_000 — stale 판정 경과 모의(빨강 A 시험 부수 패턴)
    utimesSync(`${statePath}.lock`, lockStaleAgo, lockStaleAgo);
    const lines: string[] = [];
    await showTaskCard('ta-r5-show', {}, showDeps(statePath, NOW), (line) => lines.push(line));
    const recycleLines = lines.filter((line) => line.startsWith('TA 회수'));
    expect(recycleLines).toHaveLength(1); // 출처: JUD-C #129833 mustFix 1 — 쓰기 실패 회수 시도는 관측(TA 회수 줄)에서 사라지지 않는다
    const onDisk = readTaskCard('ta-r5-show', statePath);
    // 디스크 정본 — skip-note 는 «붙지 않았다». 표시가 이와 모순되면 오표시다.
    expect((onDisk?.history ?? []).some((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toBe(false);
    expect(recycleLines[0]!).not.toContain('skip-note=칸 history'); // 미부착 오표시 금지(JUD-C #129833 mustFix 1)
    expect(recycleLines[0]!).toContain('미부착'); // 카드 쓰기 실패 — skip-note 미부착(재조정 대상) 표지
    // 출처: terra r5 mustFix 1 — #39574 · stopAttempted=false(잠금 전 오류)는 «실패» 가 아니라 «시도 안 함» 이다(CLI 회귀).
    expect(recycleLines[0]!).toContain('정확 runId stop=시도 안 함');
    expect(recycleLines[0]!).not.toContain('정확 runId stop=실패');
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
}, 20_000); // 잠금 획득 실패 재시도 상한(240회) 여유 — 출처: 빨강 A 드라이버 시험 5초 기본 상향 관례

test('FU-39400 r5b terra mustFix 4 — stop 기록 false + 카드 쓰기 실패(콜백 안 결정적 EISDIR) + 재독 성공: outcome 이 사라지지 않는다(잠금 안 시도 보존)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fu39400-r5-mf2-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const statePath = join(root, 'task-agent-actions.json');
    const runId = 'run-r5-mf2';
    const staleAt = new Date(NOW - 30 * 60_000).toISOString(); // 출처: 기존 «stale» 패턴 — 회수 자격
    const staleView = card({ id: 'ta-r5-mf2', runId, checklistId: 'FU-39400-R5', createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]) });
    writeTaskCards(statePath, [staleView]);
    const stopCalls: string[] = [];
    const outcomes = recycleStalledLaunches([staleView], {
      nowMs: NOW,
      statePath,
      // 출처: terra r5 mustFix 4 — #39574 · chmod 444 는 root 처럼 mode 비트를 우회하는 환경에서 발동하지 않는다.
      // 잠금 안 콜백(updateTaskCard 콜백 = readState 뒤·writeFileSync 앞의 유일한 훅)에서 카드 스토어 «파일 경로»를
      // 디렉터리로 교체하면 다음 writeFileSync 는 EISDIR 로 항상 실패한다 — 실제 진입점(recycleStalledLaunches)을 그대로 호출.
      recordStop: (input) => {
        stopCalls.push(input.runId);
        rmSync(statePath);
        mkdirSync(statePath); // 카드 스토어 파일→디렉터리 — 결정적 쓰기 실패 주입(EISDIR)
        return false; // 출처: JUD-C #129833 mustFix 2 — 원장 stop 기록 실패(false)
      },
      reasonCodeFor: () => 'provider-credential-failure',
      // 재독 «성공» 갈래 보존(빨강 B 관측 계약) — EISDIR 스토어의 실디스크 재독은 반드시 실패하므로, 관측 사이
      // 변화 없는 카드 뷰를 돌려주는 주입 판독기를 쓴다(기존 r2 mustFix 1·2 시험의 readCard 주입 패턴).
      readCard: () => staleView,
    });
    expect(outcomes).toHaveLength(1); // 수리 전 빨강: [] — 회수 시도가 관측에서 소멸(JUD-C #129833 mustFix 2 · 시뮬 S3)
    expect(stopCalls).toHaveLength(1); // 출처: JUD-C #129833 mustFix 2 — 잠금 «안»에서 stop 시도는 실제로 있었다(잠금 전 오류와 구별)
    expect(outcomes[0]!.stopRecorded).toBe(false); // 관측값 보존 — 허위 성공 금지(r3 계약 유지)
    expect(cardWriteFailedOf(outcomes[0]!)).toBe(true); // 카드 skip-note·stop 실패 마커 모두 못 붙였다
    expect(cardWriteUnknownOf(outcomes[0]!)).toBe(false); // 재독은 성공 — 불명 아님
    expect(stopAttemptedOf(outcomes[0]!)).toBe(true); // 잠금 안 stop 시도 관측 — 잠금 전 오류(false)와 구별
    expect(String(outcomes[0]!.skipNote)).toContain('stop-record-failed'); // stop 실패 노트로 보고(허위 skipNote 금지 · r3 계약)
    expect(statSync(statePath).isDirectory()).toBe(true); // 쓰기 실패 주입 원문 — 스토어는 파일이 아니라 디렉터리(writeFileSync EISDIR)
    // 뷰에는 skip-note 도 stop 실패 마커도 없다 — 쓰기 실패로 둘 다 못 붙였다.
    expect((staleView.history ?? []).some((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toBe(false);
    expect((staleView.history ?? []).some((entry) => (entry as { event?: string }).event === TA_STOP_FAILED_EVENT)).toBe(false);
    expect(findStalledLaunches([staleView], NOW + 60 * 60_000).map((c) => c.id)).toEqual(['ta-r5-mf2']); // 재시도 대상 유지 — 마커가 없어 다음 스윕이 다시 잡는다
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
});

test('FU-39400 r5b terra mustFix 4·1 — 잠금 «전» 오류(잠금 획득 실패 · 결정적 EISDIR): stop 시도 없음(stopAttempted=false)·«시도 안 함» 노트를 보존해 구별한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'fu39400-r5-prelock-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const statePath = join(root, 'task-agent-actions.json');
    const runId = 'run-r5-prelock';
    const staleAt = new Date(NOW - 30 * 60_000).toISOString(); // 출처: 기존 «stale» 패턴 — 회수 자격
    const staleView = card({ id: 'ta-r5-prelock', runId, checklistId: 'FU-39400-R5', createdAt: staleAt, history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]) });
    writeTaskCards(statePath, [staleView]);
    // 출처: terra r5 mustFix 4 — #39574 · chmod 555 는 root 에서 우회된다. `${statePath}.lock` 경로에 디렉터리를 놓으면
    // .lock 생성(openSync 'wx') 이 항상 EEXIST 로 실패하고 stale 회수 unlink(디렉터리) 도 항상 실패해
    // 잠금 획득 실패(타임아웃 throw)가 root 에서도 결정적이다 — 콜백 진입 «전» throw(시뮬 S4).
    mkdirSync(`${statePath}.lock`);
    const lockStaleAgo = new Date(Date.now() - 31_000); // 출처: src/storage/file-lock.ts STALE_MS=30_000 — stale 판정 경과 모의(빨강 A 시험 부수 패턴)
    utimesSync(`${statePath}.lock`, lockStaleAgo, lockStaleAgo);
    const stopCalls: string[] = [];
    const outcomes = recycleStalledLaunches([staleView], {
      nowMs: NOW,
      statePath,
      recordStop: (input) => { stopCalls.push(input.runId); }, // 잠금 전 오류라면 불리지 않는다
      reasonCodeFor: () => 'provider-credential-failure',
    });
    expect(stopCalls).toHaveLength(0); // 출처: JUD-C #129833 mustFix 2 — 잠금 전 오류: stop 시도 자체가 없다
    expect(outcomes).toHaveLength(1); // 수리 전 빨강: [] — 이쪽 분기도 소멸(회수 시도 관측 누락)
    expect(outcomes[0]!.stopRecorded).toBe(false); // stop 시도가 없었으니 기록도 없다 — 관측값 그대로
    expect(cardWriteFailedOf(outcomes[0]!)).toBe(true); // 카드 쓰기(잠금 포함) 실패 상태 보존
    expect(stopAttemptedOf(outcomes[0]!)).toBe(false); // 잠금 안 시도 없음 — mustFix ②(stopAttempted=true)와 구별되는 관측치
    // 출처: terra r5 mustFix 1 — #39574 · 시도가 없었으면 «stop 기록 실패» 노트가 아니라 «시도 안 함» 노트로 구별해 남긴다.
    expect(String(outcomes[0]!.skipNote)).toContain('stop-not-attempted');
    expect(String(outcomes[0]!.skipNote)).not.toContain('stop-record-failed');
    const onDisk = readTaskCard('ta-r5-prelock', statePath);
    expect((onDisk?.history ?? []).some((entry) => (entry as { event?: string }).event === TA_SKIP_NOTE_EVENT)).toBe(false); // 카드는 그대로 — 다음 스윕 재시도
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
}, 20_000); // 잠금 획득 실패 재시도 상한(240회) 여유 — 출처: 빨강 A 드라이버 시험 5초 기본 상향 관례

test('FU-39400 r5 — taRecycleOutcomeLine: 네 갈래 표시(정상 skip-note·마커·쓰기 실패 미부착·재독 불명) (JUD-C #129833 mustFix ①)', () => {
  const base = { cardId: 'ta-r5-line', runId: 'run-r5-line', cause: 'grounding' as const, minutesStalled: 30, skipNote: 'failed/recycled/grounding: …' };
  expect(taRecycleOutcomeLine({ ...base, stopRecorded: true }))
    .toBe('TA 회수: runId=run-r5-line · 원인=grounding · 무진척 30분 · 정확 runId stop=기록됨 · skip-note=칸 history');
  expect(taRecycleOutcomeLine({ ...base, stopRecorded: false, skipNote: 'stop-record-failed/grounding: …' }))
    .toBe('TA 회수: runId=run-r5-line · 원인=grounding · 무진척 30분 · 정확 runId stop=실패 — 재시도 대상 유지(stop-record-failed/grounding: …) · 마커=칸 history(회수 아님)');
  const writeFailed = taRecycleOutcomeLine({ ...base, stopRecorded: true, cardWriteFailed: true });
  expect(writeFailed).toContain('skip-note 미부착 — 카드 쓰기 실패'); // 출처: JUD-C #129833 mustFix 1 — stopRecorded=true 여도 미부착 표시
  expect(writeFailed).not.toContain('skip-note=칸 history'); // 오표시 금지 · 출처: JUD-C #129833 mustFix 1
  const unknown = taRecycleOutcomeLine({ ...base, stopRecorded: true, cardWriteFailed: false, cardWriteUnknown: true });
  expect(unknown).toContain('skip-note 부착 불명'); // 출처: JUD-C #129833 mustFix 1 — 재독 불명 표시
  expect(unknown).not.toContain('skip-note=칸 history'); // 오표시 금지 · 출처: JUD-C #129833 mustFix 1
  // 출처: terra r5 mustFix 1 — #39574 · stop 시도가 없었다(stopAttempted=false · 잠금 획득·진입 전 오류)면
  // «실패» 가 아니라 «시도 안 함» 으로 구분한다. undefined(관측 없음 · spy 경로)는 기존 «실패» 표시를 유지한다.
  const notAttempted = taRecycleOutcomeLine({ ...base, stopRecorded: false, stopAttempted: false, skipNote: 'stop-not-attempted/grounding: …' });
  expect(notAttempted).toContain('정확 runId stop=시도 안 함'); // 수리 전 빨강: «실패» — 시도하지 않은 것을 실패라 오표시
  expect(notAttempted).not.toContain('정확 runId stop=실패');
  const attempted = taRecycleOutcomeLine({ ...base, stopRecorded: false, stopAttempted: true, skipNote: 'stop-record-failed/grounding: …' });
  expect(attempted).toContain('정확 runId stop=실패 — 재시도 대상 유지'); // 시도했으나 실패 — 기존 표시 유지
  const unobserved = taRecycleOutcomeLine({ ...base, stopRecorded: false, skipNote: 'stop-record-failed/grounding: …' });
  expect(unobserved).toContain('정확 runId stop=실패 — 재시도 대상 유지'); // 관측 없음(undefined) — 기존 표시 유지
});

// ── FU-39400 r5b — terra r5 mustFix 3: cardWriteFailedOutcome 은 새 export 로 달았지만 외부 소비처가 없다 ──
// (전수 grep — 정의·모듈 내부 사용 2곳·시험 주석만). 불필요한 export 를 제거한다(모듈 내부 사용은 유지).
test('FU-39400 r5b terra mustFix 3 — cardWriteFailedOutcome 불필요 export 제거: 모듈 밖으로 노출되지 않는다(내부 사용 유지)', () => {
  expect((launchResultLoopModule as unknown as Record<string, unknown>)['cardWriteFailedOutcome']).toBeUndefined(); // 수리 전 빨강: export 노출 — 불필요 공개면
});
