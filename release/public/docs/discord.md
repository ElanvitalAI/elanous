# Discord voice channel

## Set up the bot

Voice runs on the same Discord bot you chat with in text. Set it up once:

```bash
elanous onboarding discord
```

The wizard shows where to create the bot in the Discord developer portal (copy
its token, turn on the **Message Content Intent**, invite it to your server),
then asks for the bot token, the Discord user IDs allowed to talk to it
(`discord.allowedUsers`) and an optional home channel for scheduled messages.
It saves them to your config (`discord.botToken`, `discord.enabled`). The bot
then answers in servers and DMs whenever the daemon runs.

## Voice

Discord now has two different voice-capable surfaces:

- text channel / DM voice attachments
- live voice channel round-trip

The live voice-channel path is configured from `voice.discord.voiceChannel`
in the active config (`elanous config path`, normally `~/.elanous/config.json`):

```json
{
  "voice": {
    "discord": {
      "voiceChannel": {
        "enabled": true,
        "listenFilter": "caller",
        "leaveOnEmpty": true
      }
    }
  }
}
```

Recommended behavior:

- `enabled = true` enables the live voice-channel surface
- `listenFilter = "caller"` keeps the showroom flow single-speaker by default
- `leaveOnEmpty = true` auto-leaves when the caller exits

Discord runs inside the NEXUS daemon — it starts automatically when Discord is configured:

```bash
elanous nexus run
```

For a standalone test session (same app and token, scoped to `discord.testChannel.channelId`, isolated state, the live daemon untouched):

```bash
elanous discord-test
```

In Discord:

1. Join a voice channel.
2. In a text channel on the same server, send `/voice-join <voice-channel-id>`.
3. Speak normally.
4. Use `/voice-leave` to exit.

Notes:

- The command channel becomes the transcript mirror target.
- Recent attachment-bearing messages in that same command channel become the sticky context source for subsequent voice turns.
- Discord keeps text output load-bearing: `👂 Listening…`, `🎙️ User: ...`, `🤖 ...`
- Voice turns are tagged before entering the ACP runner so the shared chat history keeps `guild / voice channel / speaker / filter` context.
- `ELANOUS_DISCORD_VOICE_CHANNEL`, `ELANOUS_DISCORD_VOICE_LISTEN_FILTER`, and `ELANOUS_DISCORD_VOICE_LEAVE_ON_EMPTY` still work as backward-compatible fallbacks, but user-config is preferred.
