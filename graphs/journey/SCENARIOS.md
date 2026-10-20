# TA 여정 수용 시나리오

## S — 현재

`ta-journey@1`은 `done` 경로를 dry-run으로 통과한다. `entry`·`dispatch-pod`·`author`·`pr` 단위는 기존 하니스 관측을 래핑하며, 실제 실행을 시작하지 않는다. `harvest`는 전역 `verb-harvest@1` 단위를 호출하고, 입력의 `context.observations`에 기존 경로가 남긴 노드별 `outcome`이 있어야 판정한다.

## C — 확인할 경로

그래프를 통과하는 실제 TA 카드가 아직 없어 정상 경로 하나만으로는 각 분기 배선을 확인할 수 없다.

## Q — 무엇을 입증해야 하나

행복 경로와 주요 보류·재작업 출구가 다음 노드 또는 이름 있는 종단으로 닫히며, `--test --dry-run` 실행의 외부 명령 수가 0인가?

## A — 시나리오 표

| 시나리오 | 주입한 단위 출구 | 기대 경로 끝 | 기대 상태·reason |
|---|---|---|---|
| 행복 경로 | 모든 단위 `done` | `remember → done` | `done` |
| 실제 harvest 미리보기 | 전역 `verb-harvest@1`의 `dry_run_command`가 `done` | `harvest → land` | `done` |
| harvest 완료 출구 계약 | 전역 `verb-harvest@1`에 격리 `printf` fixture가 `done` 반환 | `harvest → done` | `done` |
| harvest 재작업 출구 계약 | 전역 `verb-harvest@1`에 격리 `printf` fixture가 `rework` 반환 | `harvest → rework` | `failed · rework` |
| harvest 사람 확인 출구 계약 | 전역 `verb-harvest@1`에 격리 `printf` fixture가 `needs-human` 반환 | `harvest → needs-human` | `failed · needs-human` |
| 열차 등록 거부 | `land → needs-human` | `land → needs-human` | `failed · needs-human` |
| 반영 대기·상한 도달 | `reflect → wait` 반복, `prior.attempts` 상한 | `reflect → needs-human` | `failed · needs-human` |
| 녹색 판정 잔여 | `green → rework` | `green → rework` | `failed · rework` |
| 직접 입구 | `entry`: `intake=direct`, `launch-gate=pass` | `entry → author` | `done` |
| 대기열 입구 | `entry`: `intake=queued`, `queue=waiting` | `entry → needs-human` | `failed · needs-human` |
| 증거 부족 | 단위에 필요한 관측 하나 이상 없음 | `<unit> → needs-human` | `failed · missing-observation` |

reflect의 `wait`는 메인 그래프에서 reflect로 재진입하고 `max_visits: 3`으로 제한한다. 격리 `--test` 시험은 reflect@1 계약과 runner의 호출 경로에서 fixture provider가 `result.attempts`를 반환하고 다음 호출이 `prior.result.attempts`를 읽어 1→2→3으로 진행한 뒤 `needs-human`으로 닫히는 것을 확인한다. harvest 분기는 실제 전역 단위 선언을 복사하고 격리된 `printf` 명령 결과를 `done`·`rework`·`needs-human`으로 주입해 실제 단위 실행 경로와 라우팅을 확인한다. 나머지 분기 fixture는 선언된 출구 순서만 바꾼 `--dry-run`이며 `executed=0`이어야 한다. 모든 fixture는 임시 설정과 복사한 단위 파일을 사용한다. `needs-human`과 `rework`는 실행 상태 `failed`로 매핑하면서 원어 `reason`을 보존한다.

래퍼는 `passJourneyNode`를 통해 기존 노드와 같은 entry/exit 사건을 기록한다. 관측 누락이나 성공·보류를 판정할 수 없는 출구는 `needs-human`이며, 기존 사건이 `failed`·`error`이면 누락된 후속 단계가 있어도 `failed`다. 실제 하니스 실행은 기존 실행 경로의 몫이고, 래퍼는 실행을 대신하지 않는다. `green`·`remember`는 아직 fixture 단위이며 dry-run만 수행한다. 기본 `verb-harvest@1` dry-run은 reviewer를 호출하지 않으며 실제 PR 리뷰·수확을 주장하지 않는다.
