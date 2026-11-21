// Sends one event frame over a unix socket and waits for the one answer line. Neutral: knows the wire, not the host.
// CEO-CHANNEL-INGRESS ② (r2 RED 수리): the wire conventions stay direction-agnostic — els also uses this client when it
// PUSHES a ceo frame to the core-hosted socket (src/agent-events/ceo-ingress.ts) — but each consumer's seam stays NARROW
// (SendFrame = agent frames for the els emitter, SendCeoFrame = ceo frames for the ceo producer): the union never leaks
// into els callers' send callbacks (src/els/agent-events.test.ts TS2345).
import { createConnection } from 'node:net';
import type { AgentEventFrame } from './protocol.js';
import type { CeoIngressFrame } from './ceo-ingress.js';

// 출처: same bound as the els client (src/els/client.ts REQUEST_TIMEOUT_MS): a local socket answers at once; a host that is
// silent for this long is given up on so the emitter's ordered chain keeps moving.
const ANSWER_TIMEOUT_MS = 10_000;

export interface FrameAnswer { readonly exitCode: number; readonly message: string }
/** The els emitter's seam (emit.ts opts.send): agent-event frames only. */
export type SendFrame = (socketPath: string, frame: AgentEventFrame) => Promise<FrameAnswer>;
/** The ceo producer's seam (ceo-ingress.ts opts.send): ceo frames over the same wire. */
export type SendCeoFrame = (socketPath: string, frame: CeoIngressFrame) => Promise<FrameAnswer>;
/**
 * A caller that HOLDS its answer (the ceo listener answers only at real turn-input consumption —
 * JUD hold #122410) passes its own bound: the default 10 s would cut a busy session's honest
 * consumption receipt off long before the idle boundary ever drains the queued frame.
 */
export interface SendFrameOpts { readonly answerTimeoutMs?: number }

/** Direction-agnostic wire client: accepts either frame kind; each caller's seam stays narrow. */
export const sendFrameOverSocket = <F extends AgentEventFrame | CeoIngressFrame>(
  socketPath: string, frame: F, opts: SendFrameOpts = {},
): Promise<FrameAnswer> => new Promise((resolve) => {
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
  const timer = setTimeout(() => done({ exitCode: 1, message: 'event host did not answer' }), opts.answerTimeoutMs ?? ANSWER_TIMEOUT_MS);
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
