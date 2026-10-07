# Telegram

Set up in the wizard (step 4) or edit `config.json` directly:
```json
"telegram": {
  "enabled": true,
  "botToken": "123456:ABC...",         // from @BotFather
  "allowedUsers": [42, 100],           // from @userinfobot — first = owner
  "homeChannel": -1001234567890        // optional; for cron deliveries
}
```

The bot runs inside the background service — start it with:
```bash
elanous nexus run
```

To run the poller as its own process instead, set `elanous config set telegram.poller standalone` and run `elanous telegram run` (or install it as a service with `elanous telegram service --install`). A bare `elanous telegram` only prints help.

Every incoming chat+thread maps to a per-conversation session. Messages
persist to the same session store as CLI chats; you can `elanous session
list --source telegram` to audit. Replies chunk automatically at 4000
chars; `parameters.retry_after` on 429 is respected.

Unknown user IDs (not in `allowedUsers`) get a polite refusal and
nothing else. With an empty `allowedUsers`, the bot answers every sender
with their user id and the command to register it
(`elanous config set telegram.allowedUsers '[<id>]'`), and does nothing
else until you do.

## Away mode — follow a release from Telegram only

When you step away, away mode sends every release-run transition to Telegram so you never have to open the dashboard to know where a release is.

**What you get while away**

- one line per finished release node (✅/❌), and for the gate the introduced-failure count and any waiver that let it pass;
- a block (`⛔`) or approval wait (`⏸`) with what stopped and the next move — these go out even during quiet hours (00:00–06:30 KST);
- `🎉` when the release completes, and a `💓` heartbeat if 60 minutes pass with no new transition;
- decision cards that need you (money, publishing, security) keep arriving as they always do, with buttons.

**Set it up**

1. Telegram must already deliver to you — follow the steps above (`botToken`, `allowedUsers`). Check it with `elanous notify "away mode test"`; you should get the line within seconds.
2. Away mode reads the release runs and sends only what is new, once per tick. Run the tick every two minutes, for example with cron:

   ```bash
   */2 * * * * elanous away tick >> /tmp/elanous-away.log 2>&1
   ```

   When you are not away the tick does nothing.

**Use it**

```bash
elanous away on       # sends a confirmation with the current release status
elanous away status   # are you away · the current run and node
elanous away off
```

From Telegram: `/away on`, `/away off`, `/away status`, and `/release` for the current run, node and last result at any time.

**Permissions and secrets**

Away mode adds no new token. It uses the bot already in `config.json` — keep that file readable only by you (`chmod 600 ~/.elanous/config.json`) and never paste the bot token into a chat. Only users in `allowedUsers` can run `/away` and `/release`.

**Check that it works**

- `elanous away tick --json` prints `{"outcome":"present"}` when you are not away, and `sent`, `quiet` or `send-failed` when you are.
- The state lives in `~/.elanous/presence.json` (away or not) and `~/.elanous/away/release-watch.json` (what was already sent).

**Common failures**

| Symptom | Why | Fix |
|---|---|---|
| `away on` says the confirmation was not sent | Telegram delivery is not set up or the bot was blocked | `elanous logs --category outbound.send`, then re-check `botToken` and `allowedUsers` |
| Nothing arrives during a release | the tick is not running | add the cron line above; `elanous away tick --json` by hand should print `sent` or `quiet` |
| Progress lines arrive only in the morning | quiet hours hold ordinary lines; blocks still go out | expected — use `/release` to ask for the current state |
| The same line twice | should not happen — a line is recorded only after it is delivered | report it with the output of `elanous away tick --json` |
