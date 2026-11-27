/**
 * CLAUDE-OP-PROXY-LANE (CEO 11-26 18:3x · 내부 문서 `CLAUDE-OP-PROXY` §A1) — the proxy's own mail lane.
 *
 * S: every CLAUDE-OP → OP post (directive, decision, info) became a coach note — one line per 30 min, not mail.
 * C: the proxy must reach an idle OP fast (just below the CEO's own words) without becoming a new flood source.
 * Q: which proxy posts are mail, and how is the lane bounded?
 * A: a post from a proxy seat whose kind is on PROXY_LANE_KINDS rides the lane (ref `lane:proxy` → receiver route
 *    `proxy` → turn · P0). Its own budget: PROXY_LANE_PER_HOUR posts per receiver per rolling hour (answers to the
 *    receiver's own ask are outside it); over budget folds to the coach note; the same body inside the dedupe window is
 *    refused with the original's time. Kind-less / `coach` posts stay 30-min coach notes.
 *
 * 세 얼굴: 관측 = debug.log('msg', 'msg.proxy-lane' {to, verdict}) · 인지 = proxyLaneVerdict (pure, literal tests) ·
 *          수복과 인계 = nothing is dropped: over budget → coach note · duplicate → the original is already mail.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Seats that act as the CEO's proxy (their posts are coach notes unless they ride the lane). */
export const PROXY_SEATS: readonly string[] = ['CLAUDE-OP'];
/** Canonical kinds that ride the proxy lane as real mail. */
export const PROXY_LANE_KINDS: readonly string[] = ['request', 'decision', 'info', 'consult', 'question', 'alert'];
/** The structured ref the gate stamps on a lane post (the receiver routes on it ⊕ the sender seat). */
export const PROXY_LANE_REF = 'lane:proxy';
/** Lane budget per receiver per rolling hour (answers to the receiver's own ask excluded). */
export const PROXY_LANE_PER_HOUR = 6;
export const PROXY_LANE_WINDOW_MS = 60 * 60_000;
/** The same body to the same receiver inside this window is a duplicate. */
export const PROXY_LANE_DEDUPE_MS = 60 * 60_000;

export const isProxySeat = (seat: string | null | undefined): boolean =>
  typeof seat === 'string' && PROXY_SEATS.includes(seat.trim().toUpperCase());

/** Does this (sender, canonical kind) pair ride the lane? */
export function onProxyLane(from: string, cls: string | null | undefined): boolean {
  return isProxySeat(from) && typeof cls === 'string' && PROXY_LANE_KINDS.includes(cls);
}

/** A receiver-side lane mail: the sender is a proxy seat and the ledger row carries the lane ref. */
export function isProxyLaneMail(m: { readonly fromSeat?: string | null; readonly refs?: readonly string[] | null }): boolean {
  return isProxySeat(m.fromSeat ?? null) && (m.refs ?? []).includes(PROXY_LANE_REF);
}

export interface ProxyLaneEntry { readonly at: number; readonly hash: string; readonly answer?: boolean }

export type ProxyLaneVerdict =
  | { readonly verdict: 'pass'; readonly used: number }
  | { readonly verdict: 'over-budget'; readonly used: number }
  | { readonly verdict: 'duplicate'; readonly firstAt: number };

export function proxyBodyHash(body: string): string {
  return createHash('sha256').update(body.replace(/\s+/gu, ' ').trim()).digest('hex').slice(0, 16);
}

/** The lane decision from this receiver's lane history. An answer is never over budget, but a duplicate answer is. */
export function proxyLaneVerdict(history: readonly ProxyLaneEntry[], post: { readonly hash: string; readonly answer: boolean }, nowMs: number): ProxyLaneVerdict {
  // An entry stamped later than `nowMs` (a concurrent poster whose clock read came after ours) still counts.
  const dup = history.find((e) => e.hash === post.hash && nowMs - e.at < PROXY_LANE_DEDUPE_MS);
  if (dup) return { verdict: 'duplicate', firstAt: dup.at };
  const used = history.filter((e) => !e.answer && nowMs - e.at < PROXY_LANE_WINDOW_MS).length;
  if (!post.answer && used >= PROXY_LANE_PER_HOUR) return { verdict: 'over-budget', used };
  return { verdict: 'pass', used: post.answer ? used : used + 1 };
}

