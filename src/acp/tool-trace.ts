import { appendMessage, onSessionCreated } from '../session/index.js';
// ⛔ 메시지 «모양»은 `session/chat.ts` 가 갖는다 — 여기서 베끼지 않는다.
//   같은 계약을 두 벌로 두면 한쪽만 자라고, 그때 「어느 표면의 기록인가」가 갈린다.
import { buildToolTraceMessage } from '../session/chat.js';
import { debug } from '../debug/log.js';

/** ⛔⭐⭐⭐ **ACP 턴(= PWA 채팅이 «실제로» 타는 길)의 툴 감사 추적을 세션에 남긴다.**
 *
 *  ## 왜 이 파일이 있나
 *
 *  📏 2026-08-22 실측(16차 `[F]`): ***PWA 세션에는 툴 추적이 «하나도» 없었다.***
 *  저장소 role 분포가 `user 205 · assistant 241 · system 12` 였고 **`tool` 이 «0»**.
 *  ⛔ 전수: `buildToolTraceMessage()` 를 부르는 곳은 `session/chat.ts`(CLI·TUI) ·
 *  `discord-self-message.ts` · `telegram-commands.ts` 뿐이고 ***`src/acp/`·`src/nexus/` 에는 없었다.***
 *
 *  > 🔑 ***표면마다 감사 추적이 갈렸다*** — CLI·TUI·텔레그램은 남기고 **PWA 만 안 남겼다.**
 *  > 그래서 「PWA 에서 어떤 도구를 호출했나」에는 «지어낸 답»밖에 나올 수 없었다
 *  > (`session/chat.ts` 주석이 그 위험을 이미 적었다 — *"the REAL trace, not a confabulated one"*).
 *
 *  ## ⛔ 왜 «떼어냈나» — 시험이 「모양」이 아니라 「동작」을 물게 하려고
 *
 *  📏 무인 리뷰 must-fix(PR #11120): 1차판은 이 로직을 `server.ts` 의 깊은 클로저 안에 두고
 *  시험이 **소스 문자열만** 검사했다. ⇒ ***배선이 런타임에 죽어도, 엉뚱한 세션·인자를 저장해도 초록***인
 *  Goodhart 시험이었다. ⇒ 주입 가능한 함수로 떼어 **실행으로** 문다. */
/** ⛔ 이 저장소 «밖»으로 열지 않는다 — 소비처가 이 파일과 그 시험뿐이다(리뷰 must-fix:
 *  쓰이지 않는 공개 표면). 시험은 리터럴로 넘기므로 이름을 export 할 필요가 없다. */
type TraceMessage = ReturnType<typeof buildToolTraceMessage>;
type AppendFn = (sessionId: string, msg: TraceMessage) => unknown;
type FailureObserver = (info: { sessionId: string; tool: string; id: string; reason: string }) => void;

interface AcpToolTraceDeps {
  /** 시험 주입점. 기본은 실제 세션 저장소. */
  readonly append?: AppendFn;
  /** ⛔⭐ 메시지 «모양»을 만드는 자리 — 기본은 `session/chat.ts` 의 공유 빌더.
   *
   *  📏 무인 리뷰 must-fix(PR #11120): 산출 필드(`role`/`toolName`/…)만 검사하면
   *  ***이 모듈이 모양을 «수동 복제»해도 시험이 통과한다.*** 그러면 계약이 조용히 둘이 되고,
   *  한쪽만 자란 날 「어느 표면의 기록인가」가 갈린다(16차에 그 부류가 네 번 실제 결함이었다).
   *  ⇒ 주입점으로 열어 **「공유 빌더를 쓴다」를 시험이 «실행으로» 확인**할 수 있게 한다. */
  readonly buildMessage?: typeof buildToolTraceMessage;
  /** 실패를 «이름으로» 남기는 자리. 기본은 관측 로그. */
  readonly observeFailure?: FailureObserver;
  /** 지연·회수·상한을 남기는 자리(`trace-persist-deferred|flushed|dropped`). 기본은 관측 로그. */
  readonly observe?: (event: TraceDeferEvent, data: Record<string, unknown>) => void;
  /** 「세션이 원장에 생겼다」를 듣는 자리. 기본은 `session/index.ts` 의 `onSessionCreated`. */
  readonly subscribeSessionCreated?: (listener: (meta: { readonly id: string }) => void) => () => void;
}

