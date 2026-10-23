// ── 내부 턴 문 `startTurnIfIdle` (TUI-H2-INTERNAL-TURN · 0.2.31 · 2026-10-16) ──────────────
//
// 🚨 무엇을 푸는가: TUI 는 «사람이 Enter 를 쳐야만» 턴이 열린다. 자율 재개(H3 턴 끝 재개 · H4 우편 ·
//   H5 자기 예약)가 지나갈 «문»이 없어서, 지금까지 바깥 깨움은 입력칸 버퍼를 바꿔치고 합성 Enter 를
//   넣는 길(`hostControl.submit`)뿐이었다 — 대표 비침투(입력칸 주입 0)에 못 쓴다.
// ⭐ 이 모듈은 «문» 하나다: 한가할 때만 내부 턴을 연다. 거부는 에러가 아니라 «사유 값»이다(codex
//   `start_turn_if_idle` 꼴). 판정·상태는 여기, 대시보드(index.ts)는 얇은 배선만 한다.
// ⛔ 입력칸 버퍼·`injectKey`·`hostControl.submit` 을 만지지 않는다. 입력 루프에는 «비켜 달라»만 청한다
//   (`TextInputInternalTurnYieldPort` — 버퍼가 비었을 때만 textInput 이 스스로 물러난다).
// ⛔ 이번 조각은 문만 — H3/H4/H5 호출자는 붙이지 않는다.
//
// 세 얼굴:
//   관측 = debug.log('tui.autoturn', 'opened' | 'rejected', { origin, reason, turnId })
//   인지 = NotIdle · HumanTyping · Superseded · Disabled · Cap
//   힐링 = 열리면 같은 턴 실행 경로로 한 턴(화면엔 «↻ 자동 재개(<origin>): <이유>» 한 줄) ·
//          거부되면 호출자가 사유를 보고 다음 idle 에 다시 부른다 · 실패 시 사유 로그(TF 가 본다)

import type { InputResult, TextInputInternalTurnYieldPort } from '../../chat/index.js';
import { debug } from '../../debug/log.js';
import type { SubmitTurnIntent } from '../../input/input-intent.js';
import type { InternalTurnOrigin } from '../../chat/internal-turn-origin.js';
export type { InternalTurnOrigin } from '../../chat/internal-turn-origin.js';
import { lastHumanKeyAt as tuiLastHumanKeyAt, pendingKeyCount as tuiPendingKeyCount } from '../../tui.js';

/** 내부 턴의 출처 — 화면 한 줄·관측·정책이 이 값으로 갈린다. 새 출처는 여기에 더한다. */
/** 거부 사유 — 에러가 아니라 값이다. 호출자는 이 값을 보고 다음 idle 에 다시 부를지 정한다. */
export type InternalTurnRejectReason =
  /** 턴이 도는 중이거나, 입력칸이 안 떠 있거나(다른 창·모달), 앞 내부 턴이 아직 안 시작됐다. */
  | 'NotIdle'
  /** 입력칸에 글자 · 안 읽힌 키 · 턴 중 쳐 둔 글 · 마지막 사람 입력 뒤 조용창 안. */
  | 'HumanTyping'
  /** `expectedPrevTurnId` 가 지금의 마지막 턴과 다르다 = 그 사이 사람이 턴을 열었다. */
  | 'Superseded'
  /** 켜짐 스위치가 꺼져 있다. */
  | 'Disabled'
  /** 호출자가 넘긴 상한 판정(상한 값 자체는 H3 몫 — 여기선 존중만 한다). */
  | 'Cap';

export interface StartTurnIfIdleOptions {
  origin: InternalTurnOrigin;
  /** 화면 «↻ 자동 재개(<origin>): <이유>» 의 이유 한 줄. 없으면 origin 만 그린다. */
  reason?: string;
  /** 호출자가 «이 턴 다음에 이어 간다»고 본 직전 턴 id. 다르면 Superseded. */
  expectedPrevTurnId?: string;
  /** 호출자가 이미 상한에 닿았다고 판정했으면 true — 문은 Cap 으로 거부한다. */
  capReached?: boolean;
}

export type StartTurnIfIdleResult =
  | { opened: true; turnId: string }
  | { opened: false; reason: InternalTurnRejectReason; detail?: string };

/** 대시보드가 입력 루프에서 꺼내 실행할 내부 턴 한 건. */
export interface InternalTurnRequest {
  turnId: string;
  input: string;
  origin: InternalTurnOrigin;
  reason?: string;
}

