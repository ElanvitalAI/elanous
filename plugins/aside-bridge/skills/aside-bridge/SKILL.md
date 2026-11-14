---
name: aside-bridge
description: Invoke an explicit Aside task through the aside.exec@1 graph capability.
---

# Aside bridge

Use a graph capability node with `requires: aside.exec@1` and a node input containing `task` and optional `timeoutMs` (1–120000). The provider runs `aside exec --json <task>` without a shell. A successful result contains `sessionId`, `outcome`, `answer`, and `links`; the graph node evidence also records `sessionId`.

If Aside is unavailable, not logged in, times out, or returns invalid JSON, the node fails with `Aside 연결 필요`. Connect Aside outside this plugin before retrying. Do not put account credentials, cookies, or memory dumps in the task or graph input.

On Windows, the provider fails before execution with `Windows 미지원 · 0.3.18`. Use the macOS/Linux path for this demo; Windows support is deferred to `ASIDE-BRIDGE-WINDOWS-JOB-OBJECT`.
