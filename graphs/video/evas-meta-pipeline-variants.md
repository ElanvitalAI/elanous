# 메타 광고 파이프라인 — 세 판본의 «오버레이» (대표 2026-09-10)

> 설계·판정은 [`RFC-krea-higgsfield-periodic-pipeline`](../../내부 문서 `IDEAS`) **§2ⓔ** 가 canonical.
> 이 문서는 그 셋을 «그래프 오버레이»로 어떻게 쓰나만 답한다.

## 왜 오버레이인가 — 그래프를 «셋» 만들지 않는다

세 판본은 노드 구성이 **같다**. 다른 것은 `video`(그리고 `masters`·`pack`) 노드가
***무엇을 하나*** 뿐이다. ⇒ 그래프는 하나(`evas-meta-pipeline`)를 두고
**오버레이로 판본을 갈아 끼운다.**

⛔ **오버레이 함정 넷을 먼저 읽어라** — [`MANUAL-graph-operations`](../../내부 문서 `MANUAL-graph-operations-2026-09-10`) §2:
패치 키는 **camelCase**(파싱된 spec 기준) · 조건 문법은 `<key> <op> <literal>`(리터럴은 수 또는 낱말) ·
**전부 아니면 전무** · 워커의 YAML 은 «인라인 한 줄»만 읽는다.

---

## ① `auto-full` — 완전자동화

```yaml
overlay_id: pipeline-auto-full
target: evas-meta-pipeline
stage: launch
applies_when: pipeline_variant == auto
patch:
  - op: replace
    path: /nodes/5/mode          # video 노드
    value: mcp-unattended        # generate_video → jobs_wait
  - op: replace
    path: /nodes/3/mode          # masters 노드
    value: mcp-unattended        # execute_node_app
```

- 🔴 **오늘 못 돈다** — Krea 노드 앱이 없다(RFC §2ⓒ).
- 사람 칸 = **승인 넷만**.
- 비용: Higgsfield 는 `balance` 로 재고, **Krea 는 못 잰다**(공개 API 없음).

## ② `web-landed` — 웹 경유 · 사람 안착 (**오늘 도는 유일한 판본**)

```yaml
overlay_id: pipeline-web-landed
target: evas-meta-pipeline
stage: launch
applies_when: pipeline_variant == web
patch:
  - op: replace
    path: /nodes/5/mode
    value: observe-folder        # 04_video/ 에 파일이 났나만 본다
  - op: replace
    path: /nodes/3/mode
    value: observe-folder        # 02_masters/ 를 본다
```

- ✅ **막는 것이 0.** 사람이 Krea·Higgsfield 웹에서 뽑아 스프린트 폴더에 넣는다.
- 그래프는 **실행하지 않고 관측·기록**한다 — `survey` → `assemble`.
- 💰 **가장 싸다**(Higgsfield Unlimited 가 웹에 적용된다).
- ⭐ **①과 «계약을 공유»한다** — 폴더 구조·파일명·`07_results.json` 이 같다.
  그래서 ②를 세우는 일은 ①의 준비 작업이지 «버리는 일»이 아니다.

## ③ `web-aside-probe` — 웹 병행 · 자동화 탐색 (⭐ ①과 ②를 «고르는 자»)

```yaml
overlay_id: pipeline-web-aside-probe
target: evas-meta-pipeline
stage: launch
applies_when: pipeline_variant == probe
patch:
  - op: replace
    path: /nodes/5/mode
    value: observe-folder-and-probe   # ②를 하고 «탐침 한 발»을 더 쏜다
```

- 광고에 나가는 산출은 **②의 것**이다. 탐침 산출은 `09_probe/` 에만 둔다.
- ⛔⭐ **A/B 규율**: 두 팔이 «같은 밑 땅»에 서야 한다 —
  시작 프레임·프롬프트·모델·길이가 같아야 한다. 한쪽이 다른 쪽 입력을 바꾸면
  그건 「경로」가 아니라 「순서」를 잰 실험이다.
- 📏 남기는 것 셋: **`balance` 델타**(비용) · 나란히 본 품질 · 완주 시간.

---

## ⛔ 아직 «없는» 것 — 정직하게

| 없는 것 | 왜 | 언제 |
|---|---|---|
| `mode` 라는 노드 필드 | 지금 그래프 스펙에 없다. 판본을 가르려면 **이 필드부터 지어야 한다** | 로드맵 트랙 B |
| `pipeline_variant` 조건 키 | 오버레이 조건에 넣으려면 런 컨텍스트가 그 키를 내야 한다 | 같이 |
| `09_probe/` 계약 | ③이 실제로 돌 때 정한다 | ③ 첫 발 |

⚠️ ⇒ **위 YAML 셋은 「설계 초안」이지 「지금 먹는 오버레이」가 아니다.**
`mode` 필드와 `pipeline_variant` 키가 서기 전까지는 **판본을 손으로 고른다**.
⛔ 이 줄을 지우지 마라 — 안 그러면 다음 창이 위 YAML 을 붙여 넣고 «조용히 아무 일도 안 일어나는» 것을 본다.
