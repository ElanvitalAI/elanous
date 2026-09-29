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
| **Terminal** | Live terminals from your machine in the browser — several tabs, a modifier-key bar for touch keyboards, file and camera attachments, a mirror of the terminal UI, and a live view of an agent's terminal from a link. See [Terminal](pwa-terminal.md). |
| **Intake** | *Since 0.2.3.* One box for anything you want elanous to take — a link, a memo, a list or an instruction. It shows as you type how it reads the text, then you absorb it into your notes or send it to the harness. See [Tasks and intake](tasks-and-intake.md). |
| **Live** | Your harness runs as they happen — stage bars, a stream of decisions (what, why, where to), gauges and the raw log. Everyday mode costs almost nothing; **Full show** records more and animates it, and switches itself off after 30 minutes. See [Live](pwa-live.md). |
| **Trace** | Follow one run from the whole fleet down to a single decision and the log line behind it. Filters stack up as a lens you can peel back one chip at a time, and the address keeps the view so you can share it. See [Trace](pwa-trace.md). |
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

### Connect each device once

:::info Since 0.2.3
From 0.2.3, a device that opens the web app through the
tailnet link needs a token once. The browser on the daemon's own machine
(`localhost`) does not.
:::

A device that is not connected yet shows a banner saying it is not
connected to the daemon (인증 필요 — authentication needed). To connect it:

1. On a device that already works, open **Settings › Connect token (other
   devices)** and press **Generate connect token**, then copy it.
2. On the new device, open **Settings › Daemon** and paste it into
   **Bearer token**.

The token is kept in that browser, so you do this once per browser.

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
