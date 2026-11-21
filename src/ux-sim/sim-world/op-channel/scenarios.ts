// SIM-WORLD-OP-CHANNEL (CEO-CHANNEL-FIRST-CLASS · OP-CHANNEL-INGRESS-1121 — SIM-WORLD-P0-SWEEP ② OP 채널 장면
// 3개): the CEO channel's product-door axes replayed on the kernel contract. Each scenario drives the REAL code
// path — the real createCeoChannel boot on its own SQLite queue inside the scenario universe (the real allowlist,
// the real chat-bound re-key inside the boot, the real counts); only the outside (the sendReply egress · the
// ledger post · the SLA timers) is seamed. No token, no real seat ledger is ever opened.
// Ids are OP-C* (not C*): the capsule-events pack already owns C1/C2/C3 — the kernel's precheck 5 refuses the
// collision before anything runs.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCeoChannel, type CeoInbound } from '../../../els/ceo-channel.js';
import type { MessageEnvelope } from '../../../msg/msg-store.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

/** The SLA timers never fire inside a scenario (the red/failover axes live in the timer seams' own tests). */
const armNever = (): { cancel: () => void } => ({ cancel: () => {} });

/** OP #119739 / JUD #119740 — the retired 0.3.32 queue shape: (source, message_id) PK, no reply_text column. */
const RETIRED_SCHEMA = `CREATE TABLE IF NOT EXISTS ceo_inbox (
  source TEXT NOT NULL, message_id TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  thread_id TEXT, text TEXT NOT NULL, at INTEGER NOT NULL,
  state TEXT NOT NULL, seen_at INTEGER, answered_at INTEGER,
  PRIMARY KEY (source, message_id))`;

/** One queue row as the OP-C2/OP-C3 storage axes read it back — every identity field, not just row counts
 *  (JUD-B #120533: a count-only read passes even when the original rows were swapped for different ones). */
interface InboxRow {
  readonly source: string; readonly message_id: string; readonly chat_id: string; readonly sender_id: string;
  readonly thread_id: string | null; readonly text: string; readonly at: number; readonly state: string;
  readonly seen_at: number | null; readonly answered_at: number | null;
}

const readInbox = (dbFile: string): { readonly sql: string; readonly rows: readonly InboxRow[] } => {
  const db = new Database(dbFile, { readonly: true });
  try {
    const sql = ((db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ceo_inbox'")
      .get() as { sql: string } | undefined)?.sql ?? '');
    const rows = db.query('SELECT source, message_id, chat_id, sender_id, thread_id, text, at, state, seen_at, answered_at FROM ceo_inbox ORDER BY chat_id, message_id').all() as InboxRow[];
    return { sql, rows };
  } finally { db.close(); }
};

/** OP-C2 — the one chat's row state as the storage axis reads it back right now (null = no row yet). */
const stateOfChat = (dbFile: string, chatId: string): string | null =>
  readInbox(dbFile).rows.find((row) => row.chat_id === chatId)?.state ?? null;

/** OP-C3 — the exact seeded rows the storage axis must find INTACT after the rollback AND again after the re-key. */
const SEED_ROWS: readonly InboxRow[] = [
  { source: 'telegram', message_id: 'm-1', chat_id: 'chat-a', sender_id: 'ceo-1', thread_id: null, text: '재시작 전 행 a', at: 1, state: 'queued', seen_at: null, answered_at: null },
  { source: 'telegram', message_id: 'm-2', chat_id: 'chat-b', sender_id: 'ceo-2', thread_id: null, text: '재시작 전 행 b', at: 2, state: 'queued', seen_at: null, answered_at: null },
];
const rowIdentity = (row: InboxRow): string =>
  JSON.stringify([row.source, row.message_id, row.chat_id, row.sender_id, row.thread_id, row.text, row.at, row.state, row.seen_at, row.answered_at]);
const sameSeedRows = (rows: readonly InboxRow[]): boolean =>
  rows.length === SEED_ROWS.length && rows.every((row, index) => rowIdentity(row) === rowIdentity(SEED_ROWS[index]));
const simGrant = { ingressId: 'a'.repeat(64), sessionId: 'sim-op', turnRunId: 'sim-turn' };

