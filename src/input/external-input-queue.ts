// ── 외부 주입 입력의 별도 대기열 (TUI OP 도그푸드 결함 #6 · 2026-10-14) ──────────────
//
// S: 바깥 프로세스가 `elanous pty text <tui:pid> "<글>" --enter` 로 넣은 입력은 TUI 제어 대상의
//    `write()` → `injectKey` 로 «키보드와 같은» 키 큐에 들어간다.
// C: 그래서 사용자가 치던 composer 버퍼·턴 중 typeahead 버퍼에 글자가 «이어 붙는다»
//    (10-14 13:37 실측: 사용자가 치던 줄 끝에 외부 지시가 붙어 한 메시지로 나갔다).
// A: 제어 대상의 `write()` 가 키 주입 «전»에 이 라우터를 먼저 묻는다.
//    - 글 한 줄(제어 문자 없음 · 끝 CR 하나 허용)이 아니면 → 종전대로 키 주입(`pty key`·메뉴 몰기 무변경)
//    - composer 가 안 떠 있음(턴 밖 패널·모달 모드) → 종전대로 키 주입(드라이버 회귀 방지)
//    - Enter 가 붙은 글: 턴 중 · 사용자 버퍼에 글자가 있음 · 앞선 외부 항목이 대기 중 → «별도 항목»으로 대기열,
//      composer 가 비어 있으면 출처(`terminal`/`pty`)를 단 «별도 제출»로 즉시 보냄
//    - Enter 없는 글: 빈 composer 면 종전대로 채우고, 바쁘면(턴 중·버퍼에 글자) «거부»한다 —
//      나중에 사용자 composer 에 채우면 다시 섞이므로 대기시키지 않는다(IPC 가 실패로 정산 → rc≠0).
//    대기열은 «턴이 끝나고 composer 가 비었을 때» 한 건씩 나간다 — 사용자 버퍼는 건드리지 않는다.
//    - ⏹ 정확히 `/stop`·`/esc` 인 글(TUI-STOP-INPUT-BYPASS · #68): 대기열을 «건너뛰고» 지금 턴의 ESC 중단 경로
//      (`requestStop` → 대시보드 escGate)를 바로 부른다. 대기 중인 일반 항목은 그대로·순서대로 남는다.
//      턴이 없으면 아무것도 안 하고 `tui-stop-no-active-turn`(멈출 길이 없으면 `tui-stop-undelivered`)으로 던져 바깥 호출자(rc≠0)에게 알린다.
//    - ⏹ 원시 pty 길(TUI-STOP-RAW-PTY): `pty text pty_<id> /stop --enter`·tmux 처럼 TUI 를 띄운 «PTY 자체»에 쓰면
//      이 라우터를 안 지나 stdin 으로 들어오고, 턴 중 typeahead 가 «대기(응답 뒤)»에 쌓았다(10-17 재점검).
//      ⇒ 턴 중 스트리밍 리스너가 stdin «한 청크»가 정확히 `/stop⏎`·`/esc⏎` 이면 `routeRawPtyStop` 으로 같은 `routeStop` 을 부른다.
//      키보드는 한 키씩 오고 붙여넣기는 봉투에 싸이므로, 한 청크에 온 «글 한 줄 ⊕ Enter» 는 바깥 주입이다.
//      턴 밖·Enter 없음·그 밖의 글은 종전대로 키로 흐른다(관측 `path: 'raw-pty'` · 제어 IPC 는 `'control-ipc'`).
//
// ⚠️ herdr/tmux 처럼 «터미널 자체»에 쓰는 길은 키보드와 구별할 수 없다 — 이 라우터는
//    elanous 제어 IPC(`pty text`) 경로만 가른다.

import { debug } from '../debug/log.js';
import type { InputSourceRef } from './input-source-kind.js';

export interface ExternalInputItem {
  readonly text: string;
  readonly at: number;
}

