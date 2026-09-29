---
name: career-report
description: Produce a career report from interview profile, verified NCS units and cited course research.
---

Write Markdown with sections `## 직무`, `## NCS 능력단위 매칭` (code, name and job), `## 역량 갭` (required unit vs self-reported possession), `## 추천 코스` (course title and real URL), and `## 출처` (NCS catalog and course URLs). Do not infer confirmed competency from an interview; label gaps `증거 미확인`. Do not invent NCS units or course URLs. A search link alone is not a course: inspect the publisher's page, confirm it declares an actual course, and cite which NCS unit appears in the course name or description. Only verified, relevant courses belong in `추천 코스`; otherwise write `확인된 관련 교육 과정 없음 (추천 미확인)`. Unverified search links are not recommendations. If the NCS key or NCS sources are unavailable, return an explicit error rather than a plausible report. Never echo the original interview or credential to a log.
