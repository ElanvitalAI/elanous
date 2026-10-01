# 일곱 만성 실패 시험 판정 (K10)

## Situation

K10의 두 판 연속 실패 대상을 격리 worktree에서 각 파일별로 재실행했다. 의존성 미설치로 `typescript`·`yaml`·`commander` 해석 오류가 먼저 나와 `bun install --frozen-lockfile` 후 원래의 단언 실패를 재현했다. `bun test <파일>` 결과는 아래 표에 기록한다.

## Complication

현재 코드와 맞지 않는 원문·가격·시계 기대, 도구 없음 안내로 달라진 접두, 실제 앱 상태에 좌우되는 probe, 그리고 2026-09-08 당시 운영 원장을 이 머신에서 읽으려는 검사가 같은 실패 기준선에 섞였다.

## Question

(비움 — Complication과 별도 질문 없음)

## Answer — PR 본문용 판정표

| 파일 | 원인 | 판정(고침/은퇴/보류) | 근거 |
|---|---|---|---|
| `scripts/ocr-text-regions.test.ts` | Swift Vision 출력에 `boundingBox` 네 좌표가 더해졌으나 시험의 verbatim 문자열은 예전 출력이었다. | 고침 | `scripts/ocr-text-regions.swift:15-19`의 `box=%.6f`와 정확히 같은 원문을 기대한다. 포맷·좌표를 제거하지 않았다. 변경 이력 조회 `git log -n 3 --format='%h %s' -- scripts/ocr-text-regions.swift`: 이 checkout의 이력은 `7187cdbf` 스냅샷 한 건만 제공하며 원래 변경 PR은 **미검증**이다. |
| `src/domains/taste-propose.test.ts` | 2026-08-24 입력을 sync하면서 시스템 현재 시각(720시간 창)을 사용하므로 시일이 지나 벡터가 0건이다. | 고침 | `src/domains/taste-model.ts:60-72`의 `nowMs` seam에 시험의 `now.getTime()`을 전달한다. `src/domains/taste-propose.ts:124-139,174-180`의 제안·각인 계약은 그대로 검증한다. 같은 이력 명령(`git log -n 3 --format='%h %s' -- src/domains/taste-model.ts`)은 `7187cdbf` 스냅샷만 제공하여 원래 PR은 **미검증**이다. |
| `src/prompt-enhance/enhance.test.ts` | GPT-5.6 Terra 입력 단가 기대가 2.5 USD/M으로 낡았다. | 고침 | `src/codex/models.ts:77-82`에 `inputPerM: 2.0`, `src/budget/llm-cost.ts:243-247`에 입력 백만 토큰 곱셈이 있다. 캐시 비용의 다른 단언은 그대로다. `git log -n 3 --format='%h %s' -- src/codex/models.ts`는 `7187cdbf` 스냅샷만 반환하므로 단가 변경 PR은 **미검증**이다. |
| `src/prompt-library/preamble-cache-prefix.test.ts` | 도구 없는 baseline에는 tree 뒤에 no-tools 안내가 들어가고, 도구가 있는 자식에는 들어가지 않는다. 전체 baseline은 도구 있는 자식의 접두가 아니다. | 고침 | `src/prompt-library/universal-preamble.ts:720-743,780-788`의 순서(앵커→트리→no-tools 조건부→lifecycle→model/tool addendum)를 따라 **공유 앵커·트리 전체**를 접두로 검사하고 모델/도구 옵션이 실제로 적용되는지도 검사한다. no-tools 안내가 추가된 변경은 `c3d84db0` (#22287). |
| `src/video-pipeline/recipes/reframe.test.ts` | 실제 Affinity 앱/네트워크 상태에 따라 probe 반환과 첫 skip 이유가 변한다; 타이밍 비교는 캐시 호출 수를 검증하지 않는다. | 고침 | `src/video-pipeline/recipes/reframe.ts:48-65,80-104`의 curl을 시험에서 제어해 false는 정확히 1회만 probe하고 null은 2번 재시도함을 검증한다. 러너 부재 시에는 앱 응답 200을 주어 진짜 러너 부재 분기를 검증하고 ffmpeg 출력 비율은 실물로 확인한다. |
| `test/research-graph-promotion-first-live-run.test.ts` | 이 checkout에 2026-09-08의 run-ledger JSONL이 없다. 문서 인용은 전체 원장이 아니므로 재구성해 실제 원장이라고 부를 수 없다. | 보류 | `test.skipIf(!existsSync(ledgerPath))`; 경로는 `ELANOUS_STATE_DIR` 또는 홈의 `.elanous/run-ledger/run-16dbf868-4e60-4547-bdab-15a9e6643bee.jsonl`. 원본 런이 있는 환경에서 다시 켜져 문서·원장 컷오프를 그대로 대조한다. |
| `test/research-yaml-graph-drove-a-real-mission.test.ts` | 위와 동일한 2026-09-08 원장 부재; YAML과 문서만으로 실행 노드를 증명할 수 없다. | 보류 | 동일한 `test.skipIf(!existsSync(ledgerPath))`. 원본 run-ledger JSONL이 있는 환경에서 다시 켜져 노드·불일치·3건의 원문 데이터를 그대로 검증한다. |

경계: 대상 일곱 시험 파일만 수정했다. 기능 코드·`scripts/release-loop/**`·PR·미션 DB에는 손대지 않았다. 두 보류 시험은 운영 원장이 없는 경우만 skip하며, 원장이 존재하면 종전 단언을 전부 실행한다. 과거 변경의 PR을 확인할 수 없는 세 항목은 위처럼 미검증으로 표기한다.

## 파일별 검증 신호

| 파일 | 확인 명령 | 요약 줄(현재 worktree) | 판정 근거 위치 |
|---|---|---|---|
| `scripts/ocr-text-regions.test.ts` | `bun test scripts/ocr-text-regions.test.ts` | `1 pass · 0 fail · 0 skip` | 위 판정표 1행; diff의 Swift 문자열 |
| `src/domains/taste-propose.test.ts` | `bun test src/domains/taste-propose.test.ts` | `12 pass · 0 fail · 0 skip` | 위 판정표 2행; diff의 `nowMs` 전달 |
| `src/prompt-enhance/enhance.test.ts` | `bun test src/prompt-enhance/enhance.test.ts` | `36 pass · 0 fail · 0 skip` | 위 판정표 3행; diff의 2 USD |
| `src/prompt-library/preamble-cache-prefix.test.ts` | `bun test src/prompt-library/preamble-cache-prefix.test.ts` | `7 pass · 0 fail · 0 skip` | 위 판정표 4행; diff의 접두·옵션 단언 |
| `src/video-pipeline/recipes/reframe.test.ts` | `bun test src/video-pipeline/recipes/reframe.test.ts` | `5 pass · 0 fail · 0 skip` | 위 판정표 5행; diff의 probe count/runner 분기 |
| `test/research-graph-promotion-first-live-run.test.ts` | `bun test test/research-graph-promotion-first-live-run.test.ts` | `0 pass · 0 fail · 1 skip` | 위 판정표 6행; diff의 조건부 skip |
| `test/research-yaml-graph-drove-a-real-mission.test.ts` | `bun test test/research-yaml-graph-drove-a-real-mission.test.ts` | `0 pass · 0 fail · 1 skip` | 위 판정표 7행; diff의 조건부 skip |

반증(핵심 규칙만 고의 파손→복원):
- OCR 원문 `box=%.6f`를 `box=%.3f`로 바꿔 `bun test scripts/ocr-text-regions.test.ts` 실행: `(fail) ocr-text-regions uses the macOS Vision source verbatim [0.15ms]` / `0 pass · 1 fail`; 복원 후 `1 pass · 0 fail`.
- 제안 sync의 주입 시계를 제거: `error: expect(received).toBeGreaterThanOrEqual(expected)` / `11 pass · 1 fail`; 복원 후 `12 pass · 0 fail`.
- 단가를 옛 2.5로 되돌림: `error: expect(received).toEqual(expected)` / `35 pass · 1 fail`; 복원 후 `36 pass · 0 fail`.
- 접두의 `startsWith` 단언을 반대로: `error: expect(received).toBe(expected)` / `2 pass · 5 fail`; 복원 후 `7 pass · 0 fail`.
- probe의 1회 단언을 2회로 바꿈: `error: expect(received).toHaveBeenCalledTimes(expected)` / `4 pass · 1 fail`; 복원 후 `5 pass · 0 fail`.
- 원장 보류 두 건은 실제 원장 없는 환경에서 종전 시험을 각각 실행했을 때 `error: run ledger not found: ~/.elanous/run-ledger/run-16dbf868-4e60-4547-bdab-15a9e6643bee.jsonl`, `0 pass · 1 fail`을 확인했다. `skipIf` 적용 후 각각 `0 pass · 1 skip · 0 fail`. 원본 JSONL이 없으므로 실제 원장 있음 분기는 이 환경에서 검증할 수 없다.

타입·diff 검사: `bun bin/elanous.mjs self typecheck` → `✅ 변경 파일 타입 검사 통과 (7개 파일 검사·baseline 무시·스코프: git diff HEAD ⊕ untracked — 커밋된 변경은 «안 본다»)`; `git diff --check` → 종료 코드 0.
