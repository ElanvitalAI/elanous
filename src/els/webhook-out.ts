// Outbound webhook (ELS-EXTERNAL-SURFACES §3.2, §3.3): agent-event frames → subscribed URLs.
// Input is the v1 event frame `{op:'event', v:1, pane, seq, at, event:{kind,…}}`.
// Only `state`, `notice` and `child` with action `end` (`child-end`) are deliverable.
// Default deny: a URL whose host is not in `allowHosts` is never called, and the remote wire is HTTPS
// (#38610 REVIEW must ①): plain http is a loopback receiver's exception and nothing else.
// `allowHosts` is a TRUST GRANT, not a filter: listing a host says "this name may receive signed event bodies".
// A name is not an address, so every https target is also resolved and refused unless EVERY resolved address is
// public (no loopback, private, link-local, CGNAT, multicast, unspecified). Unresolvable = refused.
// Known limit: fetch resolves again at connect time, so a DNS-rebinding host can still flip between the check
// and the connect; allow only hosts whose DNS you control or trust. Redirects are never followed.
// Screen text is not sent: `child.line` is dropped. The secret is read from secretRef and never written anywhere.
// A target that keeps failing is retried with backoff, then the delivery goes to the dead-letter file
// and the subscription is marked disconnected (it stays subscribed).

import { createHmac, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { audit } from './control.js';

export const OUT_EVENTS = ['state', 'notice', 'child-end'] as const;
export type OutEvent = (typeof OUT_EVENTS)[number];

export interface Subscription {
  readonly id: string;
  readonly url: string;
  readonly events: readonly OutEvent[];
  /** Pane ids. Absent or empty = every pane. */
  readonly panes?: readonly string[];
  readonly secretRef: string;
}

export interface SubscriptionFile {
  readonly allowHosts: readonly string[];
  readonly subscriptions: readonly Subscription[];
}

export interface EventFrame {
  readonly op: 'event';
  readonly v: 1;
  readonly pane: string;
  readonly seq: number;
  readonly at: number;
  readonly event: { readonly kind: string; readonly [key: string]: unknown };
}

export interface OutboundDeps {
  /** `<state>/els` — subscriptions.json, webhook-deadletter.jsonl, webhook-status.json. */
  readonly stateDir: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Delays between attempts. Default 1s, 4s, 16s (four attempts). */
  readonly backoffMs?: readonly number[];
  readonly timeoutMs?: number;
  /** Addresses a host name resolves to (default: system DNS, all records). A throw means unresolvable. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Most deliveries in flight per subscription; further frames are dropped and audited. Default 8. */
  readonly maxInFlight?: number;
}

export interface DeliveryResult {
  readonly subscription: string;
  readonly ok: boolean;
  readonly tries: number;
  readonly status?: number;
}

const SUBS = 'subscriptions.json';
const DEAD = 'webhook-deadletter.jsonl';
const STATUS = 'webhook-status.json';
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function parseSubscription(value: unknown): Subscription | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !ID.test(row.id)) return undefined;
  if (typeof row.url !== 'string' || typeof row.secretRef !== 'string' || !row.secretRef) return undefined;
  if (!Array.isArray(row.events) || row.events.length === 0) return undefined;
  if (!row.events.every((e) => typeof e === 'string' && (OUT_EVENTS as readonly string[]).includes(e))) return undefined;
  if (row.panes !== undefined && (!Array.isArray(row.panes) || !row.panes.every((p) => typeof p === 'string'))) return undefined;
  try { new URL(row.url); } catch { return undefined; }
  return {
    id: row.id, url: row.url, secretRef: row.secretRef, events: row.events as OutEvent[],
    ...(row.panes !== undefined ? { panes: row.panes as string[] } : {}),
  };
}

/** The subscription file, or an empty one when missing or broken (nobody is called). */
export function loadSubscriptions(stateDir: string): SubscriptionFile {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, SUBS), 'utf8')) as { allowHosts?: unknown; subscriptions?: unknown };
    const allowHosts = Array.isArray(parsed.allowHosts) ? parsed.allowHosts.filter((h): h is string => typeof h === 'string' && h.length > 0).map((h) => h.toLowerCase()) : [];
    const subscriptions = Array.isArray(parsed.subscriptions)
      ? parsed.subscriptions.map(parseSubscription).filter((s): s is Subscription => s !== undefined)
      : [];
    return { allowHosts, subscriptions };
  } catch {
    return { allowHosts: [], subscriptions: [] };
  }
}

/** Loopback names may receive over plain http; nothing else may (#38610 REVIEW must ①). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Why a subscription URL may not be called (undefined = allowed). The host must be on `allowHosts`
 * and the remote wire must be HTTPS: a signed body never crosses a remote network in the clear.
 */
