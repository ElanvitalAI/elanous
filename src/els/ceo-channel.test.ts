// CEO-CHANNEL-FIRST-CLASS · CEO-MSG-ACK-SLA-FAILOVER — boundary tests for the els-server CEO chat ingress
// (OP-CHANNEL-INGRESS-1121 rows ①③④, owner TC-H-CC-1; row ② injection stays HAND-ELN-ELS-API's seam).
//   ① ingress: from=CEO allowlist validation · SQLite disk queue · source+chat+messageId dedupe (중복 0 —
//      telegram ids are per-chat: two chats may share one id) · restart redelivery.
//   ③ receipt: 👀 = session pickup (not filing) · 30s without 👀 → red · 5min without an answer → same-thread
//      «⏰ OP 무응답 5분 · RES 대신 받음» + the same event to RES.
//   ④ reply: the OP answer goes back into the SAME thread; a failed send is batched and retried.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCeoChannel, ensureChatBoundKey, QUEUE_SCHEMA, CEO_SEEN_SLA_MS, CEO_ANSWER_SLA_MS, CEO_FAILover_TEXT, type CeoInbound } from './ceo-channel.js';

/** Manual clock: arms are queued and ticked in order, so SLA bounds are observed without real waits. */
class FakeClock {
  t = 0;
  private jobs: { at: number; fire: () => void }[] = [];
  now = (): number => this.t;
  arm = (delayMs: number, fire: () => void) => {
    const job = { at: this.t + delayMs, fire };
    this.jobs.push(job);
    return { cancel: () => { job.at = Number.POSITIVE_INFINITY; } };
  };
  async tick(ms: number): Promise<void> {
    this.t += ms;
    const due = this.jobs.filter((j) => j.at <= this.t).sort((a, b) => a.at - b.at);
    for (const job of due) { job.at = Number.POSITIVE_INFINITY; job.fire(); }
  }
}