export function proxyLaneLine(to: string, v: ProxyLaneVerdict): string {
  if (v.verdict === 'duplicate') return `proxy lane: duplicate of the post to ${to} at ${new Date(v.firstAt).toISOString()} — not sent again (the original is already mail)`;
  if (v.verdict === 'over-budget') return `proxy lane: ${to} already got ${v.used}/${PROXY_LANE_PER_HOUR} proxy mails this hour → folded into the coach note (one line per 30 min · answers to ${to}'s own ask still pass)`;
  return `proxy lane: mail to ${to} (${v.used}/${PROXY_LANE_PER_HOUR} this hour)`;
}

/** Lane history file per receiver, next to the diverted ledgers. */
export function proxyLaneFile(root: string, to: string): string {
  return join(root, 'proxy-lane', `${to.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_')}.jsonl`);
}

type LaneLine = ProxyLaneEntry & { readonly token?: string } | { readonly cancel: string; readonly at: number } | { readonly commit: string; readonly at: number };

/**
 * A reservation not committed (mail row confirmed written) within this window is an abandoned one — the poster died or
 * its store failed without a cancel — and no longer counts for budget or dedupe, so a retry is never refused against a
 * mail that does not exist. Inside the window it still counts (a concurrent identical post is a duplicate in flight).
 */
export const PROXY_LANE_PENDING_MS = 30_000;

/** The receiver's live lane entries inside the larger of the two windows (cancelled reservations and bad lines skipped). */
export function readProxyLane(root: string, to: string, nowMs: number): ProxyLaneEntry[] {
  const file = proxyLaneFile(root, to);
  if (!existsSync(file)) return [];
  const keep = Math.max(PROXY_LANE_WINDOW_MS, PROXY_LANE_DEDUPE_MS);
  const lines: LaneLine[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line) as LaneLine); } catch { /* skip a torn line */ }
  }
  const cancelled = new Set(lines.flatMap((l) => ('cancel' in l && typeof l.cancel === 'string' ? [l.cancel] : [])));
  const committed = new Set(lines.flatMap((l) => ('commit' in l && typeof l.commit === 'string' ? [l.commit] : [])));
  const out: ProxyLaneEntry[] = [];
  for (const l of lines) {
    if ('cancel' in l || 'commit' in l) continue;
    if (typeof l.at !== 'number' || typeof l.hash !== 'string' || nowMs - l.at >= keep) continue;
    if (l.token && cancelled.has(l.token)) continue;
    // An uncommitted reservation past the pending window was abandoned (no mail row behind it).
    if (l.token && !committed.has(l.token) && nowMs - l.at >= PROXY_LANE_PENDING_MS) continue;
    out.push({ at: l.at, hash: l.hash, ...(l.answer ? { answer: true } : {}) });
  }
  return out;
}

const LOCK_STALE_MS = 5_000;
const LOCK_TRIES = 100;
const LOCK_WAIT_MS = 20;

/** Hold the receiver's lane lock (O_EXCL file) for `fn`. A lock older than 5 s is a dead holder's and is broken. */
function withLaneLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < LOCK_TRIES; i++) {
    try {
      const fd = openSync(lock, 'wx');
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; } } catch { continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
  throw new Error('proxy lane: lock busy');
}

/**
 * Judge ⊕ reserve one lane slot atomically (read, verdict and append under the receiver's lock — two concurrent posts
 * cannot both take the last slot or both pass a dedupe). A passing post gets a token; `cancelProxyLane` releases it when
 * the mail row is not written after all (a failed store), so a retry is not refused as its own duplicate.
 */
export function reserveProxyLane(root: string, to: string, post: { readonly hash: string; readonly answer: boolean }, nowMs: number): { verdict: ProxyLaneVerdict; token?: string } {
  const file = proxyLaneFile(root, to);
  return withLaneLock(file, () => {
    const verdict = proxyLaneVerdict(readProxyLane(root, to, nowMs), post, nowMs);
    if (verdict.verdict !== 'pass') return { verdict };
    const token = randomBytes(8).toString('hex');
    appendFileSync(file, `${JSON.stringify({ at: nowMs, hash: post.hash, ...(post.answer ? { answer: true } : {}), token })}\n`);
    return { verdict, token };
  });
}

/** Confirm a reservation: its mail row is written (from now on it counts for budget and dedupe for the full window). */
export function commitProxyLane(root: string, to: string, token: string, nowMs: number = Date.now()): void {
  const file = proxyLaneFile(root, to);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ commit: token, at: nowMs })}\n`);
}

/** Release a reservation whose mail row was not written. */
export function cancelProxyLane(root: string, to: string, token: string, nowMs: number = Date.now()): void {
  const file = proxyLaneFile(root, to);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ cancel: token, at: nowMs })}\n`);
}
