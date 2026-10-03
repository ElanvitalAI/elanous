'use client';

// WT-S-1 — read-only xterm.js view wired to a daemon-side
// PreviewTerminal via the ACP `agent_thought_chunk` channel + the
// `elanous/term/*` envelope. Input writeback / mouse / spawn arrive in
// later slices (WT-A).
//
// The component owns the xterm.js Terminal lifecycle and one ACP
// connection per (sessionId, terminalId) pair. The ACP connection
// auto-handshakes on open via DaemonClient.connectAcp() — see
// daemon-client.ts AcpConnectionImpl.
//
// Wire shape (incoming):
//   { method: 'session/update', params: { sessionId, update: {
//       sessionUpdate: 'agent_thought_chunk',
//       content: { type: 'text', text: '<ElanousTermEnvelope>' } } } }

import { useEffect, useRef, useState } from 'react';
// We intentionally exclude `sessionId` from the effect deps so the
// auto-handshake socket isn't torn down when the daemon-issued
// sessionId propagates back into DaemonProvider — that propagation is
// the *result* of this connection, not a trigger to reconnect.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';

import { useDaemon } from '@/components/providers/DaemonProvider';
import { debugLog } from '@/lib/debug';
import { parseElanousTermEnvelope } from '@/lib/elanous-term-envelope';
import { getPeerId } from '@/lib/peer-id';
import {
  loadSnapshot,
  saveSnapshot,
  snapshotKey,
} from '@/lib/snapshot';
import { ACP_AUTH_HOWTO, ACP_AUTH_MESSAGE, classifyAcpFailure, reconnectDelayMs } from './acp-failure';
import { dispatchTouchWheel, touchScrollAction, touchScrollLines, touchWheelLines } from './touch-scroll';
import { createXtermResizeController } from '@/lib/xterm-resize-controller';
import { isXtermCapabilityResponse } from '@/lib/xterm-capability-filter';
import { createTerminalInputSender } from './terminal-input-sender';
import { registerTerminalInput } from './terminal-input-registry';
import { shouldClear } from './terminal-clear';
import { clampFontSize, fontStepKey, isFocusToggleKey, readTermFocusStartDisabled, readTermFontSize, writeTermFocusStartDisabled, writeTermFontSize } from '@/lib/term-focus';
import { useCompactMode } from '@/lib/compact-mode';

interface Props {
  sessionId: string;
  terminalId: string;
  clearRequest?: number;
  /** Default false at WT-A-2a — keyboard input flows back to PTY via
   *  ACP `terminal/input`. Pass `readOnly={true}` for view-only modes
   *  (e.g. multi-device viewer that shouldn't compete on stdin). */
  readOnly?: boolean;
  /** WT-M-1 — fires when another peer (peerId !== ours) sends input
   *  to this terminal. Caller can debounce + flash a small badge.
   *  `bytes` is a coarse intensity hint. */
  onForeignInputActivity?: (info: { peerId: string; bytes: number; timestamp: number }) => void;
}

/** 새 셸의 «첫 출력»을 기다리는 입력 관문의 상한(ms). */
export const SHELL_READY_CAP_MS = 2_000;

