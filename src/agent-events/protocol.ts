// eln agent events — v1 of the wire between a running eln (the core) and whatever frames it (els, or any other host).
// The core only EMITS these (state, turn, meta, notice, child, release); it imports nothing from the frame. The frame
// (src/els/agent-events.ts) reads them. Neutral module: no els, no eln-core imports — both sides may import it.
//
// Wire: a unix socket, one JSON frame per line, one JSON answer line per frame:
//   {"op":"event","v":1,"ws":"OP","pane":"p123","sid":"6f1c…","seq":42,"at":1731900000000,"event":{"kind":"state","state":"working"}}
// The frame (host) puts the socket path and the pane's identity into the environment of what it spawns; without
// ELANOUS_EVENT_SOCKET there is no emitter at all and nothing touches a socket.

export const EVENT_PROTOCOL_VERSION = 1 as const;
export const ENV_EVENT_SOCKET = 'ELANOUS_EVENT_SOCKET';
export const ENV_EVENT_PANE = 'ELANOUS_EVENT_PANE';
export const ENV_EVENT_WS = 'ELANOUS_EVENT_WS';

export type AgentState = 'working' | 'idle' | 'blocked' | 'waiting-input' | 'done' | 'exited';
export const AGENT_STATES: readonly AgentState[] = ['working', 'idle', 'blocked', 'waiting-input', 'done', 'exited'];
export type ChildSourceName = 'subagent' | 'harness' | 'graph' | 'mission' | 'shell' | 'graph-node';
export const CHILD_SOURCES: readonly ChildSourceName[] = ['subagent', 'harness', 'graph', 'mission', 'shell', 'graph-node'];

export type AgentEvent =
  | { readonly kind: 'state'; readonly state: AgentState; readonly message?: string }
  | { readonly kind: 'turn'; readonly phase: 'start' | 'end'; readonly id: string }
  | { readonly kind: 'meta'; readonly model?: string; readonly queue?: number; readonly plan?: string; readonly elapsed?: string; readonly title?: string }
  | { readonly kind: 'notice'; readonly level: 'info' | 'warn' | 'alert'; readonly text: string }
  | { readonly kind: 'child'; readonly action: 'start' | 'progress' | 'status' | 'end'; readonly id: string; readonly source?: ChildSourceName;
      readonly label?: string; readonly parent?: string; readonly cwd?: string; readonly state?: 'working' | 'blocked' | 'idle';
      readonly line?: string; readonly ok?: boolean; readonly summary?: string }
  | { readonly kind: 'release' };

export interface AgentEventFrame {
  readonly op: 'event';
  readonly v: typeof EVENT_PROTOCOL_VERSION;
  /** The parent workspace (a name). */
  readonly ws: string;
  /** The pane the emitting eln runs in, when the host told it. */
  readonly pane?: string;
  /** The emitting process: random per emitter, so two processes in one pane (an inherited environment, a fast restart) are two senders. */
  readonly sid: string;
  /** Strictly increasing within one `sid` (1, 2, 3 …). The receiver drops a seq a sender has already passed. */
  readonly seq: number;
  readonly at: number;
  readonly event: AgentEvent;
}

export type ParsedFrame =
  | { readonly ok: true; readonly frame: AgentEventFrame }
  /** `ignore` = a well-formed frame this reader does not know (newer version or kind): skip it, keep going. */
  | { readonly ok: false; readonly ignore: boolean; readonly reason: string };

const text = (value: unknown, max: number): string | undefined => typeof value === 'string' ? value.slice(0, max) : undefined;
// terra must 1 (#38499): a hostile v can make String() itself throw (JSON can carry {"v": {"toString": null}}) — an unknown
// version must end as a reason, never as a crash.
// 출처: #38499 수용기준 — reason 안에 실측한 문자열을 그대로 담지 않는다: 40자 상한(아래 unknown-kind reason와 같은 근거).
const shown = (value: unknown): string => { try { return String(value).slice(0, 40); } catch { return 'unprintable'; } };
// A union (key present with a string, or absent) — not `key?: string | undefined`, which exactOptionalPropertyTypes refuses.
const optional = <K extends string>(key: K, value: string | undefined): { [P in K]: string } | Record<never, never> =>
  value === undefined ? {} : { [key]: value } as { [P in K]: string };

