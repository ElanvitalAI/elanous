// Sends one event frame over a unix socket and waits for the one answer line. Neutral: knows the wire, not the host.
import { createConnection } from 'node:net';
import type { AgentEventFrame } from './protocol.js';

// 출처: same bound as the els client (src/els/client.ts REQUEST_TIMEOUT_MS): a local socket answers at once; a host that is
// silent for this long is given up on so the emitter's ordered chain keeps moving.
const ANSWER_TIMEOUT_MS = 10_000;

export interface FrameAnswer { readonly exitCode: number; readonly message: string }
export type SendFrame = (socketPath: string, frame: AgentEventFrame) => Promise<FrameAnswer>;

export const sendFrameOverSocket: SendFrame = (socketPath, frame) => new Promise((resolve) => {
  let buffered = '';
  let settled = false;
  const socket = createConnection(socketPath);
  const done = (answer: FrameAnswer): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(answer);
  };
  const timer = setTimeout(() => done({ exitCode: 1, message: 'event host did not answer' }), ANSWER_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    // terra must 3 (#38499): a frame that cannot serialize (BigInt in meta, a cycle) fails THIS frame only — never an
    // uncaught throw out of the socket callback that would escape the promise chain.
    try { socket.write(`${JSON.stringify(frame)}\n`); } catch { done({ exitCode: 1, message: 'event frame failed to serialize' }); }
  });
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    const end = buffered.indexOf('\n');
    if (end < 0) return;
    try { const answer = JSON.parse(buffered.slice(0, end)) as { exitCode?: unknown; message?: unknown };
      done({ exitCode: typeof answer.exitCode === 'number' ? answer.exitCode : 1, message: String(answer.message ?? '') }); }
    catch { done({ exitCode: 1, message: 'event host answered with a malformed line' }); }
  });
  socket.on('error', (error) => done({ exitCode: 1, message: error.message }));
  socket.on('close', () => done({ exitCode: 1, message: 'event host closed the connection' }));
});
