# What is Elanous

**Give it a goal — it plans, builds, verifies and merges on its own. It watches itself, understands what it sees, and heals itself.**

- **Observe** — it sees its own actions through logs, screens and memory.
- **Understand** — it judges context on top of what it sees.
- **Heal** — it fixes itself, and asks a person when it cannot.

In practice, `elanous` takes a change described in one sentence, writes a goal document, implements it in an isolated git worktree, gates it with tests, reviews it unattended and merges it. You are called only when the system cannot converge.

```bash
curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash
elanous harness say "add a --json flag to the status command"
```

Under the hood every job is one loop — observe, understand, heal — drawn as a graph that elanous reshapes while it runs, with posture deciding how hard it looks and how widely it grounds itself. See [Graph engineering and self-healing loops](graph-engineering.md).

elanous also drives terminals itself — shells, Codex, Claude Code and another elanous — choosing the lowest tool that can do the job. See [PTY intelligence](pty-intelligence.md).

Work that repeats — every morning, on every new request — runs as [loop agents](loop-agents.md); you can [build your own](build-a-loop-agent.md).

Skills and graphs come as [plugins](plugins.md) from a signed marketplace — the same packages install in Codex; you can [build one](build-a-plugin.md).

## The name and the mark — élan, and nous

<img src="https://elanous.ai/media/brand/elanous-180.png" width="96" alt="Elanous mark" />

The red point at the center is *élan* — the drive to move on its own. The three white blades around it are *nous* — the mind that brings order. They turn one way — observe, understand, heal — widening a little with every turn. A spark meets a mind and keeps widening itself. That is Elanous.

*Elanous* joins Bergson's *élan vital* — the vital impulse that gave Elanvital AI its name — with Anaxagoras' *nous*, the mind that sets the world turning.

Start with [Install](install.md) and the [Quickstart](quickstart.md).
