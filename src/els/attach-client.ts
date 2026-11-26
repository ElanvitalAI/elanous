// els attach client — one long connection to the owner for one pane: frames in, `input`/`resize` lines out. Closing the
// connection (detach) never touches the pane. The terminal drawing lives in attach-view.ts; this file only speaks the wire.

import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { elsSocketPathProblem } from './server.js';
import { createLineDecoder } from './wire.js';
import { AUTH_PANE_TOKEN_ENV, AUTH_OWNER_TOKEN_ENV } from './server-auth.js';

import type { WheelRoute } from '../pty-shell/registry.js';

const WHEEL_ROUTES: readonly string[] = ['mouse-sgr', 'mouse-x10', 'arrows', 'host'];
const isWheelRoute = (value: unknown): value is WheelRoute => typeof value === 'string' && WHEEL_ROUTES.includes(value);
export interface AttachFrame { readonly pane: string; readonly seq: number; readonly cols: number; readonly rows: number; readonly screen: string; /** Lines this frame is scrolled above the live bottom (0 = live). */ readonly back: number; /** ELS-WHEEL-SCROLLBACK (OP #136704): the pane tracks its own mouse on an alternate screen — a wheel there belongs to the pane program as bytes, not to the els scrollback (which is empty there). */ readonly wheelPassthrough?: boolean; /** ELS-WHEEL-HISTORY: where a wheel over the pane goes — absent = the els scrollback (host). */ readonly wheelRoute?: WheelRoute; /** ELS-OP-INPUT-FLICKER: false = another view owns the pane size (do not re-assert). */ readonly sizeOwner?: false }

export interface AttachHandlers {
  readonly onFrame: (frame: AttachFrame) => void;
  /** The stream ended: the pane exited, the server went away, or the attach was refused (`exitCode` 1/2). */
  readonly onEnd: (exitCode: 0 | 1 | 2, reason: string) => void;
  /** A line the server refused (a bad input or resize); the attach stays open. */
  readonly onError?: (message: string) => void;
  /** Request from this pane's verified child to select another pane in this view. */
  readonly onFocus?: (pane: string, acknowledge: (accepted: boolean) => void) => void;
}

