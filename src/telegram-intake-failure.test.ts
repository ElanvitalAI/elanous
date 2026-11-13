import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBot } from './telegram.js';
import { setUserConfigOverlay } from './user-config.js';
import { resetToxRuntimeDepsForTest } from './task-orchestrator/runtime-deps.js';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
let stateDir: string | undefined;
afterEach(() => {
  setUserConfigOverlay(null);
  resetToxRuntimeDepsForTest();
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

test('saved Telegram link reports a failed task post instead of falling through to an ordinary answer', async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'telegram-intake-failure-'));
  process.env.ELANOUS_STATE_DIR = stateDir;
  setUserConfigOverlay((cfg) => ({
    ...cfg,
    skills: { ...cfg.skills, urlRouting: { ...cfg.skills.urlRouting, enabled: true, twoStage: true, absorbKeywords: ['저장'] } },
  }));
  const sent: string[] = [];
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
    if (method === 'sendMessage') sent.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true, result: { message_id: 2 } });
  }) as typeof fetch;
  bot = new TelegramBot({
    token: '123:fake', allowedUsers: [42], fetchImpl, perChatGapMs: 0, pollTimeoutSec: 0,
    readContextNow: () => ({ at: '2026-11-12T00:00:00.000Z', topic: null, facts: [], events: [], guide: [] }),
    onMessage: async () => { turns++; return 'misleading summary'; },
  });
  await bot.start();
  expect(turns).toBe(0);
  expect(sent).toEqual(['링크는 받았지만 저장 작업을 시작하지 못했습니다. 잠시 후 다시 보내 주세요.']);
});
