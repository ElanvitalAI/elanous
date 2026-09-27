# FAQ

Every answer here was checked against the real CLI. Where a number could go stale, the command that measures it is given instead — run it rather than quoting a number.

## Does elanous run with no API keys at all?

**Yes.** `elanous doctor` exits 0 and names everything that is locked, in the form `<capability> — unlock with <KEY>`. Several resources also list a free fallback that works without a key.

To try it on a truly empty setup:

```bash
mkdir -p /tmp/empty-home /tmp/empty-cache
env -i PATH="$PATH" HOME=/tmp/empty-home ELANOUS_KEY_CACHE_DIR=/tmp/empty-cache \
  elanous doctor
```

Point `ELANOUS_KEY_CACHE_DIR` at an **empty** directory as well as emptying `HOME`. If you only empty `HOME`, the credential cache survives and you will see `resolved (cache)` lines, which means it did not really run with zero keys. Do not delete your real cache to test this; other work on the same machine uses it.

## What happens when my Codex (ChatGPT) quota runs out?

Automatic **account rotation is on by default**: elanous moves to the next Codex account that still has quota. Only if no account is usable does it fall back along the fallback chain. Falling back to Grok requires all three at once: no usable Codex account, `grok` in the chain, and Grok credentials present.

Do not assume the default; check your own instance:

```bash
elanous config get llm.fallbackChain
elanous usage          # remaining quota per account
```

See [providers](providers.md) and [Codex subscription](codex-subscription.md).

## Where do I send work to the harness?

```bash
elanous harness say "add tests for this file"   # one line from the terminal
elanous harness ask 내부 문서 `MY-ASK`        # if you already wrote a goal document
```

Inside the terminal UI, use `/harness`. To list every entrance, run `elanous self entrances`.

## How big is the CLI?

Dozens of top-level commands and several hundred subcommands. Rather than trust a number here, run `elanous --help` or see [commands](commands.md).

## Is the terminal UI the main interface?

**No.** The three-pane TUI was one stage in elanous's history. The core today is the **harness**, **PTY control** (reading and typing into live terminals), and the first principle of **observation → self-awareness → self-healing**. The TUI keeps running as one surface alongside the CLI, the NEXUS/PWA dashboard, MCP and chat channels. See [how elanous works](architecture.md).

## What needs a paid service, and what breaks without it?

Much of elanous's view of the world depends on external services. `catalog/resources.yaml` records, for each resource, what still works without it in a `free_fallback` field.

Two caveats:

- An empty `free_fallback` means "not measured", not "nothing breaks". As of 2026-09-27 every resource that needs a credential has one written; in a source checkout, `bun scripts/resource-map-check.ts` lists any that do not (`emptyFreeFallbackIds`).
- The catalog only counts API keys. Dependencies that are installed binaries or browsers (the crawl skill, browser automation, Chrome/CDP) are not listed yet.

Treat only capabilities with a written free fallback as dependable without payment. `elanous doctor` shows what is unlocked on your machine.

## How many steps from install to a first change?

With a ChatGPT subscription and GitHub already signed in, three commands: `elanous doctor`, `elanous login openai-codex`, then `elanous harness say "<what you want>"` from your project. See [install](install.md) and [quickstart](quickstart.md).