export function hostDenied(allowHosts: readonly string[], url: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'not a URL'; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'only https and http URLs are delivered';
  if (parsed.username || parsed.password) return 'credentials in the URL are not delivered';
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(host)) return 'remote delivery is HTTPS only';
  if (!allowHosts.includes(host)) return 'host not in allowHosts';
  return undefined;
}

export function hostAllowed(allowHosts: readonly string[], url: string): boolean {
  return hostDenied(allowHosts, url) === undefined;
}

function ipv4Public(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

/** True only for a globally routable literal address. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  const literal = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const kind = isIP(literal);
  if (kind === 4) {
    const [a, b] = literal.split('.').map(Number) as [number, number];
    return ipv4Public(a, b);
  }
  if (kind !== 6) return false;
  let text = literal.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1]!.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, -tail[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const front = head ? head.split(':') : [];
  const back = rest !== undefined && rest ? rest.split(':') : [];
  const groups = rest === undefined ? front : [...front, ...Array<string>(8 - front.length - back.length).fill('0'), ...back];
  if (groups.length !== 8) return false;
  const g = groups.map((x) => parseInt(x, 16));
  if (g.some((x) => !Number.isInteger(x))) return false;
  const embedded = (): boolean => ipv4Public(g[6]! >> 8, g[6]! & 0xff);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(); // ::ffff:a.b.c.d (mapped)
  if (g.slice(0, 6).every((x) => x === 0)) return false; // ::, ::1 and the deprecated IPv4-compatible range
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(); // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return true;
}

/** Why the RESOLVED addresses of an https target forbid delivery (undefined = all public). Loopback http is exempt. */
async function addressDenied(url: string, resolve: (host: string) => Promise<readonly string[]>): Promise<string | undefined> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') return undefined;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly string[];
  if (isIP(host)) addresses = [host];
  else {
    try { addresses = await resolve(host); } catch { return 'host did not resolve'; }
  }
  if (addresses.length === 0) return 'host did not resolve';
  return addresses.every(isPublicAddress) ? undefined : 'host resolves to a non-public address';
}

function writeFileAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * #38610 REVIEW must ②·③ — the required file schema, checked before ANY write (put or remove):
 * an existing subscriptions.json must carry `allowHosts` and `subscriptions`, both well-formed,
 * every row sound. An omission is corruption, not an empty list — loadSubscriptions silently drops
 * what does not parse, so saving its filtered view would turn the omission (or one bad row) into a
 * permanent loss. Returns the refusal reason, or undefined when the file is sound or absent
 * (an absent file bootstraps on the first put).
 */
function subscriptionsFileBroken(stateDir: string): string | undefined {
  let raw: string;
  try { raw = readFileSync(join(stateDir, SUBS), 'utf8'); } catch { return undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return 'subscriptions.json is broken'; }
  const file = parsed as { allowHosts?: unknown; subscriptions?: unknown };
  if (!file || typeof file !== 'object' || Array.isArray(file)) return 'subscriptions.json is broken';
  const missing = file.allowHosts === undefined ? 'allowHosts' : file.subscriptions === undefined ? 'subscriptions' : undefined;
  if (missing !== undefined) return `subscriptions.json is missing ${missing}`;
  if (!Array.isArray(file.allowHosts) || !file.allowHosts.every((h) => typeof h === 'string' && h.length > 0)) return 'subscriptions.json has a malformed allowHosts';
  if (!Array.isArray(file.subscriptions) || !file.subscriptions.every((row) => parseSubscription(row) !== undefined)) return 'subscriptions.json has a malformed subscription';
  return undefined;
}

/** Add or replace one subscription. The change is audited (id, host, events — never the secret). */
export function putSubscription(stateDir: string, sub: Subscription, by: string): void {
  if (!parseSubscription(sub)) throw new Error('els webhook: not a subscription');
  // #38610 REVIEW must ② — an existing file must carry the whole required schema: a put refuses
  // instead of rewriting a missing allowHosts or subscriptions into an empty array. The original
  // is preserved and the refusal is audited.
  const broken = subscriptionsFileBroken(stateDir);
  if (broken !== undefined) {
    audit(stateDir, { principal: by, surface: 'webhook-out', action: 'subscribe', result: 'refused', reason: broken, subscription: sub.id });
    throw new Error(`els webhook: ${broken} - put refused; restore or remove the file first`);
  }
  const current = loadSubscriptions(stateDir);
  const next: SubscriptionFile = { allowHosts: current.allowHosts, subscriptions: [...current.subscriptions.filter((s) => s.id !== sub.id), sub] };
  mkdirSync(stateDir, { recursive: true });
  writeFileAtomic(join(stateDir, SUBS), `${JSON.stringify(next, null, 2)}\n`);
  audit(stateDir, { principal: by, surface: 'webhook-out', action: 'subscribe', result: 'saved', subscription: sub.id, host: new URL(sub.url).hostname, events: sub.events });
}

