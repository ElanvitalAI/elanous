// S1 (2026-07-12) — discord channel↔session binding primitives
// (텔레그램 binding 동형). ELANOUS_SESSION_ROOT tmp 격리 필수 (실데이터
// 오염 금지 규율).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachDiscordBinding,
  createSession,
  detachDiscordBinding,
  findSessionByDiscordChannel,
  listBoundSessions,
} from '../src/session/index.js';
import { buildDiscordSelfOnMessage } from '../src/discord-self-message.js';
import type { DcIncoming } from '../src/discord.js';
import type { RunTurnResult } from '../src/session/chat.js';
import type { UserConfig } from '../src/user-config/types.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-binding-'));
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.ELANOUS_SESSION_ROOT;
});

describe('discord binding primitives', () => {
  test('attaches a declared Discord text session and preserves dc origin', () => {
    const s = createSession({ source: 'discord', origin: 'dc', title: 't' });
    const meta = attachDiscordBinding(s.id, 'CH-9', 'G-1');
    const found = findSessionByDiscordChannel('CH-9');
    expect(meta.bindings?.discord).toEqual({ channelId: 'CH-9', guildId: 'G-1' });
    expect(found?.id).toBe(s.id);
    expect(found?.source).toBe('discord');
    expect(found?.sourceSource).toBe('declared');
    expect(found?.origin).toBe('dc');
    expect(findSessionByDiscordChannel('CH-unknown')).toBeNull();
  });

  test('text handler records declared Discord provenance while preserving binding and origin', async () => {
    let sessionId = '';
    const handler = buildDiscordSelfOnMessage({
      userConfig: { llm: { provider: 'test', model: 'test-model' } } as unknown as UserConfig,
      runTurnImpl: (async (opts: { sessionId: string }) => {
        sessionId = opts.sessionId;
        return { text: 'ok' } as RunTurnResult;
      }) as never,
      getBot: () => null,
    });
    const ctx: DcIncoming = {
      channelId: 'CH-text', userId: 'u1', userName: 'alice', text: 'hello',
      messageId: 'm1', isDm: true, attachments: [], raw: { guild_id: 'G-1' },
    };

    await handler(ctx);
    const meta = findSessionByDiscordChannel(ctx.channelId);
    expect(meta).not.toBeNull();
    const persisted = meta!;
    expect(persisted.id).toBe(sessionId);
    expect(persisted.source).toBe('discord');
    expect(persisted.sourceSource).toBe('declared');
    expect(persisted.origin).toBe('dc');
    expect(persisted.title).toBe('dc:alice');

    await handler({ ...ctx, text: 'again', messageId: 'm2' });
    expect(sessionId).toBe(persisted.id);
  });

  test('one channel binds at most one session — conflict throws with occupant id', () => {
    const a = createSession({ origin: 'dc' });
    const b = createSession({ origin: 'dc' });
    attachDiscordBinding(a.id, 'CH-1');
    expect(() => attachDiscordBinding(b.id, 'CH-1')).toThrow(a.id.slice(0, 8));
    // Same-pair re-attach is idempotent.
    expect(attachDiscordBinding(a.id, 'CH-1').bindings?.discord?.channelId).toBe('CH-1');
  });

  test('attach MOVES a session\'s existing discord binding (handoff semantics)', () => {
    const s = createSession({ origin: 'dc' });
    attachDiscordBinding(s.id, 'CH-old');
    attachDiscordBinding(s.id, 'CH-new'); // same session, new channel
    expect(findSessionByDiscordChannel('CH-old')).toBeNull();
    expect(findSessionByDiscordChannel('CH-new')?.id).toBe(s.id);
  });

  test('detach clears only the discord binding; other bindings survive', () => {
    const s = createSession({ origin: 'dc' });
    attachDiscordBinding(s.id, 'CH-2');
    const cleared = detachDiscordBinding(s.id);
    expect(cleared?.bindings?.discord).toBeUndefined();
    expect(findSessionByDiscordChannel('CH-2')).toBeNull();
    // Second detach is a null no-op.
    expect(detachDiscordBinding(s.id)).toBeNull();
  });

  test('listBoundSessions filters by discord channel kind', () => {
    const s = createSession({ origin: 'dc' });
    attachDiscordBinding(s.id, 'CH-3');
    createSession({ origin: 'dc' }); // unbound
    const bound = listBoundSessions({ channel: 'discord' });
    expect(bound.map((m) => m.id)).toEqual([s.id]);
  });
});