export interface Attached {
  readonly input: (bytes: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  /** Scroll the view into the pane's scrollback: positive = towards older lines. */
  readonly scroll: (lines: number) => void;
  readonly detach: () => void;
}

/** D1a: the credential this attach presents, read FRESH at every (re)attach. A pane process carries its pane token. An owner
 *  terminal (the person's `els attach`) carries the OWNER token of the server run it started against — a restart mints a new
 *  one and rewrites the owner-token file next to the socket, so an owner holder re-reads that file instead of reusing a
 *  token no running server knows (that attach would be a view-only outsider: typing refused). Only a process that already
 *  holds an owner token does this: a pane process (pane token) never reads the owner file, so nothing is promoted here. */
function attachAuth(socketPath: string): string | undefined {
  const pane = process.env[AUTH_PANE_TOKEN_ENV];
  if (pane) return pane;
  const owner = process.env[AUTH_OWNER_TOKEN_ENV];
  if (!owner) return undefined;
  try { return readFileSync(join(dirname(socketPath), 'owner-token'), 'utf8').trim() || owner; }
  catch { return owner; }
}

export function attachEls(socketPath: string, pane: string, size: { cols: number; rows: number }, handlers: AttachHandlers, opts?: { diff?: boolean }): Attached {
  let ended = false;
  const tooLong = elsSocketPathProblem(socketPath);
  // JUD-B must #107737: end 는 socket 선언 뒤에 정의한다 — tooLong 조기 반환 경로에는 socket 이 없어서, end 가
  // socket.destroy() 를 참조하면 queueMicrotask 의 end(1, tooLong) 이 TDZ ReferenceError 로 프로세스를 죽인다.
  if (tooLong) { queueMicrotask(() => { if (!ended) { ended = true; handlers.onEnd(1, tooLong); } }); return { input: () => {}, resize: () => {}, scroll: () => {}, detach: () => {} }; }
  const socket = createConnection(socketPath);
  // D1a must-1(JUD-B #107693): end 는 소켓도 닫는다 — 서버가 end 를 보내면 절반만 닫힌 연결이 남아 서버의 close() 를
  // 묶어둔다(els serve SIGTERM 이 끝나지 않는다). end 를 받은 클라 소켓은 즉시 완전히 닫는다.
  const end = (exitCode: 0 | 1 | 2, reason: string): void => { if (!ended) { ended = true; socket.destroy(); handlers.onEnd(exitCode, reason); } };
  const write = (value: object): void => { if (!ended && !socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
  // JUD #39096 ⓒ (OP #107528): the typing lines (input/resize) are owner-token-only at the door, so the attach
  // client presents the same credential `requestEls` does — the pane token of the pane it lives in, or the owner
  // token the CLI loaded from the owner-token file. Without it the connection stays view-only (outsider: attach
  // yes, typing denied). The server's auth ack line is neither frame/end/error, so the decoder ignores it.
  const auth = attachAuth(socketPath);
  if (auth) write({ op: 'auth', token: auth, pid: process.pid });
  // The attach line is queued right behind the auth line (Node buffers writes in order until the socket connects),
  // so an `input`/`resize` called before `connect` can only follow it, never overtake it.
  // ELS-ATTACH-FRAME-DIFF (OP #127484 ③): `diff:true` asks the server for row diffs; the assembler below rebuilds the
  // full screen before the handlers see it, so the AttachHandlers contract (a full frame) never changes.
  write({ op: 'attach', pane, cols: size.cols, rows: size.rows, ...(opts?.diff ? { diff: true } : {}), ...(handlers.onFocus ? { focusEvents: true } : {}) });
  // The row-diff assembler: the last full screen this attach assembled. A `frame` (always full) resets it; a
  // `frame-diff` patches the changed rows. Cleared on end — a re-attach starts from a server full frame again.
  let assembled: string[] | undefined;
  const lines = createLineDecoder((line) => {
    let value: { type?: string; exitCode?: 0 | 1 | 2; message?: string } & Partial<AttachFrame> & { count?: unknown; lines?: unknown; id?: unknown };
    try { value = JSON.parse(line) as typeof value; } catch { end(1, 'els: malformed frame from the els server'); return; }
    // The door answers a refused attach with a plain result line (no `type`) and closes: that refusal is the end, with its own
    // words — left to the socket close it would read as «the server closed the connection», the signal views retry on.
    // (The auth ack is also a plain result line, but with exitCode 0.)
    if (value && value.type === undefined && typeof value.exitCode === 'number' && value.exitCode !== 0) { end(value.exitCode, value.message ?? 'refused'); return; }
    if (value.type === 'frame' && typeof value.screen === 'string') {
      // The assembler baseline is the same body the server diffs against — renderScreen's scroll header stripped —
      // so a diff row index after a scroll → live return addresses the row the server means (JUD #127758).
      assembled = value.screen.replace(/^\[screen \d+x\d+ scrolled-back=\d+\]\n/, '').split('\n');
      handlers.onFrame({ pane: String(value.pane), seq: Number(value.seq), cols: Number(value.cols), rows: Number(value.rows), back: Number(value.back ?? 0), screen: value.screen, ...(value.wheelPassthrough === true ? { wheelPassthrough: true } : {}), ...(isWheelRoute(value.wheelRoute) ? { wheelRoute: value.wheelRoute } : {}), ...(value.sizeOwner === false ? { sizeOwner: false as const } : {}) });
    } else if (value.type === 'frame-diff') {
      const count = Number(value.count);
      const rows = Array.isArray(value.lines) ? value.lines : [];
      if (!assembled || !Number.isFinite(count) || count < 0) return;   // a diff before any full frame, or malformed: ignore, the next full frame repairs it
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const i = Number((row as { i?: unknown }).i);
        const t = (row as { t?: unknown }).t;
        if (Number.isInteger(i) && i >= 1 && i <= count && typeof t === 'string') assembled[i - 1] = t;
      }
      handlers.onFrame({ pane: String(value.pane), seq: Number(value.seq), cols: Number(value.cols), rows: Number(value.rows), back: Number(value.back ?? 0), screen: assembled.join('\n'), ...(value.wheelPassthrough === true ? { wheelPassthrough: true } : {}), ...(isWheelRoute(value.wheelRoute) ? { wheelRoute: value.wheelRoute } : {}), ...(value.sizeOwner === false ? { sizeOwner: false as const } : {}) });
    } else if (value.type === 'focus' && typeof value.pane === 'string' && typeof value.id === 'string') {
      const id = value.id;
      handlers.onFocus?.(value.pane, accepted => write({ op: 'focus-ack', id, accepted }));
    }
    else if (value.type === 'end') end(value.exitCode ?? 0, value.message ?? '');
    else if (value.type === 'error') handlers.onError?.(value.message ?? 'refused');
  });
  socket.on('data', (chunk: Buffer) => lines.push(chunk));
  socket.on('error', (error: NodeJS.ErrnoException) => {
    end(1, error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'els: no els server is running — start it with `els serve` (or `elanous side serve`)' : `els: ${error.message}`);
  });
  socket.on('close', () => end(1, 'els: the els server closed the connection'));
  return {
    input: (bytes) => write({ op: 'input', bytes }),
    resize: (cols, rows) => write({ op: 'resize', cols, rows }),
    scroll: (lines) => write({ op: 'scroll', lines }),
    detach: () => { if (!ended) { ended = true; socket.end(); } },
  };
}

/** D1a(ELS-SERVER-RESTART-SURVIVE): the ends a client can ride out — the els server going away (a restart, an update,
 *  a dropped socket). A pane that exited, a pane that never existed and a malformed stream are real ends: retrying
 *  them would lie. The strings are the wire's own words (this file's error paths, the request client's no-server and
 *  timeout lines, the server's stopping message). */
export const RECONNECT_NOTE = '서버 재기동 중 — 다시 붙는 중…';
/** The status-line note after a frame arrived: the reconnect note goes with the wait, any other note stays. */
export const noteAfterFrame = (note: string): string => (note === RECONNECT_NOTE ? '' : note);
const SERVER_AWAY = /no els server is running|closed the connection|did not answer|the server is stopping/;
export function isServerAway(reason: string): boolean {
  return SERVER_AWAY.test(reason);
}