/** OP-C1 · rows ①→③→④: one allowed-chat CEO message traverses the whole door. */
const opC1: SimWorldScenario = {
  id: 'OP-C1',
  title: 'one allowed chat CEO message queues one row, posts from=CEO to OP, is seen, answered and replied in the same thread',
  async run(ctx) {
    const stateDir = join(ctx.universeRoot, 'ceo-channel-op-c1');
    const posted: MessageEnvelope[] = [];
    const replies: Array<{ readonly inbound: CeoInbound; readonly text: string }> = [];
    const channel = createCeoChannel({
      stateDir,
      allow: () => ['chat-op'],
      now: () => 1_000_000,
      arm: armNever,
      post: (envelope) => { posted.push(envelope); },
      sendReply: async (inbound, text) => { replies.push({ inbound, text }); return true; },
    });
    try {
      const inbound: CeoInbound = { source: 'telegram', chatId: 'chat-op', senderId: 'ceo-1', messageId: 'm-1', threadId: '777', text: 'P0 확인 요청', at: 999_000 };
      const received = await channel.receive(inbound);
      const afterReceive = channel.counts();
      const seen = channel.markSeen({ source: 'telegram', chatId: 'chat-op', messageId: 'm-1' });
      const afterSeen = channel.counts();
      channel.acceptIngress({ source: 'telegram', chatId: 'chat-op', messageId: 'm-1' }, simGrant.ingressId, simGrant);
      const answered = await channel.markAnswered({ source: 'telegram', chatId: 'chat-op', messageId: 'm-1' }, '확인했습니다', simGrant);
      const final = channel.counts();
      ctx.recorder.event('op-c1-lifecycle', {
        received: received.status, ledgerFrom: posted[0]?.from ?? null, ledgerTo: posted[0]?.to ?? null,
        ledgerKind: posted[0]?.kind ?? null, seen, answered, afterReceive, afterSeen, final, replies: replies.length,
      });
      const mail = posted[0];
      const reply = replies[0];
      if (received.status === 'accepted' && afterReceive.waiting === 1
        && mail && mail.from === 'CEO' && mail.to === 'OP' && mail.kind === 'coord'
        && (mail.refs ?? []).includes('telegram-message:m-1')
        && seen && afterSeen.waiting === 1 && answered && replies.length === 1
        && reply && reply.inbound.chatId === 'chat-op' && reply.inbound.messageId === 'm-1'
        && reply.inbound.threadId === '777' && reply.text === '확인했습니다'
        && final.waiting === 0 && final.answered === 1 && final.outbox === 0) return { ok: true };
      return fail('CEO message did not traverse receive→seen→answered→reply',
        `receive ${received.status} · afterReceive ${JSON.stringify(afterReceive)} · mail ${JSON.stringify(posted.map((row) => [row.from, row.to, row.kind, row.refs]))} · seen ${seen} · afterSeen ${JSON.stringify(afterSeen)} · answered ${answered} · replies ${JSON.stringify(replies.map((row) => [row.inbound.chatId, row.inbound.messageId, row.inbound.threadId ?? null, row.text]))} · final ${JSON.stringify(final)}`);
    } finally { channel.stop(); }
  },
};

