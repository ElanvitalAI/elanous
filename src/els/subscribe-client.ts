// els subscribe client — one long connection that gets the list pushed (ELS-DESKTOP-SIDETAB-SUBSCRIBE). It follows the
// same credential contract as `requestEls`/`attachEls`: the pane or owner token goes first when the env has one, so the
// door can classify the caller; the op itself is read-only and also works for a no-token viewer.

import { createConnection } from 'node:net';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { elsSocketPathProblem } from './server.js';
import { createLineDecoder } from './wire.js';

export interface SubscribeHandlers {
  /** The server's `ls` answer message (JSON) — once at connect, then at each change. */
  readonly onList: (message: string) => void;
  /** The stream ended: the server went away, or does not know `subscribe` (an older server). Called once. */
  readonly onEnd: (reason: string) => void;
}

const NO_SERVER = 'els: no els server is running — start it with `els serve` (or `elanous side serve`)';

export function subscribeEls(socketPath: string, handlers: SubscribeHandlers): { readonly close: () => void } {
  let ended = false;
  const end = (reason: string): void => { if (!ended) { ended = true; handlers.onEnd(reason); } };
  const tooLong = elsSocketPathProblem(socketPath);
  if (tooLong) { queueMicrotask(() => end(tooLong)); return { close: () => {} }; }
  const socket = createConnection(socketPath);
  const write = (value: object): void => { if (!ended && !socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
  const token = process.env[AUTH_PANE_TOKEN_ENV] ?? process.env[AUTH_OWNER_TOKEN_ENV];
  if (token) write({ op: 'auth', token, pid: process.pid });
  write({ op: 'subscribe' });
  const lines = createLineDecoder((line) => {
    let value: { type?: string; exitCode?: number; message?: string };
    try { value = JSON.parse(line) as typeof value; } catch { end('els: malformed event from the els server'); return; }
    if (value.type === 'list' && typeof value.message === 'string') { if (!ended) handlers.onList(value.message); }
    // The auth ack is `{exitCode:0,message:'auth: …'}` without a type: skip it. Any other typeless answer (an older server's
    // «unknown request», a refusal) means no subscription.
    else if (value.type === undefined && typeof value.message === 'string' && value.message.startsWith('auth: ')) return;
    else { end(typeof value.message === 'string' ? value.message : 'els: subscribe refused'); socket.destroy(); }
  });
  socket.on('data', (chunk: Buffer) => lines.push(chunk));
  socket.on('error', (error: NodeJS.ErrnoException) => end(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? NO_SERVER : `els: ${error.message}`));
  socket.on('close', () => end('els: the els server closed the connection'));
  return { close: () => { if (!ended) ended = true; socket.destroy(); } };
}
