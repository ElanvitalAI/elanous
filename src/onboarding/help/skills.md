Skill directories — Step 2 / 5

Skills are markdown-defined micro-agents that elanous can dispatch
during a turn. The preset choice tells elanous which family of
skills to load by default:

  · opencode    — opencode-flavoured tool catalogue
  · claudecode  — Claude Code skills (default for most users)
  · codex       — OpenAI Codex tool wrapper
  · hermes      — Hermes (multi-agent orchestration) skills
  · openclaw    — OpenCLAW (red-team / pen-test) skills
  · custom      — only your own paths; no built-in preset

After picking the preset you can add extra directories — one path
per line, blank line to finish. Paths that don't exist yet are
kept anyway so you can create them later.

You can change the active preset any time via:
    elanous onboarding skills
