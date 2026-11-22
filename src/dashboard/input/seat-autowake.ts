// ── 턴 끝 자동 재개 `seat-autowake` (TUI-HOMEOSTASIS H3 · OPT-QUEUE-AUTOWAKE · 0.2.31 · 2026-10-16) ──────
//
// 🚨 무엇을 푸는가: 무인 자리 TUI(OPT 등)가 턴을 «✔ 완료»로 끝내면 그대로 멈춘다. 자리 큐
//   (`seat-state/<자리>/queue.md` «## 대기»)와 안 읽은 우편이 남아 있어도 다음 턴이 안 열려,
//   10-16 하루에 사람이 OPT 를 손으로 10회 넘게 깨웠다.
// ⭐ 이 모듈은 «남은 일이 있나»를 턴 끝에 재고, 있으면 H2 내부 턴 문(`startTurnIfIdle`)으로 다음 턴을
//   청한다. 문은 새로 짓지 않는다 — 거부 사유(NotIdle·HumanTyping …)는 H2 가 내고 여기선 그대로 남긴다.
// ⛔ 입력칸 버퍼·`injectKey`·`hostControl.submit`·pty 주입 0(대표 비침투). 큐 파일은 읽기 전용.
// ⛔ goal loop 에 얹지 않는다 — TUI 기본 엔진은 «보통 에이전트 턴»이고, 이어가기는 H2 위의 H3 다(OP #9347).
//
// 켜짐: 자리 TUI(`detectSeatTui`) ∧ `~/elanous-hq/seat-state/<자리>/autowake` 일반 파일(또는
//   `~/elanous-hq/seats/<자리>/autowake`). 끄는 길 = 파일 삭제. 사람이 앉는 자리 기본 0.
// 남은 일(OP #9349 계약): ⓐ 그 자리 안 읽은 우편 > 0 ⓑ queue.md «## 대기» 제목 아래 «- #N …» 줄 수 > 0
//   (취소선 «- ~~#N~~» 줄·다음 «## …»(예: «## 끝») 아래 줄은 남은 일이 아니다 · 제목이 없거나 줄 꼴을
//   못 알아보면 «모름» — 0 으로 읽지 않고 큐 쪽만 건너뛴다). 약속 시각은 H5 몫이라 여기 넣지 않는다.
// 상한: 같은 오더(미읽음 최대 id ⊕ 큐 머리)로는 1회 · 사람 입력 없이 연속 K=5 · 마지막 사람 입력 뒤 N=30s 안이면 안 깨움.
//
// 세 얼굴:
//   관측 = debug.log('tui.autowake', 'decided', { seat, unread, queue, opened|rejected, reason }) · 'cap'
//   인지 = 남은 일 > 0 ∧ 유휴(턴 끝 ∧ 입력칸 마운트) ∧ 상한 안
//   힐링 = H2 로 다음 턴(화면 «↻ 자동 재개(autowake): 우편 N통 · 큐 M건» 한 줄) · 상한 → 멈춤 ⊕ 'cap' ⊕
//          화면 한 줄 «사람 확인 필요» · 실패 시 사유 로그(TF 가 본다)

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TextInputInternalTurnYieldPort } from '../../chat/index.js';
import { debug } from '../../debug/log.js';
import { readUnreadSummary } from '../../msg/msg-store.js';
import { lastHumanKeyAt as tuiLastHumanKeyAt } from '../../tui.js';
import { detectSeatTui, type SeatDetection } from '../seat-boot-preamble.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from './internal-turn.js';
import { readSeatBudgetUsage, type SeatUsageBucket } from './seat-autowake-budget.js';

export const SEAT_AUTOWAKE_FILE = 'autowake';
export const DEFAULT_AUTOWAKE_CONSECUTIVE_CAP = 5;
export const DEFAULT_AUTOWAKE_HUMAN_QUIET_MS = 30_000;
// ELN-SEAT-TURN-PACING(PLAN-ELN-SEAT-RUNTIME-1005 칸 3): 자동 턴 사이 최소 간격 — 계획 «기본 30~60s»의
// 대표값 45s. 사람 턴에는 적용하지 않는다(autowake 가 연 턴만 잰다).
export const DEFAULT_AUTOWAKE_MIN_GAP_MS = 45_000;

