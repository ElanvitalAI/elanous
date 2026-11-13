---
name: absorb/suggest
description: Match today's member-owned briefing evidence to member-owned app slots.
---

# App upgrade suggestions

Use the persisted design pack in `prior` and the verified member app slots in `context.appSlots`. Return one to three small changes in `result.items`. Each item must contain its own stable `id`, `owner` equal to `context.memberId`, `briefingId` and `designPackId` equal to `prior.briefingId`, `appId` equal to `prior.appId`, the same three ordered `requirementLines` and `evidenceScrapIds` equal to `prior.scrapIds`, plus nonempty `ask` and `change` text. Cite the verified source scrap IDs in the suggested change and target only the matching member app slot. The graph rejects every item before storage if any owner, briefing, source, requirement, or slot binding differs.

If BYOK is unavailable, the app inventory is empty, or no evidence-backed match exists, return no suggestions. A suggestion remains proposed until the member explicitly approves it; do not start a build from this skill.