describe('forkSessionById (S2)', () => {
  test('copies history, records lineage, preserves origin', async () => {
    const { appendMessage, forkSessionById, loadSession } = await import('../src/session/index.js');
    const src = createSession({ origin: 'dc', title: '원본 대화' });
    appendMessage(src.id, { role: 'user', content: '질문 하나', ts: new Date().toISOString() });
    appendMessage(src.id, { role: 'assistant', content: '답변 하나', ts: new Date().toISOString() });
    appendMessage(src.id, { role: 'tool', content: 'tool-trace', ts: new Date().toISOString(), toolName: 'x' });
    const fork = forkSessionById(src.id);
    expect(fork).not.toBeNull();
    expect(fork!.meta.forkedFromId).toBe(src.id);
    expect(fork!.meta.origin).toBe('dc');
    expect(fork!.meta.title.startsWith('⑂')).toBe(true);
    // tool rows dropped, user/assistant copied
    expect(fork!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // fork is independent — appending doesn't touch the source
    appendMessage(fork!.meta.id, { role: 'user', content: '분기 질문', ts: new Date().toISOString() });
    expect(loadSession(src.id)!.messages).toHaveLength(3);
    expect(forkSessionById('nonexistent-id')).toBeNull();
  });
});

describe('forkSessionById time-travel (S3)', () => {
  async function seed(): Promise<string> {
    const { appendMessage } = await import('../src/session/index.js');
    const src = createSession({ origin: 'dc', title: '타임트래블 원본' });
    const ts = new Date().toISOString();
    appendMessage(src.id, { role: 'user', content: 'Q1', ts });
    appendMessage(src.id, { role: 'assistant', content: 'A1', ts });
    appendMessage(src.id, { role: 'user', content: 'Q2', ts });
    appendMessage(src.id, { role: 'assistant', content: 'A2', ts });
    appendMessage(src.id, { role: 'user', content: 'Q3', ts });
    appendMessage(src.id, { role: 'assistant', content: 'A3', ts });
    return src.id;
  }

  test('beforeUser=2 keeps only history strictly before the 2nd user turn', async () => {
    const { forkSessionById } = await import('../src/session/index.js');
    const srcId = await seed();
    const fork = forkSessionById(srcId, { beforeUser: 2 });
    expect(fork!.messages.map((m) => m.content)).toEqual(['Q1', 'A1']);
    expect(fork!.meta.forkedFromId).toBe(srcId);
    expect(fork!.meta.title.startsWith('⑂@u2')).toBe(true);
  });

  test('beforeUser=1 → empty history; beforeUser beyond range → full copy (clamp)', async () => {
    const { forkSessionById } = await import('../src/session/index.js');
    const srcId = await seed();
    expect(forkSessionById(srcId, { beforeUser: 1 })!.messages).toHaveLength(0);
    expect(forkSessionById(srcId, { beforeUser: 99 })!.messages).toHaveLength(6);
  });
});

describe('cross-surface attach (S4)', () => {
  test('PWA-origin daemon session can be bound to a discord channel and a telegram chat', async () => {
    const { adoptSession, appendMessage, attachTelegramBinding, findSessionByTelegramChat } = await import('../src/session/index.js');
    // R3 미러가 만드는 모양 그대로: 데몬 민팅 id + origin pwa.
    const meta = adoptSession('elanous-session-77', { origin: 'pwa', title: 'PWA 대화' });
    appendMessage(meta.id, { role: 'user', content: 'PWA에서 시작한 질문', ts: new Date().toISOString() });
    // discord 채널로 attach
    attachDiscordBinding(meta.id, 'CH-X');
    expect(findSessionByDiscordChannel('CH-X')?.id).toBe('elanous-session-77');
    // 같은 세션을 telegram chat에도 attach (동시 바인딩 = 핸드오프 케이스)
    attachTelegramBinding(meta.id, 123456);
    expect(findSessionByTelegramChat(123456)?.id).toBe('elanous-session-77');
  });

  test('discord-origin session resolves for telegram attach by prefix (shared index)', async () => {
    const { attachTelegramBinding, findSessionByTelegramChat, resolveSessionId } = await import('../src/session/index.js');
    const s = createSession({ origin: 'dc', title: '디스코드 대화' });
    attachDiscordBinding(s.id, 'CH-Y');
    const resolved = resolveSessionId(s.id.slice(0, 8));
    expect(resolved).toBe(s.id);
    attachTelegramBinding(resolved!, 654321);
    expect(findSessionByTelegramChat(654321)?.id).toBe(s.id);
    // discord binding 유지 — 두 서피스가 같은 세션을 공유(핸드오프 상태)
    expect(findSessionByDiscordChannel('CH-Y')?.id).toBe(s.id);
  });
});
