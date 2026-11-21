// els client — what `els ls/new/read/send` run: one request to the els server, one answer. It never touches the
// journal and never starts a server (the supervisor runs `els serve`).

import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import type { ElsResult } from './core.js';
import { elsSocketPathProblem, type ElsRequest } from './server.js';
import { createLineDecoder } from './wire.js';

// 출처: a request ends when the server renders a screen or spawns a PTY; both answer in well under a few seconds,
// and a server that does not answer in this time is reported, not waited on.
const REQUEST_TIMEOUT_MS = 10_000;

const NO_SERVER = 'els: no els server is running — start it with `els serve` (or `elanous side serve`)';

/** The inherited pane credential — a pane's env carries the server-minted token, so the door can judge the request. */
function paneAuth(socketPath: string, credential?: string): ElsRequest | undefined {
  const token = process.env.ELANOUS_ELS_PANE_TOKEN ?? process.env.ELANOUS_ELS_OWNER_TOKEN ?? credential;
  let runtimeToken: string | undefined;
  const path = process.env.ELANOUS_ELS_RUNTIME_TOKEN_FILE || join(dirname(socketPath), 'runtime-token');
  if (path) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size <= 256)
        runtimeToken = readFileSync(fd, 'utf8').trim() || undefined;
    } catch { /* absent or unsafe credential is not authority */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return token || runtimeToken ? { op: 'auth', ...(token ? { token } : {}), ...(runtimeToken ? { runtimeToken } : {}), pid: process.pid } : undefined;
}

/** Only the protocol's result shape is evidence of a server answer. */
function isResult(value: unknown): value is ElsResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 2)
    && typeof result.message === 'string'
    && (result.queued === undefined || (typeof result.queued === 'number' && Number.isInteger(result.queued) && result.queued >= 0));
}

export function requestEls(socketPath: string, request: ElsRequest, timeoutMs = REQUEST_TIMEOUT_MS, credential?: string): Promise<ElsResult> {
  const tooLong = elsSocketPathProblem(socketPath);
  if (tooLong) return Promise.resolve({ exitCode: 1, message: tooLong, transport: { outcome: 'not-sent', reason: 'path' } });
  return new Promise((resolve) => {
    let socket: ReturnType<typeof createConnection>;
    try { socket = createConnection(socketPath); }
    catch (error) {
      resolve({ exitCode: 1, message: `els: ${error instanceof Error ? error.message : String(error)}`, transport: { outcome: 'not-sent', reason: 'connect' } });
      return;
    }
    let settled = false;
    // Once write is attempted, even a synchronous failure cannot prove the peer received no bytes.
    let writeAttempted = false;
    const auth = paneAuth(socketPath, credential);
    let awaitingAck = Boolean(auth);
    const done = (result: ElsResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const failure = (message: string, reason: 'timeout' | 'disconnect'): void => done({ exitCode: 1, message,
      transport: writeAttempted ? { outcome: 'unknown', reason } : { outcome: 'not-sent', reason } });
    const malformed = (): void => done({ exitCode: 1, message: 'els: malformed answer from the els server', transport: { outcome: 'unknown', reason: 'malformed' } });
    const timer = setTimeout(() => failure(`els: the els server did not answer within ${timeoutMs} ms`, 'timeout'), timeoutMs);
    socket.on('connect', () => {
      try {
        if (auth) socket.write(`${JSON.stringify(auth)}\n`);
        let outgoing = request;
        if (request.op === 'seat-set' && !request.runtime && process.env.ELN_SEAT_RUNTIME) {
          try { outgoing = { ...request, runtime: JSON.parse(process.env.ELN_SEAT_RUNTIME) }; }
          catch { /* malformed declarations are rejected by the server */ }
        }
        const serialized = `${JSON.stringify(outgoing)}\n`;
        writeAttempted = true;
        socket.write(serialized);
      } catch (error) {
        failure(`els: ${error instanceof Error ? error.message : String(error)}`, 'disconnect');
      }
    });
    const lines = createLineDecoder((line) => {
      if (settled) return;
      let value: unknown;
      try { value = JSON.parse(line); } catch { malformed(); return; }
      if (!isResult(value)) { malformed(); return; }
      if (awaitingAck) {
        if (!value.message.startsWith('auth: ')) { malformed(); return; }
        if (value.exitCode !== 0) { done({ ...value, transport: { outcome: 'answered' } }); return; }
        awaitingAck = false;
        return;
      }
      // Never trust a transport field received from the wire.
      done({ ...value, transport: { outcome: 'answered' } });
    });
    socket.on('data', (chunk: Buffer) => lines.push(chunk));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const message = error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? NO_SERVER : `els: ${error.message}`;
      if (!writeAttempted) done({ exitCode: 1, message, transport: { outcome: 'not-sent', reason: 'connect' } });
      else failure(message, 'disconnect');
    });
    socket.on('close', () => failure('els: the els server closed the connection without an answer', 'disconnect'));
  });
}
