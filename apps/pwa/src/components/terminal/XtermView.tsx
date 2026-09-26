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
import { createXtermResizeController } from '@/lib/xterm-resize-controller';
import { isXtermCapabilityResponse } from '@/lib/xterm-capability-filter';
import { createTerminalInputSender } from './terminal-input-sender';
import { shouldClear } from './terminal-clear';

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

export function XtermView({ sessionId, terminalId, clearRequest = 0, readOnly = false, onForeignInputActivity }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const previousClearRequestRef = useRef<number | undefined>(undefined);
  const clearTerminalIdRef = useRef(terminalId);
  if (clearTerminalIdRef.current !== terminalId) {
    clearTerminalIdRef.current = terminalId;
    previousClearRequestRef.current = undefined;
  }
  // Latest sessionId snapshot for use inside the (deps-frozen) effect.
  // Without this, terminal/input frames after handshake still need the
  // up-to-date daemon-issued id, but we can't include `sessionId` in
  // effect deps without retriggering reconnect cycles.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

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
  }>(() => ({ state: 'CONNECTING', terminalId, connectingSince: Date.now() }));
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
      fontSize: 13,
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
    const acp = client.connectAcp({
      ...(sessionId ? { sessionId } : {}),
      onSession: (sid) => {
        if (sid) {
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
      }));
      if (state === 'CONNECTING') setNow(observedAt);
      debugLog('webterm.xterm.acp-state', { terminalId, state, reason: error?.message });
    });

    // WT-A-1b — auto-spawn on first mount. Without this, PWA-only
    // dogfood (no dashboard TUI in the daemon process) has no
    // PreviewTerminal instance to attach to and the screen stays blank.
    // Idempotent on the daemon side: re-mount returns `status:'attached'`.
    void acp.ready.then((daemonSid) => {
      if (!daemonSid) return; // handshake failed — silent
      return acp.send('terminal/spawn', {
        sessionId: daemonSid,
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
      if (r.status === 'attached' && typeof r.snapshot === 'string' && r.snapshot.length > 0) {
        // 화면만 지우고(ESC[2J — scrollback 보존) 데몬이 상주 보유한 현재
        // 뷰포트로 동기화. 로컬 복원 snapshot 보다 항상 최신이므로 우선.
        debugLog('webterm.attach.replay', { terminalId, bytes: r.snapshot.length });
        term.write('\x1b[2J\x1b[H' + r.snapshot.split('\n').join('\r\n') + '\r\n');
      }
    }).catch((e) => debugLog('webterm.spawn.error', { reason: String(e) }));

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
      getSessionId: () => sessionIdRef.current,
      terminalId,
      getPeerId,
      log: (event, details) => {
        debugLog(event, details);
        if (details.dropped > 0) setInputError({ terminalId, dropped: details.dropped });
      },
    });
    confirmInputSession = inputSender.confirmSession;

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
      inputSender.dispose();
      offUpdate();
      offState();
      try { dataDisposable?.dispose(); } catch { /* swallow */ }
      try { resizeDisposable?.dispose(); } catch { /* swallow */ }
      try { acp.close(); } catch { /* swallow */ }
      if (termRef.current === term) termRef.current = null;
      try { term.dispose(); } catch { /* swallow */ }
      debugLog('webterm.xterm.teardown', { terminalId });
    };
    // Intentionally exclude `sessionId` and `setSessionId` — see
    // sessionIdRef above. Reconnect is driven only by terminalId /
    // readOnly toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, readOnly, client]);

  useEffect(() => {
    if (shouldClear(previousClearRequestRef.current, clearRequest) && termRef.current) {
      termRef.current.clear();
      debugLog('webterm.controls.clear.applied', { terminalId });
    }
    previousClearRequestRef.current = clearRequest;
  }, [clearRequest, terminalId]);

  const statusLabel = acpState === 'CONNECTING' ? '연결 중' : acpState === 'OPEN' ? '연결됨' : acpState === 'FAILED' ? '연결 실패' : '연결 종료';
  const statusTone = acpState === 'OPEN' ? 'text-emerald-300' : acpState === 'CONNECTING' ? 'text-amber-300' : 'text-red-300';
  const connectionTarget = terminalId.trim() || '대상 미지정';
  const connectingDurationSeconds = Math.max(0, Math.floor((now - connectingSince) / 1_000));

  return (
    <div className="relative h-full w-full bg-[#0d0c08]">
      <div ref={ref} className="h-full w-full" />
      {visibleInputError && (
        <div role="alert" className="pointer-events-none absolute bottom-2 left-2 right-2 rounded bg-red-950/95 px-3 py-2 text-sm text-red-100">
          터미널 입력 전송 실패: {visibleInputError.dropped}바이트가 버려졌습니다. 명령이 일부만 실행됐을 수 있습니다. 입력을 확인하고 다시 입력하세요.
        </div>
      )}
      <span aria-live="polite" className="sr-only">ACP: {statusLabel}</span>
      <span className={`pointer-events-none absolute right-2 top-2 rounded bg-black/70 px-2 py-1 text-xs ${statusTone}`}>
        ACP: {statusLabel}
        {acpState === 'CONNECTING' && ` · ${connectingDurationSeconds}초 · ${connectionTarget} · ${config.baseUrl}`}
      </span>
    </div>
  );
}
