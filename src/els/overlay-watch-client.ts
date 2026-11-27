// ELS-ZAXIS — the attach app's side of `overlay-watch`: one long connection, the stack at once and on every change.
// Same credential contract as subscribe-client. An older server (no overlay-watch) simply ends the stream: no overlays.

import { createConnection } from 'node:net';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { elsSocketPathProblem } from './server.js';
import { parseStack, type OverlayStack } from './overlay-stack.js';
import { createLineDecoder } from './wire.js';

// 출처: #40244 ELS-ELN-LAYERS §2-4 — a dropped stream (server restart) is re-opened after this pause, never busy-looped.
const RECONNECT_MS = 2_000;

export function watchOverlays(socketPath: string, onStack: (stack: OverlayStack) => void): { readonly close: () => void } {
  let closed = false;
  let socket: ReturnType<typeof createConnection> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = (): void => {
    if (closed || elsSocketPathProblem(socketPath)) return;
    let refused = false;
    const conn = createConnection(socketPath);
    socket = conn;
    const token = process.env[AUTH_PANE_TOKEN_ENV] ?? process.env[AUTH_OWNER_TOKEN_ENV];
    if (token) conn.write(`${JSON.stringify({ op: 'auth', token, pid: process.pid })}\n`);
    conn.write(`${JSON.stringify({ op: 'overlay-watch' })}\n`);
    const lines = createLineDecoder((line) => {
      let value: { type?: string; stack?: unknown; message?: string };
      try { value = JSON.parse(line) as typeof value; } catch { return; }
      if (value.type === 'overlay') { const stack = parseStack(value.stack); if (stack && !closed) onStack(stack); }
      else if (value.type === undefined && typeof value.message === 'string' && !value.message.startsWith('auth: ')) { refused = true; conn.destroy(); }
    });
    conn.on('data', (chunk: Buffer) => lines.push(chunk));
    conn.on('error', () => { /* close follows */ });
    conn.on('close', () => {
      if (closed || refused) return;                         // an older server refused overlay-watch: stay without overlays
      retry = setTimeout(open, RECONNECT_MS);
      retry.unref?.();
    });
  };
  open();
  return { close: () => { closed = true; if (retry) clearTimeout(retry); socket?.destroy(); } };
}
