/**
 * TA-LAUNCH-RESULT-LOOP(칸 0.3.32 · P1) — 대표 승인 TA 시범의 관측 고리.
 * `2026-11-21-ta-revival-two-moves.md` 수 2:
 *   발사마다 카드 1줄: runId · 칸 · head · 단계(launched→PR→pregate→판정→착지) —
 *   `eln tasks show` 와 LANDING-20 매시 점검 표에 «TA 줄» 추가(착지 N 중 TA M).
 *   «launched ≠ 도는 중» 함정 차단: 15분 무진척이면 자동 회수(정확 runId stop) +
 *   원인 분류(그라운딩·의존·예산·환경) → 칸에 skip-note.
 * 완료 경계: 발사 대비 «결과 관측됨» 100% · 무진척 회수 평균 ≤20분 · 원인 분류 원장.
 * FU(TA-SWEEP-PERIODIC-LOOP): 회수 스윕이 `tasks show` 관측에서만 도돌아간다 — «무진척 회수 ≤20분»
 *   보장은 주기 루프(LANDING-20 매시 점검)와 스윕 연결이 몫(아직 연결 안 됨 — 이 PR 범위 밖).
 *
 * 단계 판정은 카드 원장(task-agent-actions.json)에서 «확인된» 칸만으로 한다:
 *   handed → launched → pr → verdict → landed(+ failed/recycled).
 *   pregate 관측은 영수 원장(RES evidence) 몫이라 카드 원장에는 실리지 않는다 —
 *   카드 기준 줄은 pr 에서 판정(verdict)으로 건너뛴다(⛔ 지어내지 않는다).
 * 회수는 «정확 runId stop» 한 줄(run 원장 event='stop')과 skip-note 한 줄을 카드 파일 잠금
 *   «아래 하나의 임계 구간»으로 남긴다 — 잠금 밖 재검증 뒤 관측 갱신(진척)·재발사(runId 교체)가
 *   끼어도 살아 있는/옛 런에 stop 줄이 새지 않는다(JUD-B #119045):
 *   카드 status 는 기존 전이가 소유한다 — 여기서 바꾸지 않는다(보존).
 * 멱등: 같은 runId 의 skip-note 가 있는 카드는 다시 회수하지 않는다 — skip-note 는 회수된
 *   runId 에 결속되어, 재발사된 새 런을 recycled 로 오표시·회수 제외하지 않는다(JUD-B HOLD 39400-f1e737e33dd6).
 */
import type { TaskCard } from './task-hand.js';
import { readTaskCard, taskAgentStatePath, updateTaskCard } from './task-card-state.js';

/** 카드 원장에서 판정 가능한 단계 — 닫힌 목록(pregate는 영수 원장 몫이라 제외). */
export const TA_LAUNCH_STAGES = ['handed', 'launched', 'pr', 'verdict', 'landed', 'failed', 'recycled'] as const;
export type TaLaunchStage = (typeof TA_LAUNCH_STAGES)[number];

/** 회수 skip-note 원장 이벤트 이름 — detail 은 `failed/recycled/<원인>: …` 로 시작한다. */
export const TA_SKIP_NOTE_EVENT = 'skip-note';
/** 정확 runId stop 기록 실패 마커 — skip-note 와 달리 `hasSkipNote` 에 걸리지 않아 재시도를 막지 않는다(JUD-B HOLD 39400-8a9c06bfb0f4). */
export const TA_STOP_FAILED_EVENT = 'ta-stop-record-failed';
/** 무진척 상한 — 이 시간 이상 관측 간극이면 자동 회수 후보다(경계 포함). */
export const NO_PROGRESS_MS = 15 * 60_000;

/** 무진척 원인 분류 — 닫힌 목록(못 고르면 unclassified, 지어내지 않는다). */
export const NO_PROGRESS_CAUSES = ['grounding', 'dependency', 'budget', 'environment', 'unclassified'] as const;
export type NoProgressCause = (typeof NO_PROGRESS_CAUSES)[number];

/** 런 stop 이유 코드 → 무진척 원인(그라운딩·의존·예산·환경 · 나머지 unclassified). */
const CAUSE_BY_REASON_CODE: Readonly<Record<string, NoProgressCause>> = {
  'tdd-evidence-missing': 'grounding',
  'goal-only-same-cell': 'grounding',
  'merge-held-release-path': 'dependency',
  'out-of-scope-held': 'dependency',
  'decomposition-401-invalid-api-key': 'budget',
  'provider-credential-failure': 'environment',
  'no-review-provider': 'environment',
};

export function classifyNoProgressCause(reasonCode: string): NoProgressCause {
  return CAUSE_BY_REASON_CODE[reasonCode] ?? 'unclassified';
}