/** OP-C2 · row ① dedupe axis: telegram message ids are per-chat — two allowed chats may share one id. */
const opC2: SimWorldScenario = {
  id: 'OP-C2',
  title: 'the same telegram message id in two allowed chats is two queue rows, seen and answered independently',
  async run(ctx) {
    const stateDir = join(ctx.universeRoot, 'ceo-channel-op-c2');
    const dbFile = join(stateDir, 'ceo-channel.db');
    const stateOf = (chatId: string): string | null => stateOfChat(dbFile, chatId);
    const replies: string[] = [];
    const channel = createCeoChannel({
      stateDir,
      allow: () => ['chat-a', 'chat-b'],
      now: () => 2_000_000,
      arm: armNever,
      post: () => undefined,
      sendReply: async (inbound) => { replies.push(inbound.chatId); return true; },
    });
    try {
      const first = await channel.receive({ source: 'telegram', chatId: 'chat-a', senderId: 'ceo-1', messageId: 'm-9', text: '같은 id 첫 채팅', at: 2_000_000 });
      const afterFirst = { a: stateOf('chat-a'), b: stateOf('chat-b') };
      const second = await channel.receive({ source: 'telegram', chatId: 'chat-b', senderId: 'ceo-2', messageId: 'm-9', text: '같은 id 둘째 채팅', at: 2_000_100 });
      const afterBoth = { a: stateOf('chat-a'), b: stateOf('chat-b') };
      const waiting2 = channel.counts();
      const seenA = channel.markSeen({ source: 'telegram', chatId: 'chat-a', messageId: 'm-9' });
      const afterSeenA = { a: stateOf('chat-a'), b: stateOf('chat-b') };
      const seenB = channel.markSeen({ source: 'telegram', chatId: 'chat-b', messageId: 'm-9' });
      const afterSeenB = { a: stateOf('chat-a'), b: stateOf('chat-b') };
      channel.acceptIngress({ source: 'telegram', chatId: 'chat-a', messageId: 'm-9' }, simGrant.ingressId, simGrant);
      channel.acceptIngress({ source: 'telegram', chatId: 'chat-b', messageId: 'm-9' }, simGrant.ingressId, simGrant);
      const answeredA = await channel.markAnswered({ source: 'telegram', chatId: 'chat-a', messageId: 'm-9' }, 'A 답장', simGrant);
      const afterAnsweredA = { a: stateOf('chat-a'), b: stateOf('chat-b') };
      const answeredB = await channel.markAnswered({ source: 'telegram', chatId: 'chat-b', messageId: 'm-9' }, 'B 답장', simGrant);
      const afterAnsweredB = { a: stateOf('chat-a'), b: stateOf('chat-b') };
      const final = channel.counts();
      const stepStates = { afterFirst, afterBoth, afterSeenA, afterSeenB, afterAnsweredA, afterAnsweredB };
      ctx.recorder.event('op-c2-two-chats', {
        first: first.status, second: second.status, waiting2, seenA, seenB, answeredA, answeredB, final, replies,
      });
      // JUD-B #120533: each step must leave the OTHER chat's row untouched — per-step row states, not just the aggregate.
      if (first.status === 'accepted' && second.status === 'accepted' && waiting2.waiting === 2 && seenA && seenB
        && answeredA && answeredB && final.waiting === 0 && final.answered === 2 && final.outbox === 0
        && JSON.stringify(replies) === JSON.stringify(['chat-a', 'chat-b'])
        && afterFirst.a === 'queued' && afterFirst.b === null
        && afterBoth.a === 'queued' && afterBoth.b === 'queued'
        && afterSeenA.a === 'seen' && afterSeenA.b === 'queued'
        && afterSeenB.a === 'seen' && afterSeenB.b === 'seen'
        && afterAnsweredA.a === 'answered' && afterAnsweredA.b === 'seen'
        && afterAnsweredB.a === 'answered' && afterAnsweredB.b === 'answered') return { ok: true };
      return fail('chat-bound key collapsed two chats into one inbox row (or a step leaked into the other chat)',
        `first ${first.status} · second ${second.status} · waiting after both ${waiting2.waiting} · seen ${seenA}/${seenB} · answered ${answeredA}/${answeredB} · final ${JSON.stringify(final)} · replies ${JSON.stringify(replies)} · per-step row states ${JSON.stringify(stepStates)}`);
    } finally { channel.stop(); }
  },
};

/** OP-C3 · 저장 실패 중 재시작 (JUD #119836 / OP #119845): a boot against the retired (source, message_id) key
 * without reply_text rolls the ONE-transaction re-key back (migrate-rolled-back), keeps both queued rows, and the
 * next boot — after the storage axis restores the missing column — re-keys them under the chat-bound key. */