export interface ExternalInputHost {
  /** 턴(스트리밍)이 도는 중인가. */
  isTurnActive(): boolean;
  /** 살아 있는 composer 의 현재 버퍼. composer 가 안 떠 있으면 undefined. */
  composerText(): string | undefined;
  /** 아직 소비되지 않은 키가 키 큐에 있나 — 있으면 composer 가 비어 보여도 사용자 키가 오는 중이다. */
  hasPendingKeys(): boolean;
  /** 별도 메시지로 제출한다. 못 보냈으면 false(항목은 대기열에 남는다). */
  submit(text: string, source: InputSourceRef): boolean;
  /** 지금 턴을 ESC 와 같은 경로로 멈춘다. 멈출 턴(escGate)이 없으면 false. 없으면 외부 stop 은 «턴 없음»으로 처리. */
  requestStop?(): boolean;
  /** Consume submitted external text as the answer to a live non-modal TUI question. */
  handleInlineChoice?(text: string): boolean;
  /** 외부 stop 의 결과 표지(채팅 로그 한 줄). */
  onExternalStop?(result: 'stopped' | 'no-turn' | 'failed'): void;
  /** 대기열의 현재 상태가 바뀌었다 — 화면 표지를 다시 그린다. */
  onQueueChange?(pending: readonly ExternalInputItem[]): void;
}

export type ExternalInputRoute = 'passthrough' | 'submitted' | 'queued' | 'stopped';
/** 외부 stop 이 들어온 길 — 제어 IPC(`tui:<pid>` · 이 라우터) / 원시 pty(stdin 한 청크). */
export type ExternalStopPath = 'control-ipc' | 'raw-pty';
export type ExternalInputDecision = 'passthrough' | 'submit-now' | 'queue' | 'reject';

const EXTERNAL_INPUT_SOURCE: InputSourceRef = { kind: 'terminal', provider: 'pty' };
export const EXTERNAL_INPUT_QUEUE_LIMIT = 50;
const PUMP_MS = 250;
/** 머리 항목이 turn-active 때문에 이만큼 못 나가면 한 번만 경고한다. 자동 해제는 하지 않는다. */
export const STALE_TURN_SUSPECTED_MS = 10 * 60 * 1000;

/** 글 한 줄인가 — 제어 문자 없음 · 끝 CR 하나만 허용. 아니면 null(키 주입 경로). */
export function parseExternalTextLine(chars: string): { text: string; submit: boolean } | null {
  const submit = chars.endsWith('\r');
  const text = submit ? chars.slice(0, -1) : chars;
  // ⚠️ 공백만 있는 글도 «글»이다 — trim 하면 대기열을 우회해 사용자 초안에 붙는다.
  if (!text) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(text)) return null;
  return { text, submit };
}

/** 외부 «멈춰» 명령인가 — 정확히 `/stop` 또는 `/esc`(앞뒤 공백·대소문자 변형은 일반 글). */
export function isExternalStopCommand(text: string): boolean {
  return text === '/stop' || text === '/esc';
}

/** 라우팅 판정(순수). */
export function decideExternalInputRoute(input: {
  line: { text: string; submit: boolean } | null;
  hostRegistered: boolean;
  pendingCount: number;
  turnActive: boolean;
  composerText: string | undefined;
  pendingKeys?: boolean;
}): { decision: ExternalInputDecision; reason: string } {
  if (!input.line) return { decision: 'passthrough', reason: 'not-text-line' };
  if (!input.hostRegistered) return { decision: 'passthrough', reason: 'no-host' };
  // 턴 밖에서 composer 가 안 떠 있으면(패널·모달) 그 화면을 모는 키 입력이다 — 종전 경로.
  if (!input.turnActive && input.composerText === undefined) return { decision: 'passthrough', reason: 'composer-not-live' };
  const busyReason = input.turnActive ? 'turn-active'
    // ⚠️ 공백만 있는 초안도 사용자 버퍼다 — trim 하지 않는다.
    : input.composerText !== '' ? 'user-buffer-nonempty'
    // composer 가 비어 보여도 키 큐에 사용자 키가 남아 있으면 그 키가 먼저다.
    : input.pendingKeys ? 'user-keys-pending'
    // FIFO — 앞선 외부 항목을 뒤 항목이 앞지르지 않는다.
    : input.pendingCount > 0 ? 'queue-nonempty'
    : null;
  if (!input.line.submit) {
    return busyReason ? { decision: 'reject', reason: `${busyReason}-no-enter` } : { decision: 'passthrough', reason: 'idle-empty-no-enter' };
  }
  return busyReason ? { decision: 'queue', reason: busyReason } : { decision: 'submit-now', reason: 'idle-empty' };
}

/** 대기열 머리를 지금 내보내도 되나(순수) — 턴 밖 ⊕ composer 가 떠 있고 비어 있음. */
function canDeliverExternalInput(turnActive: boolean, composerText: string | undefined, pendingKeys: boolean): boolean {
  return !turnActive && composerText === '' && !pendingKeys;
}

