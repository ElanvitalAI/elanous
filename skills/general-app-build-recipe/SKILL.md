---
name: general-app-build-recipe
requires: []
description: Use when a user asks to create a new application or web service, populate it with synthetic data, run it and deploy it. Follow architecture first, frontend and backend, persistent seed, green tests and verified publication.
triggers:
  - 시스템을 만들어서
  - 앱 만들어
  - 가상 데이터로 채워 넣고
  - 배포해줘
  - 앱을 만들어서 가상 데이터로 채워
  - 웹 서비스를 만들어서 배포
  - build an app with seeded data
  - create a web application and deploy
autoTrigger: true
sideEffects: write
cost: heavy
category: productivity
---

# General app build recipe

Read and follow the canonical recipe at `plugins/general-app-build-recipe/skills/build/SKILL.md` before creating files. This bundled entry makes the plugin's recipe visible to the agent skill catalog; the plugin manifest grants no execution or publication authority.

The required sequence is local application-specific architecture document first (frontend, backend, data, local deployment and the architecture-deliverables rubric; optional cloud expansion), then matching frontend/backend/persistent store, explicit repeatable synthetic seed, direct tests and local user flow until green, then a supported publication route with verified URL and undo. Record times and exit codes. If a capability is unavailable or any stage remains red, report that stage and stop the completion claim. Do not substitute a sample domain or legacy absolute path for the user's request.
