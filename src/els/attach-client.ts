// els attach client — one long connection to the owner for one pane: frames in, `input`/`resize` lines out. Closing the
// connection (detach) never touches the pane. The terminal drawing lives in attach-view.ts; this file only speaks the wire.

import { createConnection } from 'node:net';
import { elsSocketPathProblem } from './server.js';
import { createLineDecoder } from './wire.js';

export interface AttachFrame { readonly pane: string; readonly seq: number; readonly cols: number; readonly rows: number; readonly screen: string }

export interface AttachHandlers {
  readonly onFrame: (frame: AttachFrame) => void;
  /** The stream ended: the pane exited, the server went away, or the attach was refused (`exitCode` 1/2). */
  readonly onEnd: (exitCode: 0 | 1 | 2, reason: string) => void;
  /** A line the server refused (a bad input or resize); the attach stays open. */
  readonly onError?: (message: string) => void;
}

export interface Attached {
  readonly input: (bytes: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly detach: () => void;
}

export function attachEls(socketPath: string, pane: string, size: { cols: number; rows: number }, handlers: AttachHandlers): Attached {
  let ended = false;
  const end = (exitCode: 0 | 1 | 2, reason: string): void => { if (!ended) { ended = true; handlers.onEnd(exitCode, reason); } };
  const tooLong = elsSocketPathProblem(socketPath);
  if (tooLong) { queueMicrotask(() => end(1, tooLong)); return { input: () => {}, resize: () => {}, detach: () => {} }; }
  const socket = createConnection(socketPath);
  const write = (value: object): void => { if (!ended && !socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
  // The attach line is queued first, on the not-yet-connected socket (Node buffers writes in order until it connects), so an
  // `input`/`resize` called before `connect` can only follow it, never overtake it.
  write({ op: 'attach', pane, cols: size.cols, rows: size.rows });
  const lines = createLineDecoder((line) => {
    let value: { type?: string; exitCode?: 0 | 1 | 2; message?: string } & Partial<AttachFrame>;
    try { value = JSON.parse(line) as typeof value; } catch { end(1, 'els: malformed frame from the els server'); return; }
    if (value.type === 'frame' && typeof value.screen === 'string') {
      handlers.onFrame({ pane: String(value.pane), seq: Number(value.seq), cols: Number(value.cols), rows: Number(value.rows), screen: value.screen });
    } else if (value.type === 'end') end(value.exitCode ?? 0, value.message ?? '');
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
    detach: () => { if (!ended) { ended = true; socket.destroy(); } },
  };
}
