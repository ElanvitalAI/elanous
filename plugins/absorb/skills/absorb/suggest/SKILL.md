---
name: absorb/suggest
description: Match today's member-owned briefing evidence to member-owned app slots.
---

# App upgrade suggestions

Compare today's briefing cards with the verified member's app-slot screens and RPC inventory. Return at most three small changes in `result.items`. Every suggestion must cite one or more scrap IDs from today's briefing and target an app slot returned for this member.

If BYOK is unavailable, the app inventory is empty, or no evidence-backed match exists, return no suggestions. A suggestion remains proposed until the member explicitly approves it; do not start a build from this skill.