export interface InternalTurnGateDeps {
  /** 켜짐 스위치. 기본: `ELANOUS_TUI_AUTOTURN` 이 '0'/'off'/'false' 가 아니면 켜짐. */
  isEnabled?: () => boolean;
  /** 모델 턴이 도는 중인가(대시보드 `streamingInFlight`). */
  isTurnRunning: () => boolean;
  /** 입력칸이 앞에 있나(chat-main 이 입력 소유 ∧ 막는 모달 없음). 없으면 늘 앞이라고 본다. */
  isInputForeground?: () => boolean;
  /** 입력칸의 살아 있는 버퍼(마운트 안 됐으면 undefined). */
  getBufferText: () => string | undefined;
  /** 턴 중 쳐 둔 글(typeahead 버퍼 ⊕ 대기 제출) 수. */
  getTypeaheadCount: () => number;
  /** 아직 readKey 가 안 읽은 키 수. 기본: tui `pendingKeyCount`. */
  pendingKeyCount?: () => number;
  /** 마지막 사람 키 시각(ms · 0 = 없음). 기본: tui `lastHumanKeyAt`. */
  lastHumanKeyAt?: () => number;
  now?: () => number;
  /** 마지막 사람 입력 뒤 이 시간 안이면 HumanTyping. 기본 10초. */
  humanQuietMs?: number;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

export interface InternalTurnGate {
  /** 모든 자율 재개가 지나는 문. 동기 판정 — 열리면 입력 루프에 «비켜 달라»를 청한다. */
  startTurnIfIdle(input: string, opts: StartTurnIfIdleOptions): StartTurnIfIdleResult;
  /** textInput 에 넘기는 자리 — 마운트되면 attach, 내려가면 detach. */
  readonly port: TextInputInternalTurnYieldPort;
  /** 입력 루프가 «비켜 줬다»고 돌아왔을 때 실행할 요청을 꺼낸다(정확히 한 번). */
  takePending(): InternalTurnRequest | null;
  /** 사람이 턴을 열었다(제출이 받아들여졌다) — Superseded 의 기준이 바뀐다. */
  noteHumanTurn(): string;
  /** 턴이 끝나 입력 루프로 돌아왔다 — 내부 턴 «진행 중» 표지를 내린다. */
  noteTurnSettled(): void;
  /** 지금 도는 턴이 내부 턴인가 — 사람 후속 입력을 그 턴에 끼워 넣지(steer) 않는 데 쓴다. */
  isInternalTurnActive(): boolean;
  /** 마지막으로 열린 턴 id(사람·내부) — 호출자가 `expectedPrevTurnId` 로 쓴다. */
  lastTurnId(): string | null;
}

export const DEFAULT_HUMAN_QUIET_MS = 10_000;

export function isInternalTurnEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ELANOUS_TUI_AUTOTURN ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false');
}

export function createInternalTurnGate(deps: InternalTurnGateDeps): InternalTurnGate {
  const isEnabled = deps.isEnabled ?? (() => isInternalTurnEnabledByEnv());
  const pendingKeys = deps.pendingKeyCount ?? tuiPendingKeyCount;
  const lastHumanKeyAt = deps.lastHumanKeyAt ?? tuiLastHumanKeyAt;
  const now = deps.now ?? Date.now;
  const quietMs = deps.humanQuietMs ?? DEFAULT_HUMAN_QUIET_MS;
  const log = deps.log ?? ((c, e, d) => debug.log(c, e, d));

  let requestYield: (() => boolean) | null = null;
  let pending: InternalTurnRequest | null = null;
  let internalActive = false;
  let lastId: string | null = null;
  /** 열린(아직 안 꺼낸) 내부 턴 «직전»의 lastId — 거둘 때 되돌린다(실행 안 된 턴이 Superseded 기준이 되지 않게). */
  let idBeforePending: string | null = null;
  let seq = 0;

  /** 열었지만 실행되지 않은 내부 턴을 거둔다 — 사람이 먼저다. */
  const withdrawPending = (detail: string): void => {
    if (!pending) return;
    const { origin, turnId } = pending;
    pending = null;
    lastId = idBeforePending;
    log('tui.autoturn', 'rejected', { origin, reason: 'HumanTyping', turnId, detail: `late:${detail}` });
  };

  const reject = (
    origin: InternalTurnOrigin,
    reason: InternalTurnRejectReason,
    detail?: string,
  ): StartTurnIfIdleResult => {
    log('tui.autoturn', 'rejected', { origin, reason, turnId: null, ...(detail ? { detail } : {}) });
    return detail ? { opened: false, reason, detail } : { opened: false, reason };
  };

  const humanTypingDetail = (): string | null => {
    const buffer = deps.getBufferText();
    if (buffer !== undefined && buffer.length > 0) return 'buffer';
    if (pendingKeys() > 0) return 'unread-keys';
    if (deps.getTypeaheadCount() > 0) return 'typeahead';
    const last = lastHumanKeyAt();
    if (last > 0 && now() - last < quietMs) return 'quiet-window';
    return null;
  };

  const port: TextInputInternalTurnYieldPort = {
    attach(fn) { requestYield = fn; },
    detach(opts) {
      requestYield = null;
      // 물러나지 않고 내려갔다(사람이 먼저 Enter·Esc 등으로 끝냈다) — 연 턴을 거둔다.
      if (!opts?.yielded) withdrawPending('input-closed');
    },
    declined(detail) {
      // 판정과 물러남 사이에 사람이 글자를 넣었다 — 연 턴을 거둔다(사람이 먼저다).
      withdrawPending(detail);
    },
  };

  return {
    port,
    startTurnIfIdle(input, opts) {
      const { origin } = opts;
      if (!isEnabled()) return reject(origin, 'Disabled');
      if (opts.capReached) return reject(origin, 'Cap');
      if (deps.isTurnRunning()) return reject(origin, 'NotIdle', 'turn-running');
      if (pending) return reject(origin, 'NotIdle', 'internal-turn-pending');
      if (!requestYield) return reject(origin, 'NotIdle', 'input-not-mounted');
      if (deps.isInputForeground && !deps.isInputForeground()) return reject(origin, 'NotIdle', 'input-not-foreground');
      if (opts.expectedPrevTurnId !== undefined && opts.expectedPrevTurnId !== lastId) {
        return reject(origin, 'Superseded', `expected=${opts.expectedPrevTurnId} last=${lastId ?? 'none'}`);
      }
      const typing = humanTypingDetail();
      if (typing) return reject(origin, 'HumanTyping', typing);
      const text = input.trim();
      if (!text) return reject(origin, 'NotIdle', 'empty-input');

      const turnId = `auto-${++seq}`;
      idBeforePending = lastId;
      pending = { turnId, input: text, origin, ...(opts.reason ? { reason: opts.reason } : {}) };
      // ⭐ 물러남은 textInput 의 몫 — 버퍼가 비었을 때만 true 를 낸다(입력칸 무접촉).
      let yielded = false;
      try { yielded = requestYield(); } catch { yielded = false; }
      if (!yielded) {
        pending = null;
        return reject(origin, 'HumanTyping', 'input-declined');
      }
      lastId = turnId;
      log('tui.autoturn', 'opened', { origin, reason: opts.reason ?? null, turnId });
      return { opened: true, turnId };
    },
    takePending() {
      const req = pending;
      pending = null;
      if (req) internalActive = true;
      return req;
    },
    noteHumanTurn() {
      const id = `human-${++seq}`;
      lastId = id;
      internalActive = false;
      return id;
    },
    noteTurnSettled() {
      internalActive = false;
    },
    isInternalTurnActive: () => internalActive,
    lastTurnId: () => lastId,
  };
}

