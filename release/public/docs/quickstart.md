# Quickstart

From an installed `elanous` to a first change made for you — three commands if you already have a ChatGPT subscription and are signed in to GitHub.

## 1. See what is missing

```bash
elanous doctor
```

`doctor` is a report, not a gate: it exits 0 even with nothing configured. For each credential it says whether it resolves, where it came from, what it unlocks, and whether a free fallback exists. Its readiness section names anything that would trip you up next, with one command each; `elanous doctor --fix` shows the repairs it can make for you, and `--fix --yes` applies them.

## 2. Sign in to a model

The main path is a **subscription**, not an API key:

```bash
elanous login openai-codex                     # ChatGPT device-code sign-in
elanous login status                           # which providers have tokens
# with the default llm.provider=auto, a ChatGPT sign-in is used first
```

Other choices (xAI Grok, OpenRouter for Kimi / GLM / Qwen, Anthropic, Gemini, a local model) are in [providers](providers.md).

## 3. Ask for a change

Go to the project you want changed and say what you want in one sentence:

```bash
cd ~/my-project
elanous harness say "add a Usage section to the README with the three commands a new user runs"
```

What happens:

1. elanous writes a goal from your sentence,
2. works on it in a separate git worktree (your working tree is not touched),
3. runs the project's tests for the files it changed,
4. reviews its own change and reworks it if the review finds problems,
5. finishes with a pull request (when the repository has a GitHub remote and `gh` is signed in) or with a branch you can merge yourself (no remote).

Add `--no-auto-merge` if you want to merge pull requests yourself. Add `--dry-run` to see the plan without starting.

Running the harness on a repository other than elanous itself is new and not fully measured yet (see [harness › Other repositories](harness.md#other-repositories)) — start with `--dry-run`, and use `--no-auto-merge` so you review and merge the pull request yourself.

## 4. Talk to it directly

```bash
elanous ask "what does src/app.ts do?"   # one question, one answer
elanous agent "why is the build failing?" # one turn with file and shell tools
elanous                                    # the terminal UI
```

## 5. Open the web app

```bash
elanous nexus run      # start the daemon; the web app is served with it
elanous nexus show     # prints the web app link (usually http://127.0.0.1:31415/app/)
```

On first open it takes you to model setup. See [Web app](pwa.md).

## Where to look next

- [commands](commands.md) — the commands you will actually use
- [configuration](configuration.md) — where settings live and how to change them
- [troubleshooting](troubleshooting.md) — messages that look like one thing and mean another
