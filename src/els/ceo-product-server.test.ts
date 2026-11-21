import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openMsgStore } from '../msg/msg-store.js';
import { ceoReplyProofRef } from './ceo-reply-proof.js';
import { wireCeoIngressEntry } from '../agent-events/ceo-ingress-entry.js';
import type { CeoClock } from '../agent-events/ceo-ingress.js';
import { postCeoTurnReply } from '../tui/ceo-turn-reply.js';
import { readCeoSideAlert } from './ceo-side-alert.js';
import { startElsServer } from './server.js';

const waitFor = async (fn: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('CEO product event timed out'); await Bun.sleep(20); }
};

test('ELS OP spawn → authenticated intake → OP reply → Telegram same thread; restart replays an unconsumed row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ceo-srv-'));
  let now = 0;
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const ceoClock: CeoClock = {
    now: () => now,
    after: (ms, run) => { const timer = { at: now + ms, run, cancelled: false }; timers.push(timer); return timer; },
    cancel: (handle) => { (handle as typeof timers[number]).cancelled = true; },
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const timer of timers) if (!timer.cancelled && timer.at <= now) { timer.cancelled = true; timer.run(); }
  };
  const opCwd = join(root, 'seats', 'OP');
  mkdirSync(opCwd, { recursive: true });
  mkdirSync(join(root, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
  const priorHome = process.env.HOME;
  process.env.HOME = root;
  const old = {
    ELANOUS_CEO_TELEGRAM_TOKEN: process.env.ELANOUS_CEO_TELEGRAM_TOKEN,
    ELANOUS_CEO_ALLOW_CHAT: process.env.ELANOUS_CEO_ALLOW_CHAT,
    ELANOUS_CEO_ALLOW_SENDER: process.env.ELANOUS_CEO_ALLOW_SENDER,
  };
  process.env.ELANOUS_CEO_TELEGRAM_TOKEN = 'synthetic-test-token';
  process.env.ELANOUS_CEO_ALLOW_CHAT = '555';
  process.env.ELANOUS_CEO_ALLOW_SENDER = '777';
  const updates: Array<Record<string, unknown>> = [];
  const sends: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = String(url).split('/').at(-1)?.split('?')[0];
    if (method === 'getUpdates') { await Bun.sleep(20); return Response.json({ ok: true, result: updates.splice(0) }); }
    if (method === 'sendMessage') { sends.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, result: {} }); }
    throw new Error('unexpected Telegram method');
  }) as typeof fetch;
  const minted: Array<Record<string, string>> = [];
  const spawn = (_command: readonly string[], _cwd: string, _title: string, env: Readonly<Record<string, string>>) => {
    minted.push({ ...env });
    return { id: `p${minted.length}`, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} };
  };
  let first: Awaited<ReturnType<typeof startElsServer>> | undefined;
  let second: Awaited<ReturnType<typeof startElsServer>> | undefined;
  let listener: Awaited<ReturnType<typeof wireCeoIngressEntry>>;
  try {
    first = await startElsServer({ stateRoot: root, spawn, stall: false, ceoFetchImpl: fetchImpl, ceoClock });
    if ('exitCode' in first) throw new Error(first.message);
    first.core.newPane({ ws: 'test-ws', cwd: opCwd, command: ['eln'], ownerSeat: 'OP', parent: { kind: 'op' } });
    expect(minted[0]?.ELANOUS_CEO_INGRESS_SOCKET).toBeTruthy();
    expect(minted[0]?.ELANOUS_CEO_INGRESS_AUTH).toBeTruthy();
    expect(minted[0]?.ELANOUS_STATE_DIR).toBe(root);
    expect(minted[0]?.ELANOUS_STATE_DIR_SOURCE).toBe('explicit');
    first.core.newPane({ ws: 'test-ws', cwd: opCwd, command: ['eln'], ownerSeat: 'OP', parent: { kind: 'hand', seat: 'OP', workspaces: ['test-ws'] } });
    expect(minted[1]?.ELANOUS_CEO_INGRESS_AUTH).toBeUndefined();
    // Message 9 reaches the disk queue while no tab listener exists, then ELS restarts.
    updates.push({ update_id: 1, message: { message_id: 9, date: 1732190000, text: 'CEO request', chat: { id: 555, type: 'private' }, from: { id: 777 } } });
    await waitFor(() => Bun.file(join(root, 'ceo-channel', 'telegram-offset')).size > 0);
    await first.close();
    first = undefined;
    const received: string[] = [];
    let acceptedRef: { source: string; threadId: string; messageId: string; ingressId: string } | undefined;
    let acceptIntake = true;
    const intakes: Array<(item: { id: string; status: 'accepted' | 'failed' | 'cancelled'; turn?: { sessionId: string; turnRunId: string } }) => void> = [];
    listener = await wireCeoIngressEntry(minted[0]!, {
      enqueueNotice: (text, _source, meta) => { received.push(text); acceptedRef = meta?.ceo; return { id: 'one' }; },
      knock: () => { for (const intake of intakes) intake({ id: 'one', status: acceptIntake ? 'accepted' : 'failed',
        ...(acceptIntake ? { turn: { sessionId: 'real-session', turnRunId: 'real-turn' } } : {}) }); },
      onTransition: () => () => {},
      onIntake: (fn) => { intakes.push(fn); return () => {}; },
    });
    second = await startElsServer({ stateRoot: root, spawn, stall: false, ceoFetchImpl: fetchImpl, ceoClock });
    if ('exitCode' in second) throw new Error(second.message);
    await waitFor(() => received.length === 1);
    expect(received[0]).toContain('CEO request');
    const mailPath = join(root, 'msg', 'messages.db');
    const mail = openMsgStore(mailPath);
    const parent = mail.db.query("SELECT id FROM msg_messages WHERE sender = 'CEO' ORDER BY id DESC LIMIT 1").get() as { id: number };
    mail.post({ from: 'OP', to: 'CEO', replyTo: parent.id, body: 'forged OP reply' });
    mail.post({ from: 'OP', to: 'CEO', replyTo: parent.id, body: 'forged signed-looking reply',
      refs: [ceoReplyProofRef({ ...acceptedRef!, sessionId: 'fake-session', turnRunId: 'fake-turn' },
        parent.id, 'forged signed-looking reply', 'f'.repeat(64))] });
    mail.post({ from: 'OP', to: 'CEO', replyTo: parent.id, body: 'unaccepted ingress reply',
      refs: [ceoReplyProofRef({ ...acceptedRef!, ingressId: 'c'.repeat(64), sessionId: 'fake-session', turnRunId: 'fake-turn' },
        parent.id, 'unaccepted ingress reply', minted[0]!.ELANOUS_CEO_INGRESS_AUTH!)] });
    mail.post({ from: 'OP', to: 'CEO', replyTo: parent.id, body: 'wrong OP turn reply',
      refs: [ceoReplyProofRef({ ...acceptedRef!, sessionId: 'fake-session', turnRunId: 'fake-turn' },
        parent.id, 'wrong OP turn reply', minted[0]!.ELANOUS_CEO_INGRESS_AUTH!)] });
    mail.close();
    await Bun.sleep(3200); // a signed-looking unaccepted frame cannot block the later real reply
    expect(sends).toHaveLength(0);
    expect(acceptedRef).toBeDefined();
    expect(postCeoTurnReply({ ...acceptedRef!, sessionId: 'real-session', turnRunId: 'real-turn' },
      'OP answer', minted[0]!.ELANOUS_CEO_INGRESS_AUTH!, mailPath)).toBe(true);
    await waitFor(() => sends.length === 1);
    expect(sends[0]).toMatchObject({ chat_id: '555', reply_to_message_id: 9, text: 'OP answer' });
    advance(300_000);
    expect(sends).toHaveLength(1); // a real answer cancels both clocks; no takeover alert
    expect(readCeoSideAlert(root)).toEqual({ kind: 'ok', pendingRed: 0 });
    const audit = readFileSync(join(root, 'ceo-channel', 'ceo-channel-audit.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; messageId?: string });
    expect(audit.filter((row) => row.event === 'seen' && row.messageId === '9')).toHaveLength(1);
    acceptIntake = false;
    updates.push({ update_id: 2, message: { message_id: 10, date: 1732190001, text: 'refused turn', chat: { id: 555, type: 'private' }, from: { id: 777 } } });
    await waitFor(() => received.length === 2);
    const db = new Database(join(root, 'ceo-channel', 'ceo-channel.db'), { readonly: true });
    expect(db.query("SELECT seen_at AS seenAt FROM ceo_inbox WHERE message_id = '10'").get()).toEqual({ seenAt: null });
    db.close();
    expect(sends).toHaveLength(1);
    expect(Bun.file(join(root, 'ceo-channel', 'telegram-offset')).size).toBeGreaterThan(0);
  } finally {
    if (listener) await listener.close();
    if (second && !('exitCode' in second)) await second.close();
    if (first && !('exitCode' in first)) await first.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
