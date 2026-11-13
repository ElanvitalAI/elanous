import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBot } from './telegram.js';
import { setUserConfigOverlay } from './user-config.js';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
let stateDir: string | undefined;
afterEach(() => {
  setUserConfigOverlay(null);
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

test('unconnected saved link through fake Bot API sends one connection instruction without a false receipt', async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'telegram-intake-ack-'));
  process.env.ELANOUS_STATE_DIR = stateDir;
  setUserConfigOverlay((cfg) => ({
    ...cfg,
    skills: { ...cfg.skills, urlRouting: { ...cfg.skills.urlRouting, enabled: true, twoStage: true, absorbKeywords: ['저장'] } },
  }));
  const sent: { chat_id: number; text: string }[] = [];
  let turns = 0;
  let polls = 0;
  let bot!: TelegramBot;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = new URL(String(url)).pathname.split('/').at(-1);
    if (method === 'getUpdates') {
      if (polls++ === 0) return Response.json({ ok: true, result: [{
        update_id: 1,
        message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'https://example.org/post 요약해 저장' },
      }] });
      bot.stop();
      return Response.json({ ok: true, result: [] });
    }
    if (method === 'sendMessage') {
      const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
      sent.push({ chat_id: body.chat_id, text: body.text });
    }
    return Response.json({ ok: true, result: { message_id: 2 } });
  }) as typeof fetch;
  bot = new TelegramBot({
    token: '123:fake', allowedUsers: [42], fetchImpl, perChatGapMs: 0, pollTimeoutSec: 0,
    readContextNow: () => ({ at: '2026-11-12T00:00:00.000Z', topic: null, facts: [], events: [], guide: [] }),
    onMessage: async () => { turns++; return 'unexpected'; },
  });
  await bot.start();
  expect(turns).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.chat_id).toBe(42);
  expect(sent[0]?.text).toContain('회원 계정 연결이 필요합니다');
  expect(sent[0]?.text).not.toContain('접수 ID:');
});
