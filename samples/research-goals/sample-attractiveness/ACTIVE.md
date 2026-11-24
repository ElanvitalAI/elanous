---
goal: 반도체 매력도 분석 (Sample)
deadline: 2026-04-25T00:00:00Z
step: 1
tags: [research, sample, semiconductor]
budget:
  tokens: 1000000
  wallclock_hours: 4
  usd: 5.0
termination:
  - all_questions_answered
  - min_independent_sources: 3
  - executive_summary_written
  - budget_remaining_min: 0.10
---

# Mission — 반도체 매력도 분석 (Sample)

## Scoped brief

이 문서는 PFC-S3 research-base 의 사용 예시. 실제 세션에서는 사용자가
`ACTIVE.md` 를 작성하거나 `/research start <goal>` (PFC-S4) 로 자동 생성한다.

- **Objective metric**: 반도체 매력도 점수 (0-100 + 근거)
- **Primary risk**: DRAM 계약 가격 source mismatch
- **Required sources**: ≥ 3 independent (TrendForce / 한국거래소 / expert consensus)
- **Deadline**: 2026-04-25T00:00:00Z
- **Termination rule**: all questions answered AND ≥ 3 sources AND summary written AND budget > 10% remaining

## Termination rule

```json
{
  "kind": "and",
  "rules": [
    { "kind": "all_questions_answered", "queuePath": "question-queue.md" },
    { "kind": "min_sources", "n": 3, "sourcesPath": "knowledge/sources.md" },
    { "kind": "summary_written", "path": "executive-summary.md", "minChars": 400 },
    { "kind": "budget_remaining_min", "ratio": 0.10 }
  ]
}
```

## S4 invocation

```
/research start \
  --goal_slug sample-attractiveness \
  --mission "반도체 매력도 분석 (Sample)" \
  --budget '{"tokens":1000000,"usd":5,"wallclockMs":14400000}' \
  --max_turns 15
```

자세한 사용법 + 도구 레퍼런스: `내부 문서 `PFC-RESEARCH-TOOLS``
