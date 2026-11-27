// ELS-CHANNEL P0 (대표 11-26 19:0x · 내부 문서 `ELS-CHANNEL`) — the els server's channel log: agents in different tiles
// talk in typed messages instead of scraping each other's screens. One append-only file per channel
// (<els>/channels/<stem>.jsonl ⊕ .acks.jsonl ⊕ .meta.json), the recent window in memory, `wait` answered the moment a
// matching message lands (a promise per waiter ⊕ one deadline timer — never a poll). The SENDER is never a request field:
// the server passes the caller identity it authenticated (pane token ⊕ socket-peer ancestry) and the hub stamps it.
// Pure judges (parseChannelId · judgePost · channelAuthority) carry every safety rule so sims can drive them directly.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ElsResult } from './core.js';

export const CHANNEL_MESSAGE_TYPES = ['say', 'ask', 'answer', 'handoff', 'file', 'done', 'system'] as const;
export type ChannelMessageType = (typeof CHANNEL_MESSAGE_TYPES)[number];
export const CHANNEL_ACTIONS = ['post', 'read', 'list', 'ack', 'wait', 'hold', 'resume', 'open', 'loop-say'] as const;
export type ChannelAction = (typeof CHANNEL_ACTIONS)[number];

export const CHANNEL_BODY_MAX = 8_000;
export const CHANNEL_MEMORY_WINDOW = 200;
export const CHANNEL_WAIT_MAX_MS = 25_000;
export const PING_PONG_WINDOW = 12;
const DUP_WINDOW = 20;
const ID_RE = /^[A-Za-z0-9._:+-]{1,96}$/;
const REF_RE = /^[A-Za-z0-9._:/#@+-]{1,200}$/;
const LOOP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type ChannelRef =
  | { readonly kind: 'ws'; readonly ws: string }
  | { readonly kind: 'run'; readonly run: string }
  | { readonly kind: 'pair'; readonly a: string; readonly b: string }
  /** ELS-CHANNEL P1b: a loop agent's own channel — `loop:<graphId>`; a message here is an event for its voice adapter. */
  | { readonly kind: 'loop'; readonly loop: string };

/** `ws:<id>` · `run:<id>` · `pair:<a>+<b>` (a<b — `pairChannel` sorts). Anything else is refused (no path escape). */
export function parseChannelId(id: unknown): ChannelRef | undefined {
  if (typeof id !== 'string' || !ID_RE.test(id)) return undefined;
  const colon = id.indexOf(':');
  if (colon < 0) return undefined;
  const kind = id.slice(0, colon), rest = id.slice(colon + 1);
  if (!rest) return undefined;
  if (kind === 'ws' && !rest.includes('+')) return { kind: 'ws', ws: rest };
  if (kind === 'run' && !rest.includes('+')) return { kind: 'run', run: rest };
  if (kind === 'loop' && LOOP_ID_RE.test(rest)) return { kind: 'loop', loop: rest };
  if (kind === 'pair') {
    const parts = rest.split('+');
    if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0] >= parts[1]) return undefined;
    return { kind: 'pair', a: parts[0], b: parts[1] };
  }
  return undefined;
}

export const pairChannel = (x: string, y: string): string => (x < y ? `pair:${x}+${y}` : `pair:${y}+${x}`);
/** File stem: `:` → `_` and `+` → `~` (both outside the id grammar's other characters, so the map is one-to-one). */
/** File stem — injective (Terra #40282 must-1): every character outside [A-Za-z0-9.-] becomes `_` + two hex digits, the
 *  `_` itself included, so `ws:a:b` → `ws_3aa_3ab` and `ws:a_b` → `ws_3aa_5fb` never share a file. `stemToId` inverts it. */
