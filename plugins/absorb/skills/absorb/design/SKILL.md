---
name: absorb/design
description: Produce a member app design from the briefing's three requirements.
---

# Design from the brief

Read `prior.lines`, `prior.briefingId`, and `prior.scrapIds` from the requirements node. Use the `brief-design@1` pack contract. Produce a design for the verified member's existing app slot. Preserve the three input lines exactly and in order in `result.requirementLines` and `evidence.design.requirementLines`; carry the source IDs in `result.scrapIds` for the suggestion node. The `result.design` and `evidence.design` objects must contain `briefingId`, `scrapIds`, `appId`, `requirementLines`, and `changes`. Each `changes[]` object must contain `changes[].requirement` as the exact corresponding requirement line, `changes[].target` as an existing screen or RPC name from the verified app slot, and `changes[].action` as the requested user-visible change. Keep changes in the same order as the three input lines. Do not write source code, deploy, or invent a fourth requirement. If the app slot or source evidence is unavailable, return `needs-human`.
