// kit/bus-post — the shared executor of the `bus-post` node kind (CONTEXT-BUS-FEDERATION ③ · 0.3.39 P0 · CEO 11-28 08:4x
// «나중에는 주요 루프 에이전트(수호자 등) 사이에도»).
//
// S: loop agents told their L0 everything by mail: silence-watch 44 notices a day to OP (26 lesson candidates · 18 «no reading
//    body» notices) · guardian 15 «30-min» status digests a day to RES (a loop-agent kingdom nobody reads in a conversation).
//    Mail is the request channel; a notice in it is noise the mail-route kit then has to fold.
// C: plugin form — an agent opts in by declaring the `bus-post` node in its agent.yaml (no per-agent TS) · requests and ✋
//    stay mail (lint refuses them as notices) · a notice moves to the bus only when the L0 is known to read it (it acked a
//    digest recently), otherwise it stays mail · a bus write that fails falls back to the mail port once (its key dedupes).
// Q: how does a loop agent's notice reach its L0 as context instead of mail, without losing it when the bus is down?
// A: `busNoticePort(mail, cfg, deps)` wraps the agent's deduped mail port: a post whose kind is one of the agent.yaml
//    `bus.notices` → one `status` item in the L0's space (`busL0Space` · refs seat:<to> ⊕ notice:<kind> · the mail key as
//    the bus key, so a repeat tick is a duplicate) · not a reader / not a notice → the mail port unchanged · a throw → mail.
//
// 세 얼굴: 관측 = debug.log('bus', 'bus.notice' {route: bus|mail|fallback|duplicate}) ⊕ `eln bus tail --space <L0>` ·
//          인지 = busPostConfigOf (agent.yaml) ⊕ busL0Space ⊕ busReaderSeen ·
//          수복과 인계 = bus write failure → the mail port (once: appendOnce key · a later bus write skips a key mail already holds).
import { BUS_DEFAULT_SPACE, busPost as realBusPost, type BusPostInput, type BusPostResult } from '../../op-context-bus/bus.js';
import { busL0Space, busReaderSeen } from '../../op-context-bus/spaces.js';
import type { OrgMap } from '../../org/org-map.js';

/** The node kind an agent.yaml declares to route its notices through this kit. */
export const BUS_POST_NODE_KIND = 'bus-post';
/** Mail kinds that may become bus notices. A request (or ✋) is never one — mail is the channel for asking. */
export const BUS_NOTICE_KINDS: readonly string[] = ['info', 'status'];
/** The reader window policy name (hours) the node kind needs. */
export const BUS_READER_WINDOW_POLICY = 'bus_reader_window_h';

export interface BusPostConfig {
  /** Mail kinds this agent posts as bus `status` items (subset of BUS_NOTICE_KINDS). */
  readonly notices: readonly string[];
  readonly readerWindowMs: number;
}

/** From a compiled agent.yaml: the config when its body declares a `bus-post` node, else null (mail as before). */
export function busPostConfigOf(c: { readonly body: { readonly nodes: readonly { readonly kind: string }[] }; readonly policies: Readonly<Record<string, number>>; readonly bus?: { readonly notices: readonly string[] } | null } | null | undefined): BusPostConfig | null {
  if (!c || !c.body.nodes.some((n) => n.kind === BUS_POST_NODE_KIND)) return null;
  const notices = (c.bus?.notices?.length ? c.bus.notices : BUS_NOTICE_KINDS).filter((k) => BUS_NOTICE_KINDS.includes(k));
  const h = c.policies[BUS_READER_WINDOW_POLICY];
  return { notices, readerWindowMs: typeof h === 'number' && Number.isFinite(h) && h > 0 ? h * 3_600_000 : 0 }; // no bus_reader_window_h policy → window 0 = no reader seen → mail (agent.yaml owns the window · YAML-FIRST)
}

export type MailPort<R> = (key: string, to: string, body: string, kind?: string) => R;
export type BusNoticeRoute = 'bus' | 'mail' | 'fallback' | 'duplicate';

export interface BusNoticeDeps {
  readonly stateRoot: string;
  /** The agent's address (the bus item's `from`). */
  readonly from: string;
  readonly org: () => OrgMap;
  readonly now?: () => number;
  /** Seams (sims · tests): the bus writer and the reader probe. */
  readonly busPost?: (stateRoot: string, input: BusPostInput, opts: { space: string; now?: number }) => BusPostResult;
  readonly readerSeen?: (seat: string, space: string, nowMs: number, windowMs: number) => boolean;
  /** Does the mail ledger already hold this key? (a notice that fell back to mail is not posted to the bus later) */
  readonly mailHas?: (key: string) => boolean;
  readonly onRoute?: (e: { readonly route: BusNoticeRoute; readonly key: string; readonly to: string; readonly space?: string; readonly why?: string }) => void;
}