const opC3: SimWorldScenario = {
  id: 'OP-C3',
  title: 'a failed re-key rolls back without losing rows and the next boot re-keys both chats under the chat-bound key',
  async run(ctx) {
    const stateDir = join(ctx.universeRoot, 'ceo-channel-op-c3');
    mkdirSync(stateDir, { recursive: true });
    const dbFile = join(stateDir, 'ceo-channel.db');
    const seed = new Database(dbFile);
    try {
      seed.exec(RETIRED_SCHEMA);
      // Two queued rows under the retired key (distinct ids — the retired PK itself refuses a shared one; the
      // shared-id collision axis is OP-C2's).
      seed.exec("INSERT INTO ceo_inbox (source, message_id, chat_id, sender_id, text, at, state) VALUES ('telegram', 'm-1', 'chat-a', 'ceo-1', '재시작 전 행 a', 1, 'queued')");
      seed.exec("INSERT INTO ceo_inbox (source, message_id, chat_id, sender_id, text, at, state) VALUES ('telegram', 'm-2', 'chat-b', 'ceo-2', '재시작 전 행 b', 2, 'queued')");
    } finally { seed.close(); }
    const boot = (events: string[]) => createCeoChannel({
      stateDir,
      allow: () => ['chat-a', 'chat-b'],
      now: () => 3_000_000,
      arm: armNever,
      post: () => undefined,
      sendReply: async () => true,
      log: (event) => { events.push(event); },
    });
    // 부팅 1 — the retired table predates reply_text: the re-key COPY fails and rolls the whole transaction back.
    const boot1Events: string[] = [];
    const boot1 = boot(boot1Events);
    const counts1 = boot1.counts();
    boot1.stop();
    const afterBoot1 = readInbox(dbFile);
    // 수동 열 복구(시나리오가 시뮬레이션) — pre-0.3.33 백업에 reply_text 가 없던 운영 사고의 사후 처리를 이 시나리오가
    // 대신 수행한다. 자동 복구가 아니며 자동 복구 증거로 주장하지 않는다(JUD-B #120533 ③).
    const repair = new Database(dbFile);
    try { repair.exec('ALTER TABLE ceo_inbox ADD COLUMN reply_text TEXT'); } finally { repair.close(); }
    // 부팅 2 — same db, same rows: the retry re-key now completes under the chat-bound key.
    const boot2Events: string[] = [];
    const boot2 = boot(boot2Events);
    const counts2 = boot2.counts();
    boot2.stop();
    const afterBoot2 = readInbox(dbFile);
    const chatBound = (sql: string) => sql.includes('PRIMARY KEY (source, chat_id, message_id)');
    ctx.recorder.event('op-c3-reboot', {
      boot1Events, counts1, rowsAfterBoot1: afterBoot1.rows.length, chatBoundAfterBoot1: chatBound(afterBoot1.sql),
      boot2Events, counts2, rowsAfterBoot2: afterBoot2.rows.length, chatBoundAfterBoot2: chatBound(afterBoot2.sql),
    });
    if (!boot1Events.includes('migrate-rolled-back'))
      return fail('a failed re-key was not rolled back loudly', `boot 1 events ${JSON.stringify(boot1Events)} (expected migrate-rolled-back)`);
    if (afterBoot1.rows.length !== 2 || counts1.waiting !== 2 || chatBound(afterBoot1.sql) || !sameSeedRows(afterBoot1.rows))
      return fail('a failed re-key destroyed, renamed or corrupted the queued rows',
        `after boot 1 rows ${JSON.stringify(afterBoot1.rows)} · counts ${JSON.stringify(counts1)} · chat-bound pk ${chatBound(afterBoot1.sql)} · rows-identical-to-seed ${sameSeedRows(afterBoot1.rows)}`);
    if (boot2Events.includes('migrate-rolled-back'))
      return fail('the retry re-key failed again', `boot 2 events ${JSON.stringify(boot2Events)}`);
    if (afterBoot2.rows.length !== 2 || counts2.waiting !== 2 || !chatBound(afterBoot2.sql) || !sameSeedRows(afterBoot2.rows))
      return fail('the retry re-key did not carry both rows — field-identical — under the chat-bound key',
        `after boot 2 rows ${JSON.stringify(afterBoot2.rows)} · counts ${JSON.stringify(counts2)} · sql ${JSON.stringify(afterBoot2.sql)} · rows-identical-to-seed ${sameSeedRows(afterBoot2.rows)}`);
    return { ok: true };
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [opC1, opC2, opC3];
