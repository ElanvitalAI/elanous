// LOOP-AGENT v2 generic shell — live ports: instance-root memory · deduped mail from the agent's own address · watchers beat ·
// the configured role LLM (one non-tool call) · the knowhow seed from the repo. Every reader fails open into «unknown».
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardsRoot, type AgentCard } from './card.js';
import { fileAgentMemory, type AgentMemory } from './memory.js';
import type { AgentPorts, VoiceLlm } from './runtime.js';
import { roleLlm } from './role-llm.js';

export const liveStateRoot = (): string => (require('../instance/resolve.js') as typeof import('../instance/resolve.js')).effectiveInstanceRoot();

/** The card as a human-readable card.md in the agent's home (rewritten only when it changes). */
export function renderCardMd(card: AgentCard): string {
  return [`# ${card.name} (${card.id})`, '', `- 주소: ${card.address} · @loop:${card.id}`, `- L0 감독: ${card.supervisor}`, `- 역할: ${card.role || '-'}`, `- 기질: ${card.temperament || '-'}`,
    `- 가치: ${card.values.join(' / ') || '-'}`, `- 대상: ${card.subject || '-'}`, `- 목표: ${card.goal || '-'}`,
    `- KPI: ${card.kpi.name} ${card.kpi.dir === 'at_most' ? '≤' : '≥'} ${card.kpi.target}${card.kpi.unit ? ` ${card.kpi.unit}` : ''}`, `- 완료 조건: ${card.doneWhen.join(' · ') || '-'}`,
    `- 행동권: ${card.rights.actions.join(', ')} (틱당 ≤${card.rights.maxPerTick} · 쿨다운 ${card.rights.cooldownMin}분)`, `- 하지 않는 것: ${card.rights.neverAuto.join(' · ') || '-'}`,
    `- 깨움: ${card.wake.events.join(' · ') || '-'} · 최대 ${card.wake.maxWaitMin}분`, `- heartbeat: loop:${card.id} 매 ${card.heartbeatEveryMin}분`, '', card.soulText, ''].join('\n');
}

/** Seed the agent's knowhow pack from graphs/loop-agents/<id>/knowhow.md (versioned by hash) and refresh card.md. */
export function refreshHome(mem: AgentMemory, id: string, card: AgentCard | null, root = cardsRoot()): { seeded: boolean } {
  const seedPath = join(root, id, 'knowhow.md');
  const seeded = existsSync(seedPath) ? mem.seedKnowhow(readFileSync(seedPath, 'utf8')) : false;
  if (card) mem.writeCardMd(renderCardMd(card));
  return { seeded };
}

/** kit/loop-shell role-llm: the one voice LLM (through streamLLM · usage site loop-agent:<id>). */
export function configuredRoleLlm(role = 'coordinator', maxTokens = 900, site = 'loop-agent'): VoiceLlm | null {
  return roleLlm(role, { maxTokens, site });
}

export interface LivePorts extends AgentPorts { close(): void }

