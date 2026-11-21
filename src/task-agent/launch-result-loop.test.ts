import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import type { TaskCard } from './task-hand.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { readTaskCard, writeTaskCards } from './task-card-state.js';
import { showTaskCard } from '../cli/tasks-card-show.js';
import type { TasksCliDeps } from '../cli/tasks-cli.js';
import {
  TA_LAUNCH_STAGES,
  TA_SKIP_NOTE_EVENT,
  NO_PROGRESS_MS,
  NO_PROGRESS_CAUSES,
  classifyNoProgressCause,
  findStalledLaunches,
  landing20TaLine,
  launchStageOf,
  recycleStalledLaunches,
  taLaunchLine,
} from './launch-result-loop.js';

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
