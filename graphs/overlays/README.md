# 오버레이 — 「기본 템플릿을 «언제·어떻게» 변형하나」

대표 지시(2026-09-08): *「최초 결정 시 템플릿을 변형하고, 실제 구현 간 다이나믹 대응으로 바꿀 수 있게」*

## ⛔ 층이 «셋»이고 각 층이 바꿀 수 있는 것이 «다르다»

| 층 | 언제 | 바꿀 수 있는 것 | 바꿀 수 «없는» 것 | 검사 |
|---|---|---|---|---|
| **① 선택** | 발사 «전» | 어느 `graph_id` 를 쓸까 | — | 그 템플릿이 존재하나 |
| **② 변형** | 최초 결정 시 | `max_visits` · 라우트 목적지 · 노드 «추가» | `kind` 어휘 · 계약의 «형태» | 얹은 뒤 위상 검사 재실행 |
| **③ 다이나믹** | 구현 «중» | ②와 같되 ⊕ 예산 · 계약의 «값» | 이미 «지난» 노드 · terminal 재정의 | ②의 검사 ⊕ 체크포인트 |

🔑 ***③ 이 ② 와 다른 점은 「이미 지난 걸음」이다*** — 되돌아가는 것은 «엣지»로만 하고,
과거 노드를 «다시 정의»하지 않는다. 그래야 원장의 걸음이 사후에 해석 가능하다.

## 형식 — JSON Patch (RFC §4.6)

```yaml
overlay_id: patient-research
target: default-loop
stage: launch            # launch | runtime | heal(멈춤 갈래 사다리 전용 · stop-autoheal 만 읽는다)
patch:
  - op: replace
    path: /nodes/2/max_visits
    value: 12
  - op: add               # ⭐ 노드 «추가» — 다이나믹 대응의 핵심
    path: /nodes/-
    value:
      node_id: probe
      kind: judge
      recipe: observe-only
      max_visits: 1
      contract: { inputs: [worktree], tools: read-only, outputs: [findings] }
  - op: add
    path: /edges/-
    value: { from: gate, on: outcome, map: { fail: probe } }
```

## ⛔ 얹을 때 «반드시» 하는 것 셋

```
⑴ 얹은 «결과»에 위상 검사를 «다시» 건다   — 노드 집합이 그대로여도 도달 가능성은 바뀐다
⑵ 계약(contract)이 빠진 노드를 «거부»한다  — 권한 없는 노드가 조용히 들어오는 것을 막는다
⑶ 원장에 overlay_id ⊕ 적용 «시점»을 싣는다 — 사후에 「왜 이 걸음이었나」를 답하려면 필요하다
```
📏 ⑴ 의 근거: 2026-09-08 실측 — 노드를 «하나도» 안 바꾸고 목적지 하나만 돌렸더니
종료 노드가 도달 불가가 됐다(반증 2 fail). RFC §4.3 ⑴ 의 근거문이 그래서 정정됐다.