export function removeSubscription(stateDir: string, id: string, by: string): boolean {
  // #38610 REVIEW must ③ — the whole file is validated before anything is removed:
  // loadSubscriptions silently drops a broken row, so saving its filtered view would delete that
  // row for good. Refused → the original is preserved and the refusal is audited.
  const broken = subscriptionsFileBroken(stateDir);
  if (broken !== undefined) {
    audit(stateDir, { principal: by, surface: 'webhook-out', action: 'unsubscribe', result: 'refused', reason: broken, subscription: id });
    throw new Error(`els webhook: ${broken} - remove refused; restore or remove the file first`);
  }
  const current = loadSubscriptions(stateDir);
  const remaining = current.subscriptions.filter((s) => s.id !== id);
  if (remaining.length === current.subscriptions.length) return false;
  writeFileAtomic(join(stateDir, SUBS), `${JSON.stringify({ allowHosts: current.allowHosts, subscriptions: remaining }, null, 2)}\n`);
  audit(stateDir, { principal: by, surface: 'webhook-out', action: 'unsubscribe', result: 'removed', subscription: id });
  return true;
}

/** `state` · `notice` · `child-end`, or undefined for every other frame. */
export function outEventOf(frame: EventFrame): OutEvent | undefined {
  const kind = frame.event.kind;
  if (kind === 'state' || kind === 'notice') return kind;
  if (kind === 'child' && frame.event.action === 'end') return 'child-end';
  return undefined;
}

/**
 * The body that leaves the host — built from an allowlist, never from the event's own fields.
 * #38610 REVIEW must: a per-kind `data` allowlist lets the state value and the child end's ok reach the receiver;
 * screen text (`line`/`text`) and tokens never do. No event field is spread or passed through whole.
 */
export function outPayload(frame: EventFrame, event: OutEvent, subscription: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const e = frame.event;
  if (event === 'state') {
    if (e.kind === 'state' && typeof e.state === 'string') data.state = e.state;
  } else if (event === 'child-end') {
    if (e.kind === 'child' && typeof e.ok === 'boolean') data.ok = e.ok;
    if (e.kind === 'child' && typeof e.id === 'string') data.id = e.id;
  } else if (event === 'notice') {
    if (e.kind === 'notice' && typeof e.level === 'string') data.level = e.level;
  }
  return { v: 1, subscription, event, pane: frame.pane, seq: frame.seq, at: frame.at, ...(Object.keys(data).length > 0 ? { data } : {}) };
}

function readSecret(stateDir: string, ref: string): string | undefined {
  try {
    const secret = readFileSync(isAbsolute(ref) ? ref : join(stateDir, ref), 'utf8').trim();
    return secret || undefined;
  } catch {
    return undefined;
  }
}

function readStatus(stateDir: string): Record<string, { connected: boolean; at: number; lastStatus?: number }> {
  try { return JSON.parse(readFileSync(join(stateDir, STATUS), 'utf8')) as Record<string, { connected: boolean; at: number }>; }
  catch { return {}; }
}

