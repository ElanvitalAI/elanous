// els client — what `els ls/new/read/send` run: one request to the els server, one answer. It never touches the
// journal and never starts a server (the supervisor runs `els serve`).

import { createConnection } from 'node:net';
import type { ElsResult } from './core.js';
import { elsSocketPathProblem, type ElsRequest } from './server.js';
import { createLineDecoder } from './wire.js';

// 출처: a request ends when the server renders a screen or spawns a PTY; both answer in well under a few seconds,
// and a server that does not answer in this time is reported, not waited on.
const REQUEST_TIMEOUT_MS = 10_000;

const NO_SERVER = 'els: no els server is running — start it with `els serve` (or `elanous side serve`)';

/** The inherited pane credential — a pane's env carries the server-minted token, so the door can judge the request. */
function paneAuth(credential?: string): ElsRequest | undefined {
  const token = process.env.ELANOUS_ELS_PANE_TOKEN ?? process.env.ELANOUS_ELS_OWNER_TOKEN ?? credential;
  return token ? { op: 'auth', token, pid: process.pid } : undefined;
}

export function requestEls(socketPath: string, request: ElsRequest, timeoutMs = REQUEST_TIMEOUT_MS, credential?: string): Promise<ElsResult> {
  const tooLong = elsSocketPathProblem(socketPath);
  if (tooLong) return Promise.resolve({ exitCode: 1, message: tooLong });
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const auth = paneAuth(credential);
    let awaitingAck = Boolean(auth);
    const done = (result: ElsResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ exitCode: 1, message: `els: the els server did not answer within ${timeoutMs} ms` }), timeoutMs);
    socket.on('connect', () => {
      if (auth) socket.write(`${JSON.stringify(auth)}\n`);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    const lines = createLineDecoder((line) => {
      if (awaitingAck) { awaitingAck = false; return; } // the auth ack line — the answer comes on the next line
      try { done(JSON.parse(line) as ElsResult); }
      catch { done({ exitCode: 1, message: 'els: malformed answer from the els server' }); }
    });
    socket.on('data', (chunk: Buffer) => lines.push(chunk));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      done(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? { exitCode: 1, message: NO_SERVER } : { exitCode: 1, message: `els: ${error.message}` });
    });
    socket.on('close', () => done({ exitCode: 1, message: 'els: the els server closed the connection without an answer' }));
  });
}