export function XtermView({ sessionId, terminalId, clearRequest = 0, readOnly = false, onForeignInputActivity }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // TERM2 집중 모드 — 터미널 표면이 화면 전체를 덮는다(사이드바·머리 줄·독·칩을 하나씩 숨기지 않는다).
  const hostRef = useRef<HTMLDivElement>(null);
  const { compact } = useCompactMode();
  const [focusMode, setFocusMode] = useState(false);
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const initialFocusChecked = useRef(false);
  useEffect(() => {
    if (initialFocusChecked.current || !compact) return;
    initialFocusChecked.current = true;
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      let storage: Storage | null = null;
      try { storage = window.localStorage; } catch { /* Default to focus mode when storage is unavailable. */ }
      if (!readTermFocusStartDisabled(storage)) { focusModeRef.current = true; setFocusMode(true); }
    }
  }, [compact]);
  const toggleFocusMode = () => {
    const wasFocused = focusModeRef.current;
    focusModeRef.current = !wasFocused;
    if (wasFocused) {
      try { writeTermFocusStartDisabled(window.localStorage); } catch { /* The exit still applies. */ }
    }
    setFocusMode(!wasFocused);
  };
  const previousClearRequestRef = useRef<number | undefined>(undefined);
  const clearTerminalIdRef = useRef(terminalId);
  if (clearTerminalIdRef.current !== terminalId) {
    clearTerminalIdRef.current = terminalId;
    previousClearRequestRef.current = undefined;
  }
  // The ACP handshake, not the shared provider prop, owns this view's session.
  // Other consumers can update the provider with a different connection's id.
  const sessionIdRef = useRef(sessionId);

  // WT-M-1 — keep the latest callback in a ref so the effect closure
  // doesn't go stale when the parent re-creates the function. The
  // effect intentionally excludes this from deps (re-running it would
  // tear down + re-spawn the PTY, which is not what changing a UI
  // callback should do).
  const onForeignInputActivityRef = useRef(onForeignInputActivity);
  onForeignInputActivityRef.current = onForeignInputActivity;

  const { client, config, setSessionId } = useDaemon();
  const [acpStatus, setAcpStatus] = useState<{
    state: 'CONNECTING' | 'OPEN' | 'FAILED' | 'CLOSED';
    terminalId: string;
    connectingSince: number;
    /** 닫힘·실패 사유(서버 close reason 포함). */
    reason?: string;
  }>(() => ({ state: 'CONNECTING', terminalId, connectingSince: Date.now() }));
  // 끊기면 다시 붙는다 — 데몬 재시작 뒤 FAILED/CLOSED 에 멈춰 있던 것(대표 2026-09-28). 값이 바뀌면 연결을 새로 연다.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const reconnectAttemptRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const [inputError, setInputError] = useState<{ terminalId: string; dropped: number } | null>(null);
  const visibleInputError = inputError?.terminalId === terminalId ? inputError : null;
  const acpState = acpStatus.terminalId === terminalId ? acpStatus.state : 'CONNECTING';
  const connectingSince = acpStatus.terminalId === terminalId ? acpStatus.connectingSince : now;

  useEffect(() => {
    if (acpState !== 'CONNECTING') return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [acpState, terminalId]);

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      // Bundled via apps/pwa/public/fonts/ + @font-face in globals.css.
      // Falls back to system JetBrains Mono / monospace if bundle is
      // mid-loading — `font-display: swap` makes the swap-in seamless.
      fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", monospace',
      fontSize: readTermFontSize(typeof window === 'undefined' ? null : window.localStorage),
      theme: {
        background: '#0d0c08',
        foreground: '#e9e3d4',
        cursor: '#e9e3d4',
      },
      allowProposedApi: true,
      scrollback: 5000,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
    });
    debugLog('webterm.xterm.boot', { sessionId, terminalId, readOnly });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_evt, uri) => debugLog('webterm.link.click', { uri })),
    );
    term.loadAddon(new Unicode11Addon());
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);

    // WebGL renderer is best-effort — Safari/iOS Safari may decline.
    // The default canvas renderer is always available as fallback.
    void (async () => {
      try {
        const mod = await import('@xterm/addon-webgl');
        term.loadAddon(new mod.WebglAddon());
      } catch (e) {
        debugLog('webterm.webgl.fallback', { reason: String(e) });
      }
    })();

    // Inline image rendering — sixel + iTerm2 inline image protocol.
    // Lets the user run `imgcat`, `chafa -f sixel`, `viu -1`, etc. and
    // see the image directly in the web terminal. Note that ghostty's
    // native image display uses the kitty graphics protocol (KGP) which
    // xterm.js doesn't implement — so a literal `kitten icat` won't
    // render. Users coming from ghostty: substitute imgcat / chafa.
    void (async () => {
      try {
        const mod = await import('@xterm/addon-image');
        term.loadAddon(new mod.ImageAddon());
        debugLog('webterm.image-addon.loaded');
      } catch (e) {
        debugLog('webterm.image-addon.fallback', { reason: String(e) });
      }
    })();

    term.unicode.activeVersion = '11';
    term.open(ref.current);
    termRef.current = term;
    // Read-only CDP scenario hook: inspect the rendered xterm buffer, not daemon replay or DOM canvas text.
    const screenHost = hostRef.current as (HTMLDivElement & { __elanousTerm?: Terminal }) | null;
    if (screenHost) screenHost.__elanousTerm = term;
    fit.fit();

    // BACKLOG #3 — restore prior scrollback before the daemon streams
    // fresh frames. SerializeAddon emits a single string of ANSI bytes
    // (cursor pos · attributes · cells) that `term.write` replays
    // verbatim. We restore *before* attaching the live PTY so any new
    // frame appends naturally. If the daemon performs a screen clear on
    // attach (`\x1b[2J` etc.) the snapshot is overwritten, which is
    // exactly what users want.
    const scrollbackKey = snapshotKey('xtermScrollback', terminalId);
    const restored = loadSnapshot<string>(scrollbackKey);
    if (typeof restored === 'string' && restored.length > 0) {
      term.write(restored);
    }

    // WT-S-1.5 — connectAcp() now auto-handshakes (initialize +
    // session/new). The daemon-issued sessionId comes back via the
    // onSession callback; we sync it into DaemonProvider so chat /
    // intake / control surfaces share the same session.
    let confirmInputSession: (sid: string) => void = () => {};
    let sessionAnnounced = false;
    const acp = client.connectAcp({
      ...(sessionId ? { sessionId } : {}),
      onSession: (sid) => {
        if (sid) {
          sessionAnnounced = true;
          sessionIdRef.current = sid;
          confirmInputSession(sid);
        }
        if (sid && sid !== sessionId) {
          debugLog('webterm.acp.session.adopted', { from: sessionId, to: sid });
          setSessionId(sid);
        }
      },
    });
    debugLog('webterm.acp.session.attach', { sessionId, terminalId });
    const offState = acp.onState((state, error) => {
      const observedAt = Date.now();
      setAcpStatus((current) => ({
        state,
        terminalId,
        connectingSince: state === 'CONNECTING' ? observedAt : current.connectingSince,
        ...(error?.message ? { reason: error.message } : {}),
      }));
      if (state === 'OPEN') reconnectAttemptRef.current = 0;
      if (state === 'CONNECTING') setNow(observedAt);
      debugLog('webterm.xterm.acp-state', { terminalId, state, reason: error?.message });
    });

    // WT-A-1b — auto-spawn on first mount. Without this, PWA-only
    // dogfood (no dashboard TUI in the daemon process) has no
    // PreviewTerminal instance to attach to and the screen stays blank.
    // Idempotent on the daemon side: re-mount returns `status:'attached'`.
    // 셸 준비 관문 — 입력은 이게 열릴 때까지 모인다(terminal-input-sender `shellReady`).
    //   붙은(attached) 셸은 바로 · 새로 뜬(spawned) 셸은 첫 출력(프롬프트)에서 · 그래도 20초면 연다 · 실패면 연다(오류 표시는 기존대로).
    let openShell: (via: string) => void = () => {};
    let waitingFirstOutput = false;
    const shellWaitStart = Date.now();
    const shellReady = new Promise<void>((resolve) => {
      let opened = false;
      openShell = (via) => { if (opened) return; opened = true; debugLog('webterm.shell.ready', { terminalId, via, ms: Date.now() - shellWaitStart }); resolve(); };
    });
    // TERM4 — 상한 20초 → 2초(대표 10-02 11:5x 폴드8 «바로 안 뜨고 키가 안 먹는다»). 운영 실측: 새 터미널의 관문이
    //   매번 `cap-20s`(20.0~20.6초)로만 열렸다 — 프롬프트가 붙기 «전»에 이미 찍혀 «첫 출력»이 다시 오지 않는다.
    //   셸은 프롬프트 전 입력도 버퍼에 받으므로 짧게 열어도 글자를 잃지 않는다.
    const shellCap = setTimeout(() => openShell(`cap-${SHELL_READY_CAP_MS}ms`), SHELL_READY_CAP_MS);
    void acp.ready.then((daemonSid) => {
      if (!daemonSid) { openShell('no-session'); return; } // handshake failed — silent
      // A shared ACP transport can already be ready before this view subscribes.
      // Its ready id is a fallback only: a newer onSession announcement wins.
      if (!sessionAnnounced) sessionIdRef.current = daemonSid;
      // The sender's ready listener runs after this callback; confirm once it
      // has recorded readySessionId, without reverting a newer onSession id.
      queueMicrotask(() => confirmInputSession(sessionIdRef.current));
      return acp.send('terminal/spawn', {
        sessionId: sessionIdRef.current,
        terminalId,
        cols: term.cols,
        rows: term.rows,
        // P4 — 재attach 시 데몬측 현재 뷰포트 스냅샷 요청. 끊김-중 출력이
        // 로컬 scrollback(localStorage) 에 없어도 현재 화면은 복원.
        replay: true,
      });
    }).then((res) => {
      if (res === undefined) return;
      debugLog('webterm.spawn.result', res);
      const r = res as { status?: string; snapshot?: string };
      // 새 탭은 TerminalTabs 가 먼저 만들고 여기서는 «붙는다»(attached) — 그래서 attached 라도 화면이 아직 비어 있으면
      // (프롬프트 전) 새 셸과 같이 첫 출력을 기다린다(09-28 격리 실측: 새 탭이 attached 로 84ms 에 관문을 열었다).
      const blank = typeof r.snapshot !== 'string' || r.snapshot.trim().length === 0;
      if (r.status === 'spawned' || (r.status === 'attached' && blank)) waitingFirstOutput = true;
      else openShell(r.status === 'attached' ? 'attached' : `status:${String(r.status)}`);
      // 크기 동기 — 데몬의 attach 경로는 spawn 의 cols/rows 를 무시하고, fit() 은 onResize 구독 «전»에
      // 돌았으므로 그 뒤 그리드가 안 바뀌면 resize 가 한 번도 안 간다. 그러면 PTY 는 80×24 로 남고
      // 셸이 80칸에서 접어 넓은 xterm 위 프롬프트·긴 명령이 깨진다(2026-09-28 실측 stty 24 80 ↔ 139칸).
      // ⇒ 붙은 직후 지금 격자를 명시로 한 번 보낸다(읽기 전용은 크기 주인이 아니다).
      if (!readOnly && sessionIdRef.current) {
        try { fit.fit(); } catch { /* dimensions not ready yet */ }
        debugLog('webterm.xterm.size-sync', { terminalId, cols: term.cols, rows: term.rows, status: r.status });
        void acp
          .send('terminal/resize', { sessionId: sessionIdRef.current, terminalId, cols: term.cols, rows: term.rows })
          .catch((e) => debugLog('webterm.resize.send-error', { reason: String(e) }));
      }
      if (r.status === 'attached' && typeof r.snapshot === 'string' && r.snapshot.length > 0) {
        // 화면만 지우고(ESC[2J — scrollback 보존) 데몬이 상주 보유한 현재
        // 뷰포트로 동기화. 로컬 복원 snapshot 보다 항상 최신이므로 우선.
        debugLog('webterm.attach.replay', { terminalId, bytes: r.snapshot.length });
        term.write('\x1b[2J\x1b[H' + r.snapshot.split('\n').join('\r\n') + '\r\n');
      }
    }).catch((e) => { debugLog('webterm.spawn.error', { reason: String(e) }); openShell('spawn-error'); });

    const offUpdate = acp.on('sessionUpdate', (frame) => {
      const params = (frame.params ?? {}) as { sessionId?: string; update?: unknown };
      // sessionIdRef captures the post-handshake daemon-issued id —
      // envelopes with that sessionId are ours. Empty ref before
      // handshake → accept all, then narrow.
      const liveSid = sessionIdRef.current;
      if (params.sessionId && liveSid && params.sessionId !== liveSid) return;
      const u = params.update as { sessionUpdate?: string; content?: { type?: string; text?: string } } | undefined;
      if (!u || u.sessionUpdate !== 'agent_thought_chunk') return;
      const text = u.content?.type === 'text' ? u.content.text : null;
      if (!text) return;
      const env = parseElanousTermEnvelope(text);
      if (!env) return;
      if (env.method === 'terminalOutput' && env.payload.terminalId === terminalId) {
        debugLog('webterm.ws.frame.in', {
          terminalId,
          bytes: env.payload.data.length,
        });
        term.write(env.payload.data);
        if (waitingFirstOutput) { waitingFirstOutput = false; openShell('first-output'); }
      } else if (env.method === 'terminalExit' && env.payload.terminalId === terminalId) {
        debugLog('webterm.pty.exit', { terminalId, code: env.payload.code });
        term.write(`\r\n\x1b[2m[exit ${env.payload.code}]\x1b[0m\r\n`);
      } else if (env.method === 'terminalInputActivity' && env.payload.terminalId === terminalId) {
        // WT-M-1 — skip self-echo. Our peerId tag is in the
        // `terminal/input` payload we sent; daemon broadcasts it back.
        if (env.payload.peerId !== getPeerId()) {
          debugLog('webterm.peer.input', {
            terminalId,
            peerId: env.payload.peerId.slice(0, 4),
            bytes: env.payload.bytes,
          });
          onForeignInputActivityRef.current?.({
            peerId: env.payload.peerId,
            bytes: env.payload.bytes,
            timestamp: env.payload.timestamp,
          });
        }
      }
    });

    const inputSender = createTerminalInputSender({
      send: (method, params) => acp.send(method, params),
      ready: acp.ready,
      shellReady,
      getSessionId: () => sessionIdRef.current,
      terminalId,
      getPeerId,
      log: (event, details) => {
        debugLog(event, details);
        if (details.dropped > 0) setInputError({ terminalId, dropped: details.dropped });
      },
    });
    confirmInputSession = inputSender.confirmSession;
    const unregisterInput = readOnly ? null : registerTerminalInput(terminalId, inputSender.push);

    // WT-A-2a — keyboard input writeback. xterm.js `onData` emits the
    // standard terminal byte sequence for every key (modifyOtherKeys
    // v2 / kitty keyboard protocol when caps allow), bracketed paste
    // (DECSET 2004), focus reports (DECSET 1004). We forward the bytes
    // verbatim — the daemon-side PTY hands them to bash/vim/tmux which
    // already know how to parse them. Caller can opt out via readOnly.
    const dataDisposable = readOnly
      ? null
      : term.onData((data) => {
          // T-1 — server-side PreviewTerminal already responds to PTY
          // capability queries (DA / DSR / OSC color / XTWINOPS) at
          // microsecond latency, see src/preview/terminal.ts:290.
          // Forwarding the browser-side response too costs a 100-200ms
          // ACP round-trip — long enough that zsh has finished prompt
          // draw and entered stdin-read by the time it arrives, so the
          // raw bytes echo on the prompt line and corrupt subsequent
          // input. Drop them here; the server answer is authoritative.
          if (isXtermCapabilityResponse(data)) {
            debugLog('webterm.xterm.onData.capability-swallow', {
              terminalId, bytes: data.length,
            });
            return;
          }
          debugLog('webterm.xterm.onData', { terminalId, bytes: data.length });
          inputSender.push(data);
        });

    // WT-A-2a — resize → ACP `terminal/resize`. xterm.js fires onResize
    // after fit.fit() recomputes cols/rows on container changes. Best-
    // effort: caller may not be the active stdin owner.
    const resizeDisposable = readOnly
      ? null
      : term.onResize(({ cols, rows }) => {
          debugLog('webterm.xterm.onResize', { terminalId, cols, rows });
          void acp
            .send('terminal/resize', { sessionId: sessionIdRef.current, terminalId, cols, rows })
            .catch((e) => debugLog('webterm.resize.send-error', { reason: String(e) }));
        });

    // R-1/R-2/R-4 — observe container size (split-pane drag · dock toggle ·
    // sidebar collapse), keep fit() synchronous so the xterm redraw lands
    // in the same frame as the event (matching ghostty/iTerm), and catch
    // mobile rotation / virtual-keyboard show via visualViewport. The
    // pre-existing `window.resize` only listener missed all three.
    //
    // ACP `terminal/resize` send is naturally debounced downstream:
    // `term.onResize({cols, rows})` only fires when fit() changes the
    // cell grid, so drag-resize at pixel granularity collapses into one
    // frame at the cell boundary.
    // Trailing fit() — drag-resize and dock toggle have a settle frame
    // that the immediate ResizeObserver pass can miss (xterm cell grid
    // computed mid-layout). The trailing pass runs after the
    // resize-controller debounce window so the final cell-grid lines
    // up with the final container box. Mirrors ghostty's pattern of
    // mailing the resize to the IO thread regardless of whether the
    // grid actually changed (Surface.zig:2466-2481).
    // 폰 터치: 일반 화면은 스크롤백, 대체 화면은 xterm 휠(마우스 추적 / alternate scroll)에 맡긴다.
    const touchHost = ref.current;
    let touchStart: { y: number; viewportY: number; wheelSent: number; bufferType: 'normal' | 'alternate' } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { touchStart = null; return; }
      touchStart = { y: e.touches[0].clientY, viewportY: term.buffer.active.viewportY, wheelSent: 0, bufferType: term.buffer.active.type };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touchStart || e.touches.length !== 1) return;
      const bufferType = term.buffer.active.type;
      if (bufferType !== touchStart.bufferType) {
        touchStart = { y: e.touches[0].clientY, viewportY: term.buffer.active.viewportY, wheelSent: 0, bufferType };
        return;
      }
      const screen = term.element?.querySelector('.xterm-screen');
      const cellHeight = term.rows > 0 ? (screen?.getBoundingClientRect().height ?? 0) / term.rows : 0;
      if (!(cellHeight > 0)) return;
      const lines = bufferType === 'alternate'
        ? touchWheelLines({ startY: touchStart.y, currentY: e.touches[0].clientY, cellHeight, sentSteps: touchStart.wheelSent })
        : touchScrollLines({
            startY: touchStart.y,
            currentY: e.touches[0].clientY,
            cellHeight,
            startViewportY: touchStart.viewportY,
            currentViewportY: term.buffer.active.viewportY,
          });
      const action = touchScrollAction({ bufferType, mouseTracking: term.modes.mouseTrackingMode, lines });
      if (action.kind === 'scrollback') {
        term.scrollLines(action.lines);
        debugLog('webterm.touch-scroll', { kind: action.kind, lines: action.lines, bufferType });
      } else if (action.kind === 'wheel') {
        const target = term.element;
        if (!target) return;
        dispatchTouchWheel(target, action.steps, e.touches[0].clientX, e.touches[0].clientY);
        touchStart.wheelSent += action.steps;
        debugLog('webterm.touch-scroll', { kind: action.kind, steps: action.steps, bufferType });
      }
    };
    const onTouchEnd = () => { touchStart = null; };
    touchHost.addEventListener?.('touchstart', onTouchStart, { passive: true });
    touchHost.addEventListener?.('touchmove', onTouchMove, { passive: true });
    touchHost.addEventListener?.('touchend', onTouchEnd, { passive: true });

    const resizeController = createXtermResizeController({
      target: ref.current,
      onImmediate: () => {
        try { fit.fit(); } catch { /* dimensions not ready yet */ }
      },
      onTrailing: () => {
        try { fit.fit(); } catch { /* dimensions not ready yet */ }
      },
    });

    return () => {
      // BACKLOG #3 — capture scrollback before tearing down the term.
      // serialize.serialize() returns ANSI bytes ready for term.write
      // on next mount. Wrapped because SerializeAddon throws if the
      // term was already disposed (defensive — shouldn't happen here).
      try {
        const ansi = serialize.serialize();
        if (typeof ansi === 'string') {
          saveSnapshot(snapshotKey('xtermScrollback', terminalId), ansi);
        }
      } catch (e) {
        debugLog('webterm.xterm.snapshot.error', { reason: String(e) });
      }
      try { resizeController.dispose(); } catch { /* swallow */ }
      touchHost.removeEventListener?.('touchstart', onTouchStart);
      touchHost.removeEventListener?.('touchmove', onTouchMove);
      touchHost.removeEventListener?.('touchend', onTouchEnd);
      unregisterInput?.();
      inputSender.dispose();
      clearTimeout(shellCap);
      offUpdate();
      offState();
      try { dataDisposable?.dispose(); } catch { /* swallow */ }
      try { resizeDisposable?.dispose(); } catch { /* swallow */ }
      try { acp.close(); } catch { /* swallow */ }
      if (termRef.current === term) termRef.current = null;
      if (screenHost?.__elanousTerm === term) delete screenHost.__elanousTerm;
      try { term.dispose(); } catch { /* swallow */ }
      debugLog('webterm.xterm.teardown', { terminalId });
    };
    // Intentionally exclude `sessionId` and `setSessionId` — see
    // sessionIdRef above. Reconnect is driven only by terminalId /
    // readOnly toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, readOnly, client, reconnectNonce]);

  const failureKind = (acpState === 'FAILED' || acpState === 'CLOSED') ? classifyAcpFailure(acpStatus.reason) : null;

  // 토큰이 바뀌면(이 탭 설정 · 다른 탭 설정 모두 · DaemonProvider 가 config 를 갈아 끼운다) «토큰 없음» 상태면 바로 다시 붙는다.
  const tokenSeenRef = useRef(config.token);
  useEffect(() => {
    if (tokenSeenRef.current === config.token) return;
    tokenSeenRef.current = config.token;
    if (failureKind === 'auth' && config.token) {
      debugLog('webterm.acp.reconnect', { terminalId, why: 'token-changed' });
      setReconnectNonce((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.token]);

  // 잠깐의 실패(데몬 재시작 · 네트워크)면 1s→30s 간격으로 다시 붙는다. 토큰 거절은 두드리지 않는다 —
  // 대신 탭으로 돌아오거나(설정에서 토큰을 붙이고 온 경우) 네트워크가 돌아오면 한 번 다시 붙는다.
  useEffect(() => {
    if (failureKind === null) return;
    const retry = (why: string) => {
      reconnectAttemptRef.current += 1;
      debugLog('webterm.acp.reconnect', { terminalId, why, attempt: reconnectAttemptRef.current, reason: acpStatus.reason });
      setReconnectNonce((n) => n + 1);
    };
    const doc = typeof document === 'undefined' ? null : document;
    const win = typeof window === 'undefined' ? null : window;
    const onVisible = () => { if (doc?.visibilityState === 'visible') retry('visible'); };
    const onOnline = () => retry('online');
    doc?.addEventListener?.('visibilitychange', onVisible);
    win?.addEventListener?.('online', onOnline);
    const timer = failureKind === 'transient'
      ? setTimeout(() => retry('backoff'), reconnectDelayMs(reconnectAttemptRef.current))
      : undefined;
    return () => {
      doc?.removeEventListener?.('visibilitychange', onVisible);
      win?.removeEventListener?.('online', onOnline);
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failureKind, terminalId]);

  useEffect(() => {
    if (shouldClear(previousClearRequestRef.current, clearRequest) && termRef.current) {
      termRef.current.clear();
      debugLog('webterm.controls.clear.applied', { terminalId });
    }
    previousClearRequestRef.current = clearRequest;
  }, [clearRequest, terminalId]);

  const statusLabel = acpState === 'CONNECTING'
    ? (reconnectAttemptRef.current > 0 ? `다시 연결 중(${reconnectAttemptRef.current}회)` : '연결 중')
    : acpState === 'OPEN' ? '연결됨'
      : failureKind === 'auth' ? '토큰 없음'
        : acpState === 'FAILED' ? '연결 실패 · 곧 다시 붙습니다' : '연결 끊김 · 곧 다시 붙습니다';
  const statusTone = acpState === 'OPEN' ? 'text-emerald-300' : acpState === 'CONNECTING' ? 'text-amber-300' : 'text-red-300';
  const connectionTarget = terminalId.trim() || '대상 미지정';
  const connectingDurationSeconds = Math.max(0, Math.floor((now - connectingSince) / 1_000));

  // TERM2 — Ctrl/⌘+Shift+F 로 켜고 끈다(BT 키보드). 여러 터미널이면 포커스를 가진 것, 없으면 화면의 첫 터미널.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const owns = (): boolean => {
      const host = hostRef.current;
      if (!host) return false;
      const active = document.activeElement;
      if (active && host.contains(active)) return true;
      const anyFocused = active ? active.closest?.('[data-xterm-host]') : null;
      return !anyFocused && document.querySelector('[data-xterm-host]') === host;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isFocusToggleKey(e) && owns()) {
        e.preventDefault(); e.stopPropagation();
        toggleFocusMode();
        return;
      }
      const step = fontStepKey(e);
      const term = termRef.current;
      if (step !== 0 && term && owns()) {
        e.preventDefault(); e.stopPropagation();
        const next = clampFontSize((term.options.fontSize ?? 13) + step);
        term.options.fontSize = next;
        writeTermFontSize(window.localStorage, next);
        debugLog('webterm.focus-mode', { event: 'font', size: next });
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    debugLog('webterm.focus-mode', { event: focusMode ? 'on' : 'off', terminalId });
    if (typeof document === 'undefined') return;
    // 브라우저 전체 화면(폴드 크롬의 주소창까지) — 지원 안 하거나 거부돼도 화면 덮기는 그대로 된다.
    try {
      if (focusMode && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
      if (!focusMode && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    } catch { /* fullscreen is optional */ }
    if (focusMode) termRef.current?.focus();
  }, [focusMode, terminalId]);

  return (
    <div
      ref={hostRef}
      data-xterm-host
      data-focus-mode={focusMode ? '1' : undefined}
      className={focusMode ? 'fixed inset-0 z-[90] h-[100dvh] w-screen bg-[#0d0c08]' : 'relative h-full w-full bg-[#0d0c08]'}
    >
      <div ref={ref} className="h-full w-full" />
      <button
        type="button"
        data-share-hide
        onClick={toggleFocusMode}
        aria-pressed={focusMode}
        aria-label={focusMode ? '집중 모드 끄기' : '집중 모드 — 터미널만 크게'}
        title={focusMode ? '집중 모드 끄기 (Ctrl/⌘+Shift+F)' : '집중 모드 — 터미널만 크게 (Ctrl/⌘+Shift+F · 글자 Ctrl/⌘+Shift+±)'}
        className={focusMode
          ? 'absolute bottom-2 right-2 z-40 rounded bg-black/60 px-2 py-1 text-xs text-[#e9e3d4]/70 hover:text-[#e9e3d4]'
          : 'absolute bottom-2 right-2 z-20 rounded bg-black/60 px-2 py-1 text-xs text-[#e9e3d4]/70 hover:text-[#e9e3d4]'}
      >
        {focusMode ? '⤡ 나가기' : '⤢ 집중'}
      </button>
      {visibleInputError && (
        <div role="alert" className="pointer-events-none absolute bottom-2 left-2 right-2 rounded bg-red-950/95 px-3 py-2 text-sm text-red-100">
          터미널 입력 전송 실패: {visibleInputError.dropped}바이트가 버려졌습니다. 명령이 일부만 실행됐을 수 있습니다. 입력을 확인하고 다시 입력하세요.
        </div>
      )}
      {failureKind === 'auth' && (
        // ⛔ z-index 필수 — xterm 층이 z-index 최대 11 이라 없으면 캔버스가 클릭을 먹는다(대표 2026-09-28 «링크가 안 눌린다»).
        <div role="alert" className="absolute left-2 right-2 top-10 z-30 space-y-1 rounded bg-amber-950/95 px-3 py-2 text-sm text-amber-100" data-webterm-auth-missing>
          <p>{ACP_AUTH_MESSAGE}</p>
          <p className="text-xs text-amber-200/90">{ACP_AUTH_HOWTO}</p>
          {/* ⛔ 평범한 <a> — Next Link 의 클라이언트 이동이 이 화면에서 끝나지 않았다(클릭은 먹고 경로가 안 바뀜 · 2026-09-28 실측). 설정은 새로 읽어도 된다. */}
          <a href="/app/settings/#bearer-token" className="inline-block font-medium underline" data-webterm-auth-settings>설정 열기 →</a>
        </div>
      )}
      <span aria-live="polite" className="sr-only">ACP: {statusLabel}</span>
      <span className={`pointer-events-none absolute right-2 top-2 rounded bg-black/70 px-2 py-1 text-xs ${statusTone}`}>
        ACP: {statusLabel}
        {acpState === 'CONNECTING' && <span data-share-hide>{' · '}{`${connectingDurationSeconds}초 · ${connectionTarget} · ${config.baseUrl}`}</span>}
      </span>
    </div>
  );
}