// ── 입력 정책 (grok-build `InputPolicy` 꼴) ────────────────────────────────────────────
// 내부 턴은 ① 슬래시를 해석하지 않는다(늘 plain) ② 입력 히스토리에 넣지 않는다
// ③ 화면엔 사람 발화 에코 대신 «↻ 자동 재개» 한 줄만 ④ 사람 후속 입력은 그 턴에 끼워 넣지 않는다.

/** 내부 턴의 제출 의도 — 슬래시·sticky·exit 해석 없이 늘 plain 턴이다. */
export function resolveInternalTurnSubmitIntent(
  req: InternalTurnRequest,
  sessionId?: string | null,
): SubmitTurnIntent {
  return {
    kind: 'submit-turn',
    // 닫힌 sourceKind 어휘를 늘리지 않는다 — 자동화 계열 'scheduled' 에 출처를 싣는다.
    source: { kind: 'scheduled', jobId: `internal-turn:${req.origin}:${req.turnId}` },
    text: req.input,
    route: 'plain',
    ...(sessionId ? { sessionId } : {}),
  };
}

/** 화면 한 줄 — 사람 발화처럼 보이지 않게 «↻ 자동 재개(<origin>): <이유>». */
export function formatInternalTurnBanner(req: Pick<InternalTurnRequest, 'origin' | 'reason'>): string {
  const why = (req.reason ?? '').replace(/\s+/g, ' ').trim();
  return why ? `↻ 자동 재개(${req.origin}): ${why}` : `↻ 자동 재개(${req.origin})`;
}

/** 입력 루프가 돌아온 직후의 분기 — 대시보드는 «이 함수»를 부른다(시험이 같은 함수를 문다).
 *  - `human`    : 사람 입력 그대로(물러남 아님). 아직 열린 내부 턴이 있으면 거둔다.
 *  - `reenter`  : 물러났는데 꺼낼 게 없다(이미 거둬짐) — 입력으로 되돌아간다.
 *  - `internal` : 꺼낸 요청 ⊕ 같은 턴 실행 경로에 넣을 제출 결과(텍스트 = 내부 입력 · 출처 없음). */
export type InternalTurnConsumeResult =
  | { kind: 'human'; input: InputResult }
  | { kind: 'reenter' }
  | { kind: 'internal'; request: InternalTurnRequest; input: InputResult };

export function consumeInternalTurnYield(gate: InternalTurnGate, input: InputResult): InternalTurnConsumeResult {
  gate.port.detach({ yielded: input.yieldedToInternalTurn === true });
  if (!input.yieldedToInternalTurn) return { kind: 'human', input };
  const request = gate.takePending();
  if (!request) return { kind: 'reenter' };
  return { kind: 'internal', request, input: { text: request.input, submitted: true } };
}
