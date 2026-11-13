---
name: absorb/requirements
description: Turn a member-owned briefing into exactly three source-backed design requirements.
---

# Briefing to requirements

Read the preceding briefing evidence for the verified member. Use only its article/card content and scrap IDs. Return exactly three concise, actionable requirement lines in `result.lines` and copy them into `evidence.requirements`. Return the preceding `result.id` as `result.briefingId` and `evidence.briefingId`; preserve `result.scrapIds` and `evidence.scrapIds`. Each line must describe a distinct user-visible behavior and cite at least one source scrap ID using the exact `[scrap-id]` form, with the actual source ID replacing `scrap-id`. Do not cite IDs outside `result.scrapIds`, add implementation details, or invent facts. For an empty briefing, return `needs-human` rather than fabricating requirements. Keep the lines in the same order for a repeated briefing.
