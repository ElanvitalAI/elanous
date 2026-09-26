# The web app (PWA)

elanous ships a web dashboard — the PWA — next to the terminal UI. The
package already contains the built web app, so there is nothing to build.

## Open it

```bash
elanous nexus run      # start the daemon; the web app is served with it
elanous nexus show     # print the web app, REST and event-stream links
```

Open the link that `nexus show` prints in any browser on the same machine.
The port is picked when the daemon starts (usually `31415`, or the next free
one if that is taken), so use the printed link rather than a fixed number.
Stop a daemon you started by hand with `elanous nexus stop`.

## What is in it

| Menu | What it does |
|---|---|
| **Chat** | Talk to elanous with streaming replies, pick a session, a backend and a surface, and see the running budget. Voice input is available where the browser allows microphone access. See [Chat](pwa-chat.md). |
| **Terminal** | Live terminals from your machine in the browser — several tabs, a modifier-key bar for touch keyboards, file and camera attachments, and a mirror of the terminal UI. See [Terminal](pwa-terminal.md). |
| **Vault** | Browse your Obsidian vault, read and edit notes, create new ones, and explore tags and the link graph. See [Vault](pwa-vault.md). |
| **Settings** | Models and tiers, voice and text-to-speech, persona, notifications, theme and daemon health. |
| **Setup** (`/setup`) | First-time setup in the browser. Today it covers the LLM provider; the other wizard steps still run in the terminal with `elanous onboarding`. |

## Use it from another device

Share the web app over your Tailscale network:

```bash
elanous nexus pwa share enable
elanous nexus pwa share status
```

Other devices on the same tailnet can then open the link that
`elanous nexus show` prints. Every device on your tailnet can reach it, so
only share on a tailnet you trust. Turn it off with
`elanous nexus pwa share disable`.

If the link stops working from another device, check
`elanous nexus pwa share status` and run `elanous nexus pwa share enable`
again.

## Troubleshooting

- **The page does not load** — run `elanous nexus show`; if no daemon is
  listed, start one with `elanous nexus run`.
- **Something is missing after an update** — first run
  `elanous nexus restart-needed`. It only reports; it restarts nothing. Restart
  the daemon only when it says a restart is needed.
- Run `elanous doctor` to check credentials and setup.
