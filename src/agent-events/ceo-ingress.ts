// CEO-CHANNEL-INGRESS ②③ — the els → eln REVERSE direction of the #39370 agent-event bridge.
//
// Design: ~/elanous-hq/seat-state/OP/OP-CHANNEL-INGRESS-1121.md §② §③. A CEO writes to OP over telegram/discord; the
// els chat ingress (TC-H-CC-1, ①) validates from=CEO and persists to the disk queue, then hands the envelope here.
// ② This module injects it as an AGENT EVENT into the OP seat's eln session (front of the current turn — the sink IS
//    the session's turn-input door), not as shell typing.
// ③ Receipts are honest only: 👀 when the session actually consumes the frame (ackSeen — never at delivery/queue time),
//    ⚙️ while OP writes the answer, ✅ when the answer is sent. 30 s without 👀 → 'pending-red' (대표 대기 글 빨강);
//    5 min without ✅ → the SAME event is handed to the RES session plus a «⏰ OP 무응답 5분 · RES 대신 받음» notice in
//    the same thread; a late ✅ cancels the RES takeover and clears every timer.
//
// Why a new socket instead of the existing ELANOUS_EVENT_SOCKET: that wire is one-way (the eln core is the CLIENT — it
// connects per frame, emits, reads one answer, closes; protocol.ts:5-8), so the els host cannot push to the core over
// it. The core therefore HOSTS a ceo socket (ELANOUS_CEO_INGRESS_SOCKET, put in the seat tab's env by els) and els
// pushes over the SAME transport conventions — one JSON frame per line, one JSON answer line (transport.ts) — just
// with the roles flipped. Neutral module like protocol.ts: no els, no eln-core imports; both sides may import it.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { sendFrameOverSocket, type FrameAnswer, type SendCeoFrame } from './transport.js';

export const CEO_INGRESS_PROTOCOL_VERSION = 1 as const;
export const ENV_CEO_INGRESS_SOCKET = 'ELANOUS_CEO_INGRESS_SOCKET';
/** ① JUD hold(15:58) #39407 mustFix ① — els 가 이 세션 탭 env 에 내려주는 생산자 인증 비밀( ceo 소켓을 만든
 *  같은 설치 문맥 소유). 리스너는 이 비밀로 프레임 서명을 검증한다: 비밀 부재 → 모든 프레임 거부(fail-closed). */
export const ENV_CEO_INGRESS_AUTH = 'ELANOUS_CEO_INGRESS_AUTH';
export const CEO_ESCALATION_TEXT = '⏰ OP 무응답 5분 · RES 대신 받음';
export const CEO_RED_AFTER_MS = 30_000;      // ③ 30초 안 👀 없음 → 빨강
export const CEO_ESCALATE_AFTER_MS = 300_000; // ③ 5분 안 ✅ 없음 → RES 대행
/**
 * JUD hold #122410 mustFix — the ceo listener HOLDS its answer until the frame is really consumed
 * as turn input (the entry wires the queue's delivered transition in), so the default 10 s answer
 * bound (transport.ts ANSWER_TIMEOUT_MS) would refuse every frame queued behind a busy session
 * long before its idle boundary drains it. The ceo producer is fire-and-forget per frame — there
 * is no ordered chain to keep moving — so it waits a bounded 15 min instead (past the 5 min RES
 * takeover); a consumption slower than that leaves the SLA telling the truth (🔴 → ⏰), never 👀.
 */
export const CEO_ANSWER_TIMEOUT_MS = 900_000;
export const OP_SEAT = 'OP';
export const RES_SEAT = 'RES';

export type CeoSource = 'telegram' | 'discord';
export const CEO_SOURCES: readonly CeoSource[] = ['telegram', 'discord'];
export interface CeoAttachment { readonly name: string; readonly url: string }
export interface CeoEnvelope {
  readonly source: CeoSource;
  readonly sender: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly attachments?: readonly CeoAttachment[];
}

export type CeoIngressEvent =
  | { readonly kind: 'ceo-message'; readonly source: CeoSource; readonly sender: string; readonly threadId: string; readonly messageId: string; readonly text: string; readonly attachments?: readonly CeoAttachment[] }
  | { readonly kind: 'ceo-escalation'; readonly threadId: string; readonly messageId: string; readonly text: string }
  | { readonly kind: 'ceo-takeover-cancel'; readonly threadId: string; readonly messageId: string };