type TraceDeferEvent = 'trace-persist-deferred' | 'trace-persist-flushed' | 'trace-persist-dropped';

/** ⛔⭐⭐ **「세션이 아직 원장에 없다」는 실패가 아니라 «순서»다 — 지연 기록한다.**
 *
 *  📏 2026-10-16 실측(TUI 결함 #30·#64 · `eln logs --category acp.tool` 12h):
 *    `trace-persist-failed «session not found: elanous-session-ndusg6»` 7건이 **13:12:03~15Z 한 턴**에 몰렸고,
 *    그 세션 파일의 첫 줄은 **13:12:48Z**(턴 «끝»)였다.
 *  🔑 원인(호출부): ACP 서버는 세션 id 를 «메모리에만» 민팅하고(`acpServerRegisterSession` · `server.ts`),
 *    원장 채택은 **턴이 «끝난 뒤»** 에 일어난다 — `persistCompletedTuiAcpTurn`(서버 · origin 메타가 있을 때) 또는
 *    대시보드의 `adoptChatSession`(SESSION-RESUME-ISOLATED · 턴 완료 뒤). 그런데 툴 흔적은 «턴 도중»
 *    `pushToolResult` → 이 함수에서 쓴다. ⇒ ***새 세션의 «첫 턴» 도구 흔적은 전부 잃었다***
 *    (`/session new`·ACP 갱신마다 새 id 라 첫 턴이 반복된다).
 *  ⇒ 그 오류면 메시지를 세션별로 붙잡아 두고, 세션이 원장에 생기는 순간(`onSessionCreated`) 또는
 *    같은 세션의 다음 호출 때 «원래 시각(ts) 그대로» 붙인다. 경고는 세션당 «한 번»(지연) ⊕ 회수 때 «수»로.
 *  ⛔ 출처(`source`)를 짐작해 여기서 세션을 «만들지» 않는다 — 같은 ACP 경로를 PWA 도 타므로
 *    TUI 로 낙인찍으면 남의 세션 속성을 틀리게 박는다. 만드는 일은 원래 주인(턴 완료 채택)에게 둔다. */
/*  ⚠️ 상한은 «메모리 바닥»만 지킨다 — 영영 채택되지 않는 세션(턴 도중 종료)이 쌓이지 않게.
 *    세션당 100 을 넘으면 그 뒤 흔적은 버리고, 세션 32 를 넘으면 가장 오래 기다린 세션을 통째로 버린다.
 *    어느 쪽이든 `trace-persist-dropped` 를 «한 줄» 남길 뿐 버린 «수»를 세거나 간격을 두지 않는다
 *    (버림 계수·보고 방식은 연결 골 `ASK-ACP-TRACE-EVICTION-ACCOUNTING` 이 정한다).
 *    축출된 id 가 다시 오면 「한 번」 경고부터 다시 시작한다 — id 는 base36 무작위 6자라 드물다. */
const MAX_PENDING_PER_SESSION = 100;
const MAX_PENDING_SESSIONS = 32;
const SESSION_NOT_FOUND = /^session not found: /;

interface PendingSession {
  readonly entries: Array<{
    readonly append: AppendFn;
    readonly msg: TraceMessage;
    readonly tool: string;
    readonly id: string;
    readonly observeFailure: FailureObserver | undefined;
  }>;
  /** 세션당 상한에 한 번 닿았나 — `trace-persist-dropped` 를 세션당 한 줄만 남기려고. */
  capped: boolean;
  readonly observe: (event: TraceDeferEvent, data: Record<string, unknown>) => void;
}

const pendingBySession = new Map<string, PendingSession>();
let unsubscribeCreated: (() => void) | null = null;

