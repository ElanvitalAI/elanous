# Attach a coding-agent session to an elanous seat

You may already be working in Claude Code or Codex and want that session's work to appear alongside your elanous context. This is the opposite of [driving elanous from your coding agent](drive-from-a-coding-agent.md): you keep working in your own coding agent, while elanous receives bounded session events. Attaching a session does not give elanous control of that agent.

## 1. Mark the project, not your whole machine

A seat marker is a local text file at `<project-root>/.claude/seat`. Its content is **one seat identifier assigned to you for this project**, followed by a newline. Create the `.claude` directory if needed and write that identifier into the `seat` file before starting the session. Get the identifier from the person administering your elanous setup; do not guess it or copy one from another project. Put the file in the root of the project where you start your coding-agent session. If you work in multiple projects, mark each one separately. Do not commit the marker.

Claude Code's hooks look for this marker from the session's working directory up toward the repository root. With no valid marker, they send **nothing**. A marker in a different repository does not attach this one. The marker identifies the seat, not a credential; it does not grant permissions.

## 2. Preview, then install Claude Code's context hooks

From the project you want to attach, first inspect the settings fragment:

```bash
elanous context hooks install --print
```

Despite the word `install`, **`--print` only prints JSON**. It does not edit your settings. Read the printed `hooks` entries before copying them. Then open this project's `.claude/settings.local.json` and merge the printed `hooks` into its `hooks` object. If the file is new, create it as a JSON object containing the printed `hooks`. If you already have hooks for the same event, keep those entries and add the printed hook entries; do not replace your other hooks or your other settings. Back up an existing settings file locally before editing (for example as `.claude/settings.local.json.bak`). The fragment is the source of the hook commands; do not substitute a guessed path.

This is a **manual installation**: there is no write-mode `elanous context hooks install` command. Only change this project's `settings.local.json` hooks. In particular, leave any `permissions` entries exactly as they are; the context hooks do not need new permission rules. They do not forward your prompt or transcript: the Claude Code hooks send limited completion metadata when the marked project is active. Start a new Claude Code session in that project after saving the settings, then finish a tool action or stop the session to generate an event.

**Codex:** Claude Code's `settings.local.json` is not a Codex hook configuration. For a Codex session, use the same project seat marker as your local opt-in and record a session event explicitly after finishing work, using the identifier from that marker. From the project root, this shell example reads the marker for this invocation only:

```bash
SEAT=$(cat .claude/seat)
elanous context emit task-done --seat "$SEAT" --text "Codex session finished"
```

Inspect your own marker first; do not run the command with an empty or copied identifier. This explicit event is not automatic Codex hook capture. Do not claim Codex sessions are automatically recorded by installing Claude Code's hooks.

## 3. Check the connection

```bash
elanous context day
```

Look for a recent event and timestamp within the displayed time window after you finish a Claude Code action, stop its session, or explicitly record a Codex event. A zero count only means no matching event **in that window**; it does not prove a hook was installed or absent. If your session occurred earlier, expand the window with `elanous context day --since 48h`. This command reads context; it does not install anything.

## 4. Keep local files out of Git

Add the following lines to the project's `.git/info/exclude` for a local-only exclusion (or to the project's `.gitignore` if your team deliberately shares the ignore rules):

```gitignore
/.claude/seat
/.claude/settings.local.json
/.claude/settings.local.json.bak
```

If you use a different backup filename, exclude that filename too. Ignore rules do not untrack files already committed; check that these files were never added to Git. Keep the backup locally so existing project hook settings can be recovered.

## Why not use personal global settings?

Do **not** put these hooks in your personal global Claude Code settings. Global hooks run in sessions opened from other repositories too; a marker left in an unrelated work folder could then attribute its actions to the wrong project. Project-local hooks plus a project-local marker keep the opt-in scoped to the work you meant to attach.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `elanous context day` shows no new event | Check that the marker is at this project's root, has your assigned identifier on one line, and the Claude Code session was started in that project. Run `elanous context hooks install --print` again and compare its entries with this project's saved hooks; then finish a tool action or stop a fresh session. For Codex, record the event explicitly. |
| Your existing hooks or permissions changed | Restore your local settings backup; merge only the printed `hooks` entries into `.claude/settings.local.json` while keeping existing hooks and `permissions` unchanged. `--print` itself never edits the file. |
| A session in another repository appears attached | Remove any copied marker from the unintended project and move hooks out of personal global settings into the intended project's `settings.local.json`. Verify the working directory and check the next event with `elanous context day`. |
