// NEED-HUMAN-PUSH — the production deps of createNeedsHumanPush (ledger post · els coordinator lookup · decisions raise · logs).
import { spawn } from 'node:child_process';
import { ENV_EVENT_PANE, ENV_EVENT_SOCKET, ENV_EVENT_WS } from '../agent-events/protocol.js';
import { requestEls } from '../els/client.js';
import { canonicalMessageAddress, defaultMsgStorePath, openMsgStore, type MsgStore } from '../msg/msg-store.js';
import { resolveSeatRetroSeat } from '../seat/seat-retro-seat.js';
import { debug } from '../debug/log.js';
import { cheapHandClassifier } from '../kit/mail-route/hand-classifier.js';
import { liveHandCellLookups } from '../kit/mail-route/hand-cells.js';
import { handAskAnswer } from '../kit/mail-route/hand-dedupe.js';
import type { NeedsHumanDeps, NeedsHumanHandledBy } from './needs-human-push.js';

/**
 * Did `rung` handle the needs-human mail #msgId from `seat`? Read from the shared ledger at the 5-min check (the rung acts in its own
 * process): its TUI turn took the mail in (a seen/done/accepted receipt) · it mailed the blocked seat after the mail (id order) · the
 * mail row is acked. null = none of these.
 */
export function needsHumanHandledOn(store: MsgStore, input: { msgId: number; rung: string; seat: string }): NeedsHumanHandledBy | null {
  const rung = canonicalMessageAddress(input.rung); const seat = canonicalMessageAddress(input.seat);
  const table = (name: string): boolean => store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
  if (table('msg_receipts') && store.db.query(`SELECT 1 FROM msg_receipts WHERE message_id = ? AND recipient = ?
    AND state IN ('seen', 'accepted', 'done') LIMIT 1`).get(input.msgId, rung) !== null) return 'turn-ack';
  if (store.db.query('SELECT 1 FROM msg_messages WHERE id > ? AND sender = ? AND recipient = ? LIMIT 1').get(input.msgId, rung, seat) !== null) return 'reply';
  const status = store.messageStatus(rung, input.msgId);
  return status === 'acked' || status === 'done' ? 'ack' : null;
}

export function createNeedsHumanDeps(input: { cwd: string; resumeWith: (text: string) => void; env?: NodeJS.ProcessEnv }): NeedsHumanDeps {
  const env = input.env ?? process.env;
  let coordinator: string | null = null;
  // The coordinator comes from the els workspace setting; read once now (async) and kept — it rarely changes.
  const refresh = async (): Promise<void> => {
    const socket = env[ENV_EVENT_SOCKET]?.trim(); const ws = env[ENV_EVENT_WS]?.trim();
    if (!socket || !ws) return;
    try {
      const answer = await requestEls(socket, { op: 'ls' });
      const listed = JSON.parse(answer.message) as { workspaces?: { id?: string; name?: string; coordinatorSeat?: string }[] };
      coordinator = listed.workspaces?.find((row) => row.id === ws || row.name === ws)?.coordinatorSeat ?? null;
    } catch { coordinator = null; }
  };
  void refresh();
  return {
    seat: () => { try { return resolveSeatRetroSeat(input.cwd, env); } catch { return null; } },
    paneId: () => env[ENV_EVENT_PANE]?.trim() ?? '',
    coordinatorOf: () => coordinator,
    // KIT mail-route hand-route — an unstructured ✋ line asks Jev (decision model) once for its root (YAML threshold · 30 s cap · never blocks).
    classifyHand: (text) => cheapHandClassifier(text),
    // HAND-RAISE-DOMAIN-ROUTING — the seat's claimed cell (✋ ask identity · `cell-owner` route) and the by-reference answer.
    cellOf: (seat) => liveHandCellLookups()?.claimedCellOf(seat) ?? null,
    cellOwnerOf: (cell) => liveHandCellLookups()?.cellOwnerOf(cell) ?? null,
    answerOf: (msgId, seat) => {
      const store = openMsgStore(defaultMsgStorePath());
      try { return handAskAnswer(store, msgId, seat)?.body ?? null; } finally { store.close(); }
    },
    postMail: (envelope) => {
      const store = openMsgStore(defaultMsgStorePath());
      try { return store.post(envelope, { dedupe: true }).id; } finally { store.close(); }
    },
    handledBy: (q) => {
      const store = openMsgStore(defaultMsgStorePath());
      try { return needsHumanHandledOn(store, q); } finally { store.close(); }
    },
    ackFor: (rung, msgId) => {
      const store = openMsgStore(defaultMsgStorePath());
      try { if (store.messageStatus(rung, msgId) === 'delivered') store.ackMessage(rung, msgId, 'acked'); } finally { store.close(); }
    },
    raiseDecision: (card) => {
      const args = ['decisions', 'raise', '--title', card.title, '--category', 'scope', '--s', card.summary, '--c', `blockId ${card.blockId}`,
        '--pending-question', `근거: ${card.seat} 가 사람을 기다리며 멈췄다 (${card.reason})\n무엇이 바뀌나: 재개하면 ${card.seat} 가 일을 이어 간다\n기본값 시 결과: 멈춘 채 대기`,
        '--option', 'resume=재개:자리가 이어 간다', '--option', 'stop=중단:자리 일을 멈춘다', '--option', 'other=다른 방법:대표가 지시한다',
        '--skip-recommend', 'needs a person', '--no-xcheck', 'seat self-report', '--agent', card.seat];
      const child = spawn('elanous', args, { stdio: 'ignore', detached: true });
      child.on('error', () => { /* the log line below is the record */ });
      child.unref();
    },
    resumeWith: input.resumeWith,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: (event, data) => { debug.log('tui', event, data); },
  };
}