/**
 * 런 원장에서 runId 의 원인 코드를 읽는다(읽기 전용) — 회수 원인 분류의 실제 provider.
 * 마지막 `event='stop'` 기록부터 거꾸로: terminalEvidence.reasonCode(정밀 진단) →
 * class(포괄 분류) → 못 읽으면 'unknown'(지어내지 않는다 → unclassified).
 * 호출점(tasks-card-show) 배선 전엔 아무도 이 provider 를 안 불러 항상 unknown→unclassified 였다(JUD-B #118928).
 */
export function runLedgerReasonCodeFor(runId: string): string {
  try {
    // 늦은 결합 — 회수 시점에만 런 원장 판독기를 읽는다(defaultRecordStop 과 같은 방식 · 순환 의존 회피).
    // 정본 경로 = 기록 기본값과 같은 `<stateRoot>/run-ledger/<runId>.jsonl`(runLedgerDir) — 읽기 전용.
    const { loadRunLedger, runLedgerDir } = require('../self-implement/run-ledger.js') as typeof import('../self-implement/run-ledger.js');
    const { readRunStopRecord } = require('../self-implement/run-stop.js') as typeof import('../self-implement/run-stop.js');
    const entries = loadRunLedger(runId, runLedgerDir());
    if (!entries) return 'unknown';
    for (let index = entries.length - 1; index >= 0; index--) {
      const record = readRunStopRecord(entries[index]!);
      if (!record) continue;
      const reasonCode = record.terminalEvidence?.reasonCode;
      if (typeof reasonCode === 'string' && reasonCode && reasonCode !== 'unknown') return reasonCode;
      const runClass = record.class;
      if (typeof runClass === 'string' && runClass && runClass !== 'unclassified') return runClass;
    }
  } catch { /* 읽기 전용 최선 — 못 읽으면 unknown(unclassified 로 정직하게) */ }
  return 'unknown';
}

type CardHistoryEntry = { at?: unknown; event?: unknown; detail?: unknown; runId?: unknown };

function historyEntries(card: TaskCard): CardHistoryEntry[] {
  return (card.history ?? []) as CardHistoryEntry[];
}

/** 같은 runId 결속 — 옛 런의 회수 노트는 현재 런을 recycled 로 오표시하지 않는다(JUD-B HOLD 39400-f1e737e33dd6). */
function hasSkipNote(card: TaskCard): boolean {
  return historyEntries(card).some((entry) =>
    entry?.event === TA_SKIP_NOTE_EVENT && typeof entry.detail === 'string' && entry.detail.startsWith('failed/recycled/')
    && entry.runId === card.runId);
}

/** 마지막 관측 시각 — history 마지막 at, 없으면 createdAt(둘 다 못 읽으면 undefined). */
function lastObservedMs(card: TaskCard): number | undefined {
  const entries = historyEntries(card);
  for (let index = entries.length - 1; index >= 0; index--) {
    const at = entries[index]!.at;
    if (typeof at === 'string') {
      const ms = Date.parse(at);
      if (Number.isFinite(ms)) return ms;
    }
  }
  const created = typeof card.createdAt === 'string' ? Date.parse(card.createdAt) : Number.NaN;
  return Number.isFinite(created) ? created : undefined;
}

function cardHead(card: TaskCard): string {
  const head = card.prTerminal?.head ?? card.adoptedPr?.head;
  return typeof head === 'string' && head ? head.slice(0, 12) : '-';
}

/** 카드 원장에서 단계를 판정한다 — 원장에 없는 사실은 지어내지 않는다. */
export function launchStageOf(card: TaskCard): TaLaunchStage {
  if (card.status === 'landed' || card.status === 'landed-by-hand' || card.status === 'done') return 'landed';
  // 회수는 status 를 바꾸지 않는다(보존) — skip-note 가 붙은 발사는 status 와 무관하게 «회수됨».
  if (hasSkipNote(card)) return 'recycled';
  if (card.status === 'failed' || card.status === 'launch-failed') return 'failed';
  if (card.status === 'launched') {
    if (card.prTerminal) return 'verdict';
    if (card.pr !== undefined) return 'pr';
    return 'launched';
  }
  return 'handed';
}

/** 발사 한 줄 — `TA-LAUNCH runId=… · 칸=… · head=… · 단계=…`(없는 칸은 «-» 미기록). */
export function taLaunchLine(card: TaskCard): string {
  return `TA-LAUNCH runId=${card.runId ?? '-'} · 칸=${card.checklistId ?? '-'} · head=${cardHead(card)} · 단계=${launchStageOf(card)}`;
}