// ── 큐 파서 ──────────────────────────────────────────────────────────────────────────

export type SeatQueueParse =
  | { known: true; count: number; head: string | null }
  | { known: false; reason: 'absent' | 'no-waiting-heading' | 'unrecognized-items' | 'unreadable' };

const WAITING_HEADING = /^##\s+대기(?:\s|$)/;
const ANY_H2 = /^##\s+\S/;
/** 목록 줄(«-»·«*» 둘 다 잡되, 남은 일로 세는 것은 «- #N …» 뿐 — 나머지 꼴은 «모름»). */
const LIST_ITEM = /^\s*([-*])\s+(.*)$/;
/** «#N» 다음은 공백·줄끝·(유니코드) 글자·숫자 아닌 것 — «#12abc»·«#12한글» 은 «#12» 가 아니다. */
const ITEM_ID = /^#(\d+)(?![\p{L}\p{N}_])/u;
const STRUCK_ITEM = /^~~/;
const NESTED_TASK = /^\s+(?:[-*+]|\d+[.)])\s+(?:~~)?#\d/;

/** queue.md 에서 «## 대기» 아래 남은 항목(«- #N …»)을 센다. 형식을 모르면 known:false(0 이 아니다). */
export function parseSeatQueue(text: string | null): SeatQueueParse {
  if (text === null) return { known: false, reason: 'absent' };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => WAITING_HEADING.test(line.trim()));
  if (start < 0) return { known: false, reason: 'no-waiting-heading' };
  let count = 0;
  let head: string | null = null;
  let unrecognized = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (ANY_H2.test(line.trim())) break; // 다음 절(«## 끝» 등) — 그 아래는 남은 일이 아니다.
    if (!line.trim()) continue;
    // 들여 쓴 줄 = 앞 항목의 이어쓰기 설명 — 단, 들여 쓴 «작업처럼 보이는» 줄(목록 기호 ⊕ #N)은 꼴 모름.
    if (/^\s/.test(line)) {
      if (NESTED_TASK.test(line)) unrecognized++;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    // 들여 쓰지 않은 줄은 «- #N …» · «- ~~#N~~ …» 둘뿐이다 — 번호 목록·맨 #N·글줄은 꼴 모름.
    if (!item) { unrecognized++; continue; }
    const body = item[2]!.trim();
    if (STRUCK_ITEM.test(body)) continue; // ~~#N~~ = 완료/폐기
    const id = item[1] === '-' ? ITEM_ID.exec(body) : null;
    if (!id) { unrecognized++; continue; }
    count++;
    head ??= `#${id[1]}`;
  }
  // «- #N» 꼴이 아닌 목록 줄이 하나라도 있으면 꼴을 모른다 — 세지 않고 «모름»(0 으로도, 일부 수로도 확정하지 않는다).
  if (unrecognized > 0) return { known: false, reason: 'unrecognized-items' };
  return { known: true, count, head };
}

// ── 순수 판정 ────────────────────────────────────────────────────────────────────────

export type SeatAutowakeSkipReason =
  | 'no-seat'
  | 'disabled'
  | 'not-turn-end'
  | 'nothing-pending'
  | 'human-recent'
  | 'same-order'
  | 'cap'
  | 'min-gap'
  | 'token-budget'
  | 'terminal-codex-400';

/** The rendered error line is captured before the turn footer shortens it. */
export interface SeatAutowakeTurnResult {
  sessionId: string | null;
  lastLine: string;
  /** Raw turn failure staged for /detail open when the visible line is condensed. */
  errorDetail?: string;
}

