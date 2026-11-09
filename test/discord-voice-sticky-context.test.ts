import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onSessionCreated } from '../src/session/index.js';
import { buildDiscordVoiceWire } from '../src/discord-voice-wire.js';
import type { DcIncoming } from '../src/discord.js';
import type { runTurn } from '../src/session/chat.js';
import type { UserConfig } from '../src/user-config/types.js';
import { createStubDiscordVoiceChannelAdapter } from '../src/voice/channel-adapters/discord-voice-channel-adapter.js';
import { createDiscordVoiceStickyContextRuntime } from '../src/voice/channel-adapters/discord-voice-sticky-context.js';

describe('createDiscordVoiceStickyContextRuntime', () => {
  it('describes a bound recent attachment batch after join binding', () => {
    const runtime = createDiscordVoiceStickyContextRuntime();
    runtime.recordCommandChannelBatch({
      guildId: 'g1',
      textChannelId: 't1',
      attachments: [{ name: 'brief.pdf', localPath: '/tmp/brief.pdf', kind: 'document' }],
      observedAt: 1000,
    });
    runtime.bindVoiceSession({
      guildId: 'g1',
      channelId: 'v1',
      textChannelId: 't1',
    });
    expect(runtime.describeBoundContext({
      guildId: 'g1',
      voiceChannelId: 'v1',
      now: 1001,
    })).toBe('📎 Recent attachment context armed: brief.pdf');
  });

  it('includes extra-count when multiple attachments are armed', () => {
    const runtime = createDiscordVoiceStickyContextRuntime();
    runtime.recordCommandChannelBatch({
      guildId: 'g1',
      textChannelId: 't1',
      attachments: [
        { name: 'brief.pdf', localPath: '/tmp/brief.pdf', kind: 'document' },
        { name: 'img.png', localPath: '/tmp/img.png', kind: 'photo' },
      ],
      observedAt: 1000,
    });
    runtime.bindVoiceSession({
      guildId: 'g1',
      channelId: 'v1',
      textChannelId: 't1',
    });
    expect(runtime.describeBoundContext({
      guildId: 'g1',
      voiceChannelId: 'v1',
      now: 1001,
    })).toBe('📎 Recent attachment context armed: brief.pdf (+1 more)');
  });

  it('records voice-join sessions as declared voice provenance while retaining dc origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-voice-source-'));
    const previousRoot = process.env.ELANOUS_SESSION_ROOT;
    const previousGate = process.env.ELANOUS_DISCORD_VOICE_CHANNEL;
    const created: Array<{ source: string; sourceSource?: string; origin?: string; title: string }> = [];
    const unsubscribe = onSessionCreated((meta) => { created.push(meta); });
    process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
    process.env.ELANOUS_DISCORD_VOICE_CHANNEL = '1';
    const wire = buildDiscordVoiceWire({
      userConfig: { llm: { provider: 'test', model: 'test-model' }, discord: { botToken: '' } } as unknown as UserConfig,
      runTurnImpl: (async () => ({ text: 'ok' })) as unknown as typeof runTurn,
      getBot: () => null,
      __adapter: createStubDiscordVoiceChannelAdapter(),
    });
    const ctx: DcIncoming = {
      channelId: 'text-1', userId: 'u1', text: '/voice-join voice-1', messageId: 'm1',
      isDm: false, attachments: [], raw: { guild_id: 'guild-1' },
    };
    try {
      expect(await wire.dispatchVoiceCommand(ctx)).toContain('Joined voice channel voice-1');
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        source: 'voice', sourceSource: 'declared', origin: 'dc', title: 'dc-voice:voice-1',
      });
    } finally {
      unsubscribe();
      await wire.shutdown();
      if (previousRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
      else process.env.ELANOUS_SESSION_ROOT = previousRoot;
      if (previousGate === undefined) delete process.env.ELANOUS_DISCORD_VOICE_CHANNEL;
      else process.env.ELANOUS_DISCORD_VOICE_CHANNEL = previousGate;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
