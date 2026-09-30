import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMissionOrigin, loadMissionOrigin, saveMissionOrigin, type MissionOrigin } from './mission-origin.js';

const originalStateDir = process.env.ELANOUS_STATE_DIR;
const roots: string[] = [];

function isolatedState(): void {
  const root = mkdtempSync(join(tmpdir(), 'mission-origin-discord-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
}

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('Discord origin retains channel and optional thread across save/load and ensure', () => {
  isolatedState();
  const thread: MissionOrigin = { channel: 'discord', channelId: '123456789012345678', discordThreadId: '987654321098765432' };
  const channel: MissionOrigin = { channel: 'discord', channelId: '123456789012345678' };
  saveMissionOrigin('discord-thread', thread);
  saveMissionOrigin('discord-channel', channel);
  expect(loadMissionOrigin('discord-thread')).toEqual(thread);
  expect(ensureMissionOrigin('discord-thread')).toEqual(thread);
  expect(loadMissionOrigin('discord-channel')).toEqual(channel);
});

test('Telegram origin continues to retain numeric chat and thread IDs', () => {
  isolatedState();
  const telegram: MissionOrigin = { channel: 'telegram', chatId: 42, botId: '7', threadId: 12 };
  saveMissionOrigin('telegram-thread', telegram);
  expect(loadMissionOrigin('telegram-thread')).toEqual(telegram);
  expect(ensureMissionOrigin('telegram-thread')).toEqual(telegram);
});