export interface SeatAutowakeInput {
  /** 자리 TUI 의 자리(대문자) — 자리 아님이면 null. */
  seat: string | null;
  /** autowake 파일이 있나. */
  enabled: boolean;
  /** 직전 확인 뒤 턴이 끝났나(턴 끝에서만 깨운다 — 부팅·화면 전환 재진입은 아니다). */
  turnEnded: boolean;
  /** 안 읽은 우편 수 ⊕ 최신 id. null = 원장 없음/못 읽음(«모름»). */
  unread: { count: number; maxId: number | null } | null;
  queue: SeatQueueParse;
  now: number;
  /** 마지막 사람 키 시각(ms · 0 = 없음). */
  lastHumanKeyAt: number;
  humanQuietMs?: number;
  /** 마지막으로 «연» 자동 턴의 오더 지문. */
  lastFingerprint: string | null;
  /** 사람 입력 없이 연속으로 연 자동 턴 수. */
  consecutive: number;
  consecutiveCap?: number;
  /** 자동 턴 사이 최소 간격(ms). 0/생략 = 제한 없음. */
  minGapMs?: number | null;
  /** 마지막 «자동» 턴이 끝난 시각(ms · 0 = 자동 턴 아직 없음). */
  lastAutoTurnEndAt: number;
  /** 하루 토큰 예산(입·출력 합). null/생략 = 예산 없음(제한 안 함). */
  tokenBudget?: number | null;
  /** 오늘 이미 쓴 토큰(입·출력 합). null = 모름(제한 안 함). */
  tokensUsed?: number | null;
}

export type SeatAutowakeDecision =
  | { action: 'start-turn'; fingerprint: string; unread: number | null; queue: number | null; prompt: string; reason: string }
  | { action: 'skip'; reason: SeatAutowakeSkipReason; unread: number | null; queue: number | null; fingerprint?: string };

/** 오더 지문 — 같은 미읽음 최대 id ⊕ 같은 큐 머리면 «같은 오더»다. */
export function seatAutowakeFingerprint(unreadMaxId: number | null, queueHead: string | null): string {
  return `msg:${unreadMaxId ?? '-'}|queue:${queueHead ?? '-'}`;
}

/** «우편 N통 · 큐 M건» — 모르는 쪽은 «모름»으로 남긴다(0 으로 단정하지 않는다). */
export function formatSeatAutowakeReason(unread: number | null, queue: number | null): string {
  return `${unread === null ? '우편 모름' : `우편 ${unread}통`} · ${queue === null ? '큐 모름' : `큐 ${queue}건`}`;
}

export function formatSeatAutowakePrompt(seat: string, unread: number | null, queue: number | null): string {
  return `[자동 재개] 남은 일: ${formatSeatAutowakeReason(unread, queue)} — 이어서 처리 `
    + `(eln msg list --to ${seat} · ~/elanous-hq/seat-state/${seat}/queue.md «## 대기» 맨 위부터)`;
}

export function decideSeatAutowake(input: SeatAutowakeInput): SeatAutowakeDecision {
  const unread = input.unread ? input.unread.count : null;
  const queue = input.queue.known ? input.queue.count : null;
  const skip = (reason: SeatAutowakeSkipReason, fingerprint?: string): SeatAutowakeDecision =>
    ({ action: 'skip', reason, unread, queue, ...(fingerprint ? { fingerprint } : {}) });
  if (!input.seat) return skip('no-seat');
  if (!input.enabled) return skip('disabled');
  if (!input.turnEnded) return skip('not-turn-end');
  const pendingUnread = unread ?? 0;
  const pendingQueue = queue ?? 0;
  if (pendingUnread <= 0 && pendingQueue <= 0) return skip('nothing-pending');
  const fingerprint = seatAutowakeFingerprint(
    pendingUnread > 0 ? input.unread!.maxId : null,
    pendingQueue > 0 && input.queue.known ? input.queue.head : null,
  );
  const quiet = input.humanQuietMs ?? DEFAULT_AUTOWAKE_HUMAN_QUIET_MS;
  if (input.lastHumanKeyAt > 0 && input.now - input.lastHumanKeyAt < quiet) return skip('human-recent', fingerprint);
  if (input.consecutive >= (input.consecutiveCap ?? DEFAULT_AUTOWAKE_CONSECUTIVE_CAP)) return skip('cap', fingerprint);
  // 턴 사이 쉼(칸 3): 직전 «자동» 턴이 끝난 뒤 최소 간격이 지나기 전엔 새 자동 턴을 열지 않는다.
  // lastAutoTurnEndAt=0(자동 턴 이력 없음 — 첫 기상 등)은 간격을 재지 않는다.
  if (input.minGapMs && input.minGapMs > 0 && input.lastAutoTurnEndAt > 0
    && input.now - input.lastAutoTurnEndAt < input.minGapMs) return skip('min-gap', fingerprint);
  // 하루 토큰 예산(칸 3): 쓴 양을 알 수 있고 예산을 넘었으면 새 자동 턴을 열지 않는다.
  if (input.tokenBudget != null && input.tokenBudget > 0 && input.tokensUsed != null
    && input.tokensUsed >= input.tokenBudget) return skip('token-budget', fingerprint);
  if (input.lastFingerprint === fingerprint) return skip('same-order', fingerprint);
  return {
    action: 'start-turn',
    fingerprint,
    unread,
    queue,
    prompt: formatSeatAutowakePrompt(input.seat, unread, queue),
    reason: formatSeatAutowakeReason(unread, queue),
  };
}

