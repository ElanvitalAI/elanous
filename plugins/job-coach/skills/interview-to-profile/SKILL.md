---
name: interview-to-profile
description: Extract career candidates, experience and self-reported skills from a Korean interview.
---

Read the interview Markdown. Extract, without invention, `jobs` (target job candidates), `skills` (self-reported capabilities) and `experienceCount` (number of concrete work or project descriptions). Do not persist the raw descriptions in graph stdout. Record unknowns as missing rather than extrapolating. Never print or log the original interview. For the packaged graph, prepare headings `## 희망 직무`, `## 경험`, `## 보유 역량`; list items for experience and comma-separated skills. A job is a candidate, not a confirmed NCS code.