const defaultObserve = (event: TraceDeferEvent, data: Record<string, unknown>): void => {
  debug.log('acp.tool', event, data);
};

const safeObserve = (fn: () => void): void => {
  // ⛔ 관측 자체가 던져도 턴을 깨지 않는다 — 그러면 fail-soft 가 무의미해진다.
  try { fn(); } catch { /* 관측은 마지막 방어선이다 */ }
};

const errorReason = (err: unknown): string =>
  err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);

function observeFailureOf(
  sessionId: string,
  call: { readonly tool: string; readonly id: string },
  reason: string,
  observeFailure: FailureObserver | undefined,
): void {
  const observe = observeFailure
    ?? ((info) => { debug.log('acp.tool', 'trace-persist-failed', info); });
  safeObserve(() => observe({ sessionId, tool: call.tool, id: call.id, reason }));
}

/** 붙잡아 둔 흔적을 원래 순서대로 붙인다. 세션이 여전히 없으면 그대로 둔다(`'missing'`). */
function flushPending(sessionId: string): 'missing' | 'flushed' | 'none' {
  const p = pendingBySession.get(sessionId);
  if (!p) return 'none';
  let flushed = 0;
  let failed = 0;
  while (p.entries.length > 0) {
    const entry = p.entries[0]!;
    try {
      entry.append(sessionId, entry.msg);
      flushed += 1;
    } catch (err) {
      const reason = errorReason(err);
      // ⛔ 회수 «도중» 세션이 사라져도(이미 몇 행을 붙인 뒤라도) 그 행과 나머지는 «지연» 그대로 둔다 — 실패가 아니다.
      if (SESSION_NOT_FOUND.test(reason)) {
        // ⭐ 그때까지 붙인 행 수는 «지금» 남긴다 — 다음 회수 보고는 그 뒤의 행만 센다.
        if (flushed > 0 || failed > 0) {
          safeObserve(() => p.observe('trace-persist-flushed', { sessionId, flushed, failed, partial: true }));
        }
        return 'missing';
      }
      failed += 1;
      // ⛔ 회수 중 실패도 «같은» `trace-persist-failed` 로 — `flushed.failed` 합계에만 묻으면 실패가 안 보인다.
      observeFailureOf(sessionId, { tool: entry.tool, id: entry.id }, reason, entry.observeFailure);
    }
    p.entries.shift();
  }
  pendingBySession.delete(sessionId);
  safeObserve(() => p.observe('trace-persist-flushed', { sessionId, flushed, failed }));
  if (pendingBySession.size === 0 && unsubscribeCreated) {
    const off = unsubscribeCreated;
    unsubscribeCreated = null;
    try { off(); } catch { /* 구독 해제 실패는 무해 — 다음 지연이 다시 건다 */ }
  }
  return 'flushed';
}