/** 15분(상한 포함) 무진척 발사만 — 회수됨·runId 없음·다른 상태는 제외한다. */
export function findStalledLaunches(cards: readonly TaskCard[], nowMs: number): readonly TaskCard[] {
  return cards.filter((card) => {
    if (card.status !== 'launched' || !card.runId || hasSkipNote(card)) return false;
    const last = lastObservedMs(card);
    if (last === undefined) return false;
    return nowMs - last >= NO_PROGRESS_MS;
  });
}

export interface TaRecycleDeps {
  /** 관측 시각(시험 주입 · 기본 = 지금). */
  nowMs?: number;
  /** 정확 runId stop 한 줄 기록기(시험 주입 · 기본 = 런 원장 recordRunStop). false 를 돌려주면 기록 실패다. 원장(디스크) 경로에서는 잠금 아래 재검증을 «통과해야만» 불린다. */
  recordStop?: (input: { runId: string; cause: string; evidenceRef: string; nextMove: string; site?: string }) => boolean | void;
  /** 순수 spy 시험 전용(디스크 없는 단위 시험) — 주입하면 카드 파일 잠금의 임계 구간을 우회해 옛 순서(stop → spy 노트)로 기록한다. 원장(디스크) 경로 시험에는 주입하지 않는다. */
  appendHistory?: (cardId: string, event: string, detail: string, atMs: number, runId?: string) => boolean | void;
  /** 잠금 «밖» 사전 재독기(시험 주입 · 기본 = task-card-state readTaskCard) — 빠른 건너뛰기용. undefined·runId 불일치·자격 상실이면 건너뛴다(잠금 안 재검증은 원장 경로가 스스로 한다). */
  readCard?: (cardId: string) => TaskCard | undefined;
  /** runId → 런 stop 이유 코드(기본 = unknown → unclassified). */
  reasonCodeFor?: (runId: string) => string;
  /** 카드 원장 경로(기본 = 이 우주 task-agent-actions.json). */
  statePath?: string;
}

export interface TaRecycleOutcome {
  cardId: string;
  runId: string;
  cause: NoProgressCause;
  minutesStalled: number;
  stopRecorded: boolean;
  skipNote: string;
}

function defaultRecordStop(input: { runId: string; cause: string; evidenceRef: string; nextMove: string; site?: string }): boolean {
  try {
    // 늦은 결합 — 회수 시점에만 런 원장 기록기를 읽는다(시험은 recordStop 을 주입한다).
    const { recordRunStop } = require('../self-implement/run-stop.js') as typeof import('../self-implement/run-stop.js');
    recordRunStop(input);
    return true;
  } catch {
    return false;
  }
}

/** 원장 추가 직전 현재 카드 재독 — 스냅숏이 오래 됐을 수 있어 정본(원장)에서 다시 읽는다. */
function defaultReadCard(statePath: string | undefined): (cardId: string) => TaskCard | undefined {
  return (cardId) => readTaskCard(cardId, statePath ?? taskAgentStatePath());
}

/**
 * 15분 무진척 발사를 자동 회수한다 — 정확 runId stop 한 줄(런 원장) ⊕ 원인 분류 skip-note 한 줄(카드 원장)을
 * 카드 파일 잠금 «아래 하나의 임계 구간»으로 남긴다: 잠금 안 재검증(재발사·진척·삭제·중복)을 «통과해야만»
 * stop 을 기록한다 — 잠금 밖 재검증 뒤 관측 갱신이 끼어도 살아 있는/옛 런에 stop 줄이 새지 않는다(JUD-B #118991·#119045).
 * 카드 status 는 바꾸지 않는다(기존 전이 소유 · 보존). 멱등: 같은 runId 로 이미 회수(skip-note)된 카드는 건너뛴다.
 * deps.appendHistory 주입(순수 spy) 시에만 옛 순서(잠금 밖 stop → spy 노트)를 쓴다 — 디스크 없는 단위 시험 전용.
 */