// ── 배선 컨트롤러 ────────────────────────────────────────────────────────────────────

export interface SeatAutowakeDeps {
  /** H2 문 — 대시보드의 `internalTurnGate.startTurnIfIdle`. */
  startTurnIfIdle: (input: string, opts: StartTurnIfIdleOptions) => StartTurnIfIdleResult;
  getCwd: () => string;
  home?: string;
  detectSeat?: (cwd: string) => SeatDetection | null;
  isRegularFile?: (path: string) => boolean;
  readText?: (path: string) => string | null;
  readUnread?: (seat: string) => { count: number; maxId: number | null } | null;
  lastHumanKeyAt?: () => number;
  now?: () => number;
  humanQuietMs?: number;
  consecutiveCap?: number;
  /** 턴 사이 최소 간격(ms). 생략 = DEFAULT_AUTOWAKE_MIN_GAP_MS · null/0 = 게이트 끔(레거시 시험 배선). */
  minGapMs?: number | null;
  /** 하루 토큰 예산(입·출력 합). 호출 시점 값 — null/생략 = 예산 없음. */
  tokenBudget?: () => number | null;
  /** 오늘 이미 쓴 토큰(입·출력 합). null = 모름 → 제한 안 함. */
  tokensUsed?: () => number | null;
  /** Test seam for today's seat-attributed usage; null means unavailable. */
  readBudgetUsage?: (sinceDay: string) => readonly SeatUsageBucket[] | null;
  /** 상한 도달 때 화면 한 줄(«사람 확인 필요»). */
  notify?: (line: string) => void;
  /** 입력칸이 마운트된 뒤 판정을 미루는 자리(기본 setTimeout 0 · unref). 시험은 즉시 실행을 넘긴다. */
  defer?: (fn: () => void, ms: number) => void;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** SEAT-SELF-PULL 이음매: 턴 끝 판정이 «남은 일 없음(nothing-pending)»일 때 한 번 부른다(실패는 삼킨다).
   *  생략 = 기본 self-pull(자리 `self-pull` 파일 opt-in 일 때만 재료를 읽는다 · seat-self-pull-sources.ts). */
  onNoWorkLeft?: (ctx: { seat: string; unread: number | null; queue: number | null }) => void;
}

export interface SeatAutowakeController {
  /** 모델 턴이 끝났다(스트리밍 정리 지점) — 다음 입력칸 마운트에서 한 번 잰다. */
  noteTurnEnded(result?: SeatAutowakeTurnResult): void;
  /** 입력칸이 마운트됐다 — 턴 끝이 무장돼 있으면 판정하고, 남은 일이 있으면 H2 로 연다. */
  check(): SeatAutowakeDecision & { opened?: boolean; rejected?: string };
  /** H2 의 yield port 를 감싸 «마운트 = 판정 시점»으로 잇는다(입력칸 무접촉). */
  wrapPort(port: TextInputInternalTurnYieldPort): TextInputInternalTurnYieldPort;
}

function defaultIsRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function defaultReadText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function defaultDefer(fn: () => void, ms: number): void {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
}

