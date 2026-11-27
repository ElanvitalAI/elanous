// FED-OBSERVE — `eln fed chatlog`: the federation's conversation as ONE time-ordered stream (대표 11-26 23:3x «채팅 로그를
// 개발해주세요»).
//
// S: `els peek <seat>` (#40120) shows one seat's last turns from its eln session; reading the federation meant opening a
//    dozen peeks and the mail list side by side and merging them by eye.
// C: every seat's turns are already persisted (the eln session store, one jsonl per session) and every mail is in the msg
//    store — both with timestamps.
// Q: how does a reader see «who said what to whom, and what each seat did about it» in one stream?
// A: PURE half here: `turnsOf` groups a session's messages into turns (input summary → final assistant text → one tool
//    line → outcome) exactly like peek's `lastTurns`; `buildChatlog` interleaves every seat's turns with the mails between
//    seats by time, applies the seat / grep / window / per-seat turn limits, clips bodies and redacts secrets with the
//    shared redactor. The I/O half (which session each pane runs · the log rows · the msg store) is chatlog-live.ts.
//
// 세 얼굴: 관측 = the stream (seat label · turn id · outcome on every turn) · 판단 근거 = the outcome rule below (log rows
// for failed · the enforce ledger / «HH:MM에 확인» ending for no-op · tool calls for did) · 수복과 인계 = a reader jumps
// from a turn id to `els peek <seat>` / `eln session show <id>`.
import type { SerializedMessage } from '../session/index.js';
import { redactSecretText } from '../debug/secret-redaction.js';
import { promiseOnly } from '../loops/op-turn-enforce.js';
import type { TurnOutcome } from './snapshot.js';

export interface ChatTurn {
  readonly type: 'turn';
  readonly at: string;
  readonly seat: string;
  readonly turnId: string;
  /** Leading «[tag]» of the input (mail · bulletin · pulse …) or «user». */
  readonly inputTag: string;
  readonly input: string;
  readonly reply: string;
  readonly tools: { readonly count: number; readonly names: readonly string[] };
  readonly outcome: TurnOutcome;
  readonly why?: string;
}
export interface ChatMail {
  readonly type: 'mail';
  readonly at: string;
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly line: string;
}
export type ChatEntry = ChatTurn | ChatMail;

export interface SeatSession { readonly seat: string; readonly sessionId: string; readonly messages: readonly SerializedMessage[] }
/** Facts that decide a turn's outcome beyond its own messages. */
export interface OutcomeFacts {
  /** Fatal log rows (lost turn) per seat: epoch ms + what. */
  readonly fatal?: ReadonlyMap<string, readonly { at: number; what: string }[]>;
  /** OP turn-enforce ledger rows: turn start (since) + noop. */
  readonly enforce?: readonly { since: number; noop: boolean; promise?: boolean }[];
}

export const DEFAULT_CLIP = 240;
// 출처: a turn with no reply yet that started this recently is still running, not failed (seat turn cap is 15 min).
export const RUNNING_GRACE_MS = 15 * 60_000;

const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v) ?? '');
const flat = (s: string): string => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\s+/gu, ' ').trim();
/** Clip to `max` code points (a surrogate pair is never cut), «…» marks the cut. 0 = no clip. */
export function clipText(s: string, max: number): string {
  if (max <= 0) return s;
  const pts = Array.from(s);
  return pts.length <= max ? s : `${pts.slice(0, Math.max(1, max - 1)).join('')}…`;
}
const clean = (s: string, max: number): string => clipText(redactSecretText(flat(s)), max);

export function inputTagOf(text: string): string {
  const m = /^\s*\[([^\]\n]{1,160})\]/u.exec(text);
  return m ? m[1]!.trim() : 'user';
}

/** One session's messages → turns (a turn = a user message and everything up to the next one). */
export function turnsOf(s: SeatSession, opts: { now: number; clip: number; facts?: OutcomeFacts }): ChatTurn[] {
  const groups: SerializedMessage[][] = [];
  for (const m of s.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') groups.push([m]);
    else if (groups.length) groups[groups.length - 1]!.push(m); // rows before the first user message (a cut tail) are dropped
  }
  const seat = s.seat.toUpperCase();
  const fatal = opts.facts?.fatal?.get(seat) ?? [];
  return groups.map((g, i) => {
    const user = g[0]!;
    const start = Date.parse(user.ts);
    const end = i + 1 < groups.length ? Date.parse(groups[i + 1]![0]!.ts) : opts.now + 1;
    const tools = g.filter(m => m.role === 'tool');
    const names = new Map<string, number>();
    for (const t of tools) names.set(t.toolName ?? 'tool', (names.get(t.toolName ?? 'tool') ?? 0) + 1);
    const replies = g.filter(m => m.role === 'assistant' && asText(m.content).trim() && !m.goalInterim);
    const reply = replies.length ? asText(replies[replies.length - 1]!.content) : '';
    const lost = fatal.find(f => f.at >= start && f.at < end);
    const enforced = seat === 'OP' ? opts.facts?.enforce?.find(e => Math.abs(e.since - start) <= 5_000) : undefined;
    let outcome: ChatTurn['outcome']; let why: string | undefined;
    if (lost) { outcome = 'failed'; why = lost.what; }
    else if (enforced?.noop) { outcome = 'no-op'; why = `engine: no state change${enforced.promise ? ' · ended on «HH:MM에 확인»' : ''}`; }
    // The newest turn with no reply yet (tools or not) is still running; an old turn with no reply and no tools failed.
    else if (!reply && i === groups.length - 1 && opts.now - start < RUNNING_GRACE_MS) outcome = 'running';
    else if (!reply && !tools.length) { outcome = 'failed'; why = 'no reply'; }
    else if (reply && promiseOnly(reply) && !tools.some(t => !/^(Read|Grep|Glob|MsgList|capability_search|ToolSearch)$/u.test(t.toolName ?? ''))) { outcome = 'no-op'; why = 'ended on «HH:MM에 확인» with no action'; }
    else outcome = tools.length ? 'did' : 'reply';
    const stamp = Number.isFinite(start) ? new Date(start).toISOString().slice(11, 19).replace(/:/g, '') : String(i);
    return {
      type: 'turn', at: user.ts, seat, turnId: `${seat}/${s.sessionId.slice(0, 8)}/${stamp}`,
      inputTag: clipText(redactSecretText(flat(inputTagOf(asText(user.content)))), 30), input: clean(asText(user.content).replace(/^\s*\[[^\]\n]{1,160}\]\s*/u, ''), opts.clip), reply: clean(reply, opts.clip),
      tools: { count: tools.length, names: [...names].sort((a, b) => b[1] - a[1]).map(([n, c]) => (c > 1 ? `${n}×${c}` : n)) },
      outcome, ...(why ? { why: clean(why, 120) } : {}),
    };
  });
}