function markStatus(stateDir: string, id: string, connected: boolean, at: number, lastStatus?: number): void {
  try {
    const status = readStatus(stateDir);
    status[id] = { connected, at, ...(lastStatus !== undefined ? { lastStatus } : {}) };
    writeFileAtomic(join(stateDir, STATUS), `${JSON.stringify(status, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`els: webhook status not written: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

export function subscriptionStatus(stateDir: string): Record<string, { connected: boolean; at: number; lastStatus?: number }> {
  return readStatus(stateDir);
}

export function createOutboundWebhooks(deps: OutboundDeps) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // #38610 REVIEW must ② — the retry ceiling is a positive finite integer constant; only finite
  // non-negative delays are honored (an Infinity delay must never hang a delivery loop).
  const MAX_TRIES = 4;
  const backoff = (deps.backoffMs ?? [1_000, 4_000, 16_000]).filter((ms) => Number.isFinite(ms) && ms >= 0).slice(0, MAX_TRIES - 1);
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const resolve = deps.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((r) => r.address));
  const maxInFlight = Number.isInteger(deps.maxInFlight) && deps.maxInFlight! > 0 ? deps.maxInFlight! : 8;
  const inFlight = new Map<string, number>();
  const lastSeq = new Map<string, number>();

  async function send(sub: Subscription, secret: string, body: string, delivery: string): Promise<DeliveryResult> {
    let status: number | undefined;
    let tries = 0;
    for (let attempt = 1; attempt <= backoff.length + 1; attempt += 1) {
      tries = attempt;
      const timestamp = String(Math.floor(now() / 1000));
      try {
        const res = await doFetch(sub.url, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'content-type': 'application/json',
            'x-els-delivery': delivery,
            'x-els-timestamp': timestamp,
            'x-els-signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        // The body is never read: cancel it so the socket is released instead of waiting on the receiver.
        try { await res.body?.cancel(); } catch { /* already closed */ }
        if (res.status >= 200 && res.status < 300) return { subscription: sub.id, ok: true, tries: attempt, status };
        // A 4xx says the request itself is wrong; retrying cannot fix it. Only 408 and 429 are worth another try.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
      } catch {
        status = undefined;
      }
      if (attempt <= backoff.length) await sleep(backoff[attempt - 1]!);
    }
    return { subscription: sub.id, ok: false, tries, ...(status !== undefined ? { status } : {}) };
  }

  return {
    /** Deliver one frame to every matching subscription. Never throws. */
    async deliver(frame: EventFrame): Promise<readonly DeliveryResult[]> {
      // #38610 REVIEW must ② — NUMGUARD: shape and number guards refuse a frame BEFORE the pane
      // cursor moves, so a NaN/Infinity/negative/fractional seq or a bad `at` can never wedge that
      // pane's later deliveries. Every refusal is audited; the state stays untouched.
      const refuseFrame = (reason: string): readonly DeliveryResult[] => {
        audit(deps.stateDir, { principal: 'els', surface: 'webhook-out', action: 'deliver', result: 'refused', reason });
        return [];
      };
      if (!frame || frame.op !== 'event' || frame.v !== 1 || typeof frame.pane !== 'string' || !frame.pane) return refuseFrame('malformed frame');
      if (typeof frame.seq !== 'number' || !Number.isFinite(frame.seq) || !Number.isInteger(frame.seq) || frame.seq < 0) return refuseFrame(`bad seq ${String(frame.seq)}`);
      if (typeof frame.at !== 'number' || !Number.isFinite(frame.at) || frame.at < 0) return refuseFrame(`bad at ${String(frame.at)}`);
      if (!frame.event || typeof frame.event !== 'object' || typeof frame.event.kind !== 'string' || !frame.event.kind) return refuseFrame('malformed event');
      const previous = lastSeq.get(frame.pane);
      if (previous !== undefined && frame.seq <= previous) return [];
      lastSeq.set(frame.pane, frame.seq);
      const event = outEventOf(frame);
      if (!event) return [];
      const { allowHosts, subscriptions } = loadSubscriptions(deps.stateDir);
      const targets = subscriptions.filter((sub) => sub.events.includes(event) && (!sub.panes || sub.panes.length === 0 || sub.panes.includes(frame.pane)));
      const results: DeliveryResult[] = [];
      for (const sub of targets) {
        const used = inFlight.get(sub.id) ?? 0;
        if (used >= maxInFlight) {
          audit(deps.stateDir, { principal: 'els', surface: 'webhook-out', action: 'deliver', result: 'dropped', reason: 'in-flight cap reached', subscription: sub.id, pane: frame.pane, seq: frame.seq });
          results.push({ subscription: sub.id, ok: false, tries: 0 });
          continue;
        }
        inFlight.set(sub.id, used + 1);
        try {
          const denied = hostDenied(allowHosts, sub.url) ?? await addressDenied(sub.url, resolve);
          if (denied !== undefined) {
            audit(deps.stateDir, { principal: 'els', surface: 'webhook-out', action: 'deliver', result: 'denied', reason: denied, subscription: sub.id, pane: frame.pane, seq: frame.seq });
            results.push({ subscription: sub.id, ok: false, tries: 0 });
            continue;
          }
          const secret = readSecret(deps.stateDir, sub.secretRef);
          if (!secret) {
            audit(deps.stateDir, { principal: 'els', surface: 'webhook-out', action: 'deliver', result: 'denied', reason: 'secret unreadable', subscription: sub.id, pane: frame.pane, seq: frame.seq });
            results.push({ subscription: sub.id, ok: false, tries: 0 });
            continue;
          }
          const payload = outPayload(frame, event, sub.id);
          const delivery = randomUUID();
          const result = await send(sub, secret, JSON.stringify(payload), delivery);
          markStatus(deps.stateDir, sub.id, result.ok, now(), result.status);
          if (!result.ok) {
            try {
              mkdirSync(deps.stateDir, { recursive: true });
              appendFileSync(join(deps.stateDir, DEAD), `${JSON.stringify({ ts: new Date(now()).toISOString(), delivery, subscription: sub.id, tries: result.tries, ...(result.status !== undefined ? { status: result.status } : {}), payload })}\n`, { mode: 0o600 });
            } catch (error) {
              process.stderr.write(`els: webhook dead letter not written: ${error instanceof Error ? error.message : String(error)}\n`);
            }
          }
          results.push(result);
        } finally { inFlight.set(sub.id, (inFlight.get(sub.id) ?? 1) - 1); }
      }
      return results;
    },
  };
}