export function livePorts(card: AgentCard, opts: { stateRoot?: string; llm?: boolean; speak?: (line: string) => void } = {}): LivePorts {
  const stateRoot = opts.stateRoot ?? liveStateRoot();
  const memory = fileAgentMemory(stateRoot, card.id, card.supervisor);
  refreshHome(memory, card.id, card);
  let store: import('../msg/msg-store.js').MsgStore | null = null;
  const openStore = () => {
    if (!store) { const m = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js'); store = m.openMsgStore(m.defaultMsgStorePath()); }
    return store;
  };
  const mail = (key: string, to: string, body: string, kind = 'request'): number | null => {
    try {
      const { appendOnce } = require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js');
      const w = appendOnce(openStore(), key, () => ({ from: card.address, to, body, kind, intent: kind === 'info' || kind === 'status' ? 'info' : 'decision', refs: [key.slice(0, 200)] }));
      return w.fresh ? w.mail.id : null;
    } catch { return null; }
  };
  // CONTEXT-BUS-FEDERATION ③ — an agent.yaml with a `bus-post` node sends its notices to the L0's bus space (kit/bus-post);
  // requests, a non-reading L0 and a failed bus write keep this mail port. No node → the mail port itself.
  const { liveBusNoticePort } = require('../kit/bus-post/index.js') as typeof import('../kit/bus-post/index.js');
  const post = liveBusNoticePort(card.id, card.address, mail, { stateRoot, mailHas: (key) => { try { return openStore().findByProvenanceKey(key) !== null; } catch { return false; } } });
  return {
    memory,
    post(key, to, body, kind = 'request') { return post(key, to, body, kind); },
    beat(b) { try { (require('../kit/heartbeat/index.js') as typeof import('../kit/heartbeat/index.js')).beatSafe(b); } catch { /* fail-soft */ } },
    ...(opts.speak ? { speak: opts.speak } : {}),
    llm: opts.llm === false ? null : configuredRoleLlm(card.voice.role, 900, `loop-agent:${card.id}`),
    rollup: liveRollupSink(card.id, openStore),
    // SUPERVISORS-EXECUTE-NOT-PROPOSE: the hold ledger (eln hold) — read errors throw → the runtime holds (fail-closed)
    holdOn(target, now) {
      const hl = require('../hold-ledger/hold-ledger.js') as typeof import('../hold-ledger/hold-ledger.js');
      const h = hl.holdOverTarget(hl.readHolds(stateRoot, now), target, now);
      return h ? `${h.id} (${h.owner} · ${h.cells.join(',')} · ~${h.expiresAt.slice(11, 16)}Z)` : null;
    },
    close() { try { (store as { close(): void } | null)?.close(); } catch { /* closed */ } },
  };
}

/** SUPERVISOR-CORRECTION-JOURNAL rollup sink: one deduped mail SUPERVISOR-JOURNAL → OP (the 30-min machine digest folds it ·
 *  ref = the window key) ⊕ one line into ws:supervisors. Fail-soft: the journal keeps every row whatever happens here. */
export function liveRollupSink(id: string, store: () => import('../msg/msg-store.js').MsgStore): import('./journal.js').RollupSink {
  const { JOURNAL_SENDER } = require('./journal.js') as typeof import('./journal.js');
  const { channelSpeaker, SUPERVISORS_CHANNEL } = require('./speak.js') as typeof import('./speak.js');
  const speak = channelSpeaker(id, [SUPERVISORS_CHANNEL]);
  return (key, line) => {
    try {
      const { appendOnce } = require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js');
      const w = appendOnce(store(), key, () => ({ from: JOURNAL_SENDER, to: 'OP', body: line, kind: 'info', intent: 'info', refs: [key.slice(0, 200)] }));
      if (!w.fresh) return; // this window was already rolled up (another tick) — do not speak it twice
    } catch { /* the ws line still goes out */ }
    speak(line);
  };
}

/** Bespoke agents (judge-butler · guardian · land-steward): roll up their journal windows after their own tick. */
export async function liveJournalRollup(id: string, now = new Date()): Promise<string[]> {
  const { emitWindowRollups } = await import('./journal.js');
  const { agentHome } = await import('./memory.js');
  let store: import('../msg/msg-store.js').MsgStore | null = null;
  try {
    const lines = emitWindowRollups(agentHome(liveStateRoot(), id), id, now, liveRollupSink(id, () => (store ??= openLiveStore())));
    await (await import('./speak.js')).flushSpeakers();
    return lines;
  } catch { return []; } finally { try { (store as { close(): void } | null)?.close(); } catch { /* closed */ } }
}

/** Mail to the agent's own address (alias loop:<id>) not yet answered by it, newest 6 h, ✋ hand mail excluded — the voice
 *  answers these on each tick (≤ max per tick), the reply goes back as `kind: reply` with `replyTo`. */
export interface MailInbox { pending(nowMs: number, max?: number): import('./runtime.js').VoiceMessage[]; reply(msg: import('./runtime.js').VoiceMessage, text: string, refs: readonly string[]): number | null }
export function mailInbox(address: string, store: import('../msg/msg-store.js').MsgStore, lookbackMs = 6 * 3_600_000): MailInbox {
  return {
    pending(nowMs, max = 5) {
      const rows = store.db.query(`SELECT id, sender, body, created_at, refs_json FROM msg_messages m WHERE recipient = ? AND sender != ? AND created_at >= ?
        AND NOT EXISTS (SELECT 1 FROM msg_messages r WHERE r.sender = ? AND r.reply_to = m.id) ORDER BY id ASC LIMIT 20`)
        .all(address, address, new Date(nowMs - lookbackMs).toISOString(), address) as Array<{ id: number; sender: string; body: string; created_at: string; refs_json: string | null }>;
      return rows.filter(r => !/"block:/u.test(r.refs_json ?? '')).slice(0, max)
        .map(r => ({ id: r.id, from: r.sender, body: r.body, at: r.created_at, channel: 'mail', thread: `mail:${r.sender}` }));
    },
    reply(msg, text, refs) {
      try { return store.post({ from: address, to: msg.from, body: text, kind: 'reply', replyTo: Number(msg.id), refs: [...refs].slice(0, 12) }).id; } catch { return null; }
    },
  };
}

/** Open the live msg store once (callers close it). */
export function openLiveStore(): import('../msg/msg-store.js').MsgStore {
  const m = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  return m.openMsgStore(m.defaultMsgStorePath());
}

/** One deduped mail from a body's action (actions do not get the runtime ports): a short-lived livePorts post, closed at once. */
export function livePost(stateRoot: string, card: AgentCard | undefined, id: string): (key: string, to: string, body: string, kind?: string) => number | string | null {
  return (key, to, body, kind) => {
    try {
      const ports = livePorts(card ?? (require('./card.js') as typeof import('./card.js')).loadCard(id), { stateRoot, llm: false });
      try { return ports.post(key, to, body, kind ?? 'info'); } finally { ports.close(); }
    } catch { return null; }
  };
}

/** Like livePost, but a send that could not happen (card / store error) is `false`, not «already sent» (null). */
export function livePostResult(stateRoot: string, card: AgentCard | undefined, id: string): (key: string, to: string, body: string, kind?: string) => number | string | null | false {
  void stateRoot;
  return (key, to, body, kind) => {
    try {
      const c = card ?? (require('./card.js') as typeof import('./card.js')).loadCard(id);
      const { appendOnce } = require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js');
      const { openMsgStore, defaultMsgStorePath } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
      const store = openMsgStore(defaultMsgStorePath());
      try {
        const w = appendOnce(store, key, () => ({ from: c.address, to, body, kind: kind ?? 'info', intent: 'info', refs: [key.slice(0, 200)] }));
        return w.fresh ? w.mail.id : null;
      } finally { store.close(); }
    } catch { return false; }
  };
}