function deferTrace(
  sessionId: string,
  call: { readonly id: string; readonly name: string },
  append: AppendFn,
  msg: TraceMessage,
  reason: string,
  deps: AcpToolTraceDeps,
): void {
  let p = pendingBySession.get(sessionId);
  if (!p) {
    if (pendingBySession.size >= MAX_PENDING_SESSIONS) {
      // 가장 오래 기다린 세션부터 버린다 — 원장에 영영 안 생긴 세션(턴 도중 종료)이 쌓이지 않게.
      const [oldestId, oldest] = pendingBySession.entries().next().value as [string, PendingSession];
      pendingBySession.delete(oldestId);
      safeObserve(() => oldest.observe('trace-persist-dropped', { sessionId: oldestId, reason: 'pending-session-cap' }));
    }
    p = { entries: [], capped: false, observe: deps.observe ?? defaultObserve };
    pendingBySession.set(sessionId, p);
    // ⭐ 경고는 세션당 «한 번» — 호출마다 같은 줄을 찍던 것이 결함 #64 의 다른 반쪽이다.
    safeObserve(() => p!.observe('trace-persist-deferred', { sessionId, tool: call.name, id: call.id, reason }));
  }
  if (p.entries.length < MAX_PENDING_PER_SESSION) {
    p.entries.push({ append, msg, tool: call.name, id: call.id, observeFailure: deps.observeFailure });
  } else if (!p.capped) {
    p.capped = true;
    safeObserve(() => p!.observe('trace-persist-dropped', {
      sessionId, tool: call.name, id: call.id, reason: 'pending-per-session-cap',
    }));
  }
  if (!unsubscribeCreated) {
    const subscribe = deps.subscribeSessionCreated ?? onSessionCreated;
    try {
      unsubscribeCreated = subscribe((meta) => {
        if (!pendingBySession.has(meta.id)) return;
        // ⭐ 채택 «직후» 같은 동기 구간에서 user/assistant 가 이어 붙는다(`persistCompletedTuiAcpTurn`).
        //   마이크로태스크로 미뤄 그 뒤에 붙인다 — 그래야 「마지막 user 뒤의 tool 행」(다음 턴 관찰)이 산다.
        queueMicrotask(() => { try { flushPending(meta.id); } catch { /* fail-soft */ } });
      });
    } catch { unsubscribeCreated = null; }
  }
}

/** 시험 전용 — 모듈 상태(지연 큐·구독)를 비운다. */
export function _resetAcpToolTraceStateForTest(): void {
  pendingBySession.clear();
  if (unsubscribeCreated) { try { unsubscribeCreated(); } catch { /* 무해 */ } }
  unsubscribeCreated = null;
}

/** 시험·관측용 — 세션별로 붙잡아 둔 흔적 수. */
export function pendingAcpToolTraceCount(sessionId: string): number {
  return pendingBySession.get(sessionId)?.entries.length ?? 0;
}

/** 한 번의 툴 호출을 감사 기록으로 남긴다.
 *
 *  ⛔ **fail-soft** — 저장이 실패해도 던지지 않는다. 사람이 보는 화면이 감사 기록보다 앞선다
 *    (`session/chat.ts` 가 세운 규율).
 *  ⚠️ **그러나 «조용히 삼키지 않는다»** — 실패하면 이름을 대고 관측에 남긴다.
 *    ***조용한 실패야말로 16차가 내내 잡던 형태고, 이 PR 초판이 또 만들었다.***
 *  ⭐ 「세션이 아직 원장에 없다」면 지연 기록한다(위 `MAX_PENDING_*` 주석) — 이때도 `false` 다.
 *
 *  @returns 지금 저장에 «성공»했으면 `true`. ⛔ 「안 했다」와 「했는데 실패했다」·「미뤘다」는 다른 값이다. */
export function persistAcpToolTrace(
  sessionId: string,
  call: { readonly id: string; readonly name: string; readonly result?: unknown },
  args: unknown,
  deps: AcpToolTraceDeps = {},
): boolean {
  const append = deps.append ?? appendMessage;
  // ⛔ 모양은 «공유 빌더»가 만든다 — 여기서 손으로 조립하지 않는다(계약을 두 벌로 두지 않는다).
  const build = deps.buildMessage ?? buildToolTraceMessage;
  try {
    const msg = build(call.name, args, call.result);
    // 앞서 미뤄 둔 흔적이 있으면 먼저 붙인다(순서 보존). 여전히 세션이 없으면 이것도 뒤에 줄 세운다.
    if (pendingBySession.has(sessionId) && flushPending(sessionId) === 'missing') {
      deferTrace(sessionId, call, append, msg, 'session not found (pending)', deps);
      return false;
    }
    try {
      append(sessionId, msg);
      return true;
    } catch (err) {
      const reason = errorReason(err);
      if (SESSION_NOT_FOUND.test(reason)) {
        deferTrace(sessionId, call, append, msg, reason, deps);
        return false;
      }
      throw err;
    }
  } catch (err) {
    observeFailureOf(sessionId, { tool: call.name, id: call.id }, errorReason(err), deps.observeFailure);
    return false;
  }
}