export function createSeatAutowake(deps: SeatAutowakeDeps): SeatAutowakeController {
  const home = deps.home ?? homedir();
  // SEAT-SELF-PULL 기본 훅은 처음 «남은 일 없음»에서야 싣는다(순환 import 회피 · 부팅 비용 0).
  let defaultNoWork: ((ctx: { seat: string; unread: number | null; queue: number | null }) => void) | null = null;
  const onNoWorkLeft = deps.onNoWorkLeft ?? ((ctx: { seat: string; unread: number | null; queue: number | null }) => {
    defaultNoWork ??= (require('./seat-self-pull-sources.js') as typeof import('./seat-self-pull-sources.js'))
      .createAutowakeSelfPullHook({ startTurnIfIdle: deps.startTurnIfIdle, home });
    defaultNoWork(ctx);
  });
  const detect = deps.detectSeat ?? ((cwd: string) => {
    try { return detectSeatTui(cwd, { home }); } catch { return null; }
  });
  const isFile = deps.isRegularFile ?? defaultIsRegularFile;
  const readText = deps.readText ?? defaultReadText;
  const readUnread = deps.readUnread ?? ((seat: string) => {
    try { return readUnreadSummary(seat); } catch { return null; }
  });
  const humanKeyAt = deps.lastHumanKeyAt ?? tuiLastHumanKeyAt;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((c, e, d) => debug.log(c, e, d));
  const defer = deps.defer ?? defaultDefer;
  const quietMs = deps.humanQuietMs ?? DEFAULT_AUTOWAKE_HUMAN_QUIET_MS;
  const readUsage = deps.readBudgetUsage ?? ((day: string) => {
    const { readUsageDaily } = require('../../budget/usage-daily-store.js') as typeof import('../../budget/usage-daily-store.js');
    const usage = readUsageDaily(undefined, day);
    return usage && usage.unclassifiedRows === 0 ? usage.rows : null;
  });

  let turnEnded = false;
  let lastFingerprint: string | null = null;
  let consecutive = 0;
  let lastOpenedAt = 0;
  let capNotified = false;
  let budgetNotified = false;
  let recheckArmed = false;
  let activeSessionId: string | null = null;
  let lastOrphanFailure: { callId: string; count: number } | null = null;
  let terminalCallId: string | null = null;
  // 칸 3(턴 사이 쉼): 마지막 «자동» 턴이 끝난 시각 — noteTurnEnded 에서 찍는다(사람 턴은 잊는다).
  let lastAutoTurnEndAt = 0;
  // «지금 돌고 있는» 턴이 autowake 가 열 것인가 — check() 가 열 때 true, noteTurnEnded 에서 소비 후 즉시 false.
  let autoOpenedThisTurn = false;

  const check: SeatAutowakeController['check'] = () => {
    const detection = detect(deps.getCwd());
    const seat = detection?.seat ?? null;
    const seatStateDir = seat ? join(home, 'elanous-hq', 'seat-state', seat) : null;
    const enabled = seat !== null && (
      isFile(join(seatStateDir!, SEAT_AUTOWAKE_FILE))
      || isFile(join(home, 'elanous-hq', 'seats', seat, SEAT_AUTOWAKE_FILE))
    );
    // 자리가 아니거나 꺼져 있으면 아무것도 안 읽는다(사람 대화 TUI 비용 0 · 로그 0).
    if (!seat || !enabled) {
      turnEnded = false;
      return decideSeatAutowake({
        seat, enabled, turnEnded: false, unread: null, queue: { known: false, reason: 'absent' },
        now: 0, lastHumanKeyAt: 0, lastFingerprint, consecutive, lastAutoTurnEndAt,
      });
    }
    const humanAt = humanKeyAt();
    // 사람 키 하나가 연속 카운터를 0 으로 — 그 뒤엔 다시 열 수 있다.
    if (humanAt > lastOpenedAt && consecutive > 0) { consecutive = 0; capNotified = false; }
    const unread = readUnread(seat);
    const queue = parseSeatQueue(readText(join(seatStateDir!, 'queue.md')));
    const t = now();
    const budget = seat && enabled && turnEnded && !deps.tokenBudget && !deps.tokensUsed
      ? readSeatBudgetUsage({ seat, budgetText: readText(join(seatStateDir!, 'autowake-budget')), now: new Date(t), readUsage })
      : { budget: deps.tokenBudget?.() ?? null, used: deps.tokensUsed?.() ?? null };
    const decision = decideSeatAutowake({
      seat, enabled, turnEnded, unread, queue, now: t, lastHumanKeyAt: humanAt,
      humanQuietMs: quietMs, lastFingerprint, consecutive, consecutiveCap: deps.consecutiveCap,
      minGapMs: deps.minGapMs === undefined ? DEFAULT_AUTOWAKE_MIN_GAP_MS : deps.minGapMs,
      lastAutoTurnEndAt,
      tokenBudget: budget.budget,
      tokensUsed: budget.used,
    });
    if (terminalCallId && activeSessionId) {
      turnEnded = false;
      log('tui.autowake', 'terminal-blocked', {
        seat, sessionId: activeSessionId, errorKind: 'codex-orphan-tool-output-400',
        callId: terminalCallId, recommendedAction: '/session new',
      });
      return { action: 'skip', reason: 'terminal-codex-400', unread: decision.unread, queue: decision.queue };
    }
    if (decision.action === 'skip' && decision.reason === 'not-turn-end') return decision;
    const base = {
      seat,
      unread: decision.unread,
      queue: decision.queue,
      ...(queue.known ? {} : { queueUnknown: queue.reason }),
      fingerprint: decision.fingerprint ?? null,
      consecutive,
    };
    if (decision.action === 'skip') {
      if (decision.reason === 'human-recent') {
        // 조용창이 지나면 한 번 더 잰다(턴 끝 무장은 남긴다) — 그 사이 사람이 치면 그때 또 미뤄진다.
        if (!recheckArmed) {
          recheckArmed = true;
          defer(() => { recheckArmed = false; check(); }, Math.max(0, quietMs - (t - humanAt)) + 50);
        }
        log('tui.autowake', 'decided', { ...base, rejected: true, reason: 'human-recent' });
        return decision;
      }
      if (decision.reason === 'min-gap') {
        // 칸 3(턴 사이 쉼): 최소 간격 이내 — 무장은 그대로(쉼이 지나면 다음 check() 에서 재개).
        // 이 분기에 왔다는 것은 decide 가 minGapMs>0 를 본 것 — null/undefined 일 수 없어 기본값으로 흘려도 안전.
        const gap = deps.minGapMs ?? DEFAULT_AUTOWAKE_MIN_GAP_MS;
        if (!recheckArmed) {
          recheckArmed = true;
          defer(() => { recheckArmed = false; check(); }, Math.max(0, gap - (t - lastAutoTurnEndAt)) + 50);
        }
        log('tui.autowake', 'decided', { ...base, rejected: true, reason: 'min-gap' });
        return decision;
      }
      if (decision.reason === 'token-budget') {
        // 칸 3: 하루 예산 소진 — 무장은 유지(예산이 돌아오면 재개). 다음 사람 키에서 알림 리셋.
        if (!budgetNotified) {
          budgetNotified = true;
          log('tui.autowake', 'budget', { ...base });
          deps.notify?.(`⏸ 하루 토큰 예산 도달(${budget.used ?? '?'}/${budget.budget ?? '?'}) — 사람 확인 필요 · 키 하나면 다시 이어간다`);
        }
        log('tui.autowake', 'decided', { ...base, rejected: true, reason: 'token-budget' });
        return decision;
      }
      turnEnded = false;
      if (decision.reason === 'cap') {
        if (!capNotified) {
          capNotified = true;
          log('tui.autowake', 'cap', { ...base, cap: deps.consecutiveCap ?? DEFAULT_AUTOWAKE_CONSECUTIVE_CAP });
          deps.notify?.(`⏸ 자동 재개 상한(${deps.consecutiveCap ?? DEFAULT_AUTOWAKE_CONSECUTIVE_CAP}회 연속) — 사람 확인 필요 · 키 하나면 다시 이어간다`);
        }
      }
      log('tui.autowake', 'decided', { ...base, rejected: true, reason: decision.reason });
      if (decision.reason === 'nothing-pending') {
        try { onNoWorkLeft({ seat, unread: decision.unread, queue: decision.queue }); }
        catch (error) { log('tui.autowake', 'no-work-hook-error', { seat, error: String(error).slice(0, 200) }); }
      }
      return decision;
    }
    const result = deps.startTurnIfIdle(decision.prompt, { origin: 'autowake', reason: decision.reason });
    if (result.opened) {
      turnEnded = false;
      lastFingerprint = decision.fingerprint;
      consecutive += 1;
      lastOpenedAt = t;
      autoOpenedThisTurn = true; // noteTurnEnded 가 lastAutoTurnEndAt 를 찍는 근거.
      log('tui.autowake', 'decided', { ...base, consecutive, opened: true, reason: decision.reason, turnId: result.turnId });
      return { ...decision, opened: true };
    }
    // H2 거부 — 사유를 그대로 남긴다. 무장은 풀지 않는다(다음 마운트에서 다시 잰다).
    log('tui.autowake', 'decided', { ...base, rejected: true, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) });
    return { ...decision, opened: false, rejected: result.reason };
  };

  return {
    noteTurnEnded(result) {
      turnEnded = true;
      // 칸 3(턴 사이 쉼) ⊕ MF1(r6 mustFix 1): 종료된 턴이 autowake 가 열 턴이었는지는 «이 순간에만»
      // 알 수 있다 — 소비하자마자 되돌린다(false). 그래야 다음 턴이 사람 턴일 때 아래 else 가 맞게 돈다.
      const endedAutoTurn = autoOpenedThisTurn;
      autoOpenedThisTurn = false;
      if (endedAutoTurn) {
        // 자동 턴의 종료 시각 — min-gap 판정의 기준. deps.now() 로 찍는다(Date.now() 직접 금지 —
        // 시험 가짜 시계와 어긋나 min-gap 이 항상 걸린다).
        lastAutoTurnEndAt = now();
      } else {
        // 사람 턴 종료 — 자동 턴 사이 쉼의 기준이 아니다: lastAutoTurnEndAt 를 지운다(0 = 기록 없음).
        // 사람이 직접 마무리한 뒤 남은 일이 있으면 간격 없이 곧바로 이어붙인다(사람 턴 뒤 즉시 재개).
        lastAutoTurnEndAt = 0;
      }
      if (!result) return;
      if (result.sessionId !== activeSessionId) {
        activeSessionId = result.sessionId;
        lastOrphanFailure = null;
        terminalCallId = null;
        lastFingerprint = null;
        consecutive = 0;
      }
      // Only the production failed-turn path stages `errorDetail` (pushFailureNotice), so its presence is what
      // marks a failed turn — ordinary assistant text that quotes the same API error never carries it.
      // TUI-ORPHAN-AUTO-RESUME-STOP E4 (10-23): the visible line is not a usable gate — this 400 goes through
      // autoheal, whose notice reads «⚠ 자동 회복 N회 실패…», and the turn footer «✘ 실패 …» is the last line.
      // The old gate («모델 API 가 요청을 400 으로 거절» in lastLine) therefore never matched in the live TUI.
      const match = result.errorDetail !== undefined
        ? /\bCodex API 400\b[^\n]*?No tool call found for function call output with call_id\s+([\w-]+)/iu.exec(result.errorDetail)
        : null;
      if (!match || !activeSessionId) {
        if (result.errorDetail !== undefined) log('tui.autowake', 'turn-failure', { sessionId: activeSessionId, orphan400: false, count: 0, detailHead: result.errorDetail.slice(0, 160) });
        lastOrphanFailure = null;
        return;
      }
      const callId = match[1]!;
      lastOrphanFailure = lastOrphanFailure?.callId === callId
        ? { callId, count: lastOrphanFailure.count + 1 } : { callId, count: 1 };
      log('tui.autowake', 'turn-failure', { sessionId: activeSessionId, orphan400: true, callId, count: lastOrphanFailure.count });
      if (lastOrphanFailure.count < 2 || terminalCallId) return;
      terminalCallId = callId;
      log('tui.autowake', 'terminal', {
        seat: detect(deps.getCwd())?.seat ?? null,
        sessionId: activeSessionId, errorKind: 'codex-orphan-tool-output-400',
        callId, recommendedAction: '/session new',
      });
      deps.notify?.(`⏹ Codex 400 자동 재개 중단 · 세션 ${activeSessionId} · call_id ${callId} · /session new 로 새 세션을 시작하세요`);
    },
    check,
    wrapPort(port) {
      return {
        attach(requestYield) {
          port.attach(requestYield);
          // 입력 루프가 첫 그림을 그린 뒤 잰다 — 마운트 «중»에 물러남을 청하지 않는다.
          if (turnEnded) defer(() => { try { check(); } catch { /* fail-soft: 깨움은 입력을 막지 않는다 */ } }, 0);
        },
        detach(opts) { port.detach(opts); },
        declined(detail) { port.declined?.(detail); },
      };
    },
  };
}
