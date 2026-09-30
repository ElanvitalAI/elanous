---
name: interview-to-profile
description: Extract career candidates, experience and self-reported skills from a Korean interview.
---

Read the interview Markdown without inventing evidence. Never print or log the original interview; keep quotations out of graph stdout and persistent run context. Where a report needs a quotation, use only a short, relevant excerpt necessary to support the claim, without identifying details; otherwise paraphrase and cite the interview section. Mark unknown NCS codes or units, course names or URLs, and company policy details `미확인` rather than guessing.

## Personal mode (existing contract)

Extract `jobs` (target job candidates), `skills` (self-reported capabilities) and `experienceCount` (number of concrete work or project descriptions). Do not persist the raw descriptions in graph stdout. Record unknowns as missing rather than extrapolating. For the personal graph, prepare headings `## 희망 직무`, `## 경험`, `## 보유 역량`; list items for experience and comma-separated skills. A job is a candidate, not a confirmed NCS code.

## Enterprise mode (interview-to-profile input)

Use a fictional organization in packaged examples. Prepare the interview under these headings, separating statements made by the organization from independently confirmed facts:

- `## 기업 개요`: fictional organization, sector and team; omit real employer and employee identifiers.
- `## 교육 대상`: roles, learner group and scope; do not infer headcount or proficiency.
- `## 현업 과제`: concrete tasks and workflow bottlenecks, not a presumed diagnosis.
- `## 교육 목표`: requested outcomes and observable success measures, if stated.
- `## 현재 역량`: self-reported capabilities and evidence; not a verified competency rating.
- `## 교육 제약`: time, budget, data access and approvals only when actually supplied; otherwise `미확인`.

For the enterprise graph, summarize only the minimum necessary organization context, job candidates, tasks, goals, current skills and constraints for downstream steps. Do not copy interview paragraphs or identifying quotations into run outputs. Keep a stated need distinct from an observed task and from a recommended intervention. An interview alone does not verify NCS classifications, course existence or URLs, applicability of AI to confidential data, or internal policy approval: mark each unknown `미확인` until independently verified. Do not present a suggested training plan as an approved company policy.