export const channelStem = (id: string): string => id.replace(/[^A-Za-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
export const stemToId = (stem: string): string | undefined => {
  if (!/^(?:[A-Za-z0-9.-]|_[0-9a-f]{2})+$/.test(stem)) return undefined;
  const id = stem.replace(/_([0-9a-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return channelStem(id) === stem ? id : undefined;
};

export type CallerRole = 'op' | 'hand' | 'operator' | 'loop';
/** Built by the SERVER from the authenticated connection — never from request fields. */
export interface ChannelCaller {
  readonly role: CallerRole;
  readonly pane?: string;
  readonly seat?: string;
  /** Workspace ids AND names the caller's pane lives in (hand role); empty for op/operator. */
  readonly workspaces?: readonly string[];
  /** A person's own terminal (same-uid operator outside any pane). */
  readonly human?: boolean;
}

export interface ChannelMessage {
  readonly id: string;
  readonly seq: number;
  readonly at: number;
  readonly channel: string;
  readonly type: ChannelMessageType;
  readonly from: { readonly role: CallerRole | 'server'; readonly pane?: string; readonly seat?: string };
  readonly to?: readonly string[];
  readonly body: string;
  readonly replyTo?: string;
  readonly turn?: string;
  readonly refs?: readonly string[];
  readonly human?: true;
}

export interface ChannelPolicy {
  readonly autoReply: 'off' | 'ask-only' | 'on';
  readonly floor: 'free' | 'moderated';
  readonly moderator?: string;
  readonly maxMessages: number;
  readonly maxPerSenderPerMinute: number;
}
export interface ChannelMeta {
  readonly policy: ChannelPolicy;
  /** The workspace a run channel belongs to — written by whoever opened it (server-authorized), never by a poster. */
  readonly ws?: string;
  readonly paused?: { readonly reason: string; readonly at: number };
}

export const DEFAULT_POLICY: ChannelPolicy = { autoReply: 'ask-only', floor: 'free', maxMessages: 200, maxPerSenderPerMinute: 6 };

export const senderKey = (from: ChannelMessage['from'] | ChannelCaller): string => from.pane ?? (from.seat ? `seat:${from.seat}` : from.role);

// ── pure judges ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** ELS-CHANNEL §3-3: who may read/post/hold/resume/open on a channel. */
export function channelAuthority(caller: ChannelCaller, ref: ChannelRef, meta: ChannelMeta | undefined, action: ChannelAction): boolean {
  if (caller.role === 'op' || caller.role === 'operator') return true;
  // SUPERVISOR-REVIVE-1127: a loop agent speaks first (KPI breach line) from its own process on this host — the host door
  // (operator: same uid outside any pane) or OP only; a pane cannot speak as a loop.
  if (action === 'loop-say') return false;
  if (action === 'resume' || action === 'list') return action === 'list';
  const inWs = (ws: string | undefined): boolean => !!ws && !!caller.workspaces?.includes(ws);
  // A loop agent's channel is an open conversation on this host (CEO 11-24 «same host = trusted»): any pane may talk to it.
  const member = ref.kind === 'loop' ? true
    : ref.kind === 'ws' ? inWs(ref.ws)
    : ref.kind === 'run' ? inWs(meta?.ws)
    : (!!caller.pane && (ref.a === caller.pane || ref.b === caller.pane)) || (caller.role === 'loop' && !!caller.seat && (ref.a === caller.seat || ref.b === caller.seat));
  if (action === 'open') return ref.kind === 'run' && caller.role === 'hand' && meta === undefined;
  return member;
}

export type PostVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'paused' | 'cap' | 'rate' | 'floor' | 'dup' | 'turn' | 'ping-pong' | 'invalid'; readonly message: string; readonly pause?: string };

export interface PostDraft {
  readonly type: ChannelMessageType;
  readonly body: string;
  readonly to?: readonly string[];
  readonly turn?: string;
  readonly human?: boolean;
  readonly from: ChannelMessage['from'];
}

export const bodyHash = (body: string): string => createHash('sha256').update(body.trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);

/** ELS-CHANNEL §3-2 — every refusal rule in one pure function. `recent` = the channel's recent window, oldest first. */
export function judgePost(recent: readonly ChannelMessage[], lastSeq: number, meta: ChannelMeta, draft: PostDraft, now: number): PostVerdict {
  if (draft.type === 'system' && draft.from.role !== 'server') return { ok: false, code: 'invalid', message: 'type system is written by the server only' };
  if (draft.from.role === 'server') return { ok: true };
  const human = draft.human === true;
  const me = senderKey(draft.from);
  if (meta.paused && !human) return { ok: false, code: 'paused', message: `channel paused (${meta.paused.reason}) — a person resumes it: els channel resume` };
  if (lastSeq >= meta.policy.maxMessages && !human) return { ok: false, code: 'cap', message: `channel holds ${lastSeq} messages (cap ${meta.policy.maxMessages})`, pause: 'cap' };
  if (!human) {
    const lastMinute = recent.filter((m) => senderKey(m.from) === me && now - m.at < 60_000).length;
    if (lastMinute >= meta.policy.maxPerSenderPerMinute) return { ok: false, code: 'rate', message: `${lastMinute} messages from this sender in the last minute (max ${meta.policy.maxPerSenderPerMinute})` };
  }
  if (meta.policy.floor === 'moderated' && !human) {
    const mod = meta.policy.moderator;
    const lastMod = mod ? [...recent].reverse().find((m) => senderKey(m.from) === mod || m.from.seat === mod) : undefined;
    const named = !!lastMod?.to?.some((t) => t === draft.from.pane || t === draft.from.seat);
    if (me !== mod && draft.from.seat !== mod && !named) return { ok: false, code: 'floor', message: 'moderated channel — only the moderator or a participant it addressed may post' };
  }
  const hash = bodyHash(draft.body);
  const dup = recent.slice(-DUP_WINDOW).find((m) => senderKey(m.from) === me && bodyHash(m.body) === hash);
  if (dup) return { ok: false, code: 'dup', message: `same text already posted as ${dup.id}` };
  if (draft.turn) {
    const same = recent.find((m) => senderKey(m.from) === me && m.turn === draft.turn && m.type === draft.type);
    if (same) return { ok: false, code: 'turn', message: `this turn already posted ${draft.type} as ${same.id}` };
  }
  if (!human && isPingPong([...recent.filter((m) => m.type !== 'system'), { from: draft.from, type: draft.type } as ChannelMessage], meta.policy.moderator))
    return { ok: false, code: 'ping-pong', message: `two senders alternated ${PING_PONG_WINDOW} messages with no person, moderator or done — paused for a person`, pause: 'ping-pong' };
  return { ok: true };
}

/** The last PING_PONG_WINDOW messages are exactly two senders strictly alternating, with no human, moderator or done. */
export function isPingPong(messages: readonly Pick<ChannelMessage, 'from' | 'type' | 'human'>[], moderator?: string): boolean {
  if (messages.length < PING_PONG_WINDOW) return false;
  const tail = messages.slice(-PING_PONG_WINDOW);
  const keys = tail.map((m) => senderKey(m.from));
  if (new Set(keys).size !== 2) return false;
  if (tail.some((m) => m.human || m.type === 'done' || (moderator && (senderKey(m.from) === moderator || m.from.seat === moderator)))) return false;
  return keys.every((k, i) => i === 0 || k !== keys[i - 1]);
}

/** Open asks/handoffs: no later answer/done names them in replyTo. */
export function openItems(messages: readonly ChannelMessage[]): string[] {
  const closed = new Set(messages.filter((m) => (m.type === 'answer' || m.type === 'done') && m.replyTo).map((m) => m.replyTo!));
  return messages.filter((m) => (m.type === 'ask' || m.type === 'handoff') && !closed.has(m.id)).map((m) => m.id);
}

// ── the hub (server-owned) ───────────────────────────────────────────────────────────────────────────────────────────

export interface ChannelRequest {
  readonly action: ChannelAction;
  readonly channel?: string;
  readonly type?: string;
  readonly body?: string;
  readonly to?: readonly string[];
  readonly replyTo?: string;
  readonly turn?: string;
  readonly refs?: readonly string[];
  readonly after?: number;
  readonly limit?: number;
  readonly id?: string;
  readonly timeoutMs?: number;
  readonly policy?: Partial<ChannelPolicy>;
  readonly ws?: string;
  /** wait: wake on every new message, not only those addressed to the caller (the channel view tile). */
  readonly all?: boolean;
  /** loop-say: the loop agent (`loop:<id>`, must have a registered voice) that speaks first. */
  readonly loop?: string;
}

// ── ELS-CHANNEL P1b: loop agents as participants ────────────────────────────────────────────────────────────────────
/** What a loop agent's voice receives for one message — the whole contract (CEO 11-27 01:0x «keep it simple»). */
export interface LoopVoiceInput { readonly loop: string; readonly from: ChannelMessage['from']; readonly channel: string; readonly text: string; readonly refs: readonly string[]; readonly messageId: string }
/** What it answers. `actions` are what the loop did or proposes (its closed command set) — recorded, never executed here. */
export interface LoopVoiceReply { readonly text: string; readonly evidence?: readonly string[]; readonly actions?: readonly string[] }
export type LoopVoiceAdapter = (input: LoopVoiceInput, signal: AbortSignal) => Promise<LoopVoiceReply>;

/** The loop agents a message is for: its `loop:<id>` channel, and every `loop:<id>` named in `to`. Never the loop itself. */
export function loopTargets(message: Pick<ChannelMessage, 'channel' | 'to' | 'from' | 'type'>): string[] {
  if (message.type === 'system' || message.from.role === 'server') return [];
  const out = new Set<string>();
  const ref = parseChannelId(message.channel);
  if (ref?.kind === 'loop') out.add(ref.loop);
  for (const t of message.to ?? []) if (t.startsWith('loop:') && LOOP_ID_RE.test(t.slice(5))) out.add(t.slice(5));
  if (message.from.role === 'loop' && message.from.seat?.startsWith('loop:')) out.delete(message.from.seat.slice(5));
  return [...out];
}

/** `ids` and `open` cover the WHOLE ledger (Terra #40282 must-4): an old ask stays open and ackable past the memory window. */
interface ChannelState { meta: ChannelMeta; lastSeq: number; recent: ChannelMessage[]; acks: Map<string, string[]>; ids: Set<string>; open: Set<string> }
const track = (state: Pick<ChannelState, 'ids' | 'open'>, m: ChannelMessage): void => {
  state.ids.add(m.id);
  if (m.type === 'ask' || m.type === 'handoff') state.open.add(m.id);
  else if ((m.type === 'answer' || m.type === 'done') && m.replyTo) state.open.delete(m.replyTo);
};
interface Waiter { readonly channel: string; readonly after: number; readonly to?: string; readonly all?: boolean; readonly resolve: (m: ChannelMessage | undefined) => void; timer: unknown }

export interface ChannelHubOptions {
  readonly dir: string;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** P1b: the voice adapter of a loop agent (undefined = none registered — the message stays in the log for it). */
  readonly loopVoice?: (loop: string) => LoopVoiceAdapter | undefined;
  /** P1b: one voice call's deadline. */
  readonly loopVoiceTimeoutMs?: number;
}

export const LOOP_VOICE_TIMEOUT_MS = 120_000;
const NO_VOICE_NOTICE = (loop: string): string => `loop:${loop} has no voice yet — the message is kept in this channel for it`;

export interface ChannelHub {
  readonly apply: (request: ChannelRequest, caller: ChannelCaller) => Promise<ElsResult>;
  /** Every appended message (P1 wake ladder · stage feed · channel-watch push subscribe here). */
  readonly onPost: (listener: (message: ChannelMessage) => void) => { readonly dispose: () => void };
  readonly dispose: () => void;
  /** P1b: resolves when every voice call started so far has answered (tests · orderly shutdown). */
  readonly idle: () => Promise<void>;
}

const fail = (exitCode: 1 | 2, message: string): ElsResult => ({ exitCode, message: `els channel: ${message}` });
const ok = (payload: unknown): ElsResult => ({ exitCode: 0, message: JSON.stringify(payload) });
const strList = (v: unknown, re: RegExp, max: number): string[] | undefined | null => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !re.test(x))) return null;
  return v as string[];
};

export function createChannelHub(options: ChannelHubOptions): ChannelHub {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const states = new Map<string, ChannelState>();
  const waiters = new Set<Waiter>();
  const listeners = new Set<(m: ChannelMessage) => void>();
  const file = (id: string, ext: string): string => join(options.dir, `${channelStem(id)}${ext}`);
  const ensureDir = (): void => { mkdirSync(options.dir, { recursive: true, mode: 0o700 }); };
  const readLines = <T>(path: string): T[] => {
    if (!existsSync(path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line) as T); } catch { /* torn line — repairTail cut it */ } }
    return out;
  };
  /** Terra #40282 must-2: a crash mid-append leaves a line without its newline. Cut the file back to the last complete
   *  line so the next append starts on a fresh line (the torn fragment was never acknowledged to its poster). */
  const repairTail = (path: string): void => {
    if (!existsSync(path)) return;
    const raw = readFileSync(path);
    if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return;
    truncateSync(path, raw.lastIndexOf(0x0a) + 1);
  };

  const load = (id: string): ChannelState | undefined => {
    const cached = states.get(id);
    if (cached) return cached;
    const metaPath = file(id, '.meta.json'), logPath = file(id, '.jsonl');
    if (!existsSync(metaPath) && !existsSync(logPath)) return undefined;
    let meta: ChannelMeta = { policy: DEFAULT_POLICY };
    try { if (existsSync(metaPath)) { const raw = JSON.parse(readFileSync(metaPath, 'utf8')) as ChannelMeta; meta = { ...raw, policy: { ...DEFAULT_POLICY, ...raw.policy } }; } } catch { /* keep defaults */ }
    repairTail(logPath);
    repairTail(file(id, '.acks.jsonl'));
    const all = readLines<ChannelMessage>(logPath);
    const acks = new Map<string, string[]>();
    for (const a of readLines<{ id: string; by: string }>(file(id, '.acks.jsonl'))) acks.set(a.id, [...(acks.get(a.id) ?? []), a.by]);
    const state: ChannelState = { meta, lastSeq: all.length ? all[all.length - 1]!.seq : 0, recent: all.slice(-CHANNEL_MEMORY_WINDOW), acks, ids: new Set(), open: new Set() };
    for (const m of all) track(state, m);
    states.set(id, state);
    return state;
  };
  const create = (id: string, meta: ChannelMeta): ChannelState => {
    const state: ChannelState = { meta, lastSeq: 0, recent: [], acks: new Map(), ids: new Set(), open: new Set() };
    states.set(id, state);
    saveMeta(id, state);
    return state;
  };
  const saveMeta = (id: string, state: ChannelState): void => {
    ensureDir();
    const path = file(id, '.meta.json'), temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state.meta)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  };
  const append = (id: string, state: ChannelState, partial: Omit<ChannelMessage, 'id' | 'seq' | 'at' | 'channel'>): ChannelMessage => {
    ensureDir();
    const seq = state.lastSeq + 1;
    const message: ChannelMessage = { id: `cm-${seq}-${randomBytes(3).toString('hex')}`, seq, at: now(), channel: id, ...partial };
    const logPath = file(id, '.jsonl');
    // A failed write may leave half a line: cut it back so the ledger stays line-aligned, then report the failure.
    try { appendFileSync(logPath, `${JSON.stringify(message)}\n`, { mode: 0o600 }); } catch (error) { try { repairTail(logPath); } catch { /* reported below */ } throw error; }
    state.lastSeq = seq;
    track(state, message);
    state.recent.push(message);
    if (state.recent.length > CHANNEL_MEMORY_WINDOW) state.recent.splice(0, state.recent.length - CHANNEL_MEMORY_WINDOW);
    for (const w of [...waiters]) {
      if (w.channel === id && seq > w.after && (w.all || !w.to || !message.to?.length || message.to.includes(w.to))) { waiters.delete(w); clearTimer(w.timer); w.resolve(message); }
    }
    for (const l of listeners) { try { l(message); } catch { /* a listener never breaks a post */ } }
    return message;
  };
  const pause = (id: string, state: ChannelState, reason: string): void => {
    state.meta = { ...state.meta, paused: { reason, at: now() } };
    saveMeta(id, state);
    append(id, state, { type: 'system', from: { role: 'server' }, body: `paused: ${reason} — a person or OP resumes it with els channel resume ${id}` });
  };
  const readAfter = (id: string, state: ChannelState, after: number, limit: number): ChannelMessage[] => {
    const first = state.recent[0];
    const source = first && after + 1 < first.seq ? readLines<ChannelMessage>(file(id, '.jsonl')) : state.recent;
    return source.filter((m) => m.seq > after).slice(0, limit);
  };

  async function apply(request: ChannelRequest, caller: ChannelCaller): Promise<ElsResult> {
    const action = request.action;
    if (!CHANNEL_ACTIONS.includes(action)) return fail(2, `unknown action ${JSON.stringify(action)}`);
    if (action === 'list') return ok({ channels: listChannels(caller) });
    const id = request.channel;
    const ref = parseChannelId(id);
    if (!ref || !id) return fail(2, `bad channel id ${JSON.stringify(id)} (ws:<id> · run:<id> · pair:<a>+<b> with a<b)`);
    let state = load(id);
    if (!channelAuthority(caller, ref, state?.meta, action)) return fail(1, `${action} denied on ${id} — ${caller.role === 'hand' ? 'a pane acts on its own workspace and its own pair channels only (OP: every channel)' : 'not allowed'}`);
    switch (action) {
      case 'open': {
        if (state) return fail(1, `${id} already exists`);
        const ws = caller.role === 'hand' ? caller.workspaces?.[0] : request.ws;
        state = create(id, { policy: { ...DEFAULT_POLICY, ...sanitizePolicy(request.policy) }, ...(ws ? { ws } : {}) });
        return ok({ channel: id, meta: state.meta });
      }
      case 'post': {
        const type = request.type ?? 'say';
        if (!(CHANNEL_MESSAGE_TYPES as readonly string[]).includes(type)) return fail(2, `unknown type ${JSON.stringify(type)}`);
        const body = typeof request.body === 'string' ? request.body : '';
        if (!body.trim()) return fail(2, 'body is empty');
        if (body.length > CHANNEL_BODY_MAX) return fail(2, `body is ${body.length} chars (max ${CHANNEL_BODY_MAX}) — hand a file instead`);
        const to = strList(request.to, ID_RE, 16), refs = strList(request.refs, REF_RE, 16);
        if (to === null || refs === null) return fail(2, 'to/refs must be short id lists (≤16)');
        if (request.replyTo !== undefined && (typeof request.replyTo !== 'string' || !/^cm-\d+-[0-9a-f]{6}$/.test(request.replyTo))) return fail(2, 'replyTo must be a message id');
        if (request.turn !== undefined && (typeof request.turn !== 'string' || !ID_RE.test(request.turn))) return fail(2, 'turn must be a short id');
        state ??= create(id, { policy: DEFAULT_POLICY });
        const from: ChannelMessage['from'] = { role: caller.role, ...(caller.pane ? { pane: caller.pane } : {}), ...(caller.seat ? { seat: caller.seat } : {}) };
        const draft: PostDraft = { type: type as ChannelMessageType, body, from, ...(to ? { to } : {}), ...(request.turn ? { turn: request.turn } : {}), ...(caller.human ? { human: true } : {}) };
        const verdict = judgePost(state.recent, state.lastSeq, state.meta, draft, now());
        if (!verdict.ok) {
          if (verdict.pause && !state.meta.paused) pause(id, state, verdict.pause);
          return { exitCode: 1, message: JSON.stringify({ refused: verdict.code, message: verdict.message }) };
        }
        const message = append(id, state, { type: draft.type, from, body, ...(to ? { to } : {}), ...(request.replyTo ? { replyTo: request.replyTo } : {}),
          ...(request.turn ? { turn: request.turn } : {}), ...(refs ? { refs } : {}), ...(caller.human ? { human: true as const } : {}) });
        for (const loop of loopTargets(message)) askLoop(loop, id, message);
        return ok({ id: message.id, seq: message.seq });
      }
      case 'loop-say': {
        // A loop agent's proactive line (KPI breach / recovery). Only a loop with a registered voice may speak, so the
        // name is one people can answer; the line never wakes another loop (no loopTargets) — no loop↔loop ping-pong.
        const loop = typeof request.loop === 'string' ? request.loop : '';
        if (!LOOP_ID_RE.test(loop)) return fail(2, 'loop-say needs loop: <id>');
        if (!options.loopVoice?.(loop)) return fail(1, `loop:${loop} has no registered voice (els channel voice ${loop} -- …)`);
        const body = typeof request.body === 'string' ? request.body : '';
        if (!body.trim()) return fail(2, 'body is empty');
        if (body.length > CHANNEL_BODY_MAX) return fail(2, `body is ${body.length} chars (max ${CHANNEL_BODY_MAX})`);
        const refs = strList(request.refs, REF_RE, 16);
        if (refs === null) return fail(2, 'refs must be a short id list (≤16)');
        state ??= create(id, { policy: DEFAULT_POLICY });
        const from: ChannelMessage['from'] = { role: 'loop', seat: `loop:${loop}` };
        const verdict = judgePost(state.recent, state.lastSeq, state.meta, { type: 'say', body, from }, now());
        if (!verdict.ok) return { exitCode: 1, message: JSON.stringify({ refused: verdict.code, message: verdict.message }) };
        const message = append(id, state, { type: 'say', from, body, ...(refs ? { refs } : {}) });
        return ok({ id: message.id, seq: message.seq });
      }
      case 'read': {
        if (!state) return ok({ channel: id, lastSeq: 0, messages: [], open: [] });
        const after = Number.isInteger(request.after) && request.after! >= 0 ? request.after! : Math.max(0, state.lastSeq - 50);
        const limit = Number.isInteger(request.limit) && request.limit! > 0 ? Math.min(request.limit!, CHANNEL_MEMORY_WINDOW) : 50;
        return ok({ channel: id, lastSeq: state.lastSeq, paused: state.meta.paused, messages: readAfter(id, state, after, limit), open: [...state.open] });
      }
      case 'ack': {
        if (!state || typeof request.id !== 'string' || !state.ids.has(request.id)) return fail(2, `no message ${JSON.stringify(request.id)} in ${id}`);
        const by = senderKey(caller);
        if (!(state.acks.get(request.id) ?? []).includes(by)) {
          ensureDir();
          appendFileSync(file(id, '.acks.jsonl'), `${JSON.stringify({ id: request.id, by, at: now() })}\n`, { mode: 0o600 });
          state.acks.set(request.id, [...(state.acks.get(request.id) ?? []), by]);
        }
        return ok({ id: request.id, by });
      }
      case 'wait': {
        const after = Number.isInteger(request.after) && request.after! >= 0 ? request.after! : state?.lastSeq ?? 0;
        const to = caller.pane ?? caller.seat;
        const all = request.all === true;
        // Terra #40282 should: an old cursor reads the file too (readAfter), so a reconnect never skips a message already there.
        const ready = state ? readAfter(id, state, after, Number.MAX_SAFE_INTEGER).find((m) => all || !m.to?.length || !to || m.to.includes(to)) : undefined;
        if (ready) return ok({ message: ready });
        const timeoutMs = Math.min(Math.max(Number(request.timeoutMs) || CHANNEL_WAIT_MAX_MS, 0), CHANNEL_WAIT_MAX_MS);
        const message = await new Promise<ChannelMessage | undefined>((resolve) => {
          const waiter: Waiter = { channel: id, after, ...(to ? { to } : {}), ...(all ? { all } : {}), resolve, timer: undefined };
          waiter.timer = setTimer(() => { waiters.delete(waiter); resolve(undefined); }, timeoutMs);
          waiters.add(waiter);
        });
        return ok(message ? { message } : { timeout: true, after });
      }
      case 'hold': {
        state ??= create(id, { policy: DEFAULT_POLICY });
        if (!state.meta.paused) pause(id, state, `hold by ${caller.human ? 'a person' : senderKey(caller)}`);
        return ok({ channel: id, paused: state.meta.paused });
      }
      case 'resume': {
        if (!state?.meta.paused) return ok({ channel: id, paused: false });
        const { paused: _p, ...rest } = state.meta;
        state.meta = rest;
        saveMeta(id, state);
        append(id, state, { type: 'system', from: { role: 'server' }, body: `resumed by ${caller.human ? 'a person' : senderKey(caller)}` });
        return ok({ channel: id, paused: false });
      }
    }
    return fail(2, `unhandled action ${action}`);
  }

  // P1b: one voice call at a time per loop (a chain), each with a deadline; the reply is appended as the loop itself.
  const loopChains = new Map<string, Promise<void>>();
  /** Terra #40331 must-1: «no voice» is said once per loop and channel until that loop has a voice (not once per post). */
  const silentNoticed = new Set<string>();
  const aborts = new Set<AbortController>();
  let disposed = false;
  function askLoop(loop: string, channelId: string, message: ChannelMessage): void {
    const run = async (): Promise<void> => {
      if (disposed) return;
      const state = load(channelId);
      if (!state) return;
      const adapter = options.loopVoice?.(loop);
      const loopFrom: ChannelMessage['from'] = { role: 'loop', seat: `loop:${loop}` };
      const silentKey = `${loop}\u0000${channelId}`;
      if (!adapter) {
        if (!silentNoticed.has(silentKey)) { silentNoticed.add(silentKey); append(channelId, state, { type: 'system', from: { role: 'server' }, body: NO_VOICE_NOTICE(loop), refs: [`loop:${loop}`] }); }
        return;
      }
      for (const key of [...silentNoticed]) if (key.startsWith(`${loop}\u0000`)) silentNoticed.delete(key);
      const abort = new AbortController();
      aborts.add(abort);
      const timer = setTimer(() => abort.abort(), options.loopVoiceTimeoutMs ?? LOOP_VOICE_TIMEOUT_MS);
      try {
        const reply = await Promise.race([
          adapter({ loop, from: message.from, channel: channelId, text: message.body, refs: message.refs ?? [], messageId: message.id }, abort.signal),
          new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })),
        ]);
        if (disposed) return;
        const text = typeof reply?.text === 'string' && reply.text.trim() ? reply.text.slice(0, CHANNEL_BODY_MAX) : '(no text)';
        const evidence = (Array.isArray(reply?.evidence) ? reply.evidence : []).filter((r): r is string => typeof r === 'string' && REF_RE.test(r));
        const actions = (Array.isArray(reply?.actions) ? reply.actions : []).filter((a): a is string => typeof a === 'string' && /^[A-Za-z0-9._:=-]{1,120}$/.test(a)).map((a) => `action:${a}`);
        const refs = [...evidence, ...actions].slice(0, 16);
        // Terra #40331 must-2: a loop's reply is judged like any post — a pane↔loop ping-pong pauses on the loop's turn too.
        const verdict = judgePost(state.recent, state.lastSeq, state.meta, { type: 'answer', body: text, from: loopFrom }, now());
        if (!verdict.ok) {
          if (verdict.pause && !state.meta.paused) pause(channelId, state, verdict.pause);
          else if (!verdict.pause && verdict.code !== 'paused') append(channelId, state, { type: 'system', from: { role: 'server' }, body: `loop:${loop} reply refused (${verdict.code}): ${verdict.message}`.slice(0, 400), replyTo: message.id, refs: [`loop:${loop}`] });
          return;
        }
        append(channelId, state, { type: 'answer', from: loopFrom, body: text, replyTo: message.id, ...(refs.length ? { refs } : {}) });
      } catch (error) {
        if (disposed) return;
        append(channelId, state, { type: 'system', from: { role: 'server' }, body: `loop:${loop} voice failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, replyTo: message.id, refs: [`loop:${loop}`] });
      } finally { clearTimer(timer); aborts.delete(abort); }
    };
    const next = (loopChains.get(loop) ?? Promise.resolve()).then(run, run);
    loopChains.set(loop, next);
  }

  function listChannels(caller: ChannelCaller): unknown[] {
    let stems: string[] = [];
    // Terra #40282 must-3: a channel created by `open` has only its meta file — list both kinds of file.
    try {
      stems = [...new Set(readdirSync(options.dir).flatMap((f) => f.endsWith('.acks.jsonl') ? [] : f.endsWith('.jsonl') ? [f.slice(0, -'.jsonl'.length)] : f.endsWith('.meta.json') ? [f.slice(0, -'.meta.json'.length)] : []))].sort();
    } catch { /* no channels yet */ }
    const out: unknown[] = [];
    for (const stem of stems) {
      const id = stemToId(stem), ref = id ? parseChannelId(id) : undefined, state = ref && id ? load(id) : undefined;
      if (!id || !ref || !state || !channelAuthority(caller, ref, state.meta, 'read')) continue;
      const last = state.recent[state.recent.length - 1];
      out.push({ channel: id, lastSeq: state.lastSeq, lastAt: last?.at, open: state.open.size, ...(state.meta.paused ? { paused: state.meta.paused.reason } : {}) });
    }
    return out;
  }

  return {
    apply,
    onPost: (listener) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    dispose: () => { disposed = true; for (const a of aborts) a.abort(); for (const w of waiters) { clearTimer(w.timer); w.resolve(undefined); } waiters.clear(); listeners.clear(); },
    idle: async () => { while (true) { const chains = [...loopChains.values()]; await Promise.all(chains); if (chains.every((c, i) => [...loopChains.values()][i] === c) && chains.length === loopChains.size) return; } },
  };
}

function sanitizePolicy(p: Partial<ChannelPolicy> | undefined): Partial<ChannelPolicy> {
  if (!p || typeof p !== 'object') return {};
  const out: { -readonly [K in keyof ChannelPolicy]?: ChannelPolicy[K] } = {};
  if (p.autoReply === 'off' || p.autoReply === 'ask-only' || p.autoReply === 'on') out.autoReply = p.autoReply;
  if (p.floor === 'free' || p.floor === 'moderated') out.floor = p.floor;
  if (typeof p.moderator === 'string' && ID_RE.test(p.moderator)) out.moderator = p.moderator;
  if (Number.isInteger(p.maxMessages) && p.maxMessages! > 0) out.maxMessages = Math.min(p.maxMessages!, 2_000);
  if (Number.isInteger(p.maxPerSenderPerMinute) && p.maxPerSenderPerMinute! > 0) out.maxPerSenderPerMinute = Math.min(p.maxPerSenderPerMinute!, 60);
  return out;
}