const freshDir = (): string => {
  const dir = join(tmpdir(), `ceo-channel-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const inbound = (over: Partial<CeoInbound> = {}): CeoInbound => ({
  source: 'telegram', chatId: '100', senderId: '7', messageId: 'm1', text: '살아 있나요', at: 1_000, ...over,
});
const grant = { ingressId: 'a'.repeat(64), sessionId: 'op-session', turnRunId: 'op-turn' };
const accept = (channel: ReturnType<typeof createCeoChannel>, messageId = 'm1') => {
  const key = { source: 'telegram' as const, chatId: '100', messageId };
  expect(channel.acceptIngress(key, grant.ingressId, grant)).toBe(true);
  return key;
};

const setup = (over: Parameters<typeof createCeoChannel>[0] extends undefined ? never : any = {}) => {
  const clock = new FakeClock();
  const dir = freshDir();
  const posts: any[] = [];
  const replies: { inbound: CeoInbound; text: string }[] = [];
  const stale: CeoInbound[] = [];
  const injected: CeoInbound[] = [];
  let replyOk = true;
  const channel = createCeoChannel({
    stateDir: dir,
    allow: () => ['100'],
    now: clock.now,
    arm: clock.arm,
    post: (envelope: any) => { posts.push(envelope); return posts.length; },
    sendReply: async (m, text) => { replies.push({ inbound: m, text }); return replyOk; },
    onStale: (m) => { stale.push(m); },
    inject: async (m) => { injected.push(m); },
    ...over,
  });
  return { channel, clock, dir, posts, replies, stale, injected, failReply: () => { replyOk = false; }, okReply: () => { replyOk = true; }, cleanup: () => { rmSync(dir, { recursive: true, force: true }); channel.stop(); } };
};

describe('CEO channel ingress ① — from=CEO allowlist + disk queue', () => {
  test('a chat not on the allowlist is rejected: nothing queued, nothing posted', async () => {
    const s = setup();
    try {
      const r = await s.channel.receive(inbound({ chatId: '999' }));
      expect(r.status).toBe('rejected');
      expect(s.channel.counts().waiting).toBe(0);
      expect(s.posts).toBeEmpty();
      expect(s.replies).toBeEmpty();
    } finally { s.cleanup(); }
  });

  test('an allowed message posts to the mail ledger as from=CEO (never OP)', async () => {
    const s = setup();
    try {
      await s.channel.receive(inbound());
      expect(s.posts.length).toBe(1);
      expect(s.posts[0].from).toBe('CEO');
      expect(s.posts[0].to).toBe('OP');
      expect(s.posts[0].body).toContain('살아 있나요');
    } finally { s.cleanup(); }
  });

  test('the same source messageId twice is a duplicate: one queue row, one post, no second timer', async () => {
    const s = setup();
    try {
      const first = await s.channel.receive(inbound());
      const again = await s.channel.receive(inbound());
      expect(first.status).toBe('accepted');
      expect(again.status).toBe('duplicate');
      expect(s.channel.counts().waiting).toBe(1);
      expect(s.posts.length).toBe(1);
      await s.clock.tick(CEO_ANSWER_SLA_MS + 1_000);
      expect(s.replies.length).toBe(1); // exactly one failover, not two
    } finally { s.cleanup(); }
  });

  test('queued and unconfirmed injected rows are redelivered after restart despite an advanced remote offset', async () => {
    const dir = freshDir();
    const injected: CeoInbound[] = [];
    const boom: CeoInbound[] = [];
    const clock = new FakeClock();
    const mk = (failFor: string[]) => createCeoChannel({
      stateDir: dir, allow: () => ['100'], now: clock.now, arm: clock.arm,
      post: () => 1,
      sendReply: async () => true,
      inject: async (m) => { (failFor.includes(m.messageId) ? boom : injected).push(m); if (failFor.includes(m.messageId)) throw new Error('bridge not up'); },
    });
    const a = mk(['m2']);
    try {
      await a.receive(inbound({ messageId: 'm1' }));
      await a.receive(inbound({ messageId: 'm2' }));
      a.stop();
      const b = mk([]);
      try {
        expect((await b.redeliver())).toBe(2); // m1 had no intake receipt; its old socket send was only attempted
        expect(injected.map((m) => m.messageId).sort()).toEqual(['m1', 'm1', 'm2']);
        expect(boom.length).toBe(1);
      } finally { b.stop(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('CEO receipt ③ — 👀 at pickup, 30s red, 5min RES failover', () => {
  test('30s without a pickup goes red; a pickup before 30s does not', async () => {
    const s = setup();
    try {
      await s.channel.receive(inbound({ messageId: 'a' }));
      await s.channel.receive(inbound({ messageId: 'b' }));
      await s.channel.markSeen({ source: 'telegram', chatId: '100', messageId: 'b' });
      await s.clock.tick(CEO_SEEN_SLA_MS + 1);
      expect(s.stale.map((m) => m.messageId)).toEqual(['a']);
      await s.channel.markSeen({ source: 'telegram', chatId: '100', messageId: 'a' });
      await s.clock.tick(2_000);
      expect(s.stale.length).toBe(1); // a late pickup stays one red, no second
    } finally { s.cleanup(); }
  });

  test('5 minutes without an answer fail over: same-thread alert + the same event to RES', async () => {
    const s = setup();
    try {
      await s.channel.receive(inbound());
      await s.channel.markSeen({ source: 'telegram', chatId: '100', messageId: 'm1' }); // 👀 in time: no red
      await s.clock.tick(CEO_ANSWER_SLA_MS + 1);
      expect(s.stale).toBeEmpty();
      expect(s.replies.length).toBe(1);
      expect(s.replies[0].text).toBe(CEO_FAILover_TEXT);
      expect(s.replies[0].inbound.messageId).toBe('m1'); // same thread
      const res = s.posts.filter((p) => p.to === 'RES');
      expect(res.length).toBe(1);
      expect(res[0].body).toContain('살아 있나요');
    } finally { s.cleanup(); }
  });

  test('an answer inside the SLA cancels the failover', async () => {
    const s = setup();
    try {
      await s.channel.receive(inbound());
      await s.channel.markSeen({ source: 'telegram', chatId: '100', messageId: 'm1' });
      await s.channel.markAnswered(accept(s.channel), '답', grant);
      await s.clock.tick(CEO_ANSWER_SLA_MS + 10_000);
      expect(s.replies.length).toBe(1);
      expect(s.replies[0].text).toBe('답');
    } finally { s.cleanup(); }
  });
});

describe('CEO reply ④ — the answer lands in the same thread, failures batch', () => {
  test('old unverified reply-pending row stays off the wire after restart', async () => {
    const dir = freshDir();
    const db = new Database(join(dir, 'ceo-channel.db'));
    db.exec(QUEUE_SCHEMA);
    db.query(`INSERT INTO ceo_inbox (source, message_id, chat_id, sender_id, text, at, state, reply_text)
      VALUES ('telegram', 'm1', '100', '7', 'question', 1000, 'reply-pending', 'forged old reply')`).run();
    db.close();
    const replies: string[] = [];
    const channel = createCeoChannel({ stateDir: dir, allow: () => ['100'],
      sendReply: async (_inbound, text) => { replies.push(text); return true; } });
    try {
      expect(await channel.retryOutbox()).toBe(0);
      expect(replies).toEqual([]);
      expect(await channel.markAnswered({ source: 'telegram', chatId: '100', messageId: 'm1' }, 'forged old reply', grant)).toBe(false);
      expect(replies).toEqual([]);
      expect(await channel.markAnswered(accept(channel), 'verified new reply', grant)).toBe(true);
      expect(replies).toEqual(['verified new reply']);
    } finally { channel.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('the reply goes to the same chat, threaded on the CEO message', async () => {
    const s = setup();
    try {
      await s.channel.receive(inbound({ chatId: '100', messageId: 'm9' }));
      const ok = await s.channel.markAnswered(accept(s.channel, 'm9'), '줄게', grant);
      expect(ok).toBeTrue();
      expect(s.replies.length).toBe(1);
      expect(s.replies[0].inbound.chatId).toBe('100');
      expect(s.replies[0].inbound.messageId).toBe('m9');
      expect(s.channel.counts().outbox).toBe(0);
    } finally { s.cleanup(); }
  });

  test('a failed send stays in the outbox and is retried, once per success', async () => {
    const s = setup();
    try {
      await s.channel.receive(inbound());
      s.failReply();
      const ok = await s.channel.markAnswered(accept(s.channel), '재시도 대상', grant);
      expect(ok).toBeFalse();
      expect(s.channel.counts().outbox).toBe(1);
      s.okReply(); // the next success is where the batch goes out
      expect(await s.channel.retryOutbox()).toBe(1);
      expect(s.channel.counts().outbox).toBe(0);
      expect(s.replies.map((r) => r.text)).toEqual(['재시도 대상', '재시도 대상']);
    } finally { s.cleanup(); }
  });
});

describe('CEO channel OP #119739 / JUD #119740 — the queue key binds chatId (telegram ids are per-chat)', () => {
  test('① the same messageId in TWO allowed chats both land; only an in-chat repeat is a duplicate', async () => {
    const s = setup({ allow: () => ['100', '200'] });
    try {
      const a = await s.channel.receive(inbound({ messageId: 'm1' }));
      const b = await s.channel.receive(inbound({ chatId: '200', senderId: '8', messageId: 'm1', text: '다른 채팅의 같은 번호' }));
      expect(a.status).toBe('accepted');
      expect(b.status).toBe('accepted'); // the retired (source, message_id) key called this a duplicate
      expect(s.channel.counts().waiting).toBe(2);
      expect(s.posts.length).toBe(2);
      expect(s.posts[1].body).toContain('다른 채팅의 같은 번호');
      const repeat = await s.channel.receive(inbound({ chatId: '200', senderId: '8', messageId: 'm1', text: '다른 채팅의 같은 번호' }));
      expect(repeat.status).toBe('duplicate'); // in-chat dedupe is unchanged
      expect(s.channel.counts().waiting).toBe(2);
    } finally { s.cleanup(); }
  });

  test('③ 👀 is per-chat: seeing one chat\'s m1 leaves the other chat\'s m1 to go red', async () => {
    const s = setup({ allow: () => ['100', '200'] });
    try {
      await s.channel.receive(inbound({ messageId: 'm1' }));
      await s.channel.receive(inbound({ chatId: '200', senderId: '8', messageId: 'm1', text: '다른 채팅' }));
      expect(s.channel.markSeen({ source: 'telegram', chatId: '100', messageId: 'm1' })).toBeTrue();
      await s.clock.tick(CEO_SEEN_SLA_MS + 1);
      expect(s.stale.map((m) => `${m.chatId}/${m.messageId}`)).toEqual(['200/m1']);
    } finally { s.cleanup(); }
  });

  test('① migration — an old (source, message_id)-keyed queue keeps its rows under the chat-bound key', async () => {
    const dir = freshDir();
    try {
      const old = new Database(join(dir, 'ceo-channel.db'));
      old.exec(`CREATE TABLE ceo_inbox (
        source TEXT NOT NULL, message_id TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        thread_id TEXT, text TEXT NOT NULL, at INTEGER NOT NULL,
        state TEXT NOT NULL, reply_text TEXT, seen_at INTEGER, answered_at INTEGER,
        PRIMARY KEY (source, message_id))`);
      old.query(`INSERT INTO ceo_inbox (source, message_id, chat_id, sender_id, thread_id, text, at, state)
        VALUES ('telegram', '900', '100', '7', NULL, '이전 큐 행', 1, 'queued')`).run();
      old.close();
      const s = setup({ stateDir: dir, allow: () => ['100', '200'] });
      try {
        expect(s.channel.counts().waiting).toBe(1); // the retired row survived the re-key
        expect(s.channel.markSeen({ source: 'telegram', chatId: '100', messageId: '900' })).toBeTrue(); // and stays operable under the full key
        const b = await s.channel.receive(inbound({ chatId: '200', senderId: '8', messageId: '900', text: '다른 채팅 같은 번호' }));
        expect(b.status).toBe('accepted'); // the retired key would have eaten this row
        expect(s.channel.counts().waiting).toBe(2);
      } finally { s.cleanup(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('migration — a mid-run copy failure rolls the whole re-key back: the old rows survive a restart retry (JUD #119836 / OP #119845)', () => {
    const dir = freshDir();
    const clock = new FakeClock();
    const mk = () => createCeoChannel({
      stateDir: dir, allow: () => ['100', '200'], now: clock.now, arm: clock.arm,
      post: () => 1, sendReply: async () => true, inject: async () => {},
    });
    try {
      // A pre-0.3.32 db with the retired key — and (the injection) without reply_text, so the
      // re-key COPY statement itself fails mid-migration: exactly the stranding the HOLD names.
      const old = new Database(join(dir, 'ceo-channel.db'));
      old.exec(`CREATE TABLE ceo_inbox (
        source TEXT NOT NULL, message_id TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        thread_id TEXT, text TEXT NOT NULL, at INTEGER NOT NULL,
        state TEXT NOT NULL, seen_at INTEGER, answered_at INTEGER,
        PRIMARY KEY (source, message_id))`);
      old.query(`INSERT INTO ceo_inbox (source, message_id, chat_id, sender_id, thread_id, text, at, state)
        VALUES ('telegram', '901', '100', '7', NULL, '첫 대기 행', 1, 'queued')`).run();
      old.query(`INSERT INTO ceo_inbox (source, message_id, chat_id, sender_id, thread_id, text, at, state)
        VALUES ('telegram', '902', '200', '8', NULL, '둘째 대기 행', 2, 'queued')`).run();
      old.close();
      // Boot 1 — the copy fails: the whole migration must roll back (RED today: the failure
      // strands the fresh empty ceo_inbox and the queue rows behind it).
      const a = mk();
      try { expect(a.counts().waiting).toBe(2); } finally { a.stop(); }
      // Boot 2 — the restart retry finds the same old rows, still readable.
      const b = mk();
      try { expect(b.counts().waiting).toBe(2); } finally { b.stop(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('migration — concurrent start: a re-key finished while we waited on the write lock is re-checked INSIDE and skipped, never run twice (FU-39405-CONCURRENT-START-SCHEMA · JUD #120215 FU · OP #120234 ③)', () => {
    const dir = freshDir();
    try {
      const file = join(dir, 'ceo-channel.db');
      const seed = new Database(file);
      seed.exec(`CREATE TABLE ceo_inbox (
        source TEXT NOT NULL, message_id TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        thread_id TEXT, text TEXT NOT NULL, at INTEGER NOT NULL,
        state TEXT NOT NULL, reply_text TEXT, seen_at INTEGER, answered_at INTEGER,
        PRIMARY KEY (source, message_id))`);
      seed.query(`INSERT INTO ceo_inbox (source, message_id, chat_id, sender_id, thread_id, text, at, state)
        VALUES ('telegram', '900', '100', '7', NULL, '우승자가 살린 대기 행', 1, 'queued')`).run();
      seed.close();

      // The loser boot: its schema read is stale (old key) and its BEGIN IMMEDIATE lands only
      // after a concurrent starter finished the SAME re-key — the proxy replays exactly that race
      // on a second connection at the lock boundary.
      const db = new Database(file);
      const winner = new Database(file);
      const execed: string[] = [];
      const logs: string[] = [];
      let raced = false;
      const proxied = new Proxy(db, {
        get(target: Database, prop: string | symbol) {
          if (prop === 'exec') return (sql: string) => {
            if (sql.startsWith('BEGIN IMMEDIATE') && !raced) {
              raced = true;
              winner.exec('BEGIN IMMEDIATE');
              winner.exec('ALTER TABLE ceo_inbox RENAME TO ceo_inbox_retired_key');
              winner.exec(QUEUE_SCHEMA);
              winner.exec('INSERT OR IGNORE INTO ceo_inbox (source, message_id, chat_id, sender_id, thread_id, text, at, state, reply_text, seen_at, answered_at) SELECT source, message_id, chat_id, sender_id, thread_id, text, at, state, reply_text, seen_at, answered_at FROM ceo_inbox_retired_key');
              winner.exec('DROP TABLE ceo_inbox_retired_key');
              winner.exec('COMMIT');
              winner.close();
            }
            execed.push(sql);
            return target.exec(sql);
          };
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });

      ensureChatBoundKey(proxied, (event) => { logs.push(event); });

      // the loser must not re-run the re-key the winner already finished inside our own lock
      expect(execed.filter((sql) => sql.includes('RENAME TO ceo_inbox_retired_key') || sql.includes('DROP TABLE ceo_inbox_retired_key'))).toBeEmpty();
      expect(logs).toContain('migrate-skip-lock-race');
      // and the winner's row survives under the chat-bound key
      const row = db.query(`SELECT state FROM ceo_inbox WHERE source = 'telegram' AND chat_id = '100' AND message_id = '900'`).get() as { state: string } | undefined;
      expect(row?.state).toBe('queued');
      const schema = (db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ceo_inbox'`).get() as { sql: string }).sql;
      expect(schema).toContain('PRIMARY KEY (source, chat_id, message_id)');
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