export function recycleStalledLaunches(cards: readonly TaskCard[], deps: TaRecycleDeps = {}): TaRecycleOutcome[] {
  const nowMs = deps.nowMs ?? Date.now();
  const readCard = deps.readCard ?? defaultReadCard(deps.statePath);
  const recordStop = deps.recordStop ?? defaultRecordStop;
  const reasonCodeFor = deps.reasonCodeFor ?? (() => 'unknown');
  const outcomes: TaRecycleOutcome[] = [];
  for (const card of findStalledLaunches(cards, nowMs)) {
    const runId = card.runId!;
    // 잠금 밖 사전 재검증 — 스냅숏 뒤 재발사(runId 교체)·진척(자격 상실)·삭제·중복 회수면 빠르게 건너뛴다.
    const current = readCard(card.id);
    if (!current || current.runId !== runId || findStalledLaunches([current], nowMs).length === 0) continue;
    const last = lastObservedMs(card)!;
    const cause = classifyNoProgressCause(reasonCodeFor(runId));
    const minutesStalled = Math.max(1, Math.floor((nowMs - last) / 60_000));
    const stopInput = {
      runId,
      cause: `15분 무진척 회수 — 정확 runId stop(${cause})`,
      evidenceRef: `run-ledger:${runId}:stop`,
      nextMove: `칸 ${card.checklistId ?? '-'} skip-note 확인 — 사람/판단부가 재발사 여부를 판단`,
      site: 'launch-result-loop',
    };
    const stopNote = `failed/recycled/${cause}: 15분 무진척(${minutesStalled}분) — 정확 runId ${runId} stop · 재발사는 사람/판단부 몫`;
    // 정확 runId stop 기록 실패 — 영구 skip-note 를 남기면 findStalledLaunches 가 이 카드를 영구 제외해
    // 재시도를 못 한다. 마커만 남긴다: 이벤트 이름이 달라 hasSkipNote 에 걸리지 않고,
    // at 이 관측 시각을 갱신해 다음 회수 창(15분)을 연다(JUD-B HOLD 8a9c06bfb0f4).
    const failNote = `stop-record-failed/${cause}: 정확 runId stop 기록 실패 — 재시도 대상 유지(15분 무진척 ${minutesStalled}분 · runId ${runId}) · 다음 관측에서 다시 회수 시도`;
    let stopRecorded = false;
    let appended = false;
    if (deps.appendHistory) {
      // 순수 spy 경로(디스크 없음) — 잠금이 없으므로 옛 순서(stop → spy 노트)로 기록만 관찰한다.
      stopRecorded = recordStop(stopInput) !== false;
      appended = deps.appendHistory(card.id, stopRecorded ? TA_SKIP_NOTE_EVENT : TA_STOP_FAILED_EVENT, stopRecorded ? stopNote : failNote, nowMs, runId) !== false;
    } else {
      // 원장(디스크) 경로 — 임계 구간: 잠금 «안» 재검증을 통과해야만 stop 을 기록하고 노트를 붙인다.
      // 진척(런 생존)·재발사(runId 교체)·중복 회수가 잠금 안에서 보이면 stop 줄도 노트도 남기지 않는다.
      updateTaskCard(deps.statePath ?? taskAgentStatePath(), card.id, (live) => {
        if (!live) return undefined; // 관측 사이 삭제 — 노트를 만들지 않는다.
        if (live.runId !== runId) return undefined; // 재발사로 runId 교체 — 옛 런의 stop·노트 금지.
        if (findStalledLaunches([live], nowMs).length === 0) return undefined; // 진척 또는 이미 회수 — 자격 상실·중복.
        // void(성공)와 true 는 기록됨, false 만 실패 — 잠금 안에서 기록한다(런 원장은 별도 파일 · 교착 없음).
        stopRecorded = recordStop(stopInput) !== false;
        appended = true;
        const entry = {
          at: new Date(nowMs).toISOString(),
          event: stopRecorded ? TA_SKIP_NOTE_EVENT : TA_STOP_FAILED_EVENT,
          detail: stopRecorded ? stopNote : failNote,
          runId,
        };
        return { ...live, history: [...(live.history ?? []), entry] } as TaskCard;
      });
    }
    // 추가가 잠금 아래 재검증을 통과했을 때만 회수 결과로 센다 — 재발사·진척·중복에 밀리면 결과 없이 건너뛴다.
    if (appended) {
      outcomes.push({ cardId: card.id, runId, cause, minutesStalled, stopRecorded, skipNote: stopRecorded ? stopNote : failNote });
    }
  }
  return outcomes;
}

/** LANDING-20 매시 점검 «TA 줄» — 착지 N 중 TA M ⊕ 발사·진행·회수 보조 수. */
export function landing20TaLine(input: { landingCount: number; cards: readonly TaskCard[]; nowMs?: number }): string {
  const { landingCount, cards } = input;
  const stages = cards.map((card) => launchStageOf(card));
  const taLanded = stages.filter((stage) => stage === 'landed').length;
  const launched = stages.filter((stage) => stage === 'launched').length;
  const pr = stages.filter((stage) => stage === 'pr').length;
  const recycled = stages.filter((stage) => stage === 'recycled').length;
  const launches = cards.filter((card) => card.runId).length;
  return `착지 ${landingCount} 중 TA ${taLanded} · TA 발사 ${launches} · 진행 ${launched + pr}(launched ${launched}·pr ${pr}) · 회수 ${recycled}`;
}