/** Validate one decoded frame. Bounds every string; never throws. */
export function parseEventFrame(raw: unknown): ParsedFrame {
  // terra must 1 (#38499): a hostile frame can throw from a plain field READ (a getter: { get op() { throw } }) — the promise
  // is "never throws", so any throw on the field-access path ends as a rejected frame, never as an escape into the caller.
  try { return readFrame(raw); } catch { return { ok: false, ignore: false, reason: 'frame could not be read' }; }
}

function readFrame(raw: unknown): ParsedFrame {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!f || f.op !== 'event') return { ok: false, ignore: false, reason: 'not an event frame' };
  if (f.v !== EVENT_PROTOCOL_VERSION) return { ok: false, ignore: true, reason: `unknown protocol version ${shown(f.v)}`.slice(0, 64) };
  const ws = text(f.ws, 128);
  const sid = text(f.sid, 80);
  // 출처: #38499 — v1 계약: 송신자별 seq 는 1부터(protocol.ts:39 계약 주석)
  if (!ws || !sid || typeof f.seq !== 'number' || !Number.isSafeInteger(f.seq) || f.seq < 1 || typeof f.at !== 'number' || !Number.isFinite(f.at)) {
    return { ok: false, ignore: false, reason: 'frame needs ws, sid, seq and at' };
  }
  const e = f.event && typeof f.event === 'object' && !Array.isArray(f.event) ? f.event as Record<string, unknown> : undefined;
  if (!e || typeof e.kind !== 'string') return { ok: false, ignore: false, reason: 'frame has no event.kind' };
  const base = { op: 'event' as const, v: 1 as const, ws, sid, seq: f.seq, at: f.at, ...optional('pane', text(f.pane, 128)) };
  switch (e.kind) {
    case 'state': {
      const state = AGENT_STATES.find((candidate) => candidate === e.state);
      if (!state) return { ok: false, ignore: false, reason: 'state: unknown state' };
      return { ok: true, frame: { ...base, event: { kind: 'state', state, ...optional('message', text(e.message, 200)) } } };
    }
    case 'turn': {
      if (e.phase !== 'start' && e.phase !== 'end') return { ok: false, ignore: false, reason: 'turn: phase must be start|end' };
      const turnId = text(e.id, 80); // 출처: #38499 — turn.id 필수, 코어시 폐지(terra must-3)
      if (!turnId) return { ok: false, ignore: false, reason: 'turn: needs id' };
      return { ok: true, frame: { ...base, event: { kind: 'turn', phase: e.phase, id: turnId } } };
    }
    case 'meta': {
      const queue = typeof e.queue === 'number' && Number.isFinite(e.queue) ? e.queue : undefined;
      return { ok: true, frame: { ...base, event: { kind: 'meta', ...optional('model', text(e.model, 80)), ...(queue === undefined ? {} : { queue }),
        ...optional('plan', text(e.plan, 40)), ...optional('elapsed', text(e.elapsed, 20)), ...optional('title', text(e.title, 120)) } } };
    }
    case 'notice': {
      const level = e.level === 'info' || e.level === 'warn' || e.level === 'alert' ? e.level : undefined;
      const body = text(e.text, 200);
      if (!level || !body) return { ok: false, ignore: false, reason: 'notice: needs level and text' };
      return { ok: true, frame: { ...base, event: { kind: 'notice', level, text: body } } };
    }
    case 'child': {
      const action = e.action === 'start' || e.action === 'progress' || e.action === 'status' || e.action === 'end' ? e.action : undefined;
      const id = text(e.id, 160);
      if (!action || !id) return { ok: false, ignore: false, reason: 'child: needs action and id' };
      const source = CHILD_SOURCES.find((candidate) => candidate === e.source);
      const state = e.state === 'working' || e.state === 'blocked' || e.state === 'idle' ? e.state : undefined;
      return { ok: true, frame: { ...base, event: { kind: 'child', action, id, ...(source ? { source } : {}), ...optional('label', text(e.label, 80)),
        ...optional('parent', text(e.parent, 160)), ...optional('cwd', text(e.cwd, 300)), ...(state ? { state } : {}), ...optional('line', text(e.line, 200)),
        ...(typeof e.ok === 'boolean' ? { ok: e.ok } : {}), ...optional('summary', text(e.summary, 200)) } } };
    }
    case 'release': return { ok: true, frame: { ...base, event: { kind: 'release' } } };
    default: return { ok: false, ignore: true, reason: `unknown event kind ${e.kind.slice(0, 40)}` };
  }
}
