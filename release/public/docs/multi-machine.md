# Running elanous on several machines

One elanous works on one machine. When you have more than one — a laptop you
work on, a desktop that stays on, a small cloud VM that faces the internet —
you can join them into one **fleet**: every machine reports what it has and
what it is for, one of them keeps the shared record, and that job can move to
another machine when the first one sleeps or reboots.

This page sets that up from scratch. Every step is a command you can check
right after you run it.

## The two kinds of role

A machine can hold two kinds of role, and they behave differently.

| | **Seat** | **Duty** |
|---|---|---|
| How many machines at once | exactly one | any number |
| Example | `control` — the machine that keeps the fleet record and accepts changes | `workstation`, `compute`, `edge`, `character` |
| What you write on each machine | whether it is a *candidate*, and its *rank* | the duties it takes on |
| What "primary" means | the candidate that holds the seat **right now** | — |

- **Seats** move. You never say "this machine is the primary". You say "this
  machine is a candidate for the `control` seat, rank 1", and the fleet works
  out who holds it. The holder is the primary for that seat; the other
  candidates stand by.
- **Duties** describe what a machine is good for. They do not move and they
  can overlap. Suggested names:

| Duty | Typical machine |
|---|---|
| `workstation` | the machine a person works at (browser, editor, terminal UI) |
| `compute` | always on, many cores — runs builds and parallel agent work |
| `edge` | a small cloud VM with a public address — webhooks, outside checks |
| `character` | hosts the browser screens of bot characters |

You can use your own duty names (lowercase letters, digits and `-`).

A machine can be a candidate for a seat, take on duties, both, or neither. A
small internet-facing VM, for example, is usually `edge` only and **not** a
seat candidate — it should not become the machine that keeps your record.

## Before you start

- elanous installed on every machine — see [Install](install.md). Check with
  `elanous --version` on each.
- The machines can reach each other over a **private network**. We use
  [Tailscale](https://tailscale.com); any private network works. Do not put
  the control seat on a public address.
- Pick a short, lowercase **id** for each machine (`home`, `studio`,
  `edge-1`, …). It is how the fleet names the machine, whatever the operating
  system calls it.

## 1. Describe each machine

Run this on every machine, with that machine's own values:

```sh
# the laptop you work on — first candidate for the control seat
elanous machine set --id home --duty workstation --seat control:1

# an always-on desktop — second candidate, also does the heavy work
elanous machine set --id studio --duty compute --duty character --seat control:2

# a cloud VM — outside tasks only, never holds the seat
elanous machine set --id edge-1 --duty edge
```

Check:

```sh
elanous machine show
```

`machine set` only changes what you pass; run it again to add a duty or change
a rank. The profile is stored in the elanous state folder with owner-only
permissions.

## 2. Start the control seat on the rank-1 machine

On the rank-1 candidate (`home` above):

```sh
elanous control serve
```

It listens on `127.0.0.1:31413` and creates the fleet's admin tokens. Keep it
running as a service (launchd on macOS, a systemd user unit on Linux) so it
comes back after a reboot.

Make it reachable from the other machines **over the private network only**.
With Tailscale:

```sh
tailscale serve --bg --https=8413 http://127.0.0.1:31413
```

The other machines will use `https://<this-machine>.<your-tailnet>.ts.net:8413`.
The control seat accepts nothing without a token, so it is safe behind a
private-network proxy — but never publish it on the open internet.

## 3. Join the other machines

Each machine gets its **own** token, and the token only lets that machine
report about itself.

On the rank-1 machine, issue a token and hand it straight to the other
machine through a pipe, so it is never shown on screen or saved in your shell
history:

```sh
elanous control token issue studio \
  | ssh studio 'elanous control join --url https://home.<your-tailnet>.ts.net:8413 --machine studio --token-stdin'
```

On a machine you cannot reach with `ssh`, save the token to a file readable
only by you and use `--token-file <path>` instead, then delete the file.

Check on the joined machine: it prints `Joined <url> as <id>`. On the rank-1
machine, `elanous control token list` shows the id and when it was issued. To
cut a machine off, run `elanous control token revoke <id>`.

## 4. Report what each machine has

On each joined machine, run the member and tell it what to report:

```sh
elanous control member --resource image:registry=http://127.0.0.1:5050/v2/
```

It sends a heartbeat every 30 seconds with the machine's load, memory, duties
and seat ranks, and checks that each resource you listed answers. Run it as a
service too.

See the whole fleet from any machine:

```sh
elanous resources list
elanous resources where registry     # one resource by name, or every resource of a kind
```

## 5. Let the control seat move (optional)

Up to here the rank-1 machine always holds the control seat. If you want the
seat to move to the next candidate when that machine sleeps, reboots or fails,
the candidates need **one shared object they can all read and write** — today
a Google Cloud Storage bucket.

On every seat candidate:

```sh
elanous config set roles.bucket '"gs://<your-bucket>"'
elanous role watch
```

Run `role watch` as a service. Every candidate checks the seat once a minute:

- **Nobody holds it** — rank 1 takes it at once; rank 2 only after it has seen
  the seat empty for a while; rank 3 later still. No machine needs a list of
  the others.
- **The holder stops renewing** — the next candidate takes over after a grace
  period, lower ranks first.
- **The holder comes back** — it does **not** take the seat back by itself.
  That avoids the seat bouncing each time a laptop wakes up.

Then start the control seat on every candidate with the lease turned on, so
only the current holder accepts changes:

```sh
elanous control serve --follow-lease
```

Check who holds the seat, from any candidate:

```sh
elanous role status
```

### Planned reboots

Hand the seat over first, then reboot:

```sh
elanous role handoff --to studio     # on the current holder
elanous role accept                  # on studio, if it does not accept on its own
# … reboot the first machine …
elanous role handoff --to home       # when it is back, hand the seat back
```

Doing this for each machine in turn lets you update every machine without the
seat ever being empty.

## Troubleshooting

| You see | Do |
|---|---|
| `invalid machine` | The id must be lowercase letters, digits or `-`. Set it with `elanous machine set --id <id>`. `elanous role whoami` shows the name in use and where it came from. |
| `roles.bucket` error from `role watch` | Step 5 needs a shared bucket — set `roles.bucket`, or skip step 5. |
| `unauthorized` when joining | The token was cut or mistyped. Issue a new one (`control token issue <id>` replaces the old one) and pipe it again. |
| A machine is missing from `resources list` | Its member is not running, or cannot reach the control seat's address. Run `elanous control member --once --json` on it to see one report. |
| `role status` shows nobody after starting | No rank-1 candidate is running `role watch`. Check `elanous machine show` on each candidate. |