export interface CeoIngressFrame {
  readonly op: 'ceo';
  readonly v: typeof CEO_INGRESS_PROTOCOL_VERSION;
  readonly ws: string;
  /** The seat tab this frame is pushed into, when the sink knows it. */
  readonly pane?: string;
  readonly seq: number;
  readonly at: number;
  readonly event: CeoIngressEvent;
}

export type ParsedCeoFrame =
  | { readonly ok: true; readonly frame: CeoIngressFrame }
  /** `ignore` = a well-formed frame this reader does not know (newer version or kind): skip it, keep going. */
  | { readonly ok: false; readonly ignore: boolean; readonly reason: string };

const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' ? value.slice(0, max) : undefined);
// Hostile frames can throw from a plain field read (protocol.ts:51-54): a reason must never become a crash.
const shown = (value: unknown): string => { try { return String(value).slice(0, 40); } catch { return 'unprintable'; } };
const optional = <K extends string>(key: K, value: string | undefined): { [P in K]: string } | Record<never, never> =>
  value === undefined ? {} : { [key]: value } as { [P in K]: string };

// ── envelope (② input shape: {source, sender, threadId, messageId, text, attachments}) ─────────────────────────────
type EnvelopeFields = Omit<CeoEnvelope, never>;
const parseEnvelopeFields = (e: Record<string, unknown>): { ok: true; fields: EnvelopeFields } | { ok: false; reason: string } => {
  const source = CEO_SOURCES.find((candidate) => candidate === e.source);
  if (!source) return { ok: false, reason: 'unknown source' };
  const sender = text(e.sender, 128);
  if (!sender) return { ok: false, reason: 'envelope needs sender' };
  const threadId = text(e.threadId, 128);
  if (!threadId) return { ok: false, reason: 'envelope needs threadId' };
  const messageId = text(e.messageId, 200);
  if (!messageId) return { ok: false, reason: 'envelope needs messageId' };
  const body = text(e.text, 4000);
  if (!body) return { ok: false, reason: 'envelope needs text' };
  const rawAttachments = Array.isArray(e.attachments) ? e.attachments.slice(0, 8) : [];
  const attachments: CeoAttachment[] = [];
  for (const raw of rawAttachments) {
    const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const name = a ? text(a.name, 200) : undefined;
    const url = a ? text(a.url, 1000) : undefined;
    if (name && url) attachments.push({ name, url }); // a malformed attachment drops (lenient), the message still lands
  }
  return { ok: true, fields: { source, sender, threadId, messageId, text: body, ...(attachments.length ? { attachments } : {}) } };
};

/** Validate one CEO envelope (`submit` input). Bounds every string; never throws. */
export function parseCeoEnvelope(raw: unknown): { ok: true; envelope: CeoEnvelope } | { ok: false; reason: string } {
  try {
    const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    if (!e) return { ok: false, reason: 'not an envelope' };
    const parsed = parseEnvelopeFields(e);
    return parsed.ok ? { ok: true, envelope: parsed.fields } : { ok: false, reason: parsed.reason };
  } catch { return { ok: false, reason: 'envelope could not be read' }; }
}

// ── frame parser (mirrors protocol.ts readFrame: never throws, ignore-unknown) ─────────────────────────────────────
export function parseCeoIngressFrame(raw: unknown): ParsedCeoFrame {
  try { return readCeoFrame(raw); } catch { return { ok: false, ignore: false, reason: 'frame could not be read' }; }
}

