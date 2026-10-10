# Outbound channel setup (Telegram and Discord)

**S:** Elanous sends `/v1/outbound` messages through Telegram by default. It also has a Discord webhook sender and a Pushcut sender. The existing `routes`/`awayRoutes` fan out to the listed channels.

**C:** The connector comparison in [RESEARCH-plugins-connectors-baseline](../../../내부 문서 `RESEARCH-plugins-connectors-baseline-2026-09-30`) observes Hermes `plugins/platforms/*` and OpenClaw `extensions/<channel>/openclaw.plugin.json`, with auth-dependent chat connectors dormant until configured. Elanous likewise must not imply that declaring a channel activates an uninstalled connector. Outbound webhook delivery is not a full messaging bot: Discord webhook sends cannot read messages, handle slash commands, or acknowledge buttons. Telegram's inbound bot commands use a separate poller. The outbound router now dispatches built-in senders through a common adapter registry, but this does not migrate all inbound consumers.

**Q:** How do I provision and check these senders without assuming an unsupported channel works?

**A:** Set up the bot and webhook below, configure routing explicitly, and check the send results. The capability boundary and troubleshooting table state what remains unavailable.

## Create and install

1. **Telegram:** DM `@BotFather` `/newbot`; copy the token. Run `elanous nexus channel-bot setup telegram` to enter the token in the NEXUS key/secret framework. For an existing `telegram` configuration, confirm that the outbound target selected by `telegram.reportChannel` or the role table is also configured, because outbound `kind: alert` may not target the home chat. DM your bot `/start`; obtain your numeric ID (for example with `@userinfobot`) and configure `telegram.allowedUsers`, then set `telegram.homeChannel` to the destination chat ID. Invite the bot into a group and grant it permission to post there; use BotFather `/setprivacy` only if the bot must receive ordinary group messages. Start with `elanous nexus run` (or `elanous telegram run` if `telegram.poller=standalone`). Check the bot by sending a DM or `/start` to it, then send an authenticated `POST /v1/outbound` with `kind: alert` and inspect `channels`/`delivered`; these are separate inbound and outbound checks, not a live end-to-end suite.
2. **Discord:** Create an app in the Discord Developer Portal. To run an independent inbound bot, add a bot, install it in the server with `bot` and `applications.commands` scopes as applicable, grant only the needed View Channel/Send Messages permissions, and store its bot token via `elanous nexus channel-bot setup discord`. For **outbound** delivery, create a webhook under the target channel's Integrations → Webhooks, copy its URL and put it in `outbound.channels` below. The outbound webhook needs no OAuth scope; a bot token alone is not a webhook URL. This connector does not receive messages or provision a server/channel.

## Route and verify

Add this one-line `outbound` entry in the main configuration JSON (replace the webhook URL; never commit the real URL):

```json
"outbound": {"channels":[{"type":"telegram"},{"type":"discord","webhookUrl":"https://discord.com/api/webhooks/…"}],"routes":{"alert":["telegram","discord"]},"primary":{"alert":"telegram"},"fallback":{"alert":"discord"}}
```

`routes.alert` lists eligible channels. Optionally set `roleRoutes.OP:["discord","telegram"]` and `primary.OP:"discord"`/`fallback.OP:"telegram"` for messages with an explicit `role:"OP"` in an authenticated `/v1/outbound` POST. Requests without `role` retain the existing kind-based routing and response shape. `primary.alert` sends only to Telegram first; `fallback.alert` sends to Discord only if the primary fails. Omit `primary`/`fallback` to retain the old fan-out behavior. `awayRoutes` may replace the eligible list while `presence.json` says away, but it can never widen a role's `roleRoutes` (the two are intersected, and a role's empty route stays silent while away); explicitly empty routes suppress sends. A `fallback` without a `primary` is not used. If the main channel is not in the current route, the reply lists it as `not-routed` and only the backup is tried. Without an `outbound` configuration the Telegram-only default is unchanged. The delivery ledger still stores the same message ID, kind, text and `[{type,ok}]` channel rows.

To check routing logic without credentials, run `bun test src/nexus/outbound/router.test.ts` and `bun test test/outbound-router.test.ts`. With Nexus running, POST an authenticated `{"kind":"alert","text":"test"}` to `/v1/outbound` and inspect the `channels` and `delivered` fields of the response; never print tokens in diagnostics. A successful local unit test does not prove a live bot/webhook integration or the entire TG-E2E-SUITE.

## Key framework and common failures

`elanous nexus channel-bot setup telegram|discord` stores **bot tokens** in the NEXUS secret store via the channel-bot setup flow. The existing outbound Discord `webhookUrl` still resides in the protected user configuration: it is a credential-bearing URL, **not yet stored as a secret reference**. Restrict file permissions, rotate a leaked webhook, and never paste it in logs, reports or a public issue. Linear's `elanous connector linear set-key` provisions the separate Linear-to-task connector, not a chat channel.

| Symptom | Check / action |
|---|---|
| Telegram returns `not-configured` | This is an outbound (sending) failure: check the stored bot token, the `kind`-selected report/role target (or `homeChannel` for the operational bot), the destination chat ID, and whether the bot was started or blocked there. `telegram.allowedUsers` only controls who may send commands to the bot (inbound) and does not fix this. |
| Discord returns `http-401` or `http-404` | The webhook URL may be revoked or wrong; recreate it for the target channel. |
| Discord returns `http-429` | The sender reports rate limiting but does not retry it automatically. Slow the producer; do not claim delivery. |
| `channels` is empty | Inspect `suppressed`: dedup may have accepted the prior delivery; otherwise check explicitly empty `routes` / `awayRoutes`. |
| Telegram poller gets a 409 | Another poller or webhook owns `getUpdates`; run only one receiver for that token. |

**Unsupported by default:** Slack, Microsoft Teams, and WhatsApp have no built-in connector registered. An installed Elanous plugin can declare `contributes.connectors: [{"id":"my-channel"}]` in its `plugin.json` and export an `ElanousPlugin.channelAdapters` entry of the same type with `capabilities.send`, `parseConfig` and `send`. The plugin host registers this entry on activation and disposes it on deactivation; it then becomes eligible in `outbound.channels`/`routes`/`primary`/`fallback`. Activation in the plugin host is required: installing a plugin without activating it does not add a channel to a separately running Nexus process. This does not provide inbound or interactive behavior. Until a real connector is installed and verified, naming one of these as primary cannot make it work. The registry's Telegram and Discord adapters normalize inbound taps accepted by the existing bot poller/gateway into the shared receive envelope (without changing workflow dispatch/raw); Pushcut has no receive adapter. The Discord **webhook** still cannot receive messages. Interactive inbound, thread/topic, persona avatar, channel create/archive, permissions, slash commands, attachments, buttons/choices, remote confirmation, and rate-limit handling are not supplied by the outbound adapter. NOTIFY-MANAGER's bell-store inputs and REQ-FUNNEL's ledger inputs are separate today; their migration and a real TG-E2E-SUITE pass remain outstanding. The named `RESEARCH-chat-daemon-channels-personas` comparison (hermes-agent/openclaw) was not found in this checkout, so this chapter does not assert conclusions from it.
