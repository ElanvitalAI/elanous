// CEO channel — the telegram adapter and the mail watcher, boundary-tested at their seams.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCeoTelegramAdapter, runCeoTelegramLoop } from './ceo-channel-telegram.js';
import { chatIdFromRefs, messageIdFromRefs, openCeoMailDb, scanCeoMail, ceoMessageRef, type CeoMailDb } from './ceo-channel-mail-watch.js';
import { createCeoChannel, type CeoChannel, type CeoInbound } from './ceo-channel.js';

const freshDir = (): string => {
  const dir = join(tmpdir(), `ceo-tg-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('telegram adapter ① — getUpdates → channel.receive', () => {
  test('every new private message goes to the door once; the cursor advances past handled updates', async () => {
    const dir = freshDir();
    const received: CeoInbound[] = [];
    const statuses: string[] = [];
    const channel = {
      receive: async (inbound: CeoInbound) => { received.push(inbound); const status = inbound.messageId === '11' ? 'accepted' : 'rejected'; statuses.push(status); return { status }; },
    } as unknown as CeoChannel;
    // The Bot API answers at the top level ({ ok, result }) — no envelope wrapper (④'s fixture already agrees).
    const state = { ok: true, result: [
      { update_id: 10, message: { message_id: 11, date: 1732190000, text: '살아 있나요', chat: { id: 100, type: 'private' }, from: { id: 7 } } },
      { update_id: 11, message: { message_id: 12, text: '외부 채널', chat: { id: 200, type: 'group' }, from: { id: 8 } } },
    ] };
    const fetches: string[] = [];
    const adapter = createCeoTelegramAdapter({
      stateDir: dir, token: 'T0KEN', channel,
      fetchImpl: (async (url: unknown) => { fetches.push(String(url)); return { json: async () => state } as unknown as Response; }) as typeof fetch,
    });
    try {
      expect(await adapter.pollOnce()).toBe(1);
      expect(received.length).toBe(1);
      expect(received[0].chatId).toBe('100');
      expect(received[0].senderId).toBe('7');
      expect(received[0].messageId).toBe('11');
      expect(adapter.offset()).toBe(12); // both updates consumed (a group chat is not door material)
      expect(fetches[0]).toContain('offset=0');
      expect(fetches[0]).toContain('timeout=25');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('row ④ — sendReply posts into the same chat threaded on the CEO message; a failed call returns false', async () => {
    const dir = freshDir();
    const posted: any[] = [];
    let ok = true;
    const adapter = createCeoTelegramAdapter({
      stateDir: dir, token: 'T0KEN', channel: {} as CeoChannel,
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return { json: async () => ({ ok }) } as unknown as Response;
      }) as typeof fetch,
    });
    const inbound: CeoInbound = { source: 'telegram', chatId: '100', senderId: '7', messageId: '55', text: 'x', at: 0 };
    try {
      expect(await adapter.sendReply(inbound, '답')).toBeTrue();
      expect(posted[0].url).toContain('sendMessage');
      expect(posted[0].body.chat_id).toBe('100');
      expect(posted[0].body.reply_to_message_id).toBe(55); // the same thread
      ok = false;
      expect(await adapter.sendReply(inbound, '또')).toBeFalse();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('mail watcher ④ — authenticated reply → ✅', () => {
  const mail = (over: Partial<Parameters<typeof scanCeoMail>[0]['mail']> = {}): CeoMailDb => ({
    ceoRows: (after) => [
      { id: 501, refsJson: JSON.stringify([ceoMessageRef('m1'), 'telegram-chat:100']), createdAt: '2026-11-21T05:00:00.000Z' },
      { id: 502, refsJson: JSON.stringify([ceoMessageRef('m2'), 'telegram-chat:100']), createdAt: '2026-11-21T05:01:00.000Z' },
      { id: 503, refsJson: null, createdAt: '2026-11-21T05:02:00.000Z' }, // a foreign CEO row: no telegram ref
      { id: 504, refsJson: JSON.stringify([ceoMessageRef('m4')]), createdAt: '2026-11-21T05:03:00.000Z' }, // message ref without a chat ref: not correlatable
    ].filter((row) => row.id > after),
    firstReplyAfter: (messageId, _seat, afterId) => messageId === 502 && afterId < 601
      ? { id: 601, sender: 'OP', body: '여기 있습니다', refsJson: null } : null,
    ...over,
  });

  test('mail sender/ack cannot create 👀; a verified OP reply can create ✅ and remains chat-bound', async () => {
    const seen: Array<{ source: string; chatId: string; messageId: string }> = [];
    const answers: Array<{ source: string; chatId: string; messageId: string; body: string }> = [];
    const channel = {
      markSeen: (key: { source: string; chatId: string; messageId: string }) => { seen.push({ ...key }); return true; },
      markAnswered: async (key: { source: string; chatId: string; messageId: string }, body: string) => { answers.push({ ...key, body }); return true; },
    } as unknown as CeoChannel;
    const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
    const out = await scanCeoMail({ channel, mail: mail(), cursor: 500,
      verifyReply: () => ({ source: 'telegram', threadId: '100', messageId: 'm2', ingressId: 'a'.repeat(64),
        sessionId: 'op', turnRunId: 'turn' }),
      log: (event, data) => { logged.push({ event, data }); } });
    expect(out.cursor).toBe(504); // every row walked, foreign and uncorrelatable rows included
    expect(out.acted).toBe(1);
    expect(seen).toEqual([]); // a mail ack cannot authorize the intake receipt
    expect(answers).toEqual([{ source: 'telegram', chatId: '100', messageId: 'm2', body: '여기 있습니다' }]);
    expect(logged.filter((l) => l.event === 'no-chat-ref').map((l) => l.data.mailId)).toEqual([504]); // 504 lacks the chat ref: one line, nothing acted
  });

  test('a mail row nobody acked or answered leaves both signals alone (the SLA timers stay armed)', async () => {
    const seen: string[] = [];
    const answers: unknown[] = [];
    const channel = {
      markSeen: (key: { messageId: string }) => { seen.push(key.messageId); return true; },
      markAnswered: async (key: { messageId: string }, body: string) => { answers.push({ key, body }); return true; },
    } as unknown as CeoChannel;
    const out = await scanCeoMail({ channel, mail: mail({ firstReplyAfter: () => null }), cursor: 501 });
    expect(out.cursor).toBe(504);
    expect(seen).toEqual([]); // 501 is past the cursor; 502 was neither acked nor answered
    expect(answers).toEqual([]);
  });

  test('refs parsing only trusts its own ref (message id, chat id); a missing ledger projects to null', () => {
    expect(messageIdFromRefs(JSON.stringify([ceoMessageRef('m9')]))).toBe('m9');
    expect(messageIdFromRefs(JSON.stringify(['telegram-chat:100']))).toBeNull();
    expect(messageIdFromRefs('not json')).toBeNull();
    expect(messageIdFromRefs(null)).toBeNull();
    expect(chatIdFromRefs(JSON.stringify([ceoMessageRef('m9'), 'telegram-chat:100']))).toBe('100');
    expect(chatIdFromRefs(JSON.stringify([ceoMessageRef('m9')]))).toBeNull();
    expect(chatIdFromRefs('not json')).toBeNull();
    expect(chatIdFromRefs(null)).toBeNull();
    expect(openCeoMailDb(join(tmpdir(), `no-such-${Math.random().toString(36).slice(2)}.db`))).toBeNull();
  });
});

describe('telegram adapter OP #119477 mustFix — store-first cursor ① · token redaction ②', () => {
  const TOKEN = '910000000:AAtest-never-real';

  test('① the cursor advances only after the disk queue holds the row — a store failure is 전진 0 · 재수신 · 중복 0', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'telegram-offset'), '50'); // a previous pass persisted this cursor
    const real = createCeoChannel({
      stateDir: dir, allow: () => ['100'], senderAllow: () => ['7'],
      post: () => undefined, inject: () => undefined, sendReply: async () => true,
      arm: () => ({ cancel: () => {} }), log: () => {},
    });
    let storeFails = true;
    const door = {
      ...real,
      receive: async (inbound: CeoInbound) => {
        if (storeFails) { storeFails = false; throw new Error('store failed: sqlite disk I/O'); }
        return real.receive(inbound);
      },
    } as CeoChannel;
    const same = { ok: true, result: [{ update_id: 51, message: { message_id: 61, date: 1732190000, text: '저장에 실패해도 지워지지 않는다', chat: { id: 100, type: 'private' }, from: { id: 7 } } }] };
    const fetches: string[] = [];
    const adapter = createCeoTelegramAdapter({
      stateDir: dir, token: TOKEN, channel: door,
      fetchImpl: (async (url: unknown) => { fetches.push(String(url)); return { json: async () => same } as unknown as Response; }) as typeof fetch,
    });
    try {
      expect(await adapter.pollOnce()).toBe(0);         // the door threw — nothing handled this pass
      expect(adapter.offset()).toBe(50);               // ① 전진 0 — the cursor did not move past the row it lost
      expect(real.counts().waiting).toBe(0);            // and the queue does not hold the row
      expect(await adapter.pollOnce()).toBe(1);        // ① 재수신 — the same update comes back
      expect(fetches[1]).toContain('offset=50');        // fetched again from the unmoved cursor
      expect(adapter.offset()).toBe(52);               // now, with the row stored, the cursor advances
      expect(real.counts().waiting).toBe(1);           // ① 중복 0 — exactly one row for the message
      expect(readFileSync(join(dir, 'telegram-offset'), 'utf8')).toBe('52');
      expect(await adapter.pollOnce()).toBe(0);         // a third copy of the same update: duplicate, not handled
      expect(real.counts().waiting).toBe(1);           // the (source, message_id) key keeps it one row
    } finally { real.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('② an exception or a response-error log quoting the bot URL is masked — api.telegram.org/bot<…>, never the token', async () => {
    const dir = freshDir();
    const channel = createCeoChannel({
      stateDir: dir, allow: () => ['100'],
      post: () => undefined, inject: () => undefined, sendReply: async () => true,
      arm: () => ({ cancel: () => {} }), log: () => {},
    });
    const logged: Array<Record<string, unknown>> = [];
    const log = (_event: string, data: Record<string, unknown>): void => { logged.push(data); };
    const errText = `fetch failed: request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`;
    const throwing = (async () => { throw new Error(errText); }) as unknown as typeof fetch;
    const refused = { ok: false, description: `Bad Request: request to https://api.telegram.org/bot${TOKEN}/sendMessage failed` };
    const responder = (async () => ({ json: async () => refused }) as unknown as Response) as unknown as typeof fetch;
    const loopAdapter = createCeoTelegramAdapter({ stateDir: dir, token: TOKEN, channel, fetchImpl: throwing });
    const refusalAdapter = createCeoTelegramAdapter({ stateDir: dir, token: TOKEN, channel, fetchImpl: responder });
    try {
      let checks = 0;
      await runCeoTelegramLoop(loopAdapter, { stateDir: dir, sleep: async () => {}, stopped: () => (checks += 1) > 1, log });
      expect(JSON.stringify(logged)).not.toContain(TOKEN);                  // ② 예외 로그 — the raw token never lands
      expect(JSON.stringify(logged)).toContain('api.telegram.org/bot<…>');
      expect(await refusalAdapter.pollOnce()).toBe(0);                     // ② 응답 오류 — getUpdates refused
      const inbound: CeoInbound = { source: 'telegram', chatId: '100', senderId: '7', messageId: '61', text: 'x', at: 0 };
      expect(await refusalAdapter.sendReply(inbound, '답')).toBeFalse();   // ② 응답 오류 — send refused
      const audit = readFileSync(join(dir, 'ceo-telegram-audit.jsonl'), 'utf8');
      expect(audit).not.toContain(TOKEN);
      expect(audit).toContain('api.telegram.org/bot<…>');
    } finally { channel.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});