/** «외부 입력 N건 대기» 표지 문면. 비면 null. */
export function renderExternalInputQueueNotice(pending: readonly ExternalInputItem[]): string | null {
  if (pending.length === 0) return null;
  const head = pending[0]!.text;
  const shown = [...head].length > 40 ? `${[...head].slice(0, 40).join('')}…` : head;
  return `⤵ 외부 입력 ${pending.length}건 대기 · "${shown}" · 턴이 끝나고 입력창이 비면 별도 메시지로 전송`;
}

export interface ExternalInputQueueDeps {
  now?: () => number;
  /** 펌프 스케줄러 — 정지 함수를 돌려준다. 시험이 손으로 돌린다. */
  schedule?: (tick: () => void, ms: number) => () => void;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** 외부 stop 관측 — 기본 `debug.log('tui.input', …)`. */
  logInput?: (event: string, data: Record<string, unknown>) => void;
}

export function createExternalInputQueue(deps: ExternalInputQueueDeps = {}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((event, data) => debug.log('tui.external-input', event, data));
  const logInput = deps.logInput ?? ((event, data) => debug.log('tui.input', event, data));
  const schedule = deps.schedule ?? ((tick, ms) => {
    const t = setInterval(tick, ms);
    (t as { unref?: () => void }).unref?.();
    return () => clearInterval(t);
  });
  let host: ExternalInputHost | null = null;
  let pending: ExternalInputItem[] = [];
  let stopPump: (() => void) | null = null;
  // 경고는 머리 항목 «하나»에 한 번 — 머리가 실제로 바뀔 때만 다시 경고할 수 있다(제출 실패로 남은 같은 머리는 유지).
  let staleTurnWarnedHead: ExternalInputItem | null = null;

  const notify = (): void => {
    try { host?.onQueueChange?.(pending); } catch { /* fail-soft — 표지 실패가 입력을 막지 않는다 */ }
  };
  const ensurePump = (): void => {
    if (pending.length > 0 && !stopPump) stopPump = schedule(pump, PUMP_MS);
    if (pending.length === 0 && stopPump) { stopPump(); stopPump = null; }
  };

  /** 대기열 머리 한 건을 내보낸다(조건이 맞을 때만). 내보냈으면 true. */
  function pump(): boolean {
    const h = host;
    const head = pending[0];
    if (!h || !head) { ensurePump(); return false; }
    let turnActive: boolean; let composer: string | undefined; let pendingKeys: boolean;
    try { turnActive = h.isTurnActive(); composer = h.composerText(); pendingKeys = h.hasPendingKeys(); } catch { return false; }
    if (!canDeliverExternalInput(turnActive, composer, pendingKeys)) {
      if (turnActive && staleTurnWarnedHead !== head) {
        const waitedMs = now() - head.at;
        if (waitedMs >= STALE_TURN_SUSPECTED_MS) {
          staleTurnWarnedHead = head;
          log('stale-turn-suspected', { waitedMs, pending: pending.length });
        }
      }
      return false;
    }
    let ok = false;
    try { ok = h.submit(head.text, EXTERNAL_INPUT_SOURCE); } catch { ok = false; }
    if (!ok) { log('deliver-failed', { length: head.text.length, pending: pending.length }); return false; }
    pending = pending.slice(1);
    log('delivered', { length: head.text.length, waitedMs: now() - head.at, pending: pending.length });
    notify();
    ensurePump();
    return true;
  }

  /** ⏹ 외부 stop — 대기열을 건너뛰고 지금 턴의 escGate 로. 대기열은 건드리지 않는다. */
  function routeStop(h: ExternalInputHost, text: string, path: ExternalStopPath): ExternalInputRoute {
    let turnActive = false;
    try { turnActive = h.isTurnActive(); } catch { turnActive = false; }
    let stopped = false;
    if (turnActive && h.requestStop) {
      try { stopped = h.requestStop(); } catch { stopped = false; }
    }
    logInput('external-stop', { hadTurn: turnActive, stopped, command: text, pending: pending.length, path });
    const result = stopped ? 'stopped' : turnActive ? 'failed' : 'no-turn';
    try { h.onExternalStop?.(result); } catch { /* fail-soft */ }
    if (result === 'no-turn') throw new Error('tui-stop-no-active-turn');
    if (result === 'failed') throw new Error('tui-stop-undelivered');
    return 'stopped';
  }

  return {
    register(next: ExternalInputHost): () => void {
      host = next;
      log('host-registered', { pending: pending.length });
      ensurePump();
      if (pending.length > 0) notify();
      return () => {
        if (host !== next) return;
        host = null;
        log('host-unregistered', { pending: pending.length });
      };
    },
    /** 제어 대상 `write()` 가 키 주입 «전»에 부른다. 'passthrough' 면 호출측이 종전대로 키를 넣는다. */
    route(chars: string): ExternalInputRoute {
      // `pty key`(input-key)는 «키»다 — 공백·`j` 처럼 출력 가능한 키도 종전대로 넣는다.
      if (keyCommandDepth > 0) return 'passthrough';
      const line = parseExternalTextLine(chars);
      if (line && host && isExternalStopCommand(line.text)) return routeStop(host, line.text, 'control-ipc');
      let turnActive = false; let composer: string | undefined; let pendingKeys = false;
      if (host && line) {
        try { turnActive = host.isTurnActive(); composer = host.composerText(); pendingKeys = host.hasPendingKeys(); }
        catch { return 'passthrough'; }
      }
      if (line?.submit && host?.handleInlineChoice) {
        let consumed = false;
        try { consumed = host.handleInlineChoice(line.text); } catch { consumed = false; }
        if (consumed) {
          log('route', { length: chars.length, submit: true, turnActive, route: 'inline-choice', pending: pending.length });
          return 'submitted';
        }
      }
      const { decision, reason } = decideExternalInputRoute({
        line, hostRegistered: host !== null, pendingCount: pending.length, turnActive, composerText: composer, pendingKeys,
      });
      const base = { reason, length: chars.length, submit: line?.submit ?? false, turnActive, pendingKeys, userBufferLength: composer?.length ?? null };
      if (decision === 'passthrough') {
        log('route', { ...base, route: 'passthrough', pending: pending.length });
        return 'passthrough';
      }
      if (decision === 'reject') {
        log('route', { ...base, route: 'rejected', pending: pending.length });
        throw new Error('tui-busy-text-without-enter');
      }
      if (decision === 'submit-now' && line && host) {
        let ok = false;
        try { ok = host.submit(line.text, EXTERNAL_INPUT_SOURCE); } catch { ok = false; }
        if (ok) { log('route', { ...base, route: 'submitted', pending: pending.length }); return 'submitted'; }
      }
      if (pending.length >= EXTERNAL_INPUT_QUEUE_LIMIT) {
        log('queue-full', { ...base, pending: pending.length });
        throw new Error('tui-external-input-queue-full');
      }
      pending = [...pending, { text: line!.text, at: now() }];
      log('route', { ...base, route: 'queued', pending: pending.length });
      notify();
      ensurePump();
      return 'queued';
    },
    /**
     * ⏹ 원시 pty 길 — 턴 중 stdin «한 청크»가 정확히 `/stop⏎`·`/esc⏎` 이면 `routeStop` 으로 보내고 true(키로 흘리지 않는다).
     * 턴 밖·호스트 없음·Enter 없음·그 밖의 글은 false — 호출측이 종전대로 키를 넣는다.
     */
    routeRawStop(chunk: string): boolean {
      const h = host;
      if (!h) return false;
      const line = parseExternalTextLine(chunk);
      if (!line?.submit || !isExternalStopCommand(line.text)) return false;
      let turnActive = false;
      try { turnActive = h.isTurnActive(); } catch { turnActive = false; }
      if (!turnActive) return false;
      // 'failed'(중단 경로 없음)도 소비한다 — 표지(Esc 로 멈춰 주세요)는 routeStop 이 이미 남겼다.
      try { routeStop(h, line.text, 'raw-pty'); } catch { /* 결과는 이벤트·표지로 남았다 */ }
      return true;
    },
    pump,
    pending: (): readonly ExternalInputItem[] => pending,
  };
}

let keyCommandDepth = 0;
/** 제어 IPC 의 `input-key` 가 이 안에서 쓴다 — 라우터는 그 쓰기를 글이 아니라 키로 보고 그대로 통과시킨다. */
export function withExternalKeyCommand<T>(fn: () => T): T {
  keyCommandDepth++;
  try { return fn(); } finally { keyCommandDepth--; }
}

const shared = createExternalInputQueue();

export function registerExternalInputHost(host: ExternalInputHost): () => void { return shared.register(host); }
export function routeExternalInput(chars: string): ExternalInputRoute { return shared.route(chars); }
export function routeRawPtyStop(chunk: string): boolean { return shared.routeRawStop(chunk); }