/**
 * Wrap a deduped mail port: notices go to the L0's bus space as `status` (when the L0 reads the bus), everything else —
 * and every notice the bus cannot take — goes to `mail` unchanged. Returns `bus:<id>` for a bus item, null for a duplicate.
 */
export function busNoticePort<R>(mail: MailPort<R>, cfg: BusPostConfig, deps: BusNoticeDeps): MailPort<R | string | null> {
  const write = deps.busPost ?? ((root: string, input: BusPostInput, opts: { space: string; now?: number }) => realBusPost(root, input, opts));
  // a reader = acked a digest in the L0 space or in OP (every bus-reading seat's turn acks the OP space it reads)
  const seen = deps.readerSeen ?? ((seat: string, space: string, nowMs: number, windowMs: number) => busReaderSeen(deps.stateRoot, seat, [space, BUS_DEFAULT_SPACE], nowMs, windowMs));
  const note = (e: Parameters<NonNullable<BusNoticeDeps['onRoute']>>[0]) => { try { deps.onRoute?.(e); } catch { /* observe only */ } log(e); };
  return (key, to, body, kind) => {
    const k = kind ?? 'request';
    if (!cfg.notices.includes(k)) { note({ route: 'mail', key, to, why: `kind ${k}` }); return mail(key, to, body, kind); }
    let space: string;
    try { space = busL0Space(to, deps.org()); } catch (error) { note({ route: 'mail', key, to, why: `org ${String(error).slice(0, 80)}` }); return mail(key, to, body, kind); }
    const now = deps.now?.() ?? Date.now();
    if (!seen(space, space, now, cfg.readerWindowMs)) { note({ route: 'mail', key, to, space, why: 'L0 does not read the bus' }); return mail(key, to, body, kind); }
    try { if (deps.mailHas?.(key)) { note({ route: 'duplicate', key, to, space, why: 'already mailed' }); return null; } } catch { /* unknown → try the bus */ }
    try {
      const r = write(deps.stateRoot, { type: 'status', from: deps.from, body, refs: [`seat:${to.trim().toUpperCase()}`, `notice:${k}`], key }, { space, now });
      if (r.kind === 'posted') { note({ route: 'bus', key, to, space }); return `bus:${r.entry.id}`; }
      note({ route: 'duplicate', key, to, space });
      return null;
    } catch (error) {
      // The bus is down / locked: the notice is not lost — the mail port takes it (deduped by key, so once).
      note({ route: 'fallback', key, to, space, why: String(error).slice(0, 120) });
      return mail(key, to, body, kind);
    }
  };
}

/** Live: the agent.yaml at `<cardsRoot>/<id>` → its bus-post config (null = absent · refused · no bus-post node). */
export function liveBusPostConfig(id: string, root?: string): BusPostConfig | null {
  try {
    const { join } = require('node:path') as typeof import('node:path');
    const { cardsRoot } = require('../../loop-agent/card.js') as typeof import('../../loop-agent/card.js');
    const { lintAgentDir } = require('../../loop-agent/v3/agent-yaml.js') as typeof import('../../loop-agent/v3/agent-yaml.js');
    const r = lintAgentDir(join(root ?? cardsRoot(), id));
    return r.ok ? busPostConfigOf(r.compiled) : null;
  } catch { return null; }
}

/** Live: wrap `mail` for agent `id` when its agent.yaml declares the node — else `mail` itself. */
export function liveBusNoticePort<R>(id: string, from: string, mail: MailPort<R>, opts: { stateRoot: string; mailHas?: (key: string) => boolean; root?: string }): MailPort<R | string | null> {
  const cfg = liveBusPostConfig(id, opts.root);
  if (!cfg) return mail;
  return busNoticePort(mail, cfg, {
    stateRoot: opts.stateRoot, from,
    org: () => (require('../../org/org-map.js') as typeof import('../../org/org-map.js')).loadOrgMap().org,
    ...(opts.mailHas ? { mailHas: opts.mailHas } : {}),
  });
}

function log(e: { route: string; key: string; to: string; space?: string; why?: string }): void {
  try { (require('../../debug/log.js') as typeof import('../../debug/log.js')).debug.log('bus', 'bus.notice', { route: e.route, key: e.key.slice(0, 120), to: e.to, ...(e.space ? { space: e.space } : {}), ...(e.why ? { why: e.why } : {}) }); } catch { /* fail-open */ }
}
