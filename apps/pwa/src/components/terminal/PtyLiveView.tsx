'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import type { DaemonClient, DaemonTerminalSummary } from '@/lib/daemon-client';
import {
  initialPtyLivePollState, nextPtyLivePollState, PTY_LIVE_POLL_MS, ptySnapshotReplacement, shouldPollPty,
  type PtyLivePollState,
} from './pty-live-poll';
import { debugLog } from '@/lib/debug';
import { cellFromPoint, isMouseModeOff, mouseButtonName } from './pty-mouse-forward';

interface Props {
  terminal: DaemonTerminalSummary;
  client: Pick<DaemonClient, 'snapshotTerminal' | 'controlTerminal' | 'sendTerminalText' | 'sendTerminalKey'> & Partial<Pick<DaemonClient, 'streamTerminal' | 'sendTerminalMouse'>>;
  onClose: () => void;
}

interface LiveSession {
  closed: boolean;
  owned: boolean;
  accepting: boolean;
  queue: Promise<void>;
  takeover: Promise<void> | null;
  release: Promise<void> | null;
}

export function PtyLiveView({ terminal, client, onClose }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const screen = useRef<Terminal | null>(null);
  const sessionRef = useRef<LiveSession | null>(null);
  const stateRef = useRef<PtyLivePollState>(initialPtyLivePollState);
  const [writable, setWritable] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  /** 화면을 받는 방식 — 스트림(바이트·화면 차이) 또는 800ms 폴링(옛 데몬·실패 시). */
  const [feed, setFeed] = useState<'stream-bytes' | 'stream-screen' | 'poll' | 'connecting'>('connecting');

  useEffect(() => {
    if (!container.current) return;
    const session: LiveSession = {
      closed: false, owned: false, accepting: false,
      queue: Promise.resolve(), takeover: null, release: null,
    };
    sessionRef.current = session;
    busyRef.current = false;
    setBusy(false);
    const source = { sourceRoot: terminal.sourceRoot?.dbPath };
    const term = new Terminal({
      cols: 110, rows: 40,
      fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", monospace',
      fontSize: 13,
      theme: { background: '#0d0c08', foreground: '#e9e3d4', cursor: '#e9e3d4' },
      cursorBlink: false,
      disableStdin: true,
      scrollback: 0,
      // Unicode11Addon 이 xterm «제안 API» 를 쓴다 — 이게 없으면 첫 렌더에서 예외로 페이지 전체가 죽는다
      // (2026-09-27 실물: 다이렉트 링크가 «Application error» · XtermView 와 같은 설정).
      allowProposedApi: true,
    });
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(container.current);
    term.write('\x1b[?25l');
    screen.current = term;
    stateRef.current = initialPtyLivePollState;
    setWritable(false);
    setMessage(null);

    const input = term.onData((data) => {
      if (!session.accepting || session.closed || !data) return;
      const key = data.startsWith('\x1b') || data === '\r' || data === '\n' || data === '\x7f' || data === '\t' || data === '\x03';
      session.queue = session.queue.then(async () => {
        try {
          const result = key
            ? await client.sendTerminalKey(terminal.id, data, source)
            : await client.sendTerminalText(terminal.id, data, source);
          if (session.closed) return;
          if (result.status !== 'success') {
            if (result.status === 'denied') {
              session.accepting = false;
              setWritable(false);
              term.options.disableStdin = true;
            }
            setMessage(result.reason || `입력 실패: ${result.status}`);
          }
        } catch (error) {
          if (!session.closed) setMessage(`입력 전송 실패: ${String(error)}`);
        }
      });
    });

    // takeover 중 마우스 → PTY(🅢 #21609 `input-mouse`). xterm 이 이미 마우스를 추적하면(원 바이트 스트림으로
    // 앱의 ?1000h 를 받은 경우) xterm 이 onData 로 보내므로 여기서는 비킨다 — 두 번 보내지 않는다.
    const host = container.current;
    let mouseOffNoted = false;
    const sendMouse = (mouse: { x: number; y: number; kind: 'click' | 'scroll-up' | 'scroll-down'; button?: 'left' | 'middle' | 'right' }) => {
      session.queue = session.queue.then(async () => {
        try {
          if (!client.sendTerminalMouse) return;
          const result = await client.sendTerminalMouse(terminal.id, mouse, source);
          if (session.closed || result.status === 'success') return;
          if (isMouseModeOff(result.reason)) {
            if (mouse.kind === 'click' && !mouseOffNoted) { mouseOffNoted = true; setMessage('이 앱은 마우스를 받지 않는다(마우스 모드 꺼짐) — 키보드로 조작하세요.'); }
            return;
          }
          setMessage(result.reason || `마우스 전송 실패: ${result.status}`);
        } catch (error) {
          if (!session.closed) setMessage(`마우스 전송 실패: ${String(error)}`);
        }
      });
    };
    const cellOf = (e: MouseEvent) => {
      const screenEl = term.element?.querySelector('.xterm-screen');
      return screenEl ? cellFromPoint(e.clientX, e.clientY, screenEl.getBoundingClientRect(), term.cols, term.rows) : null;
    };
    const forwarding = () => session.accepting && !session.closed && term.modes.mouseTrackingMode === 'none';
    const onMouseDown = (e: MouseEvent) => {
      if (!forwarding()) return;
      const button = mouseButtonName(e.button);
      const cell = cellOf(e);
      if (!button || !cell) return;
      sendMouse({ ...cell, kind: 'click', button });
    };
    const onWheel = (e: WheelEvent) => {
      if (!forwarding() || e.deltaY === 0) return;
      const cell = cellOf(e);
      if (!cell) return;
      // xterm 은 마우스 추적이 없을 때 휠을 ↑↓ 화살표로 바꿔 보낸다(실측: 앱이 `ESC[A` 를 받았다) — 캡처 단계에서 가로채 막는다.
      e.preventDefault();
      e.stopPropagation();
      sendMouse({ ...cell, kind: e.deltaY < 0 ? 'scroll-up' : 'scroll-down' });
    };
    host.addEventListener?.('mousedown', onMouseDown, { capture: true });
    host.addEventListener?.('wheel', onWheel, { passive: false, capture: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!session.closed && shouldPollPty(!document.hidden, stateRef.current)) timer = setTimeout(() => { void poll(); }, PTY_LIVE_POLL_MS);
    };
    const poll = async () => {
      if (session.closed || !shouldPollPty(!document.hidden, stateRef.current)) return;
      try {
        const result = await client.snapshotTerminal(terminal.id, { ansi: true, sourceRoot: source.sourceRoot });
        if (session.closed) return;
        const next = nextPtyLivePollState(stateRef.current, result);
        stateRef.current = next;
        if (next.screen !== null && result.status === 'success') term.write(next.screen + '\x1b[?25l');
        setMessage(next.message);
      } catch {
        if (session.closed) return;
        const next = nextPtyLivePollState(stateRef.current, null);
        stateRef.current = next;
        setMessage(next.message);
      }
      schedule();
    };
    // 실시간 스트림을 먼저 쓴다(드라이브 RFC ⑥) — 안 되면 폴링으로. 창을 숨기면 끊고, 보이면 다시 잇는다(평소 부하 0).
    let polling = !client.streamTerminal;
    let disposeStream: (() => void) | null = null;
    const startStream = () => {
      if (!client.streamTerminal || session.closed || polling) return;
      setFeed('connecting');
      disposeStream = client.streamTerminal(terminal.id, { sourceRoot: source.sourceRoot }, (ev) => {
        if (session.closed) return;
        if (ev.type === 'mode') setFeed(ev.mode === 'bytes' ? 'stream-bytes' : 'stream-screen');
        else if (ev.type === 'reset' || ev.type === 'screen') { term.write(ptySnapshotReplacement(ev.screen) + '\x1b[?25l'); setMessage(null); }
        else if (ev.type === 'data') term.write(ev.chunk);
        else if (ev.type === 'end') { setMessage('PTY 가 끝났습니다'); stateRef.current = { ...stateRef.current, stopped: true }; }
        else if (ev.type === 'status') setMessage(`화면 조회: ${ev.status}`);
      }, (reason) => {
        if (session.closed) return;
        debugLog('pwa.terminal.stream-fallback', { id: terminal.id, reason });
        polling = true;
        setFeed('poll');
        void poll();
      });
    };
    const onVisibility = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!polling) {
        if (document.hidden) { disposeStream?.(); disposeStream = null; }
        else if (!disposeStream && !stateRef.current.stopped) startStream();
        return;
      }
      if (!document.hidden && !session.closed && !stateRef.current.stopped) void poll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (polling) { setFeed('poll'); void poll(); } else startStream();
    return () => {
      session.closed = true;
      session.accepting = false;
      if (timer) clearTimeout(timer);
      disposeStream?.();
      document.removeEventListener('visibilitychange', onVisibility);
      input.dispose();
      host.removeEventListener?.('mousedown', onMouseDown, { capture: true });
      host.removeEventListener?.('wheel', onWheel, { capture: true });
      // A takeover may still be in flight when the view is removed. Its promise
      // records ownership before this cleanup attempts the release.
      void (async () => {
        await session.takeover;
        if (session.release) await session.release;
        if (!session.owned) return;
        await session.queue;
        try {
          const result = await client.controlTerminal(terminal.id, 'release', source);
          if (result.status === 'success') session.owned = false;
        } catch { /* The view is gone; no UI remains to report an unreachable owner. */ }
      })();
      if (sessionRef.current === session) sessionRef.current = null;
      screen.current = null;
      term.dispose();
    };
  }, [client, terminal.id, terminal.sourceRoot?.dbPath]);

  const changeControl = (action: 'takeover' | 'release') => {
    const session = sessionRef.current;
    if (!session || session.closed || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const source = { sourceRoot: terminal.sourceRoot?.dbPath };
    if (action === 'release') {
      // Close the input gate synchronously, before waiting for the queued sends.
      session.accepting = false;
      if (screen.current) screen.current.options.disableStdin = true;
    }
    const operation = (async () => {
      try {
        if (action === 'release') await session.queue;
        const result = await client.controlTerminal(terminal.id, action, source);
        if (result.status === 'success') session.owned = action === 'takeover';
        if (session.closed) return;
        if (result.status === 'success') {
          session.accepting = action === 'takeover';
          setWritable(session.accepting);
          if (screen.current) screen.current.options.disableStdin = !session.accepting;
          setMessage(null);
        } else {
          if (action === 'release') {
            session.accepting = session.owned;
            if (screen.current) screen.current.options.disableStdin = !session.accepting;
          }
          setMessage(result.reason || (result.status === 'denied' ? '제어 거부: 권한이 없습니다' : `제어 실패: ${result.status}`));
        }
      } catch (error) {
        if (!session.closed) {
          if (action === 'release') {
            session.accepting = session.owned;
            if (screen.current) screen.current.options.disableStdin = !session.accepting;
          }
          setMessage(`제어 요청 실패: ${String(error)}`);
        }
      } finally {
        if (!session.closed) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    })();
    if (action === 'takeover') session.takeover = operation;
    else session.release = operation;
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#0d0c08]" aria-label="PTY 라이브 화면">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-700 px-3 py-2 text-sm text-zinc-100">
        <span className="font-mono">{terminal.id}</span>
        <span>{terminal.kind ?? 'PTY'}</span>
        <span>{writable ? '입력 가능' : '읽기 전용'}</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300" data-pty-feed={feed} title="화면을 받는 방식">
          {feed === 'stream-bytes' ? '● 실시간' : feed === 'stream-screen' ? '● 실시간(화면)' : feed === 'poll' ? '폴링 0.8s' : '연결 중'}
        </span>
        <button type="button" disabled={busy} onClick={() => { changeControl(writable ? 'release' : 'takeover'); }}>
          {writable ? 'release' : 'takeover'}
        </button>
        <button type="button" onClick={onClose} aria-label="PTY 라이브 닫기">닫기</button>
      </header>
      {message && <p role="status" className="px-3 py-1 text-amber-300">{message}</p>}
      <div ref={container} className="min-h-0 flex-1 overflow-auto" aria-label={`${terminal.id} 화면`} />
    </section>
  );
}