export interface MailRow { readonly id: number; readonly from: string; readonly to: string; readonly kind?: string | null; readonly body: string; readonly createdAt: string }

export interface ChatlogQuery {
  readonly now: number;
  /** Window start (epoch ms); null = no time bound (with `turns`). */
  readonly since: number | null;
  /** Last N turns per seat (null = all in the window). */
  readonly turns: number | null;
  /** Upper-cased seat filter (null = every seat). */
  readonly seats: ReadonlySet<string> | null;
  readonly grep: string | null;
  readonly clip: number;
  /** Include mails (default true). */
  readonly mail?: boolean;
}

export function entryText(e: ChatEntry): string {
  return e.type === 'mail' ? `${e.from} ${e.to} ${e.kind} ${e.line}` : `${e.seat} ${e.inputTag} ${e.input} ${e.reply} ${e.tools.names.join(' ')} ${e.outcome} ${e.why ?? ''}`;
}

/** Pure: interleave seat turns and mails by time, filtered, clipped, redacted. Ties: mail before the turn it opened. */
export function buildChatlog(sessions: readonly SeatSession[], mails: readonly MailRow[], q: ChatlogQuery, facts?: OutcomeFacts): ChatEntry[] {
  const want = (seat: string) => !q.seats || q.seats.has(seat.toUpperCase());
  const turns: ChatTurn[] = [];
  for (const s of sessions) {
    if (!want(s.seat)) continue;
    let ts = turnsOf(s, { now: q.now, clip: q.clip, ...(facts ? { facts } : {}) });
    if (q.since !== null) ts = ts.filter(t => Date.parse(t.at) >= q.since!);
    if (q.turns !== null) ts = q.turns <= 0 ? [] : ts.slice(-q.turns); // slice(-0) would keep every turn
    turns.push(...ts);
  }
  // --turns without --since: the mail window starts at the earliest shown turn.
  const lo = q.since ?? (turns.length ? Math.min(...turns.map(t => Date.parse(t.at))) : q.now);
  const mailEntries: ChatMail[] = q.mail === false ? [] : mails
    .filter(m => { const t = Date.parse(m.createdAt); return t >= lo && t <= q.now && (!q.seats || want(m.from) || want(m.to)); })
    .map(m => ({ type: 'mail', at: m.createdAt, id: m.id, from: m.from.toUpperCase(), to: m.to.toUpperCase(), kind: m.kind ?? '-', line: clean(firstLine(m.body), q.clip) }));
  let all: ChatEntry[] = [...mailEntries, ...turns];
  if (q.grep) { const g = q.grep.toLowerCase(); all = all.filter(e => entryText(e).toLowerCase().includes(g)); }
  return all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.type === b.type ? 0 : a.type === 'mail' ? -1 : 1)
    || (a.type === 'mail' && b.type === 'mail' ? a.id - b.id : 0));
}

const firstLine = (body: string): string => body.split('\n').map(l => l.trim()).find(Boolean) ?? '';

const OUTCOME_MARK: Record<TurnOutcome, string> = { did: '✔', reply: '·', 'no-op': '⚠', failed: '✘', unknown: '?', running: '…' };

/** Human lines: one ✉ line per mail; per turn a head line (seat · id · input), the reply, the tool line, the outcome. */
export function formatChatlog(entries: readonly ChatEntry[], opts: { tz?: 'local' } = {}): string[] {
  void opts;
  const clock = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8); };
  const out: string[] = [];
  for (const e of entries) {
    if (e.type === 'mail') { out.push(`${clock(e.at)} ✉ #${e.id} ${e.from}→${e.to} [${e.kind}] ${e.line}`); continue; }
    out.push(`${clock(e.at)} ▶ ${e.seat} ${e.turnId} [${e.inputTag}] ${e.input}`);
    if (e.reply) out.push(`         ◀ ${e.reply}`);
    if (e.tools.count) out.push(`         ⚙ ${e.tools.count} tool(s): ${e.tools.names.slice(0, 6).join(' ')}${e.tools.names.length > 6 ? ' …' : ''}`);
    out.push(`         ${OUTCOME_MARK[e.outcome]} ${e.outcome}${e.why ? ` — ${e.why}` : ''}`);
  }
  return out;
}