function readCeoFrame(raw: unknown): ParsedCeoFrame {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!f || f.op !== 'ceo') return { ok: false, ignore: false, reason: 'not a ceo frame' };
  if (f.v !== CEO_INGRESS_PROTOCOL_VERSION) return { ok: false, ignore: true, reason: `unknown protocol version ${shown(f.v)}`.slice(0, 64) };
  const ws = text(f.ws, 128);
  if (!ws || typeof f.seq !== 'number' || !Number.isSafeInteger(f.seq) || f.seq < 1 || typeof f.at !== 'number' || !Number.isFinite(f.at)) {
    return { ok: false, ignore: false, reason: 'frame needs ws, seq and at' };
  }
  const e = f.event && typeof f.event === 'object' && !Array.isArray(f.event) ? f.event as Record<string, unknown> : undefined;
  if (!e || typeof e.kind !== 'string') return { ok: false, ignore: false, reason: 'frame has no event.kind' };
  const base = { op: 'ceo' as const, v: CEO_INGRESS_PROTOCOL_VERSION, ws, seq: f.seq, at: f.at, ...optional('pane', text(f.pane, 128)) };
  switch (e.kind) {
    case 'ceo-message': {
      const parsed = parseEnvelopeFields(e);
      return parsed.ok ? { ok: true, frame: { ...base, event: { kind: 'ceo-message', ...parsed.fields } } } : { ok: false, ignore: false, reason: parsed.reason };
    }
    case 'ceo-escalation': {
      const threadId = text(e.threadId, 128);
      const messageId = text(e.messageId, 200);
      const body = text(e.text, 200);
      if (!threadId || !messageId || !body) return { ok: false, ignore: false, reason: 'ceo-escalation: needs threadId, messageId and text' };
      return { ok: true, frame: { ...base, event: { kind: 'ceo-escalation', threadId, messageId, text: body } } };
    }
    case 'ceo-takeover-cancel': {
      const threadId = text(e.threadId, 128);
      const messageId = text(e.messageId, 200);
      if (!threadId || !messageId) return { ok: false, ignore: false, reason: 'ceo-takeover-cancel: needs threadId and messageId' };
      return { ok: true, frame: { ...base, event: { kind: 'ceo-takeover-cancel', threadId, messageId } } };
    }
    default: return { ok: false, ignore: true, reason: `unknown ceo event kind ${e.kind.slice(0, 40)}` };
  }
}

// ── ③ receipts ─────────────────────────────────────────────────────────────────────────────────────────────────────
export type CeoReceipt = 'pending' | 'seen' | 'answering' | 'answered' | 'pending-red' | 'res-took-over';
/** The chat-channel reaction for each receipt (③ 👀 ⚙️ ✅ · 🔴 대기 빨강 · ⏰ RES 대행). '' = nothing to post yet. */
export const CEO_RECEIPT_GLYPH: Readonly<Record<CeoReceipt, string>> = {
  pending: '', seen: '👀', answering: '⚙️', answered: '✅', 'pending-red': '🔴', 'res-took-over': '⏰',
};

