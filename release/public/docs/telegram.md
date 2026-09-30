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