/** Injectable clock (③): tests never wait a real 30 s / 5 min. */
export interface CeoClock { now(): number; after(ms: number, run: () => void): unknown; cancel(handle: unknown): void }
export const ceoRealClock: CeoClock = {
  now: () => Date.now(),
  after: (ms, run) => { const t = setTimeout(run, ms); (t as { unref?: () => void }).unref?.(); return t; },
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** The one door a CEO message is pushed through into a seat's eln session. The els side provides the OP/RES impls;
 *  a real tab uses socketCeoSink (the core's ceo socket), tests use fakes. */
export interface CeoSessionSink { send(frame: CeoIngressFrame): Promise<void> | void }

interface CeoPending {
  receipt: CeoReceipt;
  envelope: CeoEnvelope;
  red?: unknown;
  escalate?: unknown;
  tookOver: boolean;
}

export interface CeoIngressOpts {
  readonly ws: string;
  readonly opSeat?: string;
  readonly resSeat?: string;
  /** CEO identities (telegram/discord user or chat ids) allowed to speak as the CEO. Everything else is discarded. */
  readonly allowedSenders: readonly string[];
  /** Seat → session sink. `undefined` = no such session right now (the SLA still runs). */
  readonly sessions: (seat: string) => CeoSessionSink | undefined;
  readonly clock?: CeoClock;
  readonly redAfterMs?: number;
  readonly escalateAfterMs?: number;
  /** Status callback — the same refKey triple as ackSeen (JUD hold(15:58) ②: source + threadId + messageId together). */
  readonly onStatus?: (source: CeoSource, threadId: string, messageId: string, receipt: CeoReceipt) => void;
}

export type CeoSubmitResult = { readonly ok: true; readonly messageId: string } | { readonly ok: false; readonly reason: string };

export interface CeoIngress {
  /** Validate (from=CEO allow-list), dedup by source+thread+message, inject into the OP session, arm the ③ SLA timers. */
  submit(raw: unknown): CeoSubmitResult;
  /** Retry an unaccepted frame after a socket or seat restart without creating a second pending receipt. */
  retryPending(source: CeoSource, threadId: string, messageId: string): boolean;
  /** ② 👀 — the OP session consumed the frame as turn input. The ONLY thing that turns the receipt seen.
   *  JUD hold(15:58) ②: keyed by source + authenticated conversation identity (threadId) + messageId TOGETHER. */
  ackSeen(source: CeoSource, threadId: string, messageId: string): boolean;
  /** ⚙️ OP is writing the answer — same triple key. */
  markAnswering(source: CeoSource, threadId: string, messageId: string): boolean;
  /** ✅ the answer went out — cancel timers, stop the RES takeover (sends ceo-takeover-cancel if RES had taken over). */
  markAnswered(source: CeoSource, threadId: string, messageId: string): boolean;
  status(source: CeoSource, threadId: string, messageId: string): CeoReceipt | undefined;
  dispose(): void;
}

export function createCeoIngress(opts: CeoIngressOpts): CeoIngress {
  const clock = opts.clock ?? ceoRealClock;
  const redAfter = opts.redAfterMs ?? CEO_RED_AFTER_MS;
  const escalateAfter = opts.escalateAfterMs ?? CEO_ESCALATE_AFTER_MS;
  const opSeat = opts.opSeat ?? OP_SEAT;
  const resSeat = opts.resSeat ?? RES_SEAT;
  const allowed = new Set(opts.allowedSenders);
  const pending = new Map<string, CeoPending>();
  // JUD hold(15:58) ② — bare messageId keys collide across conversations: source + threadId + messageId TOGETHER.
  const refKey = (source: CeoSource, threadId: string, messageId: string): string => `${source}::${threadId}::${messageId}`;
  let seq = 0;
  const make = (event: CeoIngressEvent): CeoIngressFrame => {
    seq += 1;
    return { op: 'ceo', v: CEO_INGRESS_PROTOCOL_VERSION, ws: opts.ws, seq, at: clock.now(), event };
  };
  // Fail-soft like emit.ts:4: a missing session or a throwing sink never reaches submit; the SLA still runs.
  const push = (seat: string, event: CeoIngressEvent): void => {
    const sink = opts.sessions(seat);
    if (!sink) return;
    try { void Promise.resolve(sink.send(make(event))).catch(() => { /* no session: red/RES still tell the truth */ }); }
    catch { /* same */ }
  };
  const set = (p: CeoPending, receipt: CeoReceipt): void => {
    p.receipt = receipt;
    opts.onStatus?.(p.envelope.source, p.envelope.threadId, p.envelope.messageId, receipt);
  };
  const clearTimers = (p: CeoPending): void => {
    if (p.red !== undefined) { clock.cancel(p.red); p.red = undefined; }
    if (p.escalate !== undefined) { clock.cancel(p.escalate); p.escalate = undefined; }
  };
  const escalateNow = (p: CeoPending): void => {
    p.escalate = undefined;
    if (p.receipt === 'answered' || p.tookOver) return;
    p.tookOver = true;
    push(resSeat, { kind: 'ceo-message', ...p.envelope }); // RES 탭에 같은 이벤트 전달
    push(resSeat, { kind: 'ceo-escalation', threadId: p.envelope.threadId, messageId: p.envelope.messageId, text: CEO_ESCALATION_TEXT });
    set(p, 'res-took-over');
  };
  return {
    submit: (raw) => {
      const parsed = parseCeoEnvelope(raw);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      const envelope = parsed.envelope;
      // ② from=OP 위장 0: internal seats can never be the CEO, and only the allow-list can.
      if (envelope.sender === OP_SEAT || envelope.sender === RES_SEAT || !allowed.has(envelope.sender)) {
        return { ok: false, reason: 'sender not in ceo allow-list' };
      }
      const k = refKey(envelope.source, envelope.threadId, envelope.messageId);
      if (pending.has(k)) return { ok: false, reason: 'duplicate message in this conversation' };
      const p: CeoPending = { receipt: 'pending', envelope, tookOver: false };
      pending.set(k, p);
      set(p, 'pending');
      push(opSeat, { kind: 'ceo-message', ...envelope }); // ② front of the OP session's current turn input
      p.red = clock.after(redAfter, () => { p.red = undefined; if (p.receipt === 'pending') set(p, 'pending-red'); });
      p.escalate = clock.after(escalateAfter, () => escalateNow(p));
      return { ok: true, messageId: envelope.messageId };
    },
    retryPending: (source, threadId, messageId) => {
      const p = pending.get(refKey(source, threadId, messageId));
      if (!p || (p.receipt !== 'pending' && p.receipt !== 'pending-red')) return false;
      push(opSeat, { kind: 'ceo-message', ...p.envelope });
      return true;
    },
    ackSeen: (source, threadId, messageId) => {
      const p = pending.get(refKey(source, threadId, messageId));
      if (!p || p.receipt === 'answered') return false;
      if (p.red !== undefined) { clock.cancel(p.red); p.red = undefined; }
      if (p.receipt === 'pending' || p.receipt === 'pending-red') set(p, 'seen');
      return true; // already seen / answering / taken over: the eyes moment is still the truth, no state to change
    },
    markAnswering: (source, threadId, messageId) => {
      const p = pending.get(refKey(source, threadId, messageId));
      if (!p || p.receipt === 'answered') return false;
      if (p.receipt === 'pending' || p.receipt === 'pending-red' || p.receipt === 'seen') set(p, 'answering');
      return true;
    },
    markAnswered: (source, threadId, messageId) => {
      const p = pending.get(refKey(source, threadId, messageId));
      if (!p || p.receipt === 'answered') return false;
      clearTimers(p);
      if (p.tookOver) push(resSeat, { kind: 'ceo-takeover-cancel', threadId: p.envelope.threadId, messageId }); // RES 대행 중단
      set(p, 'answered');
      return true;
    },
    status: (source, threadId, messageId) => pending.get(refKey(source, threadId, messageId))?.receipt,
    dispose: () => { for (const p of pending.values()) clearTimers(p); pending.clear(); },
  };
}

// ── els-side sink over the #39370 wire conventions (transport.ts), roles flipped: els is the client, the core hosts ──
export interface SocketCeoSinkOpts {
  readonly socketPath: string;
  readonly ws: string;
  readonly pane?: string;
  /** ① JUD hold(15:58) — the els producer signs each frame with the TARGET session's per-tab secret
   *  (its ELANOUS_CEO_INGRESS_AUTH). The listener refuses unsigned frames (fail-closed). */
  readonly authSecret?: string;
  /** ② (r2 RED 수리) the ceo producer's seam stays ceo-narrow (SendCeoFrame) — the els emitter keeps SendFrame. */
  readonly send?: SendCeoFrame;
  /** ③ JUD hold(18:33 #121400) — the answer hook: the tab's answer (exitCode 0 = the frame became
   *  turn input, held until the queue's delivered transition — JUD hold #122410) is the honest 👀
   *  moment. els wires ackSeen here — never at send/queue time. */
  readonly onAnswer?: (answer: FrameAnswer, frame: CeoIngressFrame) => void;
}

/** ① JUD hold(15:58) — the canonical bytes a ceo frame is signed over (op·v·ws·pane·seq·at·event, fixed key order). */
export function ceoFrameAuthData(frame: CeoIngressFrame): string {
  return JSON.stringify({ op: frame.op, v: frame.v, ws: frame.ws, pane: frame.pane ?? '', seq: frame.seq, at: frame.at, event: frame.event });
}

/** ① the producer's signature: HMAC-SHA256(secret, ceoFrameAuthData(frame)) as hex. */
export function ceoFrameAuth(frame: CeoIngressFrame, secret: string): string {
  return createHmac('sha256', secret).update(ceoFrameAuthData(frame), 'utf8').digest('hex');
}

/** ① the listener's verify: the raw line's `auth` must equal the HMAC over the PARSED frame's canonical bytes.
 *  A hostile raw object never throws here (every read is guarded); a mismatch/absence = refusal. */
const ceoFrameAuthOk = (frame: CeoIngressFrame, raw: unknown, secret: string): boolean => {
  let given: unknown;
  try { given = (raw as { auth?: unknown } | undefined)?.auth; } catch { return false; }
  if (typeof given !== 'string') return false;
  try {
    const expected = Buffer.from(ceoFrameAuth(frame, secret), 'utf8');
    const givenBuf = Buffer.from(given, 'utf8');
    return expected.length === givenBuf.length && timingSafeEqual(expected, givenBuf);
  } catch { return false; }
};

export function socketCeoSink(opts: SocketCeoSinkOpts): CeoSessionSink {
  // JUD hold #122410 — the held answer waits out the ceo bound (15 min), not the agent-event
  // emitter's 10 s default (transport.ts ANSWER_TIMEOUT_MS): a frame queued behind a busy
  // session is consumed late, not never — and this producer is fire-and-forget per frame.
  const send: SendCeoFrame = opts.send
    ?? ((socketPath, frame) => sendFrameOverSocket(socketPath, frame, { answerTimeoutMs: CEO_ANSWER_TIMEOUT_MS }));
  return {
    send: (frame) => {
      const withPane = opts.pane ? { ...frame, pane: opts.pane } : frame;
      // ① sign with the target tab's secret: the producer is authenticated per frame, not per connection.
      const out = opts.authSecret !== undefined ? { ...withPane, auth: ceoFrameAuth(withPane, opts.authSecret) } : withPane;
      // ③ the answer (exitCode 0 = consumed as turn input) is the only honest 👀 moment.
      void send(opts.socketPath, out).then((answer) => { opts.onAnswer?.(answer, withPane); }, () => { /* the tab is gone: red/RES still tell the truth */ });
    },
  };
}

// ── core-side listener: the eln session HOSTS the ceo socket; onFrame is the turn-input door (front of the turn) ────
export interface CeoIngressListener { readonly socketPath: string; close(): Promise<void> }
export interface CeoAcceptedTurn { readonly sessionId: string; readonly turnRunId: string }

export function createCeoIngressListener(opts: {
  readonly socketPath: string;
  /** ① JUD hold(15:58) mustFix ① — els installs this per-tab secret in the session env (ELANOUS_CEO_INGRESS_AUTH).
   *  It authenticates the producer (only els holds it) AND authorizes the destination: the secret is scoped to THIS
   *  session's tab, so a frame signed for any other session cannot verify here. Absent secret → EVERY frame is refused
   *  (fail-closed): the turn-input door never opens for an unauthenticated producer. */
  readonly authSecret?: string;
  /** The eln session's consumption hook — where a ceo frame becomes turn input. Called per valid, authenticated frame, in arrival order. */
  readonly onFrame: (frame: CeoIngressFrame) => void | CeoAcceptedTurn | Promise<void | CeoAcceptedTurn>;
}): Promise<CeoIngressListener> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.on('connection', (socket) => {
      let buffered = '';
      socket.setEncoding('utf8');
      const answer = (exitCode: number, message: string): void => {
        try { socket.write(`${JSON.stringify({ exitCode, message })}\n`); } catch { /* the client is gone: nothing to do */ }
      };
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        let end = buffered.indexOf('\n');
        while (end >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          let raw: unknown;
          try { raw = JSON.parse(line); } catch { answer(1, 'not json'); end = buffered.indexOf('\n'); continue; }
          const parsed = parseCeoIngressFrame(raw);
          if (!parsed.ok) { answer(parsed.ignore ? 0 : 1, parsed.reason); end = buffered.indexOf('\n'); continue; } // ignore → answered, skipped
          // ① JUD hold(15:58) — authenticate the producer (and thereby this frame's destination) BEFORE the
          // turn-input hook. No secret in this session env, or a bad/absent signature → refused, onFrame untouched.
          if (typeof opts.authSecret !== 'string' || !ceoFrameAuthOk(parsed.frame, raw, opts.authSecret)) {
            answer(1, 'unauthorized producer');
            end = buffered.indexOf('\n');
            continue;
          }
          void Promise.resolve(opts.onFrame(parsed.frame)).then(
            (turn) => answer(0, turn ? JSON.stringify(turn) : 'ok'),
            (error: unknown) => answer(1, error instanceof Error ? error.message.slice(0, 200) : 'ceo consumer threw'),
          );
          end = buffered.indexOf('\n');
        }
      });
      socket.on('error', () => socket.destroy());
    });
    // A stale socket file from a dead tab blocks the bind (EADDRINUSE): remove it best-effort —
    // a live listener keeps serving its inode; the bind failure is the honest outcome then.
    try { if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath); } catch { /* listen reports */ }
    server.listen(opts.socketPath, () => resolve({
      socketPath: opts.socketPath,
      close: () => new Promise<void>((res) => server.close(() => {
        try { if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath); } catch { /* best-effort */ }
        res();
      })),
    }));
  });
}

/** The eln-core one-call wiring point: hosts the ceo socket when els put ELANOUS_CEO_INGRESS_SOCKET in the tab env. */
export async function startCeoIngressFromEnv(
  env: NodeJS.ProcessEnv,
  onFrame: (frame: CeoIngressFrame) => void | CeoAcceptedTurn | Promise<void | CeoAcceptedTurn>,
): Promise<CeoIngressListener | undefined> {
  const socketPath = env[ENV_CEO_INGRESS_SOCKET]?.trim() ?? '';
  const authSecret = env[ENV_CEO_INGRESS_AUTH]?.trim() ?? '';
  return socketPath ? createCeoIngressListener({ socketPath, authSecret: authSecret || undefined, onFrame }) : undefined;
}